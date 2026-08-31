-- N2b / N4b / N3 (boss-list scope): the category reshuffle, the priority
-- tier replacement, and SideQuests' four children — bundled into one
-- migration since they're entangled (Custom Shop moves from being a
-- priority tier to being a category sub-category; the merge target for
-- Servicing has to exist before tickets can be re-pointed onto it).
--
-- The boss's answers to the three explicit "ask the boss" flags on this
-- packet:
--   1. Custom Shop (currently priority_tier 'custom_shop') is retired as a
--      priority and re-created purely as a ticket sub-category of the new
--      Repairs & Restoration — see the priority-tier block at the bottom.
--   2. The tickets on 'servicing' get re-pointed onto the new merged
--      'repairs_restoration' key, so one queue filter shows old and new
--      work together. 'inventory_restoration' tickets do NOT get
--      re-pointed — see the note on that row below, this was a separate
--      finding put back to the boss rather than assumed.
--   3. The three new priority tiers drop the old sheet-inherited
--      min_hours/max_hours bands entirely (urgency, not job size).
--
-- 'shipping' retiring safely (rather than breaking the three code paths
-- that keyed off it) depends on migration 028's is_shipping column having
-- already run.

-- Every INSERT below is ON CONFLICT (category, key) DO NOTHING (matching
-- 002_labor_rate_setting.sql's precedent): settings rows are admin-editable
-- at any time (README "Configurable by admin, not by deploy"), so by the
-- time this deploys, staff may already have hand-created a category/tier
-- with the exact slug this packet formalizes (create() derives the key by
-- slugifying the label the same way this file spells it out, e.g. "Custom
-- Shop" -> 'custom_shop', "Repairs & Restoration" -> 'repairs_restoration').
-- A plain INSERT then hits settings_category_key_key and crash-loops the
-- backend on every boot. DO NOTHING means an admin-created row wins as-is
-- (label/sort_order/meta untouched) instead of the migration erroring out
-- or silently overwriting whatever they set up; if that leaves a row
-- missing the parent_key/allow_free_text meta this packet intends (e.g.
-- Custom Shop not actually nested under Repairs & Restoration), fix that
-- one row by hand in /settings after this deploy.

-- ---------------------------------------------------------------------
-- Ticket categories
-- ---------------------------------------------------------------------

-- New top-level "Repairs & Restoration" — the merge target for Servicing.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('ticket_category', 'repairs_restoration', 'Repairs & Restoration', 30, '{}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;

-- Servicing retires into it; every ticket sitting on the old key moves
-- onto the new one (the boss's call — see header).
UPDATE settings SET retired = TRUE WHERE category = 'ticket_category' AND key = 'servicing';
UPDATE tickets
   SET category_key = 'repairs_restoration',
       category_label_snapshot = 'Repairs & Restoration'
 WHERE category_key = 'servicing';

-- Inventory Restorations is a different case, put back to the boss
-- separately when it turned up mid-implementation: frontend/src/views/
-- InventoryRestorationsView.vue depends on this exact key to keep its own
-- dedicated "instruments we bought to flip" queue working, so instead of
-- retiring it into the flat merge like Servicing, it becomes a *child* of
-- the new parent — same N2a parent/key mechanism Custom Shop uses just
-- below. Its own key and every ticket already on it are untouched, so
-- there is nothing to re-point here; they're already correctly
-- categorized and simply gain a parent for grouping purposes.
UPDATE settings
   SET meta = meta || jsonb_build_object('parent_key', 'repairs_restoration'),
       sort_order = 10
 WHERE category = 'ticket_category' AND key = 'inventory_restoration';

-- Custom Shop existed only as a priority tier before this packet (a job's
-- type and its urgency are different axes — conflating them is exactly
-- what N4b's priority-tier cleanup below is undoing). It becomes a ticket
-- sub-category instead, child of the new parent; the old priority-tier
-- row of the same name retires in the priority-tier block below.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('ticket_category', 'custom_shop', 'Custom Shop', 20,
        jsonb_build_object('parent_key', 'repairs_restoration'))
ON CONFLICT (category, key) DO NOTHING;

-- The legacy standalone "Shipping" category (distinct from "Orders &
-- Shipping", which stays) is safe to retire now that migration 028 gave
-- every ticket that depended on this exact key its own is_shipping flag
-- instead. Not part of the boss's re-point decision (that was specifically
-- about Servicing/Inventory Restorations) — any historical ticket here is
-- left exactly where it is, per the "retire, don't delete" rule; it still
-- displays its "Shipping" label via the snapshot column regardless.
UPDATE settings SET retired = TRUE WHERE category = 'ticket_category' AND key = 'shipping';

-- New top-level categories.
INSERT INTO settings (category, key, label, sort_order, meta) VALUES
  ('ticket_category', 'housekeeping', 'Housekeeping', 40, '{}'::jsonb),
  ('ticket_category', 'sidequests', 'SideQuests', 50, '{}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;

-- N3: SideQuests' four children. "Other" takes a typed name instead of a
-- fixed label (meta.allow_free_text — see resolveSubcategory() in
-- routes/tickets.js, and the parallel parts_orders.vendor_other / P3).
INSERT INTO settings (category, key, label, sort_order, meta) VALUES
  ('ticket_category', 'sidequest_hunt', 'Hunt', 10,
     jsonb_build_object('parent_key', 'sidequests')),
  ('ticket_category', 'sidequest_rnd', 'R&D', 20,
     jsonb_build_object('parent_key', 'sidequests')),
  ('ticket_category', 'sidequest_outreach', 'Outreach', 30,
     jsonb_build_object('parent_key', 'sidequests')),
  ('ticket_category', 'sidequest_other', 'Other', 40,
     jsonb_build_object('parent_key', 'sidequests', 'allow_free_text', true))
ON CONFLICT (category, key) DO NOTHING;

-- A ticket_status row's meta.excluded_categories had exactly one member,
-- ever: 'shipping'. Now that shipping sub-tickets are identified by
-- is_shipping rather than by category (028), the category-keyed exclusion
-- is replaced by a flag-keyed one (excluded_for_shipping) that
-- statusAppliesToCategory() now checks alongside it — see
-- backend/src/services/settings.js. Data-driven off whatever currently
-- excludes 'shipping' rather than hardcoding the 5 status keys, so this
-- does the right thing even if an admin already touched these rows.
UPDATE settings
   SET meta = (meta - 'excluded_categories') || jsonb_build_object('excluded_for_shipping', true)
 WHERE category = 'ticket_status'
   AND meta->'excluded_categories' ? 'shipping';

-- ---------------------------------------------------------------------
-- Priority tiers (N4b)
-- ---------------------------------------------------------------------

-- All five old tiers retire. custom_shop moved to categories above; the
-- other four are replaced outright by three urgency-based tiers rather
-- than kept alongside them. Existing tickets keep their original
-- priority_key and label snapshot (already captured at write time) and
-- keep displaying correctly — nothing here re-points them, since unlike
-- the category merge above there's no single obvious tier each old one
-- maps onto.
UPDATE settings SET retired = TRUE
 WHERE category = 'priority_tier'
   AND key IN ('daily_todo', 'expedited', 'standard_setup', 'deep_dive', 'custom_shop');

-- Expedited first — sort_order here drives the dashboard's task ranking
-- (routes/tickets.js's default ORDER BY on pr.sort_order). No min_hours/
-- max_hours meta (the boss's call — see header): these are about urgency,
-- not the job-size bands the old sheet-inherited tiers carried.
INSERT INTO settings (category, key, label, sort_order, meta) VALUES
  ('priority_tier', 'expedited_sos', 'Expedited / SOS', 10, '{}'::jsonb),
  ('priority_tier', 'standard_priority', 'Standard Priority', 20, '{}'::jsonb),
  ('priority_tier', 'low_priority', 'Low Priority', 30, '{}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
