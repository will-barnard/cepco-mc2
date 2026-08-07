'use strict';

/**
 * Invoices. Phase 1 records invoice state manually; Phase 2 replaces the write
 * path with a Xero sync (PLAN §11) — xero_invoice_id is already here so those
 * rows can be matched up rather than re-created.
 *
 * QC gates invoicing (§6): a ticket with qc_required cannot be invoiced until
 * qc_passed_at is set.
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['draft', 'sent', 'paid', 'void'];

router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.status) { params.push(req.query.status); clauses.push(`i.status = $${params.length}`); }
  if (req.query.ticket_id) { params.push(req.query.ticket_id); clauses.push(`i.ticket_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT i.*, t.title AS ticket_title, c.name AS customer_name
       FROM invoices i JOIN tickets t ON t.id = i.ticket_id
       LEFT JOIN customers c ON c.id = t.customer_id
       ${where} ORDER BY i.created_at DESC`,
    params,
  );
  res.json(rows);
}));

router.post('/', requireRole('senior'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id) throw badRequest('ticket_id is required');

  const { rows: ticketRows } = await query(
    'SELECT qc_required, qc_passed_at, title FROM tickets WHERE id = $1', [b.ticket_id],
  );
  const ticket = ticketRows[0];
  if (!ticket) throw notFound('Ticket not found');
  if (ticket.qc_required && !ticket.qc_passed_at) {
    throw badRequest('QC must pass before this ticket can be invoiced');
  }

  const { rows } = await query(
    `INSERT INTO invoices (ticket_id, xero_invoice_id, amount, status)
     VALUES ($1,$2,$3,COALESCE($4,'draft')) RETURNING *`,
    [b.ticket_id, b.xero_invoice_id || null, b.amount || null, b.status],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireRole('senior'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.status && !STATUSES.includes(b.status)) {
    throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  }
  const { rows } = await query(
    `UPDATE invoices SET
       xero_invoice_id = COALESCE($2, xero_invoice_id),
       amount = COALESCE($3, amount),
       status = COALESCE($4, status),
       sent_at = CASE WHEN $4 = 'sent' AND sent_at IS NULL THEN now() ELSE sent_at END,
       paid_at = CASE WHEN $4 = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.xero_invoice_id || null, b.amount || null, b.status || null],
  );
  if (!rows[0]) throw notFound('Invoice not found');
  res.json(rows[0]);
}));

module.exports = router;
