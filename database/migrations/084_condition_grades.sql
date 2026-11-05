-- Inventory condition grades become a fixed scale (shop feedback, Nov 2026).
--
-- instruments.condition (migration 072) held whatever the Inventory Log
-- sheet's cells said: mostly grades in the sheet's shorthand (EX, VG, NM,
-- G, F, Mint, New) but about a third free text ("OG Cube", "Paint", "No
-- case", "VG (light scratches)"). The inventory pages now pick grades from
-- a dropdown, on one scale, worst to best:
--
--     poor · good · very_good · excellent · near_mint · mint
--
-- so the stored values become those keys, and any text that isn't a grade
-- moves to a new per-field note (condition_notes, same keys as condition):
--
--   "EX"                  -> excellent
--   "VG (light scratches)"-> very_good  + note "light scratches"
--   "G-", "VG+", "EX+"    -> good / very_good / excellent (no half-grades)
--   "VG-EX", "EX-NM"      -> the lower of the two (very_good / excellent)
--   "F", "Fair", "Bad",
--   "Rough", "Poor"       -> poor      (the scale has no Fair -- shop's call)
--   "New"                 -> mint      (a freshly replaced part)
--   "Bad warp", "rough top, otherwise nice"
--                         -> poor + the whole phrase as the note (a grade
--                            word that's describing something)
--   "OG Cube", "Paint", "?", "2 bad", "Yellow but EX"
--                         -> no grade, the whole text as the note
--
-- Only a grade at the *start* of the text counts. Anything else stays a
-- note rather than being guessed at, so nothing becomes a grade the sheet
-- didn't say. condition_legacy keeps every row's original values, so the
-- conversion can be checked or undone by hand. (import_raw has the sheet
-- cells too, but only for imported rows.)
--
-- services/inventory.js's splitGrade() is the same rules in JS, for the
-- importer; keep the two in step.
--
-- Also a new condition field, Hardware, on every family -- that's only the
-- CONDITION_FIELDS list in services/inventory.js, nothing to store here.

ALTER TABLE instruments
  ADD COLUMN IF NOT EXISTS condition_notes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS condition_legacy JSONB;

CREATE FUNCTION pg_temp.split_grade(raw TEXT, OUT grade TEXT, OUT note TEXT) AS $$
DECLARE
  -- Longest alternatives first so "very good" wins over "good", "nm" over "m".
  g CONSTANT TEXT := '(near mint|very good|excellent|mint|good|fair|poor|bad|rough|new|nm|ex|vg|m|g|f)';
  s TEXT := btrim(coalesce(raw, ''));
  m TEXT[];
  rest TEXT;
BEGIN
  grade := NULL;
  note := NULL;
  IF s = '' THEN RETURN; END IF;
  -- grade, then an optional "-EX" / "/NM" range (lower grade wins, so the
  -- second is ignored), then an optional +/-, then whatever's left.
  -- m[1] grade, m[2] range's second grade, m[3] +/-, m[4] the gap, m[5] rest.
  m := regexp_match(s, '^' || g || '(?![a-z0-9])(?:\s*[-/]\s*' || g || '(?![a-z0-9]))?([+-]?)(\s*)(.*)$', 'i');
  IF m IS NULL THEN
    note := s;
    RETURN;
  END IF;
  grade := CASE lower(m[1])
    WHEN 'mint' THEN 'mint' WHEN 'm' THEN 'mint' WHEN 'new' THEN 'mint'
    WHEN 'near mint' THEN 'near_mint' WHEN 'nm' THEN 'near_mint'
    WHEN 'excellent' THEN 'excellent' WHEN 'ex' THEN 'excellent'
    WHEN 'very good' THEN 'very_good' WHEN 'vg' THEN 'very_good'
    WHEN 'good' THEN 'good' WHEN 'g' THEN 'good'
    ELSE 'poor' -- fair, f, poor, bad, rough
  END;
  -- A plain-English grade word running straight into more words ("rough
  -- top, otherwise nice", "Bad warp", "New black") is describing
  -- something, so the note keeps the whole phrase. Sheet shorthand (EX, VG,
  -- G...) or a punctuated break ("New. Rough case.") just leaves the rest.
  IF length(m[1]) > 2 AND lower(m[1]) <> 'mint' AND m[3] = '' AND m[4] <> '' AND m[5] ~* '^[a-z0-9]' THEN
    note := s;
    RETURN;
  END IF;
  -- "(light scratches)", ", 1 chip", "- will clean up", "/orange" -> the
  -- bare text.
  rest := regexp_replace(m[5], '^[\s,;:./\-]+', '');
  IF rest ~ '^\(.*\)$' THEN rest := substr(rest, 2, length(rest) - 2); END IF;
  rest := btrim(rest);
  note := NULLIF(rest, '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE instruments
   SET condition_legacy = condition
 WHERE condition <> '{}'::jsonb AND condition_legacy IS NULL;

UPDATE instruments i
   SET condition = COALESCE((
         SELECT jsonb_object_agg(kv.key, (pg_temp.split_grade(kv.value)).grade)
           FROM jsonb_each_text(i.condition_legacy) kv
          WHERE (pg_temp.split_grade(kv.value)).grade IS NOT NULL), '{}'::jsonb),
       condition_notes = COALESCE((
         SELECT jsonb_object_agg(kv.key, (pg_temp.split_grade(kv.value)).note)
           FROM jsonb_each_text(i.condition_legacy) kv
          WHERE (pg_temp.split_grade(kv.value)).note IS NOT NULL), '{}'::jsonb)
 WHERE i.condition_legacy IS NOT NULL
   -- only rows still holding exactly what was backed up, so this can never
   -- re-convert a row someone has since edited
   AND i.condition = i.condition_legacy;
