'use strict';

/**
 * Ceppys — a fictional, purely-for-fun staff-recognition award (frontend
 * CeppysView.vue). Any signed-in tech can nominate any other tech,
 * including themselves; nominations sit invisible to everyone but their
 * own nominator (GET /nominations/mine) until the weekly digest email goes
 * out (services/ceppys.js / services/ceppyScheduler.js), at which point
 * they become visible to everyone under GET /nominations/past. Nothing
 * here is admin-gated except the schedule/manual-send config itself
 * (POST /send-now) — the schedule's day/time live as an ordinary
 * shop_config settings row, edited through the existing generic
 * PATCH /settings/:id an admin already uses for the labor rate etc., so
 * there's no separate config endpoint to maintain here.
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../middleware/errors');
const settings = require('../services/settings');
const { sendCeppyDigest } = require('../services/ceppys');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// My pending nominations — only the ones *I* submitted that haven't gone
// out in a digest yet. Never another nominator's pending ones; that's the
// whole point of the surprise (see migration 017's comment).
// ---------------------------------------------------------------------------
router.get('/nominations/mine', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, e.name AS nominee_name
       FROM ceppy_nominations n
       JOIN employees e ON e.id = n.nominee_id
      WHERE n.nominator_id = $1 AND n.emailed_at IS NULL
      ORDER BY n.created_at DESC`,
    [req.user.id],
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Past nominations — every nomination that has gone out in a digest,
// newest batch first. Open to anyone signed in; this is the "everyone can
// see it once it's public" half of the state machine.
// ---------------------------------------------------------------------------
router.get('/nominations/past', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const { rows } = await query(
    `SELECT n.*, nom.name AS nominee_name, tor.name AS nominator_name
       FROM ceppy_nominations n
       JOIN employees nom ON nom.id = n.nominee_id
       JOIN employees tor ON tor.id = n.nominator_id
      WHERE n.emailed_at IS NOT NULL
      ORDER BY n.emailed_at DESC, n.created_at DESC
      LIMIT $1`,
    [limit],
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Nominate — self-nomination is allowed on purpose (product decision, not
// an oversight): nobody's barred from putting their own case forward, same
// as nothing else in this app second-guesses who a tech chooses to name.
// ---------------------------------------------------------------------------
router.post('/nominations', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const nomineeId = Number(b.nominee_id);
  if (!Number.isFinite(nomineeId)) throw badRequest('nominee_id is required');
  const title = b.title ? String(b.title).trim() : '';
  if (!title) throw badRequest('title is required');
  const reason = b.reason ? String(b.reason).trim() : '';
  if (!reason) throw badRequest('reason is required');

  // C1: one award category per nomination — either a settings-configured
  // one (Technical Ceppy, Primetime Ceppy, ...) or a one-off typed name,
  // same mutually-exclusive key-or-free-text shape as parts_orders'
  // vendor/vendor_other (P3).
  const categoryOther = b.category_other ? String(b.category_other).trim() : '';
  if (b.category_key && categoryOther) {
    throw badRequest('category_key and category_other are mutually exclusive — pick one');
  }
  let category = null;
  if (b.category_key) {
    category = await settings.resolveActive('ceppy_category', b.category_key);
  } else if (!categoryOther) {
    throw badRequest('category_key or category_other is required');
  }

  const { rows: nomineeRows } = await query(
    'SELECT id FROM employees WHERE id = $1 AND active = TRUE', [nomineeId],
  );
  if (!nomineeRows[0]) throw badRequest('Nominee not found or inactive');

  const { rows } = await query(
    `INSERT INTO ceppy_nominations
       (nominee_id, nominator_id, title, reason, category_key, category_label_snapshot, category_other)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [nomineeId, req.user.id, title, reason,
      category ? category.key : null, category ? category.label : null,
      category ? null : categoryOther],
  );
  res.status(201).json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Manual "Send now" — admin-only. Runs the exact same digest function the
// schedule uses (services/ceppys.js), so there's never a behavioral
// difference between "it fired on its own" and "an admin fired it."
// ---------------------------------------------------------------------------
router.post('/send-now', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const result = await sendCeppyDigest();
    res.json(result);
  } catch (err) {
    throw badRequest(err.message);
  }
}));

module.exports = router;
