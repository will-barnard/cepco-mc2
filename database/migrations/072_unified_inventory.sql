-- ===========================================================================
-- Unified inventory: fleet + inventory become one thing (NOTES.md §inventory).
--
-- Before this, "fleet" was instruments.is_fleet and "inventory" wasn't a
-- record at all — it was tickets in the inventory_restoration category —
-- and routes/purchases.js inserted purchased stock with is_fleet = TRUE, so
-- everything the shop bought also showed up as showroom/rental fleet. The
-- shop's own model (the CEPCo Inventory Log sheets) is simpler: a piece the
-- shop holds is either for sale or not, and "fleet" is just "not for sale,
-- because it's on the floor / rented out / in the private collection".
--
-- So instead of a flag, two columns:
--   ownership    customer | shop | consignment
--                (consignment = the shop is selling it for someone;
--                 customer_id then points at the consignor, so it reaches
--                 Xero through the normal customer sync)
--   sale_status  available | on_hold | not_for_sale | sold
--                NULL for customer-owned instruments, required otherwise
--                (CHECK below), so "is this inventory?" is simply
--                ownership <> 'customer'.
--
-- Everything the sheets carry that doesn't map to an existing column gets
-- its own here. Condition grades differ per family (Rhodes has tines,
-- Wurlitzer has reeds, Hohner has veneers), so they live in one JSONB keyed
-- by the field list in routes/inventory.js's CONDITION_FIELDS rather than
-- a dozen mostly-empty columns. Values stay free text — the sheets say
-- "OG Cube" and "yellow (new included)", not just EX/VG.
-- ===========================================================================

ALTER TABLE instruments
  ADD COLUMN ownership TEXT NOT NULL DEFAULT 'customer'
    CHECK (ownership IN ('customer', 'shop', 'consignment')),
  ADD COLUMN sale_status TEXT
    CHECK (sale_status IN ('available', 'on_hold', 'not_for_sale', 'sold')),
  -- Why it's not for sale ("Floor", "Rental", "Private Collection",
  -- "Parts donor") — free text with quick-picks in the UI; the sheets use
  -- combinations like "Floor/Rental" that a fixed enum would fight.
  ADD COLUMN nfs_reason TEXT,
  ADD COLUMN hold_for TEXT,
  ADD COLUMN asking_price NUMERIC(10,2),
  -- The sheet's price cell is often a number with a condition attached
  -- ("7750 w tolex", "8500 + custom") — the number goes above, the rest here.
  ADD COLUMN price_note TEXT,
  -- What the shop paid. Admin-only on the API (routes/inventory.js strips
  -- both fields for non-admins) — it's margin information.
  ADD COLUMN cost_paid NUMERIC(10,2),
  ADD COLUMN cost_note TEXT,
  -- Consignor as written in the sheet, kept until someone links a real
  -- customer record (customer_id). Never auto-creates a customer: a bulk
  -- import shouldn't be the thing that pushes 20 contacts into Xero.
  ADD COLUMN consignor_name TEXT,
  ADD COLUMN consignment_rate NUMERIC(5,2)
    CHECK (consignment_rate IS NULL OR (consignment_rate >= 0 AND consignment_rate <= 100)),
  ADD COLUMN condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN on_website BOOLEAN NOT NULL DEFAULT FALSE,
  -- The sheet section a piece sits under ("Rhodes Stage", "Specialty
  -- Wurlitzer Models") — the list page groups by it so it reads like the
  -- sheet the bosses are used to.
  ADD COLUMN model_group TEXT,
  ADD COLUMN sort_order INTEGER,
  ADD COLUMN sold_at DATE,
  ADD COLUMN sold_price NUMERIC(10,2),
  ADD COLUMN sold_to_name TEXT,
  ADD COLUMN sold_to_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  -- Free-text QC history carried over from the SHOWROOM QC sheet ("Last
  -- QC: Pre 2025 — needs action setup"). The real cycle is still
  -- last_qc_at + qc_interval_months (migration 034).
  ADD COLUMN qc_notes TEXT,
  -- Provenance for scripts/importInventory.js: re-running it upserts by
  -- import_key instead of duplicating, and import_raw keeps the original
  -- sheet row so anything the parser got wrong can be checked by hand.
  ADD COLUMN import_source TEXT,
  ADD COLUMN import_key TEXT,
  ADD COLUMN import_raw JSONB;

CREATE UNIQUE INDEX instruments_import_key_idx ON instruments (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX instruments_inventory_idx ON instruments (ownership, sale_status, family)
  WHERE ownership <> 'customer';

-- ---------------------------------------------------------------------------
-- Backfill from is_fleet, then drop it.
--   * is_fleet + a purchase record  -> bought stock (the purchases.js bug):
--     shop-owned, available.
--   * is_fleet otherwise            -> the old showroom/rental fleet:
--     shop-owned, not for sale.
--   * everything else               -> customer instrument, untouched.
-- fleet_last_qc (the SHOWROOM QC sheet's free-text "Last QC") moves into
-- qc_notes along with the showroom notes (which the old importer had put in
-- identifying_notes), so nothing typed there is lost.
-- ---------------------------------------------------------------------------
UPDATE instruments i
   SET ownership = 'shop', sale_status = 'available'
 WHERE i.is_fleet AND EXISTS (SELECT 1 FROM instrument_purchases p WHERE p.instrument_id = i.id);

UPDATE instruments
   SET ownership = 'shop', sale_status = 'not_for_sale', nfs_reason = 'Showroom/Rental',
       qc_notes = NULLIF(concat_ws(' — ',
         CASE WHEN fleet_last_qc IS NOT NULL THEN 'Last QC: ' || fleet_last_qc END,
         identifying_notes), ''),
       -- moved into qc_notes above (SET reads the pre-update values), so
       -- clear it rather than show the same text twice
       identifying_notes = NULL
 WHERE is_fleet AND ownership = 'customer';

ALTER TABLE instruments
  ADD CONSTRAINT instruments_sale_status_by_ownership CHECK (
    (ownership = 'customer' AND sale_status IS NULL)
    OR (ownership <> 'customer' AND sale_status IS NOT NULL)
  );

ALTER TABLE instruments DROP COLUMN is_fleet;
ALTER TABLE instruments DROP COLUMN fleet_last_qc;

-- ---------------------------------------------------------------------------
-- Change log — who moved the price or the status, and when. Written by
-- routes/inventory.js on PATCH for the handful of fields that matter for
-- sales; not a general audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE instrument_events (
    id            SERIAL PRIMARY KEY,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    field         TEXT NOT NULL,
    old_value     TEXT,
    new_value     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instrument_events_instrument_idx ON instrument_events (instrument_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Photos, in named sets ("Intake", "Listing", ...). Same storage drivers
-- and two upload paths as ticket photos (routes/attachments.js); objects
-- are keyed under instruments/<id>/ so they're distinguishable in the
-- bucket. instrument_id is repeated on the photo row so the cover-photo
-- FK and the local-driver file proxy don't need a join.
-- ---------------------------------------------------------------------------
CREATE TABLE instrument_photo_sets (
    id            SERIAL PRIMARY KEY,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    taken_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    -- Optional: the set was shot as part of this ticket's work.
    ticket_id     INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    created_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instrument_photo_sets_instrument_idx ON instrument_photo_sets (instrument_id, taken_on DESC);

CREATE TABLE instrument_photos (
    id            SERIAL PRIMARY KEY,
    set_id        INTEGER NOT NULL REFERENCES instrument_photo_sets(id) ON DELETE CASCADE,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    uploader_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    storage_key   TEXT NOT NULL,
    driver        TEXT NOT NULL,
    file_name     TEXT,
    content_type  TEXT,
    size_bytes    BIGINT,
    caption       TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instrument_photos_set_idx ON instrument_photos (set_id, sort_order, uploaded_at);
CREATE INDEX instrument_photos_key_idx ON instrument_photos (storage_key);

ALTER TABLE instruments
  ADD COLUMN cover_photo_id INTEGER REFERENCES instrument_photos(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Parts & accessories — counted stock (cases, rails, preamps, speaker
-- sets, music racks), not individual instruments. Deliberately its own
-- table: none of the instrument machinery (tickets, QC, rentals, sale
-- status) applies, and a "quantity" column on instruments would be wrong
-- for every other row. Distinct from parts_orders (things the shop needs
-- to buy for a repair) — this is what's on the shelf.
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_parts (
    id            SERIAL PRIMARY KEY,
    family        TEXT NOT NULL,            -- one of instruments.family's keys
    category      TEXT,                     -- sheet section: "Extra Cases & Pre-amps", "Rails & etc."
    name          TEXT NOT NULL,
    model         TEXT,
    -- quantity is the number when there is one; quantity_note carries the
    -- sheet's "5-10 Available" / "tons" / "N/A" when there isn't.
    quantity      INTEGER CHECK (quantity IS NULL OR quantity >= 0),
    quantity_note TEXT,
    condition     TEXT,
    price         NUMERIC(10,2),
    price_note    TEXT,
    for_sale      BOOLEAN NOT NULL DEFAULT TRUE,
    on_website    BOOLEAN NOT NULL DEFAULT FALSE,
    cost_paid     NUMERIC(10,2),
    cost_note     TEXT,
    notes         TEXT,
    sort_order    INTEGER,
    import_source TEXT,
    import_key    TEXT,
    import_raw    JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inventory_parts_import_key_idx ON inventory_parts (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX inventory_parts_family_idx ON inventory_parts (family, sort_order);

CREATE TRIGGER inventory_parts_touch BEFORE UPDATE ON inventory_parts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The QC sweep (services/recurringTickets.js) now covers every shop-held
-- instrument with a cycle, not just the old fleet — the settings row keeps
-- its key so its last_run_at survives, only the label changes.
UPDATE settings SET label = 'Inventory QC overdue sweep'
 WHERE category = 'shop_config' AND key = 'fleet_qc_sweep';
