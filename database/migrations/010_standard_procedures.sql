-- Standard shop procedures per instrument type (Settings -> Standard
-- procedures) — the price/hours catalog customer estimates (migration 011)
-- are built from. A procedure prices either as an hours range (billed out
-- at the shop's labor rate — shop_config 'labor_rate') or a flat cost,
-- never both. `family` is nullable, same convention as qc_templates
-- (migration 001): NULL applies to every instrument type, a specific
-- family restricts it to that one.
CREATE TABLE standard_procedures (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    family       TEXT,
    pricing_type TEXT NOT NULL DEFAULT 'hours'
                 CHECK (pricing_type IN ('hours', 'flat')),
    min_hours    NUMERIC(6,2),
    max_hours    NUMERIC(6,2),
    flat_cost    NUMERIC(10,2),
    description  TEXT,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
      (pricing_type = 'hours' AND min_hours IS NOT NULL AND max_hours IS NOT NULL
        AND max_hours >= min_hours AND flat_cost IS NULL)
      OR
      (pricing_type = 'flat' AND flat_cost IS NOT NULL AND min_hours IS NULL AND max_hours IS NULL)
    )
);
CREATE INDEX standard_procedures_family_idx ON standard_procedures (family);
