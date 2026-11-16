-- ===========================================================================
-- Shopify order intake v2 (Nov 2026).
--
-- The webhook used to do everything inline: match/create a customer, make
-- one Orders & Shipping ticket per order, reply 200. That stops working once
-- an order also needs a product-tag lookup against Shopify and two Xero
-- calls -- Shopify wants its 200 within five seconds and retries anything
-- slower, and neither Xero call is idempotent the way the ticket insert is.
-- So the webhook now only *records* the order here and replies; the steps
-- run right after, in-process (services/shopifyOrders.js), with each step's
-- outcome stored on this row so a failure can be retried on its own.
--
-- Step statuses, shared by all four step columns:
--   pending    not attempted yet
--   done       finished
--   skipped    deliberately not done (setting off, nothing to do, cancelled)
--   waiting    blocked on something that resolves by itself -- payment for
--              the ticket step, a Xero link for the note step
--   failed     transient error (Shopify/Xero down, token problem); the sweep
--              retries it
--   attention  needs a person -- e.g. two Xero contacts share the email, so
--              linking either one would be a guess
-- `detail` holds a short human-readable message per step, keyed by step.
-- ===========================================================================

CREATE TABLE shopify_orders (
    id                   SERIAL PRIMARY KEY,
    shopify_order_id     TEXT NOT NULL UNIQUE,
    order_name           TEXT,                 -- "#1234"
    financial_status     TEXT,
    source_name          TEXT,                 -- 'web', 'pos', a channel's own name...
    cancelled            BOOLEAN NOT NULL DEFAULT FALSE,
    cancel_handled_at    TIMESTAMPTZ,
    -- The latest version of the order Shopify has sent us (create, then
    -- paid/updated/cancelled overwrite it when newer).
    payload              JSONB NOT NULL,
    customer_id          INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    ticket_ids           INTEGER[] NOT NULL DEFAULT '{}',
    customer_status      TEXT NOT NULL DEFAULT 'pending',
    xero_contact_status  TEXT NOT NULL DEFAULT 'pending',
    ticket_status        TEXT NOT NULL DEFAULT 'pending',
    xero_note_status     TEXT NOT NULL DEFAULT 'pending',
    detail               JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Automatic retries stop after a cap (see services/shopifyOrders.js);
    -- "Re-run" in Settings resets this.
    attempts             INTEGER NOT NULL DEFAULT 0,
    -- A newer delivery for this order arrived while a run was in progress;
    -- the run goes round once more before releasing its lease.
    needs_rerun          BOOLEAN NOT NULL DEFAULT FALSE,
    -- Single-runner lease, so a redelivery landing mid-run can't create a
    -- second Xero contact or post the note twice.
    lease_until          TIMESTAMPTZ,
    received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at         TIMESTAMPTZ,
    CONSTRAINT shopify_orders_step_values CHECK (
      customer_status     IN ('pending','done','skipped','waiting','failed','attention') AND
      xero_contact_status IN ('pending','done','skipped','waiting','failed','attention') AND
      ticket_status       IN ('pending','done','skipped','waiting','failed','attention') AND
      xero_note_status    IN ('pending','done','skipped','waiting','failed','attention')
    )
);
CREATE INDEX shopify_orders_received_idx ON shopify_orders (received_at DESC);

-- Tag rules (Settings -> Shopify orders). An order item whose Shopify
-- product carries `tag` gets `action` instead of the default shipping
-- ticket: 'no_ticket' leaves it off every ticket (drop-ship, special order,
-- made to order elsewhere...), 'ticket' puts it on its own ticket in
-- category_key / subcategory_key (e.g. an MK8 "setup" add-on -> a bench
-- ticket). First matching rule by sort_order wins. Tags compare
-- case-insensitively, same as Shopify's own tag search.
CREATE TABLE shopify_tag_rules (
    id               SERIAL PRIMARY KEY,
    tag              TEXT NOT NULL,
    action           TEXT NOT NULL CHECK (action IN ('no_ticket', 'ticket')),
    category_key     TEXT,
    subcategory_key  TEXT,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT shopify_tag_rules_ticket_needs_category
      CHECK (action <> 'ticket' OR category_key IS NOT NULL)
);
CREATE UNIQUE INDEX shopify_tag_rules_tag_idx ON shopify_tag_rules (lower(tag));

-- One order can now produce more than one ticket (the default shipping
-- ticket plus a ticket per 'ticket' rule that matched), so "one ticket per
-- shopify_order_id" (migration 006) becomes "one ticket per order per
-- group". The group key is stored rather than derived from category_key so
-- a ticket someone re-categorises by hand doesn't get re-created by a
-- re-run. Every existing order-ticket was the only one for its order, i.e.
-- the default group.
ALTER TABLE tickets ADD COLUMN shopify_group_key TEXT;
UPDATE tickets SET shopify_group_key = 'default' WHERE shopify_order_id IS NOT NULL;
DROP INDEX IF EXISTS tickets_shopify_order_id_idx;
CREATE UNIQUE INDEX tickets_shopify_order_group_idx
  ON tickets (shopify_order_id, shopify_group_key) WHERE shopify_order_id IS NOT NULL;
CREATE INDEX tickets_shopify_order_id_lookup_idx
  ON tickets (shopify_order_id) WHERE shopify_order_id IS NOT NULL;

-- Shopify's own customer id: a steadier match key than email for a repeat
-- buyer (they can change their email in their Shopify account). Guest
-- checkouts have none, so email stays the fallback.
ALTER TABLE customers ADD COLUMN shopify_customer_id TEXT;
CREATE UNIQUE INDEX customers_shopify_customer_id_idx
  ON customers (shopify_customer_id) WHERE shopify_customer_id IS NOT NULL;

-- On/off switches for each step, edited from Settings -> Shopify orders.
-- Which category the default ticket lands in stays where it was
-- (shop_config.shopify_default_category).
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('shop_config', 'shopify_orders', 'Shopify order intake', 90,
        '{"create_customers": true, "sync_xero_contacts": true, "xero_note": true,
          "create_tickets": true, "skip_pos": true, "wait_for_payment": true}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
