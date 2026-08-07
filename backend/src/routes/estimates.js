'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

const CONFIDENCE = ['high', 'med', 'low'];

router.post('/', requireRole('senior'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id) throw badRequest('ticket_id is required');
  if (b.confidence && !CONFIDENCE.includes(b.confidence)) {
    throw badRequest(`confidence must be one of: ${CONFIDENCE.join(', ')}`);
  }
  const { rows } = await query(
    `INSERT INTO estimates (ticket_id, parts_cost, estimated_hours, additional_hours,
                            additional_hours_note, labor_rate, confidence, notes, created_by)
     VALUES ($1, COALESCE($2,0), COALESCE($3,0), COALESCE($4,0), $5,
             COALESCE($6,175.00), COALESCE($7,'med'), $8, $9)
     RETURNING *`,
    [b.ticket_id, b.parts_cost, b.estimated_hours, b.additional_hours,
      b.additional_hours_note || null, b.labor_rate, b.confidence, b.notes || null, req.user.id],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireRole('senior'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.confidence && !CONFIDENCE.includes(b.confidence)) {
    throw badRequest(`confidence must be one of: ${CONFIDENCE.join(', ')}`);
  }
  const { rows } = await query(
    `UPDATE estimates SET
       parts_cost = COALESCE($2, parts_cost),
       estimated_hours = COALESCE($3, estimated_hours),
       additional_hours = COALESCE($4, additional_hours),
       additional_hours_note = COALESCE($5, additional_hours_note),
       labor_rate = COALESCE($6, labor_rate),
       confidence = COALESCE($7, confidence),
       notes = COALESCE($8, notes)
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.parts_cost, b.estimated_hours, b.additional_hours,
      b.additional_hours_note === undefined ? null : b.additional_hours_note,
      b.labor_rate, b.confidence, b.notes === undefined ? null : b.notes],
  );
  if (!rows[0]) throw notFound('Estimate not found');
  res.json(rows[0]);
}));

/**
 * Approve. PLAN §5 has approval also generating tickets and a quote email —
 * both land in Phase 2 (they need Resend). Phase 1 records the approval only.
 */
router.post('/:id/approve', requireRole('senior'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE estimates SET approved_at = now(), approved_by = $2
      WHERE id = $1 AND approved_at IS NULL RETURNING *`,
    [req.params.id, req.user.id],
  );
  if (!rows[0]) throw notFound('Estimate not found, or already approved');
  res.json(rows[0]);
}));

/**
 * Historical estimate reference (§5): what similar jobs actually took.
 * Backs the confidence scoring that arrives properly in Phase 2.
 */
router.get('/reference', asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT i.family,
           t.priority_key,
           p.label AS priority_label,
           count(*)::int                              AS sample_size,
           round(avg(e.estimated_hours + e.additional_hours), 2) AS avg_estimated,
           round(avg(act.actual), 2)                  AS avg_actual,
           round(avg(act.actual - (e.estimated_hours + e.additional_hours)), 2) AS avg_variance
      FROM tickets t
      JOIN instruments i ON i.id = t.instrument_id
      JOIN estimates e   ON e.ticket_id = t.id
      JOIN LATERAL (SELECT sum(hours) AS actual FROM hours_log WHERE ticket_id = t.id) act ON TRUE
      LEFT JOIN settings p ON p.category = 'priority_tier' AND p.key = t.priority_key
     WHERE act.actual IS NOT NULL AND (e.estimated_hours + e.additional_hours) > 0
     GROUP BY i.family, t.priority_key, p.label
     ORDER BY i.family, p.label
  `);
  res.json(rows);
}));

module.exports = router;
