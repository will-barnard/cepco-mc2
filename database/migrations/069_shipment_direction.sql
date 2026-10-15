-- A shipping ticket is either sending something out of the shop (the
-- original, only case: "Ship this instrument" after a repair) or bringing
-- something in (a customer or seller shipping an instrument to the shop —
-- an inbound shipment has no existing ticket to launch "Ship this
-- instrument" from, so it's opened directly under Orders & Shipping).
-- The shipment record is where a shipping ticket's logistics live (method,
-- contact info, tracking, checklist), so the direction lives there too
-- rather than as a second flag on tickets.
--
-- Every shipment that exists today was an outbound one — inbound tickets
-- had nowhere to record that they were inbound — so the default backfills
-- them all correctly.
ALTER TABLE shipments
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'
  CHECK (direction IN ('inbound', 'outbound'));
