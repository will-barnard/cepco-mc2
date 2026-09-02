'use strict';

/**
 * Customer progress updates — one per ticket, generated from the ticket's
 * "status notes" (migration 016) and current photos, then emailed to the
 * customer as a link to a public page (routes/publicProgressUpdates.js).
 * Same division of labor as routes/quotes.js: this file is staff-only
 * (requireAuth) and never looks anything up by confirm_token; the public
 * router is the only thing that does. See migration 020 (original name:
 * status reports), migration 046 (renamed to progress updates), and
 * NOTES.md.
 *
 * Deliberately NOT nested under /tickets/:id — same flat-resource-with-
 * ticket_id convention as routes/invoices.js and routes/shipments.js.
 */

const express = require('express');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const config = require('../config');
const { sendEmail } = require('../mailer');
const { buildProgressUpdateEmail } = require('../templates/progressUpdateEmail');

const router = express.Router();
router.use(requireAuth);

const REPORT_SELECT = `
  SELECT pu.*,
         t.title AS ticket_title, t.category_key, t.instrument_id,
         i.family AS instrument_family, i.model AS instrument_model,
         st.label AS ticket_status_label,
         c.name AS customer_name, c.email AS customer_email
    FROM progress_updates pu
    JOIN tickets t ON t.id = pu.ticket_id
    LEFT JOIN instruments i ON i.id = t.instrument_id
    LEFT JOIN settings st ON st.category = 'ticket_status' AND st.key = t.status_key
    LEFT JOIN customers c ON c.id = pu.customer_id
`;

/** Staff-facing convenience: the link a "Send" email points at, once the
 * update has a token. Not shown to the public endpoint's own consumer
 * (obviously — it already knows its own URL). */
function withPublicUrl(update) {
  if (!update || !update.confirm_token || !config.appBaseUrl) return update;
  return { ...update, public_url: `${config.appBaseUrl}/progress-update/${update.confirm_token}` };
}

async function loadAttachments(updateId) {
  const { rows } = await query(
    `SELECT ta.id, ta.caption, ta.file_name, ta.uploaded_at
       FROM progress_update_attachments pua
       JOIN ticket_attachments ta ON ta.id = pua.attachment_id
      WHERE pua.progress_update_id = $1
      ORDER BY pua.sort_order`,
    [updateId],
  );
  return rows;
}

/** Re-snapshots service_done/service_needed notes + the current photo list
 * from the ticket onto `update`, inside `client`. Shared by create and
 * refresh so "generate" and "update from ticket" pull data exactly the
 * same way. Never touches `summary` — see migration 020. */
async function pullFromTicket(client, updateId, ticketId) {
  const { rows: ticketRows } = await client.query(
    'SELECT service_done_notes, service_needed_notes FROM tickets WHERE id = $1', [ticketId],
  );
  const ticket = ticketRows[0];
  if (!ticket) throw notFound('Ticket not found');

  await client.query(
    `UPDATE progress_updates SET
       service_done_notes = $2, service_needed_notes = $3, refreshed_at = now()
     WHERE id = $1`,
    [updateId, ticket.service_done_notes, ticket.service_needed_notes],
  );

  const { rows: attachments } = await client.query(
    'SELECT id FROM ticket_attachments WHERE ticket_id = $1 ORDER BY uploaded_at', [ticketId],
  );
  await client.query('DELETE FROM progress_update_attachments WHERE progress_update_id = $1', [updateId]);
  for (let i = 0; i < attachments.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      'INSERT INTO progress_update_attachments (progress_update_id, attachment_id, sort_order) VALUES ($1,$2,$3)',
      [updateId, attachments[i].id, i],
    );
  }
}

// ---------------------------------------------------------------------------
// List — the Progress Updates page. ?ticket_id= is how TicketDetailView.vue
// checks whether "Generate progress update" already has one to link to
// instead (same pattern as GET /invoices?ticket_id=).
// ---------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.status) { params.push(req.query.status); clauses.push(`pu.status = $${params.length}`); }
  if (req.query.ticket_id) { params.push(req.query.ticket_id); clauses.push(`pu.ticket_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`${REPORT_SELECT} ${where} ORDER BY pu.created_at DESC`, params);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query(`${REPORT_SELECT} WHERE pu.id = $1`, [req.params.id]);
  const update = rows[0];
  if (!update) throw notFound('Progress update not found');
  const attachments = await loadAttachments(update.id);
  res.json(withPublicUrl({ ...update, attachments }));
}));

// ---------------------------------------------------------------------------
// Create — "Generate progress update" on ticket detail. Idempotent: a
// ticket already has at most one update (migration 020's UNIQUE
// ticket_id), so a second click (or a stale button that didn't yet know
// one existed) just returns the existing row untouched rather than
// erroring or silently re-pulling — only the explicit refresh endpoint
// below pulls again.
// ---------------------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id) throw badRequest('ticket_id is required');

  const { rows: existingRows } = await query(
    'SELECT id FROM progress_updates WHERE ticket_id = $1', [b.ticket_id],
  );
  if (existingRows[0]) {
    const { rows } = await query(`${REPORT_SELECT} WHERE pu.id = $1`, [existingRows[0].id]);
    return res.json(withPublicUrl({ ...rows[0], attachments: await loadAttachments(rows[0].id) }));
  }

  const { rows: ticketRows } = await query('SELECT customer_id FROM tickets WHERE id = $1', [b.ticket_id]);
  const ticket = ticketRows[0];
  if (!ticket) throw notFound('Ticket not found');

  const update = await withTransaction(async (client) => {
    const { rows: created } = await client.query(
      'INSERT INTO progress_updates (ticket_id, customer_id, created_by) VALUES ($1,$2,$3) RETURNING id',
      [b.ticket_id, ticket.customer_id, req.user.id],
    );
    await pullFromTicket(client, created[0].id, b.ticket_id);
    return created[0];
  });

  const { rows } = await query(`${REPORT_SELECT} WHERE pu.id = $1`, [update.id]);
  return res.status(201).json(withPublicUrl({ ...rows[0], attachments: await loadAttachments(update.id) }));
}));

// ---------------------------------------------------------------------------
// Update — the reporter's own summary, and (since they're report-owned
// copies once pulled, not live ticket data) the snapshotted notes text too.
// Editable at any status, sent or not — a progress update is meant to keep
// being touched up after the link's already gone out; see NOTES.md.
// ---------------------------------------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE progress_updates SET
       summary              = COALESCE($2, summary),
       service_done_notes   = COALESCE($3, service_done_notes),
       service_needed_notes = COALESCE($4, service_needed_notes)
     WHERE id = $1 RETURNING id`,
    [
      req.params.id,
      b.summary === undefined ? null : b.summary,
      b.service_done_notes === undefined ? null : b.service_done_notes,
      b.service_needed_notes === undefined ? null : b.service_needed_notes,
    ],
  );
  if (!rows[0]) throw notFound('Progress update not found');
  const { rows: full } = await query(`${REPORT_SELECT} WHERE pu.id = $1`, [rows[0].id]);
  res.json(withPublicUrl({ ...full[0], attachments: await loadAttachments(rows[0].id) }));
}));

// ---------------------------------------------------------------------------
// Refresh — "Update from ticket." Re-pulls status notes + the current
// photo list; leaves summary alone. See pullFromTicket() above.
// ---------------------------------------------------------------------------
router.post('/:id/refresh', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM progress_updates WHERE id = $1', [req.params.id]);
  const update = rows[0];
  if (!update) throw notFound('Progress update not found');

  await withTransaction((client) => pullFromTicket(client, update.id, update.ticket_id));

  const { rows: full } = await query(`${REPORT_SELECT} WHERE pu.id = $1`, [update.id]);
  res.json(withPublicUrl({ ...full[0], attachments: await loadAttachments(update.id) }));
}));

// ---------------------------------------------------------------------------
// Send — emails the update link to the customer. Re-sendable (e.g. they
// lost the email, or there's a fresher update) without generating a new
// link — confirm_token is assigned once and reused, exactly like
// routes/quotes.js's POST /:id/send.
// ---------------------------------------------------------------------------
router.post('/:id/send', asyncHandler(async (req, res) => {
  const { rows } = await query(`${REPORT_SELECT} WHERE pu.id = $1`, [req.params.id]);
  const update = rows[0];
  if (!update) throw notFound('Progress update not found');
  if (!config.appBaseUrl) {
    throw badRequest('APP_BASE_URL is not configured — the update link would be broken.');
  }
  if (!update.customer_email) {
    throw badRequest('This customer has no email address on file.');
  }

  const attachments = await loadAttachments(update.id);
  const confirmToken = update.confirm_token || crypto.randomBytes(24).toString('hex');
  const { subject, html, attachments: emailAttachments } = buildProgressUpdateEmail({
    update,
    ticket: {
      title: update.ticket_title,
      instrument_family: update.instrument_family,
      instrument_model: update.instrument_model,
    },
    customer: { name: update.customer_name },
    attachmentCount: attachments.length,
    confirmUrl: `${config.appBaseUrl}/progress-update/${confirmToken}`,
  });

  try {
    await sendEmail({
      to: update.customer_email, subject, html, attachments: emailAttachments,
    });
    await query(
      `INSERT INTO emails (recipient, template, subject, ticket_id, customer_id, status, sent_at)
       VALUES ($1, 'progress_update', $2, $3, $4, 'sent', now())`,
      [update.customer_email, subject, update.ticket_id, update.customer_id],
    );
  } catch (err) {
    await query(
      `INSERT INTO emails (recipient, template, subject, ticket_id, customer_id, status, error)
       VALUES ($1, 'progress_update', $2, $3, $4, 'failed', $5)`,
      [update.customer_email, subject, update.ticket_id, update.customer_id, err.message],
    );
    throw badRequest(`Could not send progress update: ${err.message}`);
  }

  const { rows: updated } = await query(
    `UPDATE progress_updates SET
       confirm_token = $2,
       sent_at = COALESCE(sent_at, now()),
       status = 'sent'
     WHERE id = $1 RETURNING id`,
    [update.id, confirmToken],
  );

  const { rows: full } = await query(`${REPORT_SELECT} WHERE pu.id = $1`, [updated[0].id]);
  res.json(withPublicUrl({ ...full[0], attachments }));
}));

module.exports = router;
