'use strict';

/**
 * Standard shop procedures (Settings -> Standard procedures). The catalog
 * routes/quotes.js's estimate builder picks from — see migration 010 and
 * NOTES.md for why labor bills either an hours range or nothing, and why
 * `family` is nullable (same convention as qc_templates).
 *
 * Parts pricing (migration 043) is independent of labor: a procedure can
 * carry no parts cost at all, a single `flat_cost`, or — when the part's
 * price actually depends on the instrument's key count (Rhodes grommets,
 * hammer tips, tolex, etc.) — up to four `parts_cost_*` variant columns,
 * never flat_cost and a variant together. `outlier_hours` is a labor-only
 * reference (mean hours for the rare case this specific job runs long),
 * used by routes/quotes.js to build the estimate builder's internal
 * "assume one outlier" buffer — never shown to a customer.
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const settings = require('../services/settings');

const router = express.Router();
router.use(requireAuth);

const VARIANT_FIELDS = ['parts_cost_piano_bass', 'parts_cost_54_key', 'parts_cost_73_key', 'parts_cost_88_key'];

// N10: which of the estimate wizard's screens 3-6 (EstimateNewView.vue)
// this procedure shows up on — see migration 045's header for the mapping
// this was backfilled from. Nullable rather than required (resolveCategory
// below accepts and passes through null) — a procedure with no category
// still shows up in the wizard (bucketed under Standard Setup & Actions,
// the most permissive screen) rather than becoming invisible to it, same
// "an incomplete admin list never blocks the shop floor" posture as
// family/instrument_models' allow_manual escape hatches.
const CATEGORY_KEYS = ['standard_setup', 'electronics', 'cosmetics', 'parts'];

function resolveCategory(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (!CATEGORY_KEYS.includes(rawValue)) {
    throw badRequest(`category must be one of: ${CATEGORY_KEYS.join(', ')}`);
  }
  return rawValue;
}

/** Labor pricing only — whether/how many hours this bills. Throws on a bad
 * combination rather than letting the DB's CHECK constraint surface as a
 * raw 500. */
function resolveHours({ pricing_type: pricingType = 'hours', min_hours: minHours, max_hours: maxHours }) {
  if (!['hours', 'flat'].includes(pricingType)) {
    throw badRequest("pricing_type must be 'hours' or 'flat'");
  }
  if (pricingType === 'flat') return { pricing_type: 'flat', min_hours: null, max_hours: null };
  const min = Number(minHours);
  const max = Number(maxHours);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw badRequest('min_hours and max_hours must be non-negative numbers, with max >= min');
  }
  return { pricing_type: 'hours', min_hours: min, max_hours: max };
}

/** Parts pricing — none, a single flat_cost, or up to four key-count
 * variant costs, never a mix (migration 043). A 'flat' procedure (no
 * labor at all) needs its price to come from one of these, since it has
 * nowhere else to get one. */
function resolveParts(body, pricingType) {
  const variants = {};
  let anyVariant = false;
  for (const field of VARIANT_FIELDS) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') { variants[field] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a non-negative number`);
    variants[field] = n;
    anyVariant = true;
  }
  let flatCost = null;
  if (body.flat_cost !== undefined && body.flat_cost !== null && body.flat_cost !== '') {
    const n = Number(body.flat_cost);
    if (!Number.isFinite(n) || n < 0) throw badRequest('flat_cost must be a non-negative number');
    flatCost = n;
  }
  if (flatCost !== null && anyVariant) {
    throw badRequest('A procedure prices its parts either a single flat_cost or by key-count variant, not both');
  }
  if (pricingType === 'flat' && flatCost === null && !anyVariant) {
    throw badRequest('A flat-priced procedure needs flat_cost or at least one parts_cost_* variant');
  }
  return { flat_cost: flatCost, ...variants };
}

/** outlier_hours only means anything for an hours-based procedure — it's
 * silently dropped (not an error) when pricing_type is 'flat', so
 * flipping a procedure to flat doesn't require clearing it by hand first.
 * When it does apply, it must be at or above max_hours: an "outlier" that
 * fell inside the normal range wouldn't be one. */
function resolveOutlier(rawValue, pricingType, maxHours) {
  if (rawValue === undefined || rawValue === null || rawValue === '' || pricingType !== 'hours') return null;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < 0) throw badRequest('outlier_hours must be a non-negative number');
  if (n < Number(maxHours)) throw badRequest('outlier_hours must be at or above max_hours');
  return n;
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
  const hours = resolveHours(b);
  const parts = resolveParts(b, hours.pricing_type);
  const outlierHours = resolveOutlier(b.outlier_hours, hours.pricing_type, hours.max_hours);

  // N8's nice-to-have: a procedure can name the tech level its own work
  // usually calls for, so tasks created from it (routes/tasks.js) arrive
  // pre-tagged. Optional, same as family — "applies at any level" for a
  // procedure that doesn't specify one.
  let defaultTechLevel = null;
  if (b.default_tech_level_key) {
    defaultTechLevel = await settings.resolveActive('tech_level', b.default_tech_level_key);
  }

  const { rows: maxRow } = await query(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM standard_procedures',
  );
  const category = resolveCategory(b.category);

  const { rows } = await query(
    `INSERT INTO standard_procedures
       (name, family, pricing_type, min_hours, max_hours, flat_cost, outlier_hours,
        parts_cost_piano_bass, parts_cost_54_key, parts_cost_73_key, parts_cost_88_key,
        description, sort_order, default_tech_level_key, default_tech_level_label_snapshot, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      String(b.name).trim(), b.family || null, hours.pricing_type,
      hours.min_hours, hours.max_hours, parts.flat_cost, outlierHours,
      parts.parts_cost_piano_bass, parts.parts_cost_54_key, parts.parts_cost_73_key, parts.parts_cost_88_key,
      b.description || null, maxRow[0].next,
      defaultTechLevel ? defaultTechLevel.key : null, defaultTechLevel ? defaultTechLevel.label : null,
      category,
    ],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await query('SELECT * FROM standard_procedures WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) throw notFound('Procedure not found');

  // Same "touching any one field re-resolves and re-validates the whole
  // group" idiom as before (see the pre-043 version of this file) —
  // labor, parts, and outlier are now three separate groups since
  // migration 043 decoupled them, but a labor change can still ripple
  // into the other two (a switch to 'flat' drops any outlier_hours; a
  // shrunk pricing_type='flat' still needs *some* parts price already
  // set, so parts gets re-validated too whenever labor changes).
  const hoursTouched = b.pricing_type !== undefined || b.min_hours !== undefined || b.max_hours !== undefined;
  const hours = hoursTouched
    ? resolveHours({
      pricing_type: b.pricing_type ?? existing.pricing_type,
      min_hours: b.min_hours ?? existing.min_hours,
      max_hours: b.max_hours ?? existing.max_hours,
    })
    : null;
  const effectivePricingType = hours ? hours.pricing_type : existing.pricing_type;
  const effectiveMaxHours = hours ? hours.max_hours : existing.max_hours;

  const partsTouched = hoursTouched || b.flat_cost !== undefined || VARIANT_FIELDS.some((f) => b[f] !== undefined);
  const parts = partsTouched
    ? resolveParts({
      flat_cost: b.flat_cost !== undefined ? b.flat_cost : existing.flat_cost,
      parts_cost_piano_bass: b.parts_cost_piano_bass !== undefined ? b.parts_cost_piano_bass : existing.parts_cost_piano_bass,
      parts_cost_54_key: b.parts_cost_54_key !== undefined ? b.parts_cost_54_key : existing.parts_cost_54_key,
      parts_cost_73_key: b.parts_cost_73_key !== undefined ? b.parts_cost_73_key : existing.parts_cost_73_key,
      parts_cost_88_key: b.parts_cost_88_key !== undefined ? b.parts_cost_88_key : existing.parts_cost_88_key,
    }, effectivePricingType)
    : null;

  const outlierTouched = hoursTouched || b.outlier_hours !== undefined;
  const outlierValue = outlierTouched
    ? resolveOutlier(
      b.outlier_hours !== undefined ? b.outlier_hours : existing.outlier_hours,
      effectivePricingType, effectiveMaxHours,
    )
    : null;

  // Same explicit-touch-including-clear idiom as tickets.js's PATCH: only
  // re-resolved when the request actually mentions it, so a PATCH that
  // doesn't touch this field never silently drops an existing default.
  let defaultTechLevelTouched = false;
  let defaultTechLevelKey = null;
  let defaultTechLevelLabel = null;
  if (b.default_tech_level_key !== undefined && b.default_tech_level_key !== existing.default_tech_level_key) {
    defaultTechLevelTouched = true;
    if (b.default_tech_level_key) {
      const techLevel = await settings.resolveActive('tech_level', b.default_tech_level_key);
      defaultTechLevelKey = techLevel.key;
      defaultTechLevelLabel = techLevel.label;
    }
  }

  const categoryTouched = b.category !== undefined;
  const categoryValue = categoryTouched ? resolveCategory(b.category) : null;

  const { rows } = await query(
    `UPDATE standard_procedures SET
       name         = COALESCE($2, name),
       family       = CASE WHEN $3::boolean THEN $4 ELSE family END,
       pricing_type = CASE WHEN $5::boolean THEN $6 ELSE pricing_type END,
       min_hours    = CASE WHEN $5::boolean THEN $7 ELSE min_hours END,
       max_hours    = CASE WHEN $5::boolean THEN $8 ELSE max_hours END,
       flat_cost              = CASE WHEN $9::boolean THEN $10 ELSE flat_cost END,
       parts_cost_piano_bass  = CASE WHEN $9::boolean THEN $11 ELSE parts_cost_piano_bass END,
       parts_cost_54_key      = CASE WHEN $9::boolean THEN $12 ELSE parts_cost_54_key END,
       parts_cost_73_key      = CASE WHEN $9::boolean THEN $13 ELSE parts_cost_73_key END,
       parts_cost_88_key      = CASE WHEN $9::boolean THEN $14 ELSE parts_cost_88_key END,
       outlier_hours = CASE WHEN $15::boolean THEN $16 ELSE outlier_hours END,
       description  = COALESCE($17, description),
       active       = COALESCE($18, active),
       sort_order   = COALESCE($19, sort_order),
       default_tech_level_key = CASE WHEN $20::boolean THEN $21 ELSE default_tech_level_key END,
       default_tech_level_label_snapshot =
         CASE WHEN $20::boolean THEN $22 ELSE default_tech_level_label_snapshot END,
       category     = CASE WHEN $23::boolean THEN $24 ELSE category END,
       updated_at   = now()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      b.name || null,
      b.family !== undefined, b.family || null,
      hoursTouched, hours ? hours.pricing_type : null, hours ? hours.min_hours : null, hours ? hours.max_hours : null,
      partsTouched, parts ? parts.flat_cost : null,
      parts ? parts.parts_cost_piano_bass : null, parts ? parts.parts_cost_54_key : null,
      parts ? parts.parts_cost_73_key : null, parts ? parts.parts_cost_88_key : null,
      outlierTouched, outlierValue,
      b.description === undefined ? null : b.description,
      b.active === undefined ? null : b.active,
      b.sort_order === undefined ? null : b.sort_order,
      defaultTechLevelTouched, defaultTechLevelKey, defaultTechLevelLabel,
      categoryTouched, categoryValue,
    ],
  );
  res.json(rows[0]);
}));

module.exports = router;
module.exports.CATEGORY_KEYS = CATEGORY_KEYS;
