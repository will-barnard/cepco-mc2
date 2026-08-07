'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');

const ROLE_RANK = { junior: 1, senior: 2, admin: 3 };

function signToken(employee) {
  return jwt.sign(
    { sub: employee.id, email: employee.email, role: employee.role, name: employee.name },
    config.jwtSecret,
    { expiresIn: config.jwtTtlSeconds },
  );
}

function readToken(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (req.cookies && req.cookies.cepco_token) return req.cookies.cepco_token;
  return null;
}

/** Requires a valid token and a still-active employee record. */
async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // Re-read the employee so a deactivated or role-changed account takes effect
  // immediately rather than at token expiry.
  const { rows } = await query(
    'SELECT id, name, email, role, initials, active FROM employees WHERE id = $1',
    [payload.sub],
  );
  const employee = rows[0];
  if (!employee || !employee.active) {
    return res.status(401).json({ error: 'Account is inactive' });
  }

  req.user = employee;
  return next();
}

/** Requires at least the given role rank. */
function requireRole(...roles) {
  const minRank = Math.min(...roles.map((r) => ROLE_RANK[r] || 99));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if ((ROLE_RANK[req.user.role] || 0) < minRank) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    return next();
  };
}

const requireAdmin = requireRole('admin');

module.exports = { signToken, requireAuth, requireRole, requireAdmin, ROLE_RANK };
