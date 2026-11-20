<script setup>
/**
 * Result for one Friday Lunch round. Reads the frozen lunch_rounds.result
 * (services/lunchTally.js) -- never recomputes, so what's shown is exactly
 * what decided it. Counts only; who voted for what isn't in the API at all.
 *
 * Two shapes: `method: 'points'` (3/2/1, current) shows a standings table;
 * anything older is a ranked-choice result from before the switch (Nov
 * 2026) and keeps its round-by-round table, since that's how it was decided.
 */
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true }, // GET /lunch/rounds/:id or /current shape
});

const result = computed(() => props.state.round.result || { rounds: [] });
const rounds = computed(() => result.value.rounds || []);
const nameOf = computed(() => Object.fromEntries(props.state.places.map((p) => [p.id, p.name])));
const winnerId = computed(() => props.state.round.winner_place_id);

// Round index (0-based) each place was eliminated in; the winner and anyone
// still standing at the end get Infinity so they sort to the top.
const outIn = computed(() => {
  const map = {};
  rounds.value.forEach((r, i) => { for (const id of r.eliminated || []) map[id] = i; });
  return map;
});

const rows = computed(() => {
  const last = rounds.value[rounds.value.length - 1];
  return props.state.places
    .map((p) => ({ id: p.id, name: p.name, out: outIn.value[p.id] ?? Infinity }))
    .sort((a, b) => {
      if (a.id === winnerId.value) return -1;
      if (b.id === winnerId.value) return 1;
      if (a.out !== b.out) return b.out - a.out;
      return (last?.counts?.[b.id] ?? 0) - (last?.counts?.[a.id] ?? 0);
    });
});

const listNames = (ids) => ids.map((id) => nameOf.value[id] || '?').join(' and ');

const notes = computed(() => rounds.value
  .map((r, i) => {
    if (!r.tie_break) return null;
    const gone = nameOf.value[r.eliminated[0]] || '?';
    const among = listNames(r.tie_break.among);
    return r.tie_break.method === 'mentions'
      ? `Round ${i + 1}: ${among} tied for last. ${gone} was on the fewest ballots overall, so it went out.`
      : `Round ${i + 1}: ${among} tied for last and were on the same number of ballots. ${gone} was eliminated at random.`;
  })
  .filter(Boolean));

// --- points (current) ------------------------------------------------------
const isPoints = computed(() => result.value.method === 'points');
const pointsByRank = computed(() => result.value.points_by_rank || [3, 2, 1]);
const RANK_LABEL = ['1st', '2nd', '3rd'];
// Standings arrive sorted best-first; places added to the result before
// any ballots (none today) would just be missing, so fall back to the list.
const standings = computed(() => {
  const list = result.value.standings || [];
  const seen = new Set(list.map((s) => s.place_id));
  const missing = props.state.places
    .filter((p) => !seen.has(p.id))
    .map((p) => ({ place_id: p.id, points: 0, ranks: pointsByRank.value.map(() => 0) }));
  return [...list, ...missing];
});
// Runoffs score [1]: pick one, one vote each (migration 095).
const isRunoff = computed(() => isPoints.value && pointsByRank.value.length === 1);
const pendingTie = computed(() => result.value.tie_break?.method === 'pending');
const pointsNote = computed(() => {
  const tb = result.value.tie_break;
  if (!tb || tb.method === 'pending') return null;
  const among = listNames(tb.among);
  const winner = nameOf.value[winnerId.value] || '?';
  if (tb.method === 'rank_count') {
    return `${among} tied on points. ${winner} had more ${RANK_LABEL[tb.rank - 1]}-choice votes, so it won.`;
  }
  if (isRunoff.value) return `${among} tied on votes. ${winner} was picked at random.`;
  return `${among} tied on points and on every choice count. ${winner} was picked at random.`;
});

// --- ranked choice (results stored before the switch) ---------------------
const totalExhausted = computed(() => rounds.value[rounds.value.length - 1]?.exhausted || 0);
</script>

<template>
  <div>
    <div class="lunch-winner">
      <div class="muted small">{{ pendingTie ? 'Result' : 'Winner' }}</div>
      <div v-if="pendingTie" class="lunch-winner-name">Tie: {{ listNames(result.tie_break.among) }}</div>
      <div v-else class="lunch-winner-name">{{ nameOf[winnerId] || 'No winner' }}</div>
      <div class="muted small">
        <template v-if="result.reason === 'single_place'">Only one place was on the list, so there was no vote.</template>
        <template v-else-if="result.reason === 'no_ballots'">Nobody voted this week.</template>
        <template v-else-if="result.reason === 'no_places'">Nothing was on the list.</template>
        <template v-else-if="pendingTie">
          {{ result.total_ballots }} vote{{ result.total_ballots === 1 ? '' : 's' }}
          · waiting on an admin to pick at random
        </template>
        <template v-else-if="isRunoff">
          {{ result.total_ballots }} vote{{ result.total_ballots === 1 ? '' : 's' }}
          · {{ standings[0]?.points || 0 }} for the winner
        </template>
        <template v-else-if="isPoints">
          {{ result.total_ballots }} ballot{{ result.total_ballots === 1 ? '' : 's' }}
          · {{ standings[0]?.points || 0 }} points
        </template>
        <template v-else>
          {{ result.total_ballots }} ballot{{ result.total_ballots === 1 ? '' : 's' }}
          · ranked choice, decided in {{ rounds.length }} round{{ rounds.length === 1 ? '' : 's' }}
        </template>
      </div>
    </div>

    <div v-if="isRunoff && result.total_ballots" class="lunch-results-table-wrap">
      <table class="lunch-results-table">
        <thead><tr><th>Place</th><th class="right">Votes</th></tr></thead>
        <tbody>
          <tr v-for="s in standings" :key="s.place_id" :class="{ winner: s.place_id === winnerId }">
            <td>{{ nameOf[s.place_id] || '?' }}</td>
            <td class="right"><strong>{{ s.points }}</strong></td>
          </tr>
        </tbody>
      </table>
      <p class="muted small" style="margin: 8px 0 0">Runoff: everyone picks one, and most votes wins.</p>
      <p v-if="pointsNote" class="small" style="margin: 6px 0 0">{{ pointsNote }}</p>
    </div>

    <div v-else-if="isPoints && result.total_ballots" class="lunch-results-table-wrap">
      <table class="lunch-results-table">
        <thead>
          <tr>
            <th>Place</th>
            <th class="right">Points</th>
            <th v-for="(p, i) in pointsByRank" :key="i" class="right">{{ RANK_LABEL[i] }} ({{ p }} pt{{ p === 1 ? '' : 's' }})</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in standings" :key="s.place_id" :class="{ winner: s.place_id === winnerId }">
            <td>{{ nameOf[s.place_id] || '?' }}</td>
            <td class="right"><strong>{{ s.points }}</strong></td>
            <td v-for="(n, i) in s.ranks" :key="i" class="right" :class="{ muted: !n }">{{ n }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small" style="margin: 8px 0 0">
        Each ballot gives {{ pointsByRank.join(' / ') }} points to its 1st / 2nd / 3rd choice.
        The rank columns are how many people put a place there.
      </p>
      <p v-if="pointsNote" class="small" style="margin: 6px 0 0">{{ pointsNote }}</p>
      <p v-if="result.recounted_at" class="muted small" style="margin: 6px 0 0">
        Recounted with points on {{ new Date(result.recounted_at).toLocaleString() }}. It was first counted with ranked choice{{
          result.recounted_from?.winner_place_id && result.recounted_from.winner_place_id !== winnerId
            ? `, which picked ${nameOf[result.recounted_from.winner_place_id] || '?'}` : '' }}.
      </p>
    </div>

    <div v-else-if="rounds.length" class="lunch-results-table-wrap">
      <table class="lunch-results-table">
        <thead>
          <tr>
            <th>Place</th>
            <th class="right" title="Ballots that ranked this place anywhere: 1st, 2nd or 3rd">On ballots</th>
            <th v-for="(r, i) in rounds" :key="i" class="right">Round {{ i + 1 }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" :class="{ winner: row.id === winnerId }">
            <td>{{ row.name }}</td>
            <td class="right muted">{{ result.mentions?.[row.id] ?? 0 }}</td>
            <td v-for="(r, i) in rounds" :key="i" class="right">
              <template v-if="r.counts[row.id] !== undefined">
                <span :class="{ 'lunch-out': (r.eliminated || []).includes(row.id) }">{{ r.counts[row.id] }}</span>
              </template>
              <span v-else class="muted">·</span>
            </td>
          </tr>
          <tr v-if="totalExhausted" class="muted">
            <td>Ballots with no choices left</td>
            <td />
            <td v-for="(r, i) in rounds" :key="i" class="right">{{ r.exhausted }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small" style="margin: 8px 0 0">
        <strong>On ballots</strong> is how many people ranked a place at all (1st, 2nd or 3rd).
        The round columns are different: each ballot counts once per round, for its highest-ranked
        place still in the running. Round 1 is first choices only, so a place lots of people ranked
        2nd can show 0 there. Its votes count once the places ranked above it are out.
        Struck-through numbers were last that round and went out; · means already out.
        <template v-if="totalExhausted">
          A ballot stops counting once all of its picks are out.
        </template>
      </p>
      <p v-for="n in notes" :key="n" class="small" style="margin: 6px 0 0">{{ n }}</p>
    </div>
  </div>
</template>

<style scoped>
.lunch-winner { margin-bottom: 16px; }
.lunch-winner-name { font-size: 28px; font-weight: 700; line-height: 1.2; color: var(--accent); }
.lunch-results-table-wrap { overflow-x: auto; }
.lunch-results-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.lunch-results-table th, .lunch-results-table td {
  padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.lunch-results-table th { font-size: 12px; font-weight: 600; color: var(--text-dim); text-align: left; }
.lunch-results-table th.right, .lunch-results-table td.right { text-align: right; }
.lunch-results-table tr.winner td { font-weight: 700; color: var(--accent); }
.lunch-out { text-decoration: line-through; color: var(--red); }
</style>
