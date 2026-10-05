-- Shop feedback, Oct 2026 — per-ticket progress bar.
--
-- An optional "how far along is this job" number, 1-100, typed in on the
-- ticket page. When set, the ticket's row on the Queue page fills left to
-- right in green to that percentage, with the number shown. NULL = not
-- tracked, and the row looks exactly as it did before.
--
-- A plain integer column, not derived from tasks/hours: the shop wants a
-- human judgement call here ("the cabinet's done, still need the
-- action"), which a task count or estimate ratio wouldn't capture. Nothing
-- sets it automatically, including a status change.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS progress_percent SMALLINT;

-- Belt and braces under the route's own validation (routes/tickets.js).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_progress_percent_range') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_progress_percent_range
      CHECK (progress_percent IS NULL OR progress_percent BETWEEN 1 AND 100);
  END IF;
END $$;
