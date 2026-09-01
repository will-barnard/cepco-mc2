-- A2 (boss-list scope): weekly cleaning tickets, rotating through the
-- techs. Per the boss's call, the "skip this person" exclusion lives on
-- the staff record (one flag covers every chore template at once) rather
-- than a separate exclusion list per template — so the next person who
-- shouldn't be in the rotation doesn't need a deploy, they just get
-- unchecked in Settings -> Staff accounts.
ALTER TABLE employees ADD COLUMN excluded_from_chore_rotation BOOLEAN NOT NULL DEFAULT FALSE;

-- The four weekly chores, one per day so they don't all land on the same
-- morning. rotation_last_employee_id starts NULL on all four — the first
-- firing of each just picks the first eligible (active, not excluded)
-- employee in id order; see services/recurringTickets.js's
-- nextRotationEmployee(). Days/time/assignment are all admin-editable
-- afterward from Settings -> Recurring tickets, same as A1's four.
INSERT INTO recurring_ticket_templates
  (title, category_key, priority_key, cadence, day_of_week, time_of_day,
   rotate_among_active_techs, sort_order)
VALUES
  ('Clean bathroom', 'housekeeping', 'low_priority', 'weekly', 1, '08:00', TRUE, 50),
  ('Clean floor',     'housekeeping', 'low_priority', 'weekly', 2, '08:00', TRUE, 60),
  ('Clean showroom',  'housekeeping', 'low_priority', 'weekly', 3, '08:00', TRUE, 70),
  ('Clean kitchen',   'housekeeping', 'low_priority', 'weekly', 4, '08:00', TRUE, 80);
