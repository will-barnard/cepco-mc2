-- Shipping tickets only ever need Not Started / In Progress / Done — the
-- rest of the shared ticket_status enum (Reservation, QC, Invoice Sent,
-- Invoice Paid, On Hold) doesn't apply to a job that's just packing and
-- sending an already-serviced instrument. Rather than forking a second
-- status enum for Shipping, each ticket_status row gets an
-- `applicable_categories` list in its meta:
--   - empty/absent  -> every category (the default; Not Started/In
--     Progress/Done keep this, so they stay available everywhere)
--   - non-empty     -> only the listed ticket_category keys
-- See backend/src/services/settings.js's statusAppliesToCategory /
-- resolveStatusForCategory / defaultStatusForCategory, and NOTES.md.
--
-- This backfills the five statuses that Shipping shouldn't offer with
-- every OTHER current category, which has the same effect as "not
-- shipping" without hardcoding an exclusion list anywhere -- an admin can
-- freely edit this list in Settings later (e.g. if a sixth category is
-- added, or if some of these should apply to Shipping after all).
UPDATE settings
   SET meta = meta || jsonb_build_object(
     'applicable_categories',
     jsonb_build_array('daily_todo', 'orders_shipping', 'servicing', 'inventory_restoration')
   )
 WHERE category = 'ticket_status'
   AND key IN ('reservation', 'qc', 'invoice_sent', 'invoice_paid', 'on_hold');
