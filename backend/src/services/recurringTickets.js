'use strict';

/**
 * A1 (boss-list scope): the recurring-ticket engine. Nothing generated
 * tickets on a schedule before this — the shape to copy was already in the
 * codebase (services/ceppyScheduler.js): a plain in-process interval that
 * reads config rows, checks the shop-local day/time, and guards against
 * double-firing with a last-run timestamp compared by *date* rather than
 * exact time, so a missed tick (a slow query, a restart at just the wrong
 * moment) still recovers on the next check instead of silently skipping a
 * whole day. Same reasoning here, just per-template instead of one global
 * config row.
 *
 * A2 (weekly chore rotation) lives on this same engine rather than a
 * second one — recurring_ticket_templates.rotate_among_active_techs is the
 * only thing that differs about a chore template's firing versus one of
 * A1's plain daily tickets; the day/time/already-fired-today logic is
 * identical either way.
 */

const { query, withTransaction } = require('../db');
const config = require('../config');
const settings = require('./settings');
const { resolveNewTicketFields, insertTicketRow } = require('../routes/tickets');

const CHECK_INTERVAL_MS = 60_000;

/**
 * The next tech in the rotation, given who fired last time. Deliberately
 * "next id after this one, wrapping around" rather than a stored numeric
 * index — an index drifts the moment the eligible pool's size changes
 * (someone new hired, someone excluded, someone deactivated), while
 * walking the *current* eligible list by id and finding the one after the
 * last assignee self-heals from all of that automatically, including the
 * case where the last assignee themselves is no longer eligible (an
 * id that's no longer in the list simply isn't found, and the search
 * falls through to the first eligible person — see the findIndex/-1 case
 * below).
 */
async function nextRotationEmployee(client, lastEmployeeId) {
  const { rows } = await client.query(
    `SELECT id FROM employees
      WHERE active = TRUE AND excluded_from_chore_rotation = FALSE
      ORDER BY id`,
  );
  if (!rows.length) return null;
  if (!lastEmployeeId) return rows[0].id;
  const idx = rows.findIndex((r) => r.id === lastEmployeeId);
  return rows[(idx + 1) % rows.length].id;
}

async function fireTemplate(templateId) {
  await withTransaction(async (client) => {
    // Re-read + lock inside the transaction rather than trusting the
    // caller's already-loaded row: closes the (admittedly narrow, single-
    // process) window between tick()'s SELECT and this firing, and means
    // a template retired or edited mid-tick is respected rather than
    // fired on stale data.
    const { rows: lockedRows } = await client.query(
      'SELECT * FROM recurring_ticket_templates WHERE id = $1 FOR UPDATE', [templateId],
    );
    const t = lockedRows[0];
    if (!t || !t.active) return;

    const { rows: dateRows } = await client.query(
      `SELECT EXTRACT(DOW FROM now() AT TIME ZONE $1)::int AS current_dow,
              to_char(now() AT TIME ZONE $1, 'HH24:MI')     AS current_hhmm,
              (now() AT TIME ZONE $1)::date                 AS today,
              ($2::timestamptz AT TIME ZONE $1)::date        AS last_local_date`,
      [config.shopTimezone, t.last_generated_at],
    );
    const {
      current_dow: currentDow, current_hhmm: currentHhmm, today, last_local_date: lastLocalDate,
    } = dateRows[0];

    if (t.cadence === 'weekly' && t.day_of_week !== currentDow) return;
    if (currentHhmm < t.time_of_day) return;
    if (lastLocalDate && lastLocalDate === today) return; // already generated today

    let technicianIds = [];
    let rotationNext = t.rotation_last_employee_id;
    if (t.rotate_among_active_techs) {
      const employeeId = await nextRotationEmployee(client, t.rotation_last_employee_id);
      // No eligible employee (everyone excluded or inactive) still creates
      // the ticket, just unassigned — a missed chore is more visible than
      // a silently-skipped one, and the queue still needs clearing by hand
      // either way.
      if (employeeId) { technicianIds = [employeeId]; rotationNext = employeeId; }
    }

    const resolved = await resolveNewTicketFields({
      category_key: t.category_key,
      priority_key: t.priority_key,
    });
    await insertTicketRow(
      client,
      { title: t.title, notes: t.notes || null, technician_ids: technicianIds },
      resolved,
      // createdById: no staff member created this ticket — same convention
      // as the Shopify order webhook's own automated ticket creation.
      null,
    );

    await client.query(
      `UPDATE recurring_ticket_templates
          SET last_generated_at = now(), rotation_last_employee_id = $2, updated_at = now()
        WHERE id = $1`,
      [t.id, rotationNext],
    );

    console.log(`[recurring-tickets] fired template #${t.id} (${t.title})`);
  });
}


// A3 (boss-list scope): fixed shop-local check time, not admin-configurable
// — this is a background sweep, not something the doc asked for a settings
// screen over. Deliberately later than the daily-template default hour
// (08:30/16:00) so it doesn't compete for attention right at opening.
const FLEET_QC_SWEEP_TIME = '07:00';

/**
 * Once a day, create a QC ticket for every fleet instrument whose QC cycle
 * (instruments.last_qc_at + qc_interval_months, both set by the shop's own
 * data-entry pass — see migration 034) has come due. Same shop-local
 * date-guarded idiom as fireTemplate() above and ceppyScheduler's own
 * tick(), just keyed off a single shop_config row instead of a per-
 * template last_generated_at, since there's exactly one sweep rather than
 * many independent ones.
 */
async function fleetQcSweep() {
  try {
    const { rows: cfgRows } = await query(
      "SELECT meta FROM settings WHERE category = 'shop_config' AND key = 'fleet_qc_sweep'",
    );
    const meta = cfgRows[0]?.meta || {};

    const { rows: dateRows } = await query(
      `SELECT to_char(now() AT TIME ZONE $1, 'HH24:MI') AS current_hhmm,
              (now() AT TIME ZONE $1)::date             AS today,
              ($2::timestamptz AT TIME ZONE $1)::date    AS last_local_date`,
      [config.shopTimezone, meta.last_run_at || null],
    );
    const {
      current_hhmm: currentHhmm, today, last_local_date: lastLocalDate,
    } = dateRows[0];
    if (currentHhmm < FLEET_QC_SWEEP_TIME) return;
    if (lastLocalDate && lastLocalDate === today) return; // already ran today

    // Overdue = last_qc_at + qc_interval_months has passed, shop-local.
    // Instruments missing either value (the common case until the shop's
    // backfill pass runs) are simply not selected — no cycle configured
    // yet means no automatic ticket yet, same "no eligible row, nothing
    // happens" posture as an empty rotation pool in fireTemplate().
    // NOT EXISTS guards against re-firing on an instrument that already
    // has an open Fleet QC ticket sitting in the queue — the title prefix
    // is the marker, same lightweight "match on what's already visible"
    // approach FleetView.vue's own qcPill() takes with fleet_last_qc.
    const { rows: overdue } = await query(
      `SELECT i.* FROM instruments i
        WHERE i.is_fleet = TRUE
          AND i.qc_interval_months IS NOT NULL
          AND i.last_qc_at IS NOT NULL
          AND i.last_qc_at + (i.qc_interval_months || ' months')::interval
                <= (now() AT TIME ZONE $1)
          AND NOT EXISTS (
            SELECT 1 FROM tickets t
             WHERE t.instrument_id = i.id AND t.archived = FALSE
               AND t.title ILIKE 'Fleet QC —%'
          )`,
      [config.shopTimezone],
    );

    for (const instrument of overdue) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one overdue
        // instrument at a time, same sequential-and-attributable reasoning
        // as the template loop below.
        await withTransaction(async (client) => {
          const resolved = await resolveNewTicketFields({
            category_key: await settings.defaultKeyPreferring('ticket_category', 'inventory_restoration'),
            priority_key: await settings.defaultKeyPreferring('priority_tier', 'standard_priority'),
          });
          const label = [instrument.nickname, instrument.model || instrument.family]
            .filter(Boolean).join(' ');
          await insertTicketRow(
            client,
            {
              title: `Fleet QC — ${label}`,
              instrument_id: instrument.id,
              notes: instrument.identifying_notes || null,
            },
            resolved,
            null, // no staff member created this ticket — same convention as fireTemplate()
          );
        });
        console.log(`[fleet-qc-sweep] created QC ticket for instrument #${instrument.id}`);
      } catch (err) {
        console.error(`[fleet-qc-sweep] instrument #${instrument.id} failed`, err);
      }
    }

    await query(
      `UPDATE settings SET meta = jsonb_set(meta, '{last_run_at}', to_jsonb(now()), true)
        WHERE category = 'shop_config' AND key = 'fleet_qc_sweep'`,
    );
  } catch (err) {
    // Never let a bad sweep take the process down — same "log and move on"
    // posture as everywhere else in this file.
    console.error('[fleet-qc-sweep] tick failed', err);
  }
}

async function tick() {
  let ids;
  try {
    const { rows } = await query('SELECT id FROM recurring_ticket_templates WHERE active = TRUE');
    ids = rows.map((r) => r.id);
  } catch (err) {
    console.error('[recurring-tickets] failed to load templates', err);
    ids = [];
  }

  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop -- templates fire
      // sequentially, same as ceppyScheduler's single-config tick; there's
      // no reason to parallelize a handful of admin-configured rows, and
      // sequential keeps errors attributable to exactly one template.
      await fireTemplate(id);
    } catch (err) {
      // Never let one bad template (a retired category/priority key, a
      // dropped FK) take the process down or block the rest — same "log
      // and move on" posture as ceppyScheduler.
      console.error(`[recurring-tickets] template #${id} failed`, err);
    }
  }

  await fleetQcSweep();
}

function start() {
  tick(); // catch up immediately in case a target minute was missed while the process was down
  return setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = {
  start, nextRotationEmployee, fireTemplate, fleetQcSweep,
};
