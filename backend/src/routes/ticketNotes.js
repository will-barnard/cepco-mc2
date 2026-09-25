'use strict';

/**
 * Published ticket notes (migration 061, services/ticketNotes.js).
 *
 *   POST /api/tickets/:ticketId/notes                   { body }
 *   POST /api/tickets/:ticketId/notes/:noteId/push-xero  retry a failed push
 *
 * No GET: GET /api/tickets/:id returns them as `notes_log` (same as
 * ticket_links' `links`). No edit or delete either, deliberately -- a
 * published note is a record, same as in Xero (where it may already have
 * been copied to). A correction is a new note.
 *
 * Mounted in index.js *ahead of* routes/tickets.js so these sub-paths are
 * matched here rather than falling into that router's /:id handlers.
 */

const express = require('express');
const { pool, query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const { insertNote, pushNote } = require('../services/ticketNotes');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

const MAX_BODY = 10000;

const NOTE_SELECT = `
  SELECT n.*, e.name AS created_by_name
    FROM ticket_notes n LEFT JOIN employees e ON e.id = n.created_by
   WHERE n.id = $1`;

router.post('/', asyncHandler(async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) throw badRequest('Note text is required');
  if (body.length > MAX_BODY) throw badRequest(`Notes must be ${MAX_BODY} characters or fewer`);

  const note = await insertNote(pool, {
    ticketId: req.params.ticketId, body, createdBy: req.user?.id,
  });
  if (!note) throw notFound('Ticket not found');
  // Bump the ticket so "recently updated" sorts notice a new note, same as
  // any other edit to it.
  await query('UPDATE tickets SET updated_at = now() WHERE id = $1', [note.ticket_id]);

  // Awaited (unlike a new ticket's first note) so the response can say
  // straight away whether it reached Xero -- pushNote records failures on
  // the row rather than throwing, so the note is saved either way.
  await pushNote(note.id);
  const { rows } = await query(NOTE_SELECT, [note.id]);
  res.status(201).json(rows[0]);
}));

router.post('/:noteId/push-xero', asyncHandler(async (req, res) => {
  const { rows: found } = await query(
    'SELECT id FROM ticket_notes WHERE id = $1 AND ticket_id = $2',
    [req.params.noteId, req.params.ticketId],
  );
  if (!found[0]) throw notFound('Note not found');
  await pushNote(found[0].id);
  const { rows } = await query(NOTE_SELECT, [found[0].id]);
  res.json(rows[0]);
}));

module.exports = router;
