-- Daily To-Do's workflow: three related pieces, all scoped to the
-- ticket_category 'daily_todo' ("Daily To-Do's" -- a catch-all category
-- staff pick by hand, alongside Shipping/Orders & Shipping; see NOTES.md).
--
-- 1) Auto-create-a-task-from-the-ticket's-own-title. routes/tickets.js's
--    insertTicketRow() already does this, but gated on a hardcoded
--    `category.key === 'housekeeping'` check -- generalized here to a
--    Settings-editable per-category meta flag instead (same "don't
--    hardcode a category key that Settings can retire out from under it"
--    reasoning as N4a). Housekeeping keeps the behavior it already had
--    (seeded true here so nothing changes for it); Daily To-Do's gets it
--    newly, since a Daily To-Do ticket's whole point is just as much "the
--    title is the job" as a Housekeeping one.
--
-- 2) Daily To-Do's own preferred starting status. services/settings.js's
--    defaultStatusForCategory() otherwise always picks "first non-retired
--    status in sort order" for a category -- a new meta.default_status_key
--    override lets a category name its own, same pattern as
--    meta.default_assignee_id. Set to 'in_progress' here so a Daily To-Do
--    ticket's freshly auto-created task is immediately visible on "My
--    tasks" (migration 022's meta.unlocks_tasks lives on the 'in_progress'
--    status), rather than sitting invisible until someone manually flips
--    the ticket's status first.
--
-- 3) End-of-day archive sweep (services/recurringTickets.js's
--    dailyTodoArchiveSweep(), same shop-local-date-guarded idiom as that
--    file's existing fleetQcSweep()) needs its own last-run tracking row,
--    same shape as fleet_qc_sweep's.
UPDATE settings
   SET meta = meta || '{"auto_task_from_title": true}'::jsonb
 WHERE category = 'ticket_category' AND key = 'housekeeping';

UPDATE settings
   SET meta = meta || '{"auto_task_from_title": true, "default_status_key": "in_progress"}'::jsonb
 WHERE category = 'ticket_category' AND key = 'daily_todo';

INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('shop_config', 'daily_todo_archive', 'Daily To-Do end-of-day archive', 50, '{}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
