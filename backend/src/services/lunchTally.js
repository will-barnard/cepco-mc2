'use strict';

/**
 * Points tally for Friday Lunch (shop decision, Nov 2026, replacing the
 * first-week ranked-choice count -- people expected 2nd and 3rd choices to
 * count for something, and under instant-runoff they often never do).
 * Pure: services/fridayLunch.js feeds it the frozen place list and every
 * ballot at close, and stores what it returns on lunch_rounds.result.
 *
 * Scoring: 1st choice 3 points, 2nd 2, 3rd 1 (POINTS_BY_RANK). A ballot that
 * only ranks one place still gives it 3 -- ranking fewer places never
 * weakens your top pick. Most points wins.
 *
 * Ties on points: more 1st-choice votes wins, then more 2nd-choice votes,
 * then random -- and the result says which settled it.
 *
 * Results stored before the switch have no `method` and a `rounds` array;
 * components/LunchResults.vue still renders those as they were counted.
 */

const crypto = require('crypto');

const POINTS_BY_RANK = [3, 2, 1];
const defaultRandomIndex = (n) => crypto.randomInt(n);

/**
 * @param {object} input
 * @param {number[]} input.placeIds   every place on the frozen list
 * @param {number[][]} input.ballots  ranked place ids, best first
 * @param {(n:number)=>number} [input.randomIndex] 0 <= result < n; injectable for tests
 */
function tally({ placeIds, ballots, randomIndex = defaultRandomIndex }) {
  const known = new Set(placeIds);
  // Defensive: drop unknown ids and repeats, and anything past the scored
  // ranks. The ballot endpoint already rejects all three.
  const clean = ballots
    .map((b) => [...new Set((b || []).filter((id) => known.has(id)))].slice(0, POINTS_BY_RANK.length))
    .filter((b) => b.length);

  const byId = new Map(placeIds.map((id) => [id, {
    place_id: id, points: 0, ranks: POINTS_BY_RANK.map(() => 0),
  }]));
  for (const b of clean) {
    b.forEach((id, i) => {
      const s = byId.get(id);
      s.points += POINTS_BY_RANK[i];
      s.ranks[i] += 1;
    });
  }

  // Best first: points, then 1st-choice count, then 2nd, ... Places still
  // level after all that stay adjacent; only a tie *for first* needs
  // breaking, and that happens below.
  const cmp = (a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (let i = 0; i < POINTS_BY_RANK.length; i += 1) {
      if (b.ranks[i] !== a.ranks[i]) return b.ranks[i] - a.ranks[i];
    }
    return 0;
  };
  const standings = [...byId.values()].sort((a, b) => cmp(a, b) || a.place_id - b.place_id);

  const base = {
    method: 'points', points_by_rank: POINTS_BY_RANK, total_ballots: clean.length, standings, tie_break: null,
  };
  if (!placeIds.length) return { ...base, winner_place_id: null, reason: 'no_places' };
  if (!clean.length) return { ...base, winner_place_id: null, reason: 'no_ballots' };

  const top = standings[0];
  const tiedOnPoints = standings.filter((s) => s.points === top.points);
  if (tiedOnPoints.length === 1) return { ...base, winner_place_id: top.place_id };

  // Which rank's count first separated the leader from the rest of the
  // points tie (0 = 1st choices, 1 = 2nd ...), if any did.
  const fullyTied = tiedOnPoints.filter((s) => cmp(s, top) === 0);
  if (fullyTied.length === 1) {
    const runnerUp = tiedOnPoints[1];
    const decidedAt = top.ranks.findIndex((n, i) => n !== runnerUp.ranks[i]);
    return {
      ...base,
      winner_place_id: top.place_id,
      tie_break: { method: 'rank_count', rank: decidedAt + 1, among: tiedOnPoints.map((s) => s.place_id) },
    };
  }

  // Sorted by id above, so the same draw always means the same place.
  const pick = fullyTied[randomIndex(fullyTied.length)];
  return {
    ...base,
    winner_place_id: pick.place_id,
    tie_break: { method: 'random', among: fullyTied.map((s) => s.place_id) },
  };
}

module.exports = { tally, POINTS_BY_RANK };
