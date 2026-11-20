-- ===========================================================================
-- Friday Lunch runoffs (Nov 2026). After a round closes, an admin can send
-- its top N places (N chosen by the admin) to a runoff: a second round for
-- the same Friday that opens straight into voting with just those places.
-- Runoff ballots are pick-one, most votes wins. A tie is left undecided
-- (result.tie_break.method = 'pending') until an admin presses "Pick at
-- random" -- the shop wanted a person to make that call rather than the
-- count doing it silently. All rules: backend services/fridayLunch.js.
--
-- A runoff is an ordinary lunch_rounds row with its own copied places and
-- ballots, so voting, turnout, closing and emails are all the existing code.
-- ===========================================================================

ALTER TABLE lunch_rounds
  ADD COLUMN parent_round_id INTEGER REFERENCES lunch_rounds(id) ON DELETE CASCADE;

-- One live runoff per round. A cancelled runoff doesn't count, so the admin
-- can start another one (for example with a different N).
CREATE UNIQUE INDEX lunch_rounds_one_runoff_idx
  ON lunch_rounds (parent_round_id)
  WHERE parent_round_id IS NOT NULL AND phase <> 'cancelled';
