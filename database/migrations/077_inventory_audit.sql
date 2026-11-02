-- Inventory audit (NOTES.md §2.104). The Inventory Log import plus the
-- consignment fixes (072/075/076) changed a lot of data at once; the shop
-- is checking every piece by hand. Each instrument and each parts &
-- accessories row gets an "audited" mark — who and when, NULL = not yet.
-- Everything starts unaudited.
ALTER TABLE instruments
  ADD COLUMN audited_at TIMESTAMPTZ,
  ADD COLUMN audited_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE inventory_parts
  ADD COLUMN audited_at TIMESTAMPTZ,
  ADD COLUMN audited_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;

-- Whether the audit is running. While active, the Inventory page shows the
-- checkboxes and flags unaudited rows; Settings -> Inventory audit ends it
-- (meta.active = false), which hides all of that again. The marks
-- themselves are kept either way.
INSERT INTO settings (category, key, label, sort_order, meta)
VALUES ('shop_config', 'inventory_audit', 'Inventory audit', 70,
        jsonb_build_object('active', true, 'started_at', now()))
ON CONFLICT (category, key) DO NOTHING;
