'use strict';

/**
 * Sends the weekly Ceppies digest — the one place both the manual "Send
 * now" button (routes/ceppies.js, admin-only) and the automatic schedule
 * (services/ceppieScheduler.js) actually fire from, so there's exactly one
 * definition of "what counts as a digest going out."
 *
 * Every active employee with an email on file gets their own send (Resend
 * call + `emails` log row) rather than one email with everyone on the To
 * line — same one-row-per-recipient logging convention routes/purchases.js
 * and routes/quotes.js already use, and it means one bad address can't
 * affect anyone else's delivery.
 */

const { query } = require('../db');
const { sendEmail } = require('../mailer');
const config = require('../config');
const settings = require('./settings');
const { buildCeppieDigestEmail } = require('../templates/ceppieDigest');

const EMAIL_TEMPLATE = 'ceppie_digest';

async function sendCeppieDigest() {
  if (!config.resend.apiKey || !config.resend.fromEmail) {
    throw new Error('Email sending is not configured — set RESEND_API_KEY and RESEND_FROM_EMAIL');
  }

  const { rows: nominations } = await query(
    `SELECT n.*, nom.name AS nominee_name, tor.name AS nominator_name
       FROM ceppie_nominations n
       JOIN employees nom ON nom.id = n.nominee_id
       JOIN employees tor ON tor.id = n.nominator_id
      WHERE n.emailed_at IS NULL
      ORDER BY n.created_at`,
  );

  const { rows: recipients } = await query(
    `SELECT id, name, email FROM employees
      WHERE active = TRUE AND email IS NOT NULL AND email <> ''`,
  );

  const { subject, html, attachments } = buildCeppieDigestEmail({ nominations });

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendEmail({
        to: recipient.email, subject, html, attachments,
      });
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO emails (recipient, template, subject, status, sent_at)
         VALUES ($1, $2, $3, 'sent', now())`,
        [recipient.email, EMAIL_TEMPLATE, subject],
      );
      sent += 1;
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO emails (recipient, template, subject, status, error)
         VALUES ($1, $2, $3, 'failed', $4)`,
        [recipient.email, EMAIL_TEMPLATE, subject, err.message],
      );
      failed += 1;
    }
  }

  // The digest "went out" once we've attempted every recipient, regardless
  // of individual delivery failures (same partial-success tolerance as
  // routes/purchases.js's receipt send) — so every pending nomination moves
  // to Past now, not just the ones behind a successful send. Config being
  // entirely unset (the throw above) is the one case that stops this from
  // running at all, so a totally broken Resend setup never silently empties
  // the pending queue with nothing to show for it.
  await query('UPDATE ceppie_nominations SET emailed_at = now() WHERE emailed_at IS NULL');

  // Stamp last_sent_at on the schedule row itself — see
  // services/ceppieScheduler.js, which is what stops the automatic
  // schedule from firing a second time on the same shop-local day (and
  // what a manual "Send now" earlier in the day already satisfies for it).
  const { rows: scheduleRows } = await query(
    "SELECT id, meta FROM settings WHERE category = 'shop_config' AND key = 'ceppies_schedule'",
  );
  if (scheduleRows[0]) {
    await settings.update(scheduleRows[0].id, {
      meta: { ...scheduleRows[0].meta, last_sent_at: new Date().toISOString() },
    });
  }

  return {
    sent, failed, recipients: recipients.length, nominations_included: nominations.length,
  };
}

module.exports = { sendCeppieDigest };
