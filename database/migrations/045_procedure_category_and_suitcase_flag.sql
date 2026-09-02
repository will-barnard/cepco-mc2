-- N10 (boss-list scope): the estimate builder is being reworked into an
-- iPad-friendly, one-thing-at-a-time wizard (EstimateNewView.vue) whose
-- screens 3-6 are literally "Standard Setup & Actions" / "Electronics" /
-- "Cosmetics" / "Parts" — the same four groupings the migration 044
-- pricing-sheet import already used as section comments (Basic Repairs +
-- Action Services, Electronics, Cosmetic Services, Replacement Parts/
-- Common Parts) but never captured as real data. This adds that as an
-- actual column so the wizard can query for it instead of matching on
-- section comments that only ever lived in a migration file.
--
-- Nullable, not required: a procedure with no category set is still shown
-- (the wizard falls back to bucketing an uncategorized procedure under
-- "Standard Setup & Actions" — see EstimateNewView.vue) rather than
-- becoming invisible to the estimate builder, same "additive scaffold,
-- nothing already-working can silently break" posture as migration 036/
-- 037's family work.
ALTER TABLE standard_procedures
  ADD COLUMN category TEXT
    CHECK (category IN ('standard_setup', 'electronics', 'cosmetics', 'parts'));

-- Backfill by id — safe because these 81 rows are exactly migration 044's
-- seed, inserted in one shot into what was an empty table (ids 1-81 in
-- that migration's own VALUES order), and Postgres never reuses/renumbers
-- an existing SERIAL id regardless of what's been added since. Anything
-- an admin has added by hand since deploy has an id > 81 and is left
-- uncategorized here — same "boss can fix it in Settings" scaffold
-- posture as everything else N7/N10 touches; Settings -> Standard
-- procedures gets a Category picker (routes/procedures.js, ProceduresView.vue)
-- to fix these up (or re-bucket a row the mapping below got wrong) without
-- another migration.
UPDATE standard_procedures SET category = 'standard_setup'
  WHERE id BETWEEN 1 AND 14   -- Rhodes Standard Setup & Basic Repairs + Action Services
     OR id BETWEEN 41 AND 48; -- Wurlitzer 200 Series Services (tuning/voicing, key bed, fly springs/felts)

UPDATE standard_procedures SET category = 'cosmetics'
  WHERE id BETWEEN 15 AND 20  -- Rhodes Cosmetic Services
     OR id BETWEEN 68 AND 69; -- Wurlitzer 200 Cosmetic Services

UPDATE standard_procedures SET category = 'electronics'
  WHERE id BETWEEN 21 AND 31  -- Rhodes Electronics (Peterson/Janus preamp+power supply — the Suitcase's built-in amp)
     OR id BETWEEN 62 AND 67  -- Wurlitzer 200 Series Electronics
     OR id BETWEEN 70 AND 81; -- Wurlitzer 140/145 + 110/120 Services — these models ARE self-contained
                               -- tube amps, so their whole "Services" section is amp/electronics work.

UPDATE standard_procedures SET category = 'parts'
  WHERE id BETWEEN 32 AND 40  -- Rhodes Replacement Parts
     OR id BETWEEN 49 AND 61; -- Wurlitzer 200 Series Common Parts

-- N10: lets a leaf (or branch) of instrument_models' tree flag itself as a
-- Suitcase-style variant — Rhodes Suitcase 73/88 and Wurlitzer's
-- self-contained tube-amp models (140B/145/110/120), as opposed to a
-- Stage-style instrument with no built-in amp electronics. The estimate
-- wizard's Electronics screen (category = 'electronics' above) is shown
-- only when the instrument being quoted has this flag set somewhere along
-- its picked path — "Electronics (Suitcase only)" per the boss's sketch —
-- rather than for every instrument in a family that happens to have
-- electronics procedures at all. Same per-node boolean convention as
-- allow_manual (migration 036): admin-settable, defaults to FALSE so
-- nothing about the existing placeholder tree changes shape until someone
-- actually flags a node.
ALTER TABLE instrument_models
  ADD COLUMN is_suitcase BOOLEAN NOT NULL DEFAULT FALSE;
