'use strict';

/**
 * Friday Lunch emails -- one to every active employee with an email when a
 * round opens for suggestions, when voting opens, and when a winner is in.
 * Fired after the phase change has committed and deliberately not awaited
 * by the request: ten-odd sequential Resend calls shouldn't hold up the
 * admin's button, and a delivery problem must never undo a phase change.
 *
 * Unlike the Ceppys digest, missing email config is not an error here --
 * the vote works fine without email, so it's a logged skip.
 */

const config = require('../config');
const { query } = require('../db');
const { sendEmail } = require('../mailer');
const { buildFridayLunchEmail } = require('../templates/fridayLunchEmail');

async function send(roundId, kind) {
  if (!config.resend.apiKey || !config.resend.fromEmail) {
    console.warn(`[friday-lunch] email not configured; skipped "${kind}" email for round ${roundId}`);
    return;
  }

  const { rows: roundRows } = await query(
    `SELECT r.*, w.name AS winner_name
       FROM lunch_rounds r LEFT JOIN lunch_places w ON w.id = r.winner_place_id
      WHERE r.id = $1`,
    [roundId],
  );
  const round = roundRows[0];
  if (!round) return;
  const { rows: places } = await query(
    'SELECT name FROM lunch_places WHERE round_id = $1 ORDER BY lower(name)', [roundId],
  );
  const { rows: recipients } = await query(
    "SELECT email FROM employees WHERE active = TRUE AND email IS NOT NULL AND email <> ''",
  );

  const { subject, html, attachments } = buildFridayLunchEmail({ kind, round, places });
  const template = `friday_lunch_${kind}`;

  for (const r of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendEmail({ to: r.email, subject, html, attachments });
      // eslint-disable-next-line no-await-in-loop
      await query(
        "INSERT INTO emails (recipient, template, subject, status, sent_at) VALUES ($1, $2, $3, 'sent', now())",
        [r.email, template, subject],
      );
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        "INSERT INTO emails (recipient, template, subject, status, error) VALUES ($1, $2, $3, 'failed', $4)",
        [r.email, template, subject, err.message],
      ).catch(() => {});
    }
  }
}

/** kind: 'suggesting' | 'voting' | 'runoff' | 'closed' | 'orders'. Never throws, never awaited. */
function notifyAll(roundId, kind) {
  setImmediate(() => {
    send(roundId, kind).catch((err) => console.error('[friday-lunch] email send failed', err));
  });
}

module.exports = { notifyAll };
