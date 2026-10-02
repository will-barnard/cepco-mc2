'use strict';

/**
 * Vendor work on a ticket (migration 064) — painting, woodshop, key tops,
 * ... each with its own status, e.g. "Woodshop: Completed/Delivered".
 *
 *   PUT    /api/tickets/:ticketId/vendor-work/:trackKey  { status_key, note? }
 *   DELETE /api/tickets/:ticketId/vendor-work/:trackKey
 *
 * PUT is an upsert: adding a vendor to a ticket and changing its status
 * are the same action ("set Painting to In Progress"), so the panel never
 * needs to know whether a row exists yet. No GET — GET /api/tickets/:id
 * returns these as `vendor_work`, same as `links` / `notes_log`.
 *
 * Types and statuses are Settings lists ('vendor_track' / 'vendor_status').
 * A *new* row needs an active type; an existing row whose type has since
 * been retired can still have its status updated (retiring hides a type
 * from being added, it shouldn't freeze tickets already using it).
 *
 * Mounted in index.js ahead of routes/tickets.js, same as ticketNotes.js.
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, notFound } = require('../middleware/errors');
const settings = require('../services/settings');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

const MAX_NOTE = 500;

router.put('/:trackKey', asyncHandler(async (req, res) => {
  const { ticketId, trackKey } = req.params;
  const b = req.body || {};

  const { rows: ticketRows } = await query('SELECT id FROM tickets WHERE id = $1', [ticketId]);
  if (!ticketRows[0]) throw notFound('Ticket not found');

  const { rows: existing } = await query(
    'SELECT id FROM ticket_vendor_work WHERE ticket_id = $1 AND track_key = $2',
    [ticketId, trackKey],
  );
  const track = existing[0]
    ? await settings.resolve('vendor_track', trackKey)
    : await settings.resolveActive('vendor_track', trackKey);
  const status = await settings.resolveActive('vendor_status', b.status_key);
  // undefined = leave the note alone; '' = clear it.
  const note = b.note === undefined ? undefined : (String(b.note).trim().slice(0, MAX_NOTE) || null);

  const { rows } = await query(
    `INSERT INTO ticket_vendor_work (ticket_id, track_key, status_key, note, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ticket_id, track_key) DO UPDATE SET
       status_key = EXCLUDED.status_key,
       note       = CASE WHEN $6::boolean THEN EXCLUDED.note ELSE ticket_vendor_work.note END,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [ticketId, track.key, status.key, note ?? null, req.user.id, note !== undefined],
  );
  res.json(rows[0]);
}));

router.delete('/:trackKey', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM ticket_vendor_work WHERE ticket_id = $1 AND track_key = $2',
    [req.params.ticketId, req.params.trackKey],
  );
  if (!rowCount) throw notFound('That vendor isn\'t on this ticket');
  res.json({ deleted: true });
}));

module.exports = router;
