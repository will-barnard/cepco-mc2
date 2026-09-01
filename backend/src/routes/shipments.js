'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

const TYPES = ['basic', 'deep_pack'];

// Shared by POST / (a shipment created on its own, e.g. from a ticket's
// Shipment card) and routes/tickets.js's "Create shipping ticket" button,
// which creates the ticket and its shipment together in one transaction.
// Takes a client (not the pool-level `query`) so the caller controls the
// transaction boundary — POST / below wraps a single call in its own
// withTransaction; tickets.js's caller shares its own.
async function createShipment(client, b) {
  if (!b.ticketId) throw badRequest('ticket_id is required');
  if (b.type && !TYPES.includes(b.type)) throw badRequest(`type must be one of: ${TYPES.join(', ')}`);

  // Seed the checklist from a shipping template for the instrument's family.
  let checklist = b.checklist;
  if (!checklist) {
    const { rows: tmpl } = await client.query(
      `SELECT qt.items FROM tickets t
         LEFT JOIN instruments i ON i.id = t.instrument_id
         JOIN qc_templates qt ON qt.kind = 'shipping' AND qt.active = TRUE
                             AND (qt.family = i.family OR qt.family IS NULL)
        WHERE t.id = $1 ORDER BY qt.family NULLS LAST LIMIT 1`,
      [b.ticketId],
    );
    checklist = (tmpl[0]?.items || []).map((i) => ({ label: i.label, note: i.note || null, checked: false }));
  }

  const { rows } = await client.query(
    `INSERT INTO shipments (ticket_id, type, method, contact_info, international,
                            scheduled_date, tracking_number, checklist, notes)
     VALUES ($1, COALESCE($2,'basic'), $3, $4, COALESCE($5,FALSE), $6, $7, $8, $9) RETURNING *`,
    [b.ticketId, b.type, b.method || null, b.contactInfo || null, b.international,
      b.scheduledDate || null, b.trackingNumber || null, JSON.stringify(checklist), b.notes || null],
  );
  return rows[0];
}

router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.ticket_id) { params.push(req.query.ticket_id); clauses.push(`s.ticket_id = $${params.length}`); }
  if (req.query.pending === 'true') clauses.push('s.shipped_at IS NULL');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT s.*, t.title AS ticket_title, c.name AS customer_name
       FROM shipments s
       JOIN tickets t ON t.id = s.ticket_id
       LEFT JOIN customers c ON c.id = t.customer_id
       ${where} ORDER BY s.scheduled_date NULLS LAST, s.created_at DESC`,
    params,
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const shipment = await withTransaction((client) => createShipment(client, {
    ticketId: b.ticket_id,
    type: b.type,
    method: b.method,
    contactInfo: b.contact_info,
    international: b.international,
    scheduledDate: b.scheduled_date,
    trackingNumber: b.tracking_number,
    checklist: b.checklist,
    notes: b.notes,
  }));
  res.status(201).json(shipment);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.type && !TYPES.includes(b.type)) throw badRequest(`type must be one of: ${TYPES.join(', ')}`);
  const { rows } = await query(
    `UPDATE shipments SET
       type = COALESCE($2, type), method = COALESCE($3, method),
       contact_info = COALESCE($4, contact_info),
       international = COALESCE($5, international),
       scheduled_date = COALESCE($6, scheduled_date),
       tracking_number = COALESCE($7, tracking_number),
       checklist = COALESCE($8, checklist),
       notes = COALESCE($9, notes),
       shipped_at = CASE WHEN $10::boolean THEN now() ELSE shipped_at END
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.type || null, b.method || null,
      b.contact_info === undefined ? null : b.contact_info,
      b.international === undefined ? null : b.international,
      b.scheduled_date || null, b.tracking_number || null,
      b.checklist === undefined ? null : JSON.stringify(b.checklist),
      b.notes === undefined ? null : b.notes,
      b.mark_shipped === true],
  );
  if (!rows[0]) throw notFound('Shipment not found');
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Shipment items (migration 040) — grouping an already-existing ticket's
// instrument onto *this* shipment instead of "Ship this instrument" always
// spinning up its own disconnected shipping ticket. See that migration's
// header for the full rationale.
// ---------------------------------------------------------------------------

// Candidates for "+ Add instrument": open tickets with an instrument that
// aren't already spoken for by some shipment — either as a shipment's own
// ticket, or already pulled in as another shipment's item. Scoped to one
// shipment (excludes that shipment's own ticket) and optionally filtered by
// a free-text q against title/customer/instrument, same ILIKE shape GET
// /tickets uses for its own q filter.
router.get('/:id/candidate-tickets', asyncHandler(async (req, res) => {
  const { rows: shipRows } = await query('SELECT ticket_id FROM shipments WHERE id = $1', [req.params.id]);
  const shipment = shipRows[0];
  if (!shipment) throw notFound('Shipment not found');

  const params = [shipment.ticket_id];
  let extra = '';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    extra = `AND (t.title ILIKE $${params.length} OR c.name ILIKE $${params.length}
                  OR i.model ILIKE $${params.length} OR i.nickname ILIKE $${params.length})`;
  }
  const { rows } = await query(
    `SELECT t.id, t.title, c.name AS customer_name,
            COALESCE(i.nickname, i.model, i.family) AS instrument_label
       FROM tickets t
       LEFT JOIN customers   c ON c.id = t.customer_id
       LEFT JOIN instruments i ON i.id = t.instrument_id
      WHERE t.archived = FALSE
        AND t.instrument_id IS NOT NULL
        AND t.id != $1
        AND NOT EXISTS (SELECT 1 FROM shipments s2 WHERE s2.ticket_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM shipment_items si2 WHERE si2.source_ticket_id = t.id)
        ${extra}
      ORDER BY t.updated_at DESC
      LIMIT 20`,
    params,
  );
  res.json(rows);
}));

router.post('/:id/items', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.source_ticket_id) throw badRequest('source_ticket_id is required');

  const { rows: shipRows } = await query('SELECT * FROM shipments WHERE id = $1', [req.params.id]);
  const shipment = shipRows[0];
  if (!shipment) throw notFound('Shipment not found');
  // Adding more instruments to an already-shipped package doesn't mean
  // anything — the box is gone. Fixing an item already on the shipment
  // (PATCH/DELETE below) stays allowed after shipping, same as
  // tracking_number staying editable on a locked shipment in
  // TicketShipment.vue.
  if (shipment.shipped_at) throw badRequest('This shipment has already shipped');

  const { rows: ticketRows } = await query(
    'SELECT id, instrument_id FROM tickets WHERE id = $1 AND archived = FALSE', [b.source_ticket_id],
  );
  const source = ticketRows[0];
  if (!source) throw notFound('Ticket not found');
  if (!source.instrument_id) throw badRequest('That ticket has no instrument to ship');
  if (source.id === shipment.ticket_id) throw badRequest("That's this shipment's own ticket already");

  // Same two places candidate-tickets excludes from its list — checked
  // again here since the list can go stale between load and click.
  const { rows: dupe } = await query(
    `SELECT 1 FROM shipments WHERE ticket_id = $1
     UNION ALL
     SELECT 1 FROM shipment_items WHERE source_ticket_id = $1`,
    [source.id],
  );
  if (dupe.length) throw badRequest('That ticket is already part of a shipment');

  const { rows } = await query(
    `INSERT INTO shipment_items (shipment_id, instrument_id, source_ticket_id, own_tracking_number)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [shipment.id, source.instrument_id, source.id,
      b.own_tracking_number === undefined ? null : b.own_tracking_number],
  );
  res.status(201).json(rows[0]);
}));

// own_tracking_number is the whole "one box or separate boxes" toggle, and
// its NULL-ness (not truthiness) is what's checked — an empty string still
// means "own box, tracking number not filled in yet," distinct from NULL
// ("shares the shipment's own box"). Send null (not '') to fold an item
// back into the shared box.
router.patch('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const value = b.own_tracking_number === undefined || b.own_tracking_number === null
    ? null : String(b.own_tracking_number);
  const { rows } = await query(
    `UPDATE shipment_items SET own_tracking_number = $3
      WHERE id = $2 AND shipment_id = $1 RETURNING *`,
    [req.params.id, req.params.itemId, value],
  );
  if (!rows[0]) throw notFound('Shipment item not found');
  res.json(rows[0]);
}));

// Removes the instrument from this shipment only — never touches the
// source ticket itself, which goes right on existing as whatever it was.
router.delete('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM shipment_items WHERE id = $1 AND shipment_id = $2', [req.params.itemId, req.params.id],
  );
  if (!rowCount) throw notFound('Shipment item not found');
  res.json({ deleted: true });
}));

module.exports = router;
// Attached to the router export (same pattern as routes/tickets.js's
// resolveNewTicketFields/insertTicketRow) so routes/tickets.js can create a
// shipment on the same transaction as the shipping ticket it belongs to.
module.exports.createShipment = createShipment;
