-- ===========================================================================
-- Chicago Electric Piano — Mission Control v2
-- Phase 1 schema
--
-- Configurable-enum strategy (PLAN §8):
--   Tickets store the *stable key* of a settings row (e.g. 'in_progress'),
--   never its numeric id, plus a label snapshot taken at write time.
--     - Renaming a setting changes only its label -> renames propagate,
--       because live rows resolve label through settings at read time.
--     - Deleting/renumbering a settings row cannot orphan a ticket, because
--       the key is carried on the row itself. Deletion of an in-use key is
--       blocked in the API and the key stays readable regardless.
--     - The snapshot column preserves what the label *said* at the time, for
--       audit, without coupling the live display to it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- settings — backs every admin-configurable enum (§8)
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
    id          SERIAL PRIMARY KEY,
    category    TEXT NOT NULL,      -- ticket_status | priority_tier | qc_tier
                                    -- | tech_level | ticket_category
    key         TEXT NOT NULL,      -- stable slug, never changes
    label       TEXT NOT NULL,      -- display name, admin-editable
    sort_order  INTEGER NOT NULL DEFAULT 0,
    meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
    retired     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (category, key)
);
CREATE INDEX settings_category_idx ON settings (category, sort_order);

-- ---------------------------------------------------------------------------
-- employees — internal staff accounts
-- ---------------------------------------------------------------------------
CREATE TABLE employees (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('admin', 'senior', 'junior')),
    initials       TEXT,            -- 'MB', 'KB', 'KM' etc. from the sheets
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX employees_email_idx ON employees (lower(email));

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT,
    phone           TEXT,
    address         TEXT,
    source          TEXT NOT NULL DEFAULT 'direct'
                    CHECK (source IN ('shopify', 'email', 'direct')),
    notes           TEXT,
    -- Portal login (Phase 3). Present now so the sign-up flow has somewhere
    -- to land without a migration; null for every customer in Phase 1.
    portal_email    TEXT UNIQUE,
    portal_password_hash TEXT,
    portal_invited_at    TIMESTAMPTZ,
    portal_activated_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_idx ON customers (lower(name));

-- ---------------------------------------------------------------------------
-- instruments
--   customer_id NULL => CEPCo-owned showroom / rental fleet (§4 category 4)
-- ---------------------------------------------------------------------------
CREATE TABLE instruments (
    id            SERIAL PRIMARY KEY,
    family        TEXT NOT NULL,   -- rhodes | wurlitzer | hohner | strings
                                   -- | organ | amp | rarity
    model         TEXT,
    year          TEXT,            -- free text: sheets contain '1972', '2023?', ''
    serial_no     TEXT,
    identifying_notes TEXT,
    customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    is_fleet      BOOLEAN NOT NULL DEFAULT FALSE,
    fleet_last_qc TEXT,            -- SHOWROOM QC 'Last QC' column, free text
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instruments_customer_idx ON instruments (customer_id);
CREATE INDEX instruments_family_idx ON instruments (family);

-- ---------------------------------------------------------------------------
-- tickets — the spine of the system
-- ---------------------------------------------------------------------------
CREATE TABLE tickets (
    id                  SERIAL PRIMARY KEY,
    title               TEXT NOT NULL,

    -- configurable values, stored as stable keys (see header note)
    category_key        TEXT NOT NULL,
    category_label_snapshot TEXT,
    priority_key        TEXT NOT NULL,
    priority_label_snapshot TEXT,
    status_key          TEXT NOT NULL,
    status_label_snapshot   TEXT,
    tech_level_key      TEXT,
    tech_level_label_snapshot TEXT,

    instrument_id       INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    assigned_tech_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    shop_contact_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    -- The sheets record shop contacts as free-text initials ('MB', 'KB',
    -- 'KEEGZ'). Imported rows keep the raw string here until an admin maps
    -- them onto real employee records.
    shop_contact_raw    TEXT,

    notes               TEXT,
    drop_off_date       DATE,
    due_date            DATE,
    multi_instrument    BOOLEAN NOT NULL DEFAULT FALSE,

    -- vendor sub-tracks, from the CSV columns (Shipping/Painting/Key Tops/...)
    vendor_tracks       JSONB NOT NULL DEFAULT '{}'::jsonb,

    shopify_order_id    TEXT,
    source_sheet        TEXT,       -- provenance for CSV-imported rows
    legacy_ref          TEXT,       -- JOB QUEUE 'Assign #' where present

    qc_required         BOOLEAN NOT NULL DEFAULT TRUE,
    qc_passed_at        TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,
    archived            BOOLEAN NOT NULL DEFAULT FALSE,

    created_by          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tickets_status_idx      ON tickets (status_key);
CREATE INDEX tickets_category_idx    ON tickets (category_key);
CREATE INDEX tickets_priority_idx    ON tickets (priority_key);
CREATE INDEX tickets_customer_idx    ON tickets (customer_id);
CREATE INDEX tickets_instrument_idx  ON tickets (instrument_id);
CREATE INDEX tickets_assigned_idx    ON tickets (assigned_tech_id);
CREATE INDEX tickets_archived_idx    ON tickets (archived);

-- ---------------------------------------------------------------------------
-- status_change_log — audit trail for the rule-less status field (§8)
-- ---------------------------------------------------------------------------
CREATE TABLE status_change_log (
    id           SERIAL PRIMARY KEY,
    ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    old_status   TEXT,
    new_status   TEXT NOT NULL,
    old_label    TEXT,
    new_label    TEXT,
    changed_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    note         TEXT,
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX status_change_log_ticket_idx ON status_change_log (ticket_id, changed_at DESC);

-- ---------------------------------------------------------------------------
-- estimates
-- ---------------------------------------------------------------------------
CREATE TABLE estimates (
    id                   SERIAL PRIMARY KEY,
    ticket_id            INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    parts_cost           NUMERIC(10,2) NOT NULL DEFAULT 0,
    estimated_hours      NUMERIC(6,2) NOT NULL DEFAULT 0,
    additional_hours     NUMERIC(6,2) NOT NULL DEFAULT 0,
    additional_hours_note TEXT,
    labor_rate           NUMERIC(10,2) NOT NULL DEFAULT 175.00,
    confidence           TEXT NOT NULL DEFAULT 'med'
                         CHECK (confidence IN ('high', 'med', 'low')),
    notes                TEXT,
    approved_at          TIMESTAMPTZ,
    approved_by          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_by           INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX estimates_ticket_idx ON estimates (ticket_id);

-- ---------------------------------------------------------------------------
-- hours_log
-- ---------------------------------------------------------------------------
CREATE TABLE hours_log (
    id               SERIAL PRIMARY KEY,
    ticket_id        INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    hours            NUMERIC(6,2) NOT NULL CHECK (hours > 0),
    task_description TEXT,
    worked_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    logged_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hours_log_ticket_idx   ON hours_log (ticket_id);
CREATE INDEX hours_log_employee_idx ON hours_log (employee_id, worked_on);

-- ---------------------------------------------------------------------------
-- QC checklist templates + checks
--   Templates are admin-editable (§6/§8); items live in JSONB so a template
--   edit is one row write and existing checks keep their own item snapshot.
-- ---------------------------------------------------------------------------
CREATE TABLE qc_templates (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    family      TEXT,              -- instrument family, NULL = applies to all
    tier_key    TEXT NOT NULL,     -- settings key in category 'qc_tier'
    kind        TEXT NOT NULL DEFAULT 'qc'
                CHECK (kind IN ('qc', 'shipping', 'evaluation')),
    items       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{label, note}]
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qc_templates_tier_idx ON qc_templates (tier_key, family);

CREATE TABLE qc_checks (
    id            SERIAL PRIMARY KEY,
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    template_id   INTEGER REFERENCES qc_templates(id) ON DELETE SET NULL,
    tier_key      TEXT NOT NULL,
    round_number  INTEGER NOT NULL DEFAULT 1,
    reviewer_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    -- snapshot of the template items plus per-item completion state:
    -- [{label, note, checked: bool, checked_at}]
    results       JSONB NOT NULL DEFAULT '[]'::jsonb,
    passed        BOOLEAN,
    notes         TEXT,
    signed_off_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qc_checks_ticket_idx ON qc_checks (ticket_id, round_number);

-- ---------------------------------------------------------------------------
-- ticket_attachments (§10)
-- ---------------------------------------------------------------------------
CREATE TABLE ticket_attachments (
    id            SERIAL PRIMARY KEY,
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    uploader_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    storage_key   TEXT NOT NULL,       -- driver-relative object path
    driver        TEXT NOT NULL,       -- 'local' | 'gcs' — which driver wrote it
    file_name     TEXT,
    content_type  TEXT,
    size_bytes    BIGINT,
    caption       TEXT,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ticket_attachments_ticket_idx ON ticket_attachments (ticket_id, uploaded_at);

-- ---------------------------------------------------------------------------
-- shipments (§7)
-- ---------------------------------------------------------------------------
CREATE TABLE shipments (
    id              SERIAL PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    type            TEXT NOT NULL DEFAULT 'basic'
                    CHECK (type IN ('basic', 'deep_pack')),
    method          TEXT,
    contact_info    TEXT,
    international   BOOLEAN NOT NULL DEFAULT FALSE,
    scheduled_date  DATE,
    shipped_at      TIMESTAMPTZ,
    tracking_number TEXT,
    checklist       JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shipments_ticket_idx ON shipments (ticket_id);

-- ---------------------------------------------------------------------------
-- invoices — Phase 2 syncs these from Xero; Phase 1 records them manually
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
    id              SERIAL PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    xero_invoice_id TEXT,
    amount          NUMERIC(10,2),
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'paid', 'void')),
    sent_at         TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_ticket_idx ON invoices (ticket_id);

-- ---------------------------------------------------------------------------
-- parts_orders (+ vendors)
-- ---------------------------------------------------------------------------
CREATE TABLE vendors (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE parts_orders (
    id           SERIAL PRIMARY KEY,
    vendor_id    INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
    item         TEXT NOT NULL,
    quantity     TEXT,
    notes        TEXT,
    status       TEXT NOT NULL DEFAULT 'needed'
                 CHECK (status IN ('needed', 'ordered', 'received', 'cancelled')),
    ordered_at   TIMESTAMPTZ,
    received_at  TIMESTAMPTZ,
    created_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX parts_orders_vendor_idx ON parts_orders (vendor_id);

-- a parts order can serve several tickets (§12: "linked ticket(s)")
CREATE TABLE parts_order_tickets (
    parts_order_id INTEGER NOT NULL REFERENCES parts_orders(id) ON DELETE CASCADE,
    ticket_id      INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    PRIMARY KEY (parts_order_id, ticket_id)
);

-- ---------------------------------------------------------------------------
-- emails — outbound log (§11). Table exists in Phase 1; Resend wired in Phase 2.
-- ---------------------------------------------------------------------------
CREATE TABLE emails (
    id                SERIAL PRIMARY KEY,
    recipient         TEXT NOT NULL,
    template          TEXT NOT NULL,
    subject           TEXT,
    resend_message_id TEXT,
    ticket_id         INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'sent', 'failed')),
    error             TEXT,
    sent_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'settings','employees','customers','instruments','tickets','estimates',
        'qc_templates','qc_checks','shipments','invoices','parts_orders'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
    END LOOP;
END $$;
