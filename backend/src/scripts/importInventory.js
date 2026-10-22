'use strict';

/**
 * CEPCo Inventory Log -> unified inventory (migration 072).
 *
 * Usage:
 *   node src/scripts/importInventory.js [--dry-run] [--dir <path>]
 *
 *   --dry-run  run the whole import inside a transaction, write the report,
 *              then ROLL BACK — the report is exactly what a real run would
 *              do, nothing is kept.
 *   --force    re-run even though people have already edited imported pieces
 *              in the app (sheet columns would overwrite those edits).
 *
 * Reads the five "CEPCo Inventory Log - *.csv" sheets from assets/ and:
 *
 *   * Instrument rows -> instruments (ownership shop/consignment). Sheet
 *     sections become model_group, row order becomes sort_order, so the
 *     Inventory page reads like the sheet.
 *   * "Sold ... Data Tracking" rows -> sale_status 'sold', with the buyer
 *     and serial untangled from whichever of the two drifting columns they
 *     landed in. Rows below the Sold header that have no buyer but are
 *     marked on the website ("k") are the newest stock appended at the
 *     bottom of the sheet — they import as for sale, and the report lists
 *     them.
 *   * Cases / rails / preamps / accessories / Hohner parts sections ->
 *     inventory_parts (the Parts & Accessories tab).
 *   * The old showroom/rental fleet (from the SHOWROOM QC sheet, already in
 *     the database) is matched to its inventory-log row through
 *     FLEET_MATCHES below — the matched row keeps its id, so its tickets,
 *     rentals, QC cycle and QC notes stay attached. Fleet rows with no
 *     inventory-log counterpart are kept as-is (not for sale) and grouped
 *     under "From Showroom QC sheet" for review.
 *   * Inventory purchases made through the app (instrument_purchases) are
 *     matched by serial number the same way.
 *   * Consignors are matched to existing customers by name. A consignor
 *     with no match keeps consignor_name and is listed in the report —
 *     this script never creates customers, so it never pushes contacts to
 *     Xero on its own.
 *
 * Safe to re-run: rows upsert by import_key; anything imported earlier
 * that's no longer in the sheet is reported, never deleted.
 *
 * Every judgement call is written to inventory-import-report.json.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { pool, waitForDatabase } = require('../db');
const { migrate } = require('./migrate');
const inv = require('../services/inventory');

const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve(__dirname, '../../../assets');
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const dirFlag = args.indexOf('--dir');
const SOURCE_DIR = dirFlag >= 0 ? args[dirFlag + 1] : ASSETS_DIR;

const IMPORT_SOURCE = 'inventory_log';

// ---------------------------------------------------------------------------
// Sheet layouts. Column indexes per section type; `cond` maps the sheet's
// condition columns onto services/inventory.js's CONDITION_FIELDS keys.
// ---------------------------------------------------------------------------
const RHODES_LAYOUT = {
  name: 0, year: 1, model: 2, notes: 9, price: 10, serial: 11, web: 12, paid: 13,
  cond: { case: 3, keys: 4, bushings: 5, tines: 6, hammers: 7, lid: 8 },
};
const WURLI_LAYOUT = { ...RHODES_LAYOUT, cond: { body: 3, keys: 4, bushings: 5, reeds: 6, hammers: 7, lid: 8 } };
const HOHNER_LAYOUT = {
  name: 0, year: 1, model: 2, notes: 8, price: 9, serial: 10, web: 11, paid: 12,
  cond: { cosmetics: 3, keys: 4, interior: 5, hammers: 6, veneers: 7 },
};
const COMBO_LAYOUT = {
  name: 0, model: 1, year: 2, notes: 6, price: 7, serial: 8, web: 9, paid: 10,
  cond: { cosmetics: 3, keys: 4, interior: 5 },
};
const OTHER_LAYOUT = {
  name: 0, model: 1, year: 2, submodel: 3, notes: 6, price: 7, serial: 8, paid: 9,
  cond: { cosmetics: 4, interior: 5 },
};

// Parts sections: { name, model, qty, condition, notes, price, web, paid, extra[] }
const RHODES_CASES_PARTS = {
  name: 0, year: 1, model: 2, condition: 3, qty: 4, notes: 9, price: 10, web: 11, extra: [12], paid: 13,
};
const RHODES_RAILS_PARTS = { name: 0, model: 1, qty: 2, notes: 9, price: 10 };
const WURLI_ACCESSORY_PARTS = {
  name: 0, year: 1, model: 2, condition: 8, notes: 9, price: 10, extra: [3, 4, 11], paid: 13,
};
// Hohner Parts' header labels cols 2 and 3 both "notes".
const HOHNER_PARTS = { name: 0, notes: 2, extra: [3], condition: 4, price: 5, paid: 12 };

/**
 * Per sheet: which first-column values start a section, and what kind.
 * The first row of every sheet is its first section's header.
 *   kind: instruments | sold | parts | private_dupes
 */
const SHEETS = [
  {
    key: 'rhodes',
    file: 'CEPCo Inventory Log - RHODES.csv',
    family: 'rhodes',
    layout: RHODES_LAYOUT,
    first: { group: 'Rhodes Suitcase', kind: 'instruments' },
    sections: {
      'rhodes stage': { group: 'Rhodes Stage', kind: 'instruments' },
      'rhodes rarity': { group: 'Rhodes Rarity', kind: 'instruments' },
      'extra cases & pre-amps': { group: 'Extra Cases & Pre-amps', kind: 'parts', parts: RHODES_CASES_PARTS },
      'rails & etc.': { group: 'Rails & etc.', kind: 'parts', parts: RHODES_RAILS_PARTS },
      'sold piano data tracking:': { kind: 'sold' },
    },
  },
  {
    key: 'wurlitzer',
    file: 'CEPCo Inventory Log - WURLITZER.csv',
    family: 'wurlitzer',
    layout: WURLI_LAYOUT,
    first: { group: 'Wurlitzer 200 Series', kind: 'instruments' },
    sections: {
      'specialty wurlitzer models': { group: 'Specialty Wurlitzer Models', kind: 'instruments' },
      'wurlitzer console 200 pianos': { group: 'Wurlitzer Console 200 Pianos', kind: 'instruments' },
      'wurlitzer 140/145 series': { group: 'Wurlitzer 140/145 Series', kind: 'instruments' },
      'wurlitzer 106 series': { group: 'Wurlitzer 106 Series', kind: 'instruments' },
      'wurlitzer 112/120 series': { group: 'Wurlitzer 112/120 Series', kind: 'instruments' },
      'wurlitzer accessories + upgrades + swaps': {
        group: 'Accessories + Upgrades + Swaps', kind: 'parts', parts: WURLI_ACCESSORY_PARTS,
      },
      'private collection pianos': { kind: 'private_dupes' },
      'sold piano data tracking:': { kind: 'sold' },
    },
  },
  {
    key: 'hohner',
    file: 'CEPCo Inventory Log - HOHNER.csv',
    family: 'hohner',
    layout: HOHNER_LAYOUT,
    first: { group: 'Clavinet', kind: 'instruments' },
    sections: {
      'pianets & more': { group: 'Pianets & More', kind: 'instruments' },
      'hohner parts': { group: 'Hohner Parts', kind: 'parts', parts: HOHNER_PARTS },
      'sold piano data tracking:': { kind: 'sold' },
    },
  },
  {
    key: 'combo',
    file: 'CEPCo Inventory Log - Combo Organs String Pianos.csv',
    family: 'organ',
    layout: COMBO_LAYOUT,
    first: { group: 'Farfisa Organs', kind: 'instruments' },
    sections: {
      'vox organs': { group: 'Vox Organs', kind: 'instruments' },
      'acetone organs': { group: 'Acetone Organs', kind: 'instruments' },
      'fender/gibson organs': { group: 'Fender/Gibson Organs', kind: 'instruments' },
      'other combos': { group: 'Other Combos', kind: 'instruments' },
      pianos: { group: 'Electric Grands & CP', kind: 'instruments', family: 'strings' },
      mellotrons: { group: 'Mellotrons', kind: 'instruments', family: 'other' },
      'sold organ/piano data tracking:': { kind: 'sold' },
    },
  },
  {
    key: 'other',
    file: 'CEPCo Inventory Log - Other.csv',
    family: 'other',
    layout: OTHER_LAYOUT,
    first: { group: 'Amps, Leslies & Synths', kind: 'instruments' },
    sections: {},
  },
];

// The Wurlitzer sheet's "Private Collection Pianos" block re-lists pianos
// that already appear above it. Merged into the earlier row (its value is
// kept as a note) instead of imported twice. Keys: that block's name cell.
const PRIVATE_DUPES = {
  'shop console piano w/visualizer': 'CEPCo 215V',
  'lil pumpkin': '106P "lil pumpkin"',
};

/**
 * SHOWROOM QC sheet model (what the old fleet rows carry in `model`) ->
 * the inventory-log row it is. Read by hand from both sheets:
 *   { sheet, name }   matched: name is the row's name cell (or model cell
 *                     when the name cell is blank)
 *   { maybe: [...] }  plausibly one of these, not certain — NOT merged; the
 *                     fleet row is kept and the report lists the candidates
 *   absent            no counterpart in the inventory log — kept as-is
 * Correct this table and re-run; matched rows are updated in place.
 */
const FLEET_MATCHES = {
  // Rhodes
  '71 Suitcase': { sheet: 'rhodes', name: 'Lissy' },
  '88 MKII Suitcase': { sheet: 'rhodes', name: 'Markus / GovDealZ' },
  MKV: { sheet: 'rhodes', name: 'Stahl MKV' },
  'Jetsons Rhodes': { sheet: 'rhodes', name: 'CEP JET' },
  'Sparkletop Rhodes': { sheet: 'rhodes', name: 'FrankenSparkle' },
  'Amtrak Rhodes': { sheet: 'rhodes', name: 'Amtrak Rhodes' },
  "Paulina '72": { sheet: 'rhodes', name: 'Paula' },
  'Pre Piano': { sheet: 'rhodes', name: 'Pre Piano' },
  // Wurlitzer
  '146B': { sheet: 'wurlitzer', name: 'CEPCo 146' },
  'Red 200': { sheet: 'wurlitzer', name: 'Finn Red Top' },
  'Hot Dog': { sheet: 'wurlitzer', name: 'Hot Dog' },
  '215VA': { sheet: 'wurlitzer', name: 'CEPCo 215V' },
  'Orange 106P': { maybe: ['106P E Orange', '106 E - orange'] },
  'Tan 106P': { maybe: ['106 B - tan', '106 F - tan (sold)'] },
  'Wurlitzer 112': { maybe: ['MINTY 112', 'Liberace', 'Cepco 112a'] },
  'Wurlitzer 120 (Mahogany)': { maybe: ['Lil Jess', 'Patty'] },
  // Hohner + strings
  'Proto Whammy': { sheet: 'hohner', name: 'C-bay' },
  'Museum Pianet N': { sheet: 'hohner', name: 'NOS Pianet N' },
  Cembalet: { sheet: 'hohner', name: 'Cembalet' },
  'CP-70': { maybe: ['Janet', 'Looba', 'Slope'] },
  'Helpinstill Electric Grand': { maybe: ['Oh Oh Won'] },
  'Clavinet Pianet Duo': { maybe: ['Decemberists', 'Philly Duo'] },
  // Organs
  'Vox Continental': { sheet: 'combo', name: 'CEP Conti' },
  'Acetone Top 5': { sheet: 'combo', name: 'Acetone Top 5' },
  'Acetone Top 1': { sheet: 'combo', name: 'Acetone Top 1' },
  'Howard Combo': { sheet: 'combo', name: 'CEP Howard' },
  'Rheem Kee Bass': { sheet: 'combo', name: '"Rheem Key Bass"' },
  Solina: { sheet: 'other', name: 'ARP Solina' },
  'Gibson G101': { sheet: 'combo', name: 'Gibsons G101' },
  'Gibson G201 (or Lowry?)': { sheet: 'combo', name: 'Gibson G201' },
  'Fender Contempo': { sheet: 'combo', name: 'CEPtempo' },
  'Farfisa Compact Series': { sheet: 'combo', name: 'CEP Compact' },
  'Farfisa Transicord': { maybe: ['Gioseppe', 'Falcone'] },
  'Yamaha YC 45D': { sheet: 'combo', name: 'Sherman' },
  'Yamaha YC 25D': { sheet: 'combo', name: 'Family' },
  RMI: { sheet: 'combo', name: 'Barrelhouse RMI 368X' },
  // Mellotron, synth & rarities
  'Mellotron M4000D': { sheet: 'other', name: 'Mellotron M4000D' },
  'Mellotron M400': { sheet: 'combo', name: 'Cep Shop Mellotron' },
  Optigan: { sheet: 'combo', name: 'Ceptigan' },
  MiniMoog: { sheet: 'other', name: 'MiniMoog Model D RI' },
  'Wurlitzer Sideman': { maybe: ['Buddy', 'Richter'] },
  'Phillips Philicorda': { sheet: 'combo', name: 'Philicorda B' },
  'Farfisa Syntacordian': { sheet: 'combo', name: 'Gary' },
  // Amplifiers
  'RI Twin Reverb x2': { sheet: 'other', name: 'Twin Reverb RI x3' },
  'Fender Twin Reverb (Silverface 15")': { sheet: 'other', name: 'Twin Reverb 15"' },
  'Ampeg B15': { sheet: 'other', name: 'Ampeg B15N' },
  'Ampeg Gemini II (CEPCo)': { sheet: 'other', name: 'Ampeg Gemini II' },
  'Farfisa Leslie': { sheet: 'other', name: 'Farfisa Leslie' },
  'Leslie 122': { maybe: ['Revy', 'Donald'] },
};

/**
 * Consignors, read by hand from the notes/paid columns (they're written a
 * dozen different ways: "Consignment with Rodney Tapp", "Lisa Rollins
 * consign 25%", "(Aakash Consign)"). Key: `${sheet}|${name cell}`.
 * Rows detected as consignments but missing here still import as
 * consignments, with no consignor — the report lists them.
 */
const CONSIGNORS = {
  'rhodes|Rodney': 'Rodney Tapp',
  'rhodes|David Scott (Poppy)': 'David Scott',
  'rhodes|GT MKII 88 - WRONG LINK': 'Graham Thompson',
  'rhodes|"Fribush" Jetson': 'Sam Fribush',
  'rhodes|Dynamic (Aakash Consign)': 'Aakash',
  'rhodes|Rick Walnut': 'Rick',
  'rhodes|Chris W.': 'Chris W.',
  'rhodes|Greg H "Heaphnote" or GENE': 'Greg Heaphy',
  'rhodes|Barbarella': 'Barb Wertico',
  'rhodes|L Rollins': 'Lisa Rollins',
  'wurlitzer|Graham Thompson "GT"': 'Graham Thompson',
  'wurlitzer|L.R.C': 'Lisa Rollins',
  'wurlitzer|Hemb': 'Bryan Hembree',
  'wurlitzer|Todd 200a': 'Todd',
  'wurlitzer|Consignment: Mark Nagy': 'Mark Nagy',
  'wurlitzer|Dave "Revolution"': 'Dave',
  'hohner|Stanley V': 'Stanley V',
  'hohner|Vijay': 'Vijay',
  'hohner|Wheaties': 'Steve W',
  'hohner|Todd E7': 'Todd',
  'hohner|Kowalski': 'Kowalski',
  'hohner|Liz B Consignment': 'Lizz Bell',
  'combo|ConsignTempo': 'Brian Gay',
  'combo|Atevich': 'Alex Atevich',
  'combo|Ranson': 'Ben Ranson',
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const report = {
  started_at: new Date().toISOString(),
  source_dir: SOURCE_DIR,
  dry_run: DRY_RUN,
  counts: {
    instruments_created: 0,
    instruments_updated: 0,
    fleet_rows_merged: 0,
    purchases_merged: 0,
    parts_created: 0,
    parts_updated: 0,
    sold: 0,
    consignments: 0,
  },
  sheets: {},
  fleet_merged: [],
  fleet_kept_unmatched: [],
  fleet_possible_matches: [],
  fleet_match_target_missing: [],
  purchases_unmatched: [],
  listed_below_sold_header: [],
  sold_buyer_unknown: [],
  consignors_linked: [],
  consignors_unlinked: [],
  consignments_without_consignor: [],
  buyers_linked: 0,
  possible_duplicates: [],
  private_collection_merged: [],
  previously_imported_not_in_sheet: [],
  warnings: [],
};
const warn = (message, context) => report.warnings.push({ message, ...context });

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------
const clean = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const cell = (row, idx) => (idx === undefined ? '' : clean(row[idx]));
const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** `"Ralph 2"` (whole cell quoted) -> `Ralph 2`; inner quotes are kept. */
function cleanName(raw) {
  let s = clean(raw);
  if (/^"[^"]+"$/.test(s)) s = s.slice(1, -1).trim();
  if (s === '?' || s === '') return null;
  return s;
}

const isYearish = (s) => /\d|\?/.test(s) || /^(mid|late|early)\b/i.test(s);
const PLACEHOLDER = /^(n\/?a|na|\?+|none|removed|no serial plate|tbd)$/i;
const looksSerial = (s) => /\d/.test(s) && !/[a-z]{3,}\s+[a-z]{2,}/i.test(s);
const looksPerson = (s) => /[a-z]{2,}/i.test(s) && !/\d{3,}/.test(s) && !/^(k|m|nfs)$/i.test(s);
const WEB_MARK = /^(k|m)$/i;

/** `^[~$]?number` -> number, refusing "25% consign" and "3 hours labor". */
function leadingAmount(s) {
  const m = clean(s).replace(/,/g, '').match(/^[~$]?\s*\$?(\d+(?:\.\d+)?)\s*(k\b)?(?!\s*(%|hours?|hrs?)\b)/i);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}
const isPlainAmount = (s) => /^\$?\s*[\d,]+(\.\d+)?$/.test(clean(s));

/**
 * Price cell -> status + number. "NFS - Private Collection" is a status,
 * "7750 w tolex" is a price with a note, "SHELBY COLLAB" is just a note.
 */
function parsePrice(raw) {
  const s = clean(raw);
  const out = {
    sale_status: 'available', nfs_reason: null, asking_price: null, price_note: null,
  };
  if (!s) return out;
  if (/\bnfs\b/i.test(s)) {
    out.sale_status = 'not_for_sale';
    const reason = s.replace(/\bnfs\b/i, '').replace(/^[\s\-–/]+|[\s\-–/]+$/g, '');
    out.nfs_reason = reason || null;
    const amount = inv.parseMoney(reason);
    if (amount !== null) { out.asking_price = amount; out.nfs_reason = reason.replace(/\$?[\d,.]+/, '').trim() || null; }
    return out;
  }
  if (/^parts$/i.test(s)) {
    out.sale_status = 'not_for_sale';
    out.nfs_reason = 'Parts donor';
    return out;
  }
  out.asking_price = /\d/.test(s) ? inv.parseMoney(s) : null;
  if (!isPlainAmount(s)) out.price_note = s;
  return out;
}

function parsePaid(raw) {
  const s = clean(raw);
  if (!s || s === '?') return { cost_paid: null, cost_note: s === '?' ? '?' : null };
  return { cost_paid: leadingAmount(s), cost_note: isPlainAmount(s) ? null : s };
}

const HOLD_RE = /\b(?:on\s+)?hold\s+for\s+([^.;|]+)/i;
const CONSIGN_RE = /consign|cnsn|commish/i;

function consignmentRate(text) {
  const m = text.match(/(\d{1,2})\s*%/);
  return m ? Number(m[1]) : null;
}

/** Notes column cleanup: the Other sheet's bare "LLC"/"MM" initials. */
function cleanNotes(s, sheetKey) {
  let n = clean(s);
  if (sheetKey === 'other') n = n.replace(/^(LLC|MM)\.?\s*/i, '');
  return n || null;
}

/**
 * The sold sections' serial/buyer columns drift: sometimes the buyer is in
 * the serial column, sometimes both are in one cell ("2089 - Ryan Lewis"),
 * sometimes it's only in the notes ("sold to jordan gensler"). Classify
 * every candidate token instead of trusting the column.
 */
function untangleSold(row, layout, notes) {
  const tokens = [];
  for (const idx of [layout.serial, layout.web]) {
    const v = cell(row, idx);
    if (!v) continue;
    for (const t of v.split(/\s+-\s+/)) tokens.push(clean(t));
  }
  let serial = null;
  let buyer = null;
  let webMarked = false;
  const leftovers = [];
  for (const t0 of tokens) {
    const t = t0.replace(/^sold to\s+/i, '');
    if (WEB_MARK.test(t)) { webMarked = true; continue; }
    if (PLACEHOLDER.test(t)) continue;
    if (!serial && looksSerial(t)) serial = t;
    else if (!buyer && looksPerson(t)) buyer = t;
    else leftovers.push(t);
  }
  if (!buyer && notes) {
    const m = notes.match(/sold to\s+([^.;,]+)/i);
    if (m) buyer = clean(m[1]);
  }
  return {
    serial, buyer, webMarked, leftovers,
  };
}

function guessSoldFamily(sheet, model) {
  if (sheet.key !== 'combo') return sheet.family;
  if (/cp\s?-?\s?\d|helpin|piano/i.test(model)) return 'strings';
  if (/mellotron|optigan/i.test(model)) return 'other';
  return 'organ';
}

// ---------------------------------------------------------------------------
// Parsing — sheet rows -> plain records (no database)
// ---------------------------------------------------------------------------
function parseInstrumentRow(sheet, section, row, rowNumber, family) {
  const L = sheet.layout;
  const nameCell = clean(row[L.name]);
  const nickname = cleanName(nameCell);
  let model = cell(row, L.model);
  if (L.submodel !== undefined) {
    const sub = cell(row, L.submodel);
    if (sub && !model.toLowerCase().includes(sub.toLowerCase())) model = `${model} ${sub}`.trim();
  }
  let year = cell(row, L.year) || null;
  let notes = cleanNotes(cell(row, L.notes), sheet.key);
  if (year && !isYearish(year)) { notes = [year, notes].filter(Boolean).join('; '); year = null; }

  const condition = {};
  for (const [key, idx] of Object.entries(L.cond)) {
    const v = cell(row, idx);
    if (v) condition[key] = v;
  }

  const price = parsePrice(cell(row, L.price));
  const paid = parsePaid(cell(row, L.paid));
  const rec = {
    sheet: sheet.key,
    row_number: rowNumber,
    name_cell: nameCell,
    family,
    nickname,
    model: model || null,
    year,
    serial_no: null,
    condition,
    identifying_notes: notes,
    model_group: section.group || null,
    ownership: 'shop',
    ...price,
    ...paid,
    hold_for: null,
    on_website: false,
    consignor_name: null,
    consignment_rate: null,
    sold_at: null,
    sold_price: null,
    sold_to_name: null,
    import_raw: { sheet: sheet.file, row: rowNumber, section: section.group || section.kind, cells: row },
  };

  if (section.kind === 'sold') {
    const u = untangleSold(row, L, notes);
    rec.serial_no = u.serial;
    if (u.leftovers.length) rec.identifying_notes = [notes, ...u.leftovers].filter(Boolean).join('; ');
    if (!u.buyer && u.webMarked) {
      // Appended below the Sold header but still listed and nobody bought
      // it: current stock, not history.
      rec.on_website = true;
      rec.model_group = 'Recently added';
      const hold = [notes, cell(row, L.paid)].join(' | ').match(HOLD_RE);
      if (hold && rec.sale_status === 'available') { rec.sale_status = 'on_hold'; rec.hold_for = clean(hold[1]); }
      report.listed_below_sold_header.push({ sheet: sheet.key, row: rowNumber, name: nameCell, model });
    } else {
      rec.sale_status = 'sold';
      rec.nfs_reason = null;
      rec.sold_price = rec.asking_price;
      rec.sold_to_name = u.buyer;
      if (!u.buyer) report.sold_buyer_unknown.push({ sheet: sheet.key, row: rowNumber, name: nameCell, model });
    }
  } else {
    const serial = cell(row, L.serial);
    if (serial && !PLACEHOLDER.test(serial)) rec.serial_no = serial;
    else if (serial && !/^n\/?a$/i.test(serial)) {
      rec.identifying_notes = [notes, `Serial: ${serial}`].filter(Boolean).join('; ');
    }
    rec.on_website = WEB_MARK.test(cell(row, L.web));
    const hold = [nameCell, notes, cell(row, L.paid), cell(row, L.price)].join(' | ').match(HOLD_RE);
    if (hold && rec.sale_status !== 'not_for_sale') { rec.sale_status = 'on_hold'; rec.hold_for = clean(hold[1]); }
    // A parts donor with no price is not stock for sale.
    // ("Use Donor 69?" on a playable piece is not this — only "parts",
    // "parts donor", "donor or ...", or a row named "Donor ...".)
    if (rec.sale_status === 'available' && rec.asking_price === null
      && (/\bparts\b|\bdonor or\b/i.test(`${model} ${notes || ''}`) || /^donor\b/i.test(nameCell))) {
      rec.sale_status = 'not_for_sale';
      rec.nfs_reason = 'Parts donor';
    }
  }

  const consignText = [nameCell, notes, cell(row, L.paid), cell(row, L.price)].join(' | ');
  if (CONSIGN_RE.test(consignText)) {
    rec.ownership = 'consignment';
    rec.consignment_rate = consignmentRate(consignText);
    rec.consignor_name = CONSIGNORS[`${sheet.key}|${nameCell}`] || null;
    // "consign" in the paid column isn't a cost.
    if (CONSIGN_RE.test(cell(row, L.paid)) && rec.cost_paid !== null && !/payout|payed|paid/i.test(cell(row, L.paid))) {
      rec.cost_paid = null;
    }
    if (!rec.consignor_name) {
      report.consignments_without_consignor.push({ sheet: sheet.key, row: rowNumber, name: nameCell, text: consignText });
    }
  }
  return rec;
}

function parsePartRow(sheet, section, row, rowNumber) {
  const P = section.parts;
  const name = cleanName(cell(row, P.name)) || cell(row, P.model);
  const qtyRaw = cell(row, P.qty);
  let quantity = null;
  let quantityNote = null;
  if (qtyRaw) {
    const m = qtyRaw.match(/^~?\s*(\d+)$/);
    if (m) { quantity = Number(m[1]); if (qtyRaw.startsWith('~')) quantityNote = qtyRaw; } else quantityNote = qtyRaw;
  }
  let notes = cell(row, P.notes) || null;
  const extras = (P.extra || []).map((i) => cell(row, i)).filter((v) => v && !WEB_MARK.test(v));
  const year = cell(row, P.year);
  if (year) extras.unshift(`Year: ${year}`);
  if (extras.length) notes = [notes, ...extras].filter(Boolean).join('; ');
  if (!quantity && notes) {
    const m = notes.match(/(\d+)\s*(?:-\s*(\d+))?\s*available/i);
    if (m) { quantity = Number(m[1]); quantityNote = m[0]; }
  }
  const priceRaw = cell(row, P.price);
  const forSale = !/\bnfs\b/i.test(priceRaw);
  const price = /\d/.test(priceRaw) ? inv.parseMoney(priceRaw) : null;
  const paid = parsePaid(cell(row, P.paid));
  const model = cell(row, P.model);
  return {
    sheet: sheet.key,
    row_number: rowNumber,
    family: section.family || sheet.family,
    category: section.group,
    name,
    model: model && model !== name ? model : null,
    quantity,
    quantity_note: quantityNote,
    condition: cell(row, P.condition) || null,
    price,
    price_note: priceRaw && !isPlainAmount(priceRaw) ? priceRaw : null,
    for_sale: forSale,
    on_website: WEB_MARK.test(cell(row, P.web)),
    cost_paid: paid.cost_paid,
    cost_note: paid.cost_note,
    notes,
    import_raw: { sheet: sheet.file, row: rowNumber, section: section.group, cells: row },
  };
}

function parseSheet(sheet) {
  const full = path.join(SOURCE_DIR, sheet.file);
  if (!fs.existsSync(full)) {
    warn(`Sheet not found, skipped: ${sheet.file}`);
    return { instruments: [], parts: [], privateDupes: [] };
  }
  const rows = parse(fs.readFileSync(full, 'utf8'), { relax_column_count: true, skip_empty_lines: false, bom: true });
  const out = { instruments: [], parts: [], privateDupes: [] };
  let section = sheet.first;
  let order = 0;
  const stats = { rows: 0, instruments: 0, sold: 0, parts: 0, skipped_blank: 0 };

  rows.forEach((row, i) => {
    const rowNumber = i + 1; // 1-based, matches the sheet
    if (i === 0) return; // header row of the first section
    const first = clean(row[0]).toLowerCase();
    if (sheet.sections[first] !== undefined) { section = sheet.sections[first]; return; }
    if (!row.some((c) => clean(c))) { stats.skipped_blank += 1; return; }
    // A row with only a name and nothing else ("Janus Power Amps") is
    // still a thing on the shelf — keep it.
    stats.rows += 1;
    order += 10;

    if (section.kind === 'parts') {
      const rec = parsePartRow(sheet, section, row, rowNumber);
      rec.sort_order = order;
      out.parts.push(rec);
      stats.parts += 1;
      return;
    }
    if (section.kind === 'private_dupes') {
      out.privateDupes.push({ row, rowNumber });
      return;
    }
    const family = section.kind === 'sold'
      ? guessSoldFamily(sheet, cell(row, sheet.layout.model))
      : section.family || sheet.family;
    const rec = parseInstrumentRow(sheet, section, row, rowNumber, family);
    if (!rec.nickname && !rec.model) { stats.rows -= 1; return; }
    rec.sort_order = order;
    out.instruments.push(rec);
    if (rec.sale_status === 'sold') stats.sold += 1; else stats.instruments += 1;
  });
  report.sheets[sheet.key] = stats;
  return out;
}

// ---------------------------------------------------------------------------
// Database apply
// ---------------------------------------------------------------------------
const INSTRUMENT_COLS = [
  'family', 'nickname', 'model', 'year', 'serial_no', 'condition', 'identifying_notes', 'model_group',
  'ownership', 'sale_status', 'nfs_reason', 'hold_for', 'asking_price', 'price_note', 'cost_paid',
  'cost_note', 'on_website', 'consignor_name', 'consignment_rate', 'sold_at', 'sold_price',
  'sold_to_name', 'sort_order', 'import_source', 'import_key', 'import_raw',
];
const PART_COLS = [
  'family', 'category', 'name', 'model', 'quantity', 'quantity_note', 'condition', 'price', 'price_note',
  'for_sale', 'on_website', 'cost_paid', 'cost_note', 'notes', 'sort_order', 'import_source',
  'import_key', 'import_raw',
];

const normName = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normSerial = (s) => clean(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function assignKeys(records, prefix, keyFn) {
  const seen = new Map();
  for (const r of records) {
    const base = `${prefix}:${r.sheet}:${keyFn(r)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    r.import_key = n === 1 ? base : `${base}#${n}`;
    r.import_source = IMPORT_SOURCE;
  }
}

async function buildCustomerIndex(client) {
  const { rows } = await client.query('SELECT id, name FROM customers');
  const byName = new Map();
  for (const c of rows) {
    const k = normName(c.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  return {
    /** Exact (case/punctuation-insensitive) name match, only if unique. */
    find(name) {
      const hits = byName.get(normName(name)) || [];
      return hits.length === 1 ? hits[0] : null;
    },
    ambiguous(name) { return (byName.get(normName(name)) || []).length > 1; },
  };
}

async function upsertInstrument(client, rec, targetId) {
  const values = INSTRUMENT_COLS.map((c) => (c === 'condition' || c === 'import_raw'
    ? JSON.stringify(rec[c] ?? (c === 'condition' ? {} : null)) : rec[c] ?? null));
  if (targetId) {
    // Matched to an existing row (re-run, old fleet, or app purchase):
    // sheet values win for the sheet's columns; everything the app owns
    // (QC cycle, qc_notes, photos, cover, customer link already set by hand)
    // is left alone. customer_id is only filled, never overwritten.
    await client.query(
      `UPDATE instruments SET ${INSTRUMENT_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')},
              customer_id = COALESCE(customer_id, $${INSTRUMENT_COLS.length + 2}),
              sold_to_customer_id = COALESCE(sold_to_customer_id, $${INSTRUMENT_COLS.length + 3})
        WHERE id = $1`,
      [targetId, ...values, rec.customer_id || null, rec.sold_to_customer_id || null],
    );
    report.counts.instruments_updated += 1;
    return targetId;
  }
  const { rows } = await client.query(
    `INSERT INTO instruments (${INSTRUMENT_COLS.join(', ')}, customer_id, sold_to_customer_id)
     VALUES (${INSTRUMENT_COLS.map((_, i) => `$${i + 1}`).join(', ')},
             $${INSTRUMENT_COLS.length + 1}, $${INSTRUMENT_COLS.length + 2}) RETURNING id`,
    [...values, rec.customer_id || null, rec.sold_to_customer_id || null],
  );
  report.counts.instruments_created += 1;
  return rows[0].id;
}

async function apply(client, parsed) {
  const instruments = parsed.flatMap((p) => p.instruments);
  const parts = parsed.flatMap((p) => p.parts);

  // --- Private-collection re-listings: fold into the row they repeat. ---
  for (const p of parsed) {
    for (const { row, rowNumber } of p.privateDupes) {
      const name = clean(row[0]);
      const targetName = PRIVATE_DUPES[name.toLowerCase()];
      const target = targetName && instruments.find((r) => r.sheet === 'wurlitzer' && r.name_cell === targetName);
      if (!target) {
        warn('Private Collection row with no known original — skipped', { row: rowNumber, name });
        continue;
      }
      const value = clean(row[10]);
      target.identifying_notes = [target.identifying_notes, value && `Private collection value: ${value}`]
        .filter(Boolean).join('; ');
      if (target.sale_status === 'not_for_sale' && !target.nfs_reason) target.nfs_reason = 'Private Collection';
      report.private_collection_merged.push({ row: rowNumber, name, merged_into: targetName });
    }
  }

  assignKeys(instruments, IMPORT_SOURCE, (r) => [slug(r.name_cell), slug(r.model), slug(r.serial_no)].join('|'));
  assignKeys(parts, 'parts', (r) => [slug(r.category), slug(r.name), slug(r.model)].join('|'));

  // --- Customers: consignors and buyers. Never created here. ---
  const customers = await buildCustomerIndex(client);
  for (const r of instruments) {
    if (r.ownership === 'consignment') {
      report.counts.consignments += 1;
      if (r.consignor_name) {
        const c = customers.find(r.consignor_name);
        if (c) {
          r.customer_id = c.id;
          report.consignors_linked.push({ name: r.consignor_name, customer_id: c.id, piece: r.name_cell });
        } else {
          report.consignors_unlinked.push({
            name: r.consignor_name, piece: r.name_cell,
            reason: customers.ambiguous(r.consignor_name) ? 'several customers have this name' : 'no customer with this name',
          });
        }
      }
    }
    if (r.sale_status === 'sold') {
      report.counts.sold += 1;
      const c = r.sold_to_name && customers.find(r.sold_to_name);
      if (c) { r.sold_to_customer_id = c.id; report.buyers_linked += 1; }
    }
  }

  // --- Existing shop-held rows the sheet should land on. ---
  const { rows: existing } = await client.query(
    `SELECT i.id, i.family, i.model, i.nickname, i.serial_no, i.import_key, i.import_source,
            EXISTS (SELECT 1 FROM instrument_purchases p WHERE p.instrument_id = i.id) AS purchased
       FROM instruments i WHERE i.ownership <> 'customer'`,
  );
  const byImportKey = new Map(existing.filter((e) => e.import_key).map((e) => [e.import_key, e]));
  const claimed = new Set();
  const targetFor = new Map(); // record -> existing id

  for (const r of instruments) {
    const hit = byImportKey.get(r.import_key);
    if (hit) { targetFor.set(r, hit.id); claimed.add(hit.id); }
  }

  // Old fleet rows: never imported by this script, carry the SHOWROOM QC
  // model string. (After a first run they have import keys and the
  // byImportKey pass above already handled them.)
  const fleetRows = existing.filter((e) => !e.import_source && !e.purchased);
  for (const f of fleetRows) {
    const match = FLEET_MATCHES[clean(f.model)];
    if (match && match.sheet) {
      const target = instruments.find((r) => r.sheet === match.sheet
        && (r.name_cell === match.name || (!r.nickname && r.model === match.name)));
      if (!target) {
        report.fleet_match_target_missing.push({ fleet_model: f.model, expected: match });
        continue;
      }
      if (targetFor.has(target)) {
        warn('Two fleet rows map to the same inventory row — second kept separately', { fleet_model: f.model, target: match.name });
        continue;
      }
      targetFor.set(target, f.id);
      claimed.add(f.id);
      report.counts.fleet_rows_merged += 1;
      report.fleet_merged.push({ id: f.id, fleet_model: f.model, now: target.name_cell || target.model });
    } else if (match && match.maybe) {
      report.fleet_possible_matches.push({ id: f.id, fleet_model: f.model, maybe: match.maybe });
    }
  }

  // App-entered purchases: match on serial within the family.
  for (const e of existing.filter((x) => x.purchased && !claimed.has(x.id))) {
    const s = normSerial(e.serial_no);
    const target = s.length >= 4 && instruments.find((r) => !targetFor.has(r)
      && r.family === e.family && normSerial(r.serial_no) === s);
    if (target) {
      targetFor.set(target, e.id);
      claimed.add(e.id);
      report.counts.purchases_merged += 1;
    } else {
      report.purchases_unmatched.push({ id: e.id, family: e.family, model: e.model, serial_no: e.serial_no });
    }
  }

  // --- Write instruments ---
  for (const r of instruments) {
    // eslint-disable-next-line no-await-in-loop
    await upsertInstrument(client, r, targetFor.get(r));
  }

  // Fleet rows left over: no inventory-log counterpart. Kept, grouped.
  for (const f of fleetRows.filter((x) => !claimed.has(x.id))) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `UPDATE instruments SET model_group = 'From Showroom QC sheet',
              import_source = 'showroom_qc', import_key = $2
        WHERE id = $1`,
      [f.id, `showroom_qc:${f.id}`],
    );
    report.fleet_kept_unmatched.push({ id: f.id, model: f.model });
  }

  // Previously imported, no longer in the sheet: report, never delete.
  const liveKeys = new Set(instruments.map((r) => r.import_key));
  for (const e of existing) {
    if (e.import_source === IMPORT_SOURCE && !liveKeys.has(e.import_key)) {
      report.previously_imported_not_in_sheet.push({ id: e.id, import_key: e.import_key, model: e.model });
    }
  }

  // --- Parts ---
  const { rows: existingParts } = await client.query(
    'SELECT id, import_key FROM inventory_parts WHERE import_key IS NOT NULL',
  );
  const partByKey = new Map(existingParts.map((p) => [p.import_key, p.id]));
  for (const p of parts) {
    const values = PART_COLS.map((c) => (c === 'import_raw' ? JSON.stringify(p[c]) : p[c] ?? null));
    const id = partByKey.get(p.import_key);
    if (id) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE inventory_parts SET ${PART_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...values],
      );
      report.counts.parts_updated += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO inventory_parts (${PART_COLS.join(', ')})
         VALUES (${PART_COLS.map((_, i) => `$${i + 1}`).join(', ')})`,
        values,
      );
      report.counts.parts_created += 1;
    }
  }

  // --- Possible duplicates: same piece listed twice across/within sheets. ---
  const dupKey = (r) => normName((r.nickname || '').replace(/\b(cepco|cep|106p?)\b/gi, ''));
  const groups = new Map();
  for (const r of instruments.filter((x) => x.sale_status !== 'sold' && x.nickname)) {
    const k = dupKey(r);
    if (k.length < 3) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(`${r.sheet}: ${r.name_cell} (${r.model || '?'})`);
  }
  for (const [k, list] of groups) if (list.length > 1) report.possible_duplicates.push({ key: k, rows: list });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function run() {
  await waitForDatabase();
  await migrate();

  // Once the shop is editing inventory in the app, the sheet is no longer
  // the source of truth — a re-run would quietly put old prices/statuses
  // back. Refuse unless asked explicitly (dry runs are always fine).
  if (!DRY_RUN && !FORCE) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM instrument_events ev
         JOIN instruments i ON i.id = ev.instrument_id
        WHERE ev.employee_id IS NOT NULL AND i.import_source = $1`,
      [IMPORT_SOURCE],
    );
    if (rows[0].n > 0) {
      console.error(`[import-inventory] ${rows[0].n} edit(s) have been made in the app to imported pieces. `
        + 'Re-importing would overwrite them with the sheet. Use --dry-run to preview, or --force to do it anyway.');
      process.exit(1);
    }
  }

  const parsed = SHEETS.map(parseSheet);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await apply(client, parsed);
    if (DRY_RUN) await client.query('ROLLBACK');
    else await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  report.finished_at = new Date().toISOString();
  const outPath = path.resolve(process.cwd(), 'inventory-import-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n--- Inventory import ---');
  console.log(report.counts);
  for (const [k, s] of Object.entries(report.sheets)) console.log(`  ${k}:`, s);
  const n = (k) => report[k].length;
  console.log(`  old fleet merged: ${n('fleet_merged')}, kept unmatched: ${n('fleet_kept_unmatched')}, `
    + `possible matches to check: ${n('fleet_possible_matches')}`);
  console.log(`  listed below the Sold header (imported as for sale): ${n('listed_below_sold_header')}`);
  console.log(`  consignors linked: ${n('consignors_linked')}, unlinked: ${n('consignors_unlinked')}, `
    + `consignments with no consignor: ${n('consignments_without_consignor')}`);
  console.log(`  possible duplicates: ${n('possible_duplicates')}, warnings: ${n('warnings')}`);
  console.log(`  full report: ${outPath}`);
  if (DRY_RUN) console.log('  (dry run — rolled back, nothing was written)');
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => { console.error('[import-inventory]', err); process.exit(1); });
}

module.exports = {
  run, parseSheet, parsePrice, parsePaid, untangleSold, SHEETS, FLEET_MATCHES,
};
