'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

const SELECT = `
  SELECT r.*, i.family AS instrument_family, i.model AS instrument_model,
         i.is_fleet AS instrument_is_fleet
    FROM instrument_rentals r
    JOIN instruments i ON i.id = r.instrument_id
`;

// ---------------------------------------------------------------------------
// Calendar range — every rental overlapping [start, end] (inclusive, both
// YYYY-MM-DD). An open-ended rental (no end_date yet) is treated as still
// running, so it shows on every day in range from its start onward.
// ---------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) throw badRequest('start and end query params are required (YYYY-MM-DD)');
  const { rows } = await query(
    `${SELECT}
      WHERE r.start_date <= $2 AND (r.end_date IS NULL OR r.end_date >= $1)
      ORDER BY r.start_date`,
    [start, end],
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Departing soon — powers the admin dashboard headline (7 days out through
// the day it leaves). "Today" is computed in the shop's own timezone, not
// whatever the database container defaults to — see NOTES.md §2.13.
// ---------------------------------------------------------------------------
router.get('/departing', asyncHandler(async (req, res) => {
  const withinDays = Math.min(Math.max(parseInt(req.query.within_days, 10) || 7, 1), 60);
  const { rows } = await query(
    `${SELECT}
      WHERE r.start_date BETWEEN (now() AT TIME ZONE $2)::date
                             AND (now() AT TIME ZONE $2)::date + $1::int
      ORDER BY r.start_date`,
    [withinDays, config.shopTimezone],
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.instrument_id) throw badRequest('instrument_id is required');
  if (!b.start_date) throw badRequest('start_date is required');
  if (b.end_date && b.end_date < b.start_date) throw badRequest('end_date cannot be before start_date');

  const instrument = await query('SELECT id FROM instruments WHERE id = $1', [b.instrument_id]);
  if (!instrument.rows[0]) throw notFound('Instrument not found');

  const { rows } = await query(
    `INSERT INTO instrument_rentals (instrument_id, renter, start_date, end_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.instrument_id, b.renter || null, b.start_date, b.end_date || null, b.notes || null, req.user.id],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.end_date && b.start_date && b.end_date < b.start_date) {
    throw badRequest('end_date cannot be before start_date');
  }
  const { rows } = await query(
    `UPDATE instrument_rentals SET
        renter     = COALESCE($2, renter),
        start_date = COALESCE($3, start_date),
        end_date   = CASE WHEN $4::boolean THEN $5 ELSE end_date END,
        notes      = COALESCE($6, notes)
      WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      b.renter || null,
      b.start_date || null,
      b.end_date !== undefined,
      b.end_date || null,
      b.notes === undefined ? null : b.notes,
    ],
  );
  if (!rows[0]) throw notFound('Rental not found');
  res.json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query('DELETE FROM instrument_rentals WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) throw notFound('Rental not found');
  res.json({ deleted: true });
}));

module.exports = router;
