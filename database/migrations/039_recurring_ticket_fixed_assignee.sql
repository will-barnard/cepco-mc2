-- Some recurring tickets should always land on one specific person rather
-- than rotating or falling back to the category's default assignee — e.g.
-- a daily sweep the boss wants one particular tech to always own, or a
-- weekly chore that shouldn't rotate at all. fixed_assignee_employee_id is
-- optional and independent of rotate_among_active_techs: when set, it wins
-- outright (services/recurringTickets.js's fireTemplate checks it first);
-- when NULL — the default, and untouched on every existing row by this
-- migration — firing behaves exactly as before: rotation if
-- rotate_among_active_techs is on, otherwise the category's default
-- assignee, same as any other ticket-creation path.
--
-- ON DELETE SET NULL rather than blocking the delete: removing a staff
-- account shouldn't be held hostage by a recurring-ticket pin, and a
-- template silently falling back to rotation/default is a fine, visible
-- outcome (same posture nextRotationEmployee() already takes when nobody
-- eligible is left in the rotation pool).
ALTER TABLE recurring_ticket_templates
  ADD COLUMN fixed_assignee_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
