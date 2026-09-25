'use strict';

/**
 * Published ticket notes (migration 061) and their two-way link with
 * Xero's History & Notes.
 *
 * Xero keeps notes per *contact*, not per ticket, so:
 *
 *   MC2 -> Xero  Each note a person posts on a ticket is also posted to
 *                the ticket customer's Xero contact history, prefixed with
 *                the ticket number and title so it reads on its own over
 *                there. Automated notes (no author: recurring chores,
 *                Shopify orders, an estimate accepted by the customer)
 *                are skipped -- they'd bury the real history in Xero.
 *   Xero -> MC2  The contact's Xero history is read live when a ticket or
 *                customer page asks for it (contactHistory below) and shown
 *                read-only. Nothing is copied into MC2's own tables: Xero
 *                stays the owner of its history, and there's no second
 *                copy to drift or to de-duplicate on the next sync.
 *
 * A push that can't happen yet (customer not linked to Xero, Xero not
 * configured, Xero down) leaves the note 'pending'/'failed' and it's
 * retried by pushPendingNotes() at the end of every Xero sync run
 * (services/xeroSync.js), manual or nightly. The ticket page never waits
 * on Xero to post a note -- a Xero failure is reported next to the note,
 * not as a failure to save it.
 */

const { query } = require('../db');
const config = require('../config');
const xero = require('../xero');

// Xero doesn't document a hard limit on a history note that we could
// confirm; long notes are cut here rather than risk a rejected push. The
// full text always stays on the ticket.
const XERO_NOTE_MAX = 2000;

// Marks a Xero history entry as one MC2 posted, so the read-back
// (contactHistory) can tell them apart from notes typed in Xero itself
// and not show the same note twice on a ticket page.
const MC2_PREFIX = '[MC2';

const xeroConfigured = () => Boolean(config.xero.clientId && config.xero.clientSecret);

/**
 * Insert a note. `db` is either the pool-level `query` wrapper's owner or
 * an open transaction client (insertTicketRow passes its own, so a
 * ticket's first note commits or rolls back with the ticket itself).
 * Returns the new row; pushing to Xero is a separate step (pushNote) that
 * callers run *after* their transaction commits.
 */
async function insertNote(db, { ticketId, body, createdBy }) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  const { rows } = await db.query(
    `INSERT INTO ticket_notes (ticket_id, body, created_by, xero_status)
     SELECT t.id, $2, $3,
            CASE WHEN $3::int IS NULL OR t.customer_id IS NULL THEN 'skipped' ELSE 'pending' END
       FROM tickets t WHERE t.id = $1
     RETURNING *`,
    [ticketId, text, createdBy || null],
  );
  return rows[0] || null;
}

function xeroNoteText(note) {
  const who = note.author_name ? ` — ${note.author_name}` : '';
  const head = `${MC2_PREFIX} Ticket #${note.ticket_id}${note.ticket_title ? `: ${note.ticket_title}` : ''}] `;
  const room = XERO_NOTE_MAX - head.length - who.length;
  const body = note.body.length > room ? `${note.body.slice(0, room - 1)}…` : note.body;
  return `${head}${body}${who}`;
}

/**
 * Try to post one note to Xero. Never throws for a Xero-side problem --
 * the outcome is recorded on the row (and returned) instead.
 */
async function pushNote(noteId) {
  const { rows } = await query(
    `SELECT n.*, t.title AS ticket_title, t.customer_id, c.xero_contact_id,
            e.name AS author_name
       FROM ticket_notes n
       JOIN tickets t ON t.id = n.ticket_id
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN employees e ON e.id = n.created_by
      WHERE n.id = $1`,
    [noteId],
  );
  const note = rows[0];
  if (!note || !['pending', 'failed'].includes(note.xero_status)) return note || null;

  // The ticket's customer can change (or be cleared) after the note was
  // posted; whichever customer it has *now* is where the note goes.
  if (!note.customer_id) {
    await query("UPDATE ticket_notes SET xero_status = 'skipped', xero_error = NULL WHERE id = $1", [noteId]);
    return { ...note, xero_status: 'skipped' };
  }
  // Not linked yet, or no Xero at all: stays pending for the next sync.
  if (!note.xero_contact_id || !xeroConfigured()) return note;

  try {
    await xero.addContactNote(note.xero_contact_id, xeroNoteText(note));
    const { rows: done } = await query(
      `UPDATE ticket_notes SET xero_status = 'pushed', xero_pushed_at = now(), xero_error = NULL
        WHERE id = $1 RETURNING *`,
      [noteId],
    );
    return done[0];
  } catch (err) {
    const { rows: failed } = await query(
      "UPDATE ticket_notes SET xero_status = 'failed', xero_error = $2 WHERE id = $1 RETURNING *",
      [noteId, String(err.message).slice(0, 1000)],
    );
    return failed[0];
  }
}

/** Retry every note still waiting on Xero (optionally just one ticket's).
 * Oldest first, so a customer's history in Xero stays in order. */
async function pushPendingNotes({ ticketId } = {}) {
  const stats = { pushed: 0, failed: 0, waiting: 0 };
  if (!xeroConfigured()) return stats;
  const params = [];
  let where = "xero_status IN ('pending', 'failed')";
  if (ticketId) { params.push(ticketId); where += ` AND ticket_id = $${params.length}`; }
  const { rows } = await query(`SELECT id FROM ticket_notes WHERE ${where} ORDER BY created_at, id`, params);
  for (const { id } of rows) {
    const result = await pushNote(id); // eslint-disable-line no-await-in-loop
    if (result?.xero_status === 'pushed') stats.pushed += 1;
    else if (result?.xero_status === 'failed') stats.failed += 1;
    else if (result?.xero_status === 'pending') stats.waiting += 1;
  }
  return stats;
}

// --- Xero -> MC2 (read-only) ----------------------------------------------

// Xero's JSON dates look like "/Date(1573755038314+0000)/"; DateUTCString
// is the same instant without a zone suffix.
function parseXeroDate(rec) {
  const m = /\/Date\((-?\d+)/.exec(rec.DateUTC || '');
  if (m) return new Date(Number(m[1])).toISOString();
  if (rec.DateUTCString) return new Date(`${rec.DateUTCString}Z`).toISOString();
  return null;
}

// A ticket page can be reloaded a lot; a minute's cache per contact keeps
// that from turning into a Xero call per reload (Xero rate-limits at 60
// calls/minute per org).
const HISTORY_TTL_MS = 60 * 1000;
const historyCache = new Map(); // contactId -> { at, records }

/**
 * A Xero contact's History & Notes, newest first, minus the notes MC2
 * itself posted there (those are already on the ticket). `kind` is
 * 'note' for something a person typed into Xero, 'activity' for Xero's
 * own audit entries (created, edited, invoice sent...).
 */
async function contactHistory(contactId) {
  const hit = historyCache.get(contactId);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.records;

  const raw = await xero.getContactHistory(contactId);
  const records = raw
    .filter((r) => !String(r.Details || '').startsWith(MC2_PREFIX))
    .map((r) => ({
      at: parseXeroDate(r),
      kind: /note/i.test(r.Changes || '') ? 'note' : 'activity',
      changes: r.Changes || '',
      user: r.User || '',
      details: r.Details || '',
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  historyCache.set(contactId, { at: Date.now(), records });
  return records;
}

module.exports = {
  insertNote, pushNote, pushPendingNotes, contactHistory,
};
