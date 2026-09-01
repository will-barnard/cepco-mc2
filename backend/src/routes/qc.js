'use strict';

/**
 * QC (PLAN §6, migration 021; per-round signoffs reworked for Q6).
 *
 * Rigor tiers are retired: every ticket now follows the same standardized,
 * per-instrument-family round progression, and clearing QC always means
 * the same fixed rule (REQUIRED_ROUNDS below) rather than a per-tier
 * setting. What used to vary by tier now varies by *round*: a family's
 * qc_templates rows each carry a round_number, and a ticket's rounds are
 * always started in that order — round_number is assigned as "one more
 * than however many rounds this ticket already has" (see POST /checks),
 * so there's no way to start round 2 before round 1 exists, and no picker
 * that could get that order wrong.
 *
 * Q6: how many *people* need to sign a given round before it counts as
 * passed is no longer a single ticket-wide rule either — it's per-round,
 * via qc_templates.required_signoffs (migration 035). Setup QC (round 1)
 * still needs just one signature; Final Assembly QC (round 2) needs two
 * distinct techs literally checking the same pass. See qc_check_signoffs
 * below (one row per person per round) — qc_checks.reviewer_id/passed/
 * signed_off_at now mean "this round is fully signed off, and by whom
 * most recently," not "the one person who reviewed it."
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
// stages), but a ticket only ever needs *any* 2 rounds passed — see the
// sign-off route below for how many *people* each round itself needs
// (Q6, qc_templates.required_signoffs).
const REQUIRED_ROUNDS = 2;

// Q4: the boss's chosen "categories of service" grouping — coarser than a
// per-instrument checklist's own item labels, shared across every family/
// template so a tech sees the same four buckets on every round. Not a
// Settings-editable list (unlike ticket_category etc.) — fixed enough,
// and small enough, that a hardcoded list plus a redeploy is the right
// weight for changing it, same as CADENCES in recurringTicketTemplates.js.
const QC_ITEM_CATEGORIES = ['tuning', 'action', 'electronics', 'cosmetics'];

/** Validate items (used by both template POST and PATCH below) — checked
 * here rather than left to whatever renders them later, same "fail loud
 * at the write" posture as every other admin-editable array in this app. */
function validateItems(items) {
  if (!Array.isArray(items)) throw badRequest('items must be an array');
  return items.map((i) => {
    if (i.category !== undefined && i.category !== null && !QC_ITEM_CATEGORIES.includes(i.category)) {
      throw badRequest(`item category must be one of: ${QC_ITEM_CATEGORIES.join(', ')}`);
    }
    return { label: i.label, note: i.note || null, category: i.category || null };
  });
}

// --- templates -------------------------------------------------------------
// `include_inactive=true` is for the Settings -> QC templates admin screen,
// which needs to see (and reactivate) retired templates. Every other caller
// (TicketQc.vue's automatic round-start) omits it and keeps getting only
// the active rows it always got.
// Q4: a tiny fixed lookup, same shape as GET /instruments/families — lets
// the frontend (checklist grouping, the admin item editor) render labels
// without duplicating this list in two places.
router.get('/item-categories', (req, res) => res.json(QC_ITEM_CATEGORIES));

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

// Q6: required_signoffs (how many distinct people must sign this round
// before it's "passed" — see migration 035) shares the same "positive
// integer" validation shape as round_number, just a different floor.
function resolveRequiredSignoffs(value) {
  if (value === undefined || value === null) return null; // caller decides the default (1 on create, unchanged on update)
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest('required_signoffs must be a positive integer');
  return n;
}

router.post('/templates', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) throw badRequest('name is required');
  const roundNumber = b.round_number === undefined || b.round_number === null ? 1 : Number(b.round_number);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw badRequest('round_number must be a positive integer');
  }
  const requiredSignoffs = resolveRequiredSignoffs(b.required_signoffs) || 1;
  const items = validateItems(b.items || []);
  const { rows } = await query(
    `INSERT INTO qc_templates (name, family, kind, round_number, items, required_signoffs)
     VALUES ($1,$2,COALESCE($3,'qc'),$4,$5,$6) RETURNING *`,
    [b.name, b.family || null, b.kind, roundNumber, JSON.stringify(items), requiredSignoffs],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/templates/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.round_number !== undefined && b.round_number !== null) {
    const n = Number(b.round_number);
    if (!Number.isInteger(n) || n < 1) throw badRequest('round_number must be a positive integer');
  }
  const requiredSignoffs = resolveRequiredSignoffs(b.required_signoffs);
  const { rows } = await query(
    `UPDATE qc_templates SET
       name = COALESCE($2, name), family = COALESCE($3, family),
       kind = COALESCE($4, kind), round_number = COALESCE($5, round_number),
       items = COALESCE($6, items), active = COALESCE($7, active),
       required_signoffs = COALESCE($8, required_signoffs)
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name || null, b.family === undefined ? null : b.family,
      b.kind || null, b.round_number === undefined || b.round_number === null ? null : Number(b.round_number),
      b.items === undefined ? null : JSON.stringify(validateItems(b.items)),
      b.active === undefined ? null : b.active,
      requiredSignoffs],
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

  // Q4 supersedes the earlier "reference list only" decision: items now
  // snapshot their template's category (Tuning/Action/Electronics/
  // Cosmetics) so the checklist can group by it, and a `checked` flag a
  // tech can actually persist (PATCH /checks/:id below) — replacing the
  // old client-only "highlight while viewing" Set that reset on reload.
  const results = (template ? template.items : []).map((i) => ({
    label: i.label, note: i.note || null, category: i.category || null, checked: false,
  }));

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
 * Add this reviewer's signature to a round. Q6: a round can require more
 * than one distinct signature (qc_templates.required_signoffs — 1 for a
 * plain round, 2 for one like Final Assembly QC where two techs need to
 * literally check the same pass) before it counts as passed; the round
 * stays open, collecting signatures, until it crosses that threshold. A
 * single failing signoff still closes the round as failed outright,
 * regardless of the threshold — same "one 'no' is enough" behavior the
 * old one-reviewer-per-round model had (there's currently no UI path to
 * this — Q5 replaced "fail the round" with "add a task instead" — kept
 * only for whatever might still call this route directly with
 * passed: false).
 *
 * Passing the *ticket* still requires REQUIRED_ROUNDS rounds each
 * individually passed — the same fixed rule for every ticket regardless
 * of family/category/how many rounds its progression defines. There's no
 * separate ticket-wide distinct-reviewer count layered on top any more:
 * required_signoffs on each round is what now enforces "signed off by
 * enough different people," scoped to the round that actually needs it.
 */
router.post('/checks/:id/sign-off', requireRole('senior'), asyncHandler(async (req, res) => {
  const passed = req.body?.passed !== false;
  const reviewerId = req.body?.reviewer_id || req.user.id;

  const result = await withTransaction(async (client) => {
    const { rows: checkRows } = await client.query(
      'SELECT * FROM qc_checks WHERE id = $1 FOR UPDATE', [req.params.id],
    );
    const check = checkRows[0];
    if (!check) throw notFound('QC check not found');
    if (check.signed_off_at) throw badRequest('This QC round is already signed off');

    const { rows: templateRows } = await client.query(
      'SELECT required_signoffs FROM qc_templates WHERE id = $1', [check.template_id],
    );
    // No template (a family/round with nothing set up yet) behaves exactly
    // like today: one signature closes it.
    const requiredSignoffs = templateRows[0]?.required_signoffs || 1;

    await client.query(
      `INSERT INTO qc_check_signoffs (qc_check_id, reviewer_id, passed, signed_off_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (qc_check_id, reviewer_id)
       DO UPDATE SET passed = EXCLUDED.passed, signed_off_at = now()`,
      [check.id, reviewerId, passed],
    );

    const { rows: signoffRows } = await client.query(
      'SELECT passed FROM qc_check_signoffs WHERE qc_check_id = $1', [check.id],
    );
    const passingCount = signoffRows.filter((s) => s.passed).length;

    let closeAs = null;
    if (!passed) closeAs = false;
    else if (passingCount >= requiredSignoffs) closeAs = true;

    let signedCheck = check;
    if (closeAs !== null) {
      const { rows: closedRows } = await client.query(
        `UPDATE qc_checks SET passed = $2, signed_off_at = now(), reviewer_id = $3
          WHERE id = $1 RETURNING *`,
        [check.id, closeAs, reviewerId],
      );
      signedCheck = closedRows[0];
    }

    const { rows: passedRounds } = await client.query(
      `SELECT id FROM qc_checks
        WHERE ticket_id = $1 AND passed = TRUE AND signed_off_at IS NOT NULL`,
      [check.ticket_id],
    );
    const ticketPassed = passedRounds.length >= REQUIRED_ROUNDS;

    await client.query(
      'UPDATE tickets SET qc_passed_at = $2 WHERE id = $1',
      [check.ticket_id, ticketPassed ? new Date() : null],
    );

    return {
      check: signedCheck,
      round_closed: closeAs !== null,
      signoffs_recorded: passingCount,
      signoffs_required: requiredSignoffs,
      ticket_qc_passed: ticketPassed,
      rounds_passed: passedRounds.length,
      rounds_required: REQUIRED_ROUNDS,
    };
  });

  res.json(result);
}));

module.exports = router;
