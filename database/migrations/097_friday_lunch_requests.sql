-- ===========================================================================
-- Friday Lunch requests (Nov 2026): a new first phase, before suggestions.
-- Each person can post one short request ("no Chinese, no Mexican",
-- "somewhere with vegetarian options") to steer what gets suggested and
-- voted for. Requests lock when an admin opens suggestions, and stay on
-- show through suggestions, review and voting -- a runoff shows its parent
-- round's requests -- and are listed in the suggestions-open, voting-open
-- and runoff emails.
--
-- Phases are now: requesting -> suggesting -> reviewing -> voting -> closed
-- (or cancelled). New rounds open in 'requesting'.
--
-- Anonymous like suggestions: employee_id is kept only so people can edit
-- or remove their own; no endpoint returns whose request is whose (see
-- services/fridayLunch.js's anonymity rule).
-- ===========================================================================

ALTER TABLE lunch_rounds DROP CONSTRAINT lunch_rounds_phase_check;
ALTER TABLE lunch_rounds ADD CONSTRAINT lunch_rounds_phase_check
  CHECK (phase IN ('requesting', 'suggesting', 'reviewing', 'voting', 'closed', 'cancelled'));
ALTER TABLE lunch_rounds ALTER COLUMN phase SET DEFAULT 'requesting';
ALTER TABLE lunch_rounds ADD COLUMN suggesting_at TIMESTAMPTZ;

-- "One round in progress" now includes the requests phase.
DROP INDEX lunch_rounds_one_open_idx;
CREATE UNIQUE INDEX lunch_rounds_one_open_idx
  ON lunch_rounds ((TRUE)) WHERE phase IN ('requesting', 'suggesting', 'reviewing', 'voting');

CREATE TABLE lunch_requests (
    id            SERIAL PRIMARY KEY,
    round_id      INTEGER NOT NULL REFERENCES lunch_rounds(id) ON DELETE CASCADE,
    employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    request_text  TEXT NOT NULL CHECK (btrim(request_text) <> ''),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (round_id, employee_id)
);
