'use strict';

/**
 * Friday Lunch -- the weekly company-lunch vote (migration 094 has the
 * phase model). Everything that changes a round lives here so the route
 * file stays a thin HTTP layer, and so the phase rules have one home.
 *
 * Anonymity rule, enforced here: no function returns another person's
 * suggester_id or voter_id -- not to admins either. Callers get counts
 * ("5 of 11 have voted") and their *own* suggestions and ballot only.
 */

const config = require('../config');
const { query, withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../middleware/errors');
const { tally, POINTS_BY_RANK } = require('./lunchTally');
const { notifyAll } = require('./fridayLunchEmail');

const MAX_SUGGESTIONS = 2;
// One rank per points value (3/2/1) -- see services/lunchTally.js.
const MAX_RANKS = POINTS_BY_RANK.length;
const MAX_NAME_LENGTH = 80;

// Which admin moves are allowed from where. voting -> reviewing is left out
// on purpose: going back would mean throwing away ballots already cast, and
// a vote with a wrong list is better cancelled and restarted in the open.
const TRANSITIONS = {
  suggesting: ['reviewing', 'voting', 'cancelled'],
  reviewing: ['suggesting', 'voting', 'cancelled'],
  voting: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
};
const EDITABLE_PHASES = ['suggesting', 'reviewing'];

/**
 * Dedupe key for place names: case, spacing and punctuation don't count, so
 * "Portillo's", "portillos" and "Portillo’s" are one place. Anything fuzzier
 * ("Chipotle" vs "Chipotle Mexican Grill") is what the admin merge is for.
 */
function nameKey(name) {
  return String(name)
    .normalize('NFKD').replace(/\p{M}/gu, '') // "Café" -> "Cafe"
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('Enter a place name');
  if (name.length > MAX_NAME_LENGTH) throw badRequest(`Keep place names under ${MAX_NAME_LENGTH} characters`);
  if (!nameKey(name)) throw badRequest('Place names need at least one letter or number');
  return name;
}

/** Locks and returns a round; every write goes through this so concurrent
 * suggestions/phase changes on one round serialize (the two-per-person
 * count depends on it). */
async function lockRound(client, roundId) {
  const { rows } = await client.query('SELECT * FROM lunch_rounds WHERE id = $1 FOR UPDATE', [roundId]);
  if (!rows[0]) throw notFound('Lunch round not found');
  return rows[0];
}

function requirePhase(round, phases, message) {
  if (!phases.includes(round.phase)) throw conflict(message);
}

/** The coming Friday in shop time -- today, if today is Friday. */
async function upcomingFriday() {
  const { rows } = await query(
    // ::text so the caller gets 'YYYY-MM-DD' however the driver parses DATE.
    `SELECT (d + ((5 - EXTRACT(DOW FROM d)::int + 7) % 7))::date::text AS friday
       FROM (SELECT (now() AT TIME ZONE $1)::date AS d) t`,
    [config.shopTimezone],
  );
  return rows[0].friday;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Everything the page needs for one round, from `user`'s point of view.
 * Admins additionally get how many people suggested each place (useful when
 * deciding merges; says nothing about who).
 */
async function roundState(roundId, user) {
  const { rows: roundRows } = await query('SELECT * FROM lunch_rounds WHERE id = $1', [roundId]);
  const round = roundRows[0];
  if (!round) throw notFound('Lunch round not found');

  const [places, mine, ballot, turnout] = await Promise.all([
    query(
      `SELECT p.id, p.name, p.added_by_admin, COUNT(s.id)::int AS suggestion_count
         FROM lunch_places p
         LEFT JOIN lunch_suggestions s ON s.place_id = p.id
        WHERE p.round_id = $1
        GROUP BY p.id
        ORDER BY lower(p.name)`,
      [roundId],
    ),
    query(
      `SELECT s.id, s.typed_name, s.place_id, p.name AS place_name, s.created_at
         FROM lunch_suggestions s JOIN lunch_places p ON p.id = s.place_id
        WHERE s.round_id = $1 AND s.suggester_id = $2
        ORDER BY s.created_at`,
      [roundId, user.id],
    ),
    query(
      'SELECT choices, updated_at FROM lunch_ballots WHERE round_id = $1 AND voter_id = $2',
      [roundId, user.id],
    ),
    query(
      `SELECT
         (SELECT COUNT(DISTINCT suggester_id)::int FROM lunch_suggestions WHERE round_id = $1) AS suggesters,
         (SELECT COUNT(*)::int FROM lunch_ballots WHERE round_id = $1) AS voters,
         (SELECT COUNT(*)::int FROM employees WHERE active = TRUE) AS eligible`,
      [roundId],
    ),
  ]);

  const isAdmin = user.role === 'admin';
  return {
    round: {
      id: round.id,
      lunch_date: round.lunch_date,
      phase: round.phase,
      opened_at: round.opened_at,
      voting_opened_at: round.voting_opened_at,
      closed_at: round.closed_at,
      winner_place_id: round.winner_place_id,
      result: round.result,
    },
    places: places.rows.map((p) => (isAdmin ? p : { id: p.id, name: p.name })),
    my_suggestions: mine.rows,
    my_ballot: ballot.rows[0] || null,
    turnout: turnout.rows[0],
    limits: { suggestions: MAX_SUGGESTIONS, ranks: MAX_RANKS },
  };
}

/** The newest round of any phase (a cancelled one included, so the page can
 * say "no lunch vote this week" instead of resurfacing last week's winner),
 * or null before the first one is ever opened. */
async function currentState(user) {
  const { rows } = await query('SELECT id FROM lunch_rounds ORDER BY id DESC LIMIT 1');
  const state = rows[0] ? await roundState(rows[0].id, user) : { round: null };
  return { ...state, upcoming_friday: await upcomingFriday() };
}

async function history(limit = 52) {
  const { rows } = await query(
    `SELECT r.id, r.lunch_date, r.phase, r.closed_at, w.name AS winner_name,
            (SELECT COUNT(*)::int FROM lunch_ballots b WHERE b.round_id = r.id) AS ballots
       FROM lunch_rounds r
       LEFT JOIN lunch_places w ON w.id = r.winner_place_id
      WHERE r.phase IN ('closed', 'cancelled')
      ORDER BY r.lunch_date DESC, r.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 52, 1), 200)],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Admin: rounds and phases
// ---------------------------------------------------------------------------

async function openRound({ lunchDate, user }) {
  const date = lunchDate || await upcomingFriday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw badRequest('lunch_date must be YYYY-MM-DD');
  let round;
  try {
    const { rows } = await query(
      'INSERT INTO lunch_rounds (lunch_date, opened_by) VALUES ($1, $2) RETURNING *',
      [date, user.id],
    );
    [round] = rows;
  } catch (err) {
    // lunch_rounds_one_open_idx
    if (err.code === '23505') throw conflict('A lunch round is already in progress — close or cancel it first');
    throw err;
  }
  notifyAll(round.id, 'suggesting');
  return round;
}

/** Freezes the tally onto the round. Runs inside the caller's transaction. */
async function closeRound(client, round) {
  const { rows: places } = await client.query('SELECT id FROM lunch_places WHERE round_id = $1', [round.id]);
  const { rows: ballots } = await client.query('SELECT choices FROM lunch_ballots WHERE round_id = $1', [round.id]);
  const result = tally({ placeIds: places.map((p) => p.id), ballots: ballots.map((b) => b.choices) });
  await client.query(
    `UPDATE lunch_rounds
        SET phase = 'closed', closed_at = now(), winner_place_id = $2, result = $3
      WHERE id = $1`,
    [round.id, result.winner_place_id, result],
  );
}

async function setPhase({ roundId, to }) {
  const emailKind = await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    if (!(TRANSITIONS[round.phase] || []).includes(to)) {
      throw conflict(`Can't go from ${round.phase} to ${to}`);
    }

    if (to === 'voting') {
      const { rows } = await client.query('SELECT id FROM lunch_places WHERE round_id = $1', [round.id]);
      if (!rows.length) throw conflict('Nothing to vote on yet — add at least one place first');
      if (rows.length === 1) {
        // One place is the answer; a vote would just be a formality. Stored
        // with an explicit reason so the results card can say why there
        // were no rounds.
        await client.query(
          `UPDATE lunch_rounds
              SET phase = 'closed', voting_opened_at = now(), closed_at = now(),
                  winner_place_id = $2, result = $3
            WHERE id = $1`,
          [round.id, rows[0].id, {
            method: 'points',
            points_by_rank: POINTS_BY_RANK,
            winner_place_id: rows[0].id,
            total_ballots: 0,
            standings: [],
            tie_break: null,
            reason: 'single_place',
          }],
        );
        return 'closed';
      }
      await client.query("UPDATE lunch_rounds SET phase = 'voting', voting_opened_at = now() WHERE id = $1", [round.id]);
      return 'voting';
    }

    if (to === 'closed') {
      await closeRound(client, round);
      return 'closed';
    }

    const stamp = to === 'reviewing' ? ', reviewing_at = now()' : '';
    await client.query(`UPDATE lunch_rounds SET phase = $2${stamp} WHERE id = $1`, [round.id, to]);
    return null; // reviewing / back to suggesting / cancelled: no email
  });

  if (emailKind) notifyAll(roundId, emailKind);
}

/**
 * Re-runs the current tally on a closed round's stored ballots. Exists for
 * rounds closed under the original ranked-choice count (result has no
 * `method`), so they can be re-decided by points. Points rounds are refused:
 * recounting one changes nothing except re-rolling a random tie-break.
 *
 * closed_at is left alone (that's when voting actually closed); the result
 * records when and from what it was recounted. The winner email goes out
 * again only if the winner changed -- otherwise nobody needs to hear it.
 */
async function recountRound({ roundId }) {
  const outcome = await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['closed'], 'Only a closed round can be recounted');
    if (round.result?.method === 'points') throw conflict('This round was already counted with points');
    if (round.result?.reason === 'single_place') throw conflict('Only one place was on the list; there is nothing to recount');

    const { rows: places } = await client.query('SELECT id FROM lunch_places WHERE round_id = $1', [round.id]);
    const { rows: ballots } = await client.query('SELECT choices FROM lunch_ballots WHERE round_id = $1', [round.id]);
    const result = tally({ placeIds: places.map((p) => p.id), ballots: ballots.map((b) => b.choices) });
    result.recounted_at = new Date().toISOString();
    result.recounted_from = { method: 'ranked_choice', winner_place_id: round.winner_place_id };

    await client.query(
      'UPDATE lunch_rounds SET winner_place_id = $2, result = $3 WHERE id = $1',
      [round.id, result.winner_place_id, result],
    );
    return { changed: result.winner_place_id !== round.winner_place_id };
  });
  if (outcome.changed) notifyAll(roundId, 'closed');
  return outcome;
}

// ---------------------------------------------------------------------------
// Admin: list edits (suggesting + reviewing only)
// ---------------------------------------------------------------------------

async function lockPlaceForEdit(client, placeId) {
  const { rows } = await client.query('SELECT round_id FROM lunch_places WHERE id = $1', [placeId]);
  if (!rows[0]) throw notFound('Place not found');
  const round = await lockRound(client, rows[0].round_id);
  requirePhase(round, EDITABLE_PHASES, 'The list is locked once voting opens');
  // Re-read under the round lock: a merge/remove that held the lock first
  // may have deleted it while we waited.
  const { rows: placeRows } = await client.query('SELECT * FROM lunch_places WHERE id = $1', [placeId]);
  if (!placeRows[0]) throw notFound('Place not found');
  return { place: placeRows[0], round };
}

async function addPlace({ roundId, name }) {
  const clean = cleanName(name);
  return withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, EDITABLE_PHASES, 'The list is locked once voting opens');
    const { rows } = await client.query(
      `INSERT INTO lunch_places (round_id, name, name_key, added_by_admin)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (round_id, name_key) DO NOTHING
       RETURNING *`,
      [round.id, clean, nameKey(clean)],
    );
    if (!rows[0]) throw conflict(`"${clean}" is already on the list`);
    return rows[0];
  });
}

async function renamePlace({ placeId, name }) {
  const clean = cleanName(name);
  return withTransaction(async (client) => {
    const { place } = await lockPlaceForEdit(client, placeId);
    const { rows: clash } = await client.query(
      'SELECT id, name FROM lunch_places WHERE round_id = $1 AND name_key = $2 AND id <> $3',
      [place.round_id, nameKey(clean), place.id],
    );
    if (clash[0]) throw conflict(`"${clash[0].name}" is already on the list — merge into it instead`);
    const { rows } = await client.query(
      'UPDATE lunch_places SET name = $2, name_key = $3 WHERE id = $1 RETURNING *',
      [place.id, clean, nameKey(clean)],
    );
    return rows[0];
  });
}

async function mergePlace({ placeId, intoPlaceId }) {
  if (Number(placeId) === Number(intoPlaceId)) throw badRequest("Can't merge a place into itself");
  return withTransaction(async (client) => {
    const { place } = await lockPlaceForEdit(client, placeId);
    const { rows: targetRows } = await client.query(
      'SELECT * FROM lunch_places WHERE id = $1 AND round_id = $2', [intoPlaceId, place.round_id],
    );
    if (!targetRows[0]) throw badRequest('Merge target must be another place in the same round');
    // Someone who suggested both just ends up with one suggestion (freeing a
    // slot) rather than tripping UNIQUE (place_id, suggester_id).
    await client.query(
      `DELETE FROM lunch_suggestions s
        WHERE s.place_id = $1
          AND EXISTS (SELECT 1 FROM lunch_suggestions t WHERE t.place_id = $2 AND t.suggester_id = s.suggester_id)`,
      [place.id, intoPlaceId],
    );
    await client.query('UPDATE lunch_suggestions SET place_id = $2 WHERE place_id = $1', [place.id, intoPlaceId]);
    await client.query('DELETE FROM lunch_places WHERE id = $1', [place.id]);
    return targetRows[0];
  });
}

async function removePlace({ placeId }) {
  await withTransaction(async (client) => {
    const { place } = await lockPlaceForEdit(client, placeId);
    // Cascades its suggestions; while suggestions are open that gives the
    // suggester their slot back.
    await client.query('DELETE FROM lunch_places WHERE id = $1', [place.id]);
  });
}

// ---------------------------------------------------------------------------
// Everyone: suggestions and ballots
// ---------------------------------------------------------------------------

async function suggest({ roundId, name, user }) {
  const clean = cleanName(name);
  return withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['suggesting'], 'Suggestions are closed for this week');

    const { rows: countRows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM lunch_suggestions WHERE round_id = $1 AND suggester_id = $2',
      [round.id, user.id],
    );
    if (countRows[0].n >= MAX_SUGGESTIONS) {
      throw conflict(`You've already suggested ${MAX_SUGGESTIONS} places — remove one to add another`);
    }

    // Land on the existing place when the name matches one already listed.
    // The no-op DO UPDATE is what makes RETURNING hand back the existing row.
    const { rows: placeRows } = await client.query(
      `INSERT INTO lunch_places (round_id, name, name_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (round_id, name_key) DO UPDATE SET name = lunch_places.name
       RETURNING *`,
      [round.id, clean, nameKey(clean)],
    );
    const place = placeRows[0];

    const { rows } = await client.query(
      `INSERT INTO lunch_suggestions (round_id, place_id, suggester_id, typed_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (place_id, suggester_id) DO NOTHING
       RETURNING id`,
      [round.id, place.id, user.id, clean],
    );
    if (!rows[0]) throw conflict(`You already suggested ${place.name}`);
    return { id: rows[0].id, place_id: place.id, place_name: place.name };
  });
}

async function withdrawSuggestion({ suggestionId, user }) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM lunch_suggestions WHERE id = $1 AND suggester_id = $2', [suggestionId, user.id],
    );
    // Same 404 whether it's missing or someone else's -- don't confirm that
    // another person's suggestion id exists.
    if (!rows[0]) throw notFound('Suggestion not found');
    const round = await lockRound(client, rows[0].round_id);
    requirePhase(round, ['suggesting'], 'Suggestions are closed for this week');

    await client.query('DELETE FROM lunch_suggestions WHERE id = $1', [rows[0].id]);
    await client.query(
      `DELETE FROM lunch_places p
        WHERE p.id = $1 AND NOT p.added_by_admin
          AND NOT EXISTS (SELECT 1 FROM lunch_suggestions s WHERE s.place_id = p.id)`,
      [rows[0].place_id],
    );
  });
}

async function castBallot({ roundId, choices, user }) {
  if (!Array.isArray(choices)) throw badRequest('choices must be a list of place ids');
  const ids = choices.map(Number);
  if (!ids.length) throw badRequest('Rank at least one place');
  if (ids.length > MAX_RANKS) throw badRequest(`Rank at most ${MAX_RANKS} places`);
  if (ids.some((id) => !Number.isInteger(id))) throw badRequest('choices must be place ids');
  if (new Set(ids).size !== ids.length) throw badRequest('Each place can only be ranked once');

  return withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['voting'], 'Voting is not open');
    const { rows: valid } = await client.query(
      'SELECT id FROM lunch_places WHERE round_id = $1 AND id = ANY($2::int[])', [round.id, ids],
    );
    if (valid.length !== ids.length) throw badRequest('One of those places is not on this week\'s list');
    const { rows } = await client.query(
      `INSERT INTO lunch_ballots (round_id, voter_id, choices)
       VALUES ($1, $2, $3)
       ON CONFLICT (round_id, voter_id) DO UPDATE SET choices = EXCLUDED.choices, updated_at = now()
       RETURNING choices, updated_at`,
      [round.id, user.id, ids],
    );
    return rows[0];
  });
}

async function withdrawBallot({ roundId, user }) {
  await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['voting'], 'Voting is not open');
    await client.query('DELETE FROM lunch_ballots WHERE round_id = $1 AND voter_id = $2', [round.id, user.id]);
  });
}

module.exports = {
  nameKey,
  upcomingFriday,
  currentState,
  roundState,
  history,
  openRound,
  setPhase,
  recountRound,
  addPlace,
  renamePlace,
  mergePlace,
  removePlace,
  suggest,
  withdrawSuggestion,
  castBallot,
  withdrawBallot,
};
