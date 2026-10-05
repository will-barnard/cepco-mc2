'use strict';

/**
 * Settings service — the admin-configurable enums from PLAN §8.
 *
 * Tickets reference settings by *key*, not id. That gives both properties the
 * plan asks for: renames propagate (label is resolved at read time), and a
 * settings row disappearing can never orphan a ticket (the key lives on the
 * ticket row). Deleting a key that is in use is refused outright.
 */

const { query, withTransaction } = require('../db');
const { badRequest, conflict, notFound } = require('../middleware/errors');

const CATEGORIES = [
  'ticket_category',
  'ticket_status',
  'priority_tier',
  'tech_level',
  // Not a ticket enum — single-row shop-wide values (labor rate, etc.) that
  // shouldn't need a deploy to change.
  'shop_config',
  // C1 (boss-list scope): Ceppy award categories (Technical Ceppy,
  // Primetime Ceppy, ...) — a settings category rather than a hardcoded
  // pair, since the shop will invent a third award eventually and this way
  // they add it themselves rather than filing an engineering ticket for it.
  'ceppy_category',
  // Migration 064: outside-vendor work on a ticket (Painting, Woodshop,
  // ...) and the statuses that work moves through — ticket_vendor_work.
  'vendor_track',
  'vendor_status',
  // 'qc_tier' used to live here — retired in migration 021 (see
  // routes/qc.js). Deliberately left out of CATEGORIES so a new one can't
  // be created, but existing rows (retired, not deleted) still resolve()
  // fine for historical qc_checks display, and listAll() still returns
  // them since it groups by whatever category a row actually has.
];

// Which table+column each settings category backs — used to block deletion
// of values still referenced by a live row elsewhere. Most categories back
// a ticket column; ceppy_category (C1) is the first to back something else,
// hence table+column instead of assuming every source is `tickets`.
const USAGE_SOURCE = {
  ticket_category: { table: 'tickets', column: 'category_key', noun: 'ticket' },
  ticket_status: { table: 'tickets', column: 'status_key', noun: 'ticket' },
  priority_tier: { table: 'tickets', column: 'priority_key', noun: 'ticket' },
  tech_level: { table: 'tickets', column: 'tech_level_key', noun: 'ticket' },
  ceppy_category: { table: 'ceppy_nominations', column: 'category_key', noun: 'nomination' },
  vendor_track: { table: 'ticket_vendor_work', column: 'track_key', noun: 'vendor work record' },
  vendor_status: { table: 'ticket_vendor_work', column: 'status_key', noun: 'vendor work record' },
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

/**
 * True if a ticket_status row is usable by the given ticket_category.
 * `meta.excluded_categories` empty/absent means "every category" — the
 * default every pre-existing status keeps, so this is opt-out restriction,
 * not opt-in availability. That direction matters: a category added later
 * (Settings -> Ticket categories) automatically gets every status that
 * doesn't specifically exclude it, rather than silently missing every
 * status whose old allowlist predates it (see N4a in the boss-list scope —
 * this used to be an allowlist called `applicable_categories`, which is
 * exactly backwards for "every category except shipping"; migration 023
 * converts existing rows).
 *
 * Shipping tickets (§ NOTES.md) were the first, and until N2b's category
 * reshuffle the *only*, user of this — but shipping sub-tickets are no
 * longer their own category (migration 029 retired the dedicated
 * 'shipping' key; see tickets.is_shipping, migration 028), so their
 * exclusion moved from a category name in excluded_categories to a plain
 * boolean, meta.excluded_for_shipping, checked against the ticket's
 * is_shipping flag instead of its category_key. Both checks are
 * independent and either can exclude a status; most rows use at most one.
 */
function statusAppliesToCategory(statusRow, categoryKey, isShipping = false) {
  const excluded = statusRow.meta && statusRow.meta.excluded_categories;
  if (Array.isArray(excluded) && excluded.includes(categoryKey)) return false;
  if (isShipping && statusRow.meta && statusRow.meta.excluded_for_shipping) return false;
  return true;
}

/** resolveActive('ticket_status', key), also enforced against the ticket's
 * category and its is_shipping flag — e.g. a shipping sub-ticket can't be
 * set to QC or On Hold. */
async function resolveStatusForCategory(key, categoryKey, isShipping = false) {
  const status = await resolveActive('ticket_status', key);
  if (!statusAppliesToCategory(status, categoryKey, isShipping)) {
    throw badRequest(`'${status.label}' isn't a valid status for this ticket's category`);
  }
  return status;
}

/** The first non-retired status usable by this category, in sort order —
 * used to default a new ticket's status, and to re-home a ticket whose
 * status stops being valid after its category changes. A category can
 * override this with its own preferred starting status
 * (ticket_category.meta.default_status_key, Settings -> Ticket categories
 * — same per-category-meta pattern as default_assignee_id) — e.g. Daily
 * To-Do's starts at 'in_progress' (migration 051) rather than whatever
 * status happens to sort first, so its auto-created task (see
 * insertTicketRow's auto_task_from_title) is immediately visible on "My
 * tasks" instead of sitting invisible until someone flips the status by
 * hand. A missing, retired, or inapplicable override is silently ignored
 * — a bad Settings value must never break ticket creation for the
 * category that set it — falling through to the same "first non-retired,
 * applicable status" default every other category already gets.
 *
 * A shipping ticket (isShipping) gets the same 'in_progress' preference
 * directly, independent of any category override — is_shipping is a
 * per-ticket flag, not a per-category one (migration 028), and
 * 'orders_shipping' also carries real non-shipping billable orders that
 * shouldn't all start on 'in_progress' just for sharing that category, so
 * this can't be expressed as category.meta.default_status_key the way
 * Daily To-Do's is. Its own auto-created task (insertTicketRow's
 * is_shipping branch) would otherwise sit on 'not_started' — a status
 * that's valid for a shipping ticket but doesn't unlock tasks — same
 * "created but invisible" gap the Daily To-Do fix above closes. */
async function defaultStatusForCategory(categoryKey, isShipping = false) {
  const rows = await listCategory('ticket_status');

  try {
    const categoryRow = await resolve('ticket_category', categoryKey);
    const preferredKey = categoryRow.meta && categoryRow.meta.default_status_key;
    if (preferredKey) {
      const preferred = rows.find((r) => r.key === preferredKey);
      if (preferred && !preferred.retired && statusAppliesToCategory(preferred, categoryKey, isShipping)) {
        return preferred;
      }
    }
  } catch {
    // categoryKey itself doesn't resolve — fall through to the plain
    // default below, whose own "no eligible status" check gives the
    // caller a clearer error than this lookup failing would.
  }

  if (isShipping) {
    const inProgress = rows.find((r) => r.key === 'in_progress');
    if (inProgress && !inProgress.retired && statusAppliesToCategory(inProgress, categoryKey, isShipping)) {
      return inProgress;
    }
  }

  const match = rows.find((r) => !r.retired && statusAppliesToCategory(r, categoryKey, isShipping));
  if (!match) throw badRequest('No ticket statuses are configured for this category');
  return match;
}

/** The first non-retired value in a category, by sort order. The generic
 * "safe default" fallback for a code path whose usual key might get
 * retired out from under it (N4a: NewTicketForm.vue, FleetView.vue,
 * routes/tickets.js, routes/purchases.js and routes/shopifyWebhooks.js all
 * used to hardcode a category or priority key that Settings can now retire
 * at any time — see NOTES.md). Throws only if literally nothing in the
 * category is active, which would already break ticket creation outright. */
async function firstActive(category) {
  const rows = await listCategory(category);
  const match = rows.find((r) => !r.retired);
  if (!match) throw badRequest(`No active ${category} values are configured`);
  return match;
}

/**
 * Resolve the first of `preferredKeys` that's still a valid, active value in
 * `category`, falling back to firstActive() if none of them are (or none
 * were given). Use this for a hardcoded "usual" default that Settings might
 * retire — never for a value the caller explicitly supplied, which should
 * still fail loudly via resolveActive() if it's invalid.
 */
async function defaultKeyPreferring(category, ...preferredKeys) {
  for (const key of preferredKeys) {
    if (!key) continue;
    try {
      const row = await resolveActive(category, key);
      return row.key;
    } catch (err) {
      // not valid/active any more — try the next candidate
    }
  }
  return (await firstActive(category)).key;
}

const slugify = (s) => String(s)
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 60);

/**
 * N2a: validate meta.parent_key, if present. A settings row can nest under
 * another row in the *same* category (a ticket_category can nest under
 * another ticket_category — see N2b's Custom Shop / SideQuests tree), but
 * only one level deep: the parent itself must not have a parent. Nothing in
 * the app (the two-level category picker, tickets.subcategory_key) expects
 * arbitrary depth, so this is enforced here rather than left to whichever
 * caller happens to remember.
 */
async function validateParentKey(category, key, meta) {
  const parentKey = meta && meta.parent_key;
  if (!parentKey) return;
  if (parentKey === key) throw badRequest('A value cannot be its own parent');
  const { rows } = await query(
    'SELECT key, meta, retired FROM settings WHERE category = $1 AND key = $2',
    [category, parentKey],
  );
  const parent = rows[0];
  if (!parent) throw badRequest(`Parent '${parentKey}' does not exist in ${category}`);
  if (parent.meta && parent.meta.parent_key) {
    throw badRequest(
      'Settings values support only one level of nesting — the parent cannot itself have a parent',
    );
  }
  // A value that already has children of its own can't also become a
  // child — that would chain to three levels (parentKey -> key -> its
  // children) even though the check above, looking only at `parentKey`,
  // wouldn't catch it.
  const childCount = await countChildren(category, key);
  if (childCount > 0) {
    throw badRequest(
      'This value already has sub-values of its own — it cannot also become a child '
      + '(only one level of nesting is supported)',
    );
  }
}

/**
 * Migration 063: shop_config 'queue_split_view' — meta.value is the ordered
 * list of ticket_status keys the Queue page shows in its right-hand column.
 * Checked here because nothing else validates shop_config meta, and a typo'd
 * key would otherwise just silently never match a ticket. Retired statuses
 * are allowed (a status retired *after* being picked shouldn't make the
 * whole setting unsaveable); the Queue page simply has no tickets for it.
 */
async function validateQueueSplitView(meta) {
  const value = meta && meta.value;
  if (!Array.isArray(value)) throw badRequest('queue_split_view needs meta.value to be a list of status keys');
  if (new Set(value).size !== value.length) throw badRequest('A status can only appear once in the split view');
  const { rows } = await query(
    "SELECT key FROM settings WHERE category = 'ticket_status' AND key = ANY($1)",
    [value.map(String)],
  );
  const known = new Set(rows.map((r) => r.key));
  const unknown = value.filter((k) => !known.has(String(k)));
  if (unknown.length) throw badRequest(`Unknown ticket status(es): ${unknown.join(', ')}`);
}

/**
 * Queue sections (migration 065): ticket statuses whose meta.queue_group
 * matches share one queue section on the Queue page and dashboard. Stored
 * trimmed + lowercased so "Waiting" and "waiting " are the same section,
 * and removed outright when blank so "no section" has one representation.
 */
function normalizeQueueGroup(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v || null;
}

async function create({
  category, key, label, sort_order, meta,
}) {
  if (!CATEGORIES.includes(category)) throw badRequest(`Unknown settings category: ${category}`);
  if (!label || !String(label).trim()) throw badRequest('label is required');

  const finalKey = slugify(key || label);
  if (!finalKey) throw badRequest('Could not derive a key from that label');

  const existing = await query(
    'SELECT id FROM settings WHERE category = $1 AND key = $2',
    [category, finalKey],
  );
  if (existing.rows.length) throw conflict(`A ${category} with key '${finalKey}' already exists`);

  await validateParentKey(category, finalKey, meta);

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
async function update(id, {
  label, sort_order, meta, retired,
}) {
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

  if (meta !== undefined) await validateParentKey(current.category, current.key, meta);
  if (meta !== undefined && current.category === 'shop_config' && current.key === 'queue_split_view') {
    await validateQueueSplitView(meta);
  }

  // Joining a status to a queue section (or moving it to another one) means
  // its tickets' positions now share one order with the section's other
  // statuses — but each status was numbered on its own (10, 20, 30... per
  // drag), so the numbers would interleave meaninglessly. Re-seed that
  // section oldest-first, same as migration 065 did for Reservation + Not
  // Started. Leaving a section needs nothing: what's left keeps its order.
  let regroupTo = null;
  if (meta !== undefined && current.category === 'ticket_status' && meta && typeof meta === 'object') {
    const nextGroup = normalizeQueueGroup(meta.queue_group);
    meta = { ...meta };
    if (nextGroup) meta.queue_group = nextGroup; else delete meta.queue_group;
    if (nextGroup && nextGroup !== normalizeQueueGroup(current.meta?.queue_group)) regroupTo = nextGroup;
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
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

    if (regroupTo) {
      const { rows: members } = await client.query(
        `SELECT key FROM settings
          WHERE category = 'ticket_status' AND lower(btrim(meta->>'queue_group')) = $1`,
        [regroupTo],
      );
      if (members.length > 1) {
        await client.query('SELECT renumber_queue_section($1::text[])', [members.map((r) => r.key)]);
      }
    }

    return rows[0];
  });
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

/** Read a string value out of a shop_config row, with a fallback. */
async function shopConfigString(key, fallback) {
  const { rows } = await query(
    "SELECT meta FROM settings WHERE category = 'shop_config' AND key = $1",
    [key],
  );
  const value = rows[0]?.meta?.value;
  return typeof value === 'string' && value ? value : fallback;
}

async function countUsage(category, key) {
  const source = USAGE_SOURCE[category];
  if (!source) return 0;
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM ${source.table} WHERE ${source.column} = $1`,
    [key],
  );
  return rows[0].n;
}

/** N2a: how many other rows in this category name `key` as their
 * meta.parent_key — used to block deleting a value that's still someone's
 * parent, the same "retire instead" reasoning countUsage exists for. */
async function countChildren(category, key) {
  const { rows } = await query(
    "SELECT count(*)::int AS n FROM settings WHERE category = $1 AND meta->>'parent_key' = $2",
    [category, key],
  );
  return rows[0].n;
}

/** Hard delete. Refused if any ticket still carries the key (§8), or if any
 * other value is nested under it as a sub-category (N2a). */
async function remove(id) {
  const { rows: existing } = await query('SELECT * FROM settings WHERE id = $1', [id]);
  if (!existing[0]) throw notFound('Setting not found');
  const setting = existing[0];

  const inUse = await countUsage(setting.category, setting.key);
  if (inUse > 0) {
    const noun = USAGE_SOURCE[setting.category]?.noun || 'record';
    throw conflict(
      `'${setting.label}' is used by ${inUse} ${noun}(s). Retire it instead, `
      + `or move those ${noun}s to another value first.`,
      { in_use: inUse },
    );
  }
  const childCount = await countChildren(setting.category, setting.key);
  if (childCount > 0) {
    throw conflict(
      `'${setting.label}' has ${childCount} sub-value(s) nested under it. Retire it instead, `
      + 'or reparent those first.',
      { child_count: childCount },
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
  statusAppliesToCategory,
  resolveStatusForCategory,
  defaultStatusForCategory,
  firstActive,
  defaultKeyPreferring,
  create,
  update,
  remove,
  countUsage,
  countChildren,
  shopConfigNumber,
  shopConfigString,
  slugify,
};
