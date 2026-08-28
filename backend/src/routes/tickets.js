'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const settings = require('../services/settings');
const { createShipment } = require('./shipments');
const { FAMILIES } = require('./instruments');

const router = express.Router();
router.use(requireAuth);

// A ticket with no priority picker of its own — same reasoning as
// routes/purchases.js's and routes/shopifyWebhooks.js's own defaults:
// shipping jobs are usually quick, and anyone can re-triage from the queue
// if a particular one (crating, international) turns out to need more time.
const DEFAULT_SHIPPING_PRIORITY_KEY = 'daily_todo';

const TICKET_SELECT = `
  SELECT t.*,
         src.title AS source_ticket_title,
         c.name  AS customer_name,
         i.family AS instrument_family,
         i.model  AS instrument_model,
         i.is_fleet AS instrument_is_fleet,
         contact.name AS shop_contact_name,
         cat.label  AS category_label,
         st.label   AS status_label,
         pr.label   AS priority_label,
         tl.label   AS tech_level_label,
         COALESCE(h.actual_hours, 0)  AS actual_hours,
         e.estimated_hours,
         e.confidence AS estimate_confidence,
         COALESCE(a.attachment_count, 0) AS attachment_count,
         COALESCE(techs.technicians, '[]'::json) AS technicians,
         ip.id AS purchase_id, ip.seller_name, ip.seller_email, ip.seller_phone,
         ip.seller_address, ip.price AS purchase_price, ip.purchase_date,
         ip.notes AS purchase_notes, ip.receipt_sent_at
    FROM tickets t
    LEFT JOIN customers   c   ON c.id = t.customer_id
    LEFT JOIN instruments i   ON i.id = t.instrument_id
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
    LEFT JOIN LATERAL (
      -- Zero or more assigned techs (migration 013), each with their own
      -- position in *their* queue — never a single "the" assignee anymore.
      SELECT json_agg(
               json_build_object('id', e2.id, 'name', e2.name, 'queue_position', tt.queue_position)
               ORDER BY tt.queue_position NULLS LAST, e2.name
             ) AS technicians
        FROM ticket_technicians tt
        JOIN employees e2 ON e2.id = tt.employee_id
       WHERE tt.ticket_id = t.id
    ) techs ON TRUE
    LEFT JOIN instrument_purchases ip ON ip.ticket_id = t.id
    LEFT JOIN tickets src ON src.id = t.source_ticket_id
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

  // Tickets page's "Hide statuses" dropdown (TicketsView.vue) — a comma-
  // separated list of status keys to exclude, independent of (and
  // combinable with, however little sense that combination makes) the
  // single-status filter above. Distinct from `status` because that one
  // means "show only this one status" while this means "show everything
  // except these" — two different shapes of question, so one query param
  // apiece rather than overloading `status` with a hide/show sense.
  if (req.query.hide_status) {
    const hidden = String(req.query.hide_status).split(',').map((s) => s.trim()).filter(Boolean);
    if (hidden.length) {
      params.push(hidden);
      clauses.push(`NOT (t.status_key = ANY($${params.length}))`);
    }
  }

  // A ticket can carry more than one tech now (migration 013) — this filter
  // means "this tech is among the ones assigned," not "the" tech.
  // technicianParamIdx tracks which $N holds the id, so the ORDER BY below
  // can reuse it for the tech-queue join without pushing the value twice.
  let technicianParamIdx = null;
  if (req.query.technician_id) {
    if (req.query.technician_id === 'unassigned') {
      clauses.push('NOT EXISTS (SELECT 1 FROM ticket_technicians tt WHERE tt.ticket_id = t.id)');
    } else {
      params.push(req.query.technician_id);
      technicianParamIdx = params.length;
      clauses.push(`EXISTS (
        SELECT 1 FROM ticket_technicians tt
         WHERE tt.ticket_id = t.id AND tt.employee_id = $${technicianParamIdx}
      )`);
    }
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
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // Filtered to exactly one category, one tech, or one instrument family ->
  // that's a real queue, so show it in its explicit, reorderable order (see
  // migrations 007 and 015). Anything broader (browsing everything, or more
  // than one of those filters at once — those don't share a single queue)
  // falls back to the old priority/recency sort, since there's no one queue
  // order that spans multiple categories, techs, or families.
  //
  // Every queue axis below is now prefixed with st.sort_order — status is
  // the primary grouping everywhere a queue exists (Queue page, dashboard),
  // and the axis-specific position column is just the tiebreaker *within*
  // a status. POST /reorder-queue (below) only ever renumbers positions
  // within one status for exactly this reason — the two have to agree.
  //
  // An explicit ?sort= overrides all of the above — it's a deliberate "show
  // me the list this way" choice, not a fallback, so it wins regardless of
  // which filters are active. sort=status orders by the status's own
  // sort_order (its position in the shop's workflow — Not Started before In
  // Progress before Done, etc.), i.e. the settings-configurable progression
  // from Settings -> Ticket statuses, not alphabetical or by-key order.
  let orderBy = 'pr.sort_order NULLS LAST, t.updated_at DESC';
  let extraJoin = '';
  if (req.query.sort === 'status') {
    orderBy = 'st.sort_order NULLS LAST, t.updated_at DESC';
  } else if (req.query.category && !req.query.technician_id) {
    orderBy = 'st.sort_order NULLS LAST, t.category_queue_position NULLS LAST, t.updated_at DESC';
  } else if (technicianParamIdx && !req.query.category) {
    // Order by *this* tech's position for this ticket specifically — a
    // ticket can be #2 for one assigned tech and #7 for another.
    extraJoin = ` LEFT JOIN ticket_technicians tt_order
                    ON tt_order.ticket_id = t.id AND tt_order.employee_id = $${technicianParamIdx}`;
    orderBy = 'st.sort_order NULLS LAST, tt_order.queue_position NULLS LAST, t.updated_at DESC';
  } else if (req.query.instrument_family && !req.query.category && !req.query.technician_id) {
    // Third queue axis (migration 015): a family, e.g. every Rhodes job,
    // in its own deliberate order independent of category or tech.
    orderBy = 'st.sort_order NULLS LAST, t.family_queue_position NULLS LAST, t.updated_at DESC';
  } else if (req.query.technician_id === 'unassigned' && !req.query.category && !req.query.instrument_family) {
    // Not a positioned queue (an unassigned ticket has no tech_queue_position
    // to speak of), but the dashboard's "Unassigned" list still wants status
    // grouping — tiebroken by priority same as the no-filter fallback below.
    orderBy = 'st.sort_order NULLS LAST, pr.sort_order NULLS LAST, t.updated_at DESC';
  }

  const { rows } = await query(
    `${TICKET_SELECT}${extraJoin} ${where}
     ORDER BY ${orderBy}
     LIMIT ${limit}
     OFFSET ${offset}`,
    params,
  );

  // Total matching count (ignoring limit/offset) so callers that paginate
  // (currently just DashboardView's "Assigned to me"/"Unassigned" lists)
  // know how many pages there are. A header, not a body-shape change, so
  // every other caller of GET /tickets keeps getting a plain array back.
  const { rows: countRows } = await query(
    `SELECT count(*)::int AS total
       FROM tickets t
       LEFT JOIN instruments i ON i.id = t.instrument_id
       LEFT JOIN customers   c ON c.id = t.customer_id
       ${where}`,
    params,
  );
  res.set('X-Total-Count', String(countRows[0].total));
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
      (SELECT count(*)::int FROM tickets
        WHERE archived = FALSE
          AND NOT EXISTS (SELECT 1 FROM ticket_technicians tt WHERE tt.ticket_id = tickets.id))
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

  const [
    estimates, hours, qc, attachments, history, shipmentRows, invoiceRows, childRows,
  ] = await Promise.all([
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
    // Sub-tickets: any ticket created *from* this one (the "Create shipping
    // ticket" button, or the general "Add sub-ticket" form — both just set
    // source_ticket_id on a normal POST /tickets). Lets the parent link
    // forward to all of its children, not just each child linking back via
    // source_ticket_id/source_ticket_title.
    query(`SELECT c.id, c.title, c.category_key, c.category_label_snapshot,
                  c.status_key, c.status_label_snapshot,
                  COALESCE(techs.technicians, '[]'::json) AS technicians
             FROM tickets c
             LEFT JOIN LATERAL (
               SELECT json_agg(
                        json_build_object('id', e2.id, 'name', e2.name, 'queue_position', tt.queue_position)
                        ORDER BY tt.queue_position NULLS LAST, e2.name
                      ) AS technicians
                 FROM ticket_technicians tt
                 JOIN employees e2 ON e2.id = tt.employee_id
                WHERE tt.ticket_id = c.id
             ) techs ON TRUE
            WHERE c.source_ticket_id = $1 AND c.archived = FALSE
            ORDER BY c.created_at`, [req.params.id]),
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
    child_tickets: childRows.rows,
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

  // A sub-ticket ("Add sub-ticket" on any ticket, or the "Create shipping
  // ticket" button) is just a normal ticket with source_ticket_id set —
  // checked here so a bad/deleted parent id fails with a clear message
  // instead of surfacing the tickets_source_ticket_id_fkey constraint as a
  // raw 500.
  if (b.source_ticket_id) {
    const { rows } = await query('SELECT id FROM tickets WHERE id = $1', [b.source_ticket_id]);
    if (!rows[0]) throw badRequest(`Parent ticket #${b.source_ticket_id} not found`);
  }

  const [category, priority] = await Promise.all([
    settings.resolveActive('ticket_category', b.category_key),
    settings.resolveActive('priority_tier', b.priority_key),
  ]);

  // Status options are category-aware (e.g. Shipping only offers Not
  // Started/In Progress/Done — see NOTES.md) — resolve/default against this
  // ticket's actual category rather than the raw settings list.
  const status = b.status_key
    ? await settings.resolveStatusForCategory(b.status_key, category.key)
    : await settings.defaultStatusForCategory(category.key);

  let techLevel = null;
  if (b.tech_level_key) techLevel = await settings.resolveActive('tech_level', b.tech_level_key);

  // Default assignment (Settings -> a category's "Default assignee"): only
  // kicks in when nobody named any technicians explicitly, and only if that
  // employee is still active — a departed shipping manager should never
  // silently keep collecting new tickets.
  let defaultAssignedTechIds = [];
  const explicitTechnicianIds = Array.isArray(b.technician_ids) ? b.technician_ids : [];
  if (!explicitTechnicianIds.length && category.meta && category.meta.default_assignee_id) {
    const { rows } = await query(
      'SELECT id FROM employees WHERE id = $1 AND active = TRUE',
      [category.meta.default_assignee_id],
    );
    if (rows[0]) defaultAssignedTechIds = [rows[0].id];
  }

  return {
    category, priority, status, techLevel, defaultAssignedTechIds,
  };
}

// Small shared helpers so insertTicketRow and PATCH /:id (below) don't each
// re-derive "what family is this instrument" / "what's the back of that
// family's queue" their own way.
async function instrumentFamily(client, instrumentId) {
  if (!instrumentId) return null;
  const { rows } = await client.query('SELECT family FROM instruments WHERE id = $1', [instrumentId]);
  return rows[0] ? rows[0].family : null;
}

async function nextFamilyQueuePosition(client, family) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(t2.family_queue_position), 0) + 10 AS next
       FROM tickets t2 JOIN instruments i2 ON i2.id = t2.instrument_id
      WHERE i2.family = $1 AND t2.archived = FALSE`,
    [family],
  );
  return rows[0].next;
}

// Insert the ticket + its creation status_change_log entry + its technician
// assignments on an already-open client, given fields already resolved by
// the function above. Callers own the transaction: the POST / route wraps
// this in its own withTransaction; routes/purchases.js calls it inside a
// larger one that also writes the instrument and purchase rows, so a
// failure partway through never leaves an orphaned ticket.
async function insertTicketRow(client, b, resolved, createdById) {
  const {
    category, priority, status, techLevel, defaultAssignedTechIds,
  } = resolved;
  const technicianIds = [...new Set(
    (Array.isArray(b.technician_ids) && b.technician_ids.length ? b.technician_ids : defaultAssignedTechIds)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  )];

  // New tickets always land at the bottom of the category queue they
  // participate in — the same "back of the line" rule as the old implicit
  // ordering, just made explicit and persisted instead of falling out of
  // updated_at. See migration 007 for category queues, and 013 for why each
  // assigned tech gets their own queue position rather than the ticket
  // having just one.
  const { rows: catRows } = await client.query(
    `SELECT COALESCE(MAX(category_queue_position), 0) + 10 AS next
       FROM tickets WHERE category_key = $1 AND archived = FALSE`,
    [category.key],
  );
  const categoryQueuePosition = catRows[0].next;

  // Same "back of the line" rule, on the instrument-family axis (migration
  // 015) — only applies when this ticket actually has an instrument.
  const family = await instrumentFamily(client, b.instrument_id || null);
  const familyQueuePosition = family ? await nextFamilyQueuePosition(client, family) : null;

  const { rows } = await client.query(
    `INSERT INTO tickets (
       title, category_key, category_label_snapshot,
       priority_key, priority_label_snapshot,
       status_key, status_label_snapshot,
       tech_level_key, tech_level_label_snapshot,
       instrument_id, customer_id, shop_contact_id,
       notes, drop_off_date, due_date, multi_instrument, vendor_tracks,
       shopify_order_id, qc_required, created_by,
       category_queue_position, source_ticket_id, source_estimate_id,
       family_queue_position
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               COALESCE($17,'{}'::jsonb),$18,COALESCE($19,TRUE),$20,$21,$22,$23,$24)
     RETURNING *`,
    [
      String(b.title).trim(),
      category.key, category.label,
      priority.key, priority.label,
      status.key, status.label,
      techLevel ? techLevel.key : null, techLevel ? techLevel.label : null,
      b.instrument_id || null,
      b.customer_id || null,
      b.shop_contact_id || null,
      b.notes || null,
      b.drop_off_date || null,
      b.due_date || null,
      b.multi_instrument === true,
      b.vendor_tracks ? JSON.stringify(b.vendor_tracks) : null,
      b.shopify_order_id || null,
      b.qc_required,
      createdById,
      categoryQueuePosition,
      b.source_ticket_id || null,
      b.source_estimate_id || null,
      familyQueuePosition,
    ],
  );
  const created = rows[0];

  await client.query(
    `INSERT INTO status_change_log (ticket_id, old_status, new_status, old_label, new_label, changed_by, note)
     VALUES ($1, NULL, $2, NULL, $3, $4, 'Ticket created')`,
    [created.id, status.key, status.label, createdById],
  );

  // Each assigned tech joins their own queue at the bottom of it, same
  // "back of the line" rule as the category queue above.
  for (const employeeId of technicianIds) {
    const { rows: techRows } = await client.query(
      `SELECT COALESCE(MAX(tt.queue_position), 0) + 10 AS next
         FROM ticket_technicians tt
         JOIN tickets t2 ON t2.id = tt.ticket_id
        WHERE tt.employee_id = $1 AND t2.archived = FALSE`,
      [employeeId],
    );
    await client.query(
      `INSERT INTO ticket_technicians (ticket_id, employee_id, queue_position, assigned_by)
       VALUES ($1, $2, $3, $4)`,
      [created.id, employeeId, techRows[0].next, createdById],
    );
  }

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
  const effectiveCategoryKey = resolved.category ? resolved.category.key : existing.category_key;
  let statusAutoReset = false;
  if (b.status_key && b.status_key !== existing.status_key) {
    resolved.status = await settings.resolveStatusForCategory(b.status_key, effectiveCategoryKey);
  } else if (resolved.category) {
    // Category is changing but no explicit new status was given — if the
    // ticket's current status isn't valid for the new category (e.g. a
    // Servicing ticket sitting at "QC" moving into Shipping, which doesn't
    // have a QC status), re-home it to that category's default rather than
    // silently leaving it stuck on a status the new category can't display.
    const currentStatus = await settings.resolve('ticket_status', existing.status_key);
    if (!settings.statusAppliesToCategory(currentStatus, effectiveCategoryKey)) {
      resolved.status = await settings.defaultStatusForCategory(effectiveCategoryKey);
      statusAutoReset = true;
    }
  }
  if (b.tech_level_key !== undefined && b.tech_level_key !== existing.tech_level_key) {
    resolved.techLevel = b.tech_level_key
      ? await settings.resolveActive('tech_level', b.tech_level_key)
      : null;
  }

  const updated = await withTransaction(async (client) => {
    // Changing a ticket's category moves it into a different queue — it
    // always joins that queue at the bottom (same rule as a brand-new
    // ticket), rather than keeping a position number that was only ever
    // meaningful in the queue it just left.
    let newCategoryQueuePosition;
    if (resolved.category && resolved.category.key !== existing.category_key) {
      const { rows: catRows } = await client.query(
        `SELECT COALESCE(MAX(category_queue_position), 0) + 10 AS next
           FROM tickets WHERE category_key = $1 AND archived = FALSE`,
        [resolved.category.key],
      );
      newCategoryQueuePosition = catRows[0].next;
    }

    // Same idea, on the instrument-family axis (migration 015) — but the
    // scope key here isn't a direct column, it's derived from
    // instrument_id, so re-homing only makes sense once we know both the
    // old and new instrument's family and can tell whether that actually
    // changed. Swapping to a *different* instrument in the *same* family
    // (rare, but possible) correctly does nothing here — same "no-op
    // unless the effective scope key changes" rule the category branch
    // above follows.
    let newFamilyQueuePosition;
    if (b.instrument_id !== undefined && b.instrument_id !== existing.instrument_id) {
      const [oldFamily, newFamily] = await Promise.all([
        instrumentFamily(client, existing.instrument_id),
        instrumentFamily(client, b.instrument_id || null),
      ]);
      if (newFamily !== oldFamily) {
        newFamilyQueuePosition = newFamily ? await nextFamilyQueuePosition(client, newFamily) : null;
      }
    }

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
         shop_contact_id  = CASE WHEN $16::boolean THEN $17 ELSE shop_contact_id END,
         notes            = COALESCE($18, notes),
         drop_off_date    = COALESCE($19, drop_off_date),
         due_date         = COALESCE($20, due_date),
         multi_instrument = COALESCE($21, multi_instrument),
         vendor_tracks    = COALESCE($22, vendor_tracks),
         qc_required      = COALESCE($23, qc_required),
         archived         = COALESCE($24, archived),
         category_queue_position = CASE WHEN $25::boolean THEN $26 ELSE category_queue_position END,
         family_queue_position   = CASE WHEN $27::boolean THEN $28 ELSE family_queue_position END,
         service_done_notes      = COALESCE($29, service_done_notes),
         service_needed_notes    = COALESCE($30, service_needed_notes)
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
        b.shop_contact_id !== undefined, b.shop_contact_id || null,
        b.notes === undefined ? null : b.notes,
        b.drop_off_date === undefined ? null : b.drop_off_date,
        b.due_date === undefined ? null : b.due_date,
        b.multi_instrument === undefined ? null : b.multi_instrument,
        b.vendor_tracks === undefined ? null : JSON.stringify(b.vendor_tracks),
        b.qc_required === undefined ? null : b.qc_required,
        b.archived === undefined ? null : b.archived,
        newCategoryQueuePosition !== undefined, newCategoryQueuePosition ?? null,
        newFamilyQueuePosition !== undefined, newFamilyQueuePosition ?? null,
        b.service_done_notes === undefined ? null : b.service_done_notes,
        b.service_needed_notes === undefined ? null : b.service_needed_notes,
      ],
    );

    // Technicians: an explicit (possibly empty) array means "this is the
    // full set now" — diff against who's currently on it rather than
    // touching everyone, so a tech who stays assigned keeps their existing
    // queue position instead of getting bumped to the back of their queue.
    if (b.technician_ids !== undefined) {
      const nextIds = [...new Set(
        (Array.isArray(b.technician_ids) ? b.technician_ids : [])
          .map(Number)
          .filter((n) => Number.isFinite(n)),
      )];
      const { rows: currentRows } = await client.query(
        'SELECT employee_id FROM ticket_technicians WHERE ticket_id = $1', [req.params.id],
      );
      const currentIds = currentRows.map((r) => r.employee_id);
      const toRemove = currentIds.filter((id) => !nextIds.includes(id));
      const toAdd = nextIds.filter((id) => !currentIds.includes(id));

      if (toRemove.length) {
        await client.query(
          'DELETE FROM ticket_technicians WHERE ticket_id = $1 AND employee_id = ANY($2::int[])',
          [req.params.id, toRemove],
        );
      }
      for (const employeeId of toAdd) {
        const { rows: techRows } = await client.query(
          `SELECT COALESCE(MAX(tt.queue_position), 0) + 10 AS next
             FROM ticket_technicians tt
             JOIN tickets t2 ON t2.id = tt.ticket_id
            WHERE tt.employee_id = $1 AND t2.archived = FALSE`,
          [employeeId],
        );
        await client.query(
          `INSERT INTO ticket_technicians (ticket_id, employee_id, queue_position, assigned_by)
           VALUES ($1, $2, $3, $4)`,
          [req.params.id, employeeId, techRows[0].next, req.user.id],
        );
      }
    }

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
          b.status_note || (statusAutoReset
            ? `Status reset automatically — '${existing.status_label_snapshot}' isn't valid for `
              + `the new category (${resolved.category.label}).`
            : null),
        ],
      );
    }
    return rows[0];
  });

  res.json(updated);
}));

// ---------------------------------------------------------------------------
// Queue reordering — open to any signed-in user (per NOTES.md: this used to
// be admin-only via one-step up/down swaps; the dedicated Queue view
// (frontend QueueView.vue) replaced that with drag-and-drop, which needs a
// "here's the whole new order" call rather than a series of single swaps).
//
// A ticket sits in up to three kinds of queue — its category's, each of its
// assigned techs' own (migration 007, extended to one position per
// assignment in 013), and its instrument's family (migration 015) — so
// every call has to say which queue (and for a tech or family queue,
// whose/which). Status is now *also* required (`status_key`): GET /
// (above) sorts every one of these queues by status first, so QueueView.vue
// only ever lets someone drag within one status section at a time, and
// `ticket_ids` here is just that section's ids, not the whole queue. The
// server re-checks the invariant rather than trusting the client: "current"
// below is scoped to (queue, status_key), so a request can only ever touch
// positions for tickets that are actually in that status — reordering
// across a status boundary is rejected as a mismatch, same as any other
// stale-queue conflict. The client sends the *entire* reordered list of
// ticket ids for that one queue+status; the server checks it's exactly the
// same set of tickets currently there (nobody else added/removed/changed
// the status of one while this was being dragged) and then renumbers
// positions 10, 20, 30... in the given order — a plain reindex, not a
// series of swaps, since drag-and-drop can move something many places in
// one action. Other statuses' position values are never touched.
// ---------------------------------------------------------------------------
router.post('/reorder-queue', asyncHandler(async (req, res) => {
  const { scope } = req.body || {};
  if (scope !== 'category' && scope !== 'tech' && scope !== 'family') {
    throw badRequest("scope must be 'category', 'tech', or 'family'");
  }

  const statusKey = req.body.status_key;
  if (!statusKey) throw badRequest('status_key is required — reordering is scoped to one status at a time');
  await settings.resolve('ticket_status', statusKey); // throws if unknown

  const ticketIds = [...new Set(
    (Array.isArray(req.body.ticket_ids) ? req.body.ticket_ids : [])
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  )];
  if (!ticketIds.length) throw badRequest('ticket_ids is required');

  // Both branches follow the same shape: look up who's *actually* in this
  // queue's status section right now, refuse if that doesn't match what the
  // client thinks it's reordering (stale view — someone else changed the
  // queue, or the status, mid-drag), then write positions 10/20/30... in
  // the client's given order. Scoping "current" to status_key means a
  // client can never smuggle a cross-status reorder through this endpoint,
  // even if it tried — the mismatch check catches it the same way it
  // catches any other stale queue.
  const mismatchError = () => badRequest(
    "That queue's status section has changed since it was loaded — someone else likely added, "
    + 'removed, reassigned, or changed the status of a ticket. Reload the queue and try again.',
  );

  if (scope === 'category') {
    const categoryKey = req.body.category_key;
    if (!categoryKey) throw badRequest('category_key is required for scope=category');
    await settings.resolve('ticket_category', categoryKey); // throws if unknown

    await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT id FROM tickets WHERE category_key = $1 AND status_key = $2 AND archived = FALSE',
        [categoryKey, statusKey],
      );
      const currentIds = new Set(current.map((r) => r.id));
      if (currentIds.size !== ticketIds.length || ticketIds.some((id) => !currentIds.has(id))) {
        throw mismatchError();
      }
      for (let i = 0; i < ticketIds.length; i += 1) {
        await client.query(
          'UPDATE tickets SET category_queue_position = $1 WHERE id = $2',
          [(i + 1) * 10, ticketIds[i]],
        );
      }
    });
  } else if (scope === 'tech') {
    const employeeId = Number(req.body.employee_id);
    if (!Number.isFinite(employeeId)) throw badRequest('employee_id is required for scope=tech');
    const { rows: empRows } = await query('SELECT id FROM employees WHERE id = $1', [employeeId]);
    if (!empRows[0]) throw notFound('Technician not found');

    await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        `SELECT tt.ticket_id AS id FROM ticket_technicians tt
           JOIN tickets t2 ON t2.id = tt.ticket_id
          WHERE tt.employee_id = $1 AND t2.status_key = $2 AND t2.archived = FALSE`,
        [employeeId, statusKey],
      );
      const currentIds = new Set(current.map((r) => r.id));
      if (currentIds.size !== ticketIds.length || ticketIds.some((id) => !currentIds.has(id))) {
        throw mismatchError();
      }
      for (let i = 0; i < ticketIds.length; i += 1) {
        await client.query(
          'UPDATE ticket_technicians SET queue_position = $1 WHERE ticket_id = $2 AND employee_id = $3',
          [(i + 1) * 10, ticketIds[i], employeeId],
        );
      }
    });
  } else {
    const family = req.body.family;
    if (!family || !FAMILIES.includes(family)) {
      throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
    }

    await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        `SELECT t2.id FROM tickets t2 JOIN instruments i2 ON i2.id = t2.instrument_id
          WHERE i2.family = $1 AND t2.status_key = $2 AND t2.archived = FALSE`,
        [family, statusKey],
      );
      const currentIds = new Set(current.map((r) => r.id));
      if (currentIds.size !== ticketIds.length || ticketIds.some((id) => !currentIds.has(id))) {
        throw mismatchError();
      }
      for (let i = 0; i < ticketIds.length; i += 1) {
        await client.query(
          'UPDATE tickets SET family_queue_position = $1 WHERE id = $2',
          [(i + 1) * 10, ticketIds[i]],
        );
      }
    });
  }

  res.json({ scope, status_key: statusKey, reordered: ticketIds.length });
}));

// ---------------------------------------------------------------------------
// "Create shipping ticket" — spins up a linked ticket in the Shipping
// category for this ticket's instrument, plus its shipments record (PLAN §7:
// deeper packing jobs get "own ticket type, reuses the existing... Shipping
// Checklist pattern"). Both are created in one transaction so a failure
// partway through can't leave a shipping ticket with no shipment behind it,
// same principle as routes/purchases.js's instrument+ticket+purchase insert.
// ---------------------------------------------------------------------------
router.post('/:id/create-shipping-ticket', asyncHandler(async (req, res) => {
  const { rows } = await query(`${TICKET_SELECT} WHERE t.id = $1`, [req.params.id]);
  const source = rows[0];
  if (!source) throw notFound('Ticket not found');
  if (!source.instrument_id) throw badRequest('This ticket has no instrument to ship');

  const resolved = await resolveNewTicketFields({
    category_key: 'shipping',
    priority_key: DEFAULT_SHIPPING_PRIORITY_KEY,
  });

  const title = `Ship — ${source.instrument_family}`
    + `${source.instrument_model ? ` ${source.instrument_model}` : ''}`;
  const notes = `Ship this instrument${source.customer_name ? ` to ${source.customer_name}` : ''}. `
    + `Created from ticket #${source.id} — "${source.title}".`;

  const created = await withTransaction(async (client) => {
    const ticket = await insertTicketRow(
      client,
      {
        title,
        notes,
        instrument_id: source.instrument_id,
        customer_id: source.customer_id,
        source_ticket_id: source.id,
      },
      resolved,
      req.user.id,
    );
    const shipment = await createShipment(client, { ticketId: ticket.id });
    return { ...ticket, shipments: [shipment] };
  });

  res.status(201).json(created);
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
