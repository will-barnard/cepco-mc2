/**
 * Unit tests for the Friday Lunch ranked-choice tally (services/lunchTally.js).
 * Pure -- no database or running API needed.
 */
import { createRequire } from 'module';
import assert from 'assert/strict';

const require = createRequire(import.meta.url);
const { tally } = require('../src/services/lunchTally.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`); process.exitCode = 1;
  }
}
const rep = (n, ballot) => Array.from({ length: n }, () => ballot);
const A = 1; const B = 2; const C = 3; const D = 4;

test('outright majority wins in round 1', () => {
  const r = tally({ placeIds: [A, B, C], ballots: [...rep(3, [A]), [B], [C, B]] });
  assert.equal(r.winner_place_id, A);
  assert.equal(r.rounds.length, 1);
});

test('transfers decide it (classic IRV reversal of plurality)', () => {
  // A leads on first choices 4-3-2, but C's voters prefer B -> B wins 5-4.
  const r = tally({ placeIds: [A, B, C], ballots: [...rep(4, [A]), ...rep(3, [B]), ...rep(2, [C, B])] });
  assert.equal(r.winner_place_id, B);
  assert.deepEqual(r.rounds[0].eliminated, [C]);
  assert.equal(r.rounds[1].counts[B], 5);
});

test('exhausted ballots stop counting; majority is of continuing ballots', () => {
  // Round 1: A3 B2 C2 D1 -> D out, its one ballot has nowhere to go.
  // Round 2: B and C tie for last on everything -> random (pinned to B).
  // Round 3: B's [B, A] moves to A, [B] exhausts too -> A 4 of 6 continuing.
  const r = tally({
    placeIds: [A, B, C, D],
    ballots: [...rep(3, [A]), [B], [B, A], [C], [C], [D]],
    randomIndex: () => 0,
  });
  assert.equal(r.rounds[1].exhausted, 1);
  assert.deepEqual(r.rounds[1].eliminated, [B]);
  assert.equal(r.rounds[2].counts[A], 4);
  assert.equal(r.rounds[2].continuing, 6);
  assert.equal(r.winner_place_id, A);
});

test('50/50 final: count-back first, random only if mentions also tie', () => {
  // C out in round 1 and its ballot exhausts; A2 B2 left.
  // B is on three ballots, A on two -> A out on count-back.
  const r = tally({ placeIds: [A, B, C], ballots: [[A], [A, B], [B], [B], [C]] });
  assert.equal(r.rounds[1].tie_break.method, 'mentions');
  assert.equal(r.winner_place_id, B);
  // Same shape with equal mentions -> random.
  const r2 = tally({ placeIds: [A, B, C], ballots: [[A], [A], [B], [B], [C]], randomIndex: () => 1 });
  assert.equal(r2.rounds[1].tie_break.method, 'random');
  assert.equal(r2.winner_place_id, A);
});

test('count-back tie-break is recorded', () => {
  // first choices: A2, B1, C1. B mentioned 1x, C mentioned 2x -> B out by mentions.
  const r = tally({ placeIds: [A, B, C], ballots: [[A, C], [A], [B], [C]] });
  assert.equal(r.rounds[0].tie_break.method, 'mentions');
  assert.deepEqual(r.rounds[0].eliminated, [B]);
});

test('full tie falls to random, using the injected picker', () => {
  const pickFirst = tally({ placeIds: [A, B], ballots: [[A], [B]], randomIndex: () => 0 });
  assert.equal(pickFirst.rounds[0].tie_break.method, 'random');
  assert.deepEqual(pickFirst.rounds[0].eliminated, [A]);
  assert.equal(pickFirst.winner_place_id, B);
  const pickSecond = tally({ placeIds: [A, B], ballots: [[A], [B]], randomIndex: () => 1 });
  assert.equal(pickSecond.winner_place_id, A);
});

test('zero-vote places are dropped together', () => {
  const r = tally({ placeIds: [A, B, C, D], ballots: [[A], [A], [B]] });
  assert.equal(r.winner_place_id, A);
  assert.equal(r.rounds.length, 1); // A has 2/3 already
  const r2 = tally({ placeIds: [A, B, C, D], ballots: [[A], [B], [B, A], [A]] });
  assert.deepEqual(r2.rounds[0].eliminated.sort(), [C, D]);
});

test('no ballots / no places give no winner', () => {
  assert.equal(tally({ placeIds: [A, B], ballots: [] }).reason, 'no_ballots');
  assert.equal(tally({ placeIds: [], ballots: [[A]] }).reason, 'no_places');
});

test('ignores unknown ids and repeats inside a ballot', () => {
  const r = tally({ placeIds: [A, B], ballots: [[99, A, A], [B, 98], [A]] });
  assert.equal(r.total_ballots, 3);
  assert.equal(r.winner_place_id, A);
});

console.log(`\n${passed} passed`);
