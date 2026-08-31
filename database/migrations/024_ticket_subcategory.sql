-- N2a (boss-list scope): the sub-category mechanism that N3 (SideQuests:
-- Hunt / R&D / Outreach / Other) and "make Custom Shop a sub-category" both
-- need. A sub-category is just another ticket_category settings row whose
-- meta.parent_key names its parent — no migration needed for that half,
-- meta is already JSONB and this is how every other per-row flag (like
-- hide_ship_button) already works; see backend/src/services/settings.js's
-- validateParentKey(). A ticket records which child it
-- landed in using the same key-plus-snapshot convention as every other
-- configurable field on it (category_key/category_label_snapshot, etc.).
ALTER TABLE tickets
  ADD COLUMN subcategory_key TEXT,
  ADD COLUMN subcategory_label_snapshot TEXT,
  -- The "Other" leaf takes typed text instead of picking a settings row —
  -- same idea as the Parts/Supplies "Other" vendor ask
  -- (parts_orders.vendor_other). Kept as its own column rather than
  -- overloading the snapshot: the snapshot means "what the label said at
  -- write time" for an actual settings row, not user-typed free text.
  ADD COLUMN subcategory_other_text TEXT;

CREATE INDEX tickets_subcategory_idx ON tickets (subcategory_key);
