-- ===========================================================================
-- Shopify order webhook intake.
--
-- Shopify redelivers webhooks (retries, and sometimes duplicate deliveries
-- for the same event) — the receiver checks for an existing ticket by
-- shopify_order_id before inserting, but that check-then-insert has a race
-- if two deliveries for the same order land concurrently. This unique index
-- is the actual guarantee: a second insert for the same order fails with a
-- unique-violation that the receiver treats as "already handled," not an
-- error. Partial (WHERE shopify_order_id IS NOT NULL) because most tickets
-- have no Shopify order at all.
-- ===========================================================================

CREATE UNIQUE INDEX tickets_shopify_order_id_idx
  ON tickets (shopify_order_id) WHERE shopify_order_id IS NOT NULL;
