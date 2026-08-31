'use strict';

/**
 * Public, unauthenticated endpoints for the customer-facing side of a
 * status report — the page a "View full status report" email link opens
 * (frontend `/status-report/:token`, router.js's `alwaysPublic` route).
 * No requireAuth: a customer has no MC2 account. Looked up by
 * `confirm_token` (24 random bytes, migration 020), never by numeric id —
 * same reasoning as routes/publicQuotes.js.
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
    `SELECT sr.*, t.title AS ticket_title,
            i.family AS instrument_family, i.model AS instrument_model,
            st.label AS ticket_status_label,
            c.name AS customer_name
       FROM status_reports sr
       JOIN tickets t ON t.id = sr.ticket_id
       LEFT JOIN instruments i ON i.id = t.instrument_id
       LEFT JOIN settings st ON st.category = 'ticket_status' AND st.key = t.status_key
       LEFT JOIN customers c ON c.id = sr.customer_id
      WHERE sr.confirm_token = $1`,
    [token],
  );
  if (!rows[0]) throw notFound('This status report link is invalid or has expired.');
  return rows[0];
}

router.get('/:token', asyncHandler(async (req, res) => {
  const report = await findByToken(req.params.token);
  const { rows: attachments } = await query(
    `SELECT ta.id, ta.caption, ta.uploaded_at
       FROM status_report_attachments sra
       JOIN ticket_attachments ta ON ta.id = sra.attachment_id
      WHERE sra.status_report_id = $1
      ORDER BY sra.sort_order`,
    [report.id],
  );

  // Customer-safe subset only — no internal ids, storage keys, or ticket
  // notes/pricing. ticket_status_label is read live (it's just "what stage
  // is this at right now," not curated content) rather than snapshotted
  // like the notes fields below — see migration 020.
  res.json({
    ticket_title: report.ticket_title,
    instrument_family: report.instrument_family,
    instrument_model: report.instrument_model,
    ticket_status_label: report.ticket_status_label,
    customer_name: report.customer_name,
    summary: report.summary,
    service_done_notes: report.service_done_notes,
    service_needed_notes: report.service_needed_notes,
    sent_at: report.sent_at,
    refreshed_at: report.refreshed_at,
    viewed_at: report.viewed_at,
    attachments: attachments.map((a) => ({ id: a.id, caption: a.caption, uploaded_at: a.uploaded_at })),
  });
}));

/**
 * Photo bytes for one attachment on this report. Deliberately not the same
 * URL the internal ticket gallery uses: GCS's is a signed URL with a short
 * TTL (fine to re-fetch from an authenticated session, dead by the time a
 * customer opens an email days later), and the local driver's sits behind
 * requireAuth entirely. Resolved fresh on every call, scoped to attachments
 * this specific report actually snapshotted — see migration 020.
 */
router.get('/:token/attachments/:attachmentId', asyncHandler(async (req, res) => {
  const report = await findByToken(req.params.token);
  const { rows } = await query(
    `SELECT ta.storage_key, ta.content_type
       FROM status_report_attachments sra
       JOIN ticket_attachments ta ON ta.id = sra.attachment_id
      WHERE sra.status_report_id = $1 AND ta.id = $2`,
    [report.id, req.params.attachmentId],
  );
  const attachment = rows[0];
  if (!attachment) throw notFound('Photo not found on this report');

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
  const report = await findByToken(req.params.token);
  const { rows } = await query(
    `UPDATE status_reports SET viewed_at = COALESCE(viewed_at, now())
      WHERE id = $1 RETURNING viewed_at`,
    [report.id],
  );
  res.json({ viewed_at: rows[0].viewed_at });
}));

module.exports = router;
