'use strict';

/**
 * Restoration sales from Shopify (migration 100).
 *
 * A restoration pre-order is one Shopify listing per inventory instrument,
 * priced at the deposit. When an order for one comes in, the order intake
 * (services/shopifyOrders.js) doesn't make a ticket for it: a tag rule with
 * action "restoration" sends the item here instead (recordItems), and it
 * waits on the homepage of the reviewers picked in Settings -> Shopify
 * orders. The reviewer confirms which instrument was sold and the ticket's
 * category; confirm() then, in one transaction:
 *
 *   - records the sale of the instrument to the order's customer at the
 *     full price (ownership ledger, migration 087) -- a consignment's sale
 *     also opens its payout ticket, same as "Mark sold";
 *   - links the instrument to the Shopify listing, so that listing is an
 *     exact match from then on;
 *   - opens the restoration ticket at the back of the Repairs &
 *     Restoration queue (or its Custom Shop sub-category), with the
 *     customer, the instrument and the order on it -- or, if someone
 *     already started restoring the piece on spec, uses that open ticket
 *     instead: the customer and order go on it, and it keeps its place.
 *
 * One restoration queue (migration 101): a stock piece's ticket is an
 * ordinary Repairs & Restoration ticket, tagged "Inventory" and titled
 * "Inventory — ..." because of who owns the instrument. Selling the piece
 * just puts the buyer on it (handoverStockTickets).
 *
 * A cancelled order: a row nobody set up yet just closes. A row that was
 * set up keeps its sale until a reviewer decides (undo it, or keep it),
 * because a refunded deposit is a person's call, not the webhook's.
 */

const { query, withTransaction } = require('../db');
const config = require('../config');
const shopify = require('../shopify');
const settings = require('./settings');
const ownership = require('./ownership');
const payouts = require('./consignmentPayouts');
const { insertNote } = require('./ticketNotes');
const { sendEmail } = require('../mailer');
const { buildRestorationIntakeEmail } = require('../templates/restorationIntakeEmail');
const { HttpError, badRequest, notFound } = require('../middleware/errors');

const forbidden = (msg) => new HttpError(403, msg);

// routes/tickets.js requires services that require this file's callers;
// load it on first use so nothing sees a half-built module.
const tickets = () => require('../routes/tickets'); // eslint-disable-line global-require

const PARENT_CATEGORY_KEY = 'repairs_restoration';
// Retired in migration 101 (one restoration queue); never offered, even if
// someone un-retires it in Settings.
const INVENTORY_RESTORATION_KEY = 'inventory_restoration';
const PREFERRED_PRIORITY_KEY = 'standard_priority';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function money(amount, currency) {
  const n = Number(amount);
  if (amount === null || amount === undefined || !Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch (err) {
    return `${n.toFixed(2)} ${currency || ''}`.trim();
  }
}

/** 'YYYY-MM-DD' in the shop's timezone. */
function shopDay(iso) {
  const d = new Date(iso || Date.now());
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.shopTimezone })
    .format(Number.isNaN(d.getTime()) ? new Date() : d);
}

function shopDateLabel(iso) {
  const d = new Date(iso || Date.now());
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.shopTimezone, month: 'short', day: 'numeric', year: 'numeric',
  }).format(Number.isNaN(d.getTime()) ? new Date() : d);
}

function positiveMoney(v, field) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a positive amount`);
  return Math.round(n * 100) / 100;
}

/**
 * The numeric product id from whatever someone pastes: 123, a
 * gid://shopify/Product/123, or an admin/storefront-admin URL ending in
 * /products/123. '' / null clears it.
 */
function parseProductId(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  const m = s.match(/^(\d+)$/) || s.match(/Product\/(\d+)/) || s.match(/\/products\/(\d+)/);
  if (!m) throw badRequest('Shopify listing: paste the product id or its Shopify admin link');
  return m[1];
}

// ---------------------------------------------------------------------------
// Reviewers
// ---------------------------------------------------------------------------

async function reviewerIds() {
  const { rows } = await query(
    "SELECT meta FROM settings WHERE category = 'shop_config' AND key = 'shopify_orders'",
  );
  const ids = rows[0] && rows[0].meta && rows[0].meta.restoration_reviewer_ids;
  return Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
}

/** Active reviewers, or every active admin when none are picked (or none
 * of the picked ones are still active). */
async function effectiveReviewers() {
  const ids = await reviewerIds();
  if (ids.length) {
    const { rows } = await query(
      'SELECT id, name, email, role FROM employees WHERE id = ANY($1::int[]) AND active = TRUE ORDER BY name',
      [ids],
    );
    if (rows.length) return { rows, fallback: false };
  }
  const { rows } = await query(
    "SELECT id, name, email, role FROM employees WHERE role = 'admin' AND active = TRUE ORDER BY name",
  );
  return { rows, fallback: true };
}

/** Sees the card on the homepage. */
async function isReviewer(user) {
  if (!user) return false;
  const { rows } = await effectiveReviewers();
  return rows.some((r) => r.id === user.id);
}

/** May act on a row: a reviewer, or any admin (so nothing is stuck if
 * the reviewer is away). */
async function assertCanReview(user) {
  if (user && user.role === 'admin') return;
  if (await isReviewer(user)) return;
  throw forbidden('Only the restoration reviewers picked in Settings → Shopify orders can do this');
}

// ---------------------------------------------------------------------------
// Category choices: Repairs & Restoration and its children
// ---------------------------------------------------------------------------

async function categoryChoices() {
  const rows = await settings.listCategory('ticket_category');
  const parent = rows.find((r) => r.key === PARENT_CATEGORY_KEY && !r.retired);
  const children = rows.filter((r) => !r.retired && r.meta && r.meta.parent_key === PARENT_CATEGORY_KEY);
  const out = [];
  if (parent) {
    out.push({
      key: parent.key, label: parent.label, category_key: parent.key, subcategory_key: null,
    });
  }
  if (!parent) return out; // retired: nowhere to put a customer restoration
  for (const c of children) {
    if (c.key === INVENTORY_RESTORATION_KEY) continue;
    out.push({
      key: c.key, label: c.label, category_key: PARENT_CATEGORY_KEY, subcategory_key: c.key,
    });
  }
  return out;
}

async function defaultChoiceKey(choices) {
  const { rows } = await query(
    `SELECT category_choice FROM shopify_restoration_intake
      WHERE status = 'done' AND category_choice IS NOT NULL
      ORDER BY resolved_at DESC NULLS LAST LIMIT 1`,
  );
  const last = rows[0] && rows[0].category_choice;
  if (last && choices.some((c) => c.key === last)) return last;
  return choices[0] ? choices[0].key : null;
}

// ---------------------------------------------------------------------------
// Matching a listing to an inventory instrument
// ---------------------------------------------------------------------------

const FAMILY_WORDS = [
  [/\bwurlitzer\b|\bwurly\b/i, 'wurlitzer'],
  [/\brhodes\b/i, 'rhodes'],
  [/\bhohner\b|\bclavinet\b|\bpianet\b|\bclav\b/i, 'hohner'],
];

function familyFromTitle(title) {
  const hit = FAMILY_WORDS.find(([re]) => re.test(title || ''));
  return hit ? hit[1] : null;
}

function yearFromTitle(title) {
  const m = String(title || '').match(/\b(19[4-9]\d|20[0-2]\d)\b/);
  return m ? m[1] : null;
}

/** The listing's nickname: the quoted part of the title (CEPCo titles are
 * `YEAR Brand Model “Nickname”`), else the end of a RESTO SKU. */
function nicknamesFromItem(item) {
  const out = new Set();
  const q = String(item.title || '').match(/[“"]([^”"]{2,60})[”"]/);
  if (q) out.add(q[1].trim().toLowerCase());
  const sku = String(item.sku || '').trim();
  const resto = sku.match(/RESTO-(.+)$/i);
  if (resto) out.add(resto[1].replace(/[-_]+/g, ' ').trim().toLowerCase());
  return [...out].filter(Boolean);
}

const CANDIDATE_COLUMNS = `
  i.id, i.nickname, i.family, i.model, i.year, i.serial_no, i.ownership, i.sale_status,
  i.asking_price, i.shopify_product_id, i.customer_id,
  COALESCE((SELECT json_agg(json_build_object(
              'id', t.id, 'title', t.title, 'category_key', t.category_key, 'customer_id', t.customer_id,
              'category_label', t.category_label_snapshot,
              'status_label', t.status_label_snapshot, 'shopify_order_id', t.shopify_order_id)
              ORDER BY t.id)
       FROM tickets t WHERE t.instrument_id = i.id AND t.archived = FALSE), '[]'::json) AS open_tickets`;

const IN_STOCK = "i.ownership <> 'customer' AND i.sale_status IS DISTINCT FROM 'sold'";

/**
 * { suggestion: { instrument, reason } | null, candidates: [instrument] }.
 * Exact first (the listing is linked), then the nickname, then "the only
 * one of that family (and year) in stock". Candidates are what the card
 * offers when there's no single answer.
 */
async function suggest(item) {
  if (item.product_id) {
    const { rows } = await query(
      `SELECT ${CANDIDATE_COLUMNS} FROM instruments i WHERE i.shopify_product_id = $1`, [String(item.product_id)],
    );
    if (rows[0]) return { suggestion: { instrument: rows[0], reason: 'Linked to this Shopify listing' }, candidates: [] };
  }

  const nicknames = nicknamesFromItem(item);
  if (nicknames.length) {
    const { rows } = await query(
      `SELECT ${CANDIDATE_COLUMNS} FROM instruments i
        WHERE ${IN_STOCK} AND lower(btrim(i.nickname)) = ANY($1::text[])
        ORDER BY i.id`,
      [nicknames],
    );
    if (rows.length === 1) return { suggestion: { instrument: rows[0], reason: 'Same nickname' }, candidates: [] };
    if (rows.length > 1) return { suggestion: null, candidates: rows };
  }

  const family = familyFromTitle(item.title);
  if (!family) return { suggestion: null, candidates: [] };
  const year = yearFromTitle(item.title);
  const { rows } = await query(
    `SELECT ${CANDIDATE_COLUMNS} FROM instruments i
      WHERE ${IN_STOCK} AND i.family = $1
      ORDER BY (i.year = $2) DESC NULLS LAST, (i.sale_status = 'available') DESC, lower(i.nickname) NULLS LAST, i.id
      LIMIT 15`,
    [family, year],
  );
  const sameYear = year ? rows.filter((r) => String(r.year || '').includes(year)) : [];
  if (sameYear.length === 1) {
    return { suggestion: { instrument: sameYear[0], reason: `Only ${year} ${family} in stock` }, candidates: rows };
  }
  if (rows.length === 1) {
    return { suggestion: { instrument: rows[0], reason: `Only ${family} in stock` }, candidates: rows };
  }
  return { suggestion: null, candidates: rows };
}

/** Search box on the card: any stock piece by nickname, model, serial, year. */
async function searchStock(q) {
  const term = String(q || '').trim();
  if (!term) return [];
  const { rows } = await query(
    `SELECT ${CANDIDATE_COLUMNS} FROM instruments i
      WHERE ${IN_STOCK}
        AND (i.nickname ILIKE $1 OR i.model ILIKE $1 OR i.serial_no ILIKE $1 OR i.year ILIKE $1 OR i.family ILIKE $1)
      ORDER BY lower(i.nickname) NULLS LAST, i.id
      LIMIT 20`,
    [`%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
  );
  return rows;
}

async function loadCandidate(db, instrumentId) {
  const { rows } = await db.query(`SELECT ${CANDIDATE_COLUMNS} FROM instruments i WHERE i.id = $1`, [instrumentId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// From the order intake
// ---------------------------------------------------------------------------

/**
 * Called by the order intake's ticket step with the order's restoration
 * items ([{ li, deposit }]). Idempotent: a re-run of the step finds the
 * rows already there. Returns a one-line summary for the order log.
 */
async function recordItems(orderRow, order, items) {
  if (!items.length) return '';
  let fullValues = new Map();
  try {
    fullValues = await shopify.productFullValues(items.map(({ li }) => li.product_id));
  } catch (err) {
    // The full price is a convenience for the card; the reviewer can type it.
    console.warn('[restoration-intake] full_value lookup failed:', err.message);
  }

  const created = [];
  const summary = [];
  for (const { li, deposit } of items) {
    const productId = li.product_id ? String(li.product_id) : null;
    const item = { title: li.title, sku: li.sku, product_id: productId };
    // eslint-disable-next-line no-await-in-loop
    const { suggestion } = await suggest(item);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await query(
      `INSERT INTO shopify_restoration_intake
         (shopify_order_row_id, shopify_order_id, line_item_id, product_id, variant_id, sku, title,
          quantity, deposit_amount, full_price, currency, suggested_instrument_id, match_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (shopify_order_id, line_item_id) DO NOTHING
       RETURNING *`,
      [
        orderRow.id, String(order.id), String(li.id), productId,
        li.variant_id ? String(li.variant_id) : null, li.sku || null,
        `${li.title}${li.variant_title ? ` (${li.variant_title})` : ''}`,
        Number(li.quantity) || 1,
        Number.isFinite(deposit) ? deposit : null,
        productId && fullValues.has(productId) ? fullValues.get(productId) : null,
        order.currency || null,
        suggestion ? suggestion.instrument.id : null,
        suggestion ? suggestion.reason : null,
      ],
    );
    if (rows[0]) created.push(rows[0]);
    const label = suggestion
      ? `suggested #${suggestion.instrument.id}${suggestion.instrument.nickname ? ` “${suggestion.instrument.nickname}”` : ''}`
      : 'no match yet';
    summary.push(`${li.title} (${label})`);
  }

  if (created.length) notifySoon(created.map((r) => r.id));
  return `Restoration sale${items.length > 1 ? 's' : ''} waiting for review on the homepage: ${summary.join('; ')}`;
}

/** Line item ids on this order that are restoration deposits (for the
 * Xero note's wording). */
async function depositLineIds(shopifyOrderId) {
  const { rows } = await query(
    'SELECT line_item_id FROM shopify_restoration_intake WHERE shopify_order_id = $1', [String(shopifyOrderId)],
  );
  return new Set(rows.map((r) => r.line_item_id));
}

/**
 * The order was cancelled. Runs *before* the intake archives the order's
 * tickets: a ticket someone opened on spec and that this order was
 * attached to is the shop's own restoration, so it's detached from the
 * order rather than archived with it.
 */
async function onOrderCancelled(shopifyOrderId) {
  const id = String(shopifyOrderId);
  await query(
    `UPDATE shopify_restoration_intake SET status = 'cancelled', updated_at = now()
      WHERE shopify_order_id = $1 AND status = 'pending'`,
    [id],
  );
  const { rows } = await query(
    `UPDATE shopify_restoration_intake SET order_cancelled_at = now(), updated_at = now()
      WHERE shopify_order_id = $1 AND status = 'done' AND order_cancelled_at IS NULL
      RETURNING *`,
    [id],
  );
  if (!rows.length) return;
  await withTransaction(async (client) => {
    for (const row of rows) {
      if (!row.reused_ticket || !row.ticket_id) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        'UPDATE tickets SET shopify_order_id = NULL, shopify_group_key = NULL, updated_at = now() WHERE id = $1',
        [row.ticket_id],
      );
      // eslint-disable-next-line no-await-in-loop
      await insertNote(client, {
        ticketId: row.ticket_id,
        body: 'The Shopify order for this restoration was cancelled. The sale is waiting for a decision on the homepage.',
        createdBy: null,
      });
    }
  });
  notifySoon(rows.map((r) => r.id), 'cancelled');
}

// ---------------------------------------------------------------------------
// Homepage card
// ---------------------------------------------------------------------------

const ROW_SELECT = `
  SELECT r.*, o.order_name, o.customer_id, o.cancelled AS order_cancelled, o.financial_status,
         o.payload->>'processed_at' AS order_processed_at, o.payload->>'created_at' AS order_created_at,
         o.payload->>'note' AS order_note,
         c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         NULLIF(concat_ws(', ', c.address_line1, c.address_line2, c.city,
                          concat_ws(' ', c.region, c.postal_code), c.country), '') AS customer_address,
         e.name AS resolved_by_name, t.title AS ticket_title,
         i.nickname AS instrument_nickname, i.family AS instrument_family, i.model AS instrument_model,
         i.year AS instrument_year
    FROM shopify_restoration_intake r
    JOIN shopify_orders o ON o.id = r.shopify_order_row_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN employees e ON e.id = r.resolved_by
    LEFT JOIN tickets t ON t.id = r.ticket_id
    LEFT JOIN instruments i ON i.id = r.instrument_id`;

function shapeRow(row) {
  return {
    id: row.id,
    status: row.status,
    needs: row.status === 'pending' ? 'setup' : 'cancel_review',
    order: {
      row_id: row.shopify_order_row_id,
      shopify_order_id: row.shopify_order_id,
      name: row.order_name,
      date: shopDateLabel(row.order_processed_at || row.order_created_at),
      financial_status: row.financial_status,
      cancelled: row.order_cancelled,
      note: row.order_note || null,
      admin_url: config.shopify.shopDomain
        ? `https://${config.shopify.shopDomain}/admin/orders/${row.shopify_order_id}` : null,
    },
    customer: row.customer_id ? {
      id: row.customer_id,
      name: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
      address: row.customer_address,
    } : null,
    item: {
      title: row.title,
      sku: row.sku,
      quantity: row.quantity,
      product_id: row.product_id,
      product_admin_url: config.shopify.shopDomain && row.product_id
        ? `https://${config.shopify.shopDomain}/admin/products/${row.product_id}` : null,
      deposit: row.deposit_amount === null ? null : Number(row.deposit_amount),
      full_price: row.full_price === null ? null : Number(row.full_price),
      deposit_label: money(row.deposit_amount, row.currency),
      full_price_label: money(row.full_price, row.currency),
    },
    instrument_id: row.instrument_id,
    instrument_label: row.instrument_id
      ? [row.instrument_nickname && `“${row.instrument_nickname}”`, row.instrument_year, row.instrument_family, row.instrument_model]
        .filter(Boolean).join(' ')
      : null,
    ticket_id: row.ticket_id,
    ticket_title: row.ticket_title,
    reused_ticket: row.reused_ticket,
    sale_recorded: row.sale_recorded,
    resolved_by_name: row.resolved_by_name,
    resolved_at: row.resolved_at,
    order_cancelled_at: row.order_cancelled_at,
    created_at: row.created_at,
  };
}

/** Everything waiting on a reviewer, with live match suggestions. */
async function listOpen() {
  const { rows } = await query(
    `${ROW_SELECT}
      WHERE r.status = 'pending'
         OR (r.status = 'done' AND r.order_cancelled_at IS NOT NULL AND r.cancel_reviewed_at IS NULL)
      ORDER BY r.created_at`,
  );
  const choices = await categoryChoices();
  const defaultChoice = await defaultChoiceKey(choices);
  const out = [];
  for (const row of rows) {
    const shaped = shapeRow(row);
    if (shaped.needs === 'setup') {
      // eslint-disable-next-line no-await-in-loop
      const { suggestion, candidates } = await suggest({ title: row.title, sku: row.sku, product_id: row.product_id });
      shaped.suggestion = suggestion;
      shaped.candidates = candidates.filter((c) => !suggestion || c.id !== suggestion.instrument.id);
    }
    out.push(shaped);
  }
  return { items: out, category_choices: choices, default_category_choice: defaultChoice };
}

async function listRecent(limit = 50) {
  const { rows } = await query(
    `${ROW_SELECT} ORDER BY r.created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  return rows.map(shapeRow);
}

async function loadRow(db, id, { lock = false } = {}) {
  const { rows } = await db.query(
    `${ROW_SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id],
  );
  if (!rows[0]) throw notFound('Restoration sale not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Moving an existing ticket to another queue
// ---------------------------------------------------------------------------

/**
 * Re-home an open ticket into `resolved`'s category / sub-category, the
 * way the ticket page's category change does (PATCH /tickets/:id): to the
 * back of the new category's queue, onto that category's default status if
 * its current one doesn't apply there, logged in the status history.
 * A no-op when it's already there. `title` replaces the title when given.
 */
async function moveTicket(client, ticket, resolved, { title, userId, reason }) {
  const categoryKey = resolved.category.key;
  const subKey = resolved.subcategory ? resolved.subcategory.key : null;
  const moving = ticket.category_key !== categoryKey || (ticket.subcategory_key || null) !== subKey;
  if (!moving) {
    if (title && title !== ticket.title) {
      await client.query('UPDATE tickets SET title = $2, updated_at = now() WHERE id = $1', [ticket.id, title]);
    }
    return false;
  }
  let status = null;
  const current = await settings.resolve('ticket_status', ticket.status_key);
  if (!settings.statusAppliesToCategory(current, categoryKey, ticket.is_shipping === true)) {
    status = await settings.defaultStatusForCategory(categoryKey, ticket.is_shipping === true);
  }
  let position = ticket.category_queue_position;
  if (ticket.category_key !== categoryKey) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(category_queue_position), 0) + 10 AS next
         FROM tickets WHERE category_key = $1 AND archived = FALSE AND id <> $2`,
      [categoryKey, ticket.id],
    );
    position = rows[0].next;
  }
  await client.query(
    `UPDATE tickets
        SET category_key = $2, category_label_snapshot = $3,
            subcategory_key = $4, subcategory_label_snapshot = $5, subcategory_other_text = NULL,
            category_queue_position = $6,
            status_key = COALESCE($7, status_key), status_label_snapshot = COALESCE($8, status_label_snapshot),
            title = COALESCE($9, title), updated_at = now()
      WHERE id = $1`,
    [ticket.id, categoryKey, resolved.category.label, subKey, resolved.subcategory ? resolved.subcategory.label : null,
      position, status ? status.key : null, status ? status.label : null, title || null],
  );
  if (status) {
    await client.query(
      `INSERT INTO status_change_log (ticket_id, old_status, new_status, old_label, new_label, changed_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ticket.id, ticket.status_key, status.key, ticket.status_label_snapshot, status.label, userId || null, reason],
    );
  }
  return true;
}

/**
 * The piece's open stock restoration tickets: Repairs & Restoration
 * tickets (any sub-category) with nobody on them -- or, for a consignment,
 * with the consignor on them (the instrument page opens those that way).
 * The recurring "Inventory QC — ..." checks live in the same queue but
 * aren't restorations (services/recurringTickets.js finds them by that
 * title), so they're left out.
 */
async function stockTickets(client, instrumentId, { consignorId = null, skipTicketId = null } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM tickets
      WHERE instrument_id = $1 AND archived = FALSE AND category_key = $2 AND id <> COALESCE($3, 0)
        AND (customer_id IS NULL OR customer_id = $4)
        AND title NOT ILIKE 'Inventory QC —%' AND title NOT ILIKE 'Fleet QC —%'
      ORDER BY id FOR UPDATE`,
    [instrumentId, PARENT_CATEGORY_KEY, skipTicketId, consignorId],
  );
  return rows;
}

/** A ticket's title as its category would name it now -- or null when the
 * category doesn't standardize names and the title isn't the automatic
 * "Inventory — ..." one (a hand-typed title is left alone). */
async function regeneratedTitle(client, t, { customerId, customerName = null, stock }) {
  const category = await settings.resolve('ticket_category', t.category_key);
  const sub = t.subcategory_key ? await settings.resolve('ticket_category', t.subcategory_key) : null;
  const naming = tickets().namingFor(category, sub);
  if (naming.mode !== 'standardize' && !/^Inventory — /.test(t.title || '')) return null;
  return tickets().composeTicketTitle(customerId, t.instrument_id, naming.template, {
    categoryLabel: (sub || category).label,
    categoryKey: category.key,
    ticketName: t.ticket_name || '',
    customerName,
    stock,
    db: client,
  }) || null;
}

/**
 * A stock piece just sold (Mark sold, or confirm() below): its open stock
 * restoration tickets aren't stock work any more.
 *
 *   action 'keep'     the buyer goes on them -- now their restoration, same
 *                     queue, same place; the title follows (no more
 *                     "Inventory —") and the Inventory tag drops off by
 *                     itself, since the piece is the buyer's now
 *          'archive'  archived: sold as-is, or replaced by a new ticket
 *                     (`replacedBy`)
 * Returns the ids it touched.
 */
async function handoverStockTickets(client, instrumentId, {
  action = 'keep', customerId = null, customerName = null, consignorId = null,
  reason, replacedBy = null, skipTicketId = null,
}) {
  const open = await stockTickets(client, instrumentId, { consignorId, skipTicketId });
  for (const t of open) {
    if (action === 'archive') {
      // eslint-disable-next-line no-await-in-loop
      await insertNote(client, {
        ticketId: t.id,
        body: replacedBy ? `${reason}. Replaced by ticket #${replacedBy}; archived.` : `${reason}. Sold as-is; archived.`,
        createdBy: null,
      });
      // eslint-disable-next-line no-await-in-loop
      await client.query('UPDATE tickets SET archived = TRUE, updated_at = now() WHERE id = $1', [t.id]);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const title = await regeneratedTitle(client, t, { customerId, customerName, stock: false });
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      'UPDATE tickets SET customer_id = $2, title = COALESCE($3, title), updated_at = now() WHERE id = $1',
      [t.id, customerId || null, title],
    );
    // eslint-disable-next-line no-await-in-loop
    await insertNote(client, { ticketId: t.id, body: `${reason}: now their restoration.`, createdBy: null });
  }
  return open.map((t) => t.id);
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

async function resolveChoice(key) {
  const choices = await categoryChoices();
  const choice = choices.find((c) => c.key === key);
  if (!choice) throw badRequest('Pick Repairs & Restoration or one of its sub-categories');
  return choice;
}

async function ticketTitleFor(row, { customerId, instrumentId, resolved }) {
  const t = tickets();
  const naming = t.namingFor(resolved.category, resolved.subcategory);
  const title = await t.composeTicketTitle(customerId, instrumentId, naming.template, {
    categoryLabel: (resolved.subcategory || resolved.category).label,
    ticketName: row.order_name || '',
  });
  return title || `Restoration — ${row.title}`;
}

async function resolvedFields(choice, priorityKey) {
  return tickets().resolveNewTicketFields({
    category_key: choice.category_key,
    subcategory_key: choice.subcategory_key,
    priority_key: priorityKey
      || await settings.defaultKeyPreferring('priority_tier', PREFERRED_PRIORITY_KEY),
  });
}

/** Title the card shows before confirming. */
async function preview(id, b) {
  const row = await loadRow({ query }, id);
  const choice = await resolveChoice(b.category_choice);
  const resolved = await resolvedFields(choice, b.priority_key);
  const customerId = row.customer_id || (b.customer_id ? Number(b.customer_id) : null);
  return {
    title: await ticketTitleFor(row, {
      customerId, instrumentId: b.instrument_id ? Number(b.instrument_id) : null, resolved,
    }),
  };
}

function ticketNoteText(row, { soldPrice }) {
  const currency = row.currency;
  const lines = [
    `Restoration sold on Shopify order ${row.order_name || row.shopify_order_id} `
      + `(${shopDateLabel(row.order_processed_at || row.order_created_at)}): ${row.title}`,
  ];
  if (row.deposit_amount !== null) lines.push(`Deposit paid: ${money(row.deposit_amount, currency)}`);
  if (soldPrice !== null) {
    lines.push(`Full price: ${money(soldPrice, currency)}`);
    if (row.deposit_amount !== null) {
      lines.push(`Balance due: ${money(Math.max(soldPrice - Number(row.deposit_amount), 0), currency)}`);
    }
  }
  if (row.order_note) lines.push(`Customer note: ${row.order_note}`);
  return lines.join('\n');
}

/**
 * body: {
 *   instrument_id,          the inventory piece that was sold (required)
 *   category_choice,        a categoryChoices() key -- the new ticket's queue, or
 *                           the queue an on-spec ticket moves to
 *   priority_key,           optional, defaults to Standard
 *   ticket_mode,            'new' (default) or 'reuse'
 *   reuse_ticket_id,        with 'reuse': one of the piece's open tickets
 *   sold_price,             full price; defaults to the listing's full_value
 *   customer_id,            only when the order has no customer on it
 * }
 */
async function confirm(id, b, user) {
  await assertCanReview(user);
  const instrumentId = Number(b.instrument_id);
  if (!Number.isFinite(instrumentId)) throw badRequest('Which instrument was sold?');
  const mode = b.ticket_mode === 'reuse' ? 'reuse' : 'new';

  // Resolved outside the transaction (they read settings through the pool).
  const choice = await resolveChoice(b.category_choice);
  const resolved = await resolvedFields(choice, b.priority_key);
  const preRow = await loadRow({ query }, id);
  const customerId = preRow.customer_id || (b.customer_id ? Number(b.customer_id) : null);
  if (!customerId) throw badRequest('This order has no customer on it — pick who bought it');
  // Titles are worked out before the sale moves the piece to the buyer,
  // which composeTicketTitle doesn't care about -- it reads the customer
  // and instrument passed in.
  const title = await ticketTitleFor(preRow, { customerId, instrumentId, resolved });

  const result = await withTransaction(async (client) => {
    const row = await loadRow(client, id, { lock: true });
    if (row.status !== 'pending') throw badRequest('This restoration sale was already handled');

    const { rows: [inst] } = await client.query('SELECT * FROM instruments WHERE id = $1 FOR UPDATE', [instrumentId]);
    if (!inst) throw notFound('Instrument not found');
    const { rows: [buyer] } = await client.query('SELECT id, name FROM customers WHERE id = $1', [customerId]);
    if (!buyer) throw badRequest("That buyer isn't a customer record");

    // --- the sale ---------------------------------------------------------
    let saleRecorded = false;
    const soldPrice = positiveMoney(b.sold_price, 'sold_price')
      ?? (row.full_price === null ? null : Number(row.full_price));
    if (inst.ownership === 'customer') {
      // Already sold by hand -- fine if it was to this buyer.
      if (inst.customer_id !== customerId) {
        throw badRequest("That instrument already belongs to a customer — pick the piece from inventory that was sold");
      }
    } else {
      if (soldPrice === null) throw badRequest("What's the full price? The listing has no full value on it");
      const salePeriodId = await ownership.recordSale(client, inst.id, {
        soldOn: shopDay(row.order_processed_at || row.order_created_at),
        price: soldPrice,
        buyerId: customerId,
        buyerName: buyer.name,
        employeeId: user.id,
      });
      await client.query(
        `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
         VALUES ($1, $2, 'sold', $3, $4)`,
        [inst.id, user.id, inst.sale_status, `${buyer.name} (Shopify ${row.order_name || row.shopify_order_id})`],
      );
      if (inst.ownership === 'consignment') await payouts.openForSale(client, salePeriodId, user.id);
      saleRecorded = true;
    }

    // --- the listing link --------------------------------------------------
    if (row.product_id && inst.shopify_product_id !== row.product_id) {
      const { rows: taken } = await client.query(
        'SELECT id, nickname FROM instruments WHERE shopify_product_id = $1 AND id <> $2', [row.product_id, inst.id],
      );
      if (taken[0]) {
        throw badRequest(`This listing is linked to instrument #${taken[0].id}`
          + `${taken[0].nickname ? ` “${taken[0].nickname}”` : ''} — unlink it there first, or pick that one`);
      }
      await client.query('UPDATE instruments SET shopify_product_id = $2 WHERE id = $1', [inst.id, row.product_id]);
    }

    // --- the ticket ---------------------------------------------------------
    const groupKey = `restoration:${row.line_item_id}`;
    const note = ticketNoteText(row, { soldPrice });
    let ticketId;
    if (mode === 'reuse') {
      const { rows: [t] } = await client.query(
        'SELECT * FROM tickets WHERE id = $1 AND instrument_id = $2 AND archived = FALSE FOR UPDATE',
        [Number(b.reuse_ticket_id), inst.id],
      );
      if (!t) throw badRequest("That ticket isn't an open ticket for this instrument");
      if (t.shopify_order_id && t.shopify_order_id !== row.shopify_order_id) {
        throw badRequest(`Ticket #${t.id} already belongs to another Shopify order`);
      }
      await client.query(
        `UPDATE tickets SET customer_id = $2, shopify_order_id = $3, shopify_group_key = $4, updated_at = now()
          WHERE id = $1`,
        [t.id, customerId, row.shopify_order_id, groupKey],
      );
      // Sold: the buyer's restoration now. It keeps its place in the queue;
      // only the sub-category the reviewer picked (Custom Shop or none)
      // applies. A ticket that was somewhere else entirely moves to the
      // back of Repairs & Restoration.
      const naming = tickets().namingFor(resolved.category, resolved.subcategory);
      await moveTicket(client, t, resolved, {
        title: naming.mode === 'standardize' || /^Inventory — /.test(t.title || '') ? title : null,
        userId: user.id,
        reason: `Sold on Shopify ${row.order_name || row.shopify_order_id}`,
      });
      ticketId = t.id;
    } else {
      const ticket = await tickets().insertTicketRow(client, {
        title,
        ticket_name: row.order_name || null,
        customer_id: customerId,
        instrument_id: inst.id,
        shopify_order_id: row.shopify_order_id,
      }, resolved, user.id);
      await client.query('UPDATE tickets SET shopify_group_key = $2 WHERE id = $1', [ticket.id, groupKey]);
      ticketId = ticket.id;
    }
    // No author: the order is already on the customer's Xero history, so
    // this note isn't posted there again.
    await insertNote(client, { ticketId, body: note, createdBy: null });
    // Any other stock restoration ticket on the piece is superseded by this
    // one -- a second ticket for the same job is what to avoid.
    await handoverStockTickets(client, inst.id, {
      action: 'archive',
      consignorId: inst.ownership === 'consignment' ? inst.customer_id : null,
      replacedBy: ticketId,
      skipTicketId: ticketId,
      reason: `Sold on Shopify ${row.order_name || row.shopify_order_id}`,
    });

    await client.query(
      `UPDATE shopify_orders SET ticket_ids = array_append(ticket_ids, $2), updated_at = now()
        WHERE id = $1 AND NOT ($2 = ANY(ticket_ids))`,
      [row.shopify_order_row_id, ticketId],
    );
    if (!preRow.customer_id) {
      await client.query('UPDATE shopify_orders SET customer_id = $2 WHERE id = $1 AND customer_id IS NULL',
        [row.shopify_order_row_id, customerId]);
    }
    await client.query(
      `UPDATE shopify_restoration_intake
          SET status = 'done', instrument_id = $2, ticket_id = $3, reused_ticket = $4, sale_recorded = $5,
              category_choice = $6, resolved_by = $7, resolved_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, inst.id, ticketId, mode === 'reuse', saleRecorded, choice.key, user.id],
    );
    return { ticket_id: ticketId, instrument_id: inst.id, sale_recorded: saleRecorded };
  });
  return result;
}

async function dismiss(id, b, user) {
  await assertCanReview(user);
  const { rows } = await query(
    `UPDATE shopify_restoration_intake
        SET status = 'dismissed', dismiss_note = $2, resolved_by = $3, resolved_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, b.note ? String(b.note).trim().slice(0, 500) : null, user.id],
  );
  if (!rows[0]) throw badRequest('This restoration sale was already handled');
}

/**
 * A set-up sale whose order was cancelled afterwards.
 *   'undo_sale': the piece goes back to stock (and a consignment's payout
 *                ticket closes), the order's ticket stays archived; a
 *                reused on-spec ticket stays open, without the customer.
 *   'keep':      the sale stands (paid some other way...); the order's
 *                ticket comes back from the archive.
 */
async function reviewCancellation(id, b, user) {
  await assertCanReview(user);
  const outcome = b.outcome === 'undo_sale' ? 'sale_undone' : b.outcome === 'keep' ? 'kept' : null;
  if (!outcome) throw badRequest("outcome must be 'undo_sale' or 'keep'");
  await withTransaction(async (client) => {
    const row = await loadRow(client, id, { lock: true });
    if (row.status !== 'done' || !row.order_cancelled_at || row.cancel_reviewed_at) {
      throw badRequest('Nothing to decide on this one');
    }
    if (outcome === 'sale_undone') {
      if (row.sale_recorded && row.instrument_id) {
        await ownership.undoSale(client, row.instrument_id);
        await payouts.onSaleUndone(client, row.instrument_id);
        await client.query(
          `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
           VALUES ($1, $2, 'sold', 'sold', 'undone')`,
          [row.instrument_id, user.id],
        );
      }
      if (row.reused_ticket && row.ticket_id) {
        // Back to stock restored for sale: nobody on it, "Inventory — ..."
        // again (the tag comes back with the piece's ownership).
        const { rows: [t] } = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [row.ticket_id]);
        if (t) {
          const title = await regeneratedTitle(client, { ...t, customer_id: null }, { customerId: null, stock: true });
          await client.query(
            'UPDATE tickets SET customer_id = NULL, title = COALESCE($2, title), updated_at = now() WHERE id = $1',
            [t.id, title],
          );
        }
        await insertNote(client, {
          ticketId: row.ticket_id,
          body: 'Sale undone after the Shopify order was cancelled; back to shop stock.',
          createdBy: null,
        });
      }
    } else if (row.ticket_id && !row.reused_ticket) {
      await client.query('UPDATE tickets SET archived = FALSE, updated_at = now() WHERE id = $1', [row.ticket_id]);
      await insertNote(client, {
        ticketId: row.ticket_id, body: 'Shopify order was cancelled, but the sale was kept — ticket reopened.', createdBy: null,
      });
    }
    await client.query(
      `UPDATE shopify_restoration_intake
          SET cancel_reviewed_at = now(), cancel_reviewed_by = $2, cancel_outcome = $3, updated_at = now()
        WHERE id = $1`,
      [id, user.id, outcome],
    );
  });
}

// ---------------------------------------------------------------------------
// Email to the reviewers
// ---------------------------------------------------------------------------

async function notify(ids, kind = 'new') {
  if (!config.resend.apiKey || !config.resend.fromEmail) {
    console.warn('[restoration-intake] email not configured; reviewers will see it on the homepage only');
    return;
  }
  const { rows: items } = await query(`${ROW_SELECT} WHERE r.id = ANY($1::int[]) ORDER BY r.id`, [ids]);
  if (!items.length) return;
  const { rows: reviewers } = await effectiveReviewers();
  const { subject, html, attachments } = buildRestorationIntakeEmail({ kind, items: items.map(shapeRow) });
  for (const r of reviewers) {
    if (!r.email) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendEmail({ to: r.email, subject, html, attachments });
      // eslint-disable-next-line no-await-in-loop
      await query(
        "INSERT INTO emails (recipient, template, subject, status, sent_at) VALUES ($1, $2, $3, 'sent', now())",
        [r.email, `restoration_intake_${kind}`, subject],
      );
    } catch (err) {
      console.error(`[restoration-intake] email to ${r.email} failed:`, err.message);
      // eslint-disable-next-line no-await-in-loop
      await query(
        "INSERT INTO emails (recipient, template, subject, status, error) VALUES ($1, $2, $3, 'failed', $4)",
        [r.email, `restoration_intake_${kind}`, subject, err.message],
      ).catch(() => {});
    }
  }
  if (kind === 'new') {
    await query('UPDATE shopify_restoration_intake SET notified_at = now() WHERE id = ANY($1::int[])', [ids]);
  }
}

/** Fire-and-forget: a mail problem never holds up or fails the intake. */
function notifySoon(ids, kind) {
  setImmediate(() => {
    notify(ids, kind).catch((err) => console.error('[restoration-intake] notify failed', err));
  });
}

module.exports = {
  recordItems,
  depositLineIds,
  onOrderCancelled,
  listOpen,
  listRecent,
  searchStock,
  loadCandidate,
  preview,
  confirm,
  dismiss,
  reviewCancellation,
  isReviewer,
  effectiveReviewers,
  reviewerIds,
  categoryChoices,
  handoverStockTickets,
  parseProductId,
  // exported for tests
  suggest,
  nicknamesFromItem,
  familyFromTitle,
};
