-- Weekly chore rotation (A2, migration 033) picked "next id after last,
-- wrapping around" — deterministic, not random. With all four chore
-- templates starting from rotation_last_employee_id = NULL, their first
-- firings each independently landed on the very first eligible employee
-- (services/recurringTickets.js's nextRotationEmployee(), the `if
-- (!lastEmployeeId) return rows[0].id` branch) — so the whole week's worth
-- of housekeeping chores landed on the same person, and nothing about the
-- rotation being deterministic-but-per-template was going to un-sync that
-- on its own. nextRotationEmployee() now picks randomly among eligible
-- (active, not excluded) employees instead, which is both what was asked
-- for and what keeps independent templates from marching in lockstep.
--
-- Boss also wants a way to redo a bad roll without waiting a week.
-- Rerolling needs to find "the ticket this template most recently
-- generated," which nothing tracked before now — tickets and
-- recurring_ticket_templates had no link at all. recurring_ticket_template_id
-- is set once, at creation, only by fireTemplate() (routes/tickets.js's
-- insertTicketRow gained an optional column for it); every other ticket-
-- creation path leaves it NULL. ON DELETE SET NULL matches
-- fixed_assignee_employee_id's posture (migration 039): retiring a
-- template shouldn't hold its already-created tickets hostage.
ALTER TABLE tickets
  ADD COLUMN recurring_ticket_template_id INTEGER
    REFERENCES recurring_ticket_templates(id) ON DELETE SET NULL;
