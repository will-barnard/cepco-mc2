-- N2b (boss-list scope) side effect: the doc's category reshuffle says
-- "retire Shipping" as if it's a plain settings-screen cleanup, but the
-- 'shipping' ticket_category key isn't a duplicate of "Orders & Shipping"
-- (orders_shipping, which stays) — it's the specific category the "Ship
-- this instrument" button (TicketSubTickets.vue) auto-assigns to the
-- pack-and-send sub-tickets it spins off, and three places key real
-- behavior directly off category_key = 'shipping':
--   - TicketDetailView.vue hides the Estimate/Hours/QC/Invoicing cards on
--     these tickets (a shipping job isn't billable repair work).
--   - TicketSubTickets.vue's hasShippingChild stops a second "Ship this
--     instrument" sub-ticket being spun up once one already exists.
--   - routes/tickets.js's create-shipping-ticket route defaults new ones
--     onto it, and the 5 status rows below (Reservation/QC/Invoice Sent/
--     Invoice Paid/On Hold) exclude it via meta.excluded_categories so a
--     shipping ticket can't be set to a status that assumes billable work.
-- Retiring the category out from under all of that would silently break
-- it. This column replaces the category as the discriminator, so
-- 'shipping' can actually retire (migration 029) without losing any of
-- the above.
ALTER TABLE tickets ADD COLUMN is_shipping BOOLEAN NOT NULL DEFAULT FALSE;

-- Every ticket already sitting on the old 'shipping' category is, by
-- definition, one of these pack-and-send jobs — flip the flag for them
-- now so the behavior above doesn't change for a single existing ticket
-- once migration 029 retires the category itself. Their category_key
-- stays exactly as it is (still 'shipping', now retired but not deleted,
-- still resolvable and still displaying its historical label) — nothing
-- asked for these to be re-pointed, unlike the Servicing/Inventory
-- Restorations merge, which the boss explicitly asked for (029).
UPDATE tickets SET is_shipping = TRUE WHERE category_key = 'shipping';
