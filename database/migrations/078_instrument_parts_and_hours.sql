-- Parts & labor on an inventory instrument (NOTES.md §2.105).
--
-- An itemized list of what went into a piece: each line is either typed in
-- or picked from Parts & Accessories stock (inventory_parts). "Reserved" =
-- set aside for this instrument but not installed yet; unticking it means
-- it's in. The Inventory page's Reserved parts tab lists every reserved
-- line across all instruments. This is separate from Parts / Supplies
-- (parts_orders), which is about what to *buy*.

-- Rough labor on the piece, entered by hand. Hours logged on the piece's
-- tickets (hours_log) are shown next to it for reference, not summed into it.
ALTER TABLE instruments
  ADD COLUMN est_hours NUMERIC(6,2) CHECK (est_hours IS NULL OR est_hours >= 0);

CREATE TABLE instrument_parts (
    id                SERIAL PRIMARY KEY,
    instrument_id     INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    -- Where it came from on the shelf, if anywhere. SET NULL so deleting a
    -- stock row never erases what was used; `description` keeps the name.
    inventory_part_id INTEGER REFERENCES inventory_parts(id) ON DELETE SET NULL,
    description       TEXT NOT NULL,
    quantity          NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cost         NUMERIC(10,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
    -- How many were actually taken off inventory_parts.quantity for this
    -- line. Not always = quantity: a stock row with no count ("tons",
    -- "5-10 Available") is never decremented, so there's nothing to give
    -- back. Returning stock uses this, never `quantity`.
    stock_taken       INTEGER NOT NULL DEFAULT 0 CHECK (stock_taken >= 0),
    reserved          BOOLEAN NOT NULL DEFAULT FALSE,
    reserved_at       TIMESTAMPTZ,
    notes             TEXT,
    created_by        INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instrument_parts_instrument_idx ON instrument_parts (instrument_id, id);
CREATE INDEX instrument_parts_reserved_idx ON instrument_parts (reserved_at) WHERE reserved;

CREATE TRIGGER instrument_parts_touch BEFORE UPDATE ON instrument_parts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Removing a line puts what it took back on the shelf. A trigger rather
-- than route code so it also happens when the whole instrument is deleted
-- (ON DELETE CASCADE above) — no code path can drop stock on the floor.
-- Taking stock is done in routes/inventory.js, which needs to refuse with
-- a readable message when there isn't enough.
CREATE FUNCTION instrument_parts_return_stock() RETURNS trigger AS $$
BEGIN
  IF OLD.inventory_part_id IS NOT NULL AND OLD.stock_taken > 0 THEN
    UPDATE inventory_parts SET quantity = quantity + OLD.stock_taken
     WHERE id = OLD.inventory_part_id AND quantity IS NOT NULL;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER instrument_parts_return_stock BEFORE DELETE ON instrument_parts
  FOR EACH ROW EXECUTE FUNCTION instrument_parts_return_stock();
