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
 *
 * fixed_assignee_employee_id (migration 039) is a later, independent
 * override: any template — daily or weekly, rotating or not — can be
 * pinned to one specific person from Settings -> Recurring tickets. A pin
 * always wins over rotation when both are set; leaving it unset (the
 * default) is exactly today's behavior. See fireTemplate() below.
 */

const { query, withTransaction } = require('../db');
const config = require('../config');
const settings = require('./settings');
const { resolveNewTicketFields, insertTicketRow } = require('../routes/tickets');

const CHECK_INTERVAL_MS = 60_000;

/**
 * The next tech in the rotation, given who fired last time. Used to be
 * deterministic — "next id after this one, wrapping around" — but with
 * every weekly chore template starting from rotation_last_employee_id =
 * NULL, each one's *first* firing independently landed on the same first
 * eligible employee (the old `if (!lastEmployeeId) return rows[0].id`
 * branch), so a whole week of housekeeping chores could land on one
 * person purely by construction, not chance. Picking randomly among the
 * eligible (active, not excluded) pool fixes that directly, and is also
 * just what was asked for ("more random").
 *
 * Excludes whoever went last (when there's someone else to pick) rather
 * than a plain uniform draw — a plain draw would still let the same
 * person come up two weeks running fairly often, which reads as "broken"
 * even though it's correctly random; this keeps every firing genuinely
 * random while guaranteeing it's *someone new*. Falls back to the full
 * pool when there's only one eligible person, or when the last assignee
 * isn't in the current pool at all (excluded/deactivated since, or no
 * prior firing) — same self-healing posture the old id-walk had.
 */
async function nextRotationEmployee(client, lastEmployeeId) {
  const { rows } = await client.query(
    `SELECT id FROM employees
      WHERE active = TRUE AND excluded_from_chore_rotation = FALSE
      ORDER BY id`,
  );
  if (!rows.length) return null;
  const ids = rows.map((r) => r.id);
  const pool = ids.length > 1 ? ids.filter((id) => id !== lastEmployeeId) : ids;
  const candidates = pool.length ? pool : ids;
  return candidates[Math.floor(Math.random() * candidates.length)];
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
    if (t.fixed_assignee_employee_id) {
      // A pinned assignee (Settings -> Recurring tickets) always wins,
      // independent of rotate_among_active_techs — a template can have
      // both set (rotation configured, then overridden) and the pin still
      // takes it. rotation_last_employee_id is deliberately left alone
      // here: if the pin is cleared later, a weekly rotation resumes
      // right where it left off instead of restarting from scratch.
      technicianIds = [t.fixed_assignee_employee_id];
    } else if (t.rotate_among_active_techs) {
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
      {
        title: t.title,
        notes: t.notes || null,
        technician_ids: technicianIds,
        // Lets a re-roll (routes/recurringTicketTemplates.js) find "the
        // ticket this template most recently generated" instead of
        // guessing from title + date. Every other insertTicketRow caller
        // leaves this unset, so it stays NULL for tickets nothing to do
        // with the recurring-ticket engine created.
        recurring_ticket_template_id: t.id,
      },
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

// Deliberately later than either daily template's own fire time
// (08:30/16:00) and the fleet QC sweep's (07:00 the *next* morning) — a
// Daily To-Do ticket should stay workable for the rest of the day it was
// created, not disappear out from under whoever's doing it. Not
// admin-configurable, same "background sweep, not a Settings screen"
// posture as FLEET_QC_SWEEP_TIME above.
const DAILY_TODO_ARCHIVE_TIME = '23:00';

/**
 * Once a day, archive every open 'daily_todo'-category ticket — that
 * category is a same-day catch-all (Settings -> Ticket categories'
 * "Daily To-Do's"; migration 051 also gives it its own default starting
 * status and auto-created task, see routes/tickets.js and
 * services/settings.js), so whatever's still open at day's end is done or
 * moot either way and shouldn't sit around cluttering tomorrow's queue.
 * Same shop-local-date-guarded idiom as fleetQcSweep() above, keyed off
 * its own shop_config row instead of piggybacking on that one.
 */
async function dailyTodoArchiveSweep() {
  try {
    const { rows: cfgRows } = await query(
      "SELECT meta FROM settings WHERE category = 'shop_config' AND key = 'daily_todo_archive'",
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
    if (currentHhmm < DAILY_TODO_ARCHIVE_TIME) return;
    if (lastLocalDate && lastLocalDate === today) return; // already ran today

    const { rowCount } = await query(
      "UPDATE tickets SET archived = TRUE WHERE category_key = 'daily_todo' AND archived = FALSE",
    );

    await query(
      `UPDATE settings SET meta = jsonb_set(meta, '{last_run_at}', to_jsonb(now()), true)
        WHERE category = 'shop_config' AND key = 'daily_todo_archive'`,
    );

    if (rowCount) console.log(`[daily-todo-archive] archived ${rowCount} ticket(s)`);
  } catch (err) {
    // Never let a bad sweep take the process down — same "log and move
    // on" posture as everywhere else in this file.
    console.error('[daily-todo-archive] sweep failed', err);
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
  await dailyTodoArchiveSweep();
}

function start() {
  tick(); // catch up immediately in case a target minute was missed while the process was down
  return setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = {
  start, nextRotationEmployee, fireTemplate, fleetQcSweep, dailyTodoArchiveSweep,
};
