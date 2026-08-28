-- "Ceppies" — a fictional, purely-for-fun staff award. Any tech can
-- nominate any other tech (or themselves) with a short reason; nominations
-- collect until the admin-configured weekly digest email fires (either on
-- its own schedule or an admin's manual "send now" — see
-- backend/src/services/ceppies.js), at which point they're folded into
-- that one email to all staff and become visible in the app's "Past
-- nominations" tab.
--
-- emailed_at is the whole state machine: NULL means "pending, not yet in
-- an email" and IS NOT NULL means "went out in the digest at this
-- timestamp." Nothing else marks a nomination's lifecycle stage — the
-- digest send (services/ceppies.js's sendCeppieDigest) selects every row
-- with emailed_at IS NULL and, in the same run, stamps all of them with
-- the same now() value, which doubles as a free "batch id" for grouping
-- past nominations by which email they went out in.
--
-- Deliberately NOT gated by any admin-visible "is this nomination pending"
-- endpoint for anyone but its own nominator (see routes/ceppies.js's
-- /nominations/mine vs /nominations/past) — the whole point is that other
-- techs can't see who's been nominated for what until the email lands in
-- everyone's inbox at the same moment, same as a surprise shout-out.
CREATE TABLE ceppie_nominations (
    id            SERIAL PRIMARY KEY,
    nominee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    nominator_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    reason        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    emailed_at    TIMESTAMPTZ
);

-- "My nominations" (routes/ceppies.js) reads WHERE nominator_id = $1 AND
-- emailed_at IS NULL — this partial index covers exactly that shape without
-- indexing the (much larger, over time) already-emailed rows at all.
CREATE INDEX ceppie_nominations_pending_by_nominator_idx
  ON ceppie_nominations (nominator_id, created_at) WHERE emailed_at IS NULL;

-- "Past nominations" reads WHERE emailed_at IS NOT NULL ORDER BY emailed_at
-- DESC — same partial-index idea, the other half of the state machine.
CREATE INDEX ceppie_nominations_past_idx
  ON ceppie_nominations (emailed_at DESC) WHERE emailed_at IS NOT NULL;
