/**
 * Unit tests for the Friday Lunch points tally (services/lunchTally.js):
 * 1st = 3, 2nd = 2, 3rd = 1. Pure -- no database or running API needed.
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
const pts = (r, id) => r.standings.find((s) => s.place_id === id).points;
const A = 1; const B = 2; const C = 3; const D = 4;

test('scores 3/2/1 and the most points wins', () => {
  const r = tally({ placeIds: [A, B, C], ballots: [[A, B, C], [B, C], [C]] });
  assert.equal(pts(r, A), 3);
  assert.equal(pts(r, B), 5); // 2 + 3
  assert.equal(pts(r, C), 6); // 1 + 2 + 3
  assert.equal(r.winner_place_id, C);
  assert.equal(r.tie_break, null);
});

test('a broadly liked 2nd choice beats a polarizing favourite', () => {
  // A: 3 firsts (9). B: everyone's 2nd (5 x 2 = 10) -- the case ranked
  // choice threw out.
  const r = tally({
    placeIds: [A, B, C],
    ballots: [...rep(3, [A, B]), ...rep(2, [C, B])],
  });
  assert.equal(r.winner_place_id, B);
  assert.equal(r.standings[0].place_id, B);
});

test('places nobody ranked are listed with 0, never dropped', () => {
  const r = tally({ placeIds: [A, B, D], ballots: [[A], [B, A]] });
  assert.equal(r.standings.length, 3);
  assert.equal(pts(r, D), 0);
  assert.deepEqual(r.standings.map((s) => s.place_id), [A, B, D]); // A 5, B 3, D 0
});

test('points tie goes to more 1st-choice votes', () => {
  // A: 3 + 3 = 6 (two 1sts). B: 2 + 2 + 2 = 6 (zero 1sts).
  const r = tally({ placeIds: [A, B, C], ballots: [[A, B], [A, B], [C, B]] });
  assert.equal(pts(r, A), 6);
  assert.equal(pts(r, B), 6);
  assert.equal(r.winner_place_id, A);
  assert.equal(r.tie_break.method, 'rank_count');
  assert.equal(r.tie_break.rank, 1);
});

test('then more 2nd-choice votes', () => {
  const E = 5;
  // A: 3 + 1 + 1 = 5 (one 1st, no 2nds). B: 3 + 2 = 5 (one 1st, one 2nd).
  const r = tally({
    placeIds: [A, B, C, D, E],
    ballots: [[A], [B], [C, B, A], [D, E, A]],
  });
  assert.equal(pts(r, A), 5);
  assert.equal(pts(r, B), 5);
  assert.equal(r.winner_place_id, B);
  assert.equal(r.tie_break.method, 'rank_count');
  assert.equal(r.tie_break.rank, 2);
  assert.deepEqual(r.tie_break.among.sort(), [A, B]);
});

test('full tie falls to random, using the injected picker', () => {
  const first = tally({ placeIds: [A, B], ballots: [[A, B], [B, A]], randomIndex: () => 0 });
  assert.equal(first.tie_break.method, 'random');
  assert.deepEqual(first.tie_break.among, [A, B]);
  assert.equal(first.winner_place_id, A);
  const second = tally({ placeIds: [A, B], ballots: [[A, B], [B, A]], randomIndex: () => 1 });
  assert.equal(second.winner_place_id, B);
});

test('a tie below first place needs no tie-break', () => {
  const r = tally({ placeIds: [A, B, C], ballots: [[A], [A], [B], [C]] });
  assert.equal(r.winner_place_id, A);
  assert.equal(r.tie_break, null);
});

test('no ballots / no places give no winner', () => {
  assert.equal(tally({ placeIds: [A, B], ballots: [] }).reason, 'no_ballots');
  assert.equal(tally({ placeIds: [], ballots: [[A]] }).reason, 'no_places');
});

test('ignores unknown ids, repeats, and anything past 3rd', () => {
  const r = tally({ placeIds: [A, B, C, D], ballots: [[99, A, A, B], [B, C, D, A]] });
  assert.equal(r.total_ballots, 2);
  assert.equal(pts(r, A), 3); // first ballot: A 3, B 2 ; second: A is 4th -> 0
  assert.equal(pts(r, B), 5);
  assert.equal(r.winner_place_id, B);
});

console.log(`\n${passed} passed`);
