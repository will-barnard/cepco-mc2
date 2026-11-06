-- ===========================================================================
-- Ownership history, and a sale moves the piece to its buyer
-- (NOTES.md §2.107).
--
-- An instrument is one row for its whole life: a customer's piano we
-- service, that the shop buys, restores, sells to someone else, who brings
-- it back for service. Until now only the *current* state lived on the row,
-- and a sale didn't change the owner at all -- a sold piece stayed
-- "shop-owned, sold" forever, so when the buyer brought it in for service
-- it wasn't among their instruments and got entered again.
--
-- 1. instrument_ownership: one row per period of ownership.
--      kind          customer | shop | consignment  (same as instruments.ownership)
--      customer_id   the owner (customer) or consignor (consignment); NULL
--                    for shop stock, or when the owner has no customer
--                    record -- owner_name then says who (sheet buyer names)
--      started_on / ended_on, start_reason / end_reason -- how it changed:
--        on_file               already on file when this migration ran
--        added                 created in the app
--        purchase              the shop bought it (purchase_id says from whom)
--        sale                  the shop sold it (the closing shop/consignment
--                              period carries the sale: price, buyer, and for
--                              a consignment the deal terms + payout status)
--        consignment           an owner consigned it to the shop
--        consignment_returned  a consignment went back to its owner unsold
--        changed               any other owner change
--    end_reason NULL = the current period; exactly one per instrument.
--
-- 2. Kept in step by triggers, so no write path can skip it:
--      instrument_ownership_track   on insert / owner change of an
--                                   instrument, closes the current period
--                                   and opens the next. The app says *why*
--                                   with set_config('mc2.ownership_reason')
--                                   in the same transaction; filling in a
--                                   missing owner (linking the customer
--                                   record) or clearing one (customer
--                                   deleted) updates the period in place.
--      instrument_ownership_check   DEFERRED to commit: every instrument has
--                                   exactly one current period, and its kind
--                                   and customer match the row. A write that
--                                   would break that rolls back.
--    Code that writes the ledger itself (a sale, undoing one) sets
--    mc2.ownership_manual = 'on' for the transaction; the deferred check
--    still applies.
--
-- 3. instrument_record_sale(): the one way a sale happens -- the backfill
--    below, the API's "Mark sold", and the inventory importer all call it.
--    The shop/consignment period closes with the sale on it, the buyer's
--    period opens, and the row becomes the buyer's instrument (ownership
--    customer, customer_id = buyer). A buyer with no customer record still
--    gets the piece, by name; linking the record later fills it in.
--    instrument_undo_sale() reverses the most recent sale while the buyer's
--    period is still the current one.
--
-- 4. Backfill: every instrument gets its current period; every sold piece
--    gets its shop/consignment period (closed by the sale, with the sale on
--    it) and its buyer's period, and becomes the buyer's. The row's own
--    sold_* columns are left as they were, untouched (frozen: the ledger is
--    where sales live from here on). The consignment fields of a sold
--    consignment move onto its sale period. Checks at the end abort the
--    migration if any sale, owner, or untouched row doesn't match what was
--    there before.
--
-- Also: instrument_purchases.seller_customer_id, for when the shop buys
-- from someone who is already a customer.
-- ===========================================================================

ALTER TABLE instrument_purchases
  ADD COLUMN seller_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

CREATE TABLE instrument_ownership (
    id                  SERIAL PRIMARY KEY,
    instrument_id       INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    kind                TEXT NOT NULL CHECK (kind IN ('customer', 'shop', 'consignment')),
    customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    owner_name          TEXT,
    started_on          DATE,           -- NULL = not known (on file before this)
    ended_on            DATE,
    start_reason        TEXT NOT NULL,
    end_reason          TEXT,           -- NULL = current
    purchase_id         INTEGER REFERENCES instrument_purchases(id) ON DELETE SET NULL,
    -- the sale, on the shop/consignment period it ended
    sale_price          NUMERIC(10,2),
    sold_to_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    sold_to_name        TEXT,
    -- a consignment's deal as it stood at the sale, and the payout after it
    consignment_rate    NUMERIC(5,2),
    consignment_terms   TEXT,
    payout_status       TEXT CHECK (payout_status IS NULL
                          OR payout_status IN ('contracted', 'for_sale', 'payout_due', 'paid_out')),
    created_by          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT instrument_ownership_reasons CHECK (
      start_reason IN ('on_file', 'added', 'purchase', 'sale', 'consignment', 'consignment_returned', 'changed')
      AND (end_reason IS NULL
           OR end_reason IN ('purchase', 'sale', 'consignment', 'consignment_returned', 'changed'))),
    CONSTRAINT instrument_ownership_open_has_no_end CHECK (end_reason IS NOT NULL OR ended_on IS NULL)
);
CREATE UNIQUE INDEX instrument_ownership_current_idx ON instrument_ownership (instrument_id) WHERE end_reason IS NULL;
CREATE INDEX instrument_ownership_instrument_idx ON instrument_ownership (instrument_id, id);
CREATE INDEX instrument_ownership_customer_idx ON instrument_ownership (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX instrument_ownership_sales_idx ON instrument_ownership (ended_on DESC) WHERE end_reason = 'sale';

-- ---------------------------------------------------------------------------
-- Backfill (before the triggers exist, so it writes the ledger directly).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _before ON COMMIT DROP AS SELECT * FROM instruments;

-- Every instrument's own period. For a sold piece this is the shop /
-- consignment period, closed by its sale.
WITH lp AS (
  SELECT DISTINCT ON (instrument_id) *
    FROM instrument_purchases
   ORDER BY instrument_id, purchase_date DESC, id DESC
)
INSERT INTO instrument_ownership
  (instrument_id, kind, customer_id, owner_name, started_on, start_reason, purchase_id,
   ended_on, end_reason, sale_price, sold_to_customer_id, sold_to_name,
   consignment_rate, consignment_terms, payout_status)
SELECT i.id, i.ownership, i.customer_id,
       CASE WHEN i.ownership = 'consignment' THEN i.consignor_name END,
       CASE WHEN i.ownership = 'shop' THEN lp.purchase_date END,
       CASE WHEN i.ownership = 'shop' AND lp.id IS NOT NULL THEN 'purchase' ELSE 'on_file' END,
       CASE WHEN i.ownership = 'shop' THEN lp.id END,
       s.sold_at,
       CASE WHEN s.sold THEN 'sale' END,
       s.sold_price, s.sold_to_customer_id, s.sold_to_name,
       CASE WHEN s.sold AND i.ownership = 'consignment' THEN i.consignment_rate END,
       CASE WHEN s.sold AND i.ownership = 'consignment' THEN i.consignment_terms END,
       CASE WHEN s.sold AND i.ownership = 'consignment' THEN i.consignment_status END
  FROM instruments i
  LEFT JOIN lp ON lp.instrument_id = i.id
  CROSS JOIN LATERAL (
    SELECT (i.ownership <> 'customer' AND i.sale_status = 'sold') AS sold,
           CASE WHEN i.sale_status = 'sold' THEN i.sold_at END AS sold_at,
           CASE WHEN i.sale_status = 'sold' THEN i.sold_price END AS sold_price,
           CASE WHEN i.sale_status = 'sold' THEN i.sold_to_customer_id END AS sold_to_customer_id,
           CASE WHEN i.sale_status = 'sold' THEN i.sold_to_name END AS sold_to_name
  ) s
 ORDER BY i.id;

-- The buyer's period for every sold piece (inserted after, so id order is
-- chronological per instrument).
INSERT INTO instrument_ownership (instrument_id, kind, customer_id, owner_name, started_on, start_reason)
SELECT i.id, 'customer', i.sold_to_customer_id,
       CASE WHEN i.sold_to_customer_id IS NULL THEN i.sold_to_name END,
       i.sold_at, 'sale'
  FROM instruments i
 WHERE i.ownership <> 'customer' AND i.sale_status = 'sold'
 ORDER BY i.id;

-- ...and the piece becomes the buyer's. The consignment fields now live on
-- the sale period; sold_* stay on the row untouched.
UPDATE instruments
   SET ownership = 'customer',
       customer_id = sold_to_customer_id,
       sale_status = NULL,
       consignment_status = NULL, consignment_rate = NULL,
       consignment_terms = NULL, consignor_name = NULL
 WHERE ownership <> 'customer' AND sale_status = 'sold';

-- ---------------------------------------------------------------------------
-- The triggers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION instrument_ownership_track() RETURNS trigger AS $$
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
  -- from) a customer record: a correction to this period, not a new owner.
  IF NEW.ownership = OLD.ownership AND (OLD.customer_id IS NULL OR NEW.customer_id IS NULL) THEN
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

CREATE TRIGGER instrument_ownership_track
  AFTER INSERT OR UPDATE OF ownership, customer_id ON instruments
  FOR EACH ROW EXECUTE FUNCTION instrument_ownership_track();

CREATE FUNCTION instrument_ownership_verify(p_instrument_id INTEGER) RETURNS VOID AS $$
DECLARE
  inst RECORD;
  n INTEGER;
  cur RECORD;
BEGIN
  SELECT id, ownership, customer_id INTO inst FROM instruments WHERE id = p_instrument_id;
  IF NOT FOUND THEN RETURN; END IF; -- deleted; its periods cascade away
  SELECT count(*) INTO n FROM instrument_ownership WHERE instrument_id = p_instrument_id AND end_reason IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'instrument %: % current ownership periods (expected exactly 1)', p_instrument_id, n;
  END IF;
  SELECT kind, customer_id INTO cur FROM instrument_ownership
   WHERE instrument_id = p_instrument_id AND end_reason IS NULL;
  IF cur.kind <> inst.ownership OR cur.customer_id IS DISTINCT FROM inst.customer_id THEN
    RAISE EXCEPTION 'instrument %: current ownership period (%, customer %) does not match the instrument (%, customer %)',
      p_instrument_id, cur.kind, cur.customer_id, inst.ownership, inst.customer_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION instrument_ownership_check() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'instruments' THEN
    PERFORM instrument_ownership_verify(NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM instrument_ownership_verify(OLD.instrument_id);
  ELSE
    PERFORM instrument_ownership_verify(NEW.instrument_id);
    IF TG_OP = 'UPDATE' AND OLD.instrument_id <> NEW.instrument_id THEN
      PERFORM instrument_ownership_verify(OLD.instrument_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER instrument_ownership_check
  AFTER INSERT OR UPDATE OF ownership, customer_id ON instruments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION instrument_ownership_check();
CREATE CONSTRAINT TRIGGER instrument_ownership_check
  AFTER INSERT OR UPDATE OR DELETE ON instrument_ownership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION instrument_ownership_check();

-- ---------------------------------------------------------------------------
-- A sale. Returns the closed (sale) period's id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION instrument_record_sale(
  p_instrument_id INTEGER, p_sold_on DATE, p_price NUMERIC,
  p_buyer_id INTEGER, p_buyer_name TEXT, p_employee_id INTEGER
) RETURNS INTEGER AS $$
DECLARE
  inst instruments%ROWTYPE;
  sale_id INTEGER;
  buyer_name TEXT := NULLIF(btrim(coalesce(p_buyer_name, '')), '');
BEGIN
  SELECT * INTO inst FROM instruments WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'instrument % not found', p_instrument_id; END IF;
  IF inst.ownership = 'customer' THEN
    RAISE EXCEPTION 'instrument % belongs to a customer -- only shop stock or a consignment can be sold', p_instrument_id;
  END IF;

  PERFORM set_config('mc2.ownership_manual', 'on', true);

  UPDATE instrument_ownership
     SET ended_on = p_sold_on, end_reason = 'sale',
         sale_price = p_price, sold_to_customer_id = p_buyer_id, sold_to_name = buyer_name,
         consignment_rate  = CASE WHEN inst.ownership = 'consignment' THEN inst.consignment_rate END,
         consignment_terms = CASE WHEN inst.ownership = 'consignment' THEN inst.consignment_terms END,
         payout_status     = CASE WHEN inst.ownership = 'consignment'
                                  THEN CASE WHEN inst.consignment_status = 'paid_out' THEN 'paid_out' ELSE 'payout_due' END END
   WHERE instrument_id = p_instrument_id AND end_reason IS NULL
   RETURNING id INTO sale_id;

  INSERT INTO instrument_ownership (instrument_id, kind, customer_id, owner_name, started_on, start_reason, created_by)
  VALUES (p_instrument_id, 'customer', p_buyer_id, CASE WHEN p_buyer_id IS NULL THEN buyer_name END,
          p_sold_on, 'sale', p_employee_id);

  UPDATE instruments
     SET ownership = 'customer', customer_id = p_buyer_id, sale_status = NULL,
         consignment_status = NULL, consignment_rate = NULL, consignment_terms = NULL, consignor_name = NULL,
         on_website = FALSE
   WHERE id = p_instrument_id;

  PERFORM set_config('mc2.ownership_manual', 'off', true);
  RETURN sale_id;
END;
$$ LANGUAGE plpgsql;

-- Back to the way it was before the most recent sale: allowed only while
-- the buyer's period (opened by that sale) is still the current one. The
-- piece returns as available stock / an active consignment.
CREATE FUNCTION instrument_undo_sale(p_instrument_id INTEGER) RETURNS VOID AS $$
DECLARE
  cur instrument_ownership%ROWTYPE;
  prev instrument_ownership%ROWTYPE;
BEGIN
  PERFORM 1 FROM instruments WHERE id = p_instrument_id FOR UPDATE;
  SELECT * INTO cur FROM instrument_ownership WHERE instrument_id = p_instrument_id AND end_reason IS NULL;
  IF cur.id IS NULL OR cur.start_reason <> 'sale' THEN
    RAISE EXCEPTION 'instrument %: the current owner did not come from a sale -- nothing to undo', p_instrument_id;
  END IF;
  SELECT * INTO prev FROM instrument_ownership
   WHERE instrument_id = p_instrument_id AND id < cur.id ORDER BY id DESC LIMIT 1;
  IF prev.id IS NULL OR prev.end_reason <> 'sale' THEN
    RAISE EXCEPTION 'instrument %: no sale period to reopen', p_instrument_id;
  END IF;

  PERFORM set_config('mc2.ownership_manual', 'on', true);
  DELETE FROM instrument_ownership WHERE id = cur.id;
  UPDATE instrument_ownership
     SET ended_on = NULL, end_reason = NULL, sale_price = NULL, sold_to_customer_id = NULL, sold_to_name = NULL,
         payout_status = NULL
   WHERE id = prev.id;
  UPDATE instruments
     SET ownership = prev.kind, customer_id = prev.customer_id, sale_status = 'available',
         consignment_rate   = CASE WHEN prev.kind = 'consignment' THEN prev.consignment_rate END,
         consignment_terms  = CASE WHEN prev.kind = 'consignment' THEN prev.consignment_terms END,
         consignment_status = CASE WHEN prev.kind = 'consignment' THEN 'for_sale' END,
         consignor_name     = CASE WHEN prev.kind = 'consignment' THEN prev.owner_name END
   WHERE id = p_instrument_id;
  -- the reopened period no longer needs the deal snapshot: it's back on the row
  UPDATE instrument_ownership SET consignment_rate = NULL, consignment_terms = NULL WHERE id = prev.id;
  PERFORM set_config('mc2.ownership_manual', 'off', true);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Checks. Anything off rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad INTEGER;
  r RECORD;
  n_sold INTEGER;
BEGIN
  -- Every instrument: exactly one current period matching the row.
  FOR r IN SELECT id FROM instruments LOOP
    PERFORM instrument_ownership_verify(r.id);
  END LOOP;

  -- Every sale that was on a row is on a sale period, exactly as it was.
  SELECT count(*) INTO n_sold FROM _before WHERE ownership <> 'customer' AND sale_status = 'sold';
  SELECT count(*) INTO bad
    FROM _before b
   WHERE b.ownership <> 'customer' AND b.sale_status = 'sold'
     AND NOT EXISTS (
       SELECT 1 FROM instrument_ownership s
        WHERE s.instrument_id = b.id AND s.end_reason = 'sale'
          AND s.kind = b.ownership
          AND s.customer_id IS NOT DISTINCT FROM b.customer_id
          AND s.ended_on IS NOT DISTINCT FROM b.sold_at
          AND s.sale_price IS NOT DISTINCT FROM b.sold_price
          AND s.sold_to_customer_id IS NOT DISTINCT FROM b.sold_to_customer_id
          AND s.sold_to_name IS NOT DISTINCT FROM b.sold_to_name
          AND (b.ownership <> 'consignment' OR (
                s.owner_name IS NOT DISTINCT FROM b.consignor_name
            AND s.consignment_rate IS NOT DISTINCT FROM b.consignment_rate
            AND s.consignment_terms IS NOT DISTINCT FROM b.consignment_terms
            AND s.payout_status IS NOT DISTINCT FROM b.consignment_status)));
  IF bad > 0 THEN RAISE EXCEPTION '087: % sale(s) did not carry over exactly -- aborting', bad; END IF;

  -- Sold pieces belong to their buyer now; nothing else on them changed
  -- (updated_at is the touch trigger's).
  SELECT count(*) INTO bad
    FROM _before b JOIN instruments i ON i.id = b.id
   WHERE b.ownership <> 'customer' AND b.sale_status = 'sold'
     AND (i.ownership <> 'customer' OR i.customer_id IS DISTINCT FROM b.sold_to_customer_id
          OR (to_jsonb(i) - ARRAY['ownership', 'customer_id', 'sale_status', 'consignment_status',
                                  'consignment_rate', 'consignment_terms', 'consignor_name', 'updated_at'])
             IS DISTINCT FROM
             (to_jsonb(b) - ARRAY['ownership', 'customer_id', 'sale_status', 'consignment_status',
                                  'consignment_rate', 'consignment_terms', 'consignor_name', 'updated_at']));
  IF bad > 0 THEN RAISE EXCEPTION '087: % sold piece(s) changed beyond their owner -- aborting', bad; END IF;

  -- Every other instrument is exactly as it was.
  SELECT count(*) INTO bad
    FROM _before b JOIN instruments i ON i.id = b.id
   WHERE NOT (b.ownership <> 'customer' AND b.sale_status = 'sold')
     AND to_jsonb(i) IS DISTINCT FROM to_jsonb(b);
  IF bad > 0 THEN RAISE EXCEPTION '087: % unsold instrument(s) changed -- aborting', bad; END IF;

  SELECT count(*) INTO bad FROM instrument_ownership;
  IF bad <> (SELECT count(*) FROM _before) + n_sold THEN
    RAISE EXCEPTION '087: expected % ownership periods, made %', (SELECT count(*) FROM _before) + n_sold, bad;
  END IF;

  RAISE NOTICE '087: % instrument(s) on file; % sold piece(s) moved to their buyer (% with a customer record)',
    (SELECT count(*) FROM _before), n_sold,
    (SELECT count(*) FROM _before WHERE ownership <> 'customer' AND sale_status = 'sold' AND sold_to_customer_id IS NOT NULL);
END $$;
