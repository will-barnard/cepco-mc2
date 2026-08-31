-- N1 (boss-list scope): ticket titles auto-generate server-side when none is
-- typed (routes/tickets.js's composeTicketTitle, called from POST /tickets)
-- as "[Client Name] ["Nickname"] [Instrument Model]" — this column is the
-- one new piece that format needs. Most instruments will never get one
-- (it's only set via the "Add a new instrument instead" form on the New
-- Ticket page for now — see NOTES.md), and a title composed without it
-- just falls back to "[Client Name] [Instrument Model]", which is still a
-- perfectly usable title, so this is additive rather than something every
-- existing instrument needs backfilled.
ALTER TABLE instruments ADD COLUMN nickname TEXT;
