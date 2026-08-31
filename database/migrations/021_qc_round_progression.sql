-- Retires QC rigor tiers in favor of a standardized, per-instrument-family
-- round progression: every family now works through an ordered sequence of
-- QC rounds (Round 1, Round 2, ...), each with its own checklist template,
-- always taken in that order (round_number is assigned sequentially by
-- routes/qc.js — there is no way to start round 2 before round 1 exists).
-- Passing QC is now a fixed, global rule for every ticket rather than a
-- per-tier setting: 2 rounds signed off, by 2 different reviewers. See
-- routes/qc.js's REQUIRED_ROUNDS/REQUIRE_DISTINCT_REVIEWERS and NOTES.md.
--
-- "Retire," not delete (§8's own convention): existing qc_tier settings
-- rows and every qc_templates.tier_key / qc_checks.tier_key value already
-- written stay exactly as they are, readable for historical display
-- (TicketQc.vue's old rounds still show whatever tier they were run
-- under) — only the *columns* stop being required, and the qc_tier
-- category stops being creatable/editable going forward (removed from
-- backend/src/services/settings.js's CATEGORIES).
UPDATE settings SET retired = TRUE WHERE category = 'qc_tier';

ALTER TABLE qc_templates ALTER COLUMN tier_key DROP NOT NULL;
ALTER TABLE qc_checks    ALTER COLUMN tier_key DROP NOT NULL;

-- round_number is qc_templates' new equivalent of tier_key: which stage of
-- the standardized progression this template belongs to, scoped within its
-- (family, kind) — e.g. Wurlitzer/qc round 1 is a different row from
-- Wurlitzer/qc round 2. Defaults to 1 so every existing template (all of
-- which were single-round content under the old model) keeps behaving
-- exactly as it did, except the two Wurlitzer rows explicitly fixed below.
ALTER TABLE qc_templates ADD COLUMN round_number INTEGER NOT NULL DEFAULT 1;

-- The only two seeded templates that were ever a *second* stage (PLAN §6's
-- "QC Round 1" / "QC Final" reference model) — everything else stays at
-- the round_number=1 default. Matched by name, same idempotent-by-name
-- pattern backend/src/scripts/seed.js already uses for this table, so this
-- is a no-op on a database that never had these rows.
UPDATE qc_templates SET round_number = 1 WHERE name = 'Wurlitzer — QC Round 1';
UPDATE qc_templates SET round_number = 2 WHERE name = 'Wurlitzer — QC Final';
