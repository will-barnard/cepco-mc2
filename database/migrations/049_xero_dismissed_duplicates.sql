-- Duplicate-review dismissals for services/xeroDuplicates.js — separate
-- from xero_dismissed_matches (migration 048), which records "this MC2
-- customer is not the same person as this Xero contact." This table
-- instead records "these two MC2 customer *rows* are not the same person"
-- for the duplicate-merge review screen that exists because the regular
-- sync's exact-email/exact-name matching missed some pre-existing
-- customers and created new source='xero' rows for them instead of
-- linking. See NOTES.md for the full writeup.
CREATE TABLE xero_dismissed_duplicate_pairs (
    survivor_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    duplicate_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (survivor_id, duplicate_id)
);
