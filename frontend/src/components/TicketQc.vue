<script setup>
/**
 * QC rounds (PLAN §6, migration 021; per-round signoffs reworked for Q6;
 * checklist grouped by service category for Q4). Rigor tiers are retired:
 * every ticket follows the same standardized round progression, and the
 * ticket overall needs 2 rounds passed (see routes/qc.js's
 * REQUIRED_ROUNDS). There's nothing to pick when starting a round — the
 * backend always resolves the next round number and its standardized
 * template for this ticket's instrument family, so "Start round N" is the
 * only control.
 *
 * Q6: how many people need to sign a given round is per-round now
 * (check.required_signoffs, from the round's template) — Setup QC needs
 * one, Final Assembly QC needs two distinct techs. check.signoffs is the
 * list recorded so far; the round stays open, collecting more, until it
 * crosses that count.
 *
 * Q4: supersedes this file's earlier "reference-only checklist" decision.
 * Each item now carries a category (Tuning/Action/Electronics/Cosmetics —
 * the boss's chosen coarse grouping, routes/qc.js's QC_ITEM_CATEGORIES)
 * and a `checked` flag that's actually persisted (a PATCH per toggle,
 * same endpoint the notes field already used), grouped under category
 * headings instead of one flat list. An item with no category (every
 * pre-Q4 template item, until someone assigns one from Settings -> QC
 * templates) falls into a catch-all "General" group rather than vanishing.
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

const QC_CATEGORY_LABELS = {
  tuning: 'Tuning', action: 'Action', electronics: 'Electronics', cosmetics: 'Cosmetics',
};
const QC_CATEGORY_ORDER = ['tuning', 'action', 'electronics', 'cosmetics', null];

/** Group a round's results by category for display, in a fixed order so
 * every round's checklist reads the same way regardless of how its items
 * happen to be ordered in the template. Items with no category (not yet
 * assigned one in Settings -> QC templates) land in a trailing "General"
 * group instead of being dropped. */
function groupedResults(check) {
  const groups = new Map(QC_CATEGORY_ORDER.map((c) => [c, []]));
  (check.results || []).forEach((r, i) => {
    const key = QC_CATEGORY_LABELS[r.category] ? r.category : null;
    groups.get(key).push({ ...r, index: i });
  });
  return QC_CATEGORY_ORDER
    .map((c) => ({ key: c, label: QC_CATEGORY_LABELS[c] || 'General', items: groups.get(c) }))
    .filter((g) => g.items.length);
}

/** Q4: toggling an item now persists — a full replacement of check.results
 * with just this one item's `checked` flipped, same "PATCH /checks/:id
 * already accepts a replacement array" mechanism saveNotes() below uses
 * for the notes field. Open to anyone still working the round (same as
 * notes/reportIssue), not gated to senior — ticking off what's been
 * checked isn't a sign-off. */
async function toggleItem(check, index) {
  error.value = '';
  const results = check.results.map((r, i) => (i === index ? { ...r, checked: !r.checked } : r));
  try {
    await api.patch(`/qc/checks/${check.id}`, { results });
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
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
/** Whether the signed-in tech has already signed this round — the button
 * below hides once true so nobody accidentally re-signs their own row
 * (harmless — routes/qc.js upserts — but confusing to see re-offered). */
function alreadySigned(check) {
  return (check.signoffs || []).some((s) => s.reviewer_id === auth.user?.id);
}

async function approveRound(check) {
  error.value = '';
  busy.value = true;
  try {
    const result = await api.post(`/qc/checks/${check.id}/sign-off`, { passed: true });
    if (!result.round_closed) {
      error.value = `Signature recorded — ${result.signoffs_recorded} of `
        + `${result.signoffs_required} needed to close this round.`;
    } else if (!result.ticket_qc_passed) {
      error.value = `Round signed off. Ticket still needs `
        + `${result.rounds_required - result.rounds_passed} more passing round(s).`;
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
      passed to clear QC; how many people need to sign each round (1 or 2) depends on that
      round's template.
    </p>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-for="check in checks" :key="check.id" class="card tight" style="margin-bottom: 12px">
      <div class="row">
        <strong>Round {{ check.round_number }}</strong>
        <span class="muted small">{{ check.results.length }} item(s)</span>
        <div class="spacer" />
        <span v-if="check.signed_off_at" :class="['pill', check.passed ? 'green' : 'red']">
          {{ check.passed ? 'Passed' : 'Failed' }}
          — {{ (check.signoffs || []).map((s) => s.reviewer_name).join(', ') || check.reviewer_name }}
        </span>
        <span v-else-if="check.required_signoffs > 1" class="pill amber">
          {{ (check.signoffs || []).filter((s) => s.passed).length }} of {{ check.required_signoffs }} signed
        </span>
      </div>

      <!-- Q4: grouped by service category (Tuning/Action/Electronics/
           Cosmetics), each item a real toggle button whose checked state
           is actually persisted (routes/qc.js) rather than a reload-reset
           highlight — a tech records *what* they found in the notes field
           below, this just tracks which checks were done. -->
      <div v-for="group in groupedResults(check)" :key="group.key || 'general'" style="margin-top: 10px">
        <p class="muted small" style="margin: 0 0 2px; text-transform: uppercase; letter-spacing: .04em">
          {{ group.label }}
        </p>
        <ul class="qc-checklist">
          <li v-for="r in group.items" :key="r.index">
            <button
              type="button"
              :class="['qc-item', { active: r.checked }]"
              :disabled="!!check.signed_off_at"
              @click="toggleItem(check, r.index)"
            >
              {{ r.label }}
              <span v-if="r.note" class="item-note">{{ r.note }}</span>
            </button>
          </li>
        </ul>
      </div>

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
        <ul
          v-if="check.required_signoffs > 1 && check.signoffs?.length"
          class="muted small" style="margin: 0 0 10px; padding-left: 18px"
        >
          <li v-for="s in check.signoffs" :key="s.reviewer_id">{{ s.reviewer_name }} — signed</li>
        </ul>
        <div v-if="auth.isSenior && !alreadySigned(check)" class="row" style="margin-top: 10px">
          <button class="primary" :disabled="busy" @click="approveRound(check)">
            {{ check.required_signoffs > 1 ? 'Add my signature' : 'Approve for next round' }}
          </button>
        </div>
        <p v-else-if="auth.isSenior" class="muted small">
          You've signed this round — waiting on {{ check.required_signoffs - check.signoffs.filter((s) => s.passed).length }}
          more signature(s).
        </p>
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
