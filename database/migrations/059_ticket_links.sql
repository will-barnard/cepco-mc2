-- Ticket links: named URLs attached to a ticket (a Dropbox folder of
-- reference photos, a service manual, a forum thread, a customer's
-- YouTube demo...). Shown on the ticket detail page in the Details card,
-- below customer/instrument and above Notes & parts (see
-- frontend/src/components/TicketLinks.vue), editable in place.
--
-- Own table rather than a JSON column on tickets so each link can be added,
-- edited and removed independently (no read-modify-write of a whole list
-- when two people touch the same ticket) and so it cascades away with the
-- ticket like ticket_attachments does. `position` keeps the order they were
-- added in stable.
--
-- The CHECK is the backstop for routes/ticketLinks.js's own normalization:
-- these URLs end up in an <a href>, so only http(s) is ever allowed --
-- a `javascript:` URL saved here would run script when someone clicked it.
CREATE TABLE ticket_links (
    id          SERIAL PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    url         TEXT NOT NULL CHECK (url ~* '^https?://'),
    position    INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ticket_links_ticket_idx ON ticket_links (ticket_id, position, id);
