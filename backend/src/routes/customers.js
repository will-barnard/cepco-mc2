'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const { pushCustomerToXero } = require('../services/xeroSync');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where = 'WHERE c.name ILIKE $1 OR c.email ILIKE $1';
  }
  const { rows } = await query(
    `SELECT c.*,
            (SELECT count(*)::int FROM tickets t WHERE t.customer_id = c.id AND t.archived = FALSE)
              AS open_tickets,
            (SELECT count(*)::int FROM instruments i WHERE i.customer_id = c.id) AS instrument_count
       FROM customers c ${where} ORDER BY c.name LIMIT 500`,
    params,
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Customer not found');
  const [instruments, tickets] = await Promise.all([
    query('SELECT * FROM instruments WHERE customer_id = $1 ORDER BY family, model', [req.params.id]),
    query(`SELECT t.*, s.label AS status_label FROM tickets t
             LEFT JOIN settings s ON s.category='ticket_status' AND s.key=t.status_key
            WHERE t.customer_id = $1 ORDER BY t.updated_at DESC`, [req.params.id]),
  ]);
  res.json({ ...rows[0], instruments: instruments.rows, tickets: tickets.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) throw badRequest('name is required');
  const { rows } = await query(
    `INSERT INTO customers (name, email, phone, address, source, notes)
     VALUES ($1,$2,$3,$4,COALESCE($5,'direct'),$6) RETURNING *`,
    [String(b.name).trim(), b.email || null, b.phone || null, b.address || null,
      b.source || null, b.notes || null],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE customers SET
       name = COALESCE($2, name), email = COALESCE($3, email),
       phone = COALESCE($4, phone), address = COALESCE($5, address),
       source = COALESCE($6, source), notes = COALESCE($7, notes)
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name || null, b.email || null, b.phone || null,
      b.address || null, b.source || null, b.notes === undefined ? null : b.notes],
  );
  if (!rows[0]) throw notFound('Customer not found');
  let customer = rows[0];

  // A linked customer's edit here should reach Xero right away, not wait
  // for the next "Sync now" or nightly run — but a Xero-side failure
  // (network blip, a field Xero's own validation rejects) shouldn't make
  // this look like the edit itself failed: the MC2 write above already
  // succeeded and stays that way. Surface the failure to the caller
  // instead so the edit form can show it as a warning alongside the
  // otherwise-successful save.
  let xeroPushError = null;
  if (customer.xero_contact_id) {
    try {
      await pushCustomerToXero(customer);
      customer = { ...customer, xero_synced_at: new Date().toISOString() };
    } catch (err) {
      xeroPushError = err.message;
    }
  }

  res.json({ ...customer, xero_push_error: xeroPushError });
}));

module.exports = router;
