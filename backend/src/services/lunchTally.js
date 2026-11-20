'use strict';

/**
 * Ranked-choice (instant-runoff) tally for Friday Lunch. Pure: no database,
 * no clock -- services/fridayLunch.js feeds it the frozen place list and
 * every ballot at close, and stores what it returns on lunch_rounds.result.
 *
 * Each round, every ballot counts for its highest-ranked place still in the
 * running. A place with more than half of the ballots still counting wins.
 * Otherwise the last-place place is eliminated and its ballots move to their
 * next choice. A ballot whose choices have all been eliminated is
 * "exhausted" and stops counting -- with only three ranks allowed that will
 * happen, and the result reports how many.
 *
 * Ties for last (shop decision, Nov 2026): eliminate whichever of the tied
 * places appears on fewer ballots at any rank ("count-back"); if that's still
 * tied, pick at random and say so in the result. A 50/50 final round is the
 * same case -- the two finalists are tied for last -- so it needs no rule of
 * its own.
 *
 * Every place with zero votes in a round is dropped together rather than one
 * per round (they can't affect anyone else's count), which keeps the
 * round-by-round table short when a lot got suggested.
 */

const crypto = require('crypto');

const defaultRandomIndex = (n) => crypto.randomInt(n);

/**
 * @param {object} input
 * @param {number[]} input.placeIds   every place on the frozen list
 * @param {number[][]} input.ballots  ranked place ids, best first
 * @param {(n:number)=>number} [input.randomIndex] 0 <= result < n; injectable for tests
 * @returns {{winner_place_id:number|null, total_ballots:number,
 *            mentions:Object<string,number>, rounds:object[], reason?:string}}
 */
function tally({ placeIds, ballots, randomIndex = defaultRandomIndex }) {
  const known = new Set(placeIds);
  // Defensive: drop ids that aren't on the list and repeats within a ballot.
  // The ballot endpoint already rejects both; this just means a bad row can
  // never crash a close.
  const clean = ballots
    .map((b) => [...new Set((b || []).filter((id) => known.has(id)))])
    .filter((b) => b.length);

  const mentions = Object.fromEntries(placeIds.map((id) => [id, 0]));
  for (const b of clean) for (const id of b) mentions[id] += 1;

  const base = { total_ballots: clean.length, mentions, rounds: [] };
  if (!placeIds.length) return { ...base, winner_place_id: null, reason: 'no_places' };
  if (!clean.length) return { ...base, winner_place_id: null, reason: 'no_ballots' };

  const active = new Set(placeIds);

  for (;;) {
    const counts = Object.fromEntries([...active].map((id) => [id, 0]));
    let exhausted = 0;
    for (const b of clean) {
      const top = b.find((id) => active.has(id));
      if (top === undefined) exhausted += 1;
      else counts[top] += 1;
    }
    const continuing = clean.length - exhausted;
    const round = { counts, exhausted, continuing, eliminated: [], tie_break: null };
    base.rounds.push(round);

    const ranked = [...active].sort((a, b) => counts[b] - counts[a]);
    const leader = ranked[0];
    if (counts[leader] * 2 > continuing || active.size === 1) {
      return { ...base, winner_place_id: leader };
    }

    const zeros = [...active].filter((id) => counts[id] === 0);
    let out;
    if (zeros.length && zeros.length < active.size) {
      out = zeros;
    } else {
      const min = Math.min(...[...active].map((id) => counts[id]));
      let tied = [...active].filter((id) => counts[id] === min);
      if (tied.length > 1) {
        const fewest = Math.min(...tied.map((id) => mentions[id]));
        const byMentions = tied.filter((id) => mentions[id] === fewest);
        if (byMentions.length === 1) {
          round.tie_break = { method: 'mentions', among: tied };
          tied = byMentions;
        } else {
          // Sorted first so the same random draw always means the same place
          // regardless of Set iteration order -- makes tests deterministic.
          byMentions.sort((a, b) => a - b);
          round.tie_break = { method: 'random', among: byMentions };
          tied = [byMentions[randomIndex(byMentions.length)]];
        }
      }
      out = tied;
    }

    round.eliminated = out;
    for (const id of out) active.delete(id);
  }
}

module.exports = { tally };
