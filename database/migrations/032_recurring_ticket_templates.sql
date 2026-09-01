-- A1 (boss-list scope): the recurring-ticket engine. Nothing generates
-- tickets on a schedule today; the pattern to copy is already in the
-- codebase (services/ceppyScheduler.js) — a plain in-process interval that
-- reads a config row, checks the shop-local day/time, and guards against
-- double-firing with a last-run timestamp. This table is that engine's
-- config, one row per recurring job.
--
-- day_of_week/time_of_day follow the exact same shape as
-- shop_config.ceppys_schedule's meta (EXTRACT(DOW) semantics, 'HH:MM'
-- shop-local text) rather than inventing a new time representation.
-- last_generated_at is compared by shop-local *date*, not exact timestamp,
-- for the same "resilient to a missed tick" reason ceppyScheduler compares
-- last_sent_at by local date instead of exact time.
CREATE TABLE recurring_ticket_templates (
    id                        SERIAL PRIMARY KEY,
    title                     TEXT NOT NULL,
    category_key              TEXT NOT NULL,
    priority_key              TEXT NOT NULL,
    cadence                   TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
    day_of_week               INTEGER CHECK (day_of_week BETWEEN 0 AND 6), -- weekly only; NULL for daily
    time_of_day               TEXT NOT NULL, -- 'HH:MM', shop-local
    notes                     TEXT,

    -- A2 (weekly chore rotation) extends this same table rather than
    -- adding a second one: when true, the ticket's assignee is the next
    -- active, non-excluded employee after rotation_last_employee_id
    -- (services/recurringTickets.js), not a fixed person. A1's four daily
    -- templates don't use this — they fall back to their category's
    -- default-assignee (Settings), same as any other ticket-creation path.
    rotate_among_active_techs BOOLEAN NOT NULL DEFAULT FALSE,
    rotation_last_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

    active                    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order                INTEGER NOT NULL DEFAULT 0,
    last_generated_at         TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (cadence = 'daily' OR day_of_week IS NOT NULL)
);

-- The four daily tickets named on the boss list. Category/priority keys
-- are whatever's live after the N2b/N4b reshuffle (migration 029) —
-- Housekeeping for the inbox sweeps, Orders & Shipping for the order
-- sweeps, Low Priority for all four since they're routine daily upkeep,
-- not urgent work. All admin-editable afterward from the new Settings ->
-- Recurring tickets screen; these are just sensible starting values.
INSERT INTO recurring_ticket_templates
  (title, category_key, priority_key, cadence, time_of_day, sort_order)
VALUES
  ('AM Inbox Clearing',   'housekeeping',     'low_priority', 'daily', '08:30', 10),
  ('PM Inbox Clearing',   'housekeeping',     'low_priority', 'daily', '16:00', 20),
  ('AM Online Orders',    'orders_shipping',  'low_priority', 'daily', '08:30', 30),
  ('PM Online Orders',    'orders_shipping',  'low_priority', 'daily', '16:00', 40);
