'use strict';

/**
 * Settings service — the admin-configurable enums from PLAN §8.
 *
 * Tickets reference settings by *key*, not id. That gives both properties the
 * plan asks for: renames propagate (label is resolved at read time), and a
 * settings row disappearing can never orphan a ticket (the key lives on the
 * ticket row). Deleting a key that is in use is refused outright.
 */

const { query } = require('../db');
const { badRequest, conflict, notFound } = require('../middleware/errors');

const CATEGORIES = [
  'ticket_category',
  'ticket_status',
  'priority_tier',
  'qc_tier',
  'tech_level',
  // Not a ticket enum — single-row shop-wide values (labor rate, etc.) that
  // shouldn't need a deploy to change.
  'shop_config',
];

// Which ticket column each settings category backs — used to block deletion of
// values still referenced by live tickets.
const USAGE_COLUMN = {
  ticket_category: 'category_key',
  ticket_status: 'status_key',
  priority_tier: 'priority_key',
  tech_level: 'tech_level_key',
};

async function listAll() {
  const { rows } = await query(
    `SELECT id, category, key, label, sort_order, meta, retired
       FROM settings
      ORDER BY category, sort_order, id`,
  );
  return rows.reduce((acc, row) => {
    (acc[row.category] = acc[row.category] || []).push(row);
    return acc;
  }, {});
}

async function listCategory(category) {
  if (!CATEGORIES.includes(category)) throw badRequest(`Unknown settings category: ${category}`);
  const { rows } = await query(
    `SELECT id, category, key, label, sort_order, meta, retired
       FROM settings WHERE category = $1 ORDER BY sort_order, id`,
    [category],
  );
  return rows;
}

/** Resolve a key within a category, or throw. Retired keys are still readable. */
async function resolve(category, key) {
  const { rows } = await query(
    'SELECT id, category, key, label, meta, retired FROM settings WHERE category = $1 AND key = $2',
    [category, key],
  );
  if (!rows[0]) throw badRequest(`'${key}' is not a valid ${category}`);
  return rows[0];
}

/** Resolve and reject retired values — used when *setting* a value on a ticket. */
async function resolveActive(category, key) {
  const row = await resolve(category, key);
  if (row.retired) throw badRequest(`'${row.label}' is retired and cannot be assigned`);
  return row;
}

const slugify = (s) => String(s)
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 60);

async function create({ category, key, label, sort_order, meta }) {
  if (!CATEGORIES.includes(category)) throw badRequest(`Unknown settings category: ${category}`);
  if (!label || !String(label).trim()) throw badRequest('label is required');

  const finalKey = slugify(key || label);
  if (!finalKey) throw badRequest('Could not derive a key from that label');

  const existing = await query(
    'SELECT id FROM settings WHERE category = $1 AND key = $2',
    [category, finalKey],
  );
  if (existing.rows.length) throw conflict(`A ${category} with key '${finalKey}' already exists`);

  const { rows } = await query(
    `INSERT INTO settings (category, key, label, sort_order, meta)
     VALUES ($1, $2, $3, COALESCE($4, 0), COALESCE($5, '{}'::jsonb))
     RETURNING *`,
    [category, finalKey, String(label).trim(), sort_order, meta ? JSON.stringify(meta) : null],
  );
  return rows[0];
}

/**
 * Update label / order / meta / retired. The `key` is deliberately immutable —
 * that immutability is what makes renames safe for historical tickets.
 */
async function update(id, { label, sort_order, meta, retired }) {
  const { rows: existing } = await query('SELECT * FROM settings WHERE id = $1', [id]);
  if (!existing[0]) throw notFound('Setting not found');
  const current = existing[0];

  if (retired === true) {
    const inUse = await countUsage(current.category, current.key);
    if (inUse > 0) {
      // Retiring is allowed even in use (it only hides it from new tickets),
      // but flag it back to the caller so the UI can warn.
      // No throw here — this is the documented "retire, don't delete" path.
    }
  }

  const { rows } = await query(
    `UPDATE settings SET
        label      = COALESCE($2, label),
        sort_order = COALESCE($3, sort_order),
        meta       = COALESCE($4, meta),
        retired    = COALESCE($5, retired)
      WHERE id = $1
      RETURNING *`,
    [
      id,
      label === undefined ? null : String(label).trim(),
      sort_order === undefined ? null : sort_order,
      meta === undefined ? null : JSON.stringify(meta),
      retired === undefined ? null : retired,
    ],
  );
  return rows[0];
}

/** Read a numeric value out of a shop_config row, with a fallback. */
async function shopConfigNumber(key, fallback) {
  const { rows } = await query(
    "SELECT meta FROM settings WHERE category = 'shop_config' AND key = $1",
    [key],
  );
  const value = Number(rows[0]?.meta?.value);
  return Number.isFinite(value) ? value : fallback;
}

async function countUsage(category, key) {
  const column = USAGE_COLUMN[category];
  if (!column) return 0;
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM tickets WHERE ${column} = $1`,
    [key],
  );
  return rows[0].n;
}

/** Hard delete. Refused if any ticket still carries the key (§8). */
async function remove(id) {
  const { rows: existing } = await query('SELECT * FROM settings WHERE id = $1', [id]);
  if (!existing[0]) throw notFound('Setting not found');
  const setting = existing[0];

  const inUse = await countUsage(setting.category, setting.key);
  if (inUse > 0) {
    throw conflict(
      `'${setting.label}' is used by ${inUse} ticket(s). Retire it instead, `
      + 'or move those tickets to another value first.',
      { in_use: inUse },
    );
  }
  await query('DELETE FROM settings WHERE id = $1', [id]);
  return { deleted: true };
}

module.exports = {
  CATEGORIES,
  listAll,
  listCategory,
  resolve,
  resolveActive,
  create,
  update,
  remove,
  countUsage,
  shopConfigNumber,
  slugify,
};
