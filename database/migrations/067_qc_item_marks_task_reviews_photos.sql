-- QC rework: pass / fail / N/A marks, per-task review, and QC-only photos.
--
-- 1. Checklist items. qc_checks.results is a JSONB snapshot of the template
--    items; until now each element carried a boolean `checked` (the old
--    "highlight this item" toggle). It becomes a three-way `status`:
--    'pass' | 'fail' | 'na' | null (null = not reviewed yet). Anything that
--    was highlighted under the old model reads as a pass — highlighting was
--    the only way to say "this one's been looked at", so pass is the honest
--    translation. `checked` is dropped so there is one source of truth.
--    Who/when is stamped per item at write time (status_by / status_at) by
--    routes/qc.js; backfilled rows simply don't have them.
UPDATE qc_checks
   SET results = (
     SELECT COALESCE(
              jsonb_agg(
                (t.elem - 'checked')
                  || jsonb_build_object(
                       'status',
                       CASE WHEN COALESCE((t.elem ->> 'checked')::boolean, FALSE)
                            THEN 'pass' ELSE NULL END)
                ORDER BY t.ord),
              '[]'::jsonb)
       FROM jsonb_array_elements(qc_checks.results) WITH ORDINALITY AS t(elem, ord)
   )
 WHERE jsonb_typeof(results) = 'array' AND jsonb_array_length(results) > 0;

-- 2. Task review. Each QC round reviews the ticket's *completed* tasks with
--    the same three marks. Keyed per round (not per ticket) on purpose:
--    round 1 and round 2 are separate passes, each with its own verdict on
--    the same task. A row exists only while a mark is set — clearing a mark
--    deletes the row, so "no row" and "not reviewed" are the same thing.
--    Tasks are not snapshotted: the list shown is the ticket's live done
--    tasks, so one finished after the round opened still gets reviewed.
CREATE TABLE qc_task_reviews (
    id             SERIAL PRIMARY KEY,
    qc_check_id    INTEGER NOT NULL REFERENCES qc_checks(id) ON DELETE CASCADE,
    ticket_task_id INTEGER NOT NULL REFERENCES ticket_tasks(id) ON DELETE CASCADE,
    status         TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'na')),
    reviewed_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (qc_check_id, ticket_task_id)
);
CREATE INDEX qc_task_reviews_check_idx ON qc_task_reviews (qc_check_id);

-- 3. QC photos. Deliberately a separate table from ticket_attachments so the
--    ticket's general Photos gallery is untouched and QC evidence stays
--    attached to the round it was taken in. Same columns/driver semantics as
--    ticket_attachments (storage_key, driver, ...); ticket_id is kept for
--    convenience and so a ticket delete cascades.
CREATE TABLE qc_attachments (
    id            SERIAL PRIMARY KEY,
    qc_check_id   INTEGER NOT NULL REFERENCES qc_checks(id) ON DELETE CASCADE,
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    uploader_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    storage_key   TEXT NOT NULL,
    driver        TEXT NOT NULL,
    file_name     TEXT,
    content_type  TEXT,
    size_bytes    BIGINT,
    caption       TEXT,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qc_attachments_check_idx ON qc_attachments (qc_check_id, uploaded_at);
