-- Wurlitzer 214 (shop request, Nov 2026): the plain 214 console, in the
-- 200 Era beside its 214V sibling. Migration 050 seeded the 214V (200 Era)
-- and 214VA (200A Era) from the listing tree but never the 214 itself,
-- although the shop's own Inventory Log lists it among its console 200
-- pianos (see 091).
--
-- Console like the rest of that family (091's is_console), not a suitcase.
-- Keys and any other facts come down the tree from 200 Era the same way
-- its siblings' do, so nothing else is set on the node itself. Sorted just
-- ahead of the 214V.
--
-- Unlinked Wurlitzers whose model text is just "214" (or "214 chop", which
-- the matcher reads the same since 091) had nothing to link to until now,
-- so they're linked here -- only where the matcher finds exactly this node.

DO $$
DECLARE
  v_era INTEGER;
  v_id  INTEGER;
BEGIN
  SELECT id INTO v_era FROM instrument_models
   WHERE family = 'wurlitzer' AND parent_id IS NULL AND name = '200 Era';
  IF v_era IS NULL THEN
    RAISE NOTICE '092: no Wurlitzer "200 Era" node -- 214 not added';
    RETURN;
  END IF;

  SELECT id INTO v_id FROM instrument_models
   WHERE family = 'wurlitzer' AND parent_id = v_era AND name = '214';
  IF v_id IS NULL THEN
    INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase, is_console)
    VALUES ('wurlitzer', v_era, '214', 75, FALSE, TRUE)
    RETURNING id INTO v_id;
  END IF;

  -- Keep updated_at meaning "someone edited this" (same as 089 / 091).
  ALTER TABLE instruments DISABLE TRIGGER instruments_touch;
  UPDATE instruments
     SET model_id = v_id
   WHERE family = 'wurlitzer' AND model_id IS NULL
     AND instrument_model_match(family, model, NULL) = v_id;
  ALTER TABLE instruments ENABLE TRIGGER instruments_touch;
END $$;
