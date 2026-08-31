-- C1 (boss-list scope): "Award categories on a nomination." A nomination
-- gets a category (Technical Ceppy, Primetime Ceppy, or a manually typed
-- one) alongside its existing title/reason. category_key + a label
-- snapshot follow the same key-plus-snapshot convention every other
-- admin-configurable field in this app uses (see tickets.category_key);
-- category_other is the free-text escape hatch for a one-off award the
-- shop hasn't added to Settings yet, same mutually-exclusive
-- key-or-free-text shape as parts_orders.vendor_other (P3).
--
-- Note for whoever reads the boss-list scope doc alongside this: it says
-- the table "kept its original spelling through the Ceppie -> Ceppy
-- rename." That's not what actually happened — migration 019 renamed the
-- table itself to ceppy_nominations. This migration targets the real,
-- current name.
ALTER TABLE ceppy_nominations
  ADD COLUMN category_key TEXT,
  ADD COLUMN category_label_snapshot TEXT,
  ADD COLUMN category_other TEXT;
