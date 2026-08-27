-- ===========================================================================
-- Supplemental data import — customers/instruments/tickets added to the
-- Google Sheet (mc1) after the 2026-08-07 cutover but never brought into
-- Mission Control v2.
--
-- Found by diffing the live sheet exports (2026-08-27) against the CSVs the
-- original `importCsv.js` run pulled from (`assets/CEPCo Mission Control -
-- *.csv`, dated 2026-08-07). Unlike that script, this is NOT a wipe-and-
-- reload: it only inserts what's missing, so it's safe to run against a
-- database that already has real status changes, hours, QC sign-offs, etc.
-- sitting on top of the original import.
--
-- Same customer, multiple instruments -> multiple tickets, one per
-- instrument (Ismael Zermeno x2, St. Lucia x2, Richard Bliss x3,
-- James Leep x2) — matching how the original sheet-driven import always
-- worked (one ticket per instrument row), never bundled onto one ticket.
--
-- Idempotent by construction:
--   - customers matched/inserted by lower(name)
--   - instruments matched/inserted by (customer, family, lower(model))
--   - tickets matched/inserted by (customer, instrument, source_sheet)
-- so re-running this file (or applying it a second time by hand, outside
-- the schema_migrations guard) creates nothing twice.
--
-- Tagged source_sheet = 'supplemental-2026-08-27' (rather than a CSV
-- filename) so these rows are easy to find/report on separately from the
-- original cutover import.
-- ===========================================================================

CREATE TEMP TABLE tmp_supplemental_rows (
    client_name  TEXT NOT NULL,
    family       TEXT NOT NULL,
    priority_key TEXT NOT NULL,
    status_key   TEXT NOT NULL,
    model        TEXT NOT NULL,
    notes        TEXT,
    multi        BOOLEAN NOT NULL DEFAULT FALSE,
    other_vendor TEXT
) ON COMMIT DROP;

INSERT INTO tmp_supplemental_rows
    (client_name, family, priority_key, status_key, model, notes, multi, other_vendor)
VALUES
    -- HOHNER + STRINGS.csv / WURLITZER.csv — Custom Shop & Deep Dive
    ('Ismael Zermeno',  'hohner',    'custom_shop',    'not_started', 'Pneau Clavinet D6',
        'Delivery in September', FALSE, NULL),
    ('Ismael Zermeno',  'wurlitzer', 'custom_shop',    'not_started', 'Woody Wurlitzer 200A (+Clavinet)',
        'September Delivery to TX', TRUE, NULL),

    -- HOHNER + STRINGS.csv / RHODES.csv — Custom Shop & Deep Dive (deposit paid)
    ('St. Lucia',       'hohner',    'custom_shop',    'reservation', 'Clavinet Purchase Instagram',
        NULL, FALSE, NULL),
    ('St. Lucia',       'rhodes',    'custom_shop',    'reservation', 'Rhodes Purchase Instagram',
        NULL, FALSE, NULL),

    -- KOMBO.csv / WURLITZER.csv / RHODES.csv — Custom Shop & Deep Dive
    ('Richard Bliss',   'rarity',    'custom_shop',    'not_started', 'ARP 2600',
        'Check in with Richard before servicing', FALSE, NULL),
    ('Richard Bliss',   'wurlitzer', 'custom_shop',    'not_started', 'Wurlitzer 200',
        NULL, FALSE, NULL),
    ('Richard Bliss',   'rhodes',    'custom_shop',    'not_started', '1981 Rhodes Suitcase 73',
        'Grommets, Hammer Tips, Amplifier Electronics, Replace all pickups', FALSE,
        'Other Vendor: Order full set of Rhodes pickups'),

    -- WURLITZER.csv — Quick Setup
    ('Michael Peloquin', 'wurlitzer', 'expedited',     'not_started', 'Wurli 200',
        'assess and confirm services', FALSE, NULL),

    -- WURLITZER.csv — Standard Setup
    ('Ryan Conger',      'wurlitzer', 'standard_setup', 'reservation', 'Avocado 207a',
        'top shelf resto [sheet date: 8/13]', FALSE, NULL),
    ('John Beachboard',  'wurlitzer', 'standard_setup', 'reservation', '200a',
        'medium-to-full restoration [sheet date: 8/13]', FALSE, NULL),

    -- RHODES.csv — Standard Setup
    ('John Copeland',    'rhodes',    'standard_setup', 'not_started', '1973 FR stage 73 (orange)',
        'TBD', FALSE, NULL),
    ('James Leep',       'rhodes',    'standard_setup', 'not_started', '1977 FR Stage 73',
        'groms, tips, bushing and pedestal felt, clean case, add retro flier', TRUE, 'Not Started'),
    ('James Leep',       'rhodes',    'standard_setup', 'not_started', '1973 Hybrid Stage 73 (plastic key frame)',
        'groms, set up, add retro flier', TRUE, 'Not Started');

-- ---------------------------------------------------------------------------
-- 1. Customers — insert any of the 8 names not already present.
-- ---------------------------------------------------------------------------
INSERT INTO customers (name, source)
SELECT DISTINCT r.client_name, 'direct'
  FROM tmp_supplemental_rows r
 WHERE NOT EXISTS (
     SELECT 1 FROM customers c WHERE lower(c.name) = lower(r.client_name)
 );

-- ---------------------------------------------------------------------------
-- 2. Instruments — one per row, matched on (customer, family, model) so a
--    re-run (or a row that's already been added by hand) isn't duplicated.
-- ---------------------------------------------------------------------------
INSERT INTO instruments (family, model, customer_id)
SELECT r.family, r.model, c.id
  FROM tmp_supplemental_rows r
  JOIN customers c ON lower(c.name) = lower(r.client_name)
 WHERE NOT EXISTS (
     SELECT 1 FROM instruments i
      WHERE i.customer_id = c.id
        AND i.family = r.family
        AND lower(i.model) = lower(r.model)
 );

-- ---------------------------------------------------------------------------
-- 3. Tickets — one per instrument (never bundled, even for repeat
--    customers), tagged with a distinct source_sheet so this batch stays
--    identifiable in reports and the status_change_log audit trail.
-- ---------------------------------------------------------------------------
INSERT INTO tickets (
    title, category_key, category_label_snapshot,
    priority_key, priority_label_snapshot,
    status_key, status_label_snapshot,
    instrument_id, customer_id, notes,
    multi_instrument, vendor_tracks, shop_contact_raw, source_sheet
)
SELECT
    r.client_name || ' — ' || r.model,
    'servicing', cat.label,
    r.priority_key, pr.label,
    r.status_key, st.label,
    i.id, c.id, r.notes,
    r.multi,
    CASE WHEN r.other_vendor IS NOT NULL
         THEN jsonb_build_object('Other Vendor', r.other_vendor)
         ELSE '{}'::jsonb
    END,
    NULL,
    'supplemental-2026-08-27'
  FROM tmp_supplemental_rows r
  JOIN customers   c   ON lower(c.name) = lower(r.client_name)
  JOIN instruments i   ON i.customer_id = c.id
                      AND i.family = r.family
                      AND lower(i.model) = lower(r.model)
  LEFT JOIN settings cat ON cat.category = 'ticket_category' AND cat.key = 'servicing'
  LEFT JOIN settings pr  ON pr.category  = 'priority_tier'   AND pr.key  = r.priority_key
  LEFT JOIN settings st  ON st.category  = 'ticket_status'   AND st.key  = r.status_key
 WHERE NOT EXISTS (
     SELECT 1 FROM tickets t
      WHERE t.customer_id = c.id
        AND t.instrument_id = i.id
        AND t.source_sheet = 'supplemental-2026-08-27'
 );
