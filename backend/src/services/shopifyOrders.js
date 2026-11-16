'use strict';

/**
 * Shopify order intake v2 (migration 093, NOTES §2.111).
 *
 * The webhook route records each delivery here (recordOrder) and replies
 * 200 straight away; processOrder() then works through four steps, saving
 * each one's outcome on the shopify_orders row:
 *
 *   1. customer      match the buyer to an MC2 customer (Shopify customer
 *                    id, then email) or create one
 *   2. xero_contact  make sure that customer is linked to a Xero contact:
 *                    an existing contact with the same email is linked, not
 *                    duplicated; only if there's none is one created
 *   3. ticket        one ticket per group of items -- the default shipping
 *                    ticket, plus one per "ticket" tag rule that matched.
 *                    Items tagged "no ticket", items that don't ship, and
 *                    (by setting) POS sales are left off. An order with no
 *                    ticketed items gets no ticket. By setting, an unpaid
 *                    order waits for orders/paid.
 *   4. xero_note     "Shopify order #1234 placed Nov 16, 2026: ..." on the
 *                    customer's Xero History & Notes
 *
 * Why steps, not one transaction: two of them talk to Xero, which can't
 * roll back, and one talks to Shopify. A step that fails is retried on its
 * own -- by the sweep below every few minutes, or by "Re-run" in Settings --
 * without redoing the steps that already worked (no second Xero contact,
 * no second note, no second ticket).
 *
 * Status vocabulary is documented in migration 093.
 */

const { query, withTransaction } = require('../db');
const config = require('../config');
const xero = require('../xero');
const shopify = require('../shopify');
const settings = require('./settings');
const { insertNote } = require('./ticketNotes');
const { createCustomerInXero, ADDRESS_FIELDS } = require('./xeroSync');
const { linkCustomerToXero } = require('./xeroBackfill');
const {
  resolveNewTicketFields, insertTicketRow, renderNamingTemplate, namingFor,
  activeSubcategoryKey, SHOPIFY_SUBCATEGORY_KEY,
} = require('../routes/tickets');

const STEPS = ['customer', 'xero_contact', 'ticket', 'xero_note'];
// Steps already settled are never re-run; everything else is.
const SETTLED = new Set(['done', 'skipped']);

// financial_status values that mean "money is secured". partially_paid is
// a deposit (the MK8's 25%) and authorized is a card hold awaiting capture
// -- both are real orders the shop should start on.
const PAID_STATUSES = new Set(['paid', 'partially_paid', 'authorized']);

// Mirrors the old webhook's defaults (see git history of
// routes/shopifyWebhooks.js): routine priority, Orders & Shipping fallback.
const PREFERRED_ORDER_PRIORITY_KEY = 'low_priority';
const FALLBACK_CATEGORY_KEY = 'orders_shipping';

const MAX_AUTO_ATTEMPTS = 24; // sweep every 5 min -> about two hours of retries
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A paid/updated/cancelled delivery for an order we've never seen is only
// trusted to start tracking it if the order is this recent -- anything
// older predates this feature and was handled by the old intake.
const LATE_START_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const XERO_NOTE_MAX = 2000; // same cap as services/ticketNotes.js

const DEFAULT_INTAKE = {
  create_customers: true,
  sync_xero_contacts: true,
  xero_note: true,
  create_tickets: true,
  skip_pos: true,
  wait_for_payment: true,
};

const xeroConfigured = () => Boolean(config.xero.clientId && config.xero.clientSecret);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function intakeSettings() {
  const { rows } = await query(
    "SELECT meta FROM settings WHERE category = 'shop_config' AND key = 'shopify_orders'",
  );
  const meta = (rows[0] && rows[0].meta) || {};
  const out = { ...DEFAULT_INTAKE };
  for (const key of Object.keys(DEFAULT_INTAKE)) {
    if (typeof meta[key] === 'boolean') out[key] = meta[key];
  }
  return out;
}

async function updateIntakeSettings(patch) {
  const clean = {};
  for (const key of Object.keys(DEFAULT_INTAKE)) {
    if (typeof patch[key] === 'boolean') clean[key] = patch[key];
  }
  // Upsert rather than assume migration 093's seed row is there -- a row
  // deleted by hand shouldn't make this screen unusable.
  await query(
    `INSERT INTO settings (category, key, label, sort_order, meta)
     VALUES ('shop_config', 'shopify_orders', 'Shopify order intake', 90, $1::jsonb)
     ON CONFLICT (category, key) DO UPDATE SET meta = settings.meta || $1::jsonb, updated_at = now()`,
    [JSON.stringify(clean)],
  );
  return intakeSettings();
}

async function loadRules() {
  const { rows } = await query('SELECT * FROM shopify_tag_rules ORDER BY sort_order, id');
  return rows;
}

// Settings -> Shop configuration -> "Default category for Shopify orders";
// falls back to orders_shipping, then to whatever's first active (N4a).
async function resolveOrderCategoryKey() {
  const configured = await settings.shopConfigString('shopify_default_category', null);
  return settings.defaultKeyPreferring('ticket_category', configured, FALLBACK_CATEGORY_KEY);
}

// ---------------------------------------------------------------------------
// Reading an order payload
// ---------------------------------------------------------------------------

const normEmail = (v) => String(v || '').trim().toLowerCase();

function orderEmail(order) {
  return normEmail(order.email || order.contact_email || (order.customer && order.customer.email));
}

function orderNumber(order) {
  return order.name || `#${order.order_number || order.id}`;
}

function isPos(order) {
  return String(order.source_name || '').toLowerCase() === 'pos';
}

function personName(order) {
  const c = order.customer || {};
  const fromParts = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  if (fromParts) return fromParts;
  const addr = order.shipping_address || order.billing_address || {};
  const fromAddr = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim();
  if (fromAddr) return fromAddr;
  return (addr.name || '').trim();
}

function customerNameFromOrder(order) {
  return personName(order) || orderEmail(order) || `Shopify order ${orderNumber(order)}`;
}

// Shopify's address is already structured, so it maps straight onto
// customers' structured columns (migration 060) and from there onto the
// Xero contact's address.
function addressFromOrder(order) {
  const a = order.shipping_address || order.billing_address || {};
  return {
    address_line1: a.address1 || null,
    address_line2: a.address2 || null,
    city: a.city || null,
    region: a.province_code || a.province || null,
    postal_code: a.zip || null,
    country: a.country_code || a.country || null,
  };
}

// Reverb and eBay orders reach Shopify through their channel apps; which
// channel shows up in source_name and/or the order's tags depending on the
// app, so look in both. Only used when *creating* a customer.
function sourceFromOrder(order) {
  const hay = [order.source_name, order.tags, order.source_identifier].join(' ').toLowerCase();
  if (hay.includes('reverb')) return 'reverb';
  if (hay.includes('ebay')) return 'ebay';
  return 'shopify';
}

function money(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? '');
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch (err) {
    return `${n.toFixed(2)} ${currency || ''}`.trim();
  }
}

function shopDate(iso) {
  const d = new Date(iso || Date.now());
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.shopTimezone, month: 'short', day: 'numeric', year: 'numeric',
  }).format(Number.isNaN(d.getTime()) ? new Date() : d);
}

// What the item actually cost: unit price x quantity, less any discount
// Shopify allocated to this line.
function lineValue(li) {
  const gross = Number(li.price) * Number(li.quantity || 0);
  const discount = (li.discount_allocations || []).reduce((s, d) => s + Number(d.amount || 0), 0);
  return Number.isFinite(gross) ? gross - (Number.isFinite(discount) ? discount : 0) : null;
}

function lineLabel(li) {
  return `${li.quantity}× ${li.title}${li.variant_title ? ` (${li.variant_title})` : ''}`;
}

function xeroNoteText(order) {
  const currency = order.currency || order.presentment_currency;
  const items = (order.line_items || [])
    .filter((li) => Number(li.quantity) > 0)
    .map((li) => {
      const v = lineValue(li);
      return `${lineLabel(li)}${v === null ? '' : ` ${money(v, currency)}`}`;
    });
  const head = `Shopify order ${orderNumber(order)} placed ${shopDate(order.processed_at || order.created_at)}`;
  const tail = `Order total ${money(order.total_price, currency)}`;
  const text = `${head}: ${items.join('; ')}. ${tail}.`;
  return text.length > XERO_NOTE_MAX ? `${text.slice(0, XERO_NOTE_MAX - 1)}…` : text;
}

function ticketNotes(order, groupItems, leftOff) {
  const currency = order.currency;
  const parts = [`Order items:\n${groupItems.map((li) => `- ${lineLabel(li)}`).join('\n')}`];
  if (leftOff.length) {
    parts.push(`Also on this order, not on this ticket:\n${
      leftOff.map(({ li, reason }) => `- ${lineLabel(li)} — ${reason}`).join('\n')}`);
  }
  if (order.total_price) parts.push(`Order total: ${money(order.total_price, currency)}`);
  const shipping = (order.shipping_lines || []).map((s) => s.title).filter(Boolean).join(', ');
  if (shipping) parts.push(`Shipping method: ${shipping}`);
  if (order.note) parts.push(`Customer note: ${order.note}`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Recording deliveries
// ---------------------------------------------------------------------------

async function archiveOrderTickets(shopifyOrderId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id FROM tickets WHERE shopify_order_id = $1 AND archived = FALSE',
      [shopifyOrderId],
    );
    for (const { id } of rows) {
      // A published note with no author, so it isn't posted to Xero --
      // same as the old cancel handler.
      // eslint-disable-next-line no-await-in-loop
      await insertNote(client, { ticketId: id, body: 'Order cancelled in Shopify.', createdBy: null });
      // eslint-disable-next-line no-await-in-loop
      await client.query('UPDATE tickets SET archived = TRUE, updated_at = now() WHERE id = $1', [id]);
    }
  });
}

/**
 * Store a webhook delivery. Returns the row (or null when there's nothing
 * to track). Never calls Shopify or Xero -- this is the part the webhook
 * waits on before replying.
 */
async function recordOrder(topic, order) {
  if (!order || !order.id) return null;
  const shopifyOrderId = String(order.id);
  const cancelled = topic === 'orders/cancelled' || Boolean(order.cancelled_at);

  if (topic !== 'orders/create') {
    const { rows } = await query('SELECT id FROM shopify_orders WHERE shopify_order_id = $1', [shopifyOrderId]);
    if (!rows[0]) {
      const createdAt = Date.parse(order.created_at || '');
      const recent = Number.isFinite(createdAt) && Date.now() - createdAt < LATE_START_WINDOW_MS;
      if (!recent) {
        // An order from before this feature: keep the old intake's one
        // behaviour that still matters (cancel archives its ticket) and
        // otherwise leave it alone.
        if (cancelled) await archiveOrderTickets(shopifyOrderId);
        return null;
      }
    }
  }

  // A newer payload replaces the stored one; an older one arriving late
  // (deliveries aren't ordered) doesn't. cancelled only ever turns on.
  const newer = `COALESCE((EXCLUDED.payload->>'updated_at')::timestamptz, now())
                 >= COALESCE((shopify_orders.payload->>'updated_at')::timestamptz, '-infinity'::timestamptz)`;
  const { rows } = await query(
    `INSERT INTO shopify_orders (shopify_order_id, order_name, financial_status, source_name, cancelled, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (shopify_order_id) DO UPDATE SET
       payload          = CASE WHEN ${newer} THEN EXCLUDED.payload ELSE shopify_orders.payload END,
       financial_status = CASE WHEN ${newer} THEN EXCLUDED.financial_status ELSE shopify_orders.financial_status END,
       order_name       = COALESCE(EXCLUDED.order_name, shopify_orders.order_name),
       source_name      = COALESCE(EXCLUDED.source_name, shopify_orders.source_name),
       cancelled        = shopify_orders.cancelled OR EXCLUDED.cancelled,
       needs_rerun      = TRUE,
       updated_at       = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [shopifyOrderId, order.name || null, order.financial_status || null, order.source_name || null,
      cancelled, JSON.stringify(order)],
  );
  const row = rows[0];

  if (row.inserted) {
    // An order the old intake already ticketed (it came in just before
    // this deploy, and this is a late paid/cancel for it) -- record it,
    // but don't post a Xero note or make a customer for it after the fact.
    const { rows: legacy } = await query('SELECT id FROM tickets WHERE shopify_order_id = $1', [shopifyOrderId]);
    if (legacy.length) {
      const msg = 'Handled by the previous order intake (before this upgrade)';
      const { rows: marked } = await query(
        `UPDATE shopify_orders SET customer_status = 'skipped', xero_contact_status = 'skipped',
                ticket_status = 'skipped', xero_note_status = 'skipped', ticket_ids = $2,
                detail = jsonb_build_object('customer', $3::text, 'xero_contact', $3::text,
                                            'ticket', $3::text, 'xero_note', $3::text)
          WHERE id = $1 RETURNING *`,
        [row.id, legacy.map((t) => t.id), msg],
      );
      return marked[0];
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Step 1: customer
// ---------------------------------------------------------------------------

async function findOrCreateCustomer(order, { create }) {
  const email = orderEmail(order);
  const shopifyCustomerId = order.customer && order.customer.id ? String(order.customer.id) : null;
  const phone = order.phone || (order.customer && order.customer.phone)
    || (order.shipping_address && order.shipping_address.phone) || null;
  const address = addressFromOrder(order);

  return withTransaction(async (client) => {
    let match = null;
    if (shopifyCustomerId) {
      const { rows } = await client.query('SELECT * FROM customers WHERE shopify_customer_id = $1', [shopifyCustomerId]);
      [match] = rows;
    }
    if (!match && email) {
      // Several MC2 customers can share an email (a household); prefer the
      // one already linked to Xero, then the oldest -- the same one a
      // person scanning the list would pick.
      const { rows } = await client.query(
        `SELECT * FROM customers WHERE lower(email) = $1
          ORDER BY (xero_contact_id IS NULL), id LIMIT 1`,
        [email],
      );
      [match] = rows;
    }

    if (match) {
      // Fill blanks only -- never overwrite what the shop already has on
      // file with whatever the buyer typed at checkout.
      const sets = [];
      const params = [match.id];
      const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (shopifyCustomerId && !match.shopify_customer_id) set('shopify_customer_id', shopifyCustomerId);
      if (!match.email && email) set('email', email);
      if (!match.phone && phone) set('phone', phone);
      const hasAnyAddress = match.address || ADDRESS_FIELDS.some((k) => match[k]);
      if (!hasAnyAddress && address.address_line1) {
        for (const k of ADDRESS_FIELDS) set(k, address[k]);
      }
      if (!sets.length) return { customer: match, created: false };
      const { rows } = await client.query(
        `UPDATE customers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params,
      );
      return { customer: rows[0], created: false };
    }

    if (!create) return null;
    // A POS sale with no customer attached has nothing to make a record
    // from -- don't invent "Shopify order #1001" as a person.
    if (!email && !shopifyCustomerId && !personName(order)) return null;

    const { rows } = await client.query(
      `INSERT INTO customers (name, email, phone, source, shopify_customer_id,
                              address_line1, address_line2, city, region, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [customerNameFromOrder(order), email || null, phone, sourceFromOrder(order), shopifyCustomerId,
        ...ADDRESS_FIELDS.map((k) => address[k])],
    );
    return { customer: rows[0], created: true };
  });
}

async function stepCustomer(row, order, cfg) {
  if (row.customer_id) return { status: 'done', message: `Customer #${row.customer_id}` };
  const result = await findOrCreateCustomer(order, { create: cfg.create_customers });
  if (!result) {
    return {
      status: 'skipped',
      message: cfg.create_customers
        ? 'No name, email or Shopify customer on this order'
        : 'No existing customer matched (creating customers is off)',
    };
  }
  const { customer, created } = result;
  return {
    status: 'done',
    message: `${created ? 'Created' : 'Matched'} customer #${customer.id} (${customer.name})`,
    patch: { customer_id: customer.id },
  };
}

// ---------------------------------------------------------------------------
// Step 2: Xero contact
// ---------------------------------------------------------------------------

async function loadCustomer(id) {
  if (!id) return null;
  const { rows } = await query('SELECT * FROM customers WHERE id = $1', [id]);
  return rows[0] || null;
}

async function stepXeroContact(row, cfg) {
  if (!cfg.sync_xero_contacts) return { status: 'skipped', message: 'Off in settings' };
  if (!xeroConfigured()) return { status: 'skipped', message: 'Xero is not configured' };
  const customer = await loadCustomer(row.customer_id);
  if (!customer) return { status: 'skipped', message: 'No customer on this order' };
  if (customer.xero_contact_id) return { status: 'done', message: 'Linked to Xero' };

  const email = normEmail(customer.email);
  if (email) {
    const candidates = (await xero.findContactsByEmail(email)).filter((c) => !c.IsSupplier);
    if (candidates.length) {
      const ids = candidates.map((c) => c.ContactID);
      const [{ rows: linked }, { rows: dismissed }] = await Promise.all([
        query('SELECT id, name, xero_contact_id FROM customers WHERE xero_contact_id = ANY($1::text[])', [ids]),
        query(
          `SELECT xero_contact_id FROM xero_dismissed_matches
            WHERE customer_id = $1 AND xero_contact_id = ANY($2::text[])`,
          [customer.id, ids],
        ),
      ]);
      const taken = new Set(linked.map((r) => r.xero_contact_id));
      // An admin said "not the same person" on the backfill screen -- respect it.
      const notThem = new Set(dismissed.map((r) => r.xero_contact_id));
      const open = candidates.filter((c) => !taken.has(c.ContactID) && !notThem.has(c.ContactID));

      if (open.length === 1) {
        try {
          await linkCustomerToXero(customer.id, open[0].ContactID);
        } catch (err) {
          if (err.code === '23505') {
            return { status: 'attention', message: `Xero contact "${open[0].Name}" was just linked to another customer` };
          }
          throw err;
        }
        return { status: 'done', message: `Linked to existing Xero contact "${open[0].Name}"` };
      }
      if (open.length > 1) {
        return {
          status: 'attention',
          message: `${open.length} Xero contacts use ${email} — link the right one from Customers → Xero backfill`,
        };
      }
      if (linked.length) {
        // The email's contact already belongs to a different MC2 customer:
        // most likely the same person twice in MC2. Creating a third record
        // in Xero would make it worse.
        return {
          status: 'attention',
          message: `This email's Xero contact is already linked to customer #${linked[0].id} `
            + `(${linked[0].name}) — probably a duplicate customer; merge them from Customers → Xero duplicates`,
        };
      }
      // Every match was dismissed as "not them": a new contact is right.
    }
  }

  await createCustomerInXero(customer);
  return { status: 'done', message: 'Created a new Xero contact' };
}

// ---------------------------------------------------------------------------
// Step 3: tickets
// ---------------------------------------------------------------------------

/**
 * Split the order's items into ticket groups. Returns
 * { groups: Map<groupKey, { rule|null, items[] }>, leftOff: [{ li, reason }] }.
 */
async function groupItems(order, cfg) {
  const items = (order.line_items || []).filter((li) => Number(li.quantity) > 0);
  const rules = await loadRules();
  // Tags aren't in the order payload -- only ask Shopify when a rule could
  // actually use the answer.
  const tagsByProduct = rules.length ? await shopify.productTags(items.map((li) => li.product_id)) : new Map();

  const groups = new Map();
  const leftOff = [];
  const add = (key, rule, li) => {
    if (!groups.has(key)) groups.set(key, { rule, items: [] });
    groups.get(key).items.push(li);
  };

  for (const li of items) {
    const tags = (tagsByProduct.get(String(li.product_id)) || []).map((t) => String(t).trim().toLowerCase());
    const rule = rules.find((r) => tags.includes(String(r.tag).trim().toLowerCase()));
    if (rule && rule.action === 'no_ticket') {
      leftOff.push({ li, reason: `tagged "${rule.tag}"` });
    } else if (rule) {
      add(`rule:${rule.id}`, rule, li);
    } else if (li.requires_shipping === false) {
      // Gift cards, digital goods, paid add-on services -- nothing to box up.
      leftOff.push({ li, reason: "doesn't require shipping" });
    } else if (cfg.skip_pos && isPos(order)) {
      leftOff.push({ li, reason: 'in-store (POS) sale' });
    } else {
      add('default', null, li);
    }
  }
  return { groups, leftOff };
}

async function ensureGroupTicket(row, order, groupKey, group, allGroups, leftOff) {
  const shopifyOrderId = String(order.id);
  const { rows: existing } = await query(
    'SELECT id FROM tickets WHERE shopify_order_id = $1 AND shopify_group_key = $2',
    [shopifyOrderId, groupKey],
  );
  if (existing[0]) return { id: existing[0].id, existed: true };

  const defaultCategory = await resolveOrderCategoryKey();
  let categoryKey = defaultCategory;
  let subcategoryKey = await activeSubcategoryKey(defaultCategory, SHOPIFY_SUBCATEGORY_KEY);
  if (group.rule) {
    // A rule pointing at a since-retired category degrades to the default
    // category rather than failing the order.
    categoryKey = await settings.defaultKeyPreferring('ticket_category', group.rule.category_key, defaultCategory);
    subcategoryKey = group.rule.subcategory_key
      ? await activeSubcategoryKey(categoryKey, group.rule.subcategory_key)
      : null;
  }
  const resolved = await resolveNewTicketFields({
    category_key: categoryKey,
    subcategory_key: subcategoryKey,
    priority_key: await settings.defaultKeyPreferring('priority_tier', PREFERRED_ORDER_PRIORITY_KEY),
  });

  const customer = await loadCustomer(row.customer_id);
  const customerName = (customer && customer.name) || customerNameFromOrder(order);
  const number = orderNumber(order);
  const naming = namingFor(resolved.category, resolved.subcategory);
  const title = (naming.template && renderNamingTemplate(naming.template, {
    customerName, ticketName: number, categoryLabel: resolved.category.label,
  })) || `Shopify order ${number} — ${customerName}`;

  // What this ticket's notes call "not on this ticket": items left off
  // entirely, plus items that went to one of this order's other tickets.
  const elsewhere = [...allGroups.entries()]
    .filter(([key]) => key !== groupKey)
    .flatMap(([, g]) => g.items.map((li) => ({ li, reason: 'on a separate ticket' })));

  try {
    const created = await withTransaction(async (client) => {
      const ticket = await insertTicketRow(
        client,
        {
          title,
          ticket_name: number,
          notes: ticketNotes(order, group.items, [...leftOff, ...elsewhere]),
          customer_id: customer ? customer.id : null,
          shopify_order_id: shopifyOrderId,
        },
        resolved,
        null, // no staff member created this ticket
      );
      await client.query('UPDATE tickets SET shopify_group_key = $2 WHERE id = $1', [ticket.id, groupKey]);
      return ticket;
    });
    return { id: created.id, existed: false };
  } catch (err) {
    // tickets_shopify_order_group_idx: the ticket appeared between the
    // check above and this insert. It exists, which is what we wanted.
    if (err.code === '23505') {
      const { rows } = await query(
        'SELECT id FROM tickets WHERE shopify_order_id = $1 AND shopify_group_key = $2',
        [shopifyOrderId, groupKey],
      );
      if (rows[0]) return { id: rows[0].id, existed: true };
    }
    throw err;
  }
}

async function stepTickets(row, order, cfg) {
  if (!cfg.create_tickets) return { status: 'skipped', message: 'Off in settings' };
  if (row.cancelled) return { status: 'skipped', message: 'Order was cancelled' };
  if (cfg.wait_for_payment && !PAID_STATUSES.has(order.financial_status)) {
    return { status: 'waiting', message: `Waiting for payment (${order.financial_status || 'unknown'})` };
  }

  const { groups, leftOff } = await groupItems(order, cfg);
  const leftOffText = leftOff.map(({ li, reason }) => `${lineLabel(li)} — ${reason}`).join('; ');
  if (!groups.size) {
    return { status: 'skipped', message: `No ticket needed: ${leftOffText || 'no items'}` };
  }

  const made = [];
  const ids = new Set(row.ticket_ids || []);
  for (const [key, group] of groups) {
    // eslint-disable-next-line no-await-in-loop
    const t = await ensureGroupTicket(row, order, key, group, groups, leftOff);
    ids.add(t.id);
    made.push(`#${t.id}${t.existed ? ' (already existed)' : ''}`);
  }
  return {
    status: 'done',
    message: `Ticket ${made.join(', ')}${leftOffText ? `. Left off: ${leftOffText}` : ''}`,
    patch: { ticket_ids: [...ids] },
  };
}

// ---------------------------------------------------------------------------
// Step 4: Xero note
// ---------------------------------------------------------------------------

async function stepXeroNote(row, order, cfg) {
  if (!cfg.xero_note) return { status: 'skipped', message: 'Off in settings' };
  if (!xeroConfigured()) return { status: 'skipped', message: 'Xero is not configured' };
  if (row.cancelled) return { status: 'skipped', message: 'Order was cancelled before the note was sent' };
  const customer = await loadCustomer(row.customer_id);
  if (!customer) return { status: 'skipped', message: 'No customer on this order' };
  if (!customer.xero_contact_id) {
    // Sent automatically once the customer gets linked (the sweep checks).
    return { status: 'waiting', message: "Customer isn't linked to a Xero contact yet" };
  }
  const text = xeroNoteText(order);
  await xero.addContactNote(customer.xero_contact_id, text);
  return { status: 'done', message: text };
}

// ---------------------------------------------------------------------------
// Running the steps
// ---------------------------------------------------------------------------

const SAVABLE = new Set([
  'customer_id', 'ticket_ids', 'detail', 'cancel_handled_at',
  ...STEPS.map((s) => `${s}_status`),
]);

async function saveRow(id, patch) {
  const cols = Object.keys(patch).filter((c) => SAVABLE.has(c));
  const params = [id, ...cols.map((c) => (c === 'detail' ? JSON.stringify(patch[c]) : patch[c]))];
  const sets = cols.map((c, i) => `${c} = $${i + 2}${c === 'detail' ? '::jsonb' : ''}`);
  const { rows } = await query(
    `UPDATE shopify_orders SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    params,
  );
  return rows[0];
}

// A 4xx from Shopify/Xero (bad payload, missing scope, bad credentials)
// won't fix itself on retry -- surface it as needing a person instead of
// burning through retries. Rate limits (429) and outages do get retried.
function outcomeForError(err) {
  const status = Number(err.status);
  const permanent = err.configError || (status >= 400 && status < 500 && status !== 429);
  return { status: permanent ? 'attention' : 'failed', message: err.message };
}

async function runSteps(initial) {
  const cfg = await intakeSettings();
  let row = initial;
  const order = row.payload;

  if (row.cancelled && !row.cancel_handled_at) {
    await archiveOrderTickets(String(order.id));
    row = await saveRow(row.id, { cancel_handled_at: new Date() });
  }

  const runners = {
    customer: () => stepCustomer(row, order, cfg),
    xero_contact: () => stepXeroContact(row, cfg),
    ticket: () => stepTickets(row, order, cfg),
    xero_note: () => stepXeroNote(row, order, cfg),
  };

  for (const step of STEPS) {
    if (SETTLED.has(row[`${step}_status`])) continue;
    let outcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await runners[step]();
    } catch (err) {
      console.error(`[shopify-orders] ${row.order_name || row.shopify_order_id} ${step} failed:`, err.message);
      outcome = outcomeForError(err);
    }
    // eslint-disable-next-line no-await-in-loop
    row = await saveRow(row.id, {
      ...(outcome.patch || {}),
      [`${step}_status`]: outcome.status,
      detail: { ...(row.detail || {}), [step]: outcome.message || null },
    });
  }
  return row;
}

/**
 * Process one order. Safe to call any number of times, concurrently: a
 * lease makes sure only one run works on an order at a time, and a
 * delivery that lands mid-run (needs_rerun) gets picked up before the
 * lease is released.
 */
async function processOrder(id) {
  let last = null;
  for (let pass = 0; pass < 3; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await query(
      `UPDATE shopify_orders
          SET lease_until = now() + interval '3 minutes', needs_rerun = FALSE,
              attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND (lease_until IS NULL OR lease_until < now())
        RETURNING *`,
      [id],
    );
    if (!rows[0]) return last; // another run holds it; it'll see needs_rerun
    try {
      // eslint-disable-next-line no-await-in-loop
      last = await runSteps(rows[0]);
    } catch (err) {
      // Something outside a step (the database) -- leave statuses as they
      // are; the sweep will try again.
      console.error(`[shopify-orders] processing order row ${id} failed:`, err);
    }
    // eslint-disable-next-line no-await-in-loop
    const { rows: released } = await query(
      `UPDATE shopify_orders SET lease_until = NULL, processed_at = now()
        WHERE id = $1 RETURNING *`,
      [id],
    );
    last = released[0] || last;
    if (!last || !last.needs_rerun) return last;
  }
  return last;
}

/** Fire-and-forget for the webhook: never throws, never delays the reply. */
function processOrderSoon(id) {
  setImmediate(() => {
    processOrder(id).catch((err) => console.error('[shopify-orders] background run failed', err));
  });
}

/**
 * "Re-run" from Settings: put steps that need a person (or ran out of
 * automatic retries) back to pending, and run now. Settled steps stay
 * settled -- no second ticket, contact or note.
 */
async function reprocessOrder(id) {
  const resets = STEPS.map((s) => `${s}_status = CASE WHEN ${s}_status IN ('attention','failed') THEN 'pending' ELSE ${s}_status END`);
  const { rows } = await query(
    `UPDATE shopify_orders SET ${resets.join(', ')}, attempts = 0, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!rows[0]) return null;
  return processOrder(id);
}

// ---------------------------------------------------------------------------
// Sweep: retries, interrupted runs, notes waiting on a Xero link
// ---------------------------------------------------------------------------

let sweeping = false;

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const { rows } = await query(
      `SELECT o.id
         FROM shopify_orders o
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE (o.lease_until IS NULL OR o.lease_until < now())
          AND o.received_at > now() - interval '30 days'
          AND (
                (o.attempts < $1 AND (
                   'pending' IN (o.customer_status, o.xero_contact_status, o.ticket_status, o.xero_note_status)
                   OR 'failed' IN (o.customer_status, o.xero_contact_status, o.ticket_status, o.xero_note_status)))
             OR (o.xero_note_status = 'waiting' AND c.xero_contact_id IS NOT NULL)
             OR (o.cancelled AND o.cancel_handled_at IS NULL)
             OR o.needs_rerun
          )
        ORDER BY o.received_at
        LIMIT 20`,
      [MAX_AUTO_ATTEMPTS],
    );
    for (const { id } of rows) {
      // eslint-disable-next-line no-await-in-loop
      await processOrder(id);
    }
  } catch (err) {
    console.error('[shopify-orders] sweep failed', err);
  } finally {
    sweeping = false;
  }
}

function start() {
  // Shortly after boot, pick up anything a restart interrupted.
  setTimeout(sweep, 30_000);
  return setInterval(sweep, SWEEP_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

function overallStatus(row) {
  const statuses = STEPS.map((s) => row[`${s}_status`]);
  for (const s of ['attention', 'failed', 'pending', 'waiting']) {
    if (statuses.includes(s)) return s;
  }
  return 'done';
}

function summarize(row) {
  const order = row.payload || {};
  return {
    id: row.id,
    shopify_order_id: row.shopify_order_id,
    order_name: row.order_name,
    received_at: row.received_at,
    processed_at: row.processed_at,
    financial_status: row.financial_status,
    source_name: row.source_name,
    cancelled: row.cancelled,
    total: order.total_price ? money(order.total_price, order.currency) : null,
    buyer: customerNameFromOrder(order),
    customer_id: row.customer_id,
    customer_name: row.customer_name || null,
    ticket_ids: row.ticket_ids || [],
    steps: Object.fromEntries(STEPS.map((s) => [s, {
      status: row[`${s}_status`], message: (row.detail || {})[s] || null,
    }])),
    status: overallStatus(row),
    attempts: row.attempts,
    processing: Boolean(row.lease_until && new Date(row.lease_until) > new Date()),
  };
}

async function listOrders({ limit = 50, onlyProblems = false } = {}) {
  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name
       FROM shopify_orders o LEFT JOIN customers c ON c.id = o.customer_id
      ${onlyProblems ? `WHERE 'attention' IN (o.customer_status, o.xero_contact_status, o.ticket_status, o.xero_note_status)
                          OR 'failed' IN (o.customer_status, o.xero_contact_status, o.ticket_status, o.xero_note_status)` : ''}
      ORDER BY o.received_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  return rows.map(summarize);
}

async function getOrder(id) {
  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name
       FROM shopify_orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [id],
  );
  return rows[0] ? summarize(rows[0]) : null;
}

module.exports = {
  recordOrder,
  processOrder,
  processOrderSoon,
  reprocessOrder,
  start,
  intakeSettings,
  updateIntakeSettings,
  loadRules,
  listOrders,
  getOrder,
  // exported for tests
  xeroNoteText,
  groupItems,
  sourceFromOrder,
};
