-- Backfill review tool (services/xeroBackfill.js, XeroBackfillView.vue) —
-- when an admin looks at a fuzzy-matched candidate pair and says "no,
-- these are two different people," that decision needs to stick: not
-- just so the review screen stops re-suggesting it, but so the *regular*
-- two-way sync (services/xeroSync.js) doesn't turn around and auto-link
-- the same pair anyway if it happens to also share an exact email or name
-- (a real case — e.g. a parent and child who share a household email).
--
-- No FK to a xero contact id (Xero's ContactID lives entirely outside
-- this database) — customer_id is the only side this schema can actually
-- enforce referential integrity on, so ON DELETE CASCADE there only:
-- deleting the customer makes the dismissal meaningless anyway.
CREATE TABLE xero_dismissed_matches (
    customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    xero_contact_id TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, xero_contact_id)
);
