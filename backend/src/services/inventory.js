'use strict';

/**
 * Shared vocabulary for the unified inventory (migration 072) — used by
 * routes/inventory.js and scripts/importInventory.js, and served to the
 * frontend through GET /api/inventory/meta so the two never drift.
 */

const { FAMILIES } = require('../routes/instruments');

const OWNERSHIPS = ['shop', 'consignment']; // 'customer' exists too, but isn't inventory
const SALE_STATUSES = ['available', 'on_hold', 'not_for_sale', 'sold'];

// Where a consignment deal stands (migration 075). NULL = not recorded.
// Order is the deal's lifecycle; the Consignments view groups by it, with
// payout_due first since that's money the shop owes.
const CONSIGNMENT_STATUSES = ['contracted', 'for_sale', 'payout_due', 'paid_out'];
const CONSIGNMENT_STATUS_LABELS = {
  contracted: 'Contracted',
  for_sale: 'For sale',
  payout_due: 'Payout due',
  paid_out: 'Paid out',
};

const SALE_STATUS_LABELS = {
  available: 'For sale',
  on_hold: 'On hold',
  not_for_sale: 'Not for sale',
  sold: 'Sold',
};

// Condition grades (migration 084): one fixed scale, worst to best, picked
// from a dropdown. instruments.condition stores the key per field;
// anything that isn't a grade ("OG Cube", "light scratches") lives beside
// it in instruments.condition_notes under the same field key.
const CONDITION_GRADES = [
  { key: 'poor', label: 'Poor' },
  { key: 'good', label: 'Good' },
  { key: 'very_good', label: 'Very Good' },
  { key: 'excellent', label: 'Excellent' },
  { key: 'near_mint', label: 'Near Mint' },
  { key: 'mint', label: 'Mint' },
];
const GRADE_KEYS = new Set(CONDITION_GRADES.map((g) => g.key));

// Per-family condition columns, in the order the Inventory Log sheets use,
// plus Hardware on every family (Nov 2026). Keys are what's stored in
// instruments.condition / condition_notes; labels are the sheet's own column
// headers. Any key not listed here is still kept and shown -- this list
// drives the columns, it doesn't police the data.
const HARDWARE = { key: 'hardware', label: 'Hardware' };
const CONDITION_FIELDS = {
  rhodes: [
    { key: 'case', label: 'Tolex/Case' }, { key: 'keys', label: 'Keys' },
    { key: 'bushings', label: 'Bushings' }, { key: 'tines', label: 'Tines' },
    { key: 'hammers', label: 'Hammers' }, { key: 'lid', label: 'Lid' }, HARDWARE,
  ],
  wurlitzer: [
    { key: 'body', label: 'Tolex/Body' }, { key: 'keys', label: 'Keys' },
    { key: 'bushings', label: 'Bushings' }, { key: 'reeds', label: 'Reeds' },
    { key: 'hammers', label: 'Hammers' }, { key: 'lid', label: 'Lid' }, HARDWARE,
  ],
  hohner: [
    { key: 'cosmetics', label: 'Cosmetics' }, { key: 'keys', label: 'Keys' },
    { key: 'interior', label: 'Interior' }, { key: 'hammers', label: 'Hammers' },
    { key: 'veneers', label: 'Veneers' }, HARDWARE,
  ],
  strings: [
    { key: 'cosmetics', label: 'Cosmetics' }, { key: 'keys', label: 'Keys' },
    { key: 'interior', label: 'Interior' }, HARDWARE,
  ],
  // Kombo+ (migration 083): the old Combo Organ columns. Keys is blank for
  // an amp or a Leslie, which is fine -- an empty grade just isn't shown.
  kombo: [
    { key: 'cosmetics', label: 'Cosmetics' }, { key: 'keys', label: 'Keys' },
    { key: 'interior', label: 'Interior' }, HARDWARE,
  ],
};

// The sheet's free-text grades -> { grade, note }, for the importer. The
// same rules as migration 084's pg_temp.split_grade (which converted what
// was already imported) -- keep the two in step. Only a grade at the start
// counts ("VG (light scratches)" -> very_good + "light scratches"); a
// plain grade word running into more words is describing something, so the
// note keeps the whole phrase ("rough top, otherwise nice" -> poor + all of
// it); no grade at the start -> the whole text is the note. Fair -> poor
// and New -> mint, the shop's call; ranges ("VG-EX") take the lower grade.
const GRADE_WORDS = '(near mint|very good|excellent|mint|good|fair|poor|bad|rough|new|nm|ex|vg|m|g|f)';
const GRADE_RE = new RegExp(`^${GRADE_WORDS}(?![a-z0-9])(?:\\s*[-/]\\s*${GRADE_WORDS}(?![a-z0-9]))?([+-]?)(\\s*)(.*)$`, 'is');
const GRADE_OF = {
  mint: 'mint', m: 'mint', new: 'mint',
  'near mint': 'near_mint', nm: 'near_mint',
  excellent: 'excellent', ex: 'excellent',
  'very good': 'very_good', vg: 'very_good',
  good: 'good', g: 'good',
  fair: 'poor', f: 'poor', poor: 'poor', bad: 'poor', rough: 'poor',
};
function splitGrade(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { grade: null, note: null };
  const m = GRADE_RE.exec(s);
  if (!m) return { grade: null, note: s };
  const word = m[1].toLowerCase();
  const grade = GRADE_OF[word];
  if (word.length > 2 && word !== 'mint' && m[3] === '' && m[4] !== '' && /^[a-z0-9]/i.test(m[5])) {
    return { grade, note: s };
  }
  let rest = m[5].replace(/^[\s,;:./-]+/, '');
  if (/^\(.*\)$/s.test(rest)) rest = rest.slice(1, -1);
  rest = rest.trim();
  return { grade, note: rest || null };
}

// Quick-picks only — both fields are free text.
const NFS_REASON_PRESETS = ['Floor', 'Rental', 'Floor/Rental', 'Private Collection', 'Future Floor', 'Parts donor'];
const PHOTO_SET_PRESETS = ['Intake', 'Pre-restoration', 'In progress', 'Post-restoration', 'Listing', 'Damage', 'Pack-out'];

// Short shelf label, derived rather than stored so it can never disagree
// with the row: R-0042 for a Rhodes, W- for Wurlitzer, and so on. Kombo+
// was O- (organ) and X- (other) before migration 083; the digits are the
// row id and didn't change, so InventoryView's search matches old numbers
// by their digits.
const STOCK_PREFIX = {
  rhodes: 'R', wurlitzer: 'W', hohner: 'H', strings: 'S', kombo: 'K',
};
const stockNumber = (row) => `${STOCK_PREFIX[row.family] || 'X'}-${String(row.id).padStart(4, '0')}`;

/**
 * "7,750" / "$8,250.00" / "5k" -> number; anything without a usable leading
 * number -> null. Used for request bodies and for the sheet import.
 */
function parseMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = String(value).replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2]) n *= 1000;
  return Number.isFinite(n) ? n : null;
}

/** Cost is margin information — only admins see or write it. */
function redactForRole(row, user) {
  if (!row) return row;
  const out = { ...row, stock_number: stockNumber(row) };
  delete out.import_raw;
  if (user?.role !== 'admin') {
    delete out.cost_paid;
    delete out.cost_note;
  }
  return out;
}

module.exports = {
  FAMILIES,
  OWNERSHIPS,
  SALE_STATUSES,
  SALE_STATUS_LABELS,
  CONSIGNMENT_STATUSES,
  CONSIGNMENT_STATUS_LABELS,
  CONDITION_FIELDS,
  CONDITION_GRADES,
  GRADE_KEYS,
  splitGrade,
  NFS_REASON_PRESETS,
  PHOTO_SET_PRESETS,
  STOCK_PREFIX,
  stockNumber,
  parseMoney,
  redactForRole,
};
