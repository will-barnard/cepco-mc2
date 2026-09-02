'use strict';

/**
 * Fires the nightly Xero customer sync automatically, on the shop-local
 * time an admin configured (Settings row shop_config.xero_sync, edited
 * from the Customers page's own Xero sync panel — see routes/xero.js and
 * services/xeroSync.js). Same plain in-process setInterval, same
 * "hhmm >= configured time, and it hasn't already run today" resilience-
 * to-a-missed-tick reasoning as services/ceppyScheduler.js — the only
 * difference from that scheduler is this one has no day-of-week to check,
 * since a nightly sync runs every day rather than weekly.
 */

const { query } = require('../db');
const config = require('../config');
const { runXeroSync } = require('./xeroSync');

const CHECK_INTERVAL_MS = 60_000;

async function tick() {
  try {
    const { rows } = await query(
      "SELECT meta FROM settings WHERE category = 'shop_config' AND key = 'xero_sync'",
    );
    const meta = rows[0]?.meta || {};
    if (!meta.enabled || !meta.time) return;

    const { rows: nowRows } = await query(
      `SELECT to_char(now() AT TIME ZONE $1, 'HH24:MI') AS hhmm,
              (now() AT TIME ZONE $1)::date AS today,
              ($2::timestamptz AT TIME ZONE $1)::date AS last_synced_local_date`,
      [config.shopTimezone, meta.last_synced_at || null],
    );
    const { hhmm, today, last_synced_local_date: lastSyncedLocalDate } = nowRows[0];

    if (hhmm < meta.time) return;
    if (lastSyncedLocalDate && lastSyncedLocalDate === today) return; // already ran today

    const result = await runXeroSync();
    console.log(
      `[xero] scheduled sync complete — mc2: +${result.mc2_created} created, `
      + `${result.mc2_updated} updated; xero: +${result.xero_created} created, `
      + `${result.xero_updated} updated; ${result.conflicts.length} conflict(s)`,
    );
  } catch (err) {
    // Never let a bad tick take the process down — same "log and move on"
    // posture as ceppyScheduler.js. Next tick, or an admin's manual
    // "Sync now", can still recover from whatever this was.
    console.error('[xero] scheduler tick failed', err);
  }
}

function start() {
  tick(); // catch up immediately in case the target minute was missed while the process was down
  return setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { start };
