-- Shop feedback, Oct 2026 — two Queue page changes.
--
-- 1. Fast Track: a per-ticket flag, independent of priority tier. Priority
--    says how urgent a job is; Fast Track says "this one can jump ahead
--    because it's quick" — the two are set side by side on the ticket page
--    and New Ticket form, and the Queue page gets a "Fast Track" quick
--    filter (GET /tickets?fast_track=true). A plain boolean column like
--    is_shipping (migration 028), not a settings enum — there's nothing
--    for an admin to rename or add to.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fast_track BOOLEAN NOT NULL DEFAULT FALSE;

-- No index: the tickets table is a few hundred live rows, and the quick
-- filter is ANDed with archived = FALSE and a family/category anyway.

-- 2. Queue split view: which ticket statuses render in the Queue page's
--    right-hand column instead of the main list, and in what order
--    (meta.value = ordered array of ticket_status keys). Shop-wide, edited
--    from Settings -> Queue split view. A shop_config row rather than a
--    per-status meta flag because the right column has its *own* order,
--    independent of the statuses' workflow sort_order that the left column
--    (and every other status list) follows.
--
--    Starts empty = no split, i.e. the Queue looks exactly as it did
--    before this migration until an admin picks some statuses.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('shop_config', 'queue_split_view', 'Queue split view (right column statuses)', 60,
        '{"value": []}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
