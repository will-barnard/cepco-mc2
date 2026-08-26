-- ===========================================================================
-- Shared-computer quick switching (shop floor kiosk mode).
--
-- Junior/senior staff switch identities on a shared browser with a single
-- tap and no credential (accepted risk for a shop-floor machine — see
-- NOTES.md). Admin accounts are higher value, so switching *into* an admin
-- additionally requires this 4-digit PIN, checked the same way a password
-- is: hashed at rest, never stored or logged in the clear.
--
-- Nullable and independent of `active`/`role` — a PIN can be set ahead of
-- time, and a non-admin may have one sitting unused if they're later
-- promoted.
-- ===========================================================================

ALTER TABLE employees ADD COLUMN pin_hash TEXT;
