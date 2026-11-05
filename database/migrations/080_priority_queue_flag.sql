-- Queue page priority flag (shop feedback, Nov 2026): a priority tier can be
-- flagged to show a tag beside the ticket title on the Queue -- the same
-- kind of tag Lite (formerly "Fast Track") gets -- so high-priority jobs
-- stand out without having to read the new lightning-bolt priority column.
--
-- Same meta-on-the-settings-row mechanism as highlight_in_tasks (migration
-- 042): admin-togglable from Settings -> Priority tiers' new "Queue flag"
-- column, read by stores.js's priorityFlagged. Expedited / SOS starts
-- flagged; the rest are opt-in.
UPDATE settings
   SET meta = meta || '{"queue_flag": true}'::jsonb
 WHERE category = 'priority_tier' AND key = 'expedited_sos'
   AND NOT (meta ? 'queue_flag');
