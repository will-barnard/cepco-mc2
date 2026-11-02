-- One-time data fix: apply the shop's Consignment Tracking sheet
-- (assets/CEPCo Inventory Log - Consignment Tracking.csv) to the pieces the
-- Inventory Log import created (NOTES.md §2.103).
--
-- Matched by import_key — the importer's stable per-row key — so this is a
-- no-op on any database that never ran the import (dev, a fresh rebuild).
--
-- Four pieces the import read as shop-owned are consignments per the
-- tracking sheet: Aidy, Todd Piano Bass, Bruno, M Calc. Consignor names
-- are filled in where the tracking sheet gives a fuller one (Aakash ->
-- Akash Dheer, Steve W -> Steve Weiss). Customers are deliberately not
-- created or linked here — that pushes contacts to Xero, and is done per
-- piece from the detail page.
--
-- Not applied, no matching piece: Cliff Colnot (no instrument named),
-- Joe Randel's 1974 Suitcase 73, Graham Thompson's satellite cabs (a Parts
-- & Accessories item — parts can't be consignments). Greg's 1978 Suitcase
-- 73 is listed as a consignment there but was bought outright: left
-- shop-owned.
CREATE TEMP TABLE consignment_fix (
  import_key TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  consignor  TEXT,
  terms      TEXT,
  rate       NUMERIC(5,2)
) ON COMMIT DROP;

INSERT INTO consignment_fix (import_key, status, consignor, terms, rate) VALUES
  -- Contracted / For Sale
  ('inventory_log:wurlitzer:aidy|200|70931',                      'contracted', 'Aidy',              'Services + 25% of Sale', 25),
  ('inventory_log:combo:atevich|lowery-t2|950810',                'for_sale',   NULL,                'Service + 25% (~$1,200)', 25),
  ('inventory_log:combo:consigntempo|fender-contempo|',           'for_sale',   NULL,                NULL, NULL),
  ('inventory_log:rhodes:rodney|suitcase-73|789908',              'for_sale',   NULL,                NULL, NULL),
  ('inventory_log:rhodes:gt-mkii-88-wrong-link|stage-88-mkii|796063', 'for_sale', NULL,              'Services + 25% of Sale', 25),
  ('inventory_log:wurlitzer:graham-thompson-gt|200a|135577',      'for_sale',   NULL,                'Services + 25% of Sale', 25),
  -- Paid Out
  ('inventory_log:hohner:wheaties|clavinet-e7|',                  'paid_out',   'Steve Weiss',       'Services + 25% of Sale', 25),
  ('inventory_log:rhodes:todd-piano-bass|piano-bass|',            'paid_out',   'Todd',              'Services + 25% of Sale', 25),
  ('inventory_log:hohner:todd-e7|clavinet-e7|',                   'paid_out',   'Todd',              'Services + 25% of Sale', 25),
  ('inventory_log:rhodes:dynamic-aakash-consign|stage-73|31338',  'paid_out',   'Akash Dheer',       'Quoted at 30% commission of $5,750 = $4,025', 30),
  ('inventory_log:rhodes:bruno|stage-88|42805',                   'paid_out',   'Bruno',             '$2k', NULL),
  ('inventory_log:wurlitzer:dave-revolution|200|53567',           'paid_out',   'Dave (Revolution)', NULL, NULL),
  ('inventory_log:rhodes:barbarella|suitcase-88|612435',          'paid_out',   NULL,                'Services + 25% of Sale', 25),
  ('inventory_log:wurlitzer:m-calc|200a|130251',                  'paid_out',   'Mark Calcott',      '$3k labor trade', NULL);

-- History first, while the old values are still there, so each piece's
-- History panel explains the change. employee_id NULL = done by the system.
INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
SELECT i.id, NULL, 'ownership', i.ownership, 'consignment'
  FROM instruments i JOIN consignment_fix f USING (import_key)
 WHERE i.ownership <> 'consignment';

INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
SELECT i.id, NULL, 'consignment_status', i.consignment_status, f.status
  FROM instruments i JOIN consignment_fix f USING (import_key)
 WHERE i.consignment_status IS DISTINCT FROM f.status;

UPDATE instruments i SET
  ownership          = 'consignment',
  consignment_status = f.status,
  consignor_name     = COALESCE(f.consignor, i.consignor_name),
  consignment_terms  = COALESCE(f.terms, i.consignment_terms),
  consignment_rate   = COALESCE(f.rate, i.consignment_rate)
  FROM consignment_fix f
 WHERE i.import_key = f.import_key;
