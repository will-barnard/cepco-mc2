-- ===========================================================================
-- One restoration queue (Nov 2026).
--
-- Inventory Restorations was a category of its own: its own queue, its
-- own tab on the Inventory page, and a second way to file the same thing
-- (the New Ticket form saved it as Repairs & Restoration + an Inventory
-- Restorations sub-category, which the tab never showed). The shop's call:
-- one queue. A stock piece's restoration is a Repairs & Restoration ticket
-- like any other, and what marks it as stock is the instrument itself --
-- shop-owned or on consignment -- shown as an "Inventory" tag in the
-- queue, and an "Inventory — ..." title while no customer is on it
-- (routes/tickets.js composeTicketTitle). When the piece sells, the buyer
-- goes on the ticket and both follow on their own.
--
-- 1. Every Inventory Restorations ticket (open or archived) becomes
--    Repairs & Restoration with no sub-category; so do form-made ones that
--    carry it as their sub-category.
-- 2. The open ones are slotted into the Repairs & Restoration queue by
--    date: each goes just ahead of the first ticket in the current queue
--    order whose date is later (Date of Order/Queue, else when it was
--    entered). The existing queue's hand-made order is kept as is; only
--    the newcomers are placed. Then the whole queue is renumbered 10, 20...
--    (Family and technician queues already mixed both categories, so they
--    don't change.)
-- 3. Recurring templates, pending estimates and Shopify tag rules pointing
--    at it are re-pointed, and the category is retired (kept for history,
--    never offered again).
-- ===========================================================================

-- --- 2 (before 1, while the two groups can still be told apart) ----------
CREATE TEMP TABLE _queue ON COMMIT DROP AS
WITH rr AS (
  SELECT id, COALESCE(category_queue_position, 2147483647)::numeric AS pos,
         COALESCE(drop_off_date, created_at::date) AS d, created_at
    FROM tickets
   WHERE category_key = 'repairs_restoration' AND archived = FALSE
), inv AS (
  SELECT id, COALESCE(drop_off_date, created_at::date) AS d, created_at,
         COALESCE(category_queue_position, 2147483647) AS old_pos
    FROM tickets
   WHERE category_key = 'inventory_restoration' AND archived = FALSE
), placed AS (
  SELECT inv.id,
         -- just ahead of the first later-dated ticket in queue order, or
         -- after everything when nothing is later
         COALESCE((SELECT min(rr.pos) FROM rr
                    WHERE rr.d > inv.d OR (rr.d = inv.d AND rr.created_at > inv.created_at)),
                  (SELECT COALESCE(max(pos), 0) FROM rr) + 1) - 0.5 AS pos,
         inv.d, inv.created_at, inv.old_pos
    FROM inv
)
SELECT id, row_number() OVER (ORDER BY pos, grp, d, created_at, old_pos, id) * 10 AS new_pos
  FROM (
    SELECT id, pos, 0 AS grp, d, created_at, 0 AS old_pos FROM rr
    UNION ALL
    SELECT id, pos, 1 AS grp, d, created_at, old_pos FROM placed
  ) merged;

-- --- 1 ---------------------------------------------------------------------
UPDATE tickets
   SET category_key = 'repairs_restoration',
       category_label_snapshot = COALESCE(
         (SELECT label FROM settings WHERE category = 'ticket_category' AND key = 'repairs_restoration'),
         'Repairs & Restoration'),
       subcategory_key = NULL, subcategory_label_snapshot = NULL, subcategory_other_text = NULL
 WHERE category_key = 'inventory_restoration';

UPDATE tickets
   SET subcategory_key = NULL, subcategory_label_snapshot = NULL, subcategory_other_text = NULL
 WHERE subcategory_key = 'inventory_restoration';

UPDATE tickets t SET category_queue_position = q.new_pos FROM _queue q WHERE q.id = t.id;

-- --- 3 ---------------------------------------------------------------------
UPDATE recurring_ticket_templates SET category_key = 'repairs_restoration'
 WHERE category_key = 'inventory_restoration';

UPDATE estimates SET category_key = 'repairs_restoration'
 WHERE category_key = 'inventory_restoration';

UPDATE shopify_tag_rules SET category_key = 'repairs_restoration', subcategory_key = NULL
 WHERE category_key = 'inventory_restoration';
UPDATE shopify_tag_rules SET subcategory_key = NULL
 WHERE subcategory_key = 'inventory_restoration';

UPDATE settings SET meta = jsonb_set(meta, '{value}', '"repairs_restoration"')
 WHERE category = 'shop_config' AND key = 'shopify_default_category'
   AND meta->>'value' = 'inventory_restoration';

UPDATE settings SET retired = TRUE
 WHERE category = 'ticket_category' AND key = 'inventory_restoration';

-- A status a shop admin restricted away from Repairs & Restoration would
-- now be on tickets that can't show it. None ship that way; say so if one
-- was set up by hand, so it can be fixed from the ticket.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n
    FROM tickets t JOIN settings s ON s.category = 'ticket_status' AND s.key = t.status_key
   WHERE t.category_key = 'repairs_restoration' AND t.archived = FALSE
     AND COALESCE(s.meta->'excluded_categories', '[]'::jsonb) ? 'repairs_restoration';
  IF n > 0 THEN
    RAISE NOTICE 'migration 101: % open Repairs & Restoration ticket(s) are on a status excluded from that category', n;
  END IF;
END $$;
