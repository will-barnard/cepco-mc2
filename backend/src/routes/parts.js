'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, conflict } = require('../middleware/errors');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

// Two states only (migration 074, NOTES.md §2.102). 'delivered' and
// 'cancelled' still exist on old rows — the DB constraint allows them so
// history isn't rewritten — but nothing can set them any more.
const STATUSES = ['needed', 'ordered'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// "Today" in the shop's timezone, as SQL. A plain now()::date would be the
// server's (UTC) day, which is tomorrow for anything after 6pm Central.
const TODAY_SQL = '(now() AT TIME ZONE $TZ::text)::date';
const today = (paramIndex) => TODAY_SQL.replace('$TZ', `$${paramIndex}`);

function blankToNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * The vendor is one choice with two shapes (a vendors row, or free text via
 * "Other…", migration 025). Whenever a body mentions either key, both
 * columns are written from it — otherwise switching an order from a listed
 * vendor to "Other…" would leave the old vendor_id in place alongside it.
 */
function readVendor(b) {
  const vendorId = b.vendor_id ? Number(b.vendor_id) : null;
  const vendorOther = blankToNull(b.vendor_other);
  if (vendorId && vendorOther) {
    throw badRequest('vendor_id and vendor_other are mutually exclusive — pick one');
  }
  return { vendorId, vendorOther };
}

function readOrderedAt(v) {
  const s = blankToNull(v);
  if (s && !YMD.test(s)) throw badRequest('ordered_at must be a YYYY-MM-DD date');
  return s;
}

async function assertVendorNameFree(name, exceptId = null) {
  const { rows } = await query(
    'SELECT id, active FROM vendors WHERE lower(name) = lower($1) AND ($2::int IS NULL OR id <> $2)',
    [name, exceptId],
  );
  if (rows[0]) {
    throw conflict(rows[0].active
      ? `There's already a vendor called "${name}"`
      : `"${name}" already exists but is hidden — reactivate it instead`);
  }
}

// --- vendors ----------------------------------------------------------------

// ?all=true (admin, Settings -> Parts vendors) includes hidden vendors and
// how many open orders each has; everyone else gets the active picker list.
router.get('/vendors', asyncHandler(async (req, res) => {
  if (req.query.all === 'true') {
    const { rows } = await query(
      `SELECT v.*,
              (SELECT count(*)::int FROM parts_orders p
                WHERE p.vendor_id = v.id AND p.archived = FALSE) AS open_orders
         FROM vendors v ORDER BY v.active DESC, v.sort_order, v.name`,
    );
    return res.json(rows);
  }
  const { rows } = await query(
    'SELECT * FROM vendors WHERE active = TRUE ORDER BY sort_order, name',
  );
  return res.json(rows);
}));

router.post('/vendors', requireAdmin, asyncHandler(async (req, res) => {
  const name = blankToNull((req.body || {}).name);
  if (!name) throw badRequest('name is required');
  await assertVendorNameFree(name);

  const result = await withTransaction(async (client) => {
    // New vendors go to the bottom unless told otherwise.
    const { rows } = await client.query(
      `INSERT INTO vendors (name, sort_order)
       VALUES ($1, COALESCE($2, (SELECT COALESCE(max(sort_order), 0) + 10 FROM vendors)))
       RETURNING *`,
      [name, req.body.sort_order ?? null],
    );
    // Promote any "Other…" orders that already typed this name, so they
    // join the new vendor's box instead of sitting in a look-alike one.
    const moved = await client.query(
      `UPDATE parts_orders SET vendor_id = $1, vendor_other = NULL, updated_at = now()
        WHERE vendor_id IS NULL AND lower(trim(vendor_other)) = lower($2)`,
      [rows[0].id, name],
    );
    return { ...rows[0], moved_orders: moved.rowCount };
  });
  res.status(201).json(result);
}));

// Rename, reorder, hide/unhide. There's deliberately no DELETE: the FK is
// ON DELETE SET NULL, so deleting would silently strip the vendor off every
// order that ever used it. Hiding (active = FALSE) takes it out of the
// pickers while existing orders keep showing its name.
router.patch('/vendors/:id', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const params = [req.params.id];
  if (b.name !== undefined) {
    const name = blankToNull(b.name);
    if (!name) throw badRequest('name cannot be blank');
    await assertVendorNameFree(name, Number(req.params.id));
    params.push(name); sets.push(`name = $${params.length}`);
  }
  if (b.sort_order !== undefined) {
    const n = Number(b.sort_order);
    if (!Number.isInteger(n)) throw badRequest('sort_order must be an integer');
    params.push(n); sets.push(`sort_order = $${params.length}`);
  }
  if (b.active !== undefined) {
    params.push(Boolean(b.active)); sets.push(`active = $${params.length}`);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  const { rows } = await query(
    `UPDATE vendors SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );
  if (!rows[0]) throw notFound('Vendor not found');
  res.json(rows[0]);
}));

// --- orders -----------------------------------------------------------------

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
  // Archived rows are the old delivered/cancelled history (migrations 026,
  // 074). Hidden from the board by default; a ticket's own Vendor Orders box
  // (TicketVendorOrders.vue, ?ticket_id=) deliberately omits `archived` to
  // get its full history, since that's a small list tied to one job.
  if (req.query.archived !== undefined) {
    clauses.push(req.query.archived === 'true' ? 'p.archived = TRUE' : 'p.archived = FALSE');
  } else if (!req.query.ticket_id) {
    clauses.push('p.archived = FALSE');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Grouped by vendor in the UI, so rows for one vendor must be contiguous
  // (vendor name as a tiebreak covers the "Other…" ones, which have no
  // sort_order). Within a vendor: still-needed first, then most recently
  // ordered.
  const { rows } = await query(
    `SELECT p.*, COALESCE(v.name, p.vendor_other) AS vendor_name,
            COALESCE(
              (SELECT json_agg(json_build_object('id', t.id, 'title', t.title))
                 FROM parts_order_tickets pt JOIN tickets t ON t.id = pt.ticket_id
                WHERE pt.parts_order_id = p.id),
              '[]'::json
            ) AS tickets
       FROM parts_orders p LEFT JOIN vendors v ON v.id = p.vendor_id
       ${where}
      ORDER BY v.sort_order NULLS LAST, lower(COALESCE(v.name, p.vendor_other)) NULLS LAST,
               (p.status = 'needed') DESC, p.ordered_at DESC NULLS LAST, p.created_at DESC
      LIMIT 1000`,
    params,
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const item = blankToNull(b.item);
  if (!item) throw badRequest('item is required');
  const status = b.status || 'needed';
  if (!STATUSES.includes(status)) throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  const { vendorId, vendorOther } = readVendor(b);
  const orderedAt = readOrderedAt(b.ordered_at);

  const order = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO parts_orders (vendor_id, vendor_other, item, quantity, notes, status, ordered_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,
               CASE WHEN $6 = 'ordered' THEN COALESCE($7::date, ${today(9)}) END,
               $8)
       RETURNING *`,
      [vendorId, vendorOther, item, blankToNull(b.quantity), blankToNull(b.notes),
        status, orderedAt, req.user.id, config.shopTimezone],
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

/**
 * Partial update: only keys present in the body are touched, and a present
 * key set to '' or null clears the field (the old COALESCE version couldn't
 * clear anything). Status and ordered_at move together:
 *   -> needed:  ordered_at cleared
 *   -> ordered: ordered_at = the date sent, else the one it had, else today
 * so "Mark ordered" can send just { status } and the edit form can send a
 * hand-picked date.
 */
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.status !== undefined && !STATUSES.includes(b.status)) {
    throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  }

  const updated = await withTransaction(async (client) => {
    const { rows: [current] } = await client.query(
      'SELECT * FROM parts_orders WHERE id = $1 FOR UPDATE', [req.params.id],
    );
    if (!current) throw notFound('Parts order not found');

    const sets = [];
    const params = [req.params.id];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (b.item !== undefined) {
      const item = blankToNull(b.item);
      if (!item) throw badRequest('item cannot be blank');
      set('item', item);
    }
    if (b.quantity !== undefined) set('quantity', blankToNull(b.quantity));
    if (b.notes !== undefined) set('notes', blankToNull(b.notes));
    if (b.vendor_id !== undefined || b.vendor_other !== undefined) {
      const { vendorId, vendorOther } = readVendor(b);
      set('vendor_id', vendorId);
      set('vendor_other', vendorOther);
    }

    const status = b.status ?? current.status;
    if (b.status !== undefined) set('status', status);
    if (status === 'needed') {
      if (b.status !== undefined || b.ordered_at !== undefined) set('ordered_at', null);
    } else if (status === 'ordered' && (b.status !== undefined || b.ordered_at !== undefined)) {
      const picked = b.ordered_at !== undefined ? readOrderedAt(b.ordered_at) : null;
      if (picked) set('ordered_at', picked);
      else if (current.ordered_at) set('ordered_at', current.ordered_at);
      else {
        params.push(config.shopTimezone);
        sets.push(`ordered_at = ${today(params.length)}`);
      }
    }

    if (!sets.length) return current;
    sets.push('updated_at = now()');
    const { rows } = await client.query(
      `UPDATE parts_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0];
  });
  res.json(updated);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM parts_orders WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Parts order not found');
  res.json({ deleted: true });
}));

module.exports = router;
