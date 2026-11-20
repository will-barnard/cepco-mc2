-- ===========================================================================
-- Customer notes -> Xero (shop feedback, Nov 2026: notes typed on a customer
-- in MC2 never showed up in Xero).
--
-- Xero's API has no notes field on a contact. What Xero's contact screen
-- calls notes is its "History & Notes" log -- append-only, the same place
-- ticket notes already go (services/ticketNotes.js). So customer notes are
-- posted there as "[MC2 Customer notes] ..." whenever they change.
--
-- xero_notes_pushed is the text MC2 last posted for this customer, so a
-- note goes up once per change rather than on every sync or edit. NULL =
-- nothing posted yet, which is why every linked customer who already has
-- notes gets them posted on the first sync after this deploys -- the
-- catch-up for exactly the notes that were reported missing.
--
-- Clearing notes in MC2 doesn't post anything (Xero entries can't be
-- deleted); it only updates this column.
-- ===========================================================================

ALTER TABLE customers ADD COLUMN xero_notes_pushed TEXT;
