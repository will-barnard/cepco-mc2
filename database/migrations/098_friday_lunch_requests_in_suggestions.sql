-- ===========================================================================
-- Friday Lunch: requests merged into the suggestions phase (Nov 2026).
--
-- Migration 097 made requests their own first phase. In practice that meant
-- a second email and a second wait, so requests now happen inside the
-- suggestions phase instead: when someone opens the page they're asked for
-- their request first (or "no requests"), then move straight on to
-- suggesting, and the requests list updates live while people suggest. The
-- admin sorts out conflicts ("no Mexican" vs. a Chipotle suggestion) in
-- review before voting.
--
-- So: new rounds open in 'suggesting' again, and any round sitting in
-- 'requesting' moves on. 'requesting' stays in the CHECK constraint purely
-- so this migration can't fail on old rows; nothing sets it any more.
--
-- request_text NULL now means "answered: no requests" -- that's what moves
-- a person past the request step without posting anything.
-- ===========================================================================

UPDATE lunch_rounds SET phase = 'suggesting', suggesting_at = COALESCE(suggesting_at, now())
 WHERE phase = 'requesting';
ALTER TABLE lunch_rounds ALTER COLUMN phase SET DEFAULT 'suggesting';

ALTER TABLE lunch_requests ALTER COLUMN request_text DROP NOT NULL;
ALTER TABLE lunch_requests DROP CONSTRAINT lunch_requests_request_text_check;
ALTER TABLE lunch_requests ADD CONSTRAINT lunch_requests_request_text_check
  CHECK (request_text IS NULL OR btrim(request_text) <> '');
