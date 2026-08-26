'use strict';

const config = require('./config');

/**
 * Thin Resend client — PLAN's Phase 2 email integration, brought forward
 * just far enough for the purchase-receipt email (PLAN §12 doesn't cover
 * this specifically; it's new with the inventory-purchase flow). No SDK
 * dependency: Resend's send endpoint is one POST, and Node 20's built-in
 * `fetch` covers it without adding to package.json.
 *
 * RESEND_API_KEY / RESEND_FROM_EMAIL are both optional at the config layer
 * on purpose — the app should boot fine before an admin has set them up.
 * sendEmail() throws a clear, catchable error in that case; callers should
 * treat that as "email isn't configured yet", not a bug, and the `emails`
 * log table is where the attempt (and that error) ends up either way.
 */
async function sendEmail({
  to, subject, html, attachments,
}) {
  const { apiKey, fromEmail } = config.resend;
  if (!apiKey || !fromEmail) {
    throw new Error('Email sending is not configured — set RESEND_API_KEY and RESEND_FROM_EMAIL');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject,
      html,
      ...(attachments && attachments.length ? { attachments } : {}),
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.message || `Resend returned HTTP ${res.status}`);
  }
  return payload; // { id: 're_...' }
}

module.exports = { sendEmail };
