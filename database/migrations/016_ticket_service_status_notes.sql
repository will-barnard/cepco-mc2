-- "Status notes" (Settings -> Ticket categories -> "Status notes" toggle):
-- two free-text fields, "Service done" and "Service needed", rendered on
-- the ticket detail page right below the existing Notes & parts field.
-- Distinct columns rather than folding into `notes` because they're a
-- structured pair with their own meaning (what was actually done vs. what
-- still needs doing) that a shop lead skimming a ticket wants to read
-- separately, not hunt for inside a free-form notes blob.
--
-- Nullable and off by default everywhere: like every other per-category
-- toggle in this app (see meta.hide_ship_button on the ticket_category
-- settings rows), whether these fields even show up in the UI is admin-
-- configured per category, so most tickets will simply never have them
-- set. A ticket whose category later has the toggle turned off keeps
-- whatever it already had here — the column doesn't get cleared, the UI
-- just stops showing it, same as any other settings-driven visibility
-- toggle in this app.
ALTER TABLE tickets
  ADD COLUMN service_done_notes    TEXT,
  ADD COLUMN service_needed_notes  TEXT;
