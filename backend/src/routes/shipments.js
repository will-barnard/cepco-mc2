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

module.exports = router;
// Attached to the router export (same pattern as routes/tickets.js's
// resolveNewTicketFields/insertTicketRow) so routes/tickets.js can create a
// shipment on the same transaction as the shipping ticket it belongs to.
module.exports.createShipment = createShipment;
