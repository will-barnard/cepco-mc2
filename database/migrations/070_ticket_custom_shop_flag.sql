-- Custom Shop: a per-ticket flag, set side by side with Fast Track (migration
-- 063) on the ticket page and New Ticket form, with its own Queue quick
-- filter (GET /tickets?custom_shop=true). A plain boolean column like
-- fast_track / is_shipping, not a settings enum — and deliberately separate
-- from the "Custom Shop" sub-category under Repairs & Restoration, which
-- stays exactly as it is: the flag can be set on any ticket, whatever its
-- category.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS custom_shop BOOLEAN NOT NULL DEFAULT FALSE;
