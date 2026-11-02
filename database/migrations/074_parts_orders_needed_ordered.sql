-- Parts/Supplies simplified to two states: needed -> ordered, plus the day
-- it was ordered (NOTES.md §2.102). Marking things delivered or cancelled
-- turned out not to matter to the shop; what does matter is "has someone
-- ordered this yet, and when."

-- ordered_at becomes a calendar DATE. It's now hand-editable ("we actually
-- ordered that Friday"), and a day is what the shop means by it. Converted
-- in shop time so an order stamped at 8pm Central doesn't become tomorrow.
ALTER TABLE parts_orders
  ALTER COLUMN ordered_at TYPE DATE
  USING (ordered_at AT TIME ZONE 'America/Chicago')::date;

-- Any 'ordered' row that somehow has no date gets its creation day as the
-- best available guess, so the UI never shows "ordered —".
UPDATE parts_orders
   SET ordered_at = (created_at AT TIME ZONE 'America/Chicago')::date
 WHERE status = 'ordered' AND ordered_at IS NULL;

-- delivered/cancelled can no longer be set (routes/parts.js refuses them),
-- but existing rows keep their status rather than being rewritten — the
-- CHECK constraint still allows both so history stays honest. Any that
-- weren't archived yet (cancelled never auto-archived) are archived now so
-- they drop out of the board.
UPDATE parts_orders SET archived = TRUE
 WHERE status IN ('delivered', 'cancelled') AND archived = FALSE;
