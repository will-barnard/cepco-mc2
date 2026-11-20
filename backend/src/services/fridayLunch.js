'use strict';

/**
 * Friday Lunch -- the weekly company-lunch vote (migration 094 has the
 * phase model). Everything that changes a round lives here so the route
 * file stays a thin HTTP layer, and so the phase rules have one home.
 *
 * Anonymity rule, enforced here: no function returns another person's
 * suggester_id or voter_id -- not to admins either. Callers get counts
 * ("5 of 11 have voted") and their *own* suggestions and ballot only.
 * Orders (migration 096) are the deliberate exception: they carry names.
 */

const crypto = require('crypto');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../middleware/errors');
const { tally, POINTS_BY_RANK } = require('./lunchTally');
const { notifyAll } = require('./fridayLunchEmail');

const MAX_SUGGESTIONS = 2;
// One rank per points value (3/2/1) -- see services/lunchTally.js.
const MAX_RANKS = POINTS_BY_RANK.length;
const MAX_NAME_LENGTH = 80;
const MAX_ORDER_LENGTH = 500;

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

// Runoffs are pick-one, most votes wins (migration 095); ranking 3/2/1
// between two or three finalists would mostly just add noise.
const RUNOFF_POINTS = [1];
const ranksFor = (round) => (round.parent_round_id ? RUNOFF_POINTS.length : MAX_RANKS);

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

  const [places, mine, ballot, turnout, runoff, orders] = await Promise.all([
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
    // This round's live runoff, if one was started from it.
    query(
      "SELECT id, phase FROM lunch_rounds WHERE parent_round_id = $1 AND phase <> 'cancelled'",
      [roundId],
    ),
    // Named on purpose -- see migration 096.
    query(
      `SELECT o.id, o.order_text, o.updated_at, e.name, (o.employee_id = $2) AS mine
         FROM lunch_orders o JOIN employees e ON e.id = o.employee_id
        WHERE o.round_id = $1
        ORDER BY lower(e.name)`,
      [roundId, user.id],
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
      parent_round_id: round.parent_round_id,
      is_runoff: round.parent_round_id !== null,
      runoff_round_id: runoff.rows[0]?.id || null,
      orders_status: round.orders_status,
    },
    orders: round.orders_status ? orders.rows : [],
    places: places.rows.map((p) => (isAdmin ? p : { id: p.id, name: p.name })),
    my_suggestions: mine.rows,
    my_ballot: ballot.rows[0] || null,
    turnout: turnout.rows[0],
    limits: { suggestions: MAX_SUGGESTIONS, ranks: ranksFor(round) },
  };
}

/** The newest round of any phase (a cancelled one included, so the page can
 * say "no lunch vote this week" instead of resurfacing last week's winner),
 * or null before the first one is ever opened. */
async function currentState(user) {
  const { rows } = await query('SELECT id, phase, parent_round_id FROM lunch_rounds ORDER BY id DESC LIMIT 1');
  // A cancelled runoff means the original result stands, so show that
  // round, not "no lunch vote this week".
  const latest = rows[0];
  const showId = latest && latest.phase === 'cancelled' && latest.parent_round_id
    ? latest.parent_round_id
    : latest?.id;
  const state = showId ? await roundState(showId, user) : { round: null };
  return { ...state, upcoming_friday: await upcomingFriday() };
}

/** One row per Friday: the original round, with its runoff (if any)
 * folded in so the week's final winner is the runoff's. A runoff still in
 * voting, or tied and waiting on the random draw, leaves final_winner_name
 * null. */
async function history(limit = 52) {
  const { rows } = await query(
    `SELECT r.id, r.lunch_date, r.phase, r.closed_at, w.name AS winner_name,
            (SELECT COUNT(*)::int FROM lunch_ballots b WHERE b.round_id = r.id) AS ballots,
            ro.id AS runoff_id, ro.phase AS runoff_phase, rw.name AS runoff_winner_name,
            CASE WHEN ro.id IS NULL THEN w.name ELSE rw.name END AS final_winner_name
       FROM lunch_rounds r
       LEFT JOIN lunch_places w ON w.id = r.winner_place_id
       LEFT JOIN lunch_rounds ro ON ro.parent_round_id = r.id AND ro.phase <> 'cancelled'
       LEFT JOIN lunch_places rw ON rw.id = ro.winner_place_id
      WHERE r.parent_round_id IS NULL AND r.phase IN ('closed', 'cancelled')
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
  const result = tally({
    placeIds: places.map((p) => p.id),
    ballots: ballots.map((b) => b.choices),
    // Runoff ties wait for an admin's "Pick at random" (pickRandomWinner).
    ...(round.parent_round_id ? { pointsByRank: RUNOFF_POINTS, tieMode: 'defer' } : {}),
  });
  await client.query(
    `UPDATE lunch_rounds
        SET phase = 'closed', closed_at = now(), winner_place_id = $2, result = $3
      WHERE id = $1`,
    [round.id, result.winner_place_id, result],
  );
  return result;
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
      const result = await closeRound(client, round);
      // A pending runoff tie has no winner to announce yet; the email goes
      // out after the random draw instead.
      return result.winner_place_id ? 'closed' : null;
    }

    const stamp = to === 'reviewing' ? ', reviewing_at = now()' : '';
    await client.query(`UPDATE lunch_rounds SET phase = $2${stamp} WHERE id = $1`, [round.id, to]);
    return null; // reviewing / back to suggesting / cancelled: no email
  });

  if (emailKind) notifyAll(roundId, emailKind);
}

// ---------------------------------------------------------------------------
// Orders (migration 096): opt-in per result, named, one per person
// ---------------------------------------------------------------------------

/** Admin: start (or reopen) collecting orders for a decided result. */
async function openOrders({ roundId }) {
  const notify = await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['closed'], 'Orders can only be collected once there is a result');
    if (!round.winner_place_id) throw conflict('There is no winner yet. Settle the result first');
    const { rows: live } = await client.query(
      "SELECT 1 FROM lunch_rounds WHERE parent_round_id = $1 AND phase <> 'cancelled'", [round.id],
    );
    if (live.length) throw conflict('This result went to a runoff. Collect orders on the runoff instead');
    if (round.orders_status === 'open') return false;
    await client.query(
      `UPDATE lunch_rounds SET orders_status = 'open', orders_opened_at = COALESCE(orders_opened_at, now())
        WHERE id = $1`,
      [round.id],
    );
    // Email the first time only; reopening after a close is a quiet fix-up.
    return round.orders_status === null;
  });
  if (notify) notifyAll(roundId, 'orders');
}

/** Admin: lock the list (someone's placing the order). Reopen with openOrders. */
async function closeOrders({ roundId }) {
  await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    if (round.orders_status !== 'open') throw conflict('Orders are not open');
    await client.query("UPDATE lunch_rounds SET orders_status = 'closed' WHERE id = $1", [round.id]);
  });
}

async function saveOrder({ roundId, text, user }) {
  const clean = String(text ?? '').trim();
  if (!clean) throw badRequest('Type your order');
  if (clean.length > MAX_ORDER_LENGTH) throw badRequest(`Keep orders under ${MAX_ORDER_LENGTH} characters`);
  await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    if (round.orders_status !== 'open') throw conflict('Orders are not open');
    await client.query(
      `INSERT INTO lunch_orders (round_id, employee_id, order_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (round_id, employee_id) DO UPDATE SET order_text = EXCLUDED.order_text, updated_at = now()`,
      [round.id, user.id, clean],
    );
  });
}

/** Removes the caller's own order, or (admin) anyone's by order id. */
async function removeOrder({ roundId, orderId = null, user }) {
  await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    if (orderId === null) {
      if (round.orders_status !== 'open') throw conflict('Orders are not open');
      await client.query('DELETE FROM lunch_orders WHERE round_id = $1 AND employee_id = $2', [round.id, user.id]);
      return;
    }
    // Admin clean-up works while closed too (a duplicate, someone who left).
    if (user.role !== 'admin') throw conflict('Only an admin can remove someone else’s order');
    const { rows } = await client.query(
      'DELETE FROM lunch_orders WHERE id = $1 AND round_id = $2 RETURNING id', [orderId, round.id],
    );
    if (!rows.length) throw notFound('Order not found');
  });
}

/**
 * Sends a closed round's top `top` places to a runoff: a new round for the
 * same Friday that opens straight into voting with copies of just those
 * places. "Top" is the stored standings order (points, then 1st-choice
 * count, then 2nd, ...); the page warns the admin when the cut-off splits a
 * points tie so they can widen it.
 */
async function startRunoff({ roundId, top, user }) {
  const n = Number(top);
  const runoffId = await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['closed'], 'A runoff can only follow a closed round');
    if (round.parent_round_id) throw conflict("A runoff can't have its own runoff. Use Pick at random if it tied");
    if (round.orders_status) throw conflict('Orders are already being collected for this result');
    const { result } = round;
    if (result?.method !== 'points') throw conflict('Recount this round with points before starting a runoff');
    if (!result.total_ballots) throw conflict('Nobody voted in this round, so there is nothing to run off');
    const standings = result.standings || [];
    if (!Number.isInteger(n) || n < 2 || n > standings.length) {
      throw badRequest(`Pick between 2 and ${standings.length} places for the runoff`);
    }

    let inserted;
    try {
      const { rows } = await client.query(
        `INSERT INTO lunch_rounds (lunch_date, phase, opened_by, voting_opened_at, parent_round_id)
         VALUES ($1, 'voting', $2, now(), $3) RETURNING id`,
        [round.lunch_date, user.id, round.id],
      );
      [inserted] = rows;
    } catch (err) {
      // lunch_rounds_one_open_idx / lunch_rounds_one_runoff_idx
      if (err.code === '23505') throw conflict('A runoff (or another round) is already in progress');
      throw err;
    }
    await client.query(
      `INSERT INTO lunch_places (round_id, name, name_key, added_by_admin)
       SELECT $1, p.name, p.name_key, FALSE
         FROM lunch_places p
        WHERE p.id = ANY($2::int[])`,
      [inserted.id, standings.slice(0, n).map((s) => s.place_id)],
    );
    return inserted.id;
  });
  notifyAll(runoffId, 'runoff');
  return runoffId;
}

/** Settles a runoff left tied (tie_break.method 'pending') by drawing one
 * of the tied places at random. Recorded on the result as a random
 * tie-break with when it was drawn. */
async function pickRandomWinner({ roundId }) {
  await withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['closed'], 'Voting has to close before a tie can be drawn');
    const tb = round.result?.tie_break;
    if (tb?.method !== 'pending') throw conflict('This round has no tie waiting to be drawn');
    const among = [...tb.among].sort((a, b) => a - b);
    const winner = among[crypto.randomInt(among.length)];
    const result = {
      ...round.result,
      winner_place_id: winner,
      tie_break: { method: 'random', among, drawn_at: new Date().toISOString() },
    };
    await client.query(
      'UPDATE lunch_rounds SET winner_place_id = $2, result = $3 WHERE id = $1',
      [round.id, winner, result],
    );
  });
  notifyAll(roundId, 'closed');
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
  if (ids.some((id) => !Number.isInteger(id))) throw badRequest('choices must be place ids');
  if (new Set(ids).size !== ids.length) throw badRequest('Each place can only be ranked once');

  return withTransaction(async (client) => {
    const round = await lockRound(client, roundId);
    requirePhase(round, ['voting'], 'Voting is not open');
    const maxRanks = ranksFor(round);
    if (ids.length > maxRanks) {
      throw badRequest(maxRanks === 1 ? 'Pick one place in a runoff' : `Rank at most ${maxRanks} places`);
    }
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
  openOrders,
  closeOrders,
  saveOrder,
  removeOrder,
  startRunoff,
  pickRandomWinner,
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
