-- ===========================================================================
-- Instrument attributes: Mark becomes one of a list, and Rhodes suitcase
-- amp type is the second (NOTES.md §2.108).
--
-- Mark (085/086) was built as one bespoke field: instrument_models.mark on
-- the catalog, instruments.mark_override on a piece. The suitcase amp --
-- Jordan / Peterson / Janus -- works exactly the same way (a Mark II
-- suitcase is always Janus; a single piece can differ: a swapped amp, a
-- spare cabinet), and more of these will come. So both become entries in
-- one shape:
--
--   instrument_models.attrs     { "mark": "mk2", "suitcase_amp": "janus" }
--                               set on a node, inherited down the tree
--                               (a child's own value wins) -- the view
--                               instrument_model_facts merges them like it
--                               already did mark and key_count
--   instruments.attr_overrides  only where this piece differs from its model
--
-- A piece's effective attributes are (its model's attrs) || attr_overrides.
-- Which attributes exist, their options, and which families use them is
-- the list in services/instrumentCatalog.js (ATTRIBUTES), served at
-- GET /instruments/attributes; the database just stores keys.
--
-- Moving Mark: every catalog node's mark becomes attrs.mark, every piece's
-- mark_override becomes attr_overrides.mark, then the two old columns go.
-- The migration checks that every node's and every instrument's effective
-- Mark is exactly what it was before dropping anything, and rolls back if not.
--
-- Suitcase amp, filled in where it's unambiguous (the rest are set by hand):
--   - catalog: Rhodes suitcase models under Mark II are Janus (the Mark II
--     suitcases all shipped with the Janus amp);
--   - pieces: a Rhodes whose model, section or name says Peterson, Janus or
--     Jordan ("Megan K Spare Peterson bottom" / "Peterson cabinet"), kept as
--     an override only where it differs from what its model says.
-- Not from the year: amps were swapped often enough that a guess would be
-- wrong for exactly the pieces where it matters.
-- ===========================================================================

-- Keep updated_at meaning "someone edited this" -- the backfill isn't that.
ALTER TABLE instruments DISABLE TRIGGER instruments_touch;

CREATE TEMP TABLE _node_mark_before ON COMMIT DROP AS
  SELECT id, mark FROM instrument_model_facts;
CREATE TEMP TABLE _mark_before ON COMMIT DROP AS
  SELECT i.id, COALESCE(i.mark_override, f.mark) AS mark
    FROM instruments i LEFT JOIN instrument_model_facts f ON f.id = i.model_id;

ALTER TABLE instrument_models
  ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT instrument_models_attrs_object CHECK (jsonb_typeof(attrs) = 'object');
UPDATE instrument_models SET attrs = jsonb_build_object('mark', mark) WHERE mark IS NOT NULL;

ALTER TABLE instruments
  ADD COLUMN attr_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT instruments_attr_overrides_object CHECK (jsonb_typeof(attr_overrides) = 'object');
UPDATE instruments SET attr_overrides = jsonb_build_object('mark', mark_override) WHERE mark_override IS NOT NULL;

-- The facts view, with attrs merged down the tree in place of mark.
DROP VIEW instrument_model_facts;
CREATE VIEW instrument_model_facts AS
WITH RECURSIVE walk AS (
  SELECT n.id, n.family, n.parent_id, n.name,
         n.name::text AS chain,
         n.attrs, n.key_count, n.is_suitcase, n.active,
         1 AS depth
    FROM instrument_models n
   WHERE n.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.family, c.parent_id, c.name,
         w.chain || ' / ' || c.name,
         w.attrs || c.attrs,
         COALESCE(c.key_count, w.key_count),
         c.is_suitcase OR w.is_suitcase,
         c.active AND w.active,
         w.depth + 1
    FROM instrument_models c
    JOIN walk w ON c.parent_id = w.id
)
SELECT id, family, parent_id, name, chain, attrs, key_count, is_suitcase, active, depth
  FROM walk;

-- The text matcher's tie-break reads the mark from attrs now. Same rule.
CREATE OR REPLACE FUNCTION instrument_model_match(p_family TEXT, p_model TEXT, p_mark TEXT)
RETURNS INTEGER AS $$
DECLARE
  t TEXT := lower(regexp_replace(regexp_replace(btrim(coalesce(p_model, '')), '\s+', ' ', 'g'), '\s*/\s*', ' / ', 'g'));
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

-- Overrides minus whatever the model already says -- what's left is how
-- this piece really differs. Used below and by the inventory importer.
CREATE FUNCTION instrument_attrs_prune(overrides JSONB, model_attrs JSONB) RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM jsonb_each(COALESCE(overrides, '{}'::jsonb)) e
   WHERE model_attrs IS NULL OR model_attrs -> e.key IS DISTINCT FROM e.value;
$$ LANGUAGE sql IMMUTABLE;

-- Nothing about Mark may read differently; only then do the old columns go.
DO $$
DECLARE
  bad INTEGER;
BEGIN
  SELECT count(*) INTO bad
    FROM _node_mark_before b JOIN instrument_model_facts f ON f.id = b.id
   WHERE f.attrs->>'mark' IS DISTINCT FROM b.mark;
  IF bad > 0 THEN RAISE EXCEPTION '089: % catalog model(s) would change Mark -- aborting', bad; END IF;
  SELECT count(*) INTO bad
    FROM _mark_before b JOIN instruments i ON i.id = b.id
    LEFT JOIN instrument_model_facts f ON f.id = i.model_id
   WHERE (COALESCE(f.attrs, '{}'::jsonb) || i.attr_overrides)->>'mark' IS DISTINCT FROM b.mark;
  IF bad > 0 THEN RAISE EXCEPTION '089: % instrument(s) would change Mark -- aborting', bad; END IF;
END $$;

ALTER TABLE instrument_models DROP COLUMN mark;
ALTER TABLE instruments DROP COLUMN mark_override;

-- Suitcase amp ---------------------------------------------------------------
UPDATE instrument_models n
   SET attrs = n.attrs || '{"suitcase_amp": "janus"}'::jsonb
  FROM instrument_model_facts f
 WHERE f.id = n.id AND n.family = 'rhodes' AND n.is_suitcase AND f.attrs->>'mark' = 'mk2'
   AND NOT (n.attrs ? 'suitcase_amp');

CREATE TEMP TABLE _amp_from_text ON COMMIT DROP AS
SELECT i.id,
       lower(COALESCE(
         substring(i.model FROM '(?i)\m(peterson|janus|jordan)\M'),
         substring(i.model_group FROM '(?i)\m(peterson|janus|jordan)\M'),
         substring(i.nickname FROM '(?i)\m(peterson|janus|jordan)\M'))) AS amp
  FROM instruments i
 WHERE i.family = 'rhodes';
DELETE FROM _amp_from_text WHERE amp IS NULL;

UPDATE instruments i
   SET attr_overrides = instrument_attrs_prune(
         i.attr_overrides || jsonb_build_object('suitcase_amp', t.amp),
         (SELECT f.attrs FROM instrument_model_facts f WHERE f.id = i.model_id))
  FROM _amp_from_text t
 WHERE t.id = i.id AND NOT (i.attr_overrides ? 'suitcase_amp');

ALTER TABLE instruments ENABLE TRIGGER instruments_touch;

DO $$
BEGIN
  RAISE NOTICE '089: Mark moved to attributes; suitcase amp set on % catalog model(s) and read from the text of % piece(s)',
    (SELECT count(*) FROM instrument_models WHERE attrs ? 'suitcase_amp'),
    (SELECT count(*) FROM _amp_from_text);
END $$;
