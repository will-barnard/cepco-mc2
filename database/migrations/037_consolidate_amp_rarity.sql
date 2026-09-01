-- Consolidate the 'amp' and 'rarity' instrument families into a single
-- 'other' family (see routes/instruments.js's FAMILIES and NOTES.md). The
-- shop didn't have enough of either to justify two separate buckets, and
-- the amp/rarity split was always a bit arbitrary (see importCsv.js's old
-- classifier, which mostly just fell through to "rarity" for anything
-- that wasn't clearly an amp). Every table that stores this family key
-- gets the same reassignment.

-- instrument_default_technicians has a (family, employee_id) PRIMARY KEY
-- (migration 014). If the same employee was already a default tech for
-- BOTH 'amp' and 'rarity', a plain UPDATE would try to create two rows
-- with the same new key and violate the PK — drop the redundant side
-- first so the merge always has somewhere to land.
DELETE FROM instrument_default_technicians a
  USING instrument_default_technicians b
 WHERE a.family = 'rarity' AND b.family = 'amp' AND a.employee_id = b.employee_id;

UPDATE instruments                        SET family = 'other' WHERE family IN ('amp', 'rarity');
UPDATE qc_templates                       SET family = 'other' WHERE family IN ('amp', 'rarity');
UPDATE standard_procedures                SET family = 'other' WHERE family IN ('amp', 'rarity');
UPDATE instrument_default_technicians     SET family = 'other' WHERE family IN ('amp', 'rarity');
UPDATE instrument_models                  SET family = 'other' WHERE family IN ('amp', 'rarity');

-- qc_templates and standard_procedures have no uniqueness constraint on
-- family (unlike instrument_default_technicians above), so this migration
-- can't silently collapse a same-round 'amp' template and 'rarity'
-- template into one without picking a winner and discarding content —
-- that's a judgment call for whoever wrote each one, not this migration.
-- If both families had their own custom rows before, they now sit side by
-- side under 'other' rather than being merged or deleted; qc.js's
-- "resolve this round's template" query takes whichever one sorts first
-- and never surfaces the other, so Settings -> QC templates /
-- Settings -> Standard procedures are worth a look after this deploys to
-- reconcile or retire any leftover duplicate. See NOTES.md.
