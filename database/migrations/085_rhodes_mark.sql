-- Rhodes "Mark" (generation) as its own field on instruments -- shop
-- feedback, Nov 2026.
--
-- Model on the inventory page is free text and, for Rhodes, mostly carries
-- the body style ("Stage 73", "Suitcase 88", "Peterson cabinet"); the Mark
-- was either missing or buried in that text. Now it's a dropdown beside
-- Family, stored as a key:
--
--   pre_mark  Pre-Mark   1965-69 Fender Rhodes, before the Mark I name
--   mk1       Mark I     1969-79
--   mk2       Mark II    1979-83
--   mk3       Mark III   1980 EK-10 (piano + analog synth hybrid)
--   mk5       Mark V     1984
--   mk7       Mark 7     2007 (Rhodes Music Corp.)
--   mk8       Mark 8     2021- (Rhodes Music Group, "MK8")
--
-- Mark IV and Mark VI were prototypes that never went into production, so
-- they're not offered. The list (keys, labels, which families have one)
-- lives in services/instrumentCatalog.js's MARKS (moved there in 086);
-- only Rhodes has one today, every other family stores NULL. No CHECK
-- constraint, same as instruments.family -- the API validates, and adding a
-- mark stays a code change rather than a migration.
--
-- Backfill: a Rhodes row whose model, section (model_group) or name already
-- says "Mark II" / "Mk 2" / "MKII" / "Mark I / Stage 73" (the ticket and
-- estimate model picker's chain) gets that mark. Model wins over section,
-- section over name. Notes are deliberately not read ("has a Mark II harp
-- in it" isn't the piece's own mark). Roman or Arabic, word-boundaried, so
-- "Mark is selling" and "Mark 88" don't match. services/instrumentCatalog.js's
-- markFromText() is the same rule in JS -- keep the two in step.

ALTER TABLE instruments ADD COLUMN IF NOT EXISTS mark TEXT;

CREATE FUNCTION pg_temp.rhodes_mark(s TEXT) RETURNS TEXT AS $$
  SELECT CASE lower(m[1])
    WHEN 'i' THEN 'mk1'    WHEN '1' THEN 'mk1'
    WHEN 'ii' THEN 'mk2'   WHEN '2' THEN 'mk2'
    WHEN 'iii' THEN 'mk3'  WHEN '3' THEN 'mk3'
    WHEN 'v' THEN 'mk5'    WHEN '5' THEN 'mk5'
    WHEN 'vii' THEN 'mk7'  WHEN '7' THEN 'mk7'
    WHEN 'viii' THEN 'mk8' WHEN '8' THEN 'mk8'
  END
  FROM (SELECT regexp_match(coalesce(s, ''),
          '\m(?:mark|mk)\s*\.?\s*(viii|vii|iii|ii|i|v|[1-8])\M', 'i') AS m) x;
$$ LANGUAGE sql IMMUTABLE;

UPDATE instruments
   SET mark = COALESCE(pg_temp.rhodes_mark(model),
                       pg_temp.rhodes_mark(model_group),
                       pg_temp.rhodes_mark(nickname))
 WHERE family = 'rhodes' AND mark IS NULL;
