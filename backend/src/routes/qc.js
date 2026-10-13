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
const multer = require('multer');
const { query, withTransaction } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const storage = require('../storage');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

// Multipart parsing for QC photos (local storage driver only — GCS uploads go
// browser -> bucket via a signed URL and never touch Express). Same limits and
// MIME allow-list as the ticket Photos feature (routes/attachments.js).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadBytes, files: 10 },
});

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

// The three marks a reviewer can put on a checklist item or a completed task:
// pass (checkbox), fail (X), na (the "/" box — not applicable). null means
// "not reviewed", and is what clearing a mark sets, so every mark is
// changeable after it's set.
const MARK_STATUSES = ['pass', 'fail', 'na'];

/**
 * A fail can carry a technician's explanation. Returns { provided, value }:
 * `provided` is false when the request didn't mention a comment at all (leave
 * whatever is stored alone); blank text normalizes to null (clear it). Only
 * valid alongside a 'fail' — an explanation on a pass or N/A has no meaning.
 */
function parseComment(body, status) {
  if (!Object.prototype.hasOwnProperty.call(body, 'comment')) return { provided: false, value: null };
  if (status !== 'fail') throw badRequest('comment can only be set on a fail');
  const text = body.comment === null ? '' : String(body.comment).trim();
  if (text.length > 2000) throw badRequest('comment must be 2000 characters or fewer');
  return { provided: true, value: text || null };
}

/** Normalize an incoming mark. Missing/blank/null all mean "clear it". */
function parseMark(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!MARK_STATUSES.includes(value)) {
    throw badRequest(`status must be one of: ${MARK_STATUSES.join(', ')} (or null to clear)`);
  }
  return value;
}

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
  // Cosmetics) so the checklist can group by it. Migration 067 replaced the
  // boolean `checked` with a three-way `status` (pass/fail/na, null until
  // reviewed) — see PUT /checks/:id/items/:index below.
  const results = (template ? template.items : []).map((i) => ({
    label: i.label, note: i.note || null, category: i.category || null, status: null,
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

  // The checklist UI no longer sends `results` (it uses the per-item route
  // below, which can't clobber another tech's marks), but a full
  // replacement is still accepted — validated so a bad payload can't store
  // a status the UI doesn't know how to draw.
  if (b.results !== undefined) {
    if (!Array.isArray(b.results)) throw badRequest('results must be an array');
    b.results.forEach((r) => parseMark(r && r.status));
  }

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

/**
 * Mark one checklist item pass / fail / N/A, or clear it (status: null).
 * Its own route, and a single atomic jsonb_set, rather than the generic
 * PATCH's whole-array replacement: two techs marking different items on the
 * same round at the same time can't overwrite each other's marks. Open to
 * anyone still working the round — marking what you checked is not a
 * sign-off. Locked once the round is signed off, like notes.
 */
router.put('/checks/:id/items/:index', asyncHandler(async (req, res) => {
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    throw badRequest('status is required (pass, fail, na, or null to clear)');
  }
  const status = parseMark(req.body.status);
  const comment = parseComment(req.body, status);
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) throw badRequest('Invalid item index');

  const { rows: existing } = await query(
    'SELECT signed_off_at, jsonb_array_length(results) AS item_count FROM qc_checks WHERE id = $1',
    [req.params.id],
  );
  if (!existing[0]) throw notFound('QC check not found');
  if (existing[0].signed_off_at) throw badRequest('This QC round is already signed off');
  if (index >= existing[0].item_count) throw notFound('No such checklist item');

  // $2 (int) and $3 (text) are the same index on purpose: Postgres won't let
  // one parameter be deduced as both types. The comment key is only touched
  // when the request actually carried one ($6), so re-marking an item never
  // wipes an explanation that was already typed.
  const { rows } = await query(
    `UPDATE qc_checks
        SET results = jsonb_set(
              results, ARRAY[$3::text],
              (results -> $2::int)
                || jsonb_build_object(
                     'status', $4::text, 'status_by', $5::int, 'status_at', now())
                || CASE WHEN $6::boolean
                        THEN jsonb_build_object('comment', $7::text)
                        ELSE '{}'::jsonb END)
      WHERE id = $1 AND signed_off_at IS NULL
      RETURNING results`,
    [req.params.id, index, String(index), status, req.user.id, comment.provided, comment.value],
  );
  if (!rows[0]) throw badRequest('This QC round is already signed off');
  res.json({ index, item: rows[0].results[index] });
}));

/**
 * Review a completed task within a QC round — same three marks as the
 * checklist. One row per (round, task); clearing the mark deletes it.
 * Only tasks that are actually done can be reviewed, and only ones that
 * belong to this round's ticket.
 */
router.put('/checks/:id/task-reviews/:taskId', asyncHandler(async (req, res) => {
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    throw badRequest('status is required (pass, fail, na, or null to clear)');
  }
  const status = parseMark(req.body.status);
  const comment = parseComment(req.body, status);

  const { rows: checkRows } = await query(
    'SELECT id, ticket_id, signed_off_at FROM qc_checks WHERE id = $1', [req.params.id],
  );
  const check = checkRows[0];
  if (!check) throw notFound('QC check not found');
  if (check.signed_off_at) throw badRequest('This QC round is already signed off');

  const { rows: taskRows } = await query(
    'SELECT id, ticket_id, done FROM ticket_tasks WHERE id = $1', [req.params.taskId],
  );
  const task = taskRows[0];
  if (!task || task.ticket_id !== check.ticket_id) throw notFound('Task not found on this ticket');

  if (status === null) {
    await query(
      'DELETE FROM qc_task_reviews WHERE qc_check_id = $1 AND ticket_task_id = $2',
      [check.id, task.id],
    );
    return res.json({ qc_check_id: check.id, ticket_task_id: task.id, status: null });
  }
  if (!task.done) throw badRequest('Only completed tasks can be reviewed');

  const { rows } = await query(
    `INSERT INTO qc_task_reviews (qc_check_id, ticket_task_id, status, reviewed_by, reviewed_at, comment)
     VALUES ($1, $2, $3, $4, now(), $6)
     ON CONFLICT (qc_check_id, ticket_task_id)
     DO UPDATE SET status = EXCLUDED.status, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(),
                   comment = CASE WHEN $5::boolean THEN EXCLUDED.comment ELSE qc_task_reviews.comment END
     RETURNING *`,
    [check.id, task.id, status, req.user.id, comment.provided, comment.value],
  );
  return res.json(rows[0]);
}));

// --- QC photos --------------------------------------------------------------
// Photos attached to a QC *round*, kept apart from the ticket's general Photos
// gallery (routes/attachments.js, ticket_attachments). Same two upload paths
// and the same storage driver as that feature — direct-to-bucket for GCS,
// multipart for the local driver — the frontend picks from
// GET /api/attachments/capabilities. The rows live in qc_attachments and
// objects are keyed under tickets/<id>/qc/ so they're easy to tell apart in
// the bucket. Adding/removing is locked once the round is signed off, like
// everything else on a closed round.

const assertMime = (mime) => {
  if (!config.storage.allowedMimeTypes.includes(mime)) {
    throw badRequest(`Unsupported file type: ${mime}`);
  }
};

/** Load an open QC round for a photo write, or fail with the right error. */
async function openCheckOr404(id) {
  const { rows } = await query(
    'SELECT id, ticket_id, signed_off_at FROM qc_checks WHERE id = $1', [id],
  );
  if (!rows[0]) throw notFound('QC check not found');
  if (rows[0].signed_off_at) throw badRequest('This QC round is already signed off');
  return rows[0];
}

const qcKey = (ticketId, fileName) => storage.buildKey(`${ticketId}/qc`, fileName);

router.get('/checks/:id/attachments', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, e.name AS uploader_name FROM qc_attachments a
       LEFT JOIN employees e ON e.id = a.uploader_id
      WHERE a.qc_check_id = $1 ORDER BY a.uploaded_at`,
    [req.params.id],
  );
  res.json(rows);
}));

router.post('/checks/:id/attachments/upload-url', asyncHandler(async (req, res) => {
  if (!storage.supportsDirectUpload) {
    throw badRequest(`Storage driver '${storage.name}' does not support direct upload`);
  }
  const { file_name: fileName, content_type: contentType } = req.body || {};
  if (!contentType) throw badRequest('content_type is required');
  assertMime(contentType);
  const check = await openCheckOr404(req.params.id);

  const key = qcKey(check.ticket_id, fileName);
  const target = await storage.createUploadUrl({ key, contentType });
  res.json({ storage_key: key, ...target });
}));

router.post('/checks/:id/attachments/confirm', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.storage_key) throw badRequest('storage_key is required');
  const check = await openCheckOr404(req.params.id);
  // The key must be one this route could have issued, so a caller can't
  // register some other ticket's object as a QC photo.
  if (!String(b.storage_key).startsWith(`tickets/${check.ticket_id}/qc/`)) {
    throw badRequest('storage_key does not belong to this QC round');
  }

  let size = b.size_bytes || null;
  if (storage.statObject) {
    const stat = await storage.statObject(b.storage_key);
    if (!stat) throw badRequest('Upload was not found in storage — it may have failed');
    size = stat.size;
  }

  const { rows } = await query(
    `INSERT INTO qc_attachments
       (qc_check_id, ticket_id, uploader_id, storage_key, driver, file_name, content_type, size_bytes, caption)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [check.id, check.ticket_id, req.user.id, b.storage_key, storage.name,
      b.file_name || null, b.content_type || null, size, b.caption || null],
  );
  res.status(201).json(rows[0]);
}));

router.post('/checks/:id/attachments', upload.array('files', 10), asyncHandler(async (req, res) => {
  if (!req.files || !req.files.length) throw badRequest('No files were uploaded');
  const check = await openCheckOr404(req.params.id);

  const created = [];
  for (const file of req.files) {
    assertMime(file.mimetype);
    const key = qcKey(check.ticket_id, file.originalname);
    // eslint-disable-next-line no-await-in-loop
    await storage.putObject({ key, buffer: file.buffer, contentType: file.mimetype });
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await query(
      `INSERT INTO qc_attachments
         (qc_check_id, ticket_id, uploader_id, storage_key, driver, file_name, content_type, size_bytes, caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [check.id, check.ticket_id, req.user.id, key, storage.name,
        file.originalname, file.mimetype, file.size, req.body.caption || null],
    );
    created.push(rows[0]);
  }
  res.status(201).json(created);
}));

/** Viewable URL — signed for GCS, the auth-checked /api/attachments/file proxy for local. */
router.get('/attachments/:id/url', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT storage_key FROM qc_attachments WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Attachment not found');
  res.json({ url: await storage.getDownloadUrl(rows[0].storage_key) });
}));

// Captions stay editable on a signed-off round: describing a photo isn't
// changing the record, and "add captions later, or never" is how the ticket
// Photos feature works too.
router.patch('/attachments/:id', asyncHandler(async (req, res) => {
  const caption = req.body?.caption;
  if (caption === undefined) throw badRequest('caption is required');
  const { rows } = await query(
    'UPDATE qc_attachments SET caption = $2 WHERE id = $1 RETURNING *',
    [req.params.id, caption === '' ? null : String(caption).slice(0, 500)],
  );
  if (!rows[0]) throw notFound('Attachment not found');
  res.json(rows[0]);
}));

router.delete('/attachments/:id', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, q.signed_off_at FROM qc_attachments a
       JOIN qc_checks q ON q.id = a.qc_check_id WHERE a.id = $1`,
    [req.params.id],
  );
  const att = rows[0];
  if (!att) throw notFound('Attachment not found');
  if (att.signed_off_at) throw badRequest('This QC round is already signed off');
  if (req.user.role !== 'admin' && att.uploader_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own uploads' });
  }
  await storage.deleteObject(att.storage_key);
  await query('DELETE FROM qc_attachments WHERE id = $1', [att.id]);
  return res.json({ deleted: true });
}));

module.exports = router;
