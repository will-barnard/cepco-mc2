-- Re-pin ticket_status.sort_order to the intended workflow order. Settings
-- -> Ticket statuses renders rows lowest-sort_order-first (see
-- services/settings.js's listCategory/listAll — `ORDER BY sort_order,
-- id`), and defaultStatusForCategory uses that exact same ordering to
-- pick a new ticket's starting status: "the first non-retired status
-- usable by this category, in sort order." Those aren't two things to
-- keep in sync — they're the same lookup — so somewhere along the way
-- 'done' ended up with a lower sort_order than the in-progress statuses
-- that should come before it, and every new ticket has been defaulting
-- to Done as a result.
--
-- Rather than a relative nudge (which would depend on guessing today's
-- actual values), this pins all 8 seeded ticket_status keys back to
-- seed.js's own canonical order — safe to run regardless of whatever
-- they currently are, and a no-op if they already happen to be right.
-- Any additional ticket_status key an admin has added beyond these 8 is
-- untouched.
UPDATE settings SET sort_order = 10 WHERE category = 'ticket_status' AND key = 'reservation';
UPDATE settings SET sort_order = 20 WHERE category = 'ticket_status' AND key = 'not_started';
UPDATE settings SET sort_order = 30 WHERE category = 'ticket_status' AND key = 'in_progress';
UPDATE settings SET sort_order = 40 WHERE category = 'ticket_status' AND key = 'qc';
UPDATE settings SET sort_order = 50 WHERE category = 'ticket_status' AND key = 'invoice_sent';
UPDATE settings SET sort_order = 60 WHERE category = 'ticket_status' AND key = 'invoice_paid';
UPDATE settings SET sort_order = 70 WHERE category = 'ticket_status' AND key = 'done';
UPDATE settings SET sort_order = 80 WHERE category = 'ticket_status' AND key = 'on_hold';
