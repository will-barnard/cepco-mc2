'use strict';

/**
 * Standard shop procedures (Settings -> Standard procedures). The catalog
 * routes/quotes.js's estimate builder picks from — see migration 010 and
 * NOTES.md for why pricing is either an hours range or a flat cost, never
 * both, and why `family` is nullable (same convention as qc_templates).
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

/** Normalizes+validates the pricing fields for create/update. Throws on a
 * bad combination rather than letting the DB's CHECK constraint surface as
 * a raw 500. */
function resolvePricing({
  pricing_type: pricingType = 'hours', min_hours: minHours, max_hours: maxHours, flat_cost: flatCost,
}) {
  if (!['hours', 'flat'].includes(pricingType)) {
    throw badRequest("pricing_type must be 'hours' or 'flat'");
  }
  if (pricingType === 'hours') {
    const min = Number(minHours);
    const max = Number(maxHours);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      throw badRequest('min_hours and max_hours must be non-negative numbers, with max >= min');
    }
    return {
      pricing_type: 'hours', min_hours: min, max_hours: max, flat_cost: null,
    };
  }
  const cost = Number(flatCost);
  if (!Number.isFinite(cost) || cost < 0) throw badRequest('flat_cost must be a non-negative number');
  return {
    pricing_type: 'flat', min_hours: null, max_hours: null, flat_cost: cost,
  };
}

// `include_inactive=true` is for the Settings -> Standard procedures admin
// screen (same pattern as qc.js's GET /templates) — every other caller
// (the estimate builder) omits it and only ever sees active rows.
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.include_inactive !== 'true') clauses.push('active = TRUE');
  if (req.query.family) {
    params.push(req.query.family);
    clauses.push(`(family = $${params.length} OR family IS NULL)`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM standard_procedures ${where} ORDER BY family NULLS FIRST, sort_order, name`,
    params,
  );
  res.json(rows);
}));

router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) throw badRequest('name is required');
  const pricing = resolvePricing(b);

  const { rows: maxRow } = await query(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM standard_procedures',
  );
  const { rows } = await query(
    `INSERT INTO standard_procedures
       (name, family, pricing_type, min_hours, max_hours, flat_cost, description, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      String(b.name).trim(), b.family || null, pricing.pricing_type,
      pricing.min_hours, pricing.max_hours, pricing.flat_cost,
      b.description || null, maxRow[0].next,
    ],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await query('SELECT * FROM standard_procedures WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) throw notFound('Procedure not found');

  // Pricing is all-or-nothing: touching any one of these three re-resolves
  // (and re-validates) the full combination against the existing row's
  // current values, same reasoning as tickets.js's category/status pairing.
  const pricingTouched = b.pricing_type !== undefined || b.min_hours !== undefined
    || b.max_hours !== undefined || b.flat_cost !== undefined;
  const pricing = pricingTouched
    ? resolvePricing({
      pricing_type: b.pricing_type ?? existing.pricing_type,
      min_hours: b.min_hours ?? existing.min_hours,
      max_hours: b.max_hours ?? existing.max_hours,
      flat_cost: b.flat_cost ?? existing.flat_cost,
    })
    : null;

  const { rows } = await query(
    `UPDATE standard_procedures SET
       name         = COALESCE($2, name),
       family       = CASE WHEN $3::boolean THEN $4 ELSE family END,
       pricing_type = COALESCE($5, pricing_type),
       min_hours    = CASE WHEN $6::boolean THEN $7 ELSE min_hours END,
       max_hours    = CASE WHEN $6::boolean THEN $8 ELSE max_hours END,
       flat_cost    = CASE WHEN $6::boolean THEN $9 ELSE flat_cost END,
       description  = COALESCE($10, description),
       active       = COALESCE($11, active),
       sort_order   = COALESCE($12, sort_order),
       updated_at   = now()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      b.name || null,
      b.family !== undefined, b.family || null,
      pricing ? pricing.pricing_type : null,
      pricingTouched, pricing ? pricing.min_hours : null, pricing ? pricing.max_hours : null,
      pricing ? pricing.flat_cost : null,
      b.description === undefined ? null : b.description,
      b.active === undefined ? null : b.active,
      b.sort_order === undefined ? null : b.sort_order,
    ],
  );
  res.json(rows[0]);
}));

module.exports = router;
