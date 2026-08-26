-- Explicit, admin-reorderable queue order for jobs (tickets), on two
-- independent axes:
--
--   category_queue_position - this ticket's position among other active
--     tickets in the same ticket_category (e.g. all "Servicing" jobs).
--   tech_queue_position     - this ticket's position among other active
--     tickets assigned to the same tech (e.g. everything on Sam's plate).
--
-- Two separate columns, not one shared "queue position," because these two
-- orderings can legitimately disagree: an admin might want a ticket done
-- first in a specific tech's day even though three other tickets are
-- technically "ahead" of it in that category shop-wide. Nullable: a ticket
-- with no assigned tech has no tech_queue_position, and an archived ticket
-- keeps whatever position it last had (harmless — every query that reads
-- these columns already filters WHERE archived = FALSE).
--
-- Before this, the ticket list's only "order" was priority tier + most-
-- recently-updated-first, which reshuffled every time anyone touched a
-- ticket -- not something a person could deliberately reorder. This backfills
-- that implicit order into an explicit, stable starting point so existing
-- queues don't all collapse to the same position on migrate.
ALTER TABLE tickets
  ADD COLUMN category_queue_position INTEGER,
  ADD COLUMN tech_queue_position     INTEGER;

WITH ranked AS (
  SELECT t.id,
         row_number() OVER (
           PARTITION BY t.category_key
           ORDER BY pr.sort_order NULLS LAST, t.updated_at DESC
         ) AS rn
    FROM tickets t
    LEFT JOIN settings pr ON pr.category = 'priority_tier' AND pr.key = t.priority_key
   WHERE t.archived = FALSE
)
UPDATE tickets t SET category_queue_position = ranked.rn * 10
  FROM ranked WHERE ranked.id = t.id;

WITH ranked AS (
  SELECT t.id,
         row_number() OVER (
           PARTITION BY t.assigned_tech_id
           ORDER BY pr.sort_order NULLS LAST, t.updated_at DESC
         ) AS rn
    FROM tickets t
    LEFT JOIN settings pr ON pr.category = 'priority_tier' AND pr.key = t.priority_key
   WHERE t.archived = FALSE AND t.assigned_tech_id IS NOT NULL
)
UPDATE tickets t SET tech_queue_position = ranked.rn * 10
  FROM ranked WHERE ranked.id = t.id;

-- Every list/reorder query filters by (category_key, archived) or
-- (assigned_tech_id, archived) and orders by the matching position column.
CREATE INDEX tickets_category_queue_idx
  ON tickets (category_key, category_queue_position) WHERE archived = FALSE;
CREATE INDEX tickets_tech_queue_idx
  ON tickets (assigned_tech_id, tech_queue_position)
  WHERE archived = FALSE AND assigned_tech_id IS NOT NULL;
