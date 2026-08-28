-- "Ceppie" was a misspelling — the fictional award is "Ceppy" (plural
-- "Ceppys", same pattern as Emmy/Emmys, Grammy/Grammys). Migrations 017 and
-- 018 are left exactly as they ran (forward-only — never edit an applied
-- migration's SQL); this migration carries the rename forward instead.
ALTER TABLE ceppie_nominations RENAME TO ceppy_nominations;

ALTER INDEX ceppie_nominations_pending_by_nominator_idx
  RENAME TO ceppy_nominations_pending_by_nominator_idx;

ALTER INDEX ceppie_nominations_past_idx
  RENAME TO ceppy_nominations_past_idx;

-- The schedule's settings row (category='shop_config') is keyed by name, not
-- id, so the rename has to happen in data, not just schema. seed.js's
-- SETTINGS array is updated to the new key in the same change, and its
-- ON CONFLICT (category, key) DO NOTHING means it will never duplicate this
-- row on an environment where this UPDATE has already run.
UPDATE settings SET key = 'ceppys_schedule'
  WHERE category = 'shop_config' AND key = 'ceppies_schedule';
