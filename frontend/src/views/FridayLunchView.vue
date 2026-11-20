<script setup>
/**
 * Friday Lunch -- the weekly company-lunch vote (More menu). One round per
 * Friday, moved along by an admin: suggestions (up to two each) -> admin
 * tidies the list -> ranked-choice voting (rank up to three) -> results.
 * Phase model: migration 094. Rules: backend services/fridayLunch.js.
 *
 * Anonymous by design: the API never sends anyone else's suggestions or
 * ballot, so this page can only ever show counts and your own entries.
 * Every write returns the refreshed round, so actions just replace `state`.
 */
import { ref, computed, watch, onMounted } from 'vue';
import api from '../api';
import { useAuth } from '../stores';
import LunchResults from '../components/LunchResults.vue';

const auth = useAuth();

const state = ref(null);
const loading = ref(true);
const busy = ref(false);
const error = ref('');

const round = computed(() => state.value?.round || null);
const phase = computed(() => round.value?.phase || null);
const places = computed(() => state.value?.places || []);
const limits = computed(() => state.value?.limits || { suggestions: 2, ranks: 3 });
const turnout = computed(() => state.value?.turnout || { suggesters: 0, voters: 0, eligible: 0 });
const isOpen = computed(() => ['suggesting', 'reviewing', 'voting'].includes(phase.value));

const PHASE_LABEL = {
  suggesting: 'Taking suggestions',
  reviewing: 'Finalizing the list',
  voting: 'Voting open',
  closed: 'Results',
  cancelled: 'Cancelled',
};

// lunch_date is a bare 'YYYY-MM-DD'; noon UTC keeps it on the right day
// whatever the device's timezone.
const friendlyDate = (d) => (d
  ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
  : '');

async function load() {
  error.value = '';
  try {
    state.value = await api.get('/lunch/current');
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** Runs a write; the response is the new round state. */
async function act(fn, { confirmText } = {}) {
  if (confirmText && !confirm(confirmText)) return;
  error.value = '';
  busy.value = true;
  try {
    const next = await fn();
    if (next) state.value = next;
    return true;
  } catch (err) {
    error.value = err.message;
    // A 409 usually means the round moved on under us (an admin opened
    // voting while this page sat open) -- show where things stand now.
    if (err.status === 409) await load();
    return false;
  } finally {
    busy.value = false;
  }
}

// --- suggestions -------------------------------------------------------
const newSuggestion = ref('');
const canSuggest = computed(() => phase.value === 'suggesting'
  && (state.value?.my_suggestions?.length || 0) < limits.value.suggestions);

async function submitSuggestion() {
  const name = newSuggestion.value.trim();
  if (!name) return;
  const ok = await act(() => api.post(`/lunch/rounds/${round.value.id}/suggestions`, { name }));
  if (ok) newSuggestion.value = '';
}
const withdrawSuggestion = (s) => act(() => api.del(`/lunch/suggestions/${s.id}`));

// --- ballot ------------------------------------------------------------
// Tap places in order of preference; tap a ranked one to take it off (the
// ones below it move up). Easier than three dropdowns on the shop iPad.
const ranking = ref([]);
const savedRanking = computed(() => state.value?.my_ballot?.choices || []);
watch(savedRanking, (saved) => { ranking.value = [...saved]; }, { immediate: true });

const rankOf = (id) => ranking.value.indexOf(id) + 1; // 0 = not ranked
function toggleRank(id) {
  const i = ranking.value.indexOf(id);
  if (i >= 0) ranking.value.splice(i, 1);
  else if (ranking.value.length < limits.value.ranks) ranking.value.push(id);
}
const ballotDirty = computed(() => ranking.value.join(',') !== savedRanking.value.join(','));
const ORDINAL = ['1st', '2nd', '3rd'];

const submitBallot = () => act(() => api.put(`/lunch/rounds/${round.value.id}/ballot`, { choices: ranking.value }));
const withdrawBallot = () => act(
  () => api.del(`/lunch/rounds/${round.value.id}/ballot`),
  { confirmText: 'Take back your vote?' },
);

// --- admin: rounds and phases --------------------------------------------
const startDate = ref('');
watch(() => state.value?.upcoming_friday, (d) => { if (d && !startDate.value) startDate.value = d; }, { immediate: true });

const startRound = () => act(
  () => api.post('/lunch/rounds', { lunch_date: startDate.value || undefined }),
  { confirmText: `Open Friday Lunch suggestions for ${friendlyDate(startDate.value)}? Everyone gets an email.` },
);

function setPhase(to) {
  const t = turnout.value;
  const prompts = {
    reviewing: 'Close suggestions so you can tidy the list? You can reopen them.',
    suggesting: 'Reopen suggestions?',
    voting: places.value.length === 1
      ? `Only ${places.value[0].name} is on the list, so it wins without a vote. Continue? Everyone gets an email.`
      : `Open voting on these ${places.value.length} places? The list locks, and everyone gets an email.`,
    closed: `Close voting and count? ${t.voters} of ${t.eligible} have voted. Everyone gets the result by email.`,
    cancelled: 'Cancel this week’s lunch vote? It can’t be reopened. You can start a new one afterwards.',
  };
  return act(() => api.post(`/lunch/rounds/${round.value.id}/phase`, { to }), { confirmText: prompts[to] });
}

// --- admin: list edits -------------------------------------------------
const canEditList = computed(() => auth.isAdmin && ['suggesting', 'reviewing'].includes(phase.value));
const newPlace = ref('');
const renaming = ref({}); // place id -> draft name while editing

async function addPlace() {
  const name = newPlace.value.trim();
  if (!name) return;
  const ok = await act(() => api.post(`/lunch/rounds/${round.value.id}/places`, { name }));
  if (ok) newPlace.value = '';
}
function startRename(p) { renaming.value = { ...renaming.value, [p.id]: p.name }; }
function cancelRename(p) { const { [p.id]: _, ...rest } = renaming.value; renaming.value = rest; }
async function saveRename(p) {
  const ok = await act(() => api.patch(`/lunch/places/${p.id}`, { name: renaming.value[p.id] }));
  if (ok) cancelRename(p);
}
function mergeInto(p, event) {
  const intoId = Number(event.target.value);
  event.target.value = '';
  if (!intoId) return;
  const target = places.value.find((x) => x.id === intoId);
  act(
    () => api.post(`/lunch/places/${p.id}/merge`, { into_place_id: intoId }),
    { confirmText: `Merge "${p.name}" into "${target?.name}"? Its suggestions move over.` },
  );
}
const removePlace = (p) => act(
  () => api.del(`/lunch/places/${p.id}`),
  { confirmText: `Remove "${p.name}" from the list?` },
);

// --- history -------------------------------------------------------------
const historyRows = ref([]);
const pastState = ref(null);
async function loadHistory() {
  try { historyRows.value = await api.get('/lunch/history'); } catch { /* non-essential */ }
}
async function openPast(row) {
  if (pastState.value?.round.id === row.id) { pastState.value = null; return; }
  error.value = '';
  try { pastState.value = await api.get(`/lunch/rounds/${row.id}`); } catch (err) { error.value = err.message; }
}
// A close moves this week into history.
watch(phase, (p, prev) => { if (prev && p !== prev && ['closed', 'cancelled'].includes(p)) loadHistory(); });

onMounted(() => { load(); loadHistory(); });
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Friday Lunch</h1>
        <p class="muted small" style="margin: 0">
          Suggest up to {{ limits.suggestions }} places, then rank up to {{ limits.ranks }}.
          Suggestions and votes are anonymous.
        </p>
      </div>
      <button class="small" :disabled="busy" @click="load">Refresh</button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div v-if="loading" class="empty">Loading…</div>

    <template v-else>
      <!-- This week's round ------------------------------------------- -->
      <div class="card" style="margin-bottom: 16px">
        <template v-if="round">
          <div class="row" style="margin-bottom: 12px">
            <h2 style="margin: 0">{{ friendlyDate(round.lunch_date) }}</h2>
            <span class="tag">{{ PHASE_LABEL[phase] }}</span>
            <span class="spacer" />
            <span v-if="phase === 'suggesting' || phase === 'reviewing'" class="muted small">
              {{ turnout.suggesters }} of {{ turnout.eligible }} have suggested
            </span>
            <span v-else-if="phase === 'voting'" class="muted small">
              {{ turnout.voters }} of {{ turnout.eligible }} have voted
            </span>
          </div>

          <!-- suggesting -->
          <template v-if="phase === 'suggesting'">
            <div class="lunch-section">
              <h3>Your suggestions</h3>
              <div v-if="!state.my_suggestions.length" class="muted small" style="margin-bottom: 10px">
                You haven't suggested anywhere yet.
              </div>
              <div v-for="s in state.my_suggestions" :key="s.id" class="row lunch-mine">
                <strong>{{ s.place_name }}</strong>
                <span v-if="s.place_name !== s.typed_name" class="muted small">(you typed “{{ s.typed_name }}”)</span>
                <span class="spacer" />
                <button class="small" :disabled="busy" @click="withdrawSuggestion(s)">Remove</button>
              </div>
              <form v-if="canSuggest" class="row nowrap" style="margin-top: 10px" @submit.prevent="submitSuggestion">
                <input v-model="newSuggestion" list="lunch-place-options" maxlength="80"
                  placeholder="Somewhere for lunch…" autocomplete="off" />
                <datalist id="lunch-place-options">
                  <option v-for="p in places" :key="p.id" :value="p.name" />
                </datalist>
                <button class="primary" type="submit" :disabled="busy || !newSuggestion.trim()">Suggest</button>
              </form>
              <p v-else class="muted small" style="margin: 10px 0 0">
                That's your {{ limits.suggestions }}. Remove one to suggest somewhere else.
              </p>
            </div>
            <div class="lunch-section">
              <h3>On the list so far</h3>
              <div v-if="!places.length" class="muted small">Nothing yet. Be the first.</div>
              <div v-else class="row">
                <span v-for="p in places" :key="p.id" class="tag lunch-chip">{{ p.name }}</span>
              </div>
              <p class="muted small" style="margin: 8px 0 0">
                Typing a name that's already here backs that place rather than adding it twice.
              </p>
            </div>
          </template>

          <!-- reviewing -->
          <template v-else-if="phase === 'reviewing'">
            <p class="muted" style="margin-top: 0">
              Suggestions are closed. Voting opens once the list is finalized.
            </p>
            <div class="row">
              <span v-for="p in places" :key="p.id" class="tag lunch-chip">{{ p.name }}</span>
            </div>
          </template>

          <!-- voting -->
          <template v-else-if="phase === 'voting'">
            <p class="muted small" style="margin-top: 0">
              Tap places in order: your favourite first. Rank 1 to {{ limits.ranks }}.
              Tap a ranked place again to take it off. You can change your vote until voting closes.
            </p>
            <div class="lunch-ballot">
              <button
                v-for="p in places" :key="p.id" type="button"
                :class="['lunch-option', { ranked: rankOf(p.id) }]"
                :disabled="busy || (!rankOf(p.id) && ranking.length >= limits.ranks)"
                @click="toggleRank(p.id)"
              >
                <span class="lunch-rank">{{ rankOf(p.id) ? ORDINAL[rankOf(p.id) - 1] : '' }}</span>
                <span>{{ p.name }}</span>
              </button>
            </div>
            <div class="row" style="margin-top: 14px">
              <button class="primary" :disabled="busy || !ranking.length || !ballotDirty" @click="submitBallot">
                {{ state.my_ballot ? 'Update my vote' : 'Cast my vote' }}
              </button>
              <button v-if="ballotDirty && state.my_ballot" class="small" :disabled="busy" @click="ranking = [...savedRanking]">
                Undo changes
              </button>
              <span v-if="state.my_ballot && !ballotDirty" class="small" style="color: var(--green)">✓ Your vote is in</span>
              <span class="spacer" />
              <button v-if="state.my_ballot" class="small" :disabled="busy" @click="withdrawBallot">Withdraw my vote</button>
            </div>
          </template>

          <!-- closed -->
          <LunchResults v-else-if="phase === 'closed'" :state="state" />

          <!-- cancelled -->
          <p v-else-if="phase === 'cancelled'" class="muted" style="margin: 0">
            No lunch vote this week.
          </p>
        </template>

        <div v-else class="muted">No Friday Lunch vote has been run yet.</div>

        <p v-if="!auth.isAdmin && !isOpen" class="muted small" style="margin: 12px 0 0">
          An admin opens next week's suggestions.
        </p>
      </div>

      <!-- Admin controls ------------------------------------------------- -->
      <div v-if="auth.isAdmin" class="card" style="margin-bottom: 16px">
        <h2>Admin</h2>

        <div v-if="!isOpen" class="row nowrap">
          <div class="field" style="margin: 0; max-width: 220px">
            <label>Lunch date</label>
            <input v-model="startDate" type="date" />
          </div>
          <div class="field" style="margin: 0; flex: none">
            <label>&nbsp;</label>
            <button class="primary" :disabled="busy || !startDate" @click="startRound">Open suggestions</button>
          </div>
        </div>

        <template v-else>
          <div v-if="canEditList" class="lunch-section">
            <h3>The list</h3>
            <p class="muted small" style="margin-top: 0">
              Merge duplicates before voting. Two spellings of one place would split its votes.
              Counts are how many people suggested each place; nobody's name is attached.
            </p>
            <div v-if="!places.length" class="muted small" style="margin-bottom: 10px">Nothing suggested yet.</div>
            <div v-for="p in places" :key="p.id" class="row lunch-admin-place">
              <template v-if="renaming[p.id] !== undefined">
                <form class="row nowrap" style="flex: 1" @submit.prevent="saveRename(p)">
                  <input v-model="renaming[p.id]" maxlength="80" />
                  <button class="small primary" type="submit" :disabled="busy">Save</button>
                  <button class="small" type="button" @click="cancelRename(p)">Cancel</button>
                </form>
              </template>
              <template v-else>
                <strong>{{ p.name }}</strong>
                <span class="muted small">
                  {{ p.suggestion_count }} suggestion{{ p.suggestion_count === 1 ? '' : 's' }}{{ p.added_by_admin ? ' · added by admin' : '' }}
                </span>
                <span class="spacer" />
                <button class="small" :disabled="busy" @click="startRename(p)">Rename</button>
                <select v-if="places.length > 1" class="lunch-merge" :disabled="busy" @change="mergeInto(p, $event)">
                  <option value="">Merge into…</option>
                  <option v-for="o in places.filter((x) => x.id !== p.id)" :key="o.id" :value="o.id">{{ o.name }}</option>
                </select>
                <button class="small danger" :disabled="busy" @click="removePlace(p)">Remove</button>
              </template>
            </div>
            <form class="row nowrap" style="margin-top: 10px" @submit.prevent="addPlace">
              <input v-model="newPlace" maxlength="80" placeholder="Add a place yourself…" />
              <button class="small" type="submit" :disabled="busy || !newPlace.trim()">Add</button>
            </form>
          </div>

          <div class="row">
            <template v-if="phase === 'suggesting'">
              <button class="primary" :disabled="busy" @click="setPhase('reviewing')">Close suggestions</button>
              <button :disabled="busy || !places.length" @click="setPhase('voting')">Skip review, open voting</button>
            </template>
            <template v-else-if="phase === 'reviewing'">
              <button class="primary" :disabled="busy || !places.length" @click="setPhase('voting')">Open voting</button>
              <button :disabled="busy" @click="setPhase('suggesting')">Reopen suggestions</button>
            </template>
            <template v-else-if="phase === 'voting'">
              <button class="primary" :disabled="busy" @click="setPhase('closed')">Close voting and count</button>
            </template>
            <span class="spacer" />
            <button class="small danger" :disabled="busy" @click="setPhase('cancelled')">Cancel this week</button>
          </div>
        </template>
      </div>

      <!-- History ---------------------------------------------------------- -->
      <div class="card">
        <h2>Past Fridays</h2>
        <div v-if="!historyRows.length" class="muted small">Nothing yet.</div>
        <div v-for="h in historyRows" :key="h.id" class="lunch-history-row">
          <button type="button" class="lunch-history-toggle" @click="openPast(h)">
            <span class="muted small lunch-history-date">{{ friendlyDate(h.lunch_date) }}</span>
            <strong v-if="h.phase === 'closed'">{{ h.winner_name || 'No winner' }}</strong>
            <span v-else class="muted">Cancelled</span>
            <span class="spacer" />
            <span v-if="h.phase === 'closed'" class="muted small">
              {{ h.ballots }} vote{{ h.ballots === 1 ? '' : 's' }} {{ pastState?.round.id === h.id ? '▴' : '▾' }}
            </span>
          </button>
          <div v-if="pastState?.round.id === h.id && h.phase === 'closed'" style="padding: 8px 0 14px">
            <LunchResults :state="pastState" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lunch-section { margin-bottom: 18px; }
.lunch-section h3 { font-size: 14px; margin: 0 0 8px; }
.lunch-mine { padding: 6px 0; border-bottom: 1px solid var(--border); }
.lunch-chip { font-size: 13px; padding: 4px 10px; color: var(--text); }

.lunch-ballot { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.lunch-option {
  display: flex; align-items: center; gap: 10px; text-align: left;
  min-height: 52px; font-size: 15px;
}
.lunch-option.ranked { border-color: var(--accent); background: rgba(212, 129, 63, 0.12); }
.lunch-rank {
  flex: none; width: 34px; height: 28px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; border: 1px dashed var(--border); color: var(--accent);
}
.lunch-option.ranked .lunch-rank { border: none; background: var(--accent); color: #16181d; }

.lunch-admin-place { padding: 6px 0; border-bottom: 1px solid var(--border); }
.lunch-merge { width: auto; min-height: 32px; padding: 4px 8px; font-size: 13px; }

.lunch-history-row { border-bottom: 1px solid var(--border); }
.lunch-history-row:last-child { border-bottom: none; }
.lunch-history-toggle {
  display: flex; align-items: center; gap: 12px; width: 100%;
  background: none; border: none; border-radius: 0; padding: 10px 0; text-align: left;
}
.lunch-history-toggle:hover:not(:disabled) { background: none; }
.lunch-history-date { min-width: 190px; }
</style>
