'use strict';

/**
 * Customer-facing quotes — the "Estimates" page. Lives on the same
 * `estimates`/`estimate_items` tables as routes/estimates.js's internal,
 * post-ticket hours estimates (migration 011 added `kind` to tell them
 * apart), but as its own route file: the two payload shapes (a handful of
 * numbers on an existing ticket, vs. a customer + a list of
 * instrument/procedure line items with no ticket yet) have nothing in
 * common, so sharing handlers would just mean branching on `kind`
 * everywhere. Every route here hardcodes kind = 'customer_quote' and never
 * touches a 'ticket_estimate' row. See NOTES.md for the full writeup.
 */

const express = require('express');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, conflict } = require('../middleware/errors');
const settings = require('../services/settings');
const config = require('../config');
const { sendEmail } = require('../mailer');
const { buildQuoteEmail } = require('../templates/quoteEmail');
const { buildEstimateAcceptedNotice } = require('../templates/estimateAcceptedNotice');
const { resolveNewTicketFields, insertTicketRow, composeTicketTitle } = require('./tickets');

const router = express.Router();
router.use(requireAuth);

const DEFAULT_LABOR_RATE = 185.00;
// Preferred, not guaranteed (N4a) — Settings can retire either at any time,
// so both go through settings.defaultKeyPreferring() below rather than
// straight to resolveActive() when nothing more specific was supplied.
// N2b retired 'servicing' into the merged 'repairs_restoration'; N4b
// replaced 'standard_setup' with the new urgency-based tiers.
const PREFERRED_CATEGORY_KEY = 'repairs_restoration';
const PREFERRED_PRIORITY_KEY = 'standard_priority';

const QUOTE_SELECT = `
  SELECT e.*, c.name AS customer_name, c.email AS customer_email
    FROM estimates e
    LEFT JOIN customers c ON c.id = e.customer_id
`;

// Parts-by-variant (migration 043) — a standard_procedures row prices its
// parts either a single flat_cost or one of these four key-count columns,
// never both. Keys here match the `parts_variant` value a client sends
// (`piano_bass`, not the column's `parts_cost_piano_bass`).
const VARIANT_LABELS = {
  piano_bass: 'Piano Bass',
  '54_key': '54-Key',
  '73_key': '73-Key',
  '88_key': '88-Key',
};

/** Resolves one requested {procedure_id, parts_variant?} line against its
 * standard_procedures row into everything estimate_items snapshots.
 * `parts_variant` must be supplied (and name one of the procedure's
 * actually-populated variant columns) whenever the procedure prices its
 * parts by key count — there's no safe default to fall back to, since
 * guessing wrong silently under- or over-quotes a customer. A procedure
 * with no variant columns set at all (the common case) ignores it
 * entirely. */
function resolveProcedureItem(procedure, requestedVariant) {
  const availableVariants = Object.keys(VARIANT_LABELS)
    .filter((v) => procedure[`parts_cost_${v}`] !== null);

  let variantKey = null;
  if (availableVariants.length) {
    if (!requestedVariant || !availableVariants.includes(requestedVariant)) {
      throw badRequest(
        `"${procedure.name}" prices its parts by key count — pick one of: `
        + availableVariants.map((v) => VARIANT_LABELS[v]).join(', '),
      );
    }
    variantKey = requestedVariant;
  }

  const resolvedPartsAmount = variantKey
    ? Number(procedure[`parts_cost_${variantKey}`])
    : (procedure.flat_cost !== null ? Number(procedure.flat_cost) : null);

  return {
    pricing_type: procedure.pricing_type,
    min_hours: procedure.min_hours,
    max_hours: procedure.max_hours,
    outlier_hours: procedure.outlier_hours,
    // A 'flat' procedure's whole price lives in flat_cost (unchanged
    // shape); an 'hours' procedure's parts are additive to its labor, so
    // they get their own column instead — see migration 043.
    flat_cost: procedure.pricing_type === 'flat' ? resolvedPartsAmount : null,
    parts_cost: procedure.pricing_type === 'hours' ? resolvedPartsAmount : null,
    parts_variant_key: variantKey,
    parts_variant_label_snapshot: variantKey ? VARIANT_LABELS[variantKey] : null,
  };
}

/** Dollar range across an estimate's items, using its own frozen labor_rate
 * (never the live shop_config value — see comment on `labor_rate` below).
 * `parts_cost` (migration 043) is additive to an hours-based item's labor
 * cost at both ends of the range — it's a fixed dollar amount, not
 * something that varies with how long the job takes. */
function totalsFor(items, laborRate) {
  let minCost = 0;
  let maxCost = 0;
  let minHours = 0;
  let maxHours = 0;
  for (const item of items) {
    if (item.pricing_type === 'flat') {
      minCost += Number(item.flat_cost);
      maxCost += Number(item.flat_cost);
    } else {
      const parts = Number(item.parts_cost || 0);
      minCost += Number(item.min_hours) * laborRate + parts;
      maxCost += Number(item.max_hours) * laborRate + parts;
      minHours += Number(item.min_hours);
      maxHours += Number(item.max_hours);
    }
  }
  return {
    min_cost: Math.round(minCost * 100) / 100,
    max_cost: Math.round(maxCost * 100) / 100,
    min_hours: minHours,
    max_hours: maxHours,
  };
}

/** Internal-only estimate-builder heads-up — never sent to a customer (see
 * publicQuotes.js and templates/quoteEmail.js, neither of which touch
 * this). The ask: assume one of the jobs on this quote turns into an
 * outlier, and budget the *average* size of that overage, since there's
 * no way to know in advance which line item (if any) it'll be. Computed
 * as the mean, across every hours-based line item that has an
 * outlier_hours reference, of (outlier_hours - max_hours) — how far past
 * its own normal high end that item's outlier would run. Zero when
 * nothing on the quote has an outlier_hours value to go on. */
function outlierBufferFor(items, laborRate) {
  const overages = items
    .filter((it) => it.pricing_type === 'hours' && it.outlier_hours !== null && it.outlier_hours !== undefined)
    .map((it) => Number(it.outlier_hours) - Number(it.max_hours));
  if (!overages.length) return { outlier_buffer_hours: 0, outlier_buffer_cost: 0 };
  const meanOverage = overages.reduce((a, b) => a + b, 0) / overages.length;
  return {
    outlier_buffer_hours: Math.round(meanOverage * 100) / 100,
    outlier_buffer_cost: Math.round(meanOverage * laborRate * 100) / 100,
  };
}

async function loadItems(estimateId) {
  const { rows } = await query(
    'SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order, id',
    [estimateId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// List — the Estimates page. Defaults to "ongoing" (everything short of a
// finished conversion); ?status=all or an explicit ?status= overrides that.
// ---------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const clauses = ["e.kind = 'customer_quote'"];
  const params = [];
  if (req.query.status && req.query.status !== 'all') {
    params.push(req.query.status);
    clauses.push(`e.status = $${params.length}`);
  } else if (!req.query.status) {
    clauses.push("e.status != 'ticket_created'");
  }
  const { rows } = await query(
    `SELECT e.*, c.name AS customer_name, c.email AS customer_email,
            COALESCE(agg.item_count, 0) AS item_count,
           COALESCE(agg.min_cost, 0)   AS min_cost,
            COALESCE(agg.max_cost, 0)   AS max_cost
       FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS item_count,
                sum(CASE WHEN pricing_type = 'flat' THEN flat_cost
                         ELSE min_hours * e.labor_rate + COALESCE(parts_cost, 0) END) AS min_cost,
                sum(CASE WHEN pricing_type = 'flat' THEN flat_cost
                         ELSE max_hours * e.labor_rate + COALESCE(parts_cost, 0) END) AS max_cost
         FROM estimate_items WHERE estimate_id = e.id
       ) agg ON TRUE
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.created_at DESC`,
    params,
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Detail — the estimate plus its items and whatever tickets it has already
// produced (empty until status = 'ticket_created').
// ---------------------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query(`${QUOTE_SELECT} WHERE e.id = $1 AND e.kind = 'customer_quote'`, [req.params.id]);
  const estimate = rows[0];
  if (!estimate) throw notFound('Estimate not found');

  const [items, tickets] = await Promise.all([
    loadItems(estimate.id),
    query(
      `SELECT t.id, t.title, t.instrument_id, t.category_label_snapshot,
              t.status_key, t.status_label_snapshot
         FROM tickets t WHERE t.source_estimate_id = $1 ORDER BY t.created_at`,
      [estimate.id],
    ),
  ]);

  res.json({
    ...estimate,
    items,
    tickets: tickets.rows,
    ...totalsFor(items, Number(estimate.labor_rate)),
    ...outlierBufferFor(items, Number(estimate.labor_rate)),
  });
}));

// ---------------------------------------------------------------------------
// Create — customer + a list of {instrument_id, procedure_id} pairs.
// Creating the customer or an instrument that doesn't exist yet happens
// through the normal POST /customers / POST /instruments first (same as
// TicketNewView.vue already does) — this route only ever links ids that
// already exist, same division of labor as POST /tickets.
// ---------------------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) throw badRequest('customer_id is required');
  if (!Array.isArray(b.items) || !b.items.length) throw badRequest('At least one line item is required');

  const { rows: customerRows } = await query('SELECT * FROM customers WHERE id = $1', [b.customer_id]);
  const customer = customerRows[0];
  if (!customer) throw badRequest(`Customer #${b.customer_id} not found`);

  const categoryKey = b.category_key
    || await settings.defaultKeyPreferring('ticket_category', PREFERRED_CATEGORY_KEY);
  const priorityKey = b.priority_key
    || await settings.defaultKeyPreferring('priority_tier', PREFERRED_PRIORITY_KEY);
  await settings.resolveActive('ticket_category', categoryKey);
  await settings.resolveActive('priority_tier', priorityKey);

  const laborRate = await settings.shopConfigNumber('labor_rate', DEFAULT_LABOR_RATE);

  // Resolve + snapshot every item's instrument and procedure up front, so a
  // bad id (or an unresolved parts variant) in the middle of the list
  // fails before anything is written.
  const resolvedItems = [];
  for (const item of b.items) {
    if (!item.procedure_id) throw badRequest('Each item needs a procedure_id');
    // eslint-disable-next-line no-await-in-loop
    const { rows: procRows } = await query('SELECT * FROM standard_procedures WHERE id = $1', [item.procedure_id]);
    const procedure = procRows[0];
    if (!procedure) throw badRequest(`Procedure #${item.procedure_id} not found`);

    let instrument = null;
    if (item.instrument_id) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: instRows } = await query('SELECT * FROM instruments WHERE id = $1', [item.instrument_id]);
      instrument = instRows[0];
      if (!instrument) throw badRequest(`Instrument #${item.instrument_id} not found`);
    }

    resolvedItems.push({
      instrument_id: instrument ? instrument.id : null,
      instrument_family: instrument ? instrument.family : null,
      instrument_model: instrument ? instrument.model : null,
      procedure_id: procedure.id,
      procedure_name: procedure.name,
      ...resolveProcedureItem(procedure, item.parts_variant),
    });
  }

  const estimate = await withTransaction(async (client) => {
    const { rows: created } = await client.query(
      `INSERT INTO estimates (kind, customer_id, title, category_key, priority_key,
                              labor_rate, notes, created_by)
       VALUES ('customer_quote', $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        customer.id,
        b.title || `${customer.name} — estimate`,
        categoryKey, priorityKey, laborRate,
        b.notes || null, req.user.id,
      ],
    );
    const row = created[0];

    for (let i = 0; i < resolvedItems.length; i += 1) {
      const item = resolvedItems[i];
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, instrument_id, instrument_family, instrument_model,
            procedure_id, procedure_name, pricing_type, min_hours, max_hours, flat_cost,
            parts_cost, parts_variant_key, parts_variant_label_snapshot, outlier_hours, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          row.id, item.instrument_id, item.instrument_family, item.instrument_model,
          item.procedure_id, item.procedure_name, item.pricing_type, item.min_hours, item.max_hours,
          item.flat_cost, item.parts_cost, item.parts_variant_key, item.parts_variant_label_snapshot,
          item.outlier_hours, (i + 1) * 10,
        ],
      );
    }
    return row;
  });

  const items = await loadItems(estimate.id);
  res.status(201).json({
    ...estimate,
    items,
    tickets: [],
    ...totalsFor(items, Number(estimate.labor_rate)),
    ...outlierBufferFor(items, Number(estimate.labor_rate)),
  });
}));

// ---------------------------------------------------------------------------
// Update — title/category/priority/notes, and a wholesale items replace.
// Only while still a draft: once it's gone out (or further), the customer
// may already be looking at the numbers it had at send time, so changing
// them out from under that link would be confusing at best.
// ---------------------------------------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await query(
    "SELECT * FROM estimates WHERE id = $1 AND kind = 'customer_quote'", [req.params.id],
  );
  const existing = existingRows[0];
  if (!existing) throw notFound('Estimate not found');
  if (existing.status !== 'draft') {
    throw badRequest(`Cannot edit an estimate once it's been sent (current status: ${existing.status})`);
  }

  if (b.category_key) await settings.resolveActive('ticket_category', b.category_key);
  if (b.priority_key) await settings.resolveActive('priority_tier', b.priority_key);

  const estimate = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE estimates SET
         title        = COALESCE($2, title),
         category_key = COALESCE($3, category_key),
         priority_key = COALESCE($4, priority_key),
         notes        = COALESCE($5, notes)
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.title || null, b.category_key || null, b.priority_key || null,
        b.notes === undefined ? null : b.notes],
    );
    const row = rows[0];

    if (Array.isArray(b.items)) {
      if (!b.items.length) throw badRequest('At least one line item is required');
      await client.query('DELETE FROM estimate_items WHERE estimate_id = $1', [row.id]);
      for (let i = 0; i < b.items.length; i += 1) {
        const item = b.items[i];
        if (!item.procedure_id) throw badRequest('Each item needs a procedure_id');
        // eslint-disable-next-line no-await-in-loop
        const { rows: procRows } = await client.query(
          'SELECT * FROM standard_procedures WHERE id = $1', [item.procedure_id],
        );
        const procedure = procRows[0];
        if (!procedure) throw badRequest(`Procedure #${item.procedure_id} not found`);

        let instrument = null;
        if (item.instrument_id) {
          // eslint-disable-next-line no-await-in-loop
          const { rows: instRows } = await client.query(
            'SELECT * FROM instruments WHERE id = $1', [item.instrument_id],
          );
          instrument = instRows[0];
          if (!instrument) throw badRequest(`Instrument #${item.instrument_id} not found`);
        }

        const resolved = resolveProcedureItem(procedure, item.parts_variant);

        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO estimate_items
             (estimate_id, instrument_id, instrument_family, instrument_model,
              procedure_id, procedure_name, pricing_type, min_hours, max_hours, flat_cost,
              parts_cost, parts_variant_key, parts_variant_label_snapshot, outlier_hours, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            row.id, instrument ? instrument.id : null,
            instrument ? instrument.family : null, instrument ? instrument.model : null,
            procedure.id, procedure.name, resolved.pricing_type, resolved.min_hours, resolved.max_hours,
            resolved.flat_cost, resolved.parts_cost, resolved.parts_variant_key,
            resolved.parts_variant_label_snapshot, resolved.outlier_hours, (i + 1) * 10,
          ],
        );
      }
    }
    return row;
  });

  const items = await loadItems(estimate.id);
  res.json({
    ...estimate,
    items,
    tickets: [],
    ...totalsFor(items, Number(estimate.labor_rate)),
    ...outlierBufferFor(items, Number(estimate.labor_rate)),
  });
}));

// ---------------------------------------------------------------------------
// Send — emails the itemized estimate with a link to the public
// confirm/decline page. Re-sendable (e.g. the customer lost the email)
// without losing whatever's already happened — it only ever moves status
// forward from 'draft', never backward from 'confirmed'/'declined'.
// ---------------------------------------------------------------------------
router.post('/:id/send', asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM estimates WHERE id = $1 AND kind = 'customer_quote'", [req.params.id],
  );
  const estimate = rows[0];
  if (!estimate) throw notFound('Estimate not found');
  if (estimate.status === 'ticket_created') {
    throw conflict('This estimate already has a ticket created — nothing to send.');
  }
  if (!config.appBaseUrl) {
    throw badRequest('APP_BASE_URL is not configured — the confirmation link would be broken.');
  }

  const { rows: customerRows } = await query('SELECT * FROM customers WHERE id = $1', [estimate.customer_id]);
  const customer = customerRows[0];
  if (!customer || !customer.email) {
    throw badRequest('This customer has no email address on file.');
  }

  const items = await loadItems(estimate.id);
  // Deliberately just the real total — outlierBufferFor() is an internal
  // planning number and must never reach a customer, so it's not computed
  // here at all, let alone passed into the email.
  const totals = totalsFor(items, Number(estimate.labor_rate));

  const confirmToken = estimate.confirm_token || crypto.randomBytes(24).toString('hex');
  const { subject, html, attachments } = buildQuoteEmail({
    estimate, customer, items, totals, confirmUrl: `${config.appBaseUrl}/quote/${confirmToken}`,
  });

  try {
    await sendEmail({
      to: customer.email, subject, html, attachments,
    });
    await query(
      `INSERT INTO emails (recipient, template, subject, customer_id, status, sent_at)
       VALUES ($1, 'customer_quote', $2, $3, 'sent', now())`,
      [customer.email, subject, customer.id],
    );
  } catch (err) {
    await query(
      `INSERT INTO emails (recipient, template, subject, customer_id, status, error)
       VALUES ($1, 'customer_quote', $2, $3, 'failed', $4)`,
      [customer.email, subject, customer.id, err.message],
    );
    throw badRequest(`Could not send estimate: ${err.message}`);
  }

  const { rows: updated } = await query(
    `UPDATE estimates SET
       confirm_token = $2,
       sent_at = now(),
       status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END
     WHERE id = $1 RETURNING *`,
    [estimate.id, confirmToken],
  );
  res.json({
    ...updated[0], items, tickets: [], ...totals, ...outlierBufferFor(items, Number(estimate.labor_rate)),
  });
}));

// ---------------------------------------------------------------------------
// Convert to ticket(s) — one ticket per distinct instrument on the
// estimate (per-instrument tickets keep the same status/assignee/QC
// tracking every other ticket gets; see NOTES.md for why this isn't one
// combined multi-instrument ticket). Shared with the public confirm route,
// which calls this same function so "staff clicked Create ticket first"
// and "customer confirmed first" can never both fire — whichever happens
// first flips status to 'ticket_created' and the other becomes a no-op.
// ---------------------------------------------------------------------------
async function createTicketsForEstimate(estimate, createdById) {
  // Resolved outside the transaction, same reasoning as the
  // create-shipping-ticket route above it in tickets.js: category/priority
  // resolution is read-only settings lookups that don't need — and
  // shouldn't have to compete for — a connection out of the same pool the
  // transaction below is holding one of.
  const resolved = await resolveNewTicketFields({
    category_key: estimate.category_key
      || await settings.defaultKeyPreferring('ticket_category', PREFERRED_CATEGORY_KEY),
    priority_key: estimate.priority_key
      || await settings.defaultKeyPreferring('priority_tier', PREFERRED_PRIORITY_KEY),
  });

  return withTransaction(async (client) => {
    const { rows: lockedRows } = await client.query(
      "SELECT * FROM estimates WHERE id = $1 AND kind = 'customer_quote' FOR UPDATE", [estimate.id],
    );
    const locked = lockedRows[0];
    if (!locked) throw notFound('Estimate not found');
    if (locked.status === 'ticket_created') {
      // Already converted (the other path won the race) — return what
      // exists instead of erroring, so both callers can treat this as success.
      const { rows: existingTickets } = await client.query(
        'SELECT id, title, instrument_id FROM tickets WHERE source_estimate_id = $1 ORDER BY created_at',
        [locked.id],
      );
      return { estimate: locked, tickets: existingTickets };
    }

    const { rows: items } = await client.query(
      'SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order, id', [locked.id],
    );

    const byInstrument = new Map();
    for (const item of items) {
      const key = item.instrument_id || 'none';
      if (!byInstrument.has(key)) byInstrument.set(key, []);
      byInstrument.get(key).push(item);
    }

    const createdTickets = [];
    for (const [, groupItems] of byInstrument) {
      const first = groupItems[0];
      const lines = groupItems.map((it) => {
        let cost;
        if (it.pricing_type === 'flat') {
          cost = `$${Number(it.flat_cost).toFixed(2)}`;
        } else {
          cost = `${it.min_hours}-${it.max_hours} hrs`;
          if (it.parts_cost) cost += ` + $${Number(it.parts_cost).toFixed(2)} parts`;
        }
        return `- ${it.procedure_name} (${cost})`;
      }).join('\n');
      const notes = `From Estimate #${locked.id}${locked.title ? ` — "${locked.title}"` : ''}:\n${lines}`
        + (locked.notes ? `\n\n${locked.notes}` : '');

      // N10: same standardized "[Client] - ["Nickname"] [Year] [Family]
      // [Model]" title every other ticket-creation path uses (routes/
      // tickets.js's composeTicketTitle) — an estimate-originated ticket
      // used to instead get its own "[Family] [Model] — [Procedure]"
      // format built right here, so the same customer's instrument looked
      // different depending on whether its ticket came from a walk-in
      // intake or a confirmed estimate. A "General" group (no instrument
      // on this line item at all — items with no instrument_id share the
      // 'none' bucket in byInstrument above) has nothing for
      // composeTicketTitle to describe beyond the customer name, so the
      // procedure(s) are appended the same way the old title did, instead
      // of losing that distinguishing info entirely.
      // eslint-disable-next-line no-await-in-loop
      let title = await composeTicketTitle(locked.customer_id, first.instrument_id);
      if (!first.instrument_id) {
        const procedurePart = `${first.procedure_name}${groupItems.length > 1 ? ' + more' : ''}`;
        title = title ? `${title} - ${procedurePart}` : procedurePart;
      }

      // eslint-disable-next-line no-await-in-loop
      const ticket = await insertTicketRow(
        client,
        {
          title,
          notes,
          instrument_id: first.instrument_id,
          customer_id: locked.customer_id,
          source_estimate_id: locked.id,
        },
        resolved,
        createdById,
      );
      createdTickets.push(ticket);

      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE estimate_items SET ticket_id = $1 WHERE id = ANY($2::int[])`,
        [ticket.id, groupItems.map((it) => it.id)],
      );

      // Each procedure line item that just landed on this ticket becomes
      // one of its tasks (migration 022, NOTES.md §2.28) — technician_id
      // starts unassigned (a quote doesn't know who'll actually do the
      // work; a tech claims it later, or an admin assigns it), and
      // position stacks in the same sort_order the items were already
      // shown in on the quote. Whether these are visible on anyone's
      // dashboard yet depends on the new ticket's status, same as any
      // other task (see routes/tasks.js's unlocked_only) — nothing
      // special-cased here for that.
      let taskPosition = 0;
      for (const item of groupItems) {
        taskPosition += 10;
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO ticket_tasks (ticket_id, standard_procedure_id, estimate_item_id, title, position, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [ticket.id, item.procedure_id, item.id, item.procedure_name, taskPosition, createdById],
        );
      }
    }

    const { rows: updatedEstimate } = await client.query(
      "UPDATE estimates SET status = 'ticket_created' WHERE id = $1 RETURNING *", [locked.id],
    );
    return { estimate: updatedEstimate[0], tickets: createdTickets };
  });
}

// ---------------------------------------------------------------------------
// Accepted-estimate notice — every admin-level employee gets an email the
// moment a customer accepts (publicQuotes.js's POST /:token/confirm, the
// only place an estimate's status becomes 'confirmed'). Same one-send-
// plus-one-emails-row-per-recipient convention as services/ceppys.js.
// Deliberately swallows everything rather than throwing: a broken or
// unconfigured mailer, or an admin with a bad address, must never turn a
// customer's successful accept into an error response, and the caller
// (publicQuotes.js) doesn't need to know or care whether this ran.
// ---------------------------------------------------------------------------
async function notifyAdminsEstimateAccepted(estimate, customerName) {
  const EMAIL_TEMPLATE = 'estimate_accepted_notice';
  try {
    if (!config.resend.apiKey || !config.resend.fromEmail) return; // not configured — nothing to send

    const { rows: admins } = await query(
      `SELECT id, name, email FROM employees
        WHERE active = TRUE AND role = 'admin' AND email IS NOT NULL AND email <> ''`,
    );
    if (!admins.length) return;

    const items = await loadItems(estimate.id);
    const totals = totalsFor(items, Number(estimate.labor_rate));
    const estimateUrl = config.appBaseUrl ? `${config.appBaseUrl}/estimates/${estimate.id}` : null;
    const { subject, html, attachments } = buildEstimateAcceptedNotice({
      estimate, customerName, totals, estimateUrl,
    });

    for (const admin of admins) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sendEmail({
          to: admin.email, subject, html, attachments,
        });
        // eslint-disable-next-line no-await-in-loop
        await query(
          `INSERT INTO emails (recipient, template, subject, customer_id, status, sent_at)
           VALUES ($1, $2, $3, $4, 'sent', now())`,
          [admin.email, EMAIL_TEMPLATE, subject, estimate.customer_id],
        );
      } catch (err) {
        // eslint-disable-next-line no-await-in-loop
        await query(
          `INSERT INTO emails (recipient, template, subject, customer_id, status, error)
           VALUES ($1, $2, $3, $4, 'failed', $5)`,
          [admin.email, EMAIL_TEMPLATE, subject, estimate.customer_id, err.message],
        );
      }
    }
  } catch (err) {
    // Anything above the per-recipient loop (the admins query itself,
    // loadItems, template build) lands here — logged nowhere else, so at
    // least surface it on the server console rather than losing it silently.
    // eslint-disable-next-line no-console
    console.error('notifyAdminsEstimateAccepted failed:', err);
  }
}

router.post('/:id/create-tickets', asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM estimates WHERE id = $1 AND kind = 'customer_quote'", [req.params.id],
  );
  const estimate = rows[0];
  if (!estimate) throw notFound('Estimate not found');

  const result = await createTicketsForEstimate(estimate, req.user.id);
  res.json(result);
}));

module.exports = router;
module.exports.createTicketsForEstimate = createTicketsForEstimate;
module.exports.notifyAdminsEstimateAccepted = notifyAdminsEstimateAccepted;
