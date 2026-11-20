-- ===========================================================================
-- Friday Lunch (Nov 2026): the weekly company-lunch vote, under More in the
-- nav (frontend FridayLunchView.vue, backend routes/fridayLunch.js).
--
-- One round per Friday, moved along by an admin by hand:
--   suggesting  everyone adds up to two places
--   reviewing   suggestions closed; admin renames / merges / removes / adds
--   voting      list frozen; everyone ranks 1-3 places (ranked choice)
--   closed      tallied; winner + round-by-round result stored on the row
--   cancelled   holiday week etc. -- kept so history shows it, never tallied
-- Admin list edits are allowed in suggesting *and* reviewing, so a merge can
-- happen early; once voting opens the list is frozen, which is what lets
-- ballots hold plain place ids (see lunch_ballots.choices below).
--
-- Anonymity is enforced in the API, not the schema (product decision): the
-- suggester and voter ids are stored so people can withdraw a suggestion or
-- change their vote until voting closes, but no endpoint returns another
-- person's id -- not even to an admin. Anyone with database access can still
-- join them; the alternative (ballots with no voter id) would have meant a
-- vote can never be changed.
-- ===========================================================================

CREATE TABLE lunch_rounds (
    id                SERIAL PRIMARY KEY,
    lunch_date        DATE NOT NULL,
    phase             TEXT NOT NULL DEFAULT 'suggesting'
                      CHECK (phase IN ('suggesting', 'reviewing', 'voting', 'closed', 'cancelled')),
    opened_by         INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewing_at      TIMESTAMPTZ,
    voting_opened_at  TIMESTAMPTZ,
    closed_at         TIMESTAMPTZ,
    -- Set at close. ON DELETE SET NULL is belt-and-braces: places can't be
    -- deleted once voting opens (service rule), so this shouldn't fire.
    winner_place_id   INTEGER,
    -- services/lunchTally.js output, frozen at close: rounds of counts,
    -- eliminations, exhausted ballots, and any tie-break used. Stored rather
    -- than re-derived so a later code change to the tally (or a random
    -- tie-break) can never quietly change a past result.
    result            JSONB
);

-- At most one round in progress at a time -- "the current round" is then
-- unambiguous for every endpoint without a round id.
CREATE UNIQUE INDEX lunch_rounds_one_open_idx
  ON lunch_rounds ((TRUE)) WHERE phase IN ('suggesting', 'reviewing', 'voting');

CREATE INDEX lunch_rounds_history_idx ON lunch_rounds (lunch_date DESC, id DESC);

-- The candidate list for a round. A suggestion attaches to a place rather
-- than being one, so two people typing "Portillo's" and "portillos" land on
-- the same place (name_key, normalized in services/fridayLunch.js) and an
-- admin merge is just repointing suggestions.
CREATE TABLE lunch_places (
    id              SERIAL PRIMARY KEY,
    round_id        INTEGER NOT NULL REFERENCES lunch_rounds(id) ON DELETE CASCADE,
    name            TEXT NOT NULL CHECK (btrim(name) <> ''),
    name_key        TEXT NOT NULL,
    -- An admin-added place stays when it has no suggestions; a suggested
    -- one disappears when its last suggester withdraws.
    added_by_admin  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (round_id, name_key)
);

ALTER TABLE lunch_rounds
  ADD CONSTRAINT lunch_rounds_winner_fk
  FOREIGN KEY (winner_place_id) REFERENCES lunch_places(id) ON DELETE SET NULL;

CREATE TABLE lunch_suggestions (
    id            SERIAL PRIMARY KEY,
    round_id      INTEGER NOT NULL REFERENCES lunch_rounds(id) ON DELETE CASCADE,
    place_id      INTEGER NOT NULL REFERENCES lunch_places(id) ON DELETE CASCADE,
    suggester_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- What they actually typed, so "my suggestions" still reads right after
    -- an admin renames or merges the place it landed on.
    typed_name    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (place_id, suggester_id)
);
-- The two-per-person limit is checked in the service under a lock on the
-- round row (a count, not expressible as a plain constraint); this index
-- serves that count and "my suggestions".
CREATE INDEX lunch_suggestions_by_suggester_idx ON lunch_suggestions (round_id, suggester_id);

-- One ballot per person per round, replaced in place when they change it.
-- choices is ranked place ids, best first. An array rather than a rankings
-- table because the list is frozen while voting is open, so there's nothing
-- for a per-choice foreign key to protect; the service checks every id
-- belongs to the round and none repeat.
CREATE TABLE lunch_ballots (
    id          SERIAL PRIMARY KEY,
    round_id    INTEGER NOT NULL REFERENCES lunch_rounds(id) ON DELETE CASCADE,
    voter_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    choices     INTEGER[] NOT NULL
                CHECK (cardinality(choices) BETWEEN 1 AND 3),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (round_id, voter_id)
);
