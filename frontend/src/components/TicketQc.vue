<script setup>
/**
 * QC rounds (PLAN §6, migration 021). Rigor tiers are retired: every
 * ticket now follows the same standardized round progression and the same
 * fixed pass rule (2 rounds, signed off by 2 different reviewers — see
 * routes/qc.js's REQUIRED_ROUNDS/REQUIRE_DISTINCT_REVIEWERS). There's
 * nothing to pick when starting a round — the backend always resolves the
 * next round number and its standardized template for this ticket's
 * instrument family, so "Start round N" is the only control.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const props = defineProps({
  ticket: { type: Object, required: true },
});
const emit = defineEmits(['changed', 'task-created']);

const auth = useAuth();

const error = ref('');
const busy = ref(false);

// Checklist items are reference-only, not tracked completion state (see
// NOTES.md — that was deliberately removed in favor of the notes field
// below). Clicking one just gives it a focus/active highlight for this
// viewing session, nothing saved — a plain, local Set of "round id ::
// item index" strings, reset on reload like any other transient UI state.
const activeItems = ref(new Set());
function toggleItem(checkId, index) {
  const key = `${checkId}:${index}`;
  const next = new Set(activeItems.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  activeItems.value = next;
}

const checks = computed(() => props.ticket.qc_checks || []);

// Q5: "what needs doing before this passes" — one draft string per open
// round, keyed by check id (a plain object inside a ref stays reactive for
// property-level mutation, same as activeItems' Set above just without
// needing a full replace each time).
const issueDrafts = ref({});

async function startRound() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/qc/checks', { ticket_id: props.ticket.id });
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function saveNotes(check, value) {
  try {
    await api.patch(`/qc/checks/${check.id}`, { notes: value });
  } catch (err) {
    error.value = err.message;
  }
}

// Q5: "Fail this round" is gone — a round that turns up a problem doesn't
// get stamped failed anymore, it generates a task instead (reportIssue,
// below) and stays open/unsigned until whoever's doing the work comes back
// and approves it. qc_checks.passed = false is still something the schema
// and this route support (nothing stops a future caller from using it),
// there's simply no UI path to it here anymore — every sign-off from this
// panel passes.
async function approveRound(check) {
  error.value = '';
  busy.value = true;
  try {
    const result = await api.post(`/qc/checks/${check.id}/sign-off`, { passed: true });
    if (!result.ticket_qc_passed) {
      error.value = `Round signed off. Ticket still needs `
        + `${result.rounds_required - result.rounds_passed} more passing round(s)`
        + `${result.distinct_reviewers_required ? ' from a second reviewer' : ''}.`;
    }
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// Q5: creates a ticket_task instead of failing the round — the round
// itself is left alone (still open, still signable once the work's done),
// so nothing here touches qc_checks at all. Prefixed with the round number
// purely for context in the Tasks panel; TicketTasks.vue doesn't know or
// care where a task came from.
async function reportIssue(check) {
  const text = (issueDrafts.value[check.id] || '').trim();
  if (!text) return;
  error.value = '';
  busy.value = true;
  try {
    await api.post('/tasks', { ticket_id: props.ticket.id, title: `QC round ${check.round_number}: ${text}` });
    issueDrafts.value = { ...issueDrafts.value, [check.id]: '' };
    emit('task-created');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 4px">
      <h2 style="margin: 0">Quality control</h2>
      <div class="spacer" />
      <span v-if="ticket.qc_passed_at" class="pill green">QC passed</span>
      <span v-else-if="!ticket.qc_required" class="pill slate">QC not required</span>
      <span v-else class="pill amber">QC outstanding</span>
    </div>
    <p class="muted small" style="margin: 0 0 12px">
      Rounds always happen in order — Round 2 can't start before Round 1 is open, and each
      round's checklist is standardized for this instrument type. Every ticket needs 2 rounds
      passed, signed off by 2 different reviewers, to clear QC.
    </p>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-for="check in checks" :key="check.id" class="card tight" style="margin-bottom: 12px">
      <div class="row">
        <strong>Round {{ check.round_number }}</strong>
        <span class="muted small">{{ check.results.length }} item(s)</span>
        <div class="spacer" />
        <span v-if="check.signed_off_at" :class="['pill', check.passed ? 'green' : 'red']">
          {{ check.passed ? 'Passed' : 'Failed' }} — {{ check.reviewer_name }}
        </span>
      </div>

      <!-- Reference checklist — items carry no persisted completion state
           (see NOTES.md); a tech records what they actually found in the
           notes field below instead. Each item is a real, focusable
           button rather than static text, so it's clickable/tappable and
           keyboard-navigable while working down the list — clicking one
           just highlights it for this viewing session. -->
      <ul class="qc-checklist" style="margin-top: 10px">
        <li v-for="(r, i) in check.results" :key="i">
          <button
            type="button"
            :class="['qc-item', { active: activeItems.has(`${check.id}:${i}`) }]"
            @click="toggleItem(check.id, i)"
          >
            {{ r.label }}
            <span v-if="r.note" class="item-note">{{ r.note }}</span>
          </button>
        </li>
      </ul>

      <template v-if="!check.signed_off_at">
        <div class="field" style="margin-top: 12px">
          <label>Notes</label>
          <textarea
            :value="check.notes" style="min-height: 110px"
            placeholder="What did you check, and what did you find?"
            @change="saveNotes(check, $event.target.value)"
          />
        </div>
        <!-- Q5: an issue found here becomes a task, not a failed round —
             open to anyone (not just auth.isSenior below), same reasoning
             as TicketTasks.vue's own "assigning/completing day-to-day work
             isn't an admin-only action" — while approval still requires a
             senior tech/admin, unchanged from before this packet. -->
        <div class="field" style="margin-top: 12px">
          <label>Found something? Add it as a task</label>
          <div class="row">
            <input
              v-model="issueDrafts[check.id]" style="flex: 1"
              placeholder="e.g. Bass register still buzzing on E2"
              @keyup.enter="reportIssue(check)"
            />
            <button class="small" :disabled="busy || !issueDrafts[check.id]?.trim()" @click="reportIssue(check)">
              + Add
            </button>
          </div>
        </div>
        <div v-if="auth.isSenior" class="row" style="margin-top: 10px">
          <button class="primary" :disabled="busy" @click="approveRound(check)">
            Approve for next round
          </button>
        </div>
        <p v-else class="muted small">Sign-off requires senior tech or admin.</p>
      </template>
      <p v-else-if="check.notes" class="muted small" style="margin: 8px 0 0">{{ check.notes }}</p>
    </div>

    <div class="card tight">
      <div class="row">
        <h3 style="margin: 0">Round {{ checks.length + 1 }}</h3>
        <div class="spacer" />
        <button :disabled="busy" @click="startRound">Start round {{ checks.length + 1 }}</button>
      </div>
      <p class="muted small" style="margin: 8px 0 0">
        Pulls whatever checklist is standardized for round {{ checks.length + 1 }} on this
        instrument type (Settings → QC checklist templates) — blank if none is set up yet.
      </p>
    </div>
  </div>
</template>

<style scoped>
.qc-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  min-height: 0;
  padding: 3px 6px;
  border-radius: var(--radius);
}
.qc-item:hover { background: var(--surface-2); }
.qc-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.qc-item.active { background: rgba(212, 129, 63, 0.12); border-color: var(--accent-dim); }
</style>
