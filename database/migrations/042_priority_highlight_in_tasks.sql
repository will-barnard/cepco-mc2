-- Dashboard cleanup: a priority tier can now be flagged to pull its tasks
-- out of the regular "My tasks" list on DashboardView.vue into their own
-- separate, visually distinct box right below it — a way to make a given
-- priority level's work impossible to miss, rather than it just sorting
-- to the top of one flat list (which sort_order already does, and clearly
-- wasn't visible enough on its own to prompt this).
--
-- Same meta-on-the-settings-row, admin-togglable mechanism as every other
-- per-row behavior flag in this app (ticket_category's hide_ship_button,
-- ticket_status's unlocks_tasks) rather than a hardcoded priority key —
-- see stores.js's highlightTasksForPriority and Settings -> Priority
-- tiers' new "Highlight in tasks" column.
--
-- Expedited / SOS is the obvious candidate and the only one flagged on by
-- default; Standard/Low Priority are left off, same opt-in-not-automatic
-- convention as show_status_notes.
UPDATE settings
   SET meta = meta || '{"highlight_in_tasks": true}'::jsonb
 WHERE category = 'priority_tier' AND key = 'expedited_sos';
