-- Rename "status reports" -> "Progress Updates" throughout, per Will.
-- Forward-only, same posture as migration 019's ceppie->ceppy rename:
-- table, its attachment join table, their indexes and trigger, all
-- renamed in schema, plus the one piece of *data* that encoded the old
-- name — the hide_status_report settings meta flag (migration 041) — is
-- rewritten to hide_progress_update below so Settings -> Ticket
-- categories' toggle (now reading the new key) doesn't silently forget
-- that Housekeeping opted out.
--
-- Deliberately NOT touched: existing `emails.template = 'status_report'`
-- rows (routes/statusReports.js, now progressUpdates.js) are a sent-mail
-- audit log — same "a snapshot records what happened, not what it's
-- called today" convention as every other snapshot column in this schema
-- (estimate_items, quote confirm_token, etc.). New sends write
-- 'progress_update' going forward; old rows keep the name that was
-- actually true when they were sent.
ALTER TABLE status_reports RENAME TO progress_updates;
ALTER TABLE status_report_attachments RENAME TO progress_update_attachments;
ALTER TABLE progress_update_attachments RENAME COLUMN status_report_id TO progress_update_id;

ALTER INDEX status_reports_ticket_idx RENAME TO progress_updates_ticket_idx;
ALTER INDEX status_reports_customer_idx RENAME TO progress_updates_customer_idx;
ALTER INDEX status_report_attachments_report_idx RENAME TO progress_update_attachments_report_idx;

ALTER TRIGGER status_reports_touch ON progress_updates RENAME TO progress_updates_touch;

-- Data-level rename of the settings meta key, same reasoning as migration
-- 019's `UPDATE settings SET key = ...`: the key lives inside a jsonb
-- blob, not a column name, so the schema-level renames above can't reach
-- it. Only ever set on 'housekeeping' today (migration 041), but written
-- generically (any ticket_category row carrying the old key) rather than
-- hardcoded to that one row, in case another category has since opted
-- out the same way.
UPDATE settings
   SET meta = (meta - 'hide_status_report')
              || jsonb_build_object('hide_progress_update', meta->'hide_status_report')
 WHERE category = 'ticket_category' AND meta ? 'hide_status_report';
