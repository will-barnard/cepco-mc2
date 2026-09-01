-- N7 (boss-list scope, scaffold only — explicit call: build the structure
-- now, the boss's real list arrives later as a CSV; see NOTES.md). The 7
-- existing instruments.family keys (rhodes, wurlitzer, hohner, strings,
-- organ, amp, rarity) are left completely unchanged — they're a join key
-- in five places (instruments, qc_templates, standard_procedures,
-- instrument_default_technicians, and Queue's per-family ordering) that
-- nothing here touches. This table sits *beneath* that key: a tree of
-- model names within a family, for a guided picker rather than a bare
-- free-text Model field. Deliberately ragged — a leaf can occur at any
-- depth (some families will have eras/series, some won't) — so there's no
-- fixed depth column, just a self-referencing parent_id.
CREATE TABLE instrument_models (
    id           SERIAL PRIMARY KEY,
    family       TEXT NOT NULL, -- one of instruments.family's keys — not FK'd, same unconstrained convention instruments.family itself already uses
    parent_id    INTEGER REFERENCES instrument_models(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    -- Lets a node's picker step also offer "type your own" instead of (or
    -- alongside) its listed children — the frontend picker additionally
    -- always offers a manual-entry escape hatch regardless of this flag
    -- while the tree is this sparse, but the flag stays meaningful once
    -- real data lands for a family that's inherently open-ended (rarity/
    -- "Other" chief among them).
    allow_manual BOOLEAN NOT NULL DEFAULT FALSE,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instrument_models_tree_idx ON instrument_models (family, parent_id, sort_order);

-- Placeholder seed data — NOT the boss's real list. Demonstrates the
-- ragged-depth shape deliberately: Rhodes has a leaf sitting directly at
-- the family root ("Mark II") right alongside a deeper era -> series ->
-- model chain, and Wurlitzer has the same shape ("140B" at the root next
-- to a series -> model chain) — exactly the mix a real, incrementally-
-- built model list will actually have.
DO $$
DECLARE
  v_rhodes_70s    INTEGER;
  v_rhodes_mk1    INTEGER;
  v_wurlitzer_200 INTEGER;
BEGIN
  INSERT INTO instrument_models (family, parent_id, name, sort_order)
    VALUES ('rhodes', NULL, '1970s', 10) RETURNING id INTO v_rhodes_70s;
  INSERT INTO instrument_models (family, parent_id, name, sort_order)
    VALUES ('rhodes', v_rhodes_70s, 'Mark I', 10) RETURNING id INTO v_rhodes_mk1;
  INSERT INTO instrument_models (family, parent_id, name, sort_order) VALUES
    ('rhodes', v_rhodes_mk1, 'Suitcase 88', 10),
    ('rhodes', v_rhodes_mk1, 'Stage 73', 20);
  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual) VALUES
    ('rhodes', NULL, 'Mark II', 20, FALSE),
    ('rhodes', NULL, 'Other (not listed yet)', 999, TRUE);

  INSERT INTO instrument_models (family, parent_id, name, sort_order)
    VALUES ('wurlitzer', NULL, '200 Series', 10) RETURNING id INTO v_wurlitzer_200;
  INSERT INTO instrument_models (family, parent_id, name, sort_order) VALUES
    ('wurlitzer', v_wurlitzer_200, '200', 10),
    ('wurlitzer', v_wurlitzer_200, '200A', 20);
  INSERT INTO instrument_models (family, parent_id, name, sort_order, allow_manual) VALUES
    ('wurlitzer', NULL, '140B', 20, FALSE),
    ('wurlitzer', NULL, 'Other (not listed yet)', 999, TRUE);
END $$;
