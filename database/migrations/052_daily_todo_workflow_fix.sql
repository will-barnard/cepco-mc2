-- Fix: 051_daily_todo_workflow.sql's meta update for 'daily_todo' silently
-- no-ops on a fresh database.
--
-- migrate.js runs every *.sql file in database/migrations/ before seed.js
-- ever runs (index.js's start(): `await migrate(); await seed();`), and
-- 'daily_todo' -- unlike 'housekeeping' (INSERTed by migration 029) --
-- has never been created by a migration; it only ever exists once
-- seed.js's own idempotent SETTINGS array inserts it, which happens
-- *after* every migration has already run. So 051's
--   UPDATE settings SET meta = meta || '{...}'::jsonb
--    WHERE category = 'ticket_category' AND key = 'daily_todo';
-- matches zero rows the first time it runs against a database that
-- doesn't already have a 'daily_todo' row from an earlier deploy --
-- confirmed by running migrate+seed fresh and finding daily_todo's meta
-- still `{}` afterward. On a long-running install (this shop's actual
-- production database) the row already existed from the original seed
-- months ago, so 051's UPDATE should have taken effect there -- but since
-- there's no way to confirm that from outside the running database, and
-- the fix is cheap and idempotent either way, this makes the same change
-- self-healing regardless of whether the row already exists: an UPSERT
-- instead of a bare UPDATE, so it's correct both on this production
-- database (whatever state 051 actually left it in) and on any future
-- fresh install/staging copy.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES (
  'ticket_category', 'daily_todo', 'Daily To-Do''s', 10,
  '{"auto_task_from_title": true, "default_status_key": "in_progress"}'::jsonb
)
ON CONFLICT (category, key) DO UPDATE
  SET meta = settings.meta || '{"auto_task_from_title": true, "default_status_key": "in_progress"}'::jsonb;
