-- ===========================================================================
-- Restoration sales from Shopify (Nov 2026).
--
-- The shop sells restoration pre-orders on Shopify: one listing per
-- instrument, priced at the 50% deposit, tagged "restoration". Until now
-- an order for one either made a shipping ticket (wrong -- nothing ships
-- for months) or nothing at all (a "no ticket" rule), and someone had to
-- find the instrument, mark it sold and open the restoration ticket by
-- hand, retyping the buyer's details.
--
-- Now a tag rule can say "restoration": a matching item gets no ticket at
-- order time. It becomes a row here instead, and shows on the homepage of
-- the reviewers picked in Settings -> Shopify orders. The reviewer
-- confirms which inventory instrument was sold (mc2 suggests one), picks
-- the ticket's category, and one click records the sale to the buyer and
-- opens the ticket at the back of that queue (services/restorationIntake.js).
--
-- Statuses:
--   pending    waiting for a reviewer
--   done       sale recorded and ticket opened (ticket_id)
--   dismissed  a reviewer said there's nothing to set up (test order,
--              already handled by hand...)
--   cancelled  the order was cancelled before anyone set it up
-- A *done* row whose order is cancelled afterwards keeps its status and
-- gets order_cancelled_at: the sale stays recorded until a reviewer
-- decides (undo the sale, or keep it) -- cancel_reviewed_at.
-- ===========================================================================

ALTER TABLE shopify_tag_rules DROP CONSTRAINT IF EXISTS shopify_tag_rules_action_check;
ALTER TABLE shopify_tag_rules ADD CONSTRAINT shopify_tag_rules_action_check
  CHECK (action IN ('no_ticket', 'ticket', 'restoration'));

-- The Shopify listing for an inventory piece, by numeric product id. Set
-- when a reviewer confirms a match (so the next sale of that listing is an
-- exact match), or by hand on the instrument page. One listing, one piece.
ALTER TABLE instruments ADD COLUMN shopify_product_id TEXT;
CREATE UNIQUE INDEX instruments_shopify_product_idx
  ON instruments (shopify_product_id) WHERE shopify_product_id IS NOT NULL;

CREATE TABLE shopify_restoration_intake (
    id                      SERIAL PRIMARY KEY,
    shopify_order_row_id    INTEGER NOT NULL REFERENCES shopify_orders(id) ON DELETE CASCADE,
    shopify_order_id        TEXT NOT NULL,
    line_item_id            TEXT NOT NULL,
    product_id              TEXT,
    variant_id              TEXT,
    sku                     TEXT,
    title                   TEXT NOT NULL,
    quantity                INTEGER NOT NULL DEFAULT 1,
    -- What the buyer paid for this line (the deposit) and the listing's
    -- custom.full_value metafield at order time (the full price), when it
    -- has one. The sale is recorded at the full price.
    deposit_amount          NUMERIC(10,2),
    full_price              NUMERIC(10,2),
    currency                TEXT,
    -- mc2's best guess when the row was made, and why ("linked listing",
    -- "nickname"...). The card re-checks live; this is what the email said.
    suggested_instrument_id INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    match_reason            TEXT,
    status                  TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'done', 'dismissed', 'cancelled')),
    instrument_id           INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    -- which of the Repairs & Restoration family the reviewer picked
    -- (services/restorationIntake.js categoryChoices); the next card
    -- defaults to the last one used
    category_choice         TEXT,
    ticket_id               INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    -- true when the reviewer attached an existing open ticket instead of
    -- opening a new one
    reused_ticket           BOOLEAN NOT NULL DEFAULT FALSE,
    sale_recorded           BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_by             INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    resolved_at             TIMESTAMPTZ,
    dismiss_note            TEXT,
    order_cancelled_at      TIMESTAMPTZ,
    cancel_reviewed_at      TIMESTAMPTZ,
    cancel_reviewed_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    cancel_outcome          TEXT CHECK (cancel_outcome IS NULL OR cancel_outcome IN ('sale_undone', 'kept')),
    notified_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (shopify_order_id, line_item_id)
);
CREATE INDEX shopify_restoration_intake_open_idx
  ON shopify_restoration_intake (created_at)
  WHERE status = 'pending' OR (status = 'done' AND order_cancelled_at IS NOT NULL AND cancel_reviewed_at IS NULL);

-- Reviewers (employee ids) live with the other intake settings. Empty =
-- every admin sees the card.
UPDATE settings
   SET meta = meta || '{"restoration_reviewer_ids": []}'::jsonb
 WHERE category = 'shop_config' AND key = 'shopify_orders'
   AND NOT (meta ? 'restoration_reviewer_ids');
