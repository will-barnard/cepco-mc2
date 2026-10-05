-- Shop feedback, Oct 2026 — Reservation and Not Started share one queue.
--
-- A Reservation is a job that hasn't started *and* whose instrument isn't
-- in the shop yet. The shop wants the two in one line: a reservation that
-- was booked before a Not Started ticket sits above it. Until now every
-- status was its own queue section — GET /tickets ordered by the status's
-- sort_order first and the queue position second, and POST
-- /tickets/reorder-queue renumbered one status at a time — so a Reservation
-- could never sit above any Not Started ticket, however old it was.
--
-- 1. ticket_status.meta.queue_group: statuses carrying the same (trimmed,
--    case-insensitive) name share one queue section. The section sorts
--    where its highest-sort_order member would, is labelled after that
--    member, and is ordered by the usual position columns across all of
--    its statuses. Ungrouped statuses behave exactly as before. Editable
--    per status from Settings -> Ticket statuses ("Queue section").
UPDATE settings
   SET meta = meta || '{"queue_group": "waiting"}'::jsonb
 WHERE category = 'ticket_status'
   AND key IN ('reservation', 'not_started')
   AND COALESCE(btrim(meta->>'queue_group'), '') = '';

-- 2. Seed one shared order. Each status's positions were numbered on their
--    own (every drag renumbers its section 10, 20, 30...), so the two
--    statuses' numbers overlap and can't simply be interleaved. Renumber
--    the merged section once, oldest Date of Order/Queue (drop_off_date)
--    first, ties broken by when the ticket was entered — on every queue
--    axis: category, instrument family, and each tech's own queue. After
--    this, new tickets still join at the back of the line (MAX + 10, see
--    routes/tickets.js), so "older is higher" holds by default and a drag
--    can still override it.
--
--    A function rather than inline SQL because services/settings.js calls
--    the same thing whenever an admin puts statuses into a shared section
--    later — the same overlap problem, any time two statuses are merged.
--    Archived tickets are left alone, same scope as reorder-queue's own
--    "who's in this section" check.
CREATE OR REPLACE FUNCTION renumber_queue_section(status_keys TEXT[]) RETURNS VOID AS $$
BEGIN
  UPDATE tickets t
     SET category_queue_position = r.rn * 10
    FROM (SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY category_key
                                    ORDER BY drop_off_date NULLS LAST, created_at, id) AS rn
            FROM tickets
           WHERE archived = FALSE AND status_key = ANY(status_keys)) r
   WHERE t.id = r.id;

  UPDATE tickets t
     SET family_queue_position = r.rn * 10
    FROM (SELECT t2.id,
                 ROW_NUMBER() OVER (PARTITION BY i2.family
                                    ORDER BY t2.drop_off_date NULLS LAST, t2.created_at, t2.id) AS rn
            FROM tickets t2
            JOIN instruments i2 ON i2.id = t2.instrument_id
           WHERE t2.archived = FALSE AND t2.status_key = ANY(status_keys)) r
   WHERE t.id = r.id;

  UPDATE ticket_technicians tt
     SET queue_position = r.rn * 10
    FROM (SELECT tt2.ticket_id, tt2.employee_id,
                 ROW_NUMBER() OVER (PARTITION BY tt2.employee_id
                                    ORDER BY t2.drop_off_date NULLS LAST, t2.created_at, t2.id) AS rn
            FROM ticket_technicians tt2
            JOIN tickets t2 ON t2.id = tt2.ticket_id
           WHERE t2.archived = FALSE AND t2.status_key = ANY(status_keys)) r
   WHERE tt.ticket_id = r.ticket_id AND tt.employee_id = r.employee_id;
END;
$$ LANGUAGE plpgsql;

SELECT renumber_queue_section(ARRAY(
  SELECT key FROM settings
   WHERE category = 'ticket_status'
     AND lower(btrim(meta->>'queue_group')) = 'waiting'
));
