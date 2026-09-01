'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

const ROLES = ['admin', 'senior', 'junior'];

// Everyone can see the staff list (needed for assignment dropdowns); only
// admins see anything beyond name/role/initials.
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, email, role, initials, active, excluded_from_chore_rotation, created_at
       FROM employees ORDER BY active DESC, name`,
  );
  res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const {
    name, email, password, role, initials,
  } = req.body || {};
  if (!name || !email || !password) throw badRequest('name, email and password are required');
  if (!ROLES.includes(role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}`);
  if (String(password).length < 10) throw badRequest('Password must be at least 10 characters');

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await query(
    `INSERT INTO employees (name, email, password_hash, role, initials)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, role, initials, active, created_at`,
    [String(name).trim(), String(email).trim().toLowerCase(), hash, role, initials || null],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const {
    name, email, role, initials, active, password, pin, excluded_from_chore_rotation: excludedFromChoreRotation,
  } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) {
    throw badRequest(`role must be one of: ${ROLES.join(', ')}`);
  }
  // Recovery path for a forgotten kiosk-switch PIN — same shape as the
  // password reset below.
  if (pin !== undefined && pin !== null && !/^\d{4}$/.test(String(pin))) {
    throw badRequest('PIN must be exactly 4 digits');
  }

  // Guard against locking the shop out of its own admin panel.
  if ((active === false || (role && role !== 'admin')) && Number(req.params.id) === req.user.id) {
    throw badRequest('You cannot deactivate or demote your own account');
  }

  let hash = null;
  if (password) {
    if (String(password).length < 10) throw badRequest('Password must be at least 10 characters');
    hash = await bcrypt.hash(password, 12);
  }

  let pinHash;
  if (pin === null) {
    pinHash = null; // explicit clear
  } else if (pin !== undefined) {
    pinHash = await bcrypt.hash(String(pin), 12);
  }

  const { rows } = await query(
    `UPDATE employees SET
        name                         = COALESCE($2, name),
        email                        = COALESCE($3, email),
        role                         = COALESCE($4, role),
        initials                     = COALESCE($5, initials),
        active                       = COALESCE($6, active),
        password_hash                = COALESCE($7, password_hash),
        pin_hash                     = CASE WHEN $8 THEN $9 ELSE pin_hash END,
        excluded_from_chore_rotation = COALESCE($10, excluded_from_chore_rotation)
      WHERE id = $1
      RETURNING id, name, email, role, initials, active, excluded_from_chore_rotation, created_at`,
    [
      req.params.id,
      name === undefined ? null : String(name).trim(),
      email === undefined ? null : String(email).trim().toLowerCase(),
      role === undefined ? null : role,
      initials === undefined ? null : initials,
      active === undefined ? null : active,
      hash,
      pinHash !== undefined,
      pinHash === undefined ? null : pinHash,
      excludedFromChoreRotation === undefined ? null : excludedFromChoreRotation,
    ],
  );
  if (!rows[0]) throw notFound('Employee not found');
  res.json(rows[0]);
}));

module.exports = router;
