-- Ticket-UI cleanup: the "Customer status report" card on a ticket's
-- detail page (TicketDetailView.vue) doesn't make sense for non-repair
-- work — Housekeeping tickets (inbox sweeps, weekly chores) have no
-- customer to send a status update to. Reuses the same meta-on-the-
-- category-row, opt-out mechanism as hide_ship_button/
-- hide_from_category_queue (see stores.js's statusReportAllowed) rather
-- than a new hardcoded category check, so any other non-repair category
-- can be opted out the same way from Settings -> Ticket categories'
-- "Status report" column, no deploy required.
--
-- Shipping tickets are handled separately and don't need a row here —
-- they're identified by tickets.is_shipping (migration 028), not by
-- category, since Orders & Shipping also carries real billable Shopify
-- orders that should keep their status report.
UPDATE settings
   SET meta = meta || '{"hide_status_report": true}'::jsonb
 WHERE category = 'ticket_category' AND key = 'housekeeping';
