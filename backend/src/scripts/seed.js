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
  // Ticket categories. 'daily_todo' and 'orders_shipping' are the original
  // two untouched by the N2b reshuffle. 'servicing' and the standalone
  // 'shipping' (distinct from orders_shipping) retired in migration 029 —
  // left out of this array entirely, same as qc_tier after migration 021,
  // so a fresh database doesn't recreate them; existing databases got them
  // retired-not-deleted by that migration, still resolvable for history.
  // One accepted gap from removing them here: backend/src/scripts/
  // importCsv.js's historical Wurlitzer/Rhodes/etc. importer still
  // references 'servicing'/'shipping'/the old priority-tier keys by name
  // and would fail against a brand-new database that never had them — it's
  // a one-time tool for the original spreadsheet migration, already run
  // against production, and not expected to run again.
  ['ticket_category', 'daily_todo', "Daily To-Do's", 10, {}],
  ['ticket_category', 'orders_shipping', 'Orders & Shipping', 20, {}],
  // Repairs & Restoration (N2b) — the merge target for the old Servicing
  // category.
  ['ticket_category', 'repairs_restoration', 'Repairs & Restoration', 30, {}],
  // Inventory Restorations survives the reshuffle as a *child* of Repairs
  // & Restoration rather than retiring into the flat merge like Servicing
  // did — frontend/src/views/InventoryRestorationsView.vue depends on this
  // exact key for its own dedicated "instruments we bought to flip" queue
  // (a finding put back to the boss separately; see migration 029).
  ['ticket_category', 'inventory_restoration', 'Inventory Restorations', 10,
    { internal_only: true, parent_key: 'repairs_restoration' }],
  // Custom Shop (N2b) — used to be a priority tier (see the retired
  // priority_tier list below); now it's a sub-category of Repairs &
  // Restoration instead, since a job's type and its urgency are different
  // axes.
  ['ticket_category', 'custom_shop', 'Custom Shop', 20, { parent_key: 'repairs_restoration' }],
  ['ticket_category', 'housekeeping', 'Housekeeping', 40, {}],
  ['ticket_category', 'sidequests', 'SideQuests', 50, {}],
  // N3: SideQuests' four children. "Other" takes a typed name instead of a
  // fixed label (meta.allow_free_text — see resolveSubcategory() in
  // routes/tickets.js, and the parallel parts_orders.vendor_other / P3).
  ['ticket_category', 'sidequest_hunt', 'Hunt', 10, { parent_key: 'sidequests' }],
  ['ticket_category', 'sidequest_rnd', 'R&D', 20, { parent_key: 'sidequests' }],
  ['ticket_category', 'sidequest_outreach', 'Outreach', 30, { parent_key: 'sidequests' }],
  ['ticket_category', 'sidequest_other', 'Other', 40,
    { parent_key: 'sidequests', allow_free_text: true }],

  // Statuses, seeded from the values actually present in the sheets.
  // excluded_for_shipping (migration 029) replaced excluded_categories:
  // ['shipping'] — its only-ever member — once shipping sub-tickets became
  // identified by tickets.is_shipping (migration 028) instead of a
  // dedicated category. See backend/src/services/settings.js's
  // statusAppliesToCategory.
  ['ticket_status', 'reservation', 'Reservation', 10,
    { color: 'slate', excluded_for_shipping: true }],
  ['ticket_status', 'not_started', 'Not Started', 20, { color: 'slate' }],
  // unlocks_tasks (migration 022, NOTES.md §2.28): the tech dashboard's
  // "My tasks" section only ever surfaces tasks belonging to a ticket
  // whose current status carries this flag — admin-editable per status
  // from here on (Settings -> Ticket statuses), not hardcoded to this key.
  ['ticket_status', 'in_progress', 'In Progress', 30, { color: 'blue', unlocks_tasks: true }],
  ['ticket_status', 'qc', 'QC', 40,
    { color: 'violet', excluded_for_shipping: true }],
  ['ticket_status', 'invoice_sent', 'Invoice Sent', 50,
    { color: 'amber', excluded_for_shipping: true }],
  ['ticket_status', 'invoice_paid', 'Invoice Paid', 60,
    { color: 'green', excluded_for_shipping: true }],
  ['ticket_status', 'done', 'Done', 70, { color: 'green', terminal: true }],
  ['ticket_status', 'on_hold', 'On Hold', 80,
    { color: 'red', excluded_for_shipping: true }],

  // Priority tiers (N4b). The old sheet-inherited tiers (with their
  // min_hours/max_hours job-size bands) retired in migration 029, replaced
  // by three urgency-based tiers with no hour bands — left out of this
  // array entirely, same reasoning as the retired categories above.
  // Expedited sorts first: sort_order here drives the dashboard's task
  // ranking (routes/tickets.js's default ORDER BY on pr.sort_order).
  ['priority_tier', 'expedited_sos', 'Expedited / SOS', 10, {}],
  ['priority_tier', 'standard_priority', 'Standard Priority', 20, {}],
  ['priority_tier', 'low_priority', 'Low Priority', 30, {}],

  // QC rigor tiers used to live here (retired — migration 021). Every
  // ticket now follows the same standardized round progression instead of
  // a per-tier rule; see backend/src/routes/qc.js.

  // Tech levels.
  ['tech_level', 'junior', 'Junior Tech', 10,
    { examples: ['grommets', 'felts', 'basic prep'] }],
  ['tech_level', 'senior', 'Senior Tech', 20,
    { examples: ['action regulation', 'tuning', 'electronics diagnostics'] }],

  // Ceppy award categories (C1) — a settings category, not a hardcoded
  // pair, so the shop can add a third award (or rename these two) without
  // a deploy. ceppy_nominations.category_other covers a one-off award
  // that hasn't been added here yet.
  ['ceppy_category', 'technical', 'Technical Ceppy', 10, {}],
  ['ceppy_category', 'primetime', 'Primetime Ceppy', 20, {}],

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

  // Ceppys (fictional staff-recognition award) weekly digest schedule —
  // admin-configured from the Ceppys page's "Configure" panel, read by
  // services/ceppyScheduler.js. day_of_week follows JS's Date#getDay()
  // convention (0 = Sunday .. 6 = Saturday) since that's what a plain
  // <select> in the frontend naturally produces; time is 24-hour "HH:MM" in
  // the shop's own timezone (config.shopTimezone), same convention as every
  // other shop-local time comparison in this app (see NOTES.md §2.13).
  // Disabled by default — nobody gets an unexpected email until an admin
  // opts in, and a manual "send now" always works regardless of this flag.
  // last_sent_at (unset here) is written by services/ceppys.js after each
  // digest run, scheduled or manual, and is what stops the scheduler from
  // firing twice in the same shop-local day.
  ['shop_config', 'ceppys_schedule', 'Ceppys weekly email', 30,
    {
      enabled: false, day_of_week: 5, time: '15:00', last_sent_at: null,
    }],

  // Xero customer-contact sync (two-way — see backend/src/services/
  // xeroSync.js). Same disabled-by-default/manual-always-works posture as
  // ceppys_schedule just above: nobody's customer data starts moving
  // between systems until an admin opts in, but "Sync now" (Customers
  // page) works regardless of this flag. No day_of_week — this one runs
  // every day, not weekly — just a shop-local time-of-day, read by
  // services/xeroScheduler.js the same "hhmm >= configured time, and
  // hasn't already run today" way ceppyScheduler.js checks its own
  // schedule. last_synced_at (unset here) is stamped by xeroSync.js after
  // each run, scheduled or manual.
  ['shop_config', 'xero_sync', 'Xero customer sync', 40,
    { enabled: false, time: '02:00', last_synced_at: null }],
];

// ---------------------------------------------------------------------------
// Checklist templates, transcribed from Wurlitzer Checklists - *.csv
// ---------------------------------------------------------------------------
const item = (label, note = null) => ({ label, note });

const QC_TEMPLATES = [
  {
    // round_number 1 of 2 in Wurlitzer/qc's standardized progression — see
    // migration 021. Always runs before "QC Final" below; routes/qc.js
    // assigns round_number sequentially, so there's no way to start Final
    // first.
    name: 'Wurlitzer — QC Round 1',
    family: 'wurlitzer',
    kind: 'qc',
    round_number: 1,
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
    // round_number 2 of 2 — the closing pass. Under the standardized rule
    // (migration 021) both rounds must pass, signed off by two different
    // people, before a Wurlitzer ticket clears QC.
    name: 'Wurlitzer — QC Final',
    family: 'wurlitzer',
    kind: 'qc',
    round_number: 2,
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
    // Not part of the round progression (kind='shipping', not 'qc') — see
    // routes/shipments.js, which reads this by kind alone.
    name: 'Shipping Checklist — General',
    family: null,
    kind: 'shipping',
    round_number: 1,
    items: [
      item('Legs'), item('Sustain Pedal / Cable'),
      item('Accessories (Music Stand, Bench)'), item('IEC or Ext. Cable'),
      item('T-Shirt'), item('Stickers'), item('Print Addresses'),
      item('Print Shipping Labels / Docs'), item('Label Sides of Box'),
    ],
  },
  {
    // Round 1 of 2 for families without their own sheet yet. Derived from
    // the Wurlitzer round-1 list, trimmed to the checks that generalise.
    name: 'General Setup QC',
    family: null,
    kind: 'qc',
    round_number: 1,
    items: [
      item('Tuning'), item('Voicing / Tone'), item('Key Bed Level'),
      item('Action Regulation'), item('Dampers'), item('Hammers / Tips'),
      item('Sustain Pedal / Cable'), item('Electronics / Output'),
      item('Grounding & Shielding'), item('Cosmetics'), item('Legs / Hardware'),
    ],
  },
  {
    // Round 2 of 2 for families without their own sheet yet — every family
    // needs a closing round under the standardized rule (migration 021),
    // not just Wurlitzer, so this is the family-agnostic counterpart to
    // "Wurlitzer — QC Final" above until a shop lead writes a family-
    // specific one from Settings -> QC checklist templates.
    name: 'General Final QC',
    family: null,
    kind: 'qc',
    round_number: 2,
    items: [
      item('Tuning'), item('Voicing / Tone'), item('Action Regulation'),
      item('Dampers', 'Re-check after round 1 adjustments'),
      item('Hammers / Tips'), item('Sustain Pedal / Cable'),
      item('Electronics / Output'), item('Grounding & Shielding'),
      item('Cosmetics', 'Customer-ready condition'), item('Legs / Hardware'),
      item('Final Playtest'),
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
      `INSERT INTO qc_templates (name, family, kind, round_number, items, required_signoffs)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      // Q6: round_number 2 needs two distinct signatures on a fresh seed
      // too, same structural rule migration 035 applies to an existing
      // database — everything else keeps the column's own default of 1.
      [t.name, t.family, t.kind, t.round_number, JSON.stringify(t.items),
        t.round_number === 2 ? 2 : 1],
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
