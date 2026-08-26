'use strict';

/**
 * Idempotent seeder. Runs on every boot; inserts only what is missing.
 *
 * Seeds:
 *   - the five §8 configurable enums, with the historical values from the sheets
 *   - QC + shipping checklist templates transcribed from the Wurlitzer sheets
 *   - the PARTS ORDERS vendor list
 *   - a first admin account, only when no employees exist at all
 */

const bcrypt = require('bcryptjs');
const { pool, query, waitForDatabase } = require('../db');
const config = require('../config');

// ---------------------------------------------------------------------------
// Configurable enums (PLAN §4, §8)
// ---------------------------------------------------------------------------
const SETTINGS = [
  // The five top-level ticket categories.
  ['ticket_category', 'daily_todo', "Daily To-Do's", 10, {}],
  ['ticket_category', 'orders_shipping', 'Orders & Shipping', 20, {}],
  ['ticket_category', 'servicing', 'Servicing', 30, {}],
  ['ticket_category', 'inventory_restoration', 'Inventory Restorations', 40, { internal_only: true }],
  ['ticket_category', 'shipping', 'Shipping', 50, {}],

  // Statuses, seeded from the values actually present in the sheets.
  ['ticket_status', 'reservation', 'Reservation', 10,
    { color: 'slate', applicable_categories: ['daily_todo', 'orders_shipping', 'servicing', 'inventory_restoration'] }],
  ['ticket_status', 'not_started', 'Not Started', 20, { color: 'slate' }],
  ['ticket_status', 'in_progress', 'In Progress', 30, { color: 'blue' }],
  ['ticket_status', 'qc', 'QC', 40,
    { color: 'violet', applicable_categories: ['daily_todo', 'orders_shipping', 'servicing', 'inventory_restoration'] }],
  ['ticket_status', 'invoice_sent', 'Invoice Sent', 50,
    { color: 'amber', applicable_categories: ['daily_todo', 'orders_shipping', 'servicing', 'inventory_restoration'] }],
  ['ticket_status', 'invoice_paid', 'Invoice Paid', 60,
    { color: 'green', applicable_categories: ['daily_todo', 'orders_shipping', 'servicing', 'inventory_restoration'] }],
  ['ticket_status', 'done', 'Done', 70, { color: 'green', terminal: true }],
  ['ticket_status', 'on_hold', 'On Hold', 80,
    { color: 'red', applicable_categories: ['daily_todo', 'orders_shipping', 'servicing', 'inventory_restoration'] }],

  // Priority tiers, with the hour ranges from the sheet section headers.
  ['priority_tier', 'daily_todo', 'Daily To-Do', 10, { min_hours: 0, max_hours: 1 }],
  ['priority_tier', 'expedited', 'Expedited / Quick Setup', 20, { min_hours: 3, max_hours: 6 }],
  ['priority_tier', 'standard_setup', 'Standard Setup', 30, { min_hours: 7, max_hours: 15 }],
  ['priority_tier', 'deep_dive', 'Deep Dive', 40, { min_hours: 10, max_hours: null }],
  ['priority_tier', 'custom_shop', 'Custom Shop', 50, { min_hours: 15, max_hours: null }],

  // QC rigor tiers. Phase 1 ships single-round; Phase 2 flips required_rounds
  // to 2 and require_distinct_reviewers to true — settings change, not a deploy.
  ['qc_tier', 'standard', 'Standard Setup QC', 10,
    { required_rounds: 1, require_distinct_reviewers: false }],
  ['qc_tier', 'perfectionist', 'Perfectionist / Custom Shop QC', 20,
    { required_rounds: 2, require_distinct_reviewers: true }],

  // Tech levels.
  ['tech_level', 'junior', 'Junior Tech', 10,
    { examples: ['grommets', 'felts', 'basic prep'] }],
  ['tech_level', 'senior', 'Senior Tech', 20,
    { examples: ['action regulation', 'tuning', 'electronics diagnostics'] }],

  // Shop-wide values. Not a ticket enum — single rows the admin can change
  // without a deploy. Each new estimate copies the rate onto itself, so
  // changing this never restates a quote that already went out.
  ['shop_config', 'labor_rate', 'Shop labor rate ($/hr)', 10,
    { value: 185, unit: 'usd_per_hour' }],

  // Which ticket category a new Shopify order lands in (§ NOTES.md "Shopify
  // order intake"). Admin-editable from Settings -> Shop configuration;
  // routes/shopifyWebhooks.js falls back to 'orders_shipping' if this ever
  // points at a retired/missing category.
  ['shop_config', 'shopify_default_category', 'Default category for Shopify orders', 20,
    { value: 'orders_shipping' }],
];

// ---------------------------------------------------------------------------
// Checklist templates, transcribed from Wurlitzer Checklists - *.csv
// ---------------------------------------------------------------------------
const item = (label, note = null) => ({ label, note });

const QC_TEMPLATES = [
  {
    name: 'Wurlitzer — QC Round 1',
    family: 'wurlitzer',
    tier_key: 'standard',
    kind: 'qc',
    items: [
      item('Tuning'), item('Voicing / Volume'), item('Key Bed Level'),
      item('Friction / Warping'), item('Lazy Dampers'), item('Damper Drop'),
      item('2x Hammers'), item('Let Off / Check Off'), item('Cold Solderform'),
      item('Sustain Pedal / Cable'), item('Legs'), item('Potentiometers'),
      item('Grounding Scheme'), item('Shielding'), item('Vibrato Sweep'),
      item('Aux Output'), item('Amplifier'),
    ],
  },
  {
    name: 'Wurlitzer — QC Final',
    family: 'wurlitzer',
    tier_key: 'perfectionist',
    kind: 'qc',
    items: [
      item('Tuning'), item('Voicing / Tone'), item('Volume'),
      item('Key Bed', 'Squaring, leveling, cleaning'),
      item('Friction / Warping'), item('Damper Drop'), item('2x Hammers'),
      item('Cold Solderform'), item('Regulation'), item('Lazy Dampers'),
      item('Hammers / Tips'), item('Sustain Pedal / Cable'), item('Legs'),
      item('Potentiometers'), item('Grounding Scheme'), item('Shielding'),
      item('Vibrato Sweep'), item('Aux Output', 'Fixed / Variable'),
      item('Amp Hookup Wires / Terminals'),
    ],
  },
  {
    // Generalised from the Wurlitzer sheet (PLAN §7) — applies to any family
    // until a family-specific template is added, since family IS NULL matches all.
    name: 'Shipping Checklist — General',
    family: null,
    tier_key: 'standard',
    kind: 'shipping',
    items: [
      item('Legs'), item('Sustain Pedal / Cable'),
      item('Accessories (Music Stand, Bench)'), item('IEC or Ext. Cable'),
      item('T-Shirt'), item('Stickers'), item('Print Addresses'),
      item('Print Shipping Labels / Docs'), item('Label Sides of Box'),
    ],
  },
  {
    // Baseline QC for families without their own sheet yet. Derived from the
    // Wurlitzer round-1 list, trimmed to the checks that generalise.
    name: 'General Setup QC',
    family: null,
    tier_key: 'standard',
    kind: 'qc',
    items: [
      item('Tuning'), item('Voicing / Tone'), item('Key Bed Level'),
      item('Action Regulation'), item('Dampers'), item('Hammers / Tips'),
      item('Sustain Pedal / Cable'), item('Electronics / Output'),
      item('Grounding & Shielding'), item('Cosmetics'), item('Legs / Hardware'),
    ],
  },
];

// PARTS ORDERS.csv column headers.
const VENDORS = [
  'Vintage Vibe', 'Retro Linear', 'Schaff/Howard', 'Hardware/McMaster',
  'Mouser/CEDist', 'CVK/KRSS', 'Fabricators + Paint', 'ULINE',
];

async function seedSettings() {
  let inserted = 0;
  for (const [category, key, label, sortOrder, meta] of SETTINGS) {
    // eslint-disable-next-line no-await-in-loop
    const { rowCount } = await query(
      `INSERT INTO settings (category, key, label, sort_order, meta)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (category, key) DO NOTHING`,
      [category, key, label, sortOrder, JSON.stringify(meta)],
    );
    inserted += rowCount;
  }
  if (inserted) console.log(`[seed] settings: +${inserted}`);
}

async function seedTemplates() {
  let inserted = 0;
  for (const t of QC_TEMPLATES) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await query('SELECT id FROM qc_templates WHERE name = $1', [t.name]);
    if (rows.length) continue;
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO qc_templates (name, family, tier_key, kind, items)
       VALUES ($1,$2,$3,$4,$5)`,
      [t.name, t.family, t.tier_key, t.kind, JSON.stringify(t.items)],
    );
    inserted += 1;
  }
  if (inserted) console.log(`[seed] qc_templates: +${inserted}`);
}

async function seedVendors() {
  let inserted = 0;
  for (let i = 0; i < VENDORS.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rowCount } = await query(
      'INSERT INTO vendors (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING',
      [VENDORS[i], (i + 1) * 10],
    );
    inserted += rowCount;
  }
  if (inserted) console.log(`[seed] vendors: +${inserted}`);
}

async function seedAdmin() {
  const { rows } = await query('SELECT count(*)::int AS n FROM employees');
  if (rows[0].n > 0) return;

  const { email, password } = config.seedAdmin;
  if (!email || !password) {
    console.warn(
      '[seed] no employees exist and SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are unset — '
      + 'nobody can log in. Set both and restart the backend.',
    );
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO employees (name, email, password_hash, role, initials)
     VALUES ($1,$2,$3,'admin','WB')`,
    ['Will Barnard', email.toLowerCase(), hash],
  );
  console.log(`[seed] created first admin account: ${email}`);
}

async function seed() {
  await seedSettings();
  await seedTemplates();
  await seedVendors();
  await seedAdmin();
}

module.exports = { seed, SETTINGS, QC_TEMPLATES, VENDORS };

if (require.main === module) {
  waitForDatabase()
    .then(seed)
    .then(() => pool.end())
    .catch((err) => { console.error('[seed]', err); process.exit(1); });
}
