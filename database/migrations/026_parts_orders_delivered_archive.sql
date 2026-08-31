-- P2 (boss-list scope): rename the terminal "received" status to
-- "delivered" (matches the ask's own wording) and add an archive step so
-- delivered orders stop accumulating in the default list.
--
-- Existing 'received' rows become 'delivered' — same status, new name —
-- and are archived immediately, since by definition they were already
-- collected before this migration ran. received_at is kept as the column
-- (the boss-list packet explicitly allows either keeping received_at or
-- adding delivered_at, "don't do both") rather than renaming it, so
-- historical rows and any reporting built on it don't need touching.
UPDATE parts_orders SET status = 'delivered' WHERE status = 'received';

ALTER TABLE parts_orders DROP CONSTRAINT parts_orders_status_check;
ALTER TABLE parts_orders ADD CONSTRAINT parts_orders_status_check
  CHECK (status IN ('needed', 'ordered', 'delivered', 'cancelled'));

ALTER TABLE parts_orders ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE parts_orders SET archived = TRUE WHERE status = 'delivered';

CREATE INDEX parts_orders_archived_idx ON parts_orders (archived);
