-- ===========================================================================
-- Consignment payout tickets (NOTES.md §2.109).
--
-- Selling a consignment used to just flip its sale period to "Payout due"
-- and leave it on the Consignments tab for someone to notice. Now the sale
-- also opens a ticket to pay the consignor, in its own category, so it lands
-- on someone's queue and dashboard like any other job:
--
--   * Who gets it is the category's existing "Default assignee"
--     (Settings -> Ticket categories) -- the same per-category auto-assign
--     every other ticket type already uses, so there's no second setting.
--   * Retiring the category turns the feature off: a sale still goes
--     through, it just doesn't open a ticket (services/consignmentPayouts.js).
--
-- payout_ticket_id ties the ticket to the sale period it's paying out, and
-- keeps the two in step both ways: finishing the ticket (a terminal status
-- like Done, or archiving it) marks the payout Paid out; marking the payout
-- Paid out from the ownership history finishes the ticket. One ticket per
-- sale (unique), so a re-sell after "Undo sale" -- which reopens this same
-- period -- can't stack a second ticket on it; undo unlinks and archives
-- the old one instead.
-- ===========================================================================

ALTER TABLE instrument_ownership
  ADD COLUMN payout_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX instrument_ownership_payout_ticket_idx
  ON instrument_ownership (payout_ticket_id) WHERE payout_ticket_id IS NOT NULL;

-- The category. Starts In Progress with a task made from its title (the
-- Daily To-Do's pattern, migration 051) so the assignee sees it on their
-- dashboard straight away rather than once someone flips the status.
-- Named "Consignment payout: <consignor> - <instrument>"; {ticket_name} is
-- the consignor, filled in by the sale (and typed, for one made by hand).
-- No QC, ship button or customer progress update -- nothing to inspect,
-- ship or report on. ON CONFLICT DO NOTHING per migration 029's rule: an
-- admin-made row with this key wins as-is.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('ticket_category', 'consignment_payout', 'Consignment Payouts', 60, jsonb_build_object(
  'naming_template', 'Consignment payout: {ticket_name} - ["{nickname}" ][{year} ][{family} ][{model}]',
  'naming_mode', 'standardize',
  'naming_enforced', true,
  'naming_name_label', 'Consignor',
  'default_status_key', 'in_progress',
  'auto_task_from_title', true,
  'hide_qc', true,
  'hide_ship_button', true,
  'hide_progress_update', true))
ON CONFLICT (category, key) DO NOTHING;

-- Statuses that mean nothing for a payout (it's money going out, not a
-- repair coming in). Settings -> Ticket statuses "Applies to" can put any of
-- them back. On a brand-new database these rows don't exist yet when this
-- runs -- scripts/seed.js carries the same exclusion for that case.
UPDATE settings
   SET meta = jsonb_set(
         meta, '{excluded_categories}',
         COALESCE(meta->'excluded_categories', '[]'::jsonb) || '["consignment_payout"]'::jsonb)
 WHERE category = 'ticket_status'
   AND key IN ('reservation', 'qc', 'invoice_sent', 'invoice_paid')
   AND NOT COALESCE(meta->'excluded_categories', '[]'::jsonb) ? 'consignment_payout';
