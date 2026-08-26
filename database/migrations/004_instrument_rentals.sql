-- ===========================================================================
-- Rental calendar for the showroom/rental fleet (PLAN §4 category 4).
--
-- One row per "instrument is gone" span, not a pair of columns on
-- `instruments` — a given fleet instrument goes out on rental repeatedly
-- over its life, and the fleet page + dashboard both need the history, not
-- just the current trip. `end_date` is nullable: the shop doesn't always
-- know the return date when something goes out the door.
-- ===========================================================================

CREATE TABLE instrument_rentals (
    id            SERIAL PRIMARY KEY,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    renter        TEXT,       -- free text: who/where it's going, e.g. "Live event — Thalia Hall"
    start_date    DATE NOT NULL,
    end_date      DATE,       -- NULL = return date not yet known
    notes         TEXT,
    created_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX instrument_rentals_instrument_idx ON instrument_rentals (instrument_id, start_date);
CREATE INDEX instrument_rentals_range_idx ON instrument_rentals (start_date, end_date);

CREATE TRIGGER instrument_rentals_touch BEFORE UPDATE ON instrument_rentals
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
