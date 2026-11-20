<script setup>
/**
 * Round-by-round ranked-choice result for one Friday Lunch round. Reads the
 * frozen lunch_rounds.result (services/lunchTally.js) -- never recomputes,
 * so what's shown is exactly what decided it. Counts only; no names of who
 * voted for what exist anywhere in the API.
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

const totalExhausted = computed(() => rounds.value[rounds.value.length - 1]?.exhausted || 0);
</script>

<template>
  <div>
    <div class="lunch-winner">
      <div class="muted small">Winner</div>
      <div class="lunch-winner-name">{{ nameOf[winnerId] || 'No winner' }}</div>
      <div class="muted small">
        <template v-if="result.reason === 'single_place'">Only one place was on the list, so there was no vote.</template>
        <template v-else-if="result.reason === 'no_ballots'">Nobody voted this week.</template>
        <template v-else-if="result.reason === 'no_places'">Nothing was on the list.</template>
        <template v-else>
          {{ result.total_ballots }} ballot{{ result.total_ballots === 1 ? '' : 's' }}
          · decided in {{ rounds.length }} round{{ rounds.length === 1 ? '' : 's' }}
        </template>
      </div>
    </div>

    <div v-if="rounds.length" class="lunch-results-table-wrap">
      <table class="lunch-results-table">
        <thead>
          <tr>
            <th>Place</th>
            <th v-for="(r, i) in rounds" :key="i" class="right">Round {{ i + 1 }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" :class="{ winner: row.id === winnerId }">
            <td>{{ row.name }}</td>
            <td v-for="(r, i) in rounds" :key="i" class="right">
              <template v-if="r.counts[row.id] !== undefined">
                <span :class="{ 'lunch-out': (r.eliminated || []).includes(row.id) }">{{ r.counts[row.id] }}</span>
              </template>
              <span v-else class="muted">·</span>
            </td>
          </tr>
          <tr v-if="totalExhausted" class="muted">
            <td>Ballots with no choices left</td>
            <td v-for="(r, i) in rounds" :key="i" class="right">{{ r.exhausted }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small" style="margin: 8px 0 0">
        Each round, every ballot counts for its highest-ranked place still in the running.
        Struck-through numbers were last that round and went out.
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
