-- Shop feedback, Oct 2026 — ticket page changes.
--
-- 1. Vendor work, editable. tickets.vendor_tracks (001_init) was only ever
--    filled by the CSV import — one free-text value per old sheet column
--    (Painting, Woodshop, Key Tops, ...) — and the ticket page could only
--    show it, not change it. This gives it a real home:
--      ticket_vendor_work: one row per (ticket, vendor type), with a status
--      and an optional note, stamped with who last changed it and when.
--    Vendor types and their statuses are Settings lists ('vendor_track' /
--    'vendor_status') so the shop can add a new outside vendor (tolex,
--    plating, ...) or status without a deploy — same reasoning as every
--    other settings enum here. Keyed by settings key, so a rename in
--    Settings follows through to every ticket.
CREATE TABLE IF NOT EXISTS ticket_vendor_work (
    id          SERIAL PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    track_key   TEXT NOT NULL,
    status_key  TEXT NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    UNIQUE (ticket_id, track_key)
);

-- Seeded from the old sheets' own column names and status values.
INSERT INTO settings (category, key, label, sort_order, meta) VALUES
  ('vendor_track', 'painting',     'Painting',     10, '{}'::jsonb),
  ('vendor_track', 'woodshop',     'Woodshop',     20, '{}'::jsonb),
  ('vendor_track', 'key_tops',     'Key Tops',     30, '{}'::jsonb),
  ('vendor_track', 'plastics',     'Plastics',     40, '{}'::jsonb),
  ('vendor_track', 'metal_fab',    'Metal Fab',    50, '{}'::jsonb),
  ('vendor_track', 'other_vendor', 'Other Vendor', 60, '{}'::jsonb),
  ('vendor_status', 'not_started',      'Not Started',         10, '{"color": "slate"}'::jsonb),
  ('vendor_status', 'booked',           'Booked/Contracted',   20, '{"color": "violet"}'::jsonb),
  ('vendor_status', 'in_progress',      'In Progress',         30, '{"color": "blue"}'::jsonb),
  ('vendor_status', 'ready_for_pickup', 'Ready for Pickup',    40, '{"color": "amber"}'::jsonb),
  ('vendor_status', 'complete',         'Completed/Delivered', 50, '{"color": "green", "complete": true}'::jsonb),
  ('vendor_status', 'on_hold',          'On Hold',             60, '{"color": "red"}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;

-- Carry over every imported pair that cleanly matches a type + status
-- (case-insensitive on the labels)...
INSERT INTO ticket_vendor_work (ticket_id, track_key, status_key)
SELECT t.id, tr.key, st.key
  FROM tickets t
 CROSS JOIN LATERAL jsonb_each_text(t.vendor_tracks) kv
  JOIN settings tr ON tr.category = 'vendor_track'  AND lower(tr.label) = lower(trim(kv.key))
  JOIN settings st ON st.category = 'vendor_status' AND lower(st.label) = lower(trim(kv.value))
ON CONFLICT (ticket_id, track_key) DO NOTHING;

-- ...and drop those pairs from vendor_tracks, along with the import's
-- header-row echoes ("Painting": "Painting"). Whatever's left is free text
-- that didn't map ("Woodshop": "TBD", "Other Vendor": "tolex") — kept, and
-- still shown read-only on the ticket as imported notes, never discarded.
UPDATE tickets t
   SET vendor_tracks = COALESCE((
         SELECT jsonb_object_agg(kv.key, kv.value)
           FROM jsonb_each_text(t.vendor_tracks) kv
          WHERE lower(trim(kv.key)) <> lower(trim(kv.value))
            AND NOT EXISTS (
              SELECT 1 FROM ticket_vendor_work w
                JOIN settings tr ON tr.category = 'vendor_track' AND tr.key = w.track_key
               WHERE w.ticket_id = t.id AND lower(tr.label) = lower(trim(kv.key)))
       ), '{}'::jsonb)
 WHERE t.vendor_tracks <> '{}'::jsonb;

-- 2. Service Log. The ticket's "Service done" free-text box becomes a log
--    of entries — what was done, and the hours it took — which is exactly
--    what hours_log already is (description, hours, who, date; one row per
--    task since migration 055). So the Service Log *is* hours_log, shown on
--    the ticket, rather than a parallel table that would double-count time.
--
--    Every completed task now registers an entry automatically (routes/
--    tasks.js), whether or not anyone typed hours for it yet — so hours
--    has to be allowed to be blank. The CHECK (hours > 0) stays and still
--    rejects 0/negatives; NULL passes a CHECK, and every sum(hours) in the
--    app already ignores NULLs.
ALTER TABLE hours_log ALTER COLUMN hours DROP NOT NULL;

-- Backfill: tasks already marked done before this migration get their
-- entry too, so the log isn't missing everything finished up to today.
-- Skips ephemeral tasks (no ticket) and the rare task with nobody at all
-- to attribute it to (hours_log.employee_id is NOT NULL).
INSERT INTO hours_log (ticket_id, ticket_task_id, employee_id, hours, task_description, worked_on)
SELECT tk.ticket_id, tk.id, COALESCE(tk.done_by, tk.technician_id, tk.created_by), NULL, tk.title,
       COALESCE(tk.done_at::date, CURRENT_DATE)
  FROM ticket_tasks tk
 WHERE tk.done = TRUE
   AND tk.ticket_id IS NOT NULL
   AND COALESCE(tk.done_by, tk.technician_id, tk.created_by) IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM hours_log h WHERE h.ticket_task_id = tk.id);
