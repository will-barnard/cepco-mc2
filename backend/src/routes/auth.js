'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../middleware/errors');
const config = require('../config');

const router = express.Router();

// Sets the session cookie for both /login and /switch (kiosk identity
// switching). SameSite=None is what lets the cookie survive when MC2 is
// loaded inside a third-party iframe (e.g. embedded in Shopify admin) —
// browsers refuse to send a Lax cookie in that cross-site context, which is
// why login and every subsequent /api call used to 401 there. None without
// Secure is rejected outright by Chrome though, so this only applies when
// we're actually on HTTPS (production); local dev falls back to Lax, which
// is all a same-origin dev server needs. Kiosk mode (/auth/switch) uses this
// same helper and isn't affected either way — None is strictly more
// permissive than Lax, never less, so nothing that worked before stops
// working now.
function setAuthCookie(res, token) {
  const secure = config.env === 'production';
  res.cookie('cepco_token', token, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    maxAge: config.jwtTtlSeconds * 1000,
  });
}

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
  setAuthCookie(res, token);

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

// Kiosk mode (shared shop computer): junior/senior staff switch identities
// with a tap and no credential — the PIN below is only ever checked when the
// *target* of a switch is an admin. Set with your own current password so a
// session left unlocked for a moment can't have its PIN silently replaced.
router.post('/pin', requireAuth, asyncHandler(async (req, res) => {
  const { current_password: currentPassword, pin } = req.body || {};
  if (!currentPassword) throw badRequest('Current password is required');
  if (!/^\d{4}$/.test(String(pin || ''))) throw badRequest('PIN must be exactly 4 digits');

  const { rows } = await query('SELECT password_hash FROM employees WHERE id = $1', [req.user.id]);
  const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(String(pin), 12);
  await query('UPDATE employees SET pin_hash = $2 WHERE id = $1', [req.user.id, hash]);
  return res.json({ ok: true });
}));

// Switch the active identity on this browser without a full re-login. Any
// signed-in session can call this (see NOTES.md — deliberately not scoped to
// "kiosk" devices, since the server has no reliable way to tell those apart
// from a personal laptop). Switching into a non-admin needs nothing further;
// switching into an admin needs that admin's PIN.
router.post('/switch', requireAuth, asyncHandler(async (req, res) => {
  const { employee_id: employeeId, pin } = req.body || {};
  if (!employeeId) throw badRequest('employee_id is required');

  const { rows } = await query('SELECT * FROM employees WHERE id = $1', [employeeId]);
  const target = rows[0];
  if (!target || !target.active) return res.status(400).json({ error: 'Employee is not active' });

  if (target.role === 'admin') {
    if (!target.pin_hash) {
      return res.status(400).json({ error: `${target.name} hasn't set a PIN yet — set one from Account first` });
    }
    const ok = /^\d{4}$/.test(String(pin || '')) && await bcrypt.compare(String(pin), target.pin_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect PIN' });
  }

  const token = signToken(target);
  setAuthCookie(res, token);

  return res.json({
    user: {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role,
      initials: target.initials,
    },
  });
}));

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
