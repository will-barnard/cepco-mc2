-- "Combo Organ" (organ) and "Other" (other) instrument families collapse
-- into one: Kombo+ (key 'kombo') -- shop feedback, Nov 2026. Same shape as
-- migration 037, which folded 'amp' and 'rarity' into 'other' in the first
-- place: every table that stores a family key gets the same reassignment.
-- (The shop's old Mission Control sheet already called this group KOMBO.)
--
-- Tables that store a family (checked against information_schema, not just
-- grep): instruments, inventory_parts, instrument_models, qc_templates,
-- standard_procedures, instrument_default_technicians, estimate_items
-- (instrument_family). tickets.family_queue_position is per-family too.

-- 1. instrument_default_technicians has a (family, employee_id) PRIMARY KEY
--    (migration 014): someone who was a default tech for both families
--    would become two identical rows, so drop the redundant 'other' side
--    first (same move as 037).
DELETE FROM instrument_default_technicians a
  USING instrument_default_technicians b
 WHERE a.family = 'other' AND b.family = 'organ' AND a.employee_id = b.employee_id;

-- 2. The family queue (migration 015) had two independent position
--    sequences, which would now interleave arbitrarily. Renumber the merged
--    queue before the instruments move, while the old family is still
--    known: organ jobs keep their order, then other jobs keep theirs. Only
--    ordering matters (positions are compared, never shown), and the Queue
--    page sorts by date / status / priority now anyway; this keeps the
--    dashboard's no-sort lists sensible.
UPDATE tickets t
   SET family_queue_position = r.rn * 10
  FROM (
    SELECT t2.id,
           row_number() OVER (ORDER BY (i.family = 'organ') DESC, t2.family_queue_position, t2.id) AS rn
      FROM tickets t2
      JOIN instruments i ON i.id = t2.instrument_id
     WHERE i.family IN ('organ', 'other') AND t2.family_queue_position IS NOT NULL
  ) r
 WHERE r.id = t.id;

-- 3. The move itself.
UPDATE instruments                    SET family = 'kombo' WHERE family IN ('organ', 'other');
UPDATE inventory_parts                SET family = 'kombo' WHERE family IN ('organ', 'other');
UPDATE instrument_models              SET family = 'kombo' WHERE family IN ('organ', 'other');
UPDATE qc_templates                   SET family = 'kombo' WHERE family IN ('organ', 'other');
UPDATE standard_procedures            SET family = 'kombo' WHERE family IN ('organ', 'other');
UPDATE instrument_default_technicians SET family = 'kombo' WHERE family IN ('organ', 'other');
UPDATE estimate_items                 SET instrument_family = 'kombo' WHERE instrument_family IN ('organ', 'other');

-- Same caveat as 037: qc_templates and standard_procedures have no
-- uniqueness on family, so if both families had their own custom template
-- for the same QC round, they now sit side by side under Kombo+ rather than
-- one being picked and the other deleted. Worth a look in Settings -> QC
-- templates / Standard procedures after deploy.
--
-- The model tree (instrument_models) just gains the organ brands; 'other'
-- never had a tree (migration 050), and the model picker's free-text
-- option covers amps, Leslies and synths.
--
-- Stock numbers are derived (services/inventory.js): O-0123 / X-0123
-- become K-0123. The number part is the row id, so it doesn't change, and
-- the Inventory search matches an old O-/X- number by its digits.
