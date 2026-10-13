-- A fail can carry a technician's explanation. Checklist items keep theirs
-- inside the round's results JSON (results[].comment, no schema change);
-- completed-task reviews need a column. The text is kept when a mark moves
-- off 'fail' and back (so an accidental tap doesn't lose a typed
-- explanation), but the UI only shows it while the mark is a fail.
ALTER TABLE qc_task_reviews ADD COLUMN comment TEXT;
