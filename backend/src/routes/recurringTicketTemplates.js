'use strict';

/**
 * Recurring ticket templates (Settings -> Recurring tickets, A1/A2 on the
 * boss list). Admin-editable config for services/recurringTickets.js's
 * scheduler — the four daily tickets (AM/PM Inbox Clearing, AM/PM Online
 * Orders) and the four weekly chore rotations (bathroom/floor/showroom/
 * kitchen) all live as rows here, same "config in a table, not in code"
 * shape as qc_templates/standard_procedures.
 */

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const settings = require('../services/settings');
const { nextRotationEmployee } = require('../services/recurringTickets');

const router = express.Router();
router.use(requireAuth);

const CADENCES = ['daily', 'weekly'];

/** Shared validation for create/update — throws rather than letting a bad
 * value surface as a raw DB constraint error or silently misfire later. */
async function resolveTemplateFields(b, existing) {
  const cadence = b.cadence ?? existing?.cadence;
  if (!CADENCES.includes(cadence)) throw badRequest(`cadence must be one of: ${CADENCES.join(', ')}`);

  const dayOfWeek = b.day_of_week === undefined ? existing?.day_of_week ?? null : b.day_of_week;
  if (cadence === 'weekly') {
    if (dayOfWeek === null || dayOfWeek === undefined
      || !Number.isInteger(Number(dayOfWeek)) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw badRequest('day_of_week (0=Sunday..6=Saturday) is required for a weekly template');
    }
  }

  const timeOfDay = b.time_of_day ?? existing?.time_of_day;
  if (!timeOfDay || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)) {
    throw badRequest("time_of_day must be 'HH:MM' (24-hour, shop-local)");
  }

  const categoryKey = b.category_key ?? existing?.category_key;
  const priorityKey = b.priority_key ?? existing?.priority_key;
  if (!categoryKey) throw badRequest('category_key is required');
  if (!priorityKey) throw badRequest('priority_key is required');
  // Same guard POST /tickets relies on — resolveActive rejects a retired
  // or unknown key up front rather than letting a bad template silently
  // fail every time the scheduler tries to fire it.
  await settings.resolveActive('ticket_category', categoryKey);
  await settings.resolveActive('priority_tier', priorityKey);

  return {
    cadence, day_of_week: cadence === 'weekly' ? Number(dayOfWeek) : null, time_of_day: timeOfDay,
  };
}

/** Validates an optional fixed-assignee employee id. `undefined` means
 * "field not sent, leave whatever's there alone" — callers distinguish
 * that from an explicit null/'' ("clear the pin") themselves, since the
 * right response differs between POST (defaults to null) and PATCH
 * (COALESCE would need a separate touched flag either way). Returns the
 * numeric id, or null for anything falsy. Checked against a live FK
 * lookup rather than letting a bad id surface as a raw constraint
 * violation — same reasoning as resolveTemplateFields' category/priority
 * checks above. */
async function resolveFixedAssignee(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isFinite(id)) throw badRequest('fixed_assignee_employee_id must be a number');
  const { rows } = await query('SELECT id FROM employees WHERE id = $1', [id]);
  if (!rows.length) throw badRequest('fixed_assignee_employee_id does not match an existing employee');
  return id;
}

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, e.name AS rotation_last_employee_name, fa.name AS fixed_assignee_name
       FROM recurring_ticket_templates t
       LEFT JOIN employees e  ON e.id = t.rotation_last_employee_id
       LEFT JOIN employees fa ON fa.id = t.fixed_assignee_employee_id
      ORDER BY t.sort_order, t.id`,
  );
  res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) throw badRequest('title is required');
  const resolved = await resolveTemplateFields(b, null);
  const fixedAssigneeId = await resolveFixedAssignee(b.fixed_assignee_employee_id);

  const { rows: maxRow } = await query(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM recurring_ticket_templates',
  );
  const { rows } = await query(
    `INSERT INTO recurring_ticket_templates
       (title, category_key, priority_key, cadence, day_of_week, time_of_day, notes,
        rotate_among_active_techs, fixed_assignee_employee_id, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      String(b.title).trim(), b.category_key, b.priority_key,
      resolved.cadence, resolved.day_of_week, resolved.time_of_day,
      b.notes || null, b.rotate_among_active_techs === true, fixedAssigneeId, maxRow[0].next,
    ],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await query(
    'SELECT * FROM recurring_ticket_templates WHERE id = $1', [req.params.id],
  );
  const existing = existingRows[0];
  if (!existing) throw notFound('Recurring ticket template not found');

  // Only re-validate cadence/day/time/category/priority when the request
  // actually touches one of them — same "don't re-check what nobody
  // asked to change" shape as procedures.js's pricing block.
  const touchesSchedule = ['cadence', 'day_of_week', 'time_of_day', 'category_key', 'priority_key']
    .some((k) => b[k] !== undefined);
  const resolved = touchesSchedule ? await resolveTemplateFields(b, existing) : null;
  const touchesFixedAssignee = b.fixed_assignee_employee_id !== undefined;
  const fixedAssigneeId = touchesFixedAssignee
    ? await resolveFixedAssignee(b.fixed_assignee_employee_id) : null;

  const { rows } = await query(
    `UPDATE recurring_ticket_templates SET
       title                      = COALESCE($2, title),
       category_key               = COALESCE($3, category_key),
       priority_key               = COALESCE($4, priority_key),
       cadence                    = COALESCE($5, cadence),
       day_of_week                = CASE WHEN $6::boolean THEN $7 ELSE day_of_week END,
       time_of_day                = COALESCE($8, time_of_day),
       notes                      = CASE WHEN $9::boolean THEN $10 ELSE notes END,
       rotate_among_active_techs  = COALESCE($11, rotate_among_active_techs),
       active                     = COALESCE($12, active),
       sort_order                 = COALESCE($13, sort_order),
       fixed_assignee_employee_id = CASE WHEN $14::boolean THEN $15 ELSE fixed_assignee_employee_id END,
       updated_at                 = now()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      b.title === undefined ? null : String(b.title).trim(),
      b.category_key || null,
      b.priority_key || null,
      resolved ? resolved.cadence : null,
      touchesSchedule, resolved ? resolved.day_of_week : null,
      resolved ? resolved.time_of_day : null,
      b.notes !== undefined, b.notes === undefined ? null : b.notes,
      b.rotate_among_active_techs === undefined ? null : b.rotate_among_active_techs,
      b.active === undefined ? null : b.active,
      b.sort_order === undefined ? null : b.sort_order,
      touchesFixedAssignee, fixedAssigneeId,
    ],
  );
  res.json(rows[0]);
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM recurring_ticket_templates WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Recurring ticket template not found');
  res.json({ deleted: true });
}));

/**
 * Re-roll: pick a new random rotation assignee for this template right
 * now, instead of waiting for its next scheduled firing. If this
 * template's most recent still-open ticket is still findable (via the
 * recurring_ticket_template_id link fireTemplate() stamps on it — see
 * migration 053), that ticket's assignee is swapped over too, so this
 * actually fixes today's "this landed on the wrong person" complaint and
 * not just next week's. If there's no such ticket (nothing generated yet
 * this cycle, or it's already been archived), re-roll still moves
 * rotation_last_employee_id, which just changes who's shown as "next up".
 *
 * Uses the exact same nextRotationEmployee() the scheduler itself calls —
 * a re-roll is not a second, looser kind of pick, just an early one.
 */
router.post('/:id/reroll', requireAdmin, asyncHandler(async (req, res) => {
  const outcome = await withTransaction(async (client) => {
    const { rows: lockedRows } = await client.query(
      'SELECT * FROM recurring_ticket_templates WHERE id = $1 FOR UPDATE', [req.params.id],
    );
    const t = lockedRows[0];
    if (!t) throw notFound('Recurring ticket template not found');
    if (!t.rotate_among_active_techs) {
      throw badRequest('Re-roll only applies to templates with "Rotate among active techs" on');
    }
    if (t.fixed_assignee_employee_id) {
      throw badRequest('This template has a fixed assignee pinned — clear the pin to use rotation');
    }

    const employeeId = await nextRotationEmployee(client, t.rotation_last_employee_id);

    const { rows: ticketRows } = await client.query(
      `SELECT id FROM tickets
        WHERE recurring_ticket_template_id = $1 AND archived = FALSE
        ORDER BY created_at DESC LIMIT 1`,
      [t.id],
    );
    const ticket = ticketRows[0] || null;

    if (ticket && employeeId) {
      // Same replace-the-assignment shape as PATCH /tickets/:id's
      // technician_ids handling — drop whoever's on it, put the new pick
      // at the back of their own queue.
      const { rows: currentRows } = await client.query(
        'SELECT employee_id FROM ticket_technicians WHERE ticket_id = $1', [ticket.id],
      );
      const currentIds = currentRows.map((r) => r.employee_id);
      if (currentIds.length) {
        await client.query(
          'DELETE FROM ticket_technicians WHERE ticket_id = $1 AND employee_id = ANY($2::int[])',
          [ticket.id, currentIds],
        );
      }
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
        [ticket.id, employeeId, techRows[0].next, req.user.id],
      );
    }

    await client.query(
      `UPDATE recurring_ticket_templates
          SET rotation_last_employee_id = $2, updated_at = now()
        WHERE id = $1`,
      [t.id, employeeId],
    );

    return { templateId: t.id, rerolledTicketId: ticket ? ticket.id : null };
  });

  const { rows } = await query(
    `SELECT t.*, e.name AS rotation_last_employee_name, fa.name AS fixed_assignee_name
       FROM recurring_ticket_templates t
       LEFT JOIN employees e  ON e.id = t.rotation_last_employee_id
       LEFT JOIN employees fa ON fa.id = t.fixed_assignee_employee_id
      WHERE t.id = $1`,
    [outcome.templateId],
  );
  res.json({ ...rows[0], rerolled_ticket_id: outcome.rerolledTicketId });
}));

module.exports = router;
