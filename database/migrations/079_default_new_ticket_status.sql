-- Shop feedback, Nov 2026 -- "Reservation" is technically the first status
-- (lowest sort_order), so every new ticket started there, but most jobs
-- actually start at Not Started.
--
-- A shop-wide "New tickets start at" setting, edited from Settings -> Shop
-- configuration (meta.value = a ticket_status key). It sits below a
-- category's own meta.default_status_key (e.g. Daily To-Do's -> In Progress)
-- and a shipping ticket's In Progress preference, and above the old "first
-- applicable status" fallback -- see services/settings.js's
-- defaultStatusForCategory(). A status that's retired, missing, or not valid
-- for the ticket's category is ignored and falls through to that fallback.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('shop_config', 'default_ticket_status', 'New tickets start at', 80,
        '{"value": "not_started"}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
