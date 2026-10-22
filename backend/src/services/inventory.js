'use strict';

/**
 * Shared vocabulary for the unified inventory (migration 072) — used by
 * routes/inventory.js and scripts/importInventory.js, and served to the
 * frontend through GET /api/inventory/meta so the two never drift.
 */

const { FAMILIES } = require('../routes/instruments');

const OWNERSHIPS = ['shop', 'consignment']; // 'customer' exists too, but isn't inventory
const SALE_STATUSES = ['available', 'on_hold', 'not_for_sale', 'sold'];

const SALE_STATUS_LABELS = {
  available: 'For sale',
  on_hold: 'On hold',
  not_for_sale: 'Not for sale',
  sold: 'Sold',
};

// Per-family condition columns, in the order the Inventory Log sheets use.
// Keys are what's stored in instruments.condition (JSONB); labels are the
// sheet's own column headers. Any key not listed here is still kept and
// shown — this list drives the columns, it doesn't police the data.
const CONDITION_FIELDS = {
  rhodes: [
    { key: 'case', label: 'Tolex/Case' }, { key: 'keys', label: 'Keys' },
    { key: 'bushings', label: 'Bushings' }, { key: 'tines', label: 'Tines' },
    { key: 'hammers', label: 'Hammers' }, { key: 'lid', label: 'Lid' },
  ],
  wurlitzer: [
    { key: 'body', label: 'Tolex/Body' }, { key: 'keys', label: 'Keys' },
    { key: 'bushings', label: 'Bushings' }, { key: 'reeds', label: 'Reeds' },
    { key: 'hammers', label: 'Hammers' }, { key: 'lid', label: 'Lid' },
  ],
  hohner: [
    { key: 'cosmetics', label: 'Cosmetics' }, { key: 'keys', label: 'Keys' },
    { key: 'interior', label: 'Interior' }, { key: 'hammers', label: 'Hammers' },
    { key: 'veneers', label: 'Veneers' },
  ],
  strings: [
    { key: 'cosmetics', label: 'Cosmetics' }, { key: 'keys', label: 'Keys' },
    { key: 'interior', label: 'Interior' },
  ],
  organ: [
    { key: 'cosmetics', label: 'Cosmetics' }, { key: 'keys', label: 'Keys' },
    { key: 'interior', label: 'Interior' },
  ],
  other: [
    { key: 'cosmetics', label: 'Cosmetics' }, { key: 'interior', label: 'Interior' },
  ],
};

// Quick-picks only — both fields are free text.
const NFS_REASON_PRESETS = ['Floor', 'Rental', 'Floor/Rental', 'Private Collection', 'Future Floor', 'Parts donor'];
const PHOTO_SET_PRESETS = ['Intake', 'Pre-restoration', 'In progress', 'Post-restoration', 'Listing', 'Damage', 'Pack-out'];

// Short shelf label, derived rather than stored so it can never disagree
// with the row: R-0042 for a Rhodes, W- for Wurlitzer, and so on.
const STOCK_PREFIX = {
  rhodes: 'R', wurlitzer: 'W', hohner: 'H', strings: 'S', organ: 'O', other: 'X',
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
  CONDITION_FIELDS,
  NFS_REASON_PRESETS,
  PHOTO_SET_PRESETS,
  STOCK_PREFIX,
  stockNumber,
  parseMoney,
  redactForRole,
};
