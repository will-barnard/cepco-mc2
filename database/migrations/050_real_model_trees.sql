-- Real model trees, sourced from the Listing Trees app (chicagoelectricpiano.com's
-- product-description-copy source of truth) rather than migration 036's placeholder
-- seed. Pulled via the listing-trees skill (trees: Rhodes #2, Wurlitzer #3, Farfisa #4,
-- Gibson & Kalamazoo #5, Howard #6, Vox #7, Electric String Pianos #8, Hohner #9,
-- Fender #10, Rheem #14, RMI #15, Lowrey #16) and collapsed to root + one level per
-- Will's call: Listing Trees goes deeper in places (Rhodes Mark I splits into
-- Fender-era/Late Torrington/Singer Tines/Schaller Tines sub-eras before cabinet type;
-- Wurlitzer's 200/200A eras separately list Early/Late sub-periods with identical model
-- number sets underneath) — that extra layer is flattened away here since no estimates
-- exist yet to migrate and the picker only needed to go one level deep.
--
-- No estimates reference the old placeholder rows in production, so this replaces them
-- outright rather than trying to preserve/remap ids — DELETE cascades to every child via
-- instrument_models' own parent_id FK (migration 036).
--
-- Family groupings follow instruments.family (routes/instruments.js's FAMILIES):
-- 'organ' covers every combo-organ brand CEPCo services (Farfisa/Vox/Gibson &
-- Kalamazoo/Howard/Rheem/RMI/Lowrey/Fender Contempo) as sibling root nodes, same as
-- 'hohner' covers Clavinet/Pianet/Cembalet and 'strings' covers the Yamaha CP series
-- and the Helpinstill Roadmaster. 'other' (the amp/rarity catch-all, migration 037) has
-- no Listing Trees copy to draw from and is left untouched.
--
-- is_suitcase (migration 045) is set only where the distinction is unambiguous: Rhodes'
-- own Suitcase 73/88 cabinet leaves, and Wurlitzer's three inherently self-contained
-- tube-amp eras (110 & 120 / 140-145 Pre-B / 140B-145B — the exact list migration 045's
-- own comment named) flagged at the era root, which is enough: the wizard checks every
-- node along the picked path, not just the leaf. Wurlitzer's 200/200A model numbers mix
-- built-in-speaker and bare-keyboard variants at a finer grain than this migration is
-- confident calling correctly one by one, so those are left FALSE — worth a pass in
-- Settings -> Instrument models from someone who knows that lineup's cabinets by number.

DELETE FROM instrument_models WHERE family IN ('rhodes', 'wurlitzer', 'hohner', 'strings', 'organ');

DO $$
DECLARE
  v_root INTEGER;
BEGIN
  -- rhodes
  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Mark I', 10, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('rhodes', v_root, 'Stage 73', 10, FALSE),
    ('rhodes', v_root, 'Stage 88', 20, FALSE),
    ('rhodes', v_root, 'Suitcase 73', 30, TRUE),
    ('rhodes', v_root, 'Suitcase 88', 40, TRUE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Mark II', 20, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('rhodes', v_root, 'Stage 73', 10, FALSE),
    ('rhodes', v_root, 'Stage 88', 20, FALSE),
    ('rhodes', v_root, 'Suitcase 73', 30, TRUE),
    ('rhodes', v_root, 'Suitcase 88', 40, TRUE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Sparkletop', 30, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Rhodes 54', 40, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Mark V', 50, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Mark 8', 60, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Piano Bass', 70, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('rhodes', NULL, 'Other', 999, TRUE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('rhodes', v_root, 'Pre-Piano', 10, FALSE),
    ('rhodes', v_root, 'Student Model', 20, FALSE),
    ('rhodes', v_root, 'Instructor Model', 30, FALSE);

  -- wurlitzer
  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('wurlitzer', NULL, '110 & 120 Era', 10, FALSE, TRUE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('wurlitzer', v_root, '100', 10, FALSE),
    ('wurlitzer', v_root, '110', 20, FALSE),
    ('wurlitzer', v_root, '111', 30, FALSE),
    ('wurlitzer', v_root, '112', 40, FALSE),
    ('wurlitzer', v_root, '112A', 50, FALSE),
    ('wurlitzer', v_root, '120', 60, FALSE),
    ('wurlitzer', v_root, '700', 70, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('wurlitzer', NULL, '140/145 Era (Pre-B)', 20, FALSE, TRUE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('wurlitzer', v_root, '140', 10, FALSE),
    ('wurlitzer', v_root, '145', 20, FALSE),
    ('wurlitzer', v_root, '140A', 30, FALSE),
    ('wurlitzer', v_root, '145A', 40, FALSE),
    ('wurlitzer', v_root, '720A', 50, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('wurlitzer', NULL, '140B/145B Era', 30, FALSE, TRUE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('wurlitzer', v_root, '140B', 10, FALSE),
    ('wurlitzer', v_root, '145B', 20, FALSE),
    ('wurlitzer', v_root, '720B', 30, FALSE),
    ('wurlitzer', v_root, '146B', 40, FALSE),
    ('wurlitzer', v_root, '726B', 50, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('wurlitzer', NULL, '200 Era', 40, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('wurlitzer', v_root, '200', 10, FALSE),
    ('wurlitzer', v_root, '203', 20, FALSE),
    ('wurlitzer', v_root, '203W', 30, FALSE),
    ('wurlitzer', v_root, '206', 40, FALSE),
    ('wurlitzer', v_root, '207', 50, FALSE),
    ('wurlitzer', v_root, '207V', 60, FALSE),
    ('wurlitzer', v_root, '106', 70, FALSE),
    ('wurlitzer', v_root, '214V', 80, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('wurlitzer', NULL, '200A Era', 50, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('wurlitzer', v_root, '200A', 10, FALSE),
    ('wurlitzer', v_root, '206A', 20, FALSE),
    ('wurlitzer', v_root, '207A', 30, FALSE),
    ('wurlitzer', v_root, '207VA', 40, FALSE),
    ('wurlitzer', v_root, '210', 50, FALSE),
    ('wurlitzer', v_root, '210A', 60, FALSE),
    ('wurlitzer', v_root, '214VA', 70, FALSE),
    ('wurlitzer', v_root, '270', 80, FALSE),
    ('wurlitzer', v_root, '205V', 90, FALSE),
    ('wurlitzer', v_root, '215V', 100, FALSE),
    ('wurlitzer', v_root, '200B', 110, FALSE),
    ('wurlitzer', v_root, '300', 120, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('wurlitzer', NULL, 'Other', 999, TRUE, FALSE);

  -- hohner
  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('hohner', NULL, 'Clavinet', 10, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('hohner', v_root, 'Clavinet I', 10, FALSE),
    ('hohner', v_root, 'Clavinet II', 20, FALSE),
    ('hohner', v_root, 'Clavinet C', 30, FALSE),
    ('hohner', v_root, 'Clavinet D6', 40, FALSE),
    ('hohner', v_root, 'Clavinet E7', 50, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('hohner', NULL, 'Pianet', 20, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('hohner', v_root, 'Pianet N', 10, FALSE),
    ('hohner', v_root, 'Pianet T', 20, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('hohner', NULL, 'Cembalet', 30, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('hohner', v_root, 'Cembalet I', 10, FALSE),
    ('hohner', v_root, 'Cembalet II', 20, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('hohner', NULL, 'Other', 999, TRUE, FALSE);

  -- strings
  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('strings', NULL, 'Yamaha CP Series', 10, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('strings', v_root, 'CP-70', 10, FALSE),
    ('strings', v_root, 'CP-70B', 20, FALSE),
    ('strings', v_root, 'CP-70D', 30, FALSE),
    ('strings', v_root, 'CP-70M', 40, FALSE),
    ('strings', v_root, 'CP-80', 50, FALSE),
    ('strings', v_root, 'CP-80B', 60, FALSE),
    ('strings', v_root, 'CP-80D', 70, FALSE),
    ('strings', v_root, 'CP-80M', 80, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('strings', NULL, 'Helpinstill Roadmaster', 20, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('strings', v_root, 'Roadmaster 64', 10, FALSE),
    ('strings', v_root, 'Roadmaster 88', 20, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('strings', NULL, 'Other', 999, TRUE, FALSE);

  -- organ
  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Farfisa', 10, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('organ', v_root, 'Combo Compact', 10, FALSE),
    ('organ', v_root, 'Mini Compact', 20, FALSE),
    ('organ', v_root, 'Compact Deluxe', 30, FALSE),
    ('organ', v_root, 'Compact Duo', 40, FALSE),
    ('organ', v_root, 'FAST 2', 50, FALSE),
    ('organ', v_root, 'FAST 3', 60, FALSE),
    ('organ', v_root, 'FAST 4', 70, FALSE),
    ('organ', v_root, 'FAST 5', 80, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Vox', 20, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('organ', v_root, 'Continental', 10, FALSE),
    ('organ', v_root, 'Continental II / Super Continental', 20, FALSE),
    ('organ', v_root, 'Jaguar', 30, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Gibson & Kalamazoo', 30, FALSE, FALSE)
    RETURNING id INTO v_root;
  INSERT INTO instrument_models (family, parent_id, name, sort_order, is_suitcase) VALUES
    ('organ', v_root, 'Kalamazoo K-101', 10, FALSE),
    ('organ', v_root, 'Gibson G-101', 20, FALSE),
    ('organ', v_root, 'Gibson G-201', 30, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Rheem Mark VII', 40, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'RMI 368X Electra-Piano', 50, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Lowrey T2', 60, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Fender Contempo Organ', 70, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Howard Combo Organ', 80, FALSE, FALSE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual, is_suitcase)
    VALUES ('organ', NULL, 'Other', 999, TRUE, FALSE);

END $$;
