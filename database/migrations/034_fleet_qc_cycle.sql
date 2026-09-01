-- A3 (boss-list scope): fleet QC on a real per-instrument cycle (3/6/12
-- month intervals) instead of instruments.fleet_last_qc, which is
-- unusable for driving anything automatic — it's shop shorthand free text
-- ('Pre 2025', 'Upcoming', 'Never'), not a date. fleet_last_qc itself is
-- left completely alone: still shown on FleetView.vue exactly as before,
-- for every existing fleet instrument, until the shop does the one-time
-- data-entry pass that fills in real values below (an admin job, not
-- something to script — none of the existing free-text values carry a
-- computable date to convert). Until that pass sets both columns for a
-- given instrument, the sweep below simply skips it.
ALTER TABLE instruments ADD COLUMN last_qc_at DATE;
ALTER TABLE instruments ADD COLUMN qc_interval_months INTEGER
  CHECK (qc_interval_months IS NULL OR qc_interval_months IN (3, 6, 12));

-- Scheduler state for services/recurringTickets.js's daily fleet-QC sweep —
-- same "config row in shop_config, meta.last_run_at compared by shop-local
-- date" idiom as ceppys_schedule (services/ceppyScheduler.js), so a missed
-- tick still recovers on the next check instead of silently skipping a day.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('shop_config', 'fleet_qc_sweep', 'Fleet QC overdue sweep', 40, '{}'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
