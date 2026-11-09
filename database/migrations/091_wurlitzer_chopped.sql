-- ===========================================================================
-- Wurlitzer "chopped" (NOTES.md §2.110).
--
-- A console Wurlitzer (206, 214, ...) is often "chopped": taken off its
-- console base and made into a portable / stage piano. That changes what
-- the piece is -- price, shipping, which parts it needs -- so it's a flag on
-- the instrument, an attribute like Mark and suitcase amp (migration 089):
-- attr_overrides.chopped = 'yes'. The attribute itself is an entry in
-- services/instrumentCatalog.js's ATTRIBUTES (piece-only: a model is never
-- chopped, so the catalog can't set it).
--
-- Where the checkbox shows is a new catalog fact, is_console, resolved down
-- the tree like is_suitcase (true anywhere on the path): shown for a piece
-- on a console model, an unlinked piece, or one already marked; hidden for
-- a known non-console model (a 200A). Edited in Settings -> Instrument models.
--
-- Flagged console here, from the shop's own Inventory Log ("Wurlitzer
-- Console 200 Pianos": 203, 206, 206A, 214) plus their direct siblings
-- (203W; the 207 teacher's consoles of the 206; 214V/VA) and the 215V the
-- shop lists as its "Shop Console Piano", and the 270 Butterfly. Left for
-- someone who knows the cabinets by number: 205V, 210/210A, 106, 700,
-- 145/145A/145B, 720A/720B, 726B.
--
-- Pieces marked chopped: a Wurlitzer whose model text or nickname says
-- "chopped" ("206 (chopped)"), or plain "chop" on an Inventory Log row
-- ("214 chop") -- there it describes the piece. Not a bare "chop" anywhere
-- else: the ticket importer put a whole job cell in the model text, and a
-- job queue's "206a chop" is a chop still to do. Not from notes either --
-- "good chop candidate" / "chop & sell" / "ideal for chop" are about pieces
-- that aren't chopped yet. The rest are set by hand.
--
-- The model matcher now ignores a chop word, so "206 (chopped)" links to
-- the 206 like "206" does; those pieces are re-linked below.
-- ===========================================================================

ALTER TABLE instrument_models ADD COLUMN is_console BOOLEAN NOT NULL DEFAULT FALSE;

DROP VIEW instrument_model_facts;
CREATE VIEW instrument_model_facts AS
WITH RECURSIVE walk AS (
  SELECT n.id, n.family, n.parent_id, n.name,
         n.name::text AS chain,
         n.attrs, n.key_count, n.is_suitcase, n.is_console, n.active,
         1 AS depth
    FROM instrument_models n
   WHERE n.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.family, c.parent_id, c.name,
         w.chain || ' / ' || c.name,
         w.attrs || c.attrs,
         COALESCE(c.key_count, w.key_count),
         c.is_suitcase OR w.is_suitcase,
         c.is_console OR w.is_console,
         c.active AND w.active,
         w.depth + 1
    FROM instrument_models c
    JOIN walk w ON c.parent_id = w.id
)
SELECT id, family, parent_id, name, chain, attrs, key_count, is_suitcase, active, depth, is_console
  FROM walk;

-- Same rule as migration 089's, plus: a chop word ("chopped", "chop",
-- "(chopped)") isn't part of a model's name.
CREATE OR REPLACE FUNCTION instrument_model_match(p_family TEXT, p_model TEXT, p_mark TEXT)
RETURNS INTEGER AS $$
DECLARE
  t TEXT := lower(regexp_replace(btrim(regexp_replace(regexp_replace(
              coalesce(p_model, ''), '\(?\s*\mchop(ped)?\M\s*\)?', ' ', 'gi'), '\s+', ' ', 'g')),
              '\s*/\s*', ' / ', 'g'));
  ids INTEGER[];
BEGIN
  IF t = '' OR p_family IS NULL THEN RETURN NULL; END IF;

  SELECT array_agg(id) INTO ids FROM instrument_model_facts
   WHERE family = p_family AND lower(chain) = t;
  IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  IF cardinality(ids) > 1 THEN RETURN NULL; END IF;

  SELECT array_agg(id) INTO ids FROM instrument_model_facts
   WHERE family = p_family AND lower(name) = t;
  IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  IF cardinality(ids) > 1 AND p_mark IS NOT NULL THEN
    SELECT array_agg(id) INTO ids FROM instrument_model_facts
     WHERE id = ANY (ids) AND attrs->>'mark' = p_mark;
    IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

UPDATE instrument_models SET is_console = TRUE
 WHERE family = 'wurlitzer'
   AND name IN ('203', '203W', '206', '206A', '207', '207V', '207A', '207VA', '214V', '214VA', '215V', '270');

-- Keep updated_at meaning "someone edited this" (same as 089).
ALTER TABLE instruments DISABLE TRIGGER instruments_touch;

UPDATE instruments
   SET attr_overrides = attr_overrides || '{"chopped": "yes"}'::jsonb
 WHERE family = 'wurlitzer'
   AND (model ~* '\mchopped\M' OR nickname ~* '\mchopped\M'
        OR (import_key LIKE 'inventory_log:%' AND (model ~* '\mchop\M' OR nickname ~* '\mchop\M')))
   AND NOT attr_overrides ? 'chopped';

UPDATE instruments
   SET model_id = instrument_model_match(family, model, NULL)
 WHERE model_id IS NULL AND family = 'wurlitzer' AND model ~* '\mchop(ped)?\M'
   AND instrument_model_match(family, model, NULL) IS NOT NULL;

ALTER TABLE instruments ENABLE TRIGGER instruments_touch;
