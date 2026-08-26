'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const settings = require('../services/settings');

const router = express.Router();
router.use(requireAuth);

const TICKET_SELECT = `
  SELECT t.*,
         c.name  AS customer_name,
         i.family AS instrument_family,
         i.model  AS instrument_model,
         i.is_fleet AS instrument_is_fleet,
         tech.name AS assigned_tech_name,
         contact.name AS shop_contact_name,
         cat.label  AS category_label,
         st.label   AS status_label,
         pr.label   AS priority_label,
         tl.label   AS tech_level_label,
         COALESCE(h.actual_hours, 0)  AS actual_hours,
         e.estimated_hours,
         e.confidence AS estimate_confidence,
         COALESCE(a.attachment_count, 0) AS attachment_count,
         ip.id AS purchase_id, ip.seller_name, ip.seller_email, ip.seller_phone,
         ip.seller_address, ip.price AS purchase_price, ip.purchase_date,
         ip.notes AS purchase_notes, ip.receipt_sent_at
    FROM tickets t
    LEFT JOIN customers   c   ON c.id = t.customer_id
    LEFT JOIN instruments i   ON i.id = t.instrument_id
    LEFT JOIN employees   tech    ON tech.id = t.assigned_tech_id
    LEFT JOIN employees   contact ON contact.id = t.shop_contact_id
    LEFT JOIN settings cat ON cat.category = 'ticket_category' AND cat.key = t.category_key
    LEFT JOIN settings st  ON st.category  = 'ticket_status'   AND st.key  = t.status_key
    LEFT JOIN settings pr  ON pr.category  = 'priority_tier'   AND pr.key  = t.priority_key
    LEFT JOIN settings tl  ON tl.category  = 'tech_level'      AND tl.key  = t.tech_level_key
    LEFT JOIN LATERAL (
      SELECT sum(hours) AS actual_hours FROM hours_log WHERE ticket_id = t.id
    ) h ON TRUE
    LEFT JOIN LATERAL (
      SELECT estimated_hours + additional_hours AS estimated_hours, confidence
        FROM estimates WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1
    ) e ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS attachment_count FROM ticket_attachments WHERE ticket_id = t.id
    ) a ON TRUE
    LEFT JOIN instrument_purchases ip ON ip.ticket_id = t.id
`;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  const push = (sql, value) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.category) push('t.category_key = ?', req.query.category);
  if (req.query.status) push('t.status_key = ?', req.query.status);
  if (req.query.priority) push('t.priority_key = ?', req.query.priority);
  if (req.query.customer_id) push('t.customer_id = ?', req.query.customer_id);
  if (req.query.instrument_family) push('i.family = ?', req.query.instrument_family);
  if (req.query.assigned_tech_id) {
    if (req.query.assigned_tech_id === 'unassigned') clauses.push('t.assigned_tech_id IS NULL');
    else push('t.assigned_tech_id = ?', req.query.assigned_tech_id);
  }
  if (req.query.fleet === 'true') clauses.push('i.is_fleet = TRUE');
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    clauses.push(`(t.title ILIKE $${params.length} OR t.notes ILIKE $${params.length}
                   OR c.name ILIKE $${params.length} OR i.model ILIKE $${params.length})`);
  }

  // Archived tickets are hidden unless asked for.
  clauses.push(req.query.archived === 'true' ? 't.archived = TRUE' : 't.archived = FALSE');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);

  const { rows } = await query(
    `${TICKET_SELECT} ${where}
     ORDER BY pr.sort_order NULLS LAST, t.updated_at DESC
     LIMIT ${limit}`,
    params,
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Board summary — counts per status, for the dashboard
// ---------------------------------------------------------------------------
router.get('/summary', asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT s.key, s.label, s.sort_order, COALESCE(counts.n, 0)::int AS count
      FROM settings s
      LEFT JOIN (
        SELECT status_key, count(*) AS n FROM tickets WHERE archived = FALSE GROUP BY status_key
      ) counts ON counts.status_key = s.key
     WHERE s.category = 'ticket_status'
     ORDER BY s.sort_order, s.id
  `);
  const totals = await query(`
    SELECT
      (SELECT count(*)::int FROM tickets WHERE archived = FALSE) AS open_tickets,
      (SELECT COALESCE(sum(hours), 0)::numeric FROM hours_log
        WHERE worked_on >= date_trunc('week', CURRENT_DATE)) AS hours_this_week,
      (SELECT count(*)::int FROM tickets WHERE archived = FALSE AND assigned_tech_id IS NULL)
        AS unassigned
  `);
  res.json({ by_status: rows, totals: totals.rows[0] });
}));

// ---------------------------------------------------------------------------
// Detail — ticket plus every child collection
// ---------------------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query(`${TICKET_SELECT} WHERE t.id = $1`, [req.params.id]);
  const ticket = rows[0];
  if (!ticket) throw notFound('Ticket not found');

  const [estimates, hours, qc, attachments, history, shipmentRows, invoiceRows] = await Promise.all([
    query(`SELECT e.*, emp.name AS created_by_name
             FROM estimates e LEFT JOIN employees emp ON emp.id = e.created_by
            WHERE e.ticket_id = $1 ORDER BY e.created_at DESC`, [req.params.id]),
    query(`SELECT h.*, emp.name AS employee_name
             FROM hours_log h JOIN employees emp ON emp.id = h.employee_id
            WHERE h.ticket_id = $1 ORDER BY h.worked_on DESC, h.logged_at DESC`, [req.params.id]),
    query(`SELECT q.*, emp.name AS reviewer_name, s.label AS tier_label
             FROM qc_checks q
             LEFT JOIN employees emp ON emp.id = q.reviewer_id
             LEFT JOIN settings s ON s.category = 'qc_tier' AND s.key = q.tier_key
            WHERE q.ticket_id = $1 ORDER BY q.round_number`, [req.params.id]),
    query(`SELECT a.*, emp.name AS uploader_name
             FROM ticket_attachments a LEFT JOIN employees emp ON emp.id = a.uploader_id
            WHERE a.ticket_id = $1 ORDER BY a.uploaded_at DESC`, [req.params.id]),
    query(`SELECT l.*, emp.name AS changed_by_name
             FROM status_change_log l LEFT JOIN employees emp ON emp.id = l.changed_by
            WHERE l.ticket_id = $1 ORDER BY l.changed_at DESC`, [req.params.id]),
    query('SELECT * FROM shipments WHERE ticket_id = $1 ORDER BY created_at', [req.params.id]),
    query('SELECT * FROM invoices WHERE ticket_id = $1 ORDER BY created_at', [req.params.id]),
  ]);

  res.json({
    ...ticket,
    estimates: estimates.rows,
    hours_log: hours.rows,
    qc_checks: qc.rows,
    attachments: attachments.rows,
    status_history: history.rows,
    shipments: shipmentRows.rows,
    invoices: invoiceRows.rows,
  });
}));

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
// Resolve category/priority/status/tech-level for a *new* ticket (status
// defaults to the first non-retired one by sort order). Named distinctly
// from PATCH's local `resolved` below — that one is partial/optional and
// unrelated to this.
async function resolveNewTicketFields(b) {
  if (!b.category_key) throw badRequest('category_key is required');
  if (!b.priority_key) throw badRequest('priority_key is required');

  const [category, priority] = await Promise.all([
    settings.resolveActive('ticket_category', b.category_key),
    settings.resolveActive('priority_tier', b.priority_key),
  ]);

  let statusKey = b.status_key;
  if (!statusKey) {
    const { rows } = await query(
      `SELECT key FROM settings WHERE category = 'ticket_status' AND retired = FALSE
        ORDER BY sort_order, id LIMIT 1`,
    );
    if (!rows[0]) throw badRequest('No ticket statuses are configured');
    statusKey = rows[0].key;
  }
  const status = await settings.resolveActive('ticket_status', statusKey);

  let techLevel = null;
  if (b.tech_level_key) techLevel = await settings.resolveActive('tech_level', b.tech_level_key);

  return {
    category, priority, status, techLevel,
  };
}

// Insert the ticket + its creation status_change_log entry on an
// already-open client, given fields already resolved by the function
// above. Callers own the transaction: the POST / route wraps this in its
// own withTransaction; routes/purchases.js calls it inside a larger one
// that also writes the instrument and purchase rows, so a failure partway
// through never leaves an orphaned ticket.
async function insertTicketRow(client, b, resolved, createdById) {
  const {
    category, priority, status, techLevel,
  } = resolved;
  const { rows } = await client.query(
    `INSERT INTO tickets (
       title, category_key, category_label_snapshot,
       priority_key, priority_label_snapshot,
       status_key, status_label_snapshot,
       tech_level_key, tech_level_label_snapshot,
       instrument_id, customer_id, assigned_tech_id, shop_contact_id,
       notes, drop_off_date, due_date, multi_instrument, vendor_tracks,
       shopify_order_id, qc_required, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               COALESCE($18,'{}'::jsonb),$19,COALESCE($20,TRUE),$21)
     RETURNING *`,
    [
      String(b.title).trim(),
      category.key, category.label,
      priority.key, priority.label,
      status.key, status.label,
      techLevel ? techLevel.key : null, techLevel ? techLevel.label : null,
      b.instrument_id || null,
      b.customer_id || null,
      b.assigned_tech_id || null,
      b.shop_contact_id || null,
      b.notes || null,
      b.drop_off_date || null,
      b.due_date || null,
      b.multi_instrument === true,
      b.vendor_tracks ? JSON.stringify(b.vendor_tracks) : null,
      b.shopify_order_id || null,
      b.qc_required,
      createdById,
    ],
  );
  const created = rows[0];

  await client.query(
    `INSERT INTO status_change_log (ticket_id, old_status, new_status, old_label, new_label, changed_by, note)
     VALUES ($1, NULL, $2, NULL, $3, $4, 'Ticket created')`,
    [created.id, status.key, status.label, createdById],
  );
  return created;
}

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) throw badRequest('title is required');

  const resolved = await resolveNewTicketFields(b);
  const ticket = await withTransaction((client) => insertTicketRow(client, b, resolved, req.user.id));

  res.status(201).json(ticket);
}));

// ---------------------------------------------------------------------------
// Update
//   Status is free-form (§8): any value may follow any value. Every change is
//   written to status_change_log so the audit trail stands in for a rules engine.
// ---------------------------------------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) throw notFound('Ticket not found');

  const resolved = {};
  if (b.category_key && b.category_key !== existing.category_key) {
    resolved.category = await settings.resolveActive('ticket_category', b.category_key);
  }
  if (b.priority_key && b.priority_key !== existing.priority_key) {
    resolved.priority = await settings.resolveActive('priority_tier', b.priority_key);
  }
  if (b.status_key && b.status_key !== existing.status_key) {
    resolved.status = await settings.resolveActive('ticket_status', b.status_key);
  }
  if (b.tech_level_key !== undefined && b.tech_level_key !== existing.tech_level_key) {
    resolved.techLevel = b.tech_level_key
      ? await settings.resolveActive('tech_level', b.tech_level_key)
      : null;
  }

  const updated = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE tickets SET
         title            = COALESCE($2, title),
         category_key     = COALESCE($3, category_key),
         category_label_snapshot = COALESCE($4, category_label_snapshot),
         priority_key     = COALESCE($5, priority_key),
         priority_label_snapshot = COALESCE($6, priority_label_snapshot),
         status_key       = COALESCE($7, status_key),
         status_label_snapshot   = COALESCE($8, status_label_snapshot),
         tech_level_key   = CASE WHEN $9::boolean THEN $10 ELSE tech_level_key END,
         tech_level_label_snapshot = CASE WHEN $9::boolean THEN $11 ELSE tech_level_label_snapshot END,
         instrument_id    = CASE WHEN $12::boolean THEN $13 ELSE instrument_id END,
         customer_id      = CASE WHEN $14::boolean THEN $15 ELSE customer_id END,
         assigned_tech_id = CASE WHEN $16::boolean THEN $17 ELSE assigned_tech_id END,
         shop_contact_id  = CASE WHEN $18::boolean THEN $19 ELSE shop_contact_id END,
         notes            = COALESCE($20, notes),
         drop_off_date    = COALESCE($21, drop_off_date),
         due_date         = COALESCE($22, due_date),
         multi_instrument = COALESCE($23, multi_instrument),
         vendor_tracks    = COALESCE($24, vendor_tracks),
         qc_required      = COALESCE($25, qc_required),
         archived         = COALESCE($26, archived)
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        b.title === undefined ? null : String(b.title).trim(),
        resolved.category ? resolved.category.key : null,
        resolved.category ? resolved.category.label : null,
        resolved.priority ? resolved.priority.key : null,
        resolved.priority ? resolved.priority.label : null,
        resolved.status ? resolved.status.key : null,
        resolved.status ? resolved.status.label : null,
        b.tech_level_key !== undefined,
        resolved.techLevel ? resolved.techLevel.key : null,
        resolved.techLevel ? resolved.techLevel.label : null,
        b.instrument_id !== undefined, b.instrument_id || null,
        b.customer_id !== undefined, b.customer_id || null,
        b.assigned_tech_id !== undefined, b.assigned_tech_id || null,
        b.shop_contact_id !== undefined, b.shop_contact_id || null,
        b.notes === undefined ? null : b.notes,
        b.drop_off_date === undefined ? null : b.drop_off_date,
        b.due_date === undefined ? null : b.due_date,
        b.multi_instrument === undefined ? null : b.multi_instrument,
        b.vendor_tracks === undefined ? null : JSON.stringify(b.vendor_tracks),
        b.qc_required === undefined ? null : b.qc_required,
        b.archived === undefined ? null : b.archived,
      ],
    );

    if (resolved.status) {
      await client.query(
        `INSERT INTO status_change_log
           (ticket_id, old_status, new_status, old_label, new_label, changed_by, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.params.id,
          existing.status_key, resolved.status.key,
          existing.status_label_snapshot, resolved.status.label,
          req.user.id,
          b.status_note || null,
        ],
      );
    }
    return rows[0];
  });

  res.json(updated);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { rowCount } = await query('DELETE FROM tickets WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Ticket not found');
  return res.json({ deleted: true });
}));

module.exports = router;
// Attached to the router export rather than module-level named exports, so
// `require('./tickets')` still works unchanged as the mounted route in
// index.js, and routes/purchases.js can additionally pull these two off it.
module.exports.resolveNewTicketFields = resolveNewTicketFields;
module.exports.insertTicketRow = insertTicketRow;
