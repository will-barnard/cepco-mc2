-- Standard procedures: parts costs that vary by key-count model variant,
-- and an "outlier hours" reference for the estimate builder's variance
-- buffer. Both driven by the Rhodes/Wurlitzer pricing sheet migration 044
-- seeds from — see NOTES.md for the full writeup and the two design
-- decisions this encodes.
--
-- 1. PARTS BY VARIANT. Several Rhodes parts (grommets, hammer tips, tolex,
--    the white key/sharp) price differently depending on the instrument's
--    key count (a shop shorthand of "Piano Bass" / "54-Key" / "73-Key" /
--    "88-Key" models) — up to four different numbers for what is
--    otherwise the same repair. `flat_cost` could only ever hold one, so
--    a procedure now optionally carries all four instead, and an estimate
--    line item picks whichever one actually applies to the instrument
--    being quoted (see estimate_items below, and routes/quotes.js).
--    `flat_cost` keeps its existing meaning — a single parts price that
--    does NOT vary by variant (every Wurlitzer parts cost in the sheet,
--    plus the Rhodes rows where the four columns happened to be
--    identical) — and is mutually exclusive with the four variant
--    columns: a procedure prices its parts one way or the other, never
--    both.
--
--    Labor (hours) and parts are now independent of each other rather
--    than the "hours XOR flat" choice migration 010 started with: a
--    procedure can be hours-only (no parts at all), parts-only (no
--    labor — pricing_type stays 'flat' for these), or both hours AND a
--    parts cost (flat or by-variant) on the same row, which is the
--    common case in the source sheet (a grommet job is a labor charge
--    plus the grommet itself). pricing_type keeps its original meaning:
--    'hours' means this procedure bills labor at the shop rate,
--    'flat' means it doesn't (a pure parts line, no labor hours).
--
-- 2. OUTLIER HOURS. The sheet's "Outlier" column is a mean estimate of
--    how long this specific job runs when it turns out to be the hard
--    one — a shop reference point, not a real quote bound. Explicitly
--    NOT customer-facing (see routes/quotes.js and publicQuotes.js — it's
--    never sent to a customer, by name or by value). What IS wanted: the
--    estimate builder computes the mean of (outlier_hours - max_hours)
--    across every hours-based line item on a quote, and surfaces that as
--    a single internal "assume one of these turns into an outlier"
--    buffer alongside — never folded into — the customer's own Low-High
--    range and total.
ALTER TABLE standard_procedures
  ADD COLUMN outlier_hours         NUMERIC(6,2),
  ADD COLUMN parts_cost_piano_bass NUMERIC(10,2),
  ADD COLUMN parts_cost_54_key     NUMERIC(10,2),
  ADD COLUMN parts_cost_73_key     NUMERIC(10,2),
  ADD COLUMN parts_cost_88_key     NUMERIC(10,2);

-- Replaces migration 010's original (unnamed, hence the default-named
-- `standard_procedures_check`) constraint. Same hours-range internal
-- consistency as before; the only real change is dropping the old
-- "flat_cost IS NULL when pricing_type = 'hours'" requirement (parts can
-- now ride alongside labor) and accepting a 'flat' row priced entirely
-- through the four variant columns instead of flat_cost.
ALTER TABLE standard_procedures DROP CONSTRAINT standard_procedures_check;
ALTER TABLE standard_procedures ADD CONSTRAINT standard_procedures_check CHECK (
  (pricing_type = 'hours' AND min_hours IS NOT NULL AND max_hours IS NOT NULL AND max_hours >= min_hours)
  OR
  (pricing_type = 'flat' AND min_hours IS NULL AND max_hours IS NULL
    AND (flat_cost IS NOT NULL
         OR parts_cost_piano_bass IS NOT NULL OR parts_cost_54_key IS NOT NULL
         OR parts_cost_73_key IS NOT NULL OR parts_cost_88_key IS NOT NULL))
);

-- A parts cost prices one way or the other, never both at once — see the
-- header above.
ALTER TABLE standard_procedures ADD CONSTRAINT standard_procedures_parts_exclusive_check CHECK (
  NOT (flat_cost IS NOT NULL AND (
    parts_cost_piano_bass IS NOT NULL OR parts_cost_54_key IS NOT NULL
    OR parts_cost_73_key IS NOT NULL OR parts_cost_88_key IS NOT NULL
  ))
);

-- Only meaningful for hours-based procedures, and only sensible as a
-- number bigger than the normal high end — an "outlier" that fell inside
-- the regular range wouldn't be one.
ALTER TABLE standard_procedures ADD CONSTRAINT standard_procedures_outlier_check CHECK (
  outlier_hours IS NULL OR (pricing_type = 'hours' AND outlier_hours >= max_hours)
);

-- estimate_items snapshots everything about the procedure it was added
-- from (migration 011's header) so a later catalog edit never rewrites a
-- quote that's already gone out — these four follow the same rule.
-- `parts_cost` is the resolved dollar amount for THIS line (whichever
-- variant applies, or the procedure's flat_cost if it doesn't vary),
-- additive to an hours-based item's labor cost; for a 'flat' pricing_type
-- item priced by variant, the resolved amount is snapshotted onto the
-- existing `flat_cost` column instead (no separate `parts_cost`, since a
-- flat item's whole price already lives there). `parts_variant_key`/
-- `_label_snapshot` record which variant was picked, for display only.
-- `outlier_hours` is the procedure's outlier reference at add-time, used
-- exclusively for the internal buffer calculation described above.
ALTER TABLE estimate_items
  ADD COLUMN parts_cost                  NUMERIC(10,2),
  ADD COLUMN parts_variant_key           TEXT,
  ADD COLUMN parts_variant_label_snapshot TEXT,
  ADD COLUMN outlier_hours               NUMERIC(6,2);
