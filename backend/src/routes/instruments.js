'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

// Instrument taxonomy (PLAN §5), extended per SHOWROOM QC.
const FAMILIES = ['rhodes', 'wurlitzer', 'hohner', 'strings', 'organ', 'amp', 'rarity'];

router.get('/families', (req, res) => res.json(FAMILIES));

router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.family) { params.push(req.query.family); clauses.push(`i.family = $${params.length}`); }
  if (req.query.customer_id) { params.push(req.query.customer_id); clauses.push(`i.customer_id = $${params.length}`); }
  if (req.query.fleet === 'true') clauses.push('i.is_fleet = TRUE');
  if (req.query.fleet === 'false') clauses.push('i.is_fleet = FALSE');
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    clauses.push(`(i.model ILIKE $${params.length} OR i.identifying_notes ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT i.*, c.name AS customer_name,
            (SELECT count(*)::int FROM tickets t WHERE t.instrument_id = i.id AND t.archived = FALSE)
              AS open_tickets
       FROM instruments i LEFT JOIN customers c ON c.id = i.customer_id
       ${where} ORDER BY i.family, i.model LIMIT 1000`,
    params,
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT i.*, c.name AS customer_name FROM instruments i
       LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`,
    [req.params.id],
  );
  if (!rows[0]) throw notFound('Instrument not found');
  const tickets = await query(
    `SELECT t.*, s.label AS status_label FROM tickets t
       LEFT JOIN settings s ON s.category='ticket_status' AND s.key=t.status_key
      WHERE t.instrument_id = $1 ORDER BY t.updated_at DESC`,
    [req.params.id],
  );
  res.json({ ...rows[0], tickets: tickets.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.family || !FAMILIES.includes(b.family)) {
    throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  }
  const { rows } = await query(
    `INSERT INTO instruments (family, model, year, serial_no, identifying_notes,
                              customer_id, is_fleet, fleet_last_qc)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,FALSE),$8) RETURNING *`,
    [b.family, b.model || null, b.year || null, b.serial_no || null,
      b.identifying_notes || null, b.customer_id || null, b.is_fleet, b.fleet_last_qc || null],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.family && !FAMILIES.includes(b.family)) {
    throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  }
  const { rows } = await query(
    `UPDATE instruments SET
       family = COALESCE($2, family), model = COALESCE($3, model),
       year = COALESCE($4, year), serial_no = COALESCE($5, serial_no),
       identifying_notes = COALESCE($6, identifying_notes),
       customer_id = CASE WHEN $7::boolean THEN $8 ELSE customer_id END,
       is_fleet = COALESCE($9, is_fleet),
       fleet_last_qc = COALESCE($10, fleet_last_qc)
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.family || null, b.model || null, b.year || null, b.serial_no || null,
      b.identifying_notes === undefined ? null : b.identifying_notes,
      b.customer_id !== undefined, b.customer_id || null,
      b.is_fleet === undefined ? null : b.is_fleet,
      b.fleet_last_qc === undefined ? null : b.fleet_last_qc],
  );
  if (!rows[0]) throw notFound('Instrument not found');
  res.json(rows[0]);
}));

module.exports = router;
