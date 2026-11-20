-- ===========================================================================
-- Friday Lunch orders (Nov 2026). On a finished result an admin can choose
-- to collect orders: everyone types what they want, and the list is shown
-- on the page to everyone. Off unless an admin turns it on for that round.
--
-- Unlike suggestions and ballots, orders are NOT anonymous -- they show the
-- person's name, because whoever places the order needs to know whose is
-- whose.
--
-- orders_status: NULL = not collecting; 'open' = people can add/edit;
-- 'closed' = locked while someone places the order (an admin can reopen).
-- ===========================================================================

ALTER TABLE lunch_rounds
  ADD COLUMN orders_status TEXT CHECK (orders_status IN ('open', 'closed')),
  ADD COLUMN orders_opened_at TIMESTAMPTZ;

-- One order per person per round, edited in place.
CREATE TABLE lunch_orders (
    id           SERIAL PRIMARY KEY,
    round_id     INTEGER NOT NULL REFERENCES lunch_rounds(id) ON DELETE CASCADE,
    employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    order_text   TEXT NOT NULL CHECK (btrim(order_text) <> ''),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (round_id, employee_id)
);
