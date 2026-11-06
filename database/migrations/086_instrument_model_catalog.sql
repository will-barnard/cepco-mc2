-- ===========================================================================
-- Instruments point at the model they are (NOTES.md §2.106).
--
-- instrument_models (migrations 036/050) is the catalog of what kinds of
-- instrument exist: Rhodes -> Mark I -> Stage 73, Wurlitzer -> 200A Era ->
-- 200A. Until now an instrument only kept the *text* of whatever was picked
-- ("Mark I / Stage 73"), so every fact about the model got re-derived from
-- that text: the parts-pricing key count by regex (EstimateNewView's
-- detectVariantKey), the Mark by regex (migration 085), and is_suitcase not
-- at all for an instrument already on file. This migration makes the
-- catalog the source of those facts and links instruments to it.
--
-- 1. Facts on catalog nodes, inherited down the tree. A node can carry
--    `mark` (Rhodes generation, a key from services/instrumentCatalog.js's
--    MARKS) and `key_count`. A node's *effective* value is its own, else
--    the nearest ancestor's -- so "Mark I" says mk1 once and its Stage 73 /
--    Suitcase 88 children inherit it, while each leaf says its own key
--    count. is_suitcase keeps its existing meaning: true if any node on the
--    path says so (exactly what the estimate wizard already checked). The
--    view instrument_model_facts computes all of it, plus the " / " name
--    chain the pickers write.
--
-- 2. instruments.model_id -> instrument_models, the model the piece is.
--    `model` stays exactly as written (sheet text, free text, or the
--    picker's chain) -- nothing in it is rewritten, ever, by this
--    migration. A composite FK on (model_id, family) means the database
--    itself refuses a Wurlitzer linked to a Rhodes node, and no catalog
--    node can be deleted while an instrument points at it (the API turns
--    that into "deactivate it instead").
--
-- 3. instruments.mark (085) becomes mark_override: NULL means "whatever
--    the catalog says", a value means this particular piece differs from
--    stock (a Mark II harp in a Mark I case). Reads expose the effective
--    mark as COALESCE(mark_override, catalog mark).
--
-- Backfill rules -- link only when the answer is unambiguous, otherwise
-- leave the row unlinked exactly as it was (the edit pages' model picker
-- links it by hand):
--   a. the text equals one node's full chain ("Mark I / Stage 73", case
--      and spacing around "/" ignored) within the instrument's family; else
--   b. the text equals exactly one node's own name in that family
--      ("Suitcase 73" in a sheet row); if several share the name (Mark I and
--      Mark II both have a Suitcase 73), the piece's own mark from 085
--      picks between them, and if that still isn't exactly one, no link;
--   c. and never when linking would change how the piece prices parts
--      (its own text says 73 but the match says nothing, say).
-- instrument_model_match() is that rule, kept as a function so the
-- importer and the API's free-text saves use the same one.
--
-- Integrity checks that abort the migration (everything rolls back) rather
-- than continue on a surprise:
--   - every catalog node must be reachable from a root (no cycles);
--   - for every node, the parts-pricing variant the new facts give must
--     equal what detectVariantKey() gives on its chain today -- so no
--     estimate prices differently because of this migration;
--   - no instrument's model text, family or mark changes meaning: the
--     effective mark after equals the stored mark before for every row
--     that had one.
-- ===========================================================================

-- 1. Facts on catalog nodes -------------------------------------------------
ALTER TABLE instrument_models
  ADD COLUMN mark TEXT,
  ADD COLUMN key_count INTEGER CHECK (key_count IS NULL OR key_count BETWEEN 1 AND 128),
  ADD CONSTRAINT instrument_models_id_family_key UNIQUE (id, family);

-- Set from the node's own name, not ids: production's tree may have been
-- edited in Settings since migration 050 seeded it. Mark only on Rhodes
-- (the Kombo+ "Rheem Mark VII" is an organ). Sparkletop, Rhodes 54, Piano
-- Bass and the "Other" nodes span or predate the Marks, so they're left
-- for someone at the shop to set in Settings -> Instrument models.
UPDATE instrument_models SET mark = CASE lower(m[1])
    WHEN 'i' THEN 'mk1'    WHEN '1' THEN 'mk1'
    WHEN 'ii' THEN 'mk2'   WHEN '2' THEN 'mk2'
    WHEN 'iii' THEN 'mk3'  WHEN '3' THEN 'mk3'
    WHEN 'v' THEN 'mk5'    WHEN '5' THEN 'mk5'
    WHEN 'vii' THEN 'mk7'  WHEN '7' THEN 'mk7'
    WHEN 'viii' THEN 'mk8' WHEN '8' THEN 'mk8'
  END
  FROM (SELECT id AS mid, regexp_match(name, '\m(?:mark|mk)\s*\.?\s*(viii|vii|iii|ii|i|v|[1-8])\M', 'i') AS m
          FROM instrument_models) x
 WHERE x.mid = instrument_models.id AND family = 'rhodes' AND x.m IS NOT NULL;

-- Key count from the name, by the same rule detectVariantKey() applies to
-- the chain: Piano Bass (32 keys) first, then a bare 54 / 73 / 88.
UPDATE instrument_models SET key_count = CASE
    WHEN name ~* 'piano\s*bass' THEN 32
    WHEN name ~ '\m54\M' THEN 54
    WHEN name ~ '\m73\M' THEN 73
    WHEN name ~ '\m88\M' THEN 88
  END
 WHERE name ~* 'piano\s*bass' OR name ~ '\m(54|73|88)\M';

-- 2. The facts view ---------------------------------------------------------
CREATE VIEW instrument_model_facts AS
WITH RECURSIVE walk AS (
  SELECT n.id, n.family, n.parent_id, n.name,
         n.name::text AS chain,
         n.mark, n.key_count, n.is_suitcase, n.active,
         1 AS depth
    FROM instrument_models n
   WHERE n.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.family, c.parent_id, c.name,
         w.chain || ' / ' || c.name,
         COALESCE(c.mark, w.mark),
         COALESCE(c.key_count, w.key_count),
         c.is_suitcase OR w.is_suitcase,
         c.active AND w.active,
         w.depth + 1
    FROM instrument_models c
    JOIN walk w ON c.parent_id = w.id
)
SELECT id, family, parent_id, name, chain, mark, key_count, is_suitcase, active, depth
  FROM walk;

DO $$
DECLARE
  n_nodes INTEGER;
  n_reach INTEGER;
BEGIN
  SELECT count(*) INTO n_nodes FROM instrument_models;
  SELECT count(*) INTO n_reach FROM instrument_model_facts;
  IF n_nodes <> n_reach THEN
    RAISE EXCEPTION 'instrument_models has % node(s) not reachable from a root (a parent cycle?) -- fix in Settings before migrating',
      n_nodes - n_reach;
  END IF;
END $$;

-- Parts-pricing variant: today's regex on the chain vs. the new facts.
CREATE FUNCTION pg_temp.variant_from_text(t TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN t ~* 'piano\s*bass' THEN 'piano_bass'
    WHEN t ~ '\m54\M' THEN '54_key'
    WHEN t ~ '\m73\M' THEN '73_key'
    WHEN t ~ '\m88\M' THEN '88_key'
  END;
$$ LANGUAGE sql IMMUTABLE;
CREATE FUNCTION pg_temp.variant_from_keys(k INTEGER) RETURNS TEXT AS $$
  SELECT CASE k WHEN 32 THEN 'piano_bass' WHEN 54 THEN '54_key' WHEN 73 THEN '73_key' WHEN 88 THEN '88_key' END;
$$ LANGUAGE sql IMMUTABLE;

DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(format('#%s %s (was %s, would be %s)', id, chain,
                           coalesce(pg_temp.variant_from_text(chain), 'none'),
                           coalesce(pg_temp.variant_from_keys(key_count), 'none')), '; ')
    INTO bad
    FROM instrument_model_facts
   WHERE pg_temp.variant_from_text(chain) IS DISTINCT FROM pg_temp.variant_from_keys(key_count);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'parts-pricing variant would change for: %', bad;
  END IF;
END $$;

-- 3. The matcher ------------------------------------------------------------
-- Text as written -> the one catalog node it unambiguously names, or NULL.
-- p_mark (a MARKS key or NULL) only breaks a tie between same-named nodes.
CREATE FUNCTION instrument_model_match(p_family TEXT, p_model TEXT, p_mark TEXT)
RETURNS INTEGER AS $$
DECLARE
  t TEXT := lower(regexp_replace(regexp_replace(btrim(coalesce(p_model, '')), '\s+', ' ', 'g'), '\s*/\s*', ' / ', 'g'));
  ids INTEGER[];
BEGIN
  IF t = '' OR p_family IS NULL THEN RETURN NULL; END IF;

  SELECT array_agg(id) INTO ids FROM instrument_model_facts
   WHERE family = p_family AND lower(chain) = t;
  IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  IF cardinality(ids) > 1 THEN RETURN NULL; END IF; -- duplicate siblings: don't guess

  SELECT array_agg(id) INTO ids FROM instrument_model_facts
   WHERE family = p_family AND lower(name) = t;
  IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  IF cardinality(ids) > 1 AND p_mark IS NOT NULL THEN
    SELECT array_agg(id) INTO ids FROM instrument_model_facts
     WHERE id = ANY (ids) AND mark = p_mark;
    IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- 4. Link instruments -------------------------------------------------------
ALTER TABLE instruments RENAME COLUMN mark TO mark_override;
ALTER TABLE instruments
  ADD COLUMN model_id INTEGER,
  ADD CONSTRAINT instruments_model_fk FOREIGN KEY (model_id, family)
    REFERENCES instrument_models (id, family) ON UPDATE CASCADE;
CREATE INDEX instruments_model_id_idx ON instruments (model_id) WHERE model_id IS NOT NULL;

-- Snapshot for the checks below (and for anyone auditing the link later --
-- it's a real table, kept, so "what did 086 link, and why" stays answerable).
CREATE TABLE instrument_model_link_audit (
  instrument_id  INTEGER PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  family         TEXT NOT NULL,
  model_text     TEXT,
  mark_before    TEXT,
  model_id       INTEGER,  -- NULL = left unlinked
  linked_chain   TEXT,
  note           TEXT,     -- why a match was not linked, when it wasn't
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO instrument_model_link_audit (instrument_id, family, model_text, mark_before, model_id)
SELECT id, family, model, mark_override, instrument_model_match(family, model, mark_override)
  FROM instruments;

-- A link must not change how the piece prices: if the model text alone
-- gives a different parts variant than the linked model would (or none
-- where the model gives one), leave it unlinked for a person to look at.
UPDATE instrument_model_link_audit a
   SET note = format('not linked: text prices as %s, model #%s as %s',
                     coalesce(pg_temp.variant_from_text(a.model_text), 'unknown'), a.model_id,
                     coalesce(pg_temp.variant_from_keys(f.key_count), 'unknown')),
       model_id = NULL
  FROM instrument_model_facts f
 WHERE f.id = a.model_id
   AND pg_temp.variant_from_text(a.model_text) IS DISTINCT FROM pg_temp.variant_from_keys(f.key_count);

UPDATE instruments i SET model_id = a.model_id
  FROM instrument_model_link_audit a
 WHERE a.instrument_id = i.id AND a.model_id IS NOT NULL;

UPDATE instrument_model_link_audit a SET linked_chain = f.chain
  FROM instrument_model_facts f WHERE f.id = a.model_id;

-- A stored mark that the linked model already implies is no longer an
-- override -- clear it so a later catalog fix reaches this piece too.
UPDATE instruments i SET mark_override = NULL
  FROM instrument_model_facts f
 WHERE f.id = i.model_id AND i.mark_override = f.mark;

DO $$
DECLARE
  changed INTEGER;
  linked INTEGER;
  unlinked INTEGER;
BEGIN
  -- Nothing about a piece may read differently afterwards.
  SELECT count(*) INTO changed
    FROM instrument_model_link_audit a
    JOIN instruments i ON i.id = a.instrument_id
    LEFT JOIN instrument_model_facts f ON f.id = i.model_id
   WHERE i.model IS DISTINCT FROM a.model_text
      OR i.family IS DISTINCT FROM a.family
      OR (a.mark_before IS NOT NULL AND COALESCE(i.mark_override, f.mark) IS DISTINCT FROM a.mark_before);
  IF changed > 0 THEN
    RAISE EXCEPTION '% instrument(s) would read differently after linking -- aborting', changed;
  END IF;

  SELECT count(*) FILTER (WHERE model_id IS NOT NULL), count(*) FILTER (WHERE model_id IS NULL AND model_text IS NOT NULL)
    INTO linked, unlinked FROM instrument_model_link_audit;
  RAISE NOTICE '086: linked % instrument(s) to the model catalog; % with model text left unlinked (see instrument_model_link_audit)',
    linked, unlinked;
END $$;
