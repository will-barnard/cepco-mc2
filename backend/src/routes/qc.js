'use strict';

/**
 * QC (PLAN §6).
 *
 * Phase 1 is single-tier, single-round sign-off. The schema and this route are
 * already shaped for Phase 2's two-tier / two-person / two-round requirement:
 *   - round_number exists and increments
 *   - the qc_tier settings row carries meta.required_rounds
 *   - canPass() enforces required_rounds and distinct reviewers
 * Phase 2 raises required_rounds to 2 in settings; no code change needed.
 */

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const settings = require('../services/settings');

const router = express.Router();
router.use(requireAuth);

// --- templates -------------------------------------------------------------
// `include_inactive=true` is for the Settings -> QC templates admin screen,
// which needs to see (and reactivate) retired templates. Every other caller
// (TicketQc.vue's round-start dropdown) omits it and keeps getting only the
// active rows it always got.
router.get('/templates', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.include_inactive !== 'true') clauses.push('active = TRUE');
  if (req.query.family) {
    params.push(req.query.family);
    clauses.push(`(family = $${params.length} OR family IS NULL)`);
  }
  if (req.query.kind) { params.push(req.query.kind); clauses.push(`kind = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM qc_templates ${where} ORDER BY family NULLS LAST, name`,
    params,
  );
  res.json(rows);
}));

router.post('/templates', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) throw badRequest('name is required');
  if (!b.tier_key) throw badRequest('tier_key is required');
  await settings.resolve('qc_tier', b.tier_key);
  const { rows } = await query(
    `INSERT INTO qc_templates (name, family, tier_key, kind, items)
     VALUES ($1,$2,$3,COALESCE($4,'qc'),COALESCE($5,'[]'::jsonb)) RETURNING *`,
    [b.name, b.family || null, b.tier_key, b.kind, JSON.stringify(b.items || [])],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/templates/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE qc_templates SET
       name = COALESCE($2, name), family = COALESCE($3, family),
       tier_key = COALESCE($4, tier_key), kind = COALESCE($5, kind),
       items = COALESCE($6, items), active = COALESCE($7, active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name || null, b.family === undefined ? null : b.family,
      b.tier_key || null, b.kind || null,
      b.items === undefined ? null : JSON.stringify(b.items),
      b.active === undefined ? null : b.active],
  );
  if (!rows[0]) throw notFound('Template not found');
  res.json(rows[0]);
}));

// --- checks ----------------------------------------------------------------

/** Start a QC round on a ticket, snapshotting the template's items. */
router.post('/checks', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id) throw badRequest('ticket_id is required');
  if (!b.tier_key) throw badRequest('tier_key is required');
  await settings.resolveActive('qc_tier', b.tier_key);

  let items = [];
  if (b.template_id) {
    const { rows } = await query('SELECT items FROM qc_templates WHERE id = $1', [b.template_id]);
    if (!rows[0]) throw notFound('QC template not found');
    items = rows[0].items;
  }
  // No per-item checkboxes anymore (per NOTES.md — a plain reference list
  // plus the round-level notes field replaced tracked completion state), so
  // the snapshot just keeps label/note for display.
  const results = items.map((item) => ({ label: item.label, note: item.note || null }));

  const { rows: roundRows } = await query(
    'SELECT COALESCE(max(round_number), 0) + 1 AS next FROM qc_checks WHERE ticket_id = $1',
    [b.ticket_id],
  );

  const { rows } = await query(
    `INSERT INTO qc_checks (ticket_id, template_id, tier_key, round_number, reviewer_id, results)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.ticket_id, b.template_id || null, b.tier_key, roundRows[0].next,
      b.reviewer_id || req.user.id, JSON.stringify(results)],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/checks/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existing } = await query('SELECT * FROM qc_checks WHERE id = $1', [req.params.id]);
  if (!existing[0]) throw notFound('QC check not found');
  if (existing[0].signed_off_at) throw badRequest('This QC round is already signed off');

  const { rows } = await query(
    `UPDATE qc_checks SET
       results = COALESCE($2, results),
       notes   = COALESCE($3, notes),
       reviewer_id = COALESCE($4, reviewer_id)
     WHERE id = $1 RETURNING *`,
    [req.params.id,
      b.results === undefined ? null : JSON.stringify(b.results),
      b.notes === undefined ? null : b.notes,
      b.reviewer_id || null],
  );
  res.json(rows[0]);
}));

/**
 * Sign off a round. Passing the *ticket* additionally requires the tier's
 * required_rounds to be satisfied by distinct reviewers.
 */
router.post('/checks/:id/sign-off', requireRole('senior'), asyncHandler(async (req, res) => {
  const passed = req.body?.passed !== false;

  const result = await withTransaction(async (client) => {
    const { rows: checkRows } = await client.query(
      'SELECT * FROM qc_checks WHERE id = $1 FOR UPDATE', [req.params.id],
    );
    const check = checkRows[0];
    if (!check) throw notFound('QC check not found');
    if (check.signed_off_at) throw badRequest('This QC round is already signed off');

    const { rows: signed } = await client.query(
      `UPDATE qc_checks SET passed = $2, signed_off_at = now(), reviewer_id = $3
        WHERE id = $1 RETURNING *`,
      [req.params.id, passed, req.body?.reviewer_id || req.user.id],
    );

    // Does the ticket now clear QC overall?
    const tier = await settings.resolve('qc_tier', check.tier_key);
    const requiredRounds = Number(tier.meta?.required_rounds) || 1;
    const requireDistinct = tier.meta?.require_distinct_reviewers === true;

    const { rows: passedRounds } = await client.query(
      `SELECT reviewer_id FROM qc_checks
        WHERE ticket_id = $1 AND passed = TRUE AND signed_off_at IS NOT NULL`,
      [check.ticket_id],
    );

    const distinctReviewers = new Set(passedRounds.map((r) => r.reviewer_id)).size;
    const roundsOk = passedRounds.length >= requiredRounds;
    const reviewersOk = !requireDistinct || distinctReviewers >= 2;
    const ticketPassed = roundsOk && reviewersOk;

    await client.query(
      'UPDATE tickets SET qc_passed_at = $2 WHERE id = $1',
      [check.ticket_id, ticketPassed ? new Date() : null],
    );

    return {
      check: signed[0],
      ticket_qc_passed: ticketPassed,
      rounds_passed: passedRounds.length,
      rounds_required: requiredRounds,
      distinct_reviewers: distinctReviewers,
      distinct_reviewers_required: requireDistinct ? 2 : 0,
    };
  });

  res.json(result);
}));

module.exports = router;
