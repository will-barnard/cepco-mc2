-- Vendor work folded into Vendor Orders (shop feedback, Nov 2026).
--
-- The ticket page had two boxes that both meant "something an outside
-- vendor is doing for this job": Vendor work (migration 064 -- Painting /
-- Woodshop / Key Tops ... with a six-step status) and Vendor Orders
-- (parts_orders, the same rows the Parts / Supplies tab and dashboard
-- show). Only the second ever reached Parts / Supplies, which is what the
-- shop expected the first to do. So every Vendor work row becomes an
-- ordinary parts_orders row linked to its ticket, and the Vendor work box
-- is gone from the UI.
--
-- 1. Each Vendor work type that has ever been used (or is still active)
--    becomes a real Parts / Supplies vendor, so Painting / Woodshop / ...
--    keep showing up in the vendor picker. Matched case-insensitively
--    against existing vendors; a hidden vendor with the same name is
--    reactivated rather than duplicated. "Other Vendor" isn't made into a
--    vendor -- the picker already has "Other…", so those rows use
--    vendor_other instead.
--
-- 2. Status: Parts / Supplies only has needed -> ordered (migration 074),
--    so the six Vendor work statuses collapse onto it:
--      Not Started, On Hold         -> needed
--      Booked, In Progress, Ready   -> ordered (dated the day it last changed)
--      anything flagged complete    -> delivered + archived, which the
--                                      ticket's own box still lists as history
--    Any other (shop-added) status counts as ordered. Where the collapse
--    loses something (In Progress, Ready for Pickup, On Hold, custom
--    statuses) the original label is added to the end of the notes
--    ("Vendor work: Ready for Pickup"); Not Started / Booked / Completed map
--    exactly and get nothing extra.
--
-- 3. ticket_vendor_work and the vendor_track / vendor_status settings are
--    NOT dropped. Each row is stamped with the order it became
--    (parts_order_id), so the move can be checked or undone by hand. They
--    can be dropped in a later migration once nobody needs them.
--
-- tickets.vendor_tracks (free text from the CSV import that 064 couldn't
-- map, e.g. "Woodshop: TBD") is untouched; the Vendor Orders box shows it
-- read-only under "From the old sheet", same as Vendor work did.

ALTER TABLE ticket_vendor_work
  ADD COLUMN IF NOT EXISTS parts_order_id INTEGER REFERENCES parts_orders(id) ON DELETE SET NULL;

-- 1a. Reactivate hidden vendors that match a type name.
UPDATE vendors v
   SET active = TRUE
  FROM settings tr
 WHERE tr.category = 'vendor_track' AND tr.key <> 'other_vendor'
   AND lower(v.name) = lower(tr.label)
   AND v.active = FALSE
   AND (NOT tr.retired OR EXISTS (SELECT 1 FROM ticket_vendor_work w WHERE w.track_key = tr.key));

-- 1b. Create the rest, after the existing vendors in the picker.
INSERT INTO vendors (name, sort_order, active)
SELECT tr.label,
       (SELECT COALESCE(max(sort_order), 0) FROM vendors) + row_number() OVER (ORDER BY tr.sort_order, tr.id) * 10,
       TRUE
  FROM settings tr
 WHERE tr.category = 'vendor_track' AND tr.key <> 'other_vendor'
   AND (NOT tr.retired OR EXISTS (SELECT 1 FROM ticket_vendor_work w WHERE w.track_key = tr.key))
   AND NOT EXISTS (SELECT 1 FROM vendors v WHERE lower(v.name) = lower(tr.label));

-- 2. One order per Vendor work row. A temp mapping table keeps the
--    order <-> vendor-work pairing without relying on insert order.
CREATE TEMP TABLE vw_move ON COMMIT DROP AS
SELECT w.id                                   AS vw_id,
       nextval(pg_get_serial_sequence('parts_orders', 'id')) AS order_id,
       w.ticket_id,
       t.title                                AS item,
       CASE WHEN w.track_key = 'other_vendor' THEN NULL ELSE v.id END AS vendor_id,
       CASE WHEN w.track_key = 'other_vendor' THEN COALESCE(tr.label, 'Other Vendor') END AS vendor_other,
       CASE
         WHEN COALESCE((st.meta->>'complete')::boolean, FALSE) THEN 'delivered'
         WHEN w.status_key IN ('not_started', 'on_hold') THEN 'needed'
         ELSE 'ordered'
       END                                    AS status,
       NULLIF(concat_ws(E'\n', NULLIF(trim(w.note), ''),
                        CASE WHEN w.status_key NOT IN ('not_started', 'booked', 'complete')
                             THEN 'Vendor work: ' || COALESCE(st.label, w.status_key) END), '') AS notes,
       (w.updated_at AT TIME ZONE 'America/Chicago')::date AS changed_on,
       w.updated_at,
       w.created_at,
       w.updated_by
  FROM ticket_vendor_work w
  JOIN tickets t ON t.id = w.ticket_id
  LEFT JOIN settings tr ON tr.category = 'vendor_track'  AND tr.key = w.track_key
  LEFT JOIN settings st ON st.category = 'vendor_status' AND st.key = w.status_key
  LEFT JOIN vendors  v  ON lower(v.name) = lower(tr.label)
 WHERE w.parts_order_id IS NULL;

INSERT INTO parts_orders
  (id, vendor_id, vendor_other, item, notes, status, ordered_at, received_at, archived,
   created_by, created_at, updated_at)
SELECT order_id, vendor_id, vendor_other, item, notes, status,
       CASE WHEN status IN ('ordered', 'delivered') THEN changed_on END,
       CASE WHEN status = 'delivered' THEN updated_at END,
       status = 'delivered',
       updated_by, created_at, updated_at
  FROM vw_move;

INSERT INTO parts_order_tickets (parts_order_id, ticket_id)
SELECT order_id, ticket_id FROM vw_move
ON CONFLICT DO NOTHING;

UPDATE ticket_vendor_work w
   SET parts_order_id = m.order_id
  FROM vw_move m
 WHERE m.vw_id = w.id;
