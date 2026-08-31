-- P3 (boss-list scope): "Add 'Other' to the vendor dropdown." Vendors live
-- in their own table (vendors) with no Settings screen at all, so a bare
-- "Other" row there would be useless — nobody could say *who*. Instead,
-- "Other" is a picker option that reveals a free-text field, stored here
-- rather than as a real vendors row.
ALTER TABLE parts_orders ADD COLUMN vendor_other TEXT;
