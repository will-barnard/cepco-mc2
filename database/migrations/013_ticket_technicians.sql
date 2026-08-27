-- ===========================================================================
-- Multiple technicians per ticket.
--
-- tickets.assigned_tech_id was a single FK — a ticket could only ever be on
-- one person's plate. Real jobs are often worked by more than one tech
-- (e.g. a custom-shop resto split between a woodshop tech and an
-- electronics tech), so this replaces the single column with a join table:
-- one row per (ticket, technician) assignment.
--
-- tech_queue_position moves onto the join table too, as queue_position — it
-- was always "this ticket's position in *this* tech's queue", which only
-- made sense pinned to one tech per ticket. With more than one tech
-- possible, each assignment gets its own position: the same ticket can be
-- #2 on Sam's queue and #7 on Jamie's queue at the same time. See migration
-- 007 for the original reasoning on why queue position lives per-scope
-- rather than as one shared ordering.
--
-- No backend code reads tickets.assigned_tech_id / tech_queue_position
-- after this ships (routes/tickets.js and routes/hours.js were rewritten in
-- the same change to use ticket_technicians instead), so both columns —
-- and the index built for the old column — are dropped here rather than
-- left behind as dead, confusable state.
-- ===========================================================================

CREATE TABLE ticket_technicians (
    ticket_id      INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    queue_position INTEGER,
    assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    PRIMARY KEY (ticket_id, employee_id)
);
-- employee_id is the leading column here (not covered by the PK, whose
-- leading column is ticket_id) — this is what routes/hours.js's per-tech
-- workload rollup and the tech-queue list/reorder endpoints filter and sort
-- by.
CREATE INDEX ticket_technicians_employee_queue_idx
  ON ticket_technicians (employee_id, queue_position);

-- Backfill from the single-tech column/position it replaces.
INSERT INTO ticket_technicians (ticket_id, employee_id, queue_position, assigned_at)
SELECT id, assigned_tech_id, tech_queue_position, updated_at
  FROM tickets
 WHERE assigned_tech_id IS NOT NULL;

DROP INDEX IF EXISTS tickets_tech_queue_idx;
ALTER TABLE tickets
  DROP COLUMN assigned_tech_id,
  DROP COLUMN tech_queue_position;
