-- "Ship this instrument" (routes/tickets.js's create-shipping-ticket) makes
-- one new ticket + one shipment per instrument. Sometimes an instrument on
-- an *already-existing* ticket needs to travel as part of a shipment that
-- already exists on a different ticket instead — e.g. two separate repair
-- jobs going out to the same customer together — rather than getting its
-- own disconnected shipping ticket. shipment_items is how a shipment
-- absorbs those without pretending they were ever created as their own
-- shipping tickets.
--
-- The shipping ticket's own instrument (tickets.instrument_id, via
-- shipments.ticket_id) stays the "primary" one and is never duplicated in
-- here — this table is only the *additional* instruments grouped onto that
-- same shipment.
CREATE TABLE shipment_items (
    id                  SERIAL PRIMARY KEY,
    shipment_id         INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    instrument_id       INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    -- The repair/etc. ticket this instrument came from, so the shipment
    -- can link back to it. Nullable rather than required so a future caller
    -- could add a bare instrument with no ticket behind it; every caller
    -- today always sets it.
    source_ticket_id    INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    -- NULL (the default) = this instrument rides in the shipment's own box,
    -- sharing shipments.tracking_number and shipments.checklist. Set = it's
    -- packed as its own separate box within this same shipping ticket, with
    -- its own tracking number — "one box or separate boxes" is this column,
    -- not a second shipment.
    own_tracking_number TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A ticket can only ever be pulled into one shipment. Postgres allows
    -- multiple NULLs under a plain UNIQUE, so this doesn't block the
    -- no-ticket-behind-it case above — it only stops the same real ticket
    -- being added twice (a backstop; the route checks this too, for a
    -- friendlier error message than a raw constraint violation).
    UNIQUE (source_ticket_id)
);

CREATE INDEX shipment_items_shipment_id_idx ON shipment_items (shipment_id);
