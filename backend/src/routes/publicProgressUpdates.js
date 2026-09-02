'use strict';

/**
 * Public, unauthenticated endpoints for the customer-facing side of a
 * progress update — the page a "View full progress update" email link
 * opens (frontend `/progress-update/:token`, router.js's `alwaysPublic`
 * route — plus a `/status-report/:token` alias kept for links emailed
 * before migration 046's rename). No requireAuth: a customer has no MC2
 * account. Looked up by `confirm_token` (24 random bytes, migration 020),
 * never by numeric id — same reasoning as routes/publicQuotes.js.
 *
 * The one action here (acknowledge) is a POST the page's own button
 * triggers, never something that fires from the GET that loads the page —
 * same GET-never-changes-state rule as publicQuotes.js, for the same
 * reason (mail scanners/clients prefetching links).
 */

const express = require('express');
const { query } = require('../db');
const { asyncHandler, notFound, badRequest } = require('../middleware/errors');
const storage = require('../storage');

const router = express.Router();

async function findByToken(token) {
  const { rows } = await query(
    `SELECT pu.*, t.title AS ticket_title,
            i.family AS instrument_family, i.model AS instrument_model,
            st.label AS ticket_status_label,
            c.name AS customer_name
       FROM progress_updates pu
       JOIN tickets t ON t.id = pu.ticket_id
       LEFT JOIN instruments i ON i.id = t.instrument_id
       LEFT JOIN settings st ON st.category = 'ticket_status' AND st.key = t.status_key
       LEFT JOIN customers c ON c.id = pu.customer_id
      WHERE pu.confirm_token = $1`,
    [token],
  );
  if (!rows[0]) throw notFound('This progress update link is invalid or has expired.');
  return rows[0];
}

router.get('/:token', asyncHandler(async (req, res) => {
  const update = await findByToken(req.params.token);
  const { rows: attachments } = await query(
    `SELECT ta.id, ta.caption, ta.uploaded_at
       FROM progress_update_attachments pua
       JOIN ticket_attachments ta ON ta.id = pua.attachment_id
      WHERE pua.progress_update_id = $1
      ORDER BY pua.sort_order`,
    [update.id],
  );

  // Customer-safe subset only — no internal ids, storage keys, or ticket
  // notes/pricing. ticket_status_label is read live (it's just "what stage
  // is this at right now," not curated content) rather than snapshotted
  // like the notes fields below — see migration 020.
  res.json({
    ticket_title: update.ticket_title,
    instrument_family: update.instrument_family,
    instrument_model: update.instrument_model,
    ticket_status_label: update.ticket_status_label,
    customer_name: update.customer_name,
    summary: update.summary,
    service_done_notes: update.service_done_notes,
    service_needed_notes: update.service_needed_notes,
    sent_at: update.sent_at,
    refreshed_at: update.refreshed_at,
    viewed_at: update.viewed_at,
    attachments: attachments.map((a) => ({ id: a.id, caption: a.caption, uploaded_at: a.uploaded_at })),
  });
}));

/**
 * Photo bytes for one attachment on this update. Deliberately not the same
 * URL the internal ticket gallery uses: GCS's is a signed URL with a short
 * TTL (fine to re-fetch from an authenticated session, dead by the time a
 * customer opens an email days later), and the local driver's sits behind
 * requireAuth entirely. Resolved fresh on every call, scoped to attachments
 * this specific update actually snapshotted — see migration 020.
 */
router.get('/:token/attachments/:attachmentId', asyncHandler(async (req, res) => {
  const update = await findByToken(req.params.token);
  const { rows } = await query(
    `SELECT ta.storage_key, ta.content_type
       FROM progress_update_attachments pua
       JOIN ticket_attachments ta ON ta.id = pua.attachment_id
      WHERE pua.progress_update_id = $1 AND ta.id = $2`,
    [update.id, req.params.attachmentId],
  );
  const attachment = rows[0];
  if (!attachment) throw notFound('Photo not found on this update');

  if (storage.supportsDirectUpload) {
    // GCS — redirect to a freshly-signed read URL rather than caching one.
    const url = await storage.getDownloadUrl(attachment.storage_key);
    return res.redirect(url);
  }
  if (!storage.readObject) throw badRequest('This storage driver does not serve files directly');
  const buffer = await storage.readObject(attachment.storage_key);
  res.set('Content-Type', attachment.content_type || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=300');
  return res.send(buffer);
}));

router.post('/:token/acknowledge', asyncHandler(async (req, res) => {
  const update = await findByToken(req.params.token);
  const { rows } = await query(
    `UPDATE progress_updates SET viewed_at = COALESCE(viewed_at, now())
      WHERE id = $1 RETURNING viewed_at`,
    [update.id],
  );
  res.json({ viewed_at: rows[0].viewed_at });
}));

module.exports = router;
