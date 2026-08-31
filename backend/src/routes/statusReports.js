'use strict';

/**
 * Customer status reports — one per ticket, generated from the ticket's
 * "status notes" (migration 016) and current photos, then emailed to the
 * customer as a link to a public page (routes/publicStatusReports.js).
 * Same division of labor as routes/quotes.js: this file is staff-only
 * (requireAuth) and never looks anything up by confirm_token; the public
 * router is the only thing that does. See migration 020 and NOTES.md.
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
const { buildStatusReportEmail } = require('../templates/statusReportEmail');

const router = express.Router();
router.use(requireAuth);

const REPORT_SELECT = `
  SELECT sr.*,
         t.title AS ticket_title, t.category_key, t.instrument_id,
         i.family AS instrument_family, i.model AS instrument_model,
         st.label AS ticket_status_label,
         c.name AS customer_name, c.email AS customer_email
    FROM status_reports sr
    JOIN tickets t ON t.id = sr.ticket_id
    LEFT JOIN instruments i ON i.id = t.instrument_id
    LEFT JOIN settings st ON st.category = 'ticket_status' AND st.key = t.status_key
    LEFT JOIN customers c ON c.id = sr.customer_id
`;

/** Staff-facing convenience: the link a "Send" email points at, once the
 * report has a token. Not shown to the public endpoint's own consumer
 * (obviously — it already knows its own URL). */
function withPublicUrl(report) {
  if (!report || !report.confirm_token || !config.appBaseUrl) return report;
  return { ...report, public_url: `${config.appBaseUrl}/status-report/${report.confirm_token}` };
}

async function loadAttachments(reportId) {
  const { rows } = await query(
    `SELECT ta.id, ta.caption, ta.file_name, ta.uploaded_at
       FROM status_report_attachments sra
       JOIN ticket_attachments ta ON ta.id = sra.attachment_id
      WHERE sra.status_report_id = $1
      ORDER BY sra.sort_order`,
    [reportId],
  );
  return rows;
}

/** Re-snapshots service_done/service_needed notes + the current photo list
 * from the ticket onto `report`, inside `client`. Shared by create and
 * refresh so "generate" and "update from ticket" pull data exactly the
 * same way. Never touches `summary` — see migration 020. */
async function pullFromTicket(client, reportId, ticketId) {
  const { rows: ticketRows } = await client.query(
    'SELECT service_done_notes, service_needed_notes FROM tickets WHERE id = $1', [ticketId],
  );
  const ticket = ticketRows[0];
  if (!ticket) throw notFound('Ticket not found');

  await client.query(
    `UPDATE status_reports SET
       service_done_notes = $2, service_needed_notes = $3, refreshed_at = now()
     WHERE id = $1`,
    [reportId, ticket.service_done_notes, ticket.service_needed_notes],
  );

  const { rows: attachments } = await client.query(
    'SELECT id FROM ticket_attachments WHERE ticket_id = $1 ORDER BY uploaded_at', [ticketId],
  );
  await client.query('DELETE FROM status_report_attachments WHERE status_report_id = $1', [reportId]);
  for (let i = 0; i < attachments.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      'INSERT INTO status_report_attachments (status_report_id, attachment_id, sort_order) VALUES ($1,$2,$3)',
      [reportId, attachments[i].id, i],
    );
  }
}

// ---------------------------------------------------------------------------
// List — the Status Reports page. ?ticket_id= is how TicketDetailView.vue
// checks whether "Generate status report" already has one to link to
// instead (same pattern as GET /invoices?ticket_id=).
// ---------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.status) { params.push(req.query.status); clauses.push(`sr.status = $${params.length}`); }
  if (req.query.ticket_id) { params.push(req.query.ticket_id); clauses.push(`sr.ticket_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`${REPORT_SELECT} ${where} ORDER BY sr.created_at DESC`, params);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query(`${REPORT_SELECT} WHERE sr.id = $1`, [req.params.id]);
  const report = rows[0];
  if (!report) throw notFound('Status report not found');
  const attachments = await loadAttachments(report.id);
  res.json(withPublicUrl({ ...report, attachments }));
}));

// ---------------------------------------------------------------------------
// Create — "Generate status report" on ticket detail. Idempotent: a ticket
// already has at most one report (migration 020's UNIQUE ticket_id), so a
// second click (or a stale button that didn't yet know one existed) just
// returns the existing row untouched rather than erroring or silently
// re-pulling — only the explicit refresh endpoint below pulls again.
// ---------------------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id) throw badRequest('ticket_id is required');

  const { rows: existingRows } = await query(
    'SELECT id FROM status_reports WHERE ticket_id = $1', [b.ticket_id],
  );
  if (existingRows[0]) {
    const { rows } = await query(`${REPORT_SELECT} WHERE sr.id = $1`, [existingRows[0].id]);
    return res.json(withPublicUrl({ ...rows[0], attachments: await loadAttachments(rows[0].id) }));
  }

  const { rows: ticketRows } = await query('SELECT customer_id FROM tickets WHERE id = $1', [b.ticket_id]);
  const ticket = ticketRows[0];
  if (!ticket) throw notFound('Ticket not found');

  const report = await withTransaction(async (client) => {
    const { rows: created } = await client.query(
      'INSERT INTO status_reports (ticket_id, customer_id, created_by) VALUES ($1,$2,$3) RETURNING id',
      [b.ticket_id, ticket.customer_id, req.user.id],
    );
    await pullFromTicket(client, created[0].id, b.ticket_id);
    return created[0];
  });

  const { rows } = await query(`${REPORT_SELECT} WHERE sr.id = $1`, [report.id]);
  return res.status(201).json(withPublicUrl({ ...rows[0], attachments: await loadAttachments(report.id) }));
}));

// ---------------------------------------------------------------------------
// Update — the reporter's own summary, and (since they're report-owned
// copies once pulled, not live ticket data) the snapshotted notes text too.
// Editable at any status, sent or not — a status report is meant to keep
// being touched up after the link's already gone out; see NOTES.md.
// ---------------------------------------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE status_reports SET
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
  if (!rows[0]) throw notFound('Status report not found');
  const { rows: full } = await query(`${REPORT_SELECT} WHERE sr.id = $1`, [rows[0].id]);
  res.json(withPublicUrl({ ...full[0], attachments: await loadAttachments(rows[0].id) }));
}));

// ---------------------------------------------------------------------------
// Refresh — "Update from ticket." Re-pulls status notes + the current
// photo list; leaves summary alone. See pullFromTicket() above.
// ---------------------------------------------------------------------------
router.post('/:id/refresh', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM status_reports WHERE id = $1', [req.params.id]);
  const report = rows[0];
  if (!report) throw notFound('Status report not found');

  await withTransaction((client) => pullFromTicket(client, report.id, report.ticket_id));

  const { rows: full } = await query(`${REPORT_SELECT} WHERE sr.id = $1`, [report.id]);
  res.json(withPublicUrl({ ...full[0], attachments: await loadAttachments(report.id) }));
}));

// ---------------------------------------------------------------------------
// Send — emails the report link to the customer. Re-sendable (e.g. they
// lost the email, or there's a fresher update) without generating a new
// link — confirm_token is assigned once and reused, exactly like
// routes/quotes.js's POST /:id/send.
// ---------------------------------------------------------------------------
router.post('/:id/send', asyncHandler(async (req, res) => {
  const { rows } = await query(`${REPORT_SELECT} WHERE sr.id = $1`, [req.params.id]);
  const report = rows[0];
  if (!report) throw notFound('Status report not found');
  if (!config.appBaseUrl) {
    throw badRequest('APP_BASE_URL is not configured — the report link would be broken.');
  }
  if (!report.customer_email) {
    throw badRequest('This customer has no email address on file.');
  }

  const attachments = await loadAttachments(report.id);
  const confirmToken = report.confirm_token || crypto.randomBytes(24).toString('hex');
  const { subject, html, attachments: emailAttachments } = buildStatusReportEmail({
    report,
    ticket: {
      title: report.ticket_title,
      instrument_family: report.instrument_family,
      instrument_model: report.instrument_model,
    },
    customer: { name: report.customer_name },
    attachmentCount: attachments.length,
    confirmUrl: `${config.appBaseUrl}/status-report/${confirmToken}`,
  });

  try {
    await sendEmail({
      to: report.customer_email, subject, html, attachments: emailAttachments,
    });
    await query(
      `INSERT INTO emails (recipient, template, subject, ticket_id, customer_id, status, sent_at)
       VALUES ($1, 'status_report', $2, $3, $4, 'sent', now())`,
      [report.customer_email, subject, report.ticket_id, report.customer_id],
    );
  } catch (err) {
    await query(
      `INSERT INTO emails (recipient, template, subject, ticket_id, customer_id, status, error)
       VALUES ($1, 'status_report', $2, $3, $4, 'failed', $5)`,
      [report.customer_email, subject, report.ticket_id, report.customer_id, err.message],
    );
    throw badRequest(`Could not send status report: ${err.message}`);
  }

  const { rows: updated } = await query(
    `UPDATE status_reports SET
       confirm_token = $2,
       sent_at = COALESCE(sent_at, now()),
       status = 'sent'
     WHERE id = $1 RETURNING id`,
    [report.id, confirmToken],
  );

  const { rows: full } = await query(`${REPORT_SELECT} WHERE sr.id = $1`, [updated[0].id]);
  res.json(withPublicUrl({ ...full[0], attachments }));
}));

module.exports = router;
