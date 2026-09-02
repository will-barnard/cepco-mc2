'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

// Instrument taxonomy (PLAN §5), extended per SHOWROOM QC. 'amp' and
// 'rarity' were consolidated into a single 'other' family (see migration
// 037 and NOTES.md) — the shop didn't have enough of either to justify
// separate buckets, and "amp" vs. "rarity" was a fairly arbitrary split to
// begin with (see importCsv.js's old classifier, which just fell through
// to whichever wasn't clearly an amp). Existing rows carrying the old keys
// are reassigned to 'other' by that migration in every table that stores
// a family (instruments, qc_templates, standard_procedures,
// instrument_default_technicians, instrument_models) — there's nothing
// left anywhere in the schema still writing 'amp' or 'rarity'.
const FAMILIES = ['rhodes', 'wurlitzer', 'hohner', 'strings', 'organ', 'other'];

router.get('/families', (req, res) => res.json(FAMILIES));

// N7 (boss-list scope, scaffold): a few of these family keys read fine as
// raw strings in a <select> ("rhodes", "wurlitzer") but the rest don't
// ("strings" and "other" are internal shorthand, not what a customer or
// even a tech would call the category out loud). Additive only — the
// existing /families endpoint above keeps its plain-string-array shape so
// none of its ~11 existing frontend consumers (`v-for="f in
// refData.families"` etc.) need to change; this is a second, optional
// lookup for screens that want a nicer label instead.
const FAMILY_LABELS = {
  rhodes: 'Rhodes',
  wurlitzer: 'Wurlitzer',
  hohner: 'Hohner',
  strings: 'Electric String Pianos',
  organ: 'Combo Organ',
  other: 'Other',
};

router.get('/family-labels', (req, res) => res.json(FAMILY_LABELS));

// ---------------------------------------------------------------------------
// Default technicians per instrument family (migration 014). Registered
// ahead of GET/PATCH '/:id' below, same reasoning as '/families' above —
// these are literal sub-paths, not an instrument id, and Express matches
// route registration order.
// ---------------------------------------------------------------------------

// Every family gets a (possibly empty) entry, not just the ones an admin
// has actually configured — callers (this route's own consumers: the
// Default instrument assignments page, and TicketNewView's auto-fill)
// shouldn't have to know FAMILIES themselves just to render "no defaults
// set yet" for the rest.
router.get('/default-technicians', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT family, employee_id FROM instrument_default_technicians ORDER BY family',
  );
  const byFamily = Object.fromEntries(FAMILIES.map((f) => [f, []]));
  for (const row of rows) {
    if (!byFamily[row.family]) byFamily[row.family] = [];
    byFamily[row.family].push(row.employee_id);
  }
  res.json(byFamily);
}));

// Replaces the full default set for one family — same "here's the whole
// list now" contract as PATCH /tickets/:id's technician_ids, just without
// needing a diff (there's no per-row state like queue_position to preserve
// here, so a delete-then-insert is simplest and correct). PATCH rather than
// PUT to match the rest of this API — nothing here uses PUT.
router.patch('/default-technicians/:family', requireAdmin, asyncHandler(async (req, res) => {
  const { family } = req.params;
  if (!FAMILIES.includes(family)) throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  const ids = [...new Set(
    (Array.isArray(req.body?.technician_ids) ? req.body.technician_ids : [])
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  )];

  await withTransaction(async (client) => {
    await client.query('DELETE FROM instrument_default_technicians WHERE family = $1', [family]);
    for (const employeeId of ids) {
      await client.query(
        'INSERT INTO instrument_default_technicians (family, employee_id) VALUES ($1, $2)',
        [family, employeeId],
      );
    }
  });
  res.json({ family, technician_ids: ids });
}));

// One-time (or occasional) catch-up: assign each instrument-bearing,
// non-archived ticket that currently has nobody on it to its instrument
// family's configured defaults. Tickets with no instrument are skipped
// outright (there's no family to look defaults up by), archived tickets
// are skipped (they're done — nothing to route to a queue), and a family
// with no defaults configured is left alone rather than guessed at.
router.post('/default-technicians/backfill', requireAdmin, asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: candidates } = await client.query(`
      SELECT t.id, i.family
        FROM tickets t
        JOIN instruments i ON i.id = t.instrument_id
       WHERE t.instrument_id IS NOT NULL
         AND t.archived = FALSE
         AND NOT EXISTS (SELECT 1 FROM ticket_technicians tt WHERE tt.ticket_id = t.id)
       ORDER BY t.id
    `);

    const { rows: defaultRows } = await client.query(
      'SELECT family, employee_id FROM instrument_default_technicians',
    );
    const defaultsByFamily = {};
    for (const row of defaultRows) {
      if (!defaultsByFamily[row.family]) defaultsByFamily[row.family] = [];
      defaultsByFamily[row.family].push(row.employee_id);
    }

    let ticketsAssigned = 0;
    let ticketsSkipped = 0;
    const perFamily = {};

    for (const candidate of candidates) {
      const employeeIds = defaultsByFamily[candidate.family] || [];
      if (!employeeIds.length) { ticketsSkipped += 1; continue; }

      // Same "back of the line" queue-position rule as a brand-new ticket
      // (insertTicketRow in routes/tickets.js) — computed one at a time per
      // employee so a tech picked up by several backfilled tickets in this
      // same run still gets sequential, non-colliding positions.
      for (const employeeId of employeeIds) {
        const { rows: techRows } = await client.query(
          `SELECT COALESCE(MAX(tt.queue_position), 0) + 10 AS next
             FROM ticket_technicians tt
             JOIN tickets t2 ON t2.id = tt.ticket_id
            WHERE tt.employee_id = $1 AND t2.archived = FALSE`,
          [employeeId],
        );
        await client.query(
          `INSERT INTO ticket_technicians (ticket_id, employee_id, queue_position, assigned_by)
           VALUES ($1, $2, $3, $4)`,
          [candidate.id, employeeId, techRows[0].next, req.user.id],
        );
      }
      ticketsAssigned += 1;
      perFamily[candidate.family] = (perFamily[candidate.family] || 0) + 1;
    }

    return {
      tickets_considered: candidates.length,
      tickets_assigned: ticketsAssigned,
      tickets_skipped_no_defaults: ticketsSkipped,
      per_family: perFamily,
    };
  });

  res.json(result);
}));

router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.family) { params.push(req.query.family); clauses.push(`i.family = $${params.length}`); }
  if (req.query.customer_id) { params.push(req.query.customer_id); clauses.push(`i.customer_id = $${params.length}`); }
  if (req.query.fleet === 'true') clauses.push('i.is_fleet = TRUE');
  if (req.query.fleet === 'false') clauses.push('i.is_fleet = FALSE');
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    clauses.push(`(i.model ILIKE $${params.length} OR i.identifying_notes ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT i.*, c.name AS customer_name,
            (SELECT count(*)::int FROM tickets t WHERE t.instrument_id = i.id AND t.archived = FALSE)
              AS open_tickets
       FROM instruments i LEFT JOIN customers c ON c.id = i.customer_id
       ${where} ORDER BY i.family, i.model LIMIT 1000`,
    params,
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT i.*, c.name AS customer_name FROM instruments i
       LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`,
    [req.params.id],
  );
  if (!rows[0]) throw notFound('Instrument not found');
  const tickets = await query(
    `SELECT t.*, s.label AS status_label FROM tickets t
       LEFT JOIN settings s ON s.category='ticket_status' AND s.key=t.status_key
      WHERE t.instrument_id = $1 ORDER BY t.updated_at DESC`,
    [req.params.id],
  );
  res.json({ ...rows[0], tickets: tickets.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.family || !FAMILIES.includes(b.family)) {
    throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  }
  const { rows } = await query(
    `INSERT INTO instruments (family, model, year, serial_no, identifying_notes,
                              customer_id, is_fleet, fleet_last_qc, nickname)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,FALSE),$8,$9) RETURNING *`,
    [b.family, b.model || null, b.year || null, b.serial_no || null,
      b.identifying_notes || null, b.customer_id || null, b.is_fleet, b.fleet_last_qc || null,
      // N1: only the New Ticket page's "add a new instrument instead" form
      // sends this today — see composeTicketTitle in routes/tickets.js.
      b.nickname || null],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.family && !FAMILIES.includes(b.family)) {
    throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  }
  // A3: qc_interval_months is the one field here with an actual constraint
  // (the DB CHECK only allows NULL/3/6/12) — validated up front so a typo
  // surfaces as a clear 400 instead of a raw constraint-violation 500.
  if (b.qc_interval_months !== undefined && b.qc_interval_months !== null
    && ![3, 6, 12].includes(Number(b.qc_interval_months))) {
    throw badRequest('qc_interval_months must be 3, 6, 12, or null');
  }
  const { rows } = await query(
    `UPDATE instruments SET
       family = COALESCE($2, family), model = COALESCE($3, model),
       year = COALESCE($4, year), serial_no = COALESCE($5, serial_no),
       identifying_notes = COALESCE($6, identifying_notes),
       customer_id = CASE WHEN $7::boolean THEN $8 ELSE customer_id END,
       is_fleet = COALESCE($9, is_fleet),
       fleet_last_qc = COALESCE($10, fleet_last_qc),
       nickname = COALESCE($11, nickname),
       last_qc_at = CASE WHEN $12::boolean THEN $13 ELSE last_qc_at END,
       qc_interval_months = CASE WHEN $14::boolean THEN $15 ELSE qc_interval_months END
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.family || null, b.model || null, b.year || null, b.serial_no || null,
      b.identifying_notes === undefined ? null : b.identifying_notes,
      b.customer_id !== undefined, b.customer_id || null,
      b.is_fleet === undefined ? null : b.is_fleet,
      b.fleet_last_qc === undefined ? null : b.fleet_last_qc,
      b.nickname || null,
      b.last_qc_at !== undefined, b.last_qc_at || null,
      b.qc_interval_months !== undefined, b.qc_interval_months || null],
  );
  if (!rows[0]) throw notFound('Instrument not found');
  res.json(rows[0]);
}));

module.exports = router;
module.exports.FAMILIES = FAMILIES;
// N10: composeTicketTitle (routes/tickets.js) and its client-side mirror
// (TicketNewView.vue's autoTitlePreview) both need a human family label,
// not the raw key, in a standardized ticket title — same labels this
// route's own /family-labels endpoint already serves the frontend.
module.exports.FAMILY_LABELS = FAMILY_LABELS;
