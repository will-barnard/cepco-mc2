'use strict';

/**
 * N7 (boss-list scope, scaffold — see migration 036 and NOTES.md). Admin
 * CRUD plus a read endpoint over `instrument_models`, the ragged tree of
 * model names sitting beneath each of instruments.FAMILIES' keys. Those
 * keys themselves are untouched by this file — `family` here is just
 * whichever of those strings a node belongs to, validated against the
 * same list `routes/instruments.js` already exports.
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const { FAMILIES } = require('./instruments');

const router = express.Router();
router.use(requireAuth);

/** A parent, if given, must exist and belong to the *same* family — a
 * cross-family parent would corrupt the one thing this tree actually
 * promises (that walking up from any node stays within one family). */
async function validateParent(parentId, family) {
  if (!parentId) return;
  const { rows } = await query('SELECT family FROM instrument_models WHERE id = $1', [parentId]);
  if (!rows[0]) throw badRequest(`Parent node #${parentId} not found`);
  if (rows[0].family !== family) throw badRequest('A node\'s parent must be in the same family');
}

// Open to any authenticated user, not just admins — this is what the
// ticket/purchase/estimate forms' cascading picker reads live while
// someone's filling out a form, same as GET /instruments/families.
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.family) { params.push(req.query.family); clauses.push(`family = $${params.length}`); }
  if (req.query.include_inactive !== 'true') clauses.push('active = TRUE');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM instrument_models ${where} ORDER BY family, parent_id NULLS FIRST, sort_order, name`,
    params,
  );
  res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.family || !FAMILIES.includes(b.family)) {
    throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  }
  if (!b.name || !String(b.name).trim()) throw badRequest('name is required');
  await validateParent(b.parent_id || null, b.family);

  const { rows: maxRow } = await query(
    `SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM instrument_models
      WHERE family = $1 AND parent_id IS NOT DISTINCT FROM $2`,
    [b.family, b.parent_id || null],
  );
  const { rows } = await query(
    `INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.family, b.parent_id || null, String(b.name).trim(),
      b.sort_order === undefined ? maxRow[0].next : Number(b.sort_order),
      b.allow_manual === true,
      // N10: flags this node (and anything picked under it) as a
      // Suitcase-style/self-contained-amp variant — gates whether the
      // estimate wizard's Electronics screen shows at all for a given
      // instrument (see migration 045's header). Same plain boolean
      // convention as allow_manual just above.
      b.is_suitcase === true],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await query('SELECT * FROM instrument_models WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) throw notFound('Instrument model not found');

  // family itself is deliberately not editable here — moving a whole
  // subtree to a different family is a rare enough operation (and one
  // that would need to cascade the change to every descendant) that it's
  // simpler to delete and recreate than support in place.
  if (b.parent_id !== undefined && b.parent_id !== null) {
    if (Number(b.parent_id) === existing.id) throw badRequest('A node cannot be its own parent');
    await validateParent(b.parent_id, existing.family);
  }

  const { rows } = await query(
    `UPDATE instrument_models SET
       name         = COALESCE($2, name),
       parent_id    = CASE WHEN $3::boolean THEN $4 ELSE parent_id END,
       sort_order   = COALESCE($5, sort_order),
       allow_manual = COALESCE($6, allow_manual),
       is_suitcase  = COALESCE($7, is_suitcase),
       active       = COALESCE($8, active),
       updated_at   = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id,
      b.name === undefined ? null : String(b.name).trim(),
      b.parent_id !== undefined, b.parent_id || null,
      b.sort_order === undefined ? null : Number(b.sort_order),
      b.allow_manual === undefined ? null : b.allow_manual,
      b.is_suitcase === undefined ? null : b.is_suitcase,
      b.active === undefined ? null : b.active],
  );
  res.json(rows[0]);
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  // ON DELETE CASCADE (migration 036) takes the whole subtree with it —
  // deliberate: a branch node with children is "a whole model line," not
  // just one row, and there's nothing else in the app referencing these
  // ids yet (instruments.model stays a plain string the picker fills in,
  // never a foreign key) for a cascade to orphan.
  const { rowCount } = await query('DELETE FROM instrument_models WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Instrument model not found');
  res.json({ deleted: true });
}));

module.exports = router;
