-- Task-level hours capture (ticketing-interface cleanup): TicketHours.vue's
-- free-standing "log hours against this ticket" form is hidden for now in
-- favor of capturing hours right where the work is actually marked done —
-- TicketTasks.vue's checklist. One hours_log row per task, linked back via
-- ticket_task_id, upserted (not appended) so re-editing the number after
-- the fact replaces it rather than piling up duplicates — see routes/
-- tasks.js's PATCH /:id.
--
-- The payoff (not built yet, just what this sets up): a task already
-- carries standard_procedure_id when it's catalog-sourced, so
-- avg(hours_log.hours) grouped by ticket_tasks.standard_procedure_id will
-- eventually show how long a given procedure has actually been taking in
-- practice, to inform EstimateNewView.vue's per-procedure hour defaults —
-- the same role routes/estimates.js's GET /reference already plays at the
-- coarser instrument-family/priority-tier level.
ALTER TABLE hours_log ADD COLUMN ticket_task_id INTEGER REFERENCES ticket_tasks(id) ON DELETE SET NULL;

-- Enforces "one hours entry per task" and is what makes the upsert in
-- routes/tasks.js's PATCH /:id possible (ON CONFLICT (ticket_task_id)).
-- Partial (WHERE ticket_task_id IS NOT NULL) since every hours_log row
-- logged the old way — and any still logged directly via POST /hours, e.g.
-- for work that never went through a task — has no task to be unique
-- against.
CREATE UNIQUE INDEX hours_log_ticket_task_uniq ON hours_log (ticket_task_id) WHERE ticket_task_id IS NOT NULL;
