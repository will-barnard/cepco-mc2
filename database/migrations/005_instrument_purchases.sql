-- ===========================================================================
-- Instrument purchase intake — "Add instrument purchase" on the new
-- Inventory Restorations tab.
--
-- One row per acquisition, separate from `instruments` and `customers`:
--   - The person the shop bought FROM isn't a `customers` row. That table
--     means "someone we service", and an instrument bought for inventory
--     deliberately has customer_id NULL (see 001_init.sql — NULL = fleet).
--     Reusing customers for sellers would either violate that convention or
--     require bolting a second meaning onto one table.
--   - It's not columns on `instruments` for the same reason rentals aren't
--     (see 004_instrument_rentals.sql): keep the acquisition event as its
--     own record, and instruments/tickets stay exactly as general-purpose
--     as they already are.
--
-- ticket_id links to the inventory_restoration ticket created in the same
-- transaction — that's what "click the instrument, send the receipt" hangs
-- off of. ON DELETE SET NULL rather than CASCADE: deleting the ticket
-- shouldn't erase the record that money changed hands.
-- ===========================================================================

CREATE TABLE instrument_purchases (
    id              SERIAL PRIMARY KEY,
    instrument_id   INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    ticket_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    seller_name     TEXT NOT NULL,
    seller_email    TEXT,
    seller_phone    TEXT,
    seller_address  TEXT,
    price           NUMERIC(10,2) NOT NULL,
    purchase_date   DATE NOT NULL,
    notes           TEXT,
    receipt_sent_at TIMESTAMPTZ,
    created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instrument_purchases_instrument_idx ON instrument_purchases (instrument_id);
CREATE INDEX instrument_purchases_ticket_idx ON instrument_purchases (ticket_id);

CREATE TRIGGER instrument_purchases_touch BEFORE UPDATE ON instrument_purchases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
