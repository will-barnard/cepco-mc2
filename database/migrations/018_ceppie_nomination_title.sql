-- Adds a "Ceppie Title" to each nomination — the specific award name being
-- given, e.g. "Technical Ceppie for Innovation of the Laser Level", as
-- distinct from `reason` (why they earned it). Required going forward
-- (enforced in routes/ceppies.js, same pattern as `reason`), but the
-- column itself allows a default so this migration doesn't choke on any
-- nominations that already exist.
ALTER TABLE ceppie_nominations
  ADD COLUMN title TEXT NOT NULL DEFAULT '';

ALTER TABLE ceppie_nominations
  ALTER COLUMN title DROP DEFAULT;
