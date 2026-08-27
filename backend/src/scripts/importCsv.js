'use strict';

/**
 * One-time migration of the Google Sheets operation into Mission Control
 * (PLAN §13).
 *
 * Usage:
 *   node src/scripts/importCsv.js [--reset] [--dry-run] [--dir <path>]
 *
 *   --reset    delete previously imported rows first (anything carrying a
 *              source_sheet, plus the fleet instruments) and re-import
 *   --dry-run  parse and report, write nothing
 *
 * The sheets are inconsistent by nature — section headers repeated mid-file,
 * year divider rows, labour-rate rows, half-typed rows. Everything skipped is
 * counted and written to import-report.json rather than silently dropped, so
 * the cutover can be checked by hand.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { pool, query, waitForDatabase } = require('../db');
const { migrate } = require('./migrate');
const { seed } = require('./seed');

const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve(__dirname, '../../../assets');

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const DRY_RUN = args.includes('--dry-run');
const dirFlag = args.indexOf('--dir');
const SOURCE_DIR = dirFlag >= 0 ? args[dirFlag + 1] : ASSETS_DIR;

const report = {
  started_at: new Date().toISOString(),
  source_dir: SOURCE_DIR,
  dry_run: DRY_RUN,
  files: {},
  created: {
    customers: 0, instruments: 0, tickets: 0, estimates: 0, parts_orders: 0, fleet: 0,
  },
  skipped: [],
  warnings: [],
};

const skip = (file, row, reason) => report.skipped.push({ file, reason, row });
const warn = (message, context) => report.warnings.push({ message, context });

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

const STATUS_MAP = {
  reservation: 'reservation',
  'not started': 'not_started',
  'in progress': 'in_progress',
  qc: 'qc',
  'invoice sent': 'invoice_sent',
  'invoice paid': 'invoice_paid',
  done: 'done',
  'on hold': 'on_hold',
};

function mapStatus(raw, file) {
  const key = clean(raw).toLowerCase();
  if (!key) return 'not_started';
  if (STATUS_MAP[key]) return STATUS_MAP[key];
  warn(`Unrecognised status '${raw}' — defaulted to Not Started`, { file });
  return 'not_started';
}

// Section headers in the instrument sheets map onto the seeded priority tiers.
function mapPriorityHeader(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return null;
  if (s.startsWith('quick setup')) return 'expedited';
  if (s.startsWith('standard setup')) return 'standard_setup';
  if (s.startsWith('custom shop')) return 'custom_shop';
  return null;
}

/**
 * Instrument family. The sheet a row came from gives a strong prior; the
 * instrument text refines it, because HOHNER + STRINGS and KOMBO each hold
 * more than one family.
 */
function classifyFamily(sheetFamily, instrumentText) {
  const s = clean(instrumentText).toLowerCase();

  if (sheetFamily === 'hohner_strings') {
    if (/clavinet|pianet|cembalet|hohner|clav\b|d6|e7/.test(s)) return 'hohner';
    return 'strings';
  }
  if (sheetFamily === 'kombo') {
    if (/organ|vox|farfisa|acetone|gibson g\d|rmi|continental|combo|hammond|leslie|philicorda|top \d/.test(s)) {
      return 'organ';
    }
    if (/amp|twin|reverb|ampeg|leslie/.test(s)) return 'amp';
    return 'rarity';
  }
  if (sheetFamily === 'job_queue') {
    if (/rhodes|mkii|mk ii|mki\b/.test(s)) return 'rhodes';
    if (/wurli|wurlitzer|206|200a|112|140/.test(s)) return 'wurlitzer';
    if (/clavinet|pianet|cembalet|hohner/.test(s)) return 'hohner';
    if (/cp-?\d|helpinstill|yamaha cp/.test(s)) return 'strings';
    if (/organ|vox|farfisa|acetone|continental|hammond/.test(s)) return 'organ';
    if (/amp|twin|reverb|ampeg/.test(s)) return 'amp';
    return 'rarity';
  }
  return sheetFamily; // rhodes | wurlitzer
}

/** m/d/yyyy -> ISO date. Anything looser (m/d, '2023?') stays unparsed. */
function parseSheetDate(raw) {
  const s = clean(raw);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const VENDOR_COLUMNS = [
  ['Shipping', 8], ['Painting', 9], ['Key Tops', 10], ['Woodshop', 11],
  ['Plastics', 12], ['Metal Fab', 13], ['Other Vendor', 14],
];

function extractVendorTracks(row) {
  const tracks = {};
  for (const [label, idx] of VENDOR_COLUMNS) {
    const v = clean(row[idx]);
    if (v && v.toLowerCase() !== 'none') tracks[label] = v;
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// Entity upserts (in-memory caches keep the import to one pass)
// ---------------------------------------------------------------------------
const customerCache = new Map();
const instrumentCache = new Map();

async function upsertCustomer(name) {
  const trimmed = clean(name);
  if (!trimmed) return null;
  const cacheKey = trimmed.toLowerCase();
  if (customerCache.has(cacheKey)) return customerCache.get(cacheKey);

  const { rows: existing } = await query(
    'SELECT id FROM customers WHERE lower(name) = $1 LIMIT 1', [cacheKey],
  );
  if (existing[0]) {
    customerCache.set(cacheKey, existing[0].id);
    return existing[0].id;
  }
  if (DRY_RUN) { customerCache.set(cacheKey, -1); report.created.customers += 1; return -1; }

  const { rows } = await query(
    "INSERT INTO customers (name, source) VALUES ($1, 'direct') RETURNING id", [trimmed],
  );
  customerCache.set(cacheKey, rows[0].id);
  report.created.customers += 1;
  return rows[0].id;
}

async function upsertInstrument({ family, model, customerId, isFleet, lastQc, notes }) {
  const trimmedModel = clean(model);
  const cacheKey = `${family}|${trimmedModel.toLowerCase()}|${customerId || 'fleet'}`;
  if (instrumentCache.has(cacheKey)) return instrumentCache.get(cacheKey);

  if (DRY_RUN) {
    instrumentCache.set(cacheKey, -1);
    report.created.instruments += 1;
    if (isFleet) report.created.fleet += 1;
    return -1;
  }
  const { rows } = await query(
    `INSERT INTO instruments (family, model, customer_id, is_fleet, fleet_last_qc, identifying_notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [family, trimmedModel || null, customerId || null, !!isFleet, lastQc || null, notes || null],
  );
  instrumentCache.set(cacheKey, rows[0].id);
  report.created.instruments += 1;
  if (isFleet) report.created.fleet += 1;
  return rows[0].id;
}

async function createTicket(t) {
  if (DRY_RUN) { report.created.tickets += 1; return -1; }
  const { rows } = await query(
    `INSERT INTO tickets (
       title, category_key, category_label_snapshot,
       priority_key, priority_label_snapshot,
       status_key, status_label_snapshot,
       instrument_id, customer_id, notes, drop_off_date,
       multi_instrument, vendor_tracks, shop_contact_raw, source_sheet, legacy_ref
     )
     SELECT $1, $2, cat.label, $3, pr.label, $4, st.label,
            $5, $6, $7, $8, $9, COALESCE($10,'{}'::jsonb), $11, $12, $13
       FROM settings cat, settings pr, settings st
      WHERE cat.category='ticket_category' AND cat.key=$2
        AND pr.category='priority_tier'    AND pr.key=$3
        AND st.category='ticket_status'    AND st.key=$4
     RETURNING id`,
    [t.title, t.category, t.priority, t.status, t.instrumentId, t.customerId,
      t.notes || null, t.dropOff || null, !!t.multi,
      t.vendorTracks ? JSON.stringify(t.vendorTracks) : null,
      t.shopContact || null, t.sourceSheet, t.legacyRef || null],
  );
  if (!rows[0]) throw new Error(`Ticket insert produced no row (bad enum key?) for '${t.title}'`);
  report.created.tickets += 1;
  return rows[0].id;
}

async function createEstimate(ticketId, hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return;
  if (DRY_RUN) { report.created.estimates += 1; return; }
  // Historical rows are pinned to the $175 rate the sheets were quoted at,
  // not the current shop rate — see JOB QUEUE.csv's labour-rate rows.
  await query(
    `INSERT INTO estimates (ticket_id, estimated_hours, labor_rate, confidence, notes)
     VALUES ($1, $2, 175.00, 'low', 'Imported from Google Sheets — Estimated Hrs column')`,
    [ticketId, n],
  );
  report.created.estimates += 1;
}

const readCsv = (file) => {
  const full = path.join(SOURCE_DIR, file);
  if (!fs.existsSync(full)) { warn(`File not found, skipped: ${file}`); return null; }
  return parse(fs.readFileSync(full, 'utf8'), { relax_column_count: true, skip_empty_lines: false });
};

// ---------------------------------------------------------------------------
// Instrument sheets: RHODES / WURLITZER / HOHNER + STRINGS / KOMBO
// ---------------------------------------------------------------------------
async function importInstrumentSheet(file, sheetFamily) {
  const rows = readCsv(file);
  if (!rows) return;
  let priority = 'standard_setup';
  let imported = 0;

  for (const row of rows) {
    const [date, status, client, instrument, multi, notes, estHours, shopContact] = row;

    // Section header ("Standard Setup (7-15hr)") — switches the priority tier.
    const headerPriority = mapPriorityHeader(date);
    if (headerPriority && !clean(status) && !clean(client)) {
      priority = headerPriority;
      continue;
    }
    // Repeated column-header row.
    if (clean(date).toLowerCase() === 'date' && clean(status).toLowerCase() === 'status') continue;
    // Blank or half-typed row: a real job always has both a client and an
    // instrument. This is what filters out rows like ",e,,ic,FALSE".
    if (!clean(client) || clean(instrument).length < 3) {
      if (row.some((c) => clean(c))) skip(file, row, 'no client or no usable instrument');
      continue;
    }

    const customerId = await upsertCustomer(client);
    const family = classifyFamily(sheetFamily, instrument);
    const instrumentId = await upsertInstrument({
      family, model: instrument, customerId, isFleet: false,
    });

    // Preserve partial dates ('1/7', '2023?') that can't become a real date.
    const dropOff = parseSheetDate(date);
    const rawDate = clean(date);
    const noteParts = [clean(notes)];
    if (rawDate && !dropOff) noteParts.push(`[sheet date: ${rawDate}]`);

    const ticketId = await createTicket({
      title: `${clean(client)} — ${clean(instrument)}`,
      category: 'servicing',
      priority,
      status: mapStatus(status, file),
      instrumentId,
      customerId,
      notes: noteParts.filter(Boolean).join(' ') || null,
      dropOff,
      multi: clean(multi).toUpperCase() === 'TRUE',
      vendorTracks: extractVendorTracks(row),
      shopContact: clean(shopContact) || null,
      sourceSheet: file,
    });
    await createEstimate(ticketId, estHours);
    imported += 1;
  }
  report.files[file] = { imported };
}

// ---------------------------------------------------------------------------
// JOB QUEUE
// ---------------------------------------------------------------------------
async function importJobQueue(file) {
  const rows = readCsv(file);
  if (!rows) return;
  let imported = 0;
  let section = { category: 'servicing', priority: 'standard_setup' };

  for (const row of rows) {
    const [assign, status, client, instrument, , dropOffRaw, notes, , shopContact, estHours] = row;

    // 'WEBCo' marks the start of a web-orders block.
    if (clean(assign).toUpperCase() === 'WEBCO') {
      section = { category: 'orders_shipping', priority: 'expedited' };
      continue;
    }
    // Year divider rows repeat the same year across several columns.
    if (/^\d{4}$/.test(clean(assign)) && clean(assign) === clean(client)) {
      section = { category: 'servicing', priority: 'standard_setup' };
      continue;
    }
    // Formatting artifacts called out in PLAN §13.
    if (/per hour labor rate/i.test(clean(assign))) continue;
    if (clean(status) === 'Select Satus') continue;
    if (clean(assign).toLowerCase() === 'choma') continue;
    if (clean(assign) === 'Key:' || clean(assign).toLowerCase() === 'assign #') continue;
    if (clean(instrument).toUpperCase() === 'WEB ORDERS & EZ TURNAROUND') continue;

    if (!clean(client) || clean(instrument).length < 3) {
      if (row.some((c) => clean(c))) skip(file, row, 'no client or no usable instrument');
      continue;
    }

    const customerId = await upsertCustomer(client);
    const family = classifyFamily('job_queue', instrument);
    const instrumentId = await upsertInstrument({
      family, model: instrument, customerId, isFleet: false,
    });

    const dropOff = parseSheetDate(dropOffRaw);
    const rawDate = clean(dropOffRaw);
    const noteParts = [clean(notes)];
    if (rawDate && !dropOff) noteParts.push(`[sheet drop-off: ${rawDate}]`);

    const ticketId = await createTicket({
      title: `${clean(client)} — ${clean(instrument)}`,
      category: section.category,
      priority: section.priority,
      status: mapStatus(status, file),
      instrumentId,
      customerId,
      notes: noteParts.filter(Boolean).join(' ') || null,
      dropOff,
      shopContact: clean(shopContact) || null,
      sourceSheet: file,
      legacyRef: /^\d+(\.\d+)?$/.test(clean(assign)) ? clean(assign) : null,
    });
    await createEstimate(ticketId, estHours);
    imported += 1;
  }
  report.files[file] = { imported };
}

// ---------------------------------------------------------------------------
// SHOWROOM QC -> CEPCo's own fleet (instruments with customer_id NULL)
// ---------------------------------------------------------------------------
const FLEET_SECTIONS = {
  RHODES: 'rhodes',
  WURLITZER: 'wurlitzer',
  'HOHNER + STRINGS': 'hohner',
  ORGANS: 'organ',
  'MELLOTRON, SYNTH, & RARITIES': 'rarity',
  AMPLIFIERS: 'amp',
};

async function importShowroomQc(file) {
  const rows = readCsv(file);
  if (!rows) return;
  let family = null;
  let imported = 0;

  for (const row of rows) {
    const [model, lastQc, notes, history] = row.map(clean);

    if (model.toLowerCase() === 'model' && lastQc.toLowerCase() === 'last qc') continue;

    const sectionKey = Object.keys(FLEET_SECTIONS)
      .find((k) => k.toLowerCase() === model.toLowerCase());
    if (sectionKey && !lastQc && !notes) { family = FLEET_SECTIONS[sectionKey]; continue; }

    if (!model) continue;
    if (!family) { skip(file, row, 'row appeared before any family section header'); continue; }

    const combinedNotes = [notes, history && `History: ${history}`].filter(Boolean).join(' | ');
    await upsertInstrument({
      family,
      model,
      customerId: null,
      isFleet: true,
      lastQc: lastQc || null,
      notes: combinedNotes || null,
    });
    imported += 1;
  }
  report.files[file] = { imported };
}

// ---------------------------------------------------------------------------
// PARTS ORDERS — eight vendor blocks laid out side by side, 3 columns each
// ---------------------------------------------------------------------------
async function importPartsOrders(file) {
  const rows = readCsv(file);
  if (!rows) return;
  const [vendorRow, ...rest] = rows;
  const dataRows = rest.slice(1); // drop the repeated Item/Notes header row

  const vendorCols = [];
  for (let col = 0; col < vendorRow.length; col += 3) {
    const name = clean(vendorRow[col]);
    if (name) vendorCols.push({ name, col });
  }

  let imported = 0;
  for (const { name, col } of vendorCols) {
    let vendorId = null;
    if (!DRY_RUN) {
      const { rows: v } = await query(
        `INSERT INTO vendors (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [name],
      );
      vendorId = v[0].id;
    }
    for (const row of dataRows) {
      const itemText = clean(row[col]);
      if (!itemText) continue;
      if (!DRY_RUN) {
        await query(
          `INSERT INTO parts_orders (vendor_id, item, notes, status)
           VALUES ($1,$2,$3,'needed')`,
          [vendorId, itemText, clean(row[col + 1]) || null],
        );
      }
      report.created.parts_orders += 1;
      imported += 1;
    }
  }
  report.files[file] = { imported };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function resetImported() {
  console.log('[import] --reset: removing previously imported rows');
  // Only rows *this script* created — source_sheet is always a CSV filename
  // here (see importInstrumentSheet/importJobQueue above). Data added later
  // by a hand-authored migration (e.g. one tagged source_sheet =
  // 'supplemental-2026-08-27') is a different provenance and must survive a
  // --reset of the original sheet cutover.
  await query("DELETE FROM tickets WHERE source_sheet LIKE '%.csv'");
  await query('DELETE FROM instruments WHERE is_fleet = TRUE');
  await query(`DELETE FROM instruments WHERE id NOT IN (
                 SELECT instrument_id FROM tickets WHERE instrument_id IS NOT NULL)`);
  await query(`DELETE FROM customers WHERE id NOT IN (
                 SELECT customer_id FROM tickets WHERE customer_id IS NOT NULL)
               AND portal_email IS NULL`);
  // Parts orders have no source_sheet column; the import only ever creates
  // 'needed' rows, so clearing those is the closest safe equivalent. Anything
  // the shop has since ordered or received is left alone.
  await query("DELETE FROM parts_orders WHERE status = 'needed'");
}

async function run() {
  await waitForDatabase();
  // The import can run against a brand-new database, so bring the schema up
  // first; the enums must then exist before any ticket can reference them.
  await migrate();
  await seed();

  // Same '%.csv' scoping as resetImported() — a supplemental migration's
  // tickets (source_sheet not ending in .csv) shouldn't make this think the
  // sheet cutover already ran.
  const { rows: guard } = await query(
    "SELECT count(*)::int AS n FROM tickets WHERE source_sheet LIKE '%.csv'",
  );
  if (guard[0].n > 0 && !RESET && !DRY_RUN) {
    console.error(
      `[import] ${guard[0].n} imported tickets already exist. `
      + 'Re-run with --reset to replace them, or --dry-run to preview.',
    );
    process.exit(1);
  }
  if (RESET && !DRY_RUN) await resetImported();

  await importInstrumentSheet('CEPCo Mission Control - RHODES.csv', 'rhodes');
  await importInstrumentSheet('CEPCo Mission Control - WURLITZER.csv', 'wurlitzer');
  await importInstrumentSheet('CEPCo Mission Control - HOHNER + STRINGS.csv', 'hohner_strings');
  await importInstrumentSheet('CEPCo Mission Control - KOMBO.csv', 'kombo');
  await importJobQueue('CEPCo Mission Control - JOB QUEUE.csv');
  await importShowroomQc('CEPCo Mission Control - SHOWROOM QC.csv');
  await importPartsOrders('CEPCo Mission Control - PARTS ORDERS.csv');

  report.finished_at = new Date().toISOString();

  const outPath = path.resolve(process.cwd(), 'import-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n--- Import summary ---');
  console.log(report.created);
  for (const [file, stats] of Object.entries(report.files)) {
    console.log(`  ${file}: ${stats.imported} row(s)`);
  }
  console.log(`  skipped rows: ${report.skipped.length}`);
  console.log(`  warnings: ${report.warnings.length}`);
  console.log(`  full report: ${outPath}`);
  if (DRY_RUN) console.log('  (dry run — nothing was written)');
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => { console.error('[import]', err); process.exit(1); });
}

module.exports = { run, classifyFamily, mapStatus, parseSheetDate };
