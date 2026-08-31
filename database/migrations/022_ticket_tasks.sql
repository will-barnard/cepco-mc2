-- Tasks (PLAN follow-up, NOTES.md §2.28): a ticket's short-lived, per-tech
-- work items — the granular "what do I actually do next" list that sits
-- underneath a ticket, distinct from every other per-ticket concept:
--   - Not a sub-ticket (migration 008/§2.22): a sub-ticket is a full ticket
--     with its own status workflow, queue position, hours log, and QC/
--     invoicing exposure. A job's ~10 tasks would flood every one of those
--     if they were sub-tickets instead.
--   - Not a QC check (qc_checks/qc_templates, §2.23): QC items are
--     reference-only and reviewer-signed-off, not tracked completion state
--     assigned to whoever's doing the work.
--   - Directly sourced from standard_procedures (migration 010, §2.24) when
--     a task represents catalog work — either carried over automatically
--     when a customer quote converts to a ticket (routes/quotes.js's
--     createTicketsForEstimate — see estimate_item_id below), or attached
--     to a ticket by hand for jobs that never went through a quote. A task
--     can also exist with no procedure behind it at all, for ad-hoc work
--     ("call customer back about the finish color") that isn't on the
--     catalog.
--
-- Rows are created as soon as a procedure/task is attached to a ticket,
-- regardless of the ticket's current status — "eventually populate as
-- tasks" means the row exists right away (so staff can plan a job's tasks
-- during intake), but GET /tasks?unlocked_only=true (what the tech
-- dashboard's "My tasks" section reads) only surfaces tasks whose ticket is
-- currently in a status with meta.unlocks_tasks = true (see the UPDATE
-- below) — a new admin-configurable flag, not a hardcoded status key,
-- since every other status-driven behavior in this app (sort order,
-- category applicability, color) already goes through Settings-editable
-- meta rather than a string comparison against a specific key that an
-- admin could rename or reorder out from under it.
CREATE TABLE ticket_tasks (
    id                     SERIAL PRIMARY KEY,
    ticket_id              INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,

    -- Set when this task came from the procedures catalog; NULL for a
    -- free-form/ad-hoc task. ON DELETE SET NULL rather than RESTRICT/CASCADE
    -- — same reasoning as estimate_items.procedure_id (migration 011): a
    -- later-deleted procedure must never take an already-attached task (or
    -- its title, already snapshotted below) down with it.
    standard_procedure_id  INTEGER REFERENCES standard_procedures(id) ON DELETE SET NULL,

    -- Set only for a task that was carried over automatically from a
    -- customer quote at conversion time (routes/quotes.js) — lets that
    -- carry-over path recognize "this estimate_item already became a task"
    -- without depending on title-matching. NULL for anything attached
    -- directly to a ticket, quote or no quote.
    estimate_item_id       INTEGER REFERENCES estimate_items(id) ON DELETE SET NULL,

    -- Snapshotted at creation from standard_procedures.name (same
    -- snapshot-don't-reference convention as estimate_items.procedure_name
    -- and every other label snapshot in this app) for a procedure-sourced
    -- task, or typed directly for a free-form one. A later procedure
    -- rename never rewrites a task that's already in progress.
    title                  TEXT NOT NULL,

    -- The task's own assignee — independent of ticket_technicians
    -- (migration 013), since one ticket's ten tasks are meant to be
    -- splittable across whichever of its techs is doing each one. NULL =
    -- unclaimed (e.g. every task carried over from a quote starts this way
    -- — a quote doesn't know who'll do the work).
    technician_id          INTEGER REFERENCES employees(id) ON DELETE SET NULL,

    -- "Back of the line" ordering within a ticket, same convention as
    -- category_queue_position/family_queue_position (migrations 007/015):
    -- new tasks get MAX(position)+10 for their ticket, leaving room to
    -- reorder later without a full renumber if that's ever added.
    position               INTEGER NOT NULL DEFAULT 0,

    done                   BOOLEAN NOT NULL DEFAULT FALSE,
    done_at                TIMESTAMPTZ,
    done_by                INTEGER REFERENCES employees(id) ON DELETE SET NULL,

    created_by             INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every ticket-detail read is "all tasks for this ticket," and the tech
-- dashboard's per-tech query is "this tech's open tasks" — both need to be
-- fast without a sequential scan as ticket_tasks grows.
CREATE INDEX ticket_tasks_ticket_idx ON ticket_tasks (ticket_id);
CREATE INDEX ticket_tasks_technician_open_idx
  ON ticket_tasks (technician_id) WHERE done = FALSE;

-- The unlock flag itself: the shop's actual "In Progress" status (seed.js's
-- default) is the sensible starting point, same as any other feature that
-- ships with a reasonable default an admin can immediately see and change
-- (e.g. §2.25's category-queue-picker meta). Existing installs get this
-- backfilled here; seed.js is updated to match for anything seeded fresh
-- from now on.
UPDATE settings
   SET meta = meta || '{"unlocks_tasks": true}'::jsonb
 WHERE category = 'ticket_status' AND key = 'in_progress';
