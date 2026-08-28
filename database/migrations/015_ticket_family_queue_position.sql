-- Explicit, admin-reorderable queue order for jobs (tickets), scoped to the
-- instrument's family (rhodes, wurlitzer, hohner, strings, organ, amp,
-- rarity — see routes/instruments.js's FAMILIES) — a third, independent
-- queue axis alongside category_queue_position (007, "all Servicing jobs")
-- and ticket_technicians.queue_position (013, "everything on Sam's plate").
-- An admin might want every Rhodes job worked in one deliberate order
-- regardless of which category or tech it's under, the same way category
-- and tech queues already let them do for those two axes.
--
-- Nullable, and only ever set for tickets that have an instrument: a
-- shipping ticket or anything else with no instrument_id has no family to
-- queue against, so it simply never gets a family_queue_position. Every
-- query that reads this column already scopes to "tickets whose instrument
-- is in family X," so a NULL here never surfaces as a gap in anyone's queue
-- — same reasoning as tech_queue_position being NULL for an unassigned
-- ticket in migration 007.
ALTER TABLE tickets ADD COLUMN family_queue_position INTEGER;

WITH ranked AS (
  SELECT t.id,
         row_number() OVER (
           PARTITION BY i.family
           ORDER BY pr.sort_order NULLS LAST, t.updated_at DESC
         ) AS rn
    FROM tickets t
    JOIN instruments i ON i.id = t.instrument_id
    LEFT JOIN settings pr ON pr.category = 'priority_tier' AND pr.key = t.priority_key
   WHERE t.archived = FALSE
)
UPDATE tickets t SET family_queue_position = ranked.rn * 10
  FROM ranked WHERE ranked.id = t.id;

-- Every family-queue list/reorder query joins tickets -> instruments to
-- filter by family, then orders by this column — mirrors the category and
-- tech partial indexes above, keyed on instrument_id since family itself
-- isn't a column on tickets.
CREATE INDEX tickets_family_queue_idx
  ON tickets (instrument_id, family_queue_position) WHERE archived = FALSE;
