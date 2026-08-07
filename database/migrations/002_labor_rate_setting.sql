-- ===========================================================================
-- Shop labor rate: $175 -> $185, and promoted to an admin-editable setting.
--
-- NOTES.md §2.8 flagged that burying the rate in a column default means a code
-- change every time it moves. It has now moved, so it becomes configuration.
--
-- Deliberately NOT backfilled: estimates already written keep the rate they
-- were quoted at. `estimates.labor_rate` stays on the row for exactly that
-- reason — a rate change must never silently restate an old quote.
-- ===========================================================================

ALTER TABLE estimates ALTER COLUMN labor_rate SET DEFAULT 185.00;

INSERT INTO settings (category, key, label, sort_order, meta)
VALUES (
  'shop_config',
  'labor_rate',
  'Shop labor rate ($/hr)',
  10,
  '{"value": 185, "unit": "usd_per_hour"}'::jsonb
)
ON CONFLICT (category, key) DO NOTHING;
