-- Consignment payout tracking (NOTES.md §2.103). The Inventory Log only
-- recorded *that* a piece was consigned and at what rate. The shop's
-- Consignment Tracking sheet also tracked where each deal stands
-- (Contracted / For Sale / Paid Out) and its terms in words ("Services +
-- 25% of Sale", "$2k", "3k labor trade") — and without that, a consignment
-- that's sold but not yet paid out looks exactly like a settled one.
--
--   consignment_status  contracted -> for_sale -> payout_due -> paid_out
--                       NULL = not recorded. Only meaningful while
--                       ownership = 'consignment'; routes/inventory.js
--                       clears it when a piece stops being one, and moves
--                       it to payout_due when a consignment is marked sold.
--   consignment_terms   the deal as written; consignment_rate stays the
--                       number when there is one.
ALTER TABLE instruments
  ADD COLUMN consignment_status TEXT
    CHECK (consignment_status IS NULL
           OR consignment_status IN ('contracted', 'for_sale', 'payout_due', 'paid_out')),
  ADD COLUMN consignment_terms TEXT;

CREATE INDEX instruments_consignment_status_idx
  ON instruments (consignment_status) WHERE consignment_status IS NOT NULL;

-- Unsold consignments are, by definition, for sale. Sold ones are left
-- NULL on purpose: nothing in the inventory sheets says whether the
-- consignor was paid, and guessing "payout due" would put years-old sales
-- on an owed-money list. Migration 076 fills in the ones the tracking
-- sheet does answer; the rest show as "Not recorded" until someone sets it.
UPDATE instruments SET consignment_status = 'for_sale'
 WHERE ownership = 'consignment' AND sale_status <> 'sold';
