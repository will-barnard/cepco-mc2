'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../middleware/errors');
const config = require('../config');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('Email and password are required');

  const { rows } = await query(
    'SELECT * FROM employees WHERE lower(email) = lower($1)',
    [String(email).trim()],
  );
  const employee = rows[0];

  // Same response for unknown email and wrong password — don't leak which
  // addresses have accounts.
  const ok = employee && employee.active
    && await bcrypt.compare(password, employee.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const token = signToken(employee);
  res.cookie('cepco_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: config.jwtTtlSeconds * 1000,
  });

  return res.json({
    token,
    user: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      initials: employee.initials,
    },
  });
}));

router.post('/logout', (req, res) => {
  res.clearCookie('cepco_token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { current_password: currentPassword, new_password: newPassword } = req.body || {};
  if (!currentPassword || !newPassword) throw badRequest('Current and new password are required');
  if (String(newPassword).length < 10) {
    throw badRequest('New password must be at least 10 characters');
  }

  const { rows } = await query('SELECT password_hash FROM employees WHERE id = $1', [req.user.id]);
  const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE employees SET password_hash = $2 WHERE id = $1', [req.user.id, hash]);
  return res.json({ ok: true });
}));

module.exports = router;
