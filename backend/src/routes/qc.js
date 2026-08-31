'use strict';

/**
 * QC (PLAN §6, migration 021).
 *
 * Rigor tiers are retired: every ticket now follows the same standardized,
 * per-instrument-family round progression, and clearing QC always means
 * the same fixed rule (REQUIRED_ROUNDS / REQUIRE_DISTINCT_REVIEWERS below)
 * rather than a per-tier setting. What used to vary by tier now varies by
 * *round*: a family's qc_templates rows each carry a round_number, and a
 * ticket's rounds are always started in that order — round_number is
 * assigned as "one more than however many rounds this ticket already
 * has" (see POST /checks), so there's no way to start round 2 before
 * round 1 exists, and no picker that could get that order wrong.
 */

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

// The fixed rule every ticket's QC is judged against, replacing what used
// to be per-tier settings (qc_tier.meta.required_rounds /
// require_distinct_reviewers). A family is free to define more than 2
// rounds in its progression (extra rounds are just additional, optional
// stages), but a ticket only ever needs *any* 2 passing rounds signed off
// by 2 different people to clear QC — see the sign-off route below.
const REQUIRED_ROUNDS = 2;
const REQUIRE_DISTINCT_REVIEWERS = true;

// --- templates -------------------------------------------------------------
// `include_inactive=true` is for the Settings -> QC templates admin screen,
// which needs to see (and reactivate) retired templates. Every other caller
// (TicketQc.vue's automatic round-start) omits it and keeps getting only
// the active rows it always got.
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
    `SELECT * FROM qc_templates ${where} ORDER BY family NULLS LAST, round_number, name`,
    params,
  );
  res.json(rows);
}));

router.post('/templates', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) throw badRequest('name is required');
  const roundNumber = b.round_number === undefined || b.round_number === null ? 1 : Number(b.round_number);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw badRequest('round_number must be a positive integer');
  }
  const { rows } = await query(
    `INSERT INTO qc_templates (name, family, kind, round_number, items)
     VALUES ($1,$2,COALESCE($3,'qc'),$4,COALESCE($5,'[]'::jsonb)) RETURNING *`,
    [b.name, b.family || null, b.kind, roundNumber, JSON.stringify(b.items || [])],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/templates/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.round_number !== undefined && b.round_number !== null) {
    const n = Number(b.round_number);
    if (!Number.isInteger(n) || n < 1) throw badRequest('round_number must be a positive integer');
  }
  const { rows } = await query(
    `UPDATE qc_templates SET
       name = COALESCE($2, name), family = COALESCE($3, family),
       kind = COALESCE($4, kind), round_number = COALESCE($5, round_number),
       items = COALESCE($6, items), active = COALESCE($7, active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name || null, b.family === undefined ? null : b.family,
      b.kind || null, b.round_number === undefined || b.round_number === null ? null : Number(b.round_number),
      b.items === undefined ? null : JSON.stringify(b.items),
      b.active === undefined ? null : b.active],
  );
  if (!rows[0]) throw notFound('Template not found');
  res.json(rows[0]);
}));

// --- checks ----------------------------------------------------------------

/**
 * Start the next QC round on a ticket. Always the next one in sequence —
 * this ticket's current round count plus one — and always the template
 * standardized for that round on this ticket's instrument family (falling
 * back to the family-agnostic template for that round, same precedence as
 * GET /templates). No round to jump to out of order, and nothing to pick:
 * that's the whole point of a standardized progression. A family that
 * hasn't had a template written yet for this round number just starts the
 * round blank — same graceful degradation as always; an admin can fill it
 * in later from Settings -> QC templates without disturbing the round
 * that's already open.
 */
router.post('/checks', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id) throw badRequest('ticket_id is required');

  const { rows: ticketRows } = await query(
    `SELECT t.id, i.family AS instrument_family
       FROM tickets t LEFT JOIN instruments i ON i.id = t.instrument_id
      WHERE t.id = $1`,
    [b.ticket_id],
  );
  const ticket = ticketRows[0];
  if (!ticket) throw notFound('Ticket not found');

  const { rows: roundRows } = await query(
    'SELECT COALESCE(max(round_number), 0) + 1 AS next FROM qc_checks WHERE ticket_id = $1',
    [b.ticket_id],
  );
  const roundNumber = roundRows[0].next;

  const { rows: templateRows } = await query(
    `SELECT * FROM qc_templates
      WHERE kind = 'qc' AND active = TRUE AND round_number = $1
        AND (family = $2 OR family IS NULL)
      ORDER BY family NULLS LAST LIMIT 1`,
    [roundNumber, ticket.instrument_family || null],
  );
  const template = templateRows[0] || null;

  // No per-item checkboxes (per NOTES.md — a plain reference list plus the
  // round-level notes field replaced tracked completion state), so the
  // snapshot just keeps label/note for display.
  const results = (template ? template.items : []).map((i) => ({ label: i.label, note: i.note || null }));

  const { rows } = await query(
    `INSERT INTO qc_checks (ticket_id, template_id, round_number, reviewer_id, results)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.ticket_id, template ? template.id : null, roundNumber, b.reviewer_id || req.user.id, JSON.stringify(results)],
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
 * Sign off a round. Passing the *ticket* additionally requires
 * REQUIRED_ROUNDS passing rounds signed off by REQUIRE_DISTINCT_REVIEWERS
 * distinct reviewers — the same fixed rule for every ticket, regardless of
 * family, category, or how many rounds its progression happens to define.
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

    const { rows: passedRounds } = await client.query(
      `SELECT reviewer_id FROM qc_checks
        WHERE ticket_id = $1 AND passed = TRUE AND signed_off_at IS NOT NULL`,
      [check.ticket_id],
    );

    const distinctReviewers = new Set(passedRounds.map((r) => r.reviewer_id)).size;
    const roundsOk = passedRounds.length >= REQUIRED_ROUNDS;
    const reviewersOk = !REQUIRE_DISTINCT_REVIEWERS || distinctReviewers >= 2;
    const ticketPassed = roundsOk && reviewersOk;

    await client.query(
      'UPDATE tickets SET qc_passed_at = $2 WHERE id = $1',
      [check.ticket_id, ticketPassed ? new Date() : null],
    );

    return {
      check: signed[0],
      ticket_qc_passed: ticketPassed,
      rounds_passed: passedRounds.length,
      rounds_required: REQUIRED_ROUNDS,
      distinct_reviewers: distinctReviewers,
      distinct_reviewers_required: REQUIRE_DISTINCT_REVIEWERS ? 2 : 0,
    };
  });

  res.json(result);
}));

module.exports = router;
