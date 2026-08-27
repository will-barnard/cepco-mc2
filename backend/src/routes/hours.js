'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

/** Hours across tickets — the timesheet view. */
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  const push = (sql, v) => { params.push(v); clauses.push(sql.replace('?', `$${params.length}`)); };

  // Techs see only their own hours; admins see everyone's.
  if (req.user.role === 'admin' && req.query.employee_id) push('h.employee_id = ?', req.query.employee_id);
  else if (req.user.role !== 'admin') push('h.employee_id = ?', req.user.id);

  if (req.query.ticket_id) push('h.ticket_id = ?', req.query.ticket_id);
  if (req.query.from) push('h.worked_on >= ?', req.query.from);
  if (req.query.to) push('h.worked_on <= ?', req.query.to);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT h.*, e.name AS employee_name, t.title AS ticket_title
       FROM hours_log h
       JOIN employees e ON e.id = h.employee_id
       JOIN tickets   t ON t.id = h.ticket_id
       ${where} ORDER BY h.worked_on DESC, h.logged_at DESC LIMIT 1000`,
    params,
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id) throw badRequest('ticket_id is required');
  const hours = Number(b.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw badRequest('hours must be a positive number');
  if (hours > 24) throw badRequest('hours must be 24 or less for a single entry');

  // A tech can only log against themselves; an admin may log on behalf of staff.
  const employeeId = (req.user.role === 'admin' && b.employee_id) ? b.employee_id : req.user.id;

  const { rows } = await query(
    `INSERT INTO hours_log (ticket_id, employee_id, hours, task_description, worked_on)
     VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE)) RETURNING *`,
    [b.ticket_id, employeeId, hours, b.task_description || null, b.worked_on || null],
  );
  res.status(201).json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM hours_log WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Hours entry not found');
  if (req.user.role !== 'admin' && rows[0].employee_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own hours' });
  }
  await query('DELETE FROM hours_log WHERE id = $1', [req.params.id]);
  return res.json({ deleted: true });
}));

/** Per-tech workload rollup, admin only. */
router.get('/by-employee', asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { rows } = await query(`
    SELECT e.id, e.name, e.role,
           COALESCE(sum(h.hours) FILTER (WHERE h.worked_on >= date_trunc('week', CURRENT_DATE)), 0)
             AS hours_this_week,
           COALESCE(sum(h.hours) FILTER (WHERE h.worked_on >= date_trunc('month', CURRENT_DATE)), 0)
             AS hours_this_month,
           COALESCE(sum(h.hours), 0) AS hours_total,
           (SELECT count(*)::int FROM ticket_technicians tt
             JOIN tickets t ON t.id = tt.ticket_id
             WHERE tt.employee_id = e.id AND t.archived = FALSE) AS open_tickets
      FROM employees e
      LEFT JOIN hours_log h ON h.employee_id = e.id
     WHERE e.active = TRUE
     GROUP BY e.id ORDER BY e.name
  `);
  return res.json(rows);
}));

module.exports = router;
