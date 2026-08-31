'use strict';

/**
 * Ticket tasks (migration 022, NOTES.md §2.28) — a ticket's short-lived,
 * per-tech work items. Deliberately lighter than every other per-ticket
 * concept it sits next to: no status workflow of its own (just done/not
 * done), no queue position that other queues need to agree with, no hours
 * logging (that stays exactly where it already was — hours_log/routes/
 * hours.js), no reviewer sign-off (that's QC's job, routes/qc.js). A task
 * either snapshots a standard_procedures row it was created from
 * (standard_procedure_id + title) or is free-form (standard_procedure_id
 * NULL, title typed directly) — see the migration for why both exist.
 *
 * Open to any signed-in user, not admin-gated — same reasoning as
 * ticket_technicians assignment and sub-ticket creation (routes/tickets.js,
 * TicketSubTickets.vue): assigning/completing day-to-day work items isn't
 * an admin-only action in this shop.
 */
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const settings = require('../services/settings');

const router = express.Router();
router.use(requireAuth);

const TASK_SELECT = `
  SELECT tk.*,
         t.title AS ticket_title,
         t.status_key, st.label AS status_label,
         t.priority_key, pr.label AS priority_label, pr.sort_order AS priority_sort_order,
         t.archived AS ticket_archived,
         e.name AS technician_name,
         db.name AS done_by_name
    FROM ticket_tasks tk
    JOIN tickets t ON t.id = tk.ticket_id
    LEFT JOIN settings st ON st.category = 'ticket_status' AND st.key = t.status_key
    LEFT JOIN settings pr ON pr.category = 'priority_tier' AND pr.key = t.priority_key
    LEFT JOIN employees e  ON e.id = tk.technician_id
    LEFT JOIN employees db ON db.id = tk.done_by
`;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  const push = (sql, value) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.ticket_id) push('tk.ticket_id = ?', req.query.ticket_id);
  if (req.query.technician_id) push('tk.technician_id = ?', req.query.technician_id);
  if (req.query.done === 'true') clauses.push('tk.done = TRUE');
  else if (req.query.done === 'false') clauses.push('tk.done = FALSE');

  // The tech dashboard's "My tasks" section (DashboardView.vue) asks for
  // this: only tasks belonging to a ticket that's both active (not
  // archived) and currently sitting in a status an admin has flagged as
  // "tasks are live here" (Settings -> Ticket statuses' meta.unlocks_tasks
  // — see migration 022's comment on why this is a flag and not a
  // hardcoded status key). A ticket's own detail page wants the opposite
  // — every task regardless of status, so staff can plan a job's tasks
  // before work starts — so this is opt-in via the query param, not the
  // list's default.
  if (req.query.unlocked_only === 'true') {
    clauses.push("t.archived = FALSE AND COALESCE((st.meta->>'unlocks_tasks')::boolean, FALSE)");
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // Dashboard ordering: whichever ticket has the higher-priority tier
  // (lower sort_order — Daily To-Do before Custom Shop, same convention as
  // every other priority-ordered list) sorts first, tiebroken by this
  // task's own position within its ticket. A single-ticket read (the
  // detail page's `?ticket_id=`) gets the same ORDER BY, which is just
  // "by position" once priority is constant across the result set.
  const { rows } = await query(
    `${TASK_SELECT} ${where} ORDER BY pr.sort_order NULLS LAST, tk.position, tk.id`,
    params,
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Create — either from a catalog procedure (standard_procedure_id) or
// free-form (title only). See migration 022's column comments.
// ---------------------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const {
    ticket_id: ticketId, standard_procedure_id: procedureId, technician_id: technicianId,
  } = req.body || {};
  if (!ticketId) throw badRequest('ticket_id is required');

  const { rows: ticketRows } = await query('SELECT id FROM tickets WHERE id = $1', [ticketId]);
  if (!ticketRows[0]) throw notFound('Ticket not found');

  let title = req.body && req.body.title ? String(req.body.title).trim() : '';
  // N8: a procedure can name the tech level its own work usually calls for
  // (standard_procedures.default_tech_level_key) — a task created from one
  // arrives pre-tagged with it unless the caller explicitly picked a
  // different level for this one instance.
  let procedureDefaultTechLevelKey = null;
  if (procedureId) {
    const { rows: procRows } = await query(
      'SELECT name, default_tech_level_key FROM standard_procedures WHERE id = $1', [procedureId],
    );
    if (!procRows[0]) throw badRequest('Unknown standard_procedure_id');
    // A caller can still supply a custom title alongside a procedure (e.g.
    // "Rhodes tine replacement — bass register only"); otherwise the task
    // snapshots the procedure's name exactly as it reads right now.
    if (!title) title = procRows[0].name;
    procedureDefaultTechLevelKey = procRows[0].default_tech_level_key;
  }
  if (!title) throw badRequest('title is required when standard_procedure_id is not set');

  // N8: tech level lives on the task now, not the ticket (see migration
  // 031) — explicit tech_level_key on the request wins, then the source
  // procedure's default, then nothing (a task with no particular level
  // requirement, same as "any" on the old ticket-level picker).
  const techLevelKey = req.body && req.body.tech_level_key !== undefined
    ? req.body.tech_level_key
    : procedureDefaultTechLevelKey;
  let techLevel = null;
  if (techLevelKey) techLevel = await settings.resolveActive('tech_level', techLevelKey);

  // Back of the line for this ticket — same MAX(...)+10 convention as
  // category_queue_position/family_queue_position (migrations 007/015).
  const { rows: posRows } = await query(
    'SELECT COALESCE(MAX(position), 0) + 10 AS next FROM ticket_tasks WHERE ticket_id = $1',
    [ticketId],
  );

  const { rows: inserted } = await query(
    `INSERT INTO ticket_tasks (
       ticket_id, standard_procedure_id, title, technician_id, position, created_by,
       tech_level_key, tech_level_label_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      ticketId, procedureId || null, title, technicianId || null, posRows[0].next, req.user.id,
      techLevel ? techLevel.key : null, techLevel ? techLevel.label : null,
    ],
  );

  const { rows } = await query(`${TASK_SELECT} WHERE tk.id = $1`, [inserted[0].id]);
  res.status(201).json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Update — assign/unassign, rename, or toggle done. Toggling `done` stamps
// (or clears) done_at/done_by together rather than trusting the client to
// send a consistent triple — same "server derives the timestamp" pattern
// as qc.js's sign-off and tickets.js's archive.
// ---------------------------------------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await query('SELECT * FROM ticket_tasks WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) throw notFound('Task not found');

  const b = req.body || {};
  const title = b.title !== undefined ? String(b.title).trim() : existing.title;
  if (!title) throw badRequest('title cannot be blank');
  const technicianId = b.technician_id !== undefined ? (b.technician_id || null) : existing.technician_id;

  // N8: same "explicit touch, including an explicit clear to null" idiom
  // as tickets.js's PATCH uses for its own settings-backed columns —
  // tech_level_key is only re-resolved when the caller actually mentioned
  // it, so leaving it out of the request never quietly clears a task's
  // tech level.
  let techLevelKey = existing.tech_level_key;
  let techLevelLabel = existing.tech_level_label_snapshot;
  if (b.tech_level_key !== undefined && b.tech_level_key !== existing.tech_level_key) {
    if (b.tech_level_key) {
      const techLevel = await settings.resolveActive('tech_level', b.tech_level_key);
      techLevelKey = techLevel.key;
      techLevelLabel = techLevel.label;
    } else {
      techLevelKey = null;
      techLevelLabel = null;
    }
  }

  let { done, done_at: doneAt, done_by: doneBy } = existing;
  if (b.done !== undefined && Boolean(b.done) !== existing.done) {
    done = Boolean(b.done);
    doneAt = done ? new Date() : null;
    doneBy = done ? req.user.id : null;
  }

  await query(
    `UPDATE ticket_tasks
        SET title = $2, technician_id = $3, done = $4, done_at = $5, done_by = $6,
            tech_level_key = $7, tech_level_label_snapshot = $8
      WHERE id = $1`,
    [req.params.id, title, technicianId, done, doneAt, doneBy, techLevelKey, techLevelLabel],
  );

  const { rows: updated } = await query(`${TASK_SELECT} WHERE tk.id = $1`, [req.params.id]);
  res.json(updated[0]);
}));

// ---------------------------------------------------------------------------
// Delete — e.g. a procedure attached to the wrong ticket by mistake.
// ---------------------------------------------------------------------------
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM ticket_tasks WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Task not found');
  res.json({ deleted: true });
}));

module.exports = router;
