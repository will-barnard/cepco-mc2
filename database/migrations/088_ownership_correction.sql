-- Ownership history (087): a 'correction' corrects the current period.
--
-- The routes say mc2.ownership_reason = 'correction' when an owner is being
-- fixed rather than changed -- a different consignor on the same
-- consignment, an instrument moved to the right customer from its edit
-- form, a sale's buyer linked afterwards. 087's trigger only corrected in
-- place when the owner was being linked or unlinked; with two different
-- customers it closed the period as if the instrument had changed hands,
-- and the reason 'correction' isn't a valid end reason, so the save failed.
-- Same function, one more case in that branch.

CREATE OR REPLACE FUNCTION instrument_ownership_track() RETURNS trigger AS $$
DECLARE
  reason TEXT := NULLIF(current_setting('mc2.ownership_reason', true), '');
  emp INTEGER := NULLIF(current_setting('mc2.employee_id', true), '')::integer;
BEGIN
  IF current_setting('mc2.ownership_manual', true) = 'on' THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO instrument_ownership (instrument_id, kind, customer_id, owner_name, started_on, start_reason, created_by)
    VALUES (NEW.id, NEW.ownership, NEW.customer_id,
            CASE WHEN NEW.ownership = 'consignment' THEN NEW.consignor_name END,
            CURRENT_DATE, COALESCE(reason, 'added'), emp);
    RETURN NULL;
  END IF;

  IF NEW.ownership = OLD.ownership AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN
    RETURN NULL;
  END IF;
  -- Same kind of ownership, and the owner was just linked to (or unlinked
  -- from) a customer record, or the app says it's fixing a wrong owner
  -- (reason 'correction'): this period is corrected, not a new owner.
  IF NEW.ownership = OLD.ownership
     AND (OLD.customer_id IS NULL OR NEW.customer_id IS NULL OR reason = 'correction') THEN
    UPDATE instrument_ownership SET customer_id = NEW.customer_id
     WHERE instrument_id = NEW.id AND end_reason IS NULL;
    RETURN NULL;
  END IF;

  UPDATE instrument_ownership
     SET ended_on = CURRENT_DATE, end_reason = COALESCE(reason, 'changed')
   WHERE instrument_id = NEW.id AND end_reason IS NULL;
  INSERT INTO instrument_ownership (instrument_id, kind, customer_id, owner_name, started_on, start_reason, created_by)
  VALUES (NEW.id, NEW.ownership, NEW.customer_id,
          CASE WHEN NEW.ownership = 'consignment' THEN NEW.consignor_name END,
          CURRENT_DATE, COALESCE(reason, 'changed'), emp);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
