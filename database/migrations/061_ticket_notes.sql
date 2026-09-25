-- Published ticket notes (shop feedback, Sep 2026). Replaces the single
-- live-edited "Notes & parts" textarea on a ticket with a log of notes
-- that are each posted once, stamped with who and when -- the same model
-- as Xero's own History & Notes -- and, for a customer linked to Xero,
-- also posted to that contact's history there (services/ticketNotes.js).
--
-- Every ticket-creation path's `notes` (the New Ticket form's intake
-- notes, "Ship this instrument", an accepted estimate's procedure list,
-- recurring chores, Shopify orders) now becomes that ticket's first note
-- instead of being written to tickets.notes -- see insertTicketRow in
-- routes/tickets.js.
--
-- tickets.notes itself is left in place, unwritten from here on: it's
-- copied into this table below (so nothing disappears from any ticket)
-- and kept as-is as a backstop until you're happy to drop it.

CREATE TABLE ticket_notes (
    id              SERIAL PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    body            TEXT NOT NULL CHECK (length(btrim(body)) > 0),
    created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- TRUE only for the rows copied from tickets.notes below: their
    -- created_at is the ticket's, not when the text was actually written
    -- (the old textarea kept no history), so the UI labels them.
    legacy          BOOLEAN NOT NULL DEFAULT FALSE,
    -- Xero History push state:
    --   pending -- to be posted once the ticket's customer is linked to a
    --              Xero contact (retried by every Xero sync run)
    --   pushed  -- posted; xero_pushed_at says when
    --   failed  -- last attempt errored (xero_error says why); retried
    --              like pending
    --   skipped -- never going to Xero: an automated note (no author), a
    --              ticket with no customer, or a note migrated from the
    --              old textarea below (pushing years of old notes into
    --              Xero in one go would bury the real history there)
    xero_status     TEXT NOT NULL DEFAULT 'pending'
                    CHECK (xero_status IN ('pending', 'pushed', 'failed', 'skipped')),
    xero_pushed_at  TIMESTAMPTZ,
    xero_error      TEXT
);
CREATE INDEX ticket_notes_ticket_idx ON ticket_notes (ticket_id, created_at);
CREATE INDEX ticket_notes_xero_todo_idx ON ticket_notes (xero_status)
    WHERE xero_status IN ('pending', 'failed');

INSERT INTO ticket_notes (ticket_id, body, created_by, created_at, legacy, xero_status)
SELECT id, notes, created_by, created_at, TRUE, 'skipped'
  FROM tickets
 WHERE notes IS NOT NULL AND btrim(notes) <> '';
