'use strict';

/**
 * Fires the weekly Ceppys digest automatically, on the day/time an admin
 * configured (Settings -> shop_config's ceppys_schedule row, edited from
 * the Ceppys page's own "Configure" panel — see routes/ceppys.js and
 * services/ceppys.js).
 *
 * A plain in-process setInterval, not a real cron library or an external
 * scheduled task: this backend runs as one long-lived Node process under
 * Beachhead (see index.js's SIGTERM/SIGINT handlers), and the only thing
 * that needs deciding once a minute is "is it the configured day/time yet,
 * and did today's digest already go out" — both cheap single-row/single-
 * query checks. Checking `hhmm >= configured time` rather than an exact-
 * minute match makes this resilient to a missed tick (a slow query, a
 * restart at just the wrong moment): it still fires the next time it's
 * checked, as long as it's still the configured day and nothing has gone
 * out yet today.
 */

const { query } = require('../db');
const config = require('../config');
const { sendCeppyDigest } = require('./ceppys');

const CHECK_INTERVAL_MS = 60_000;

async function tick() {
  try {
    const { rows } = await query(
      "SELECT meta FROM settings WHERE category = 'shop_config' AND key = 'ceppys_schedule'",
    );
    const meta = rows[0]?.meta || {};
    if (!meta.enabled) return;
    if (meta.day_of_week === undefined || meta.day_of_week === null || !meta.time) return;

    const { rows: nowRows } = await query(
      `SELECT EXTRACT(DOW FROM now() AT TIME ZONE $1)::int AS dow,
              to_char(now() AT TIME ZONE $1, 'HH24:MI') AS hhmm,
              (now() AT TIME ZONE $1)::date AS today,
              ($2::timestamptz AT TIME ZONE $1)::date AS last_sent_local_date`,
      [config.shopTimezone, meta.last_sent_at || null],
    );
    const {
      dow, hhmm, today, last_sent_local_date: lastSentLocalDate,
    } = nowRows[0];

    if (dow !== meta.day_of_week) return;
    if (hhmm < meta.time) return;
    if (lastSentLocalDate && lastSentLocalDate === today) return; // already sent today

    const result = await sendCeppyDigest();
    console.log(
      `[ceppys] scheduled digest sent — ${result.sent} ok, ${result.failed} failed, `
      + `${result.nominations_included} nomination(s) included`,
    );
  } catch (err) {
    // Never let a bad tick take the process down — same "log and move on"
    // posture as the rest of this app's background-ish work (see
    // middleware/errors.js's asyncHandler for the request-handling
    // equivalent). Next tick, or the admin's manual "Send now", can still
    // recover from whatever this was.
    console.error('[ceppys] scheduler tick failed', err);
  }
}

function start() {
  tick(); // catch up immediately in case the target minute was missed while the process was down
  return setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { start };
