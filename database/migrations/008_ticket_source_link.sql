-- Generic "created from another ticket" provenance link, alongside the
-- existing shopify_order_id / legacy_ref provenance columns. First use:
-- "Create shipping ticket" (routes/tickets.js) spins up a new Shipping-
-- category ticket from an existing one and needs to record where it came
-- from, both so the original ticket can link forward to it and so the new
-- ticket can link back. ON DELETE SET NULL rather than CASCADE: deleting
-- the original ticket shouldn't take the shipping ticket down with it.
ALTER TABLE tickets
  ADD COLUMN source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

CREATE INDEX tickets_source_ticket_idx ON tickets (source_ticket_id) WHERE source_ticket_id IS NOT NULL;
