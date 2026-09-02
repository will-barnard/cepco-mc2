-- Two-way Xero customer-contact sync (Custom Connection, client_credentials
-- — see backend/src/xero.js). Two columns on customers, same "link + last
-- reconciled" shape as every other external-system link in this schema:
--
--   xero_contact_id  — Xero's ContactID (a GUID) once this customer has
--                       been matched or created on the Xero side. NULL for
--                       a customer that has never been reconciled — the
--                       common case for every existing row until the first
--                       sync runs.
--   xero_synced_at    — when services/xeroSync.js last reconciled this row
--                       (pulled from Xero, pushed to Xero, or found already
--                       in agreement) — NOT "when this row was last
--                       edited." Comparing this against both
--                       customers.updated_at and the Xero contact's own
--                       UpdatedDateUTC is how the sync decides which side,
--                       if either, changed since the two were last in sync
--                       — see that file's header for the full reconcile
--                       algorithm.
--
-- Partial unique index rather than a plain UNIQUE constraint: most rows
-- have xero_contact_id NULL (nothing wrong with that — not every customer
-- needs to exist in the shop's accounting system, e.g. a one-off walk-in),
-- and a plain UNIQUE would only allow a single NULL row under Postgres's
-- multi-NULL-is-fine rule anyway coincidentally working today with few
-- rows, but that's relying on undefined-feeling behavior; WHERE NOT NULL
-- says explicitly "unique only once actually linked."
ALTER TABLE customers ADD COLUMN xero_contact_id TEXT;
ALTER TABLE customers ADD COLUMN xero_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX customers_xero_contact_id_idx ON customers (xero_contact_id)
  WHERE xero_contact_id IS NOT NULL;

-- A contact that exists only in Xero (never created here) needs a real
-- source value once xeroSync.js pulls it in as a brand-new customer row —
-- 'xero' joins migration 001's original shopify/email/direct set rather
-- than being force-fit into 'direct', which already means something
-- specific (a walk-in, not synced from anywhere).
ALTER TABLE customers DROP CONSTRAINT customers_source_check;
ALTER TABLE customers ADD CONSTRAINT customers_source_check
  CHECK (source IN ('shopify', 'email', 'direct', 'xero'));
