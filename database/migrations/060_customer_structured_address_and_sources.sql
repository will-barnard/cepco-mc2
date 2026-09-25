-- Customer intake feedback (Sep 2026):
--   1. Structured address fields, so an address entered here lands in
--      Xero's own Address fields (line 1/2, city, region, postal code,
--      country) and prints correctly on an invoice -- instead of the whole
--      free-text blob being stuffed into AddressLine1 (the limitation
--      services/xeroSync.js's header used to call out).
--   2. More "Source" values -- Reverb, eBay, Instagram, Facebook -- so a
--      customer's record says where to go looking for past conversations.
--
-- `customers.address` is kept, not dropped, and becomes the flattened
-- one-line display form ("123 Main St, Apt 2, Springfield, IL 62701, US")
-- maintained by the trigger below. Every existing reader (ticket detail's
-- contact popover, the Xero backfill/duplicate review screens, search)
-- keeps working untouched, and the handful of writers that only know
-- about a single free-text address (the Shopify webhook before this
-- change, EstimateNewView's contact step) still work too -- see the
-- trigger's "legacy writer" branch.

ALTER TABLE customers
  ADD COLUMN address_line1 TEXT,
  ADD COLUMN address_line2 TEXT,
  ADD COLUMN city          TEXT,
  ADD COLUMN region        TEXT,   -- state / province
  ADD COLUMN postal_code   TEXT,
  ADD COLUMN country       TEXT;

-- customers_touch (migration 001) would stamp updated_at = now() on every
-- row the two backfill UPDATEs below touch, and the Xero sync reads
-- "updated_at > xero_synced_at" as "edited in MC2 since the last sync" --
-- so leaving it on would make the next sync push every customer with an
-- address to Xero at once, for a change nobody actually made. Off for the
-- backfill only, back on right after.
ALTER TABLE customers DISABLE TRIGGER customers_touch;

-- Existing free-text addresses move into line 1 as-is. Deliberately not
-- parsed into city/state/ZIP: a wrong guess at splitting "Suite 4, Austin
-- TX" is worse than leaving it whole for someone to tidy up on next edit.
UPDATE customers
   SET address_line1 = NULLIF(btrim(address), '')
 WHERE address IS NOT NULL;

-- Keeps `address` in step with the structured columns on every write.
--
-- Legacy writer branch: a write that changes `address` but none of the
-- structured columns is someone who only knows about the single free-text
-- field -- store that text as line 1 (clearing the rest, since it
-- replaces the whole address) rather than silently discarding it by
-- recomputing `address` from the unchanged structured columns.
CREATE OR REPLACE FUNCTION customers_sync_address() RETURNS TRIGGER AS $$
DECLARE
  structured_changed BOOLEAN;
  legacy_changed     BOOLEAN;
BEGIN
  NEW.address_line1 := NULLIF(btrim(NEW.address_line1), '');
  NEW.address_line2 := NULLIF(btrim(NEW.address_line2), '');
  NEW.city          := NULLIF(btrim(NEW.city), '');
  NEW.region        := NULLIF(btrim(NEW.region), '');
  NEW.postal_code   := NULLIF(btrim(NEW.postal_code), '');
  NEW.country       := NULLIF(btrim(NEW.country), '');
  NEW.address       := NULLIF(btrim(NEW.address), '');

  IF TG_OP = 'INSERT' THEN
    structured_changed := num_nonnulls(NEW.address_line1, NEW.address_line2, NEW.city,
                                       NEW.region, NEW.postal_code, NEW.country) > 0;
    legacy_changed := NEW.address IS NOT NULL;
  ELSE
    structured_changed :=
      (NEW.address_line1, NEW.address_line2, NEW.city, NEW.region, NEW.postal_code, NEW.country)
      IS DISTINCT FROM
      (OLD.address_line1, OLD.address_line2, OLD.city, OLD.region, OLD.postal_code, OLD.country);
    legacy_changed := NEW.address IS DISTINCT FROM OLD.address;
  END IF;

  IF legacy_changed AND NOT structured_changed THEN
    NEW.address_line1 := NEW.address;
    NEW.address_line2 := NULL;
    NEW.city          := NULL;
    NEW.region        := NULL;
    NEW.postal_code   := NULL;
    NEW.country       := NULL;
  END IF;

  NEW.address := NULLIF(concat_ws(', ',
    NEW.address_line1,
    NEW.address_line2,
    NEW.city,
    NULLIF(concat_ws(' ', NEW.region, NEW.postal_code), ''),
    NEW.country
  ), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_sync_address
  BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_sync_address();

-- Re-flatten what the backfill above just wrote, so every row is already
-- in the trigger's canonical shape (trims included) before anyone edits it.
UPDATE customers SET address_line1 = address_line1 WHERE address_line1 IS NOT NULL;

ALTER TABLE customers ENABLE TRIGGER customers_touch;

-- Source: keep every existing value ('xero' is set by the sync itself,
-- migration 047) and add the marketplaces/social channels customers
-- actually arrive through.
ALTER TABLE customers DROP CONSTRAINT customers_source_check;
ALTER TABLE customers ADD CONSTRAINT customers_source_check
  CHECK (source IN ('shopify', 'email', 'direct', 'xero',
                    'reverb', 'ebay', 'instagram', 'facebook'));
