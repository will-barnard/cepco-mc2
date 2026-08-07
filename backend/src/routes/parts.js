'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['needed', 'ordered', 'received', 'cancelled'];

router.get('/vendors', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM vendors WHERE active = TRUE ORDER BY sort_order, name',
  );
  res.json(rows);
}));

router.post('/vendors', requireAdmin, asyncHandler(async (req, res) => {
  const { name, sort_order: sortOrder } = req.body || {};
  if (!name) throw badRequest('name is required');
  const { rows } = await query(
    'INSERT INTO vendors (name, sort_order) VALUES ($1, COALESCE($2,0)) RETURNING *',
    [String(name).trim(), sortOrder],
  );
  res.status(201).json(rows[0]);
}));

router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.status) { params.push(req.query.status); clauses.push(`p.status = $${params.length}`); }
  if (req.query.vendor_id) { params.push(req.query.vendor_id); clauses.push(`p.vendor_id = $${params.length}`); }
  if (req.query.ticket_id) {
    params.push(req.query.ticket_id);
    clauses.push(`EXISTS (SELECT 1 FROM parts_order_tickets pt
                           WHERE pt.parts_order_id = p.id AND pt.ticket_id = $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT p.*, v.name AS vendor_name,
            COALESCE(
              (SELECT json_agg(json_build_object('id', t.id, 'title', t.title))
                 FROM parts_order_tickets pt JOIN tickets t ON t.id = pt.ticket_id
                WHERE pt.parts_order_id = p.id),
              '[]'::json
            ) AS tickets
       FROM parts_orders p LEFT JOIN vendors v ON v.id = p.vendor_id
       ${where} ORDER BY v.sort_order NULLS LAST, p.created_at DESC LIMIT 1000`,
    params,
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.item || !String(b.item).trim()) throw badRequest('item is required');
  if (b.status && !STATUSES.includes(b.status)) {
    throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  }

  const order = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO parts_orders (vendor_id, item, quantity, notes, status, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'needed'),$6) RETURNING *`,
      [b.vendor_id || null, String(b.item).trim(), b.quantity || null,
        b.notes || null, b.status, req.user.id],
    );
    for (const ticketId of b.ticket_ids || []) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        'INSERT INTO parts_order_tickets (parts_order_id, ticket_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [rows[0].id, ticketId],
      );
    }
    return rows[0];
  });
  res.status(201).json(order);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.status && !STATUSES.includes(b.status)) {
    throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  }
  const { rows } = await query(
    `UPDATE parts_orders SET
       vendor_id = COALESCE($2, vendor_id), item = COALESCE($3, item),
       quantity = COALESCE($4, quantity), notes = COALESCE($5, notes),
       status = COALESCE($6, status),
       ordered_at  = CASE WHEN $6 = 'ordered'  AND ordered_at  IS NULL THEN now() ELSE ordered_at END,
       received_at = CASE WHEN $6 = 'received' AND received_at IS NULL THEN now() ELSE received_at END
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.vendor_id || null, b.item || null, b.quantity || null,
      b.notes === undefined ? null : b.notes, b.status || null],
  );
  if (!rows[0]) throw notFound('Parts order not found');
  res.json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM parts_orders WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Parts order not found');
  res.json({ deleted: true });
}));

module.exports = router;
