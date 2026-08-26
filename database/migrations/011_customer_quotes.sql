-- Customer-facing quotes ("Estimates" in the UI) — resolves NOTES.md §2.7's
-- flagged tension. PLAN §5 wants confirming an estimate to auto-generate
-- its ticket(s); 001_init.sql's `estimates` table requires a ticket_id up
-- front, which only ever fit the *other* thing that table does (a tech's
-- post-intake hours/parts estimate logged against a ticket that already
-- exists, feeding actual-vs-estimate reporting in routes/estimates.js
-- '/reference'). Both are legitimately "an estimate" in the shop's own
-- vocabulary, so rather than a same-meaning, differently-named `quotes`
-- table, `estimates` grows a `kind` column and the columns the new kind
-- needs, and stays one table with two shapes of row:
--   - kind='ticket_estimate' (the default — every existing row, and every
--     row routes/estimates.js writes): ticket_id is always set, exactly
--     the Phase 1 behavior, completely unchanged.
--   - kind='customer_quote' (written only by routes/quotes.js): ticket_id
--     stays NULL forever, even after conversion — a quote can produce
--     more than one ticket (one per instrument; see estimate_items below),
--     so a single ticket_id column couldn't represent that anyway. The
--     resulting ticket(s) link back via the new tickets.source_estimate_id
--     instead.
ALTER TABLE estimates
  ALTER COLUMN ticket_id DROP NOT NULL,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket_estimate'
      CHECK (kind IN ('ticket_estimate', 'customer_quote')),
  ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN title TEXT,
  ADD COLUMN category_key TEXT,
  ADD COLUMN priority_key TEXT,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'sent', 'confirmed', 'declined', 'ticket_created')),
  ADD COLUMN confirm_token TEXT UNIQUE,
  ADD COLUMN sent_at TIMESTAMPTZ,
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN declined_at TIMESTAMPTZ;

CREATE INDEX estimates_kind_idx ON estimates (kind);
CREATE INDEX estimates_customer_idx ON estimates (customer_id) WHERE customer_id IS NOT NULL;

-- Line items for a customer_quote: one row per (instrument, procedure) pair
-- selected while building it. Everything about the procedure — and the
-- instrument's own label — is snapshotted at add-time, same reasoning as
-- qc_checks snapshotting qc_templates.items (migration 001): a later
-- rename or re-price of a standard procedure must never rewrite a quote
-- that's already gone out to a customer.
CREATE TABLE estimate_items (
    id                SERIAL PRIMARY KEY,
    estimate_id       INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    instrument_id     INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    instrument_family TEXT,
    instrument_model  TEXT,
    procedure_id      INTEGER REFERENCES standard_procedures(id) ON DELETE SET NULL,
    procedure_name    TEXT NOT NULL,
    pricing_type      TEXT NOT NULL CHECK (pricing_type IN ('hours', 'flat')),
    min_hours         NUMERIC(6,2),
    max_hours         NUMERIC(6,2),
    flat_cost         NUMERIC(10,2),
    sort_order        INTEGER NOT NULL DEFAULT 0,
    -- Set once this item's instrument gets its ticket (migration 011's
    -- one-ticket-per-instrument rule) — several items can end up pointing
    -- at the same ticket_id when they share an instrument.
    ticket_id         INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX estimate_items_estimate_idx ON estimate_items (estimate_id);

-- The reverse link for a customer_quote's ticket(s) — same shape as
-- tickets.source_ticket_id (migration 008), just pointing at the estimate
-- it was generated from instead of another ticket.
ALTER TABLE tickets
  ADD COLUMN source_estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL;
CREATE INDEX tickets_source_estimate_idx ON tickets (source_estimate_id)
  WHERE source_estimate_id IS NOT NULL;
