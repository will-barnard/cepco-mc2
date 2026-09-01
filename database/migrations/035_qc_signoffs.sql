-- Q6 (boss-list scope): Setup QC and Final Assembly QC need different
-- numbers of signatures — Setup QC (round 1) needs one reviewer, Final
-- Assembly QC (round 2) needs two distinct techs literally checking the
-- same final pass before that round counts as passed. qc_checks could
-- only ever hold one reviewer_id/signed_off_at (migration 021's round
-- progression still assumed one signer per round), so there was no way to
-- record a second signature on the same round at all — the
-- REQUIRE_DISTINCT_REVIEWERS rule in routes/qc.js worked around that by
-- requiring two distinct reviewers *somewhere across the ticket's rounds*
-- instead, which isn't the same thing as two people checking one round.
--
-- qc_checks.reviewer_id/passed/signed_off_at are left in place rather than
-- dropped — they still mean exactly what they always meant for a 1-
-- signoff round (round_number 1's default), and now double as "the round
-- is fully signed off" once a multi-signoff round crosses its threshold
-- (reviewer_id becomes "whoever's signature closed it," informational —
-- routes/qc.js and TicketQc.vue read the full list from the new table).
CREATE TABLE qc_check_signoffs (
    id            SERIAL PRIMARY KEY,
    qc_check_id   INTEGER NOT NULL REFERENCES qc_checks(id) ON DELETE CASCADE,
    reviewer_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    passed        BOOLEAN NOT NULL DEFAULT TRUE,
    signed_off_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One signature per person per round — re-signing (routes/qc.js's
    -- sign-off route upserts) replaces their own row rather than piling up
    -- a history of the same person flip-flopping.
    UNIQUE (qc_check_id, reviewer_id)
);
CREATE INDEX qc_check_signoffs_check_idx ON qc_check_signoffs (qc_check_id);

-- How many distinct people need to sign a round built from this template
-- before the round itself is "passed." Defaults to 1 — today's actual
-- behavior for every existing template.
ALTER TABLE qc_templates ADD COLUMN required_signoffs INTEGER NOT NULL DEFAULT 1
  CHECK (required_signoffs >= 1);

-- The boss's stated rule structurally: every family's closing round
-- (round_number 2, "Final Assembly QC" whatever it ends up named — see
-- backend/src/scripts/seed.js and NOTES.md, the rename/content rewrite
-- itself is a shop job, not this migration's) needs two signatures.
-- Round 1 ("Setup QC") stays at the default of 1.
UPDATE qc_templates SET required_signoffs = 2 WHERE round_number = 2;

-- Backfill: every qc_checks row already signed off under the old one-
-- reviewer-per-round model becomes that round's recorded signoff — no
-- history lost, and it's exactly what "required_signoffs = 1" rounds
-- (everything except round 2, until the shop's rename/rework lands) still
-- expect going forward.
INSERT INTO qc_check_signoffs (qc_check_id, reviewer_id, passed, signed_off_at)
SELECT id, reviewer_id, passed, signed_off_at
  FROM qc_checks
 WHERE signed_off_at IS NOT NULL AND reviewer_id IS NOT NULL
ON CONFLICT (qc_check_id, reviewer_id) DO NOTHING;
