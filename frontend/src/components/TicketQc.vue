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
 *
 * Migration 067 reworks the round's body into three stacked sections, one
 * column wide:
 *   1. Checklist — each item has pass (check) / fail (X) / N/A ("/") boxes
 *      (QcMarks.vue). N/A strikes the item through. Pressing the active box
 *      again clears it, so every mark can be changed after it's set. This
 *      replaces Q4's single highlight toggle and the 3-column layout.
 *   2. Completed tasks — the ticket's done tasks (TicketTasks.vue), each
 *      reviewed with the same three boxes, per round (qc_task_reviews).
 *   3. Photos — QcPhotos.vue, attached to this round, separate from the
 *      ticket's general Photos card.
 * Checklist override (migration 071): anyone can switch an open round onto a
 * different QC checklist (the picker in the round's Checklist header, or
 * before starting a round). Marks carry over to items worded the same; the
 * round's standard template still decides how many signatures it needs.
 * Admins also get a "Reset QC" button that reopens every round on the ticket
 * and returns it to "QC outstanding" (routes/qc.js, POST
 * /qc/tickets/:ticketId/reset) — the marks, notes and photos are kept.
 *
 * Marks are applied optimistically against a local copy of the ticket's
 * rounds (the parent only reloads on sign-off / new round), and rolled back
 * if the server refuses. A signed-off round is read-only.
 */
import { ref, computed, watch, onMounted } from 'vue';
import api from '../api';
import { useAuth } from '../stores';
import QcMarks from './QcMarks.vue';
import QcPhotos from './QcPhotos.vue';

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

// Local, mutable copy of the ticket's rounds. The parent hands us a fresh
// `ticket` object on every reload, so this re-syncs whenever that happens;
// between reloads, marks are applied to this copy the instant they're
// clicked (optimistic) so the checklist never waits on the network.
const checks = ref([]);
watch(
  () => props.ticket.qc_checks,
  (rounds) => {
    checks.value = (rounds || []).map((c) => ({ ...c, results: (c.results || []).map((r) => ({ ...r })) }));
  },
  { immediate: true },
);

// Round-by-round task verdicts, flattened to "checkId:taskId" -> status.
const taskMarks = ref({});
// Same keys -> the explanation typed under a failed task.
const taskComments = ref({});
watch(
  () => props.ticket.qc_task_reviews,
  (rows) => {
    const m = {};
    const c = {};
    (rows || []).forEach((r) => {
      const key = `${r.qc_check_id}:${r.ticket_task_id}`;
      m[key] = r.status;
      c[key] = r.comment || '';
    });
    taskMarks.value = m;
    taskComments.value = c;
  },
  { immediate: true },
);

// Tasks aren't part of GET /tickets/:id (same as TicketTasks.vue), so this
// panel fetches its own list, and re-fetches when the parent reloads the
// ticket — TicketTasks emits `changed` when a task is checked off, which is
// exactly when a task becomes (or stops being) reviewable here.
const tasks = ref([]);
async function loadTasks() {
  try {
    tasks.value = await api.get('/tasks', { ticket_id: props.ticket.id });
  } catch (err) {
    error.value = err.message;
  }
}
onMounted(loadTasks);
watch(() => props.ticket, loadTasks);

// Completed work is what gets reviewed, in the order it was finished.
const doneTasks = computed(() => tasks.value
  .filter((t) => t.done)
  .sort((a, b) => String(a.done_at || '').localeCompare(String(b.done_at || ''))));
const openTaskCount = computed(() => tasks.value.filter((t) => !t.done).length);

// Photo upload capabilities (storage driver) — one fetch shared by every
// round's QcPhotos rather than each of them asking.
const caps = ref(null);
onMounted(async () => {
  try { caps.value = await api.get('/attachments/capabilities'); } catch { /* QcPhotos falls back to multipart */ }
});

// QC checklists anyone can switch a round onto (every active QC template,
// any instrument family). Fetched once; the picker lists this ticket's own
// instrument family first.
const templates = ref([]);
onMounted(async () => {
  try { templates.value = await api.get('/qc/templates', { kind: 'qc' }); } catch { /* picker just stays empty */ }
});
const family = computed(() => props.ticket.instrument_family || null);
const familyTemplates = computed(() => templates.value.filter((t) => !t.family || t.family === family.value));
const otherTemplates = computed(() => templates.value.filter((t) => t.family && t.family !== family.value));
const templateLabel = (t) => (t.family && t.family !== family.value ? `${t.name} (${t.family})` : t.name);

/** The checklist a round is on: the override if there is one, else its
 * standard template (which is null for a round nothing was set up for). */
const currentChecklistId = (check) => check.checklist_template_id ?? check.template_id ?? '';
/** The current one might be retired since — still shown, under its own name,
 * rather than the select going blank. */
const currentMissing = (check) => {
  const id = currentChecklistId(check);
  return id !== '' && !templates.value.some((t) => t.id === id);
};
const currentName = (check) => check.checklist_override_name || check.template_name || 'Current checklist';

async function switchChecklist(check, event) {
  const raw = event.target.value;
  const next = raw === '' ? null : Number(raw);
  const previous = currentChecklistId(check);
  if ((next ?? '') === previous) return;
  const marked = check.results.filter((r) => r.status).length;
  if (marked && !confirm(
    `Switch this round to a different checklist? Marks on items worded the same carry over; `
    + `marks on the other ${marked === 1 ? 'item' : 'items'} are cleared.`,
  )) {
    event.target.value = previous;
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    const res = await api.put(`/qc/checks/${check.id}/checklist`, { template_id: next });
    if (res.marks_dropped) {
      error.value = `Checklist switched. ${res.marks_carried} mark(s) carried over, `
        + `${res.marks_dropped} cleared (no matching item).`;
    }
    emit('changed');
  } catch (err) {
    event.target.value = previous;
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// Admin-only: reopen every round and put the ticket back to QC outstanding.
const canResetQc = computed(() => auth.isAdmin
  && (props.ticket.qc_passed_at || checks.value.some((c) => c.signed_off_at || (c.signoffs || []).length)));

async function resetQc() {
  if (!confirm(
    'Reset QC for this ticket?\n\nEvery round is reopened and all signatures are cleared, so the rounds '
    + 'have to be signed off again. Checklist marks, notes and photos are kept.',
  )) return;
  error.value = '';
  busy.value = true;
  try {
    await api.post(`/qc/tickets/${props.ticket.id}/reset`);
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

/** Pressing the active box clears the mark; any other box sets it. */
const nextMark = (current, pressed) => (current === pressed ? null : pressed);

async function markItem(check, index, pressed) {
  if (check.signed_off_at) return;
  error.value = '';
  const item = check.results[index];
  const previous = item.status ?? null;
  const next = nextMark(previous, pressed);
  item.status = next;
  try {
    await api.put(`/qc/checks/${check.id}/items/${index}`, { status: next });
  } catch (err) {
    item.status = previous;
    error.value = err.message;
  }
}

const taskMark = (check, task) => taskMarks.value[`${check.id}:${task.id}`] ?? null;
const taskComment = (check, task) => taskComments.value[`${check.id}:${task.id}`] || '';

/** A fail's explanation. Optional — the box appears under the failed line
 * and saves when the tech clicks away (change event), so nothing blocks
 * marking. The text survives a mark moving off fail and back, but is only
 * shown while the mark is a fail. */
async function saveItemComment(check, index, value) {
  if (check.signed_off_at) return;
  error.value = '';
  const item = check.results[index];
  const text = value.trim();
  if (text === (item.comment || '')) return;
  const previous = item.comment;
  item.comment = text || null;
  try {
    await api.put(`/qc/checks/${check.id}/items/${index}`, { status: 'fail', comment: text });
  } catch (err) {
    item.comment = previous;
    error.value = err.message;
  }
}

async function saveTaskComment(check, task, value) {
  if (check.signed_off_at) return;
  error.value = '';
  const key = `${check.id}:${task.id}`;
  const text = value.trim();
  const previous = taskComments.value[key] || '';
  if (text === previous) return;
  taskComments.value = { ...taskComments.value, [key]: text };
  try {
    await api.put(`/qc/checks/${check.id}/task-reviews/${task.id}`, { status: 'fail', comment: text });
  } catch (err) {
    taskComments.value = { ...taskComments.value, [key]: previous };
    error.value = err.message;
  }
}

async function markTask(check, task, pressed) {
  if (check.signed_off_at) return;
  error.value = '';
  const key = `${check.id}:${task.id}`;
  const previous = taskMarks.value[key] ?? null;
  const next = nextMark(previous, pressed);
  taskMarks.value = { ...taskMarks.value, [key]: next };
  try {
    await api.put(`/qc/checks/${check.id}/task-reviews/${task.id}`, { status: next });
  } catch (err) {
    taskMarks.value = { ...taskMarks.value, [key]: previous };
    error.value = err.message;
  }
}

/** "9 of 12 marked · 1 failed" — a glanceable progress line per section. */
function tally(statuses) {
  const marked = statuses.filter(Boolean).length;
  const failed = statuses.filter((x) => x === 'fail').length;
  const text = `${marked} of ${statuses.length} marked`;
  return { text: failed ? `${text} · ${failed} failed` : text, failed };
}
const itemTally = (check) => tally(check.results.map((r) => r.status ?? null));
const taskTally = (check) => tally(doneTasks.value.map((t) => taskMark(check, t)));

// Q5: "what needs doing before this passes" — one draft string per open
// round, keyed by check id (a plain object inside a ref stays reactive for
// property-level mutation, same as activeItems' Set above just without
// needing a full replace each time).
const issueDrafts = ref({});

// '' = the checklist standardized for this round and instrument type.
const startChecklistId = ref('');

async function startRound() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/qc/checks', {
      ticket_id: props.ticket.id,
      ...(startChecklistId.value !== '' ? { checklist_template_id: Number(startChecklistId.value) } : {}),
    });
    startChecklistId.value = '';
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
      <button
        v-if="canResetQc" type="button" class="small danger" :disabled="busy"
        title="Admin: reopen every round and clear all signatures" @click="resetQc"
      >Reset QC</button>
    </div>
    <p class="muted small" style="margin: 0 0 12px">
      Rounds always happen in order — Round 2 can't start before Round 1 is open, and each
      round's checklist is standardized for this instrument type, though anyone can switch an
      open round onto a different checklist. Every ticket needs 2 rounds passed to clear QC; how
      many people need to sign each round (1 or 2) depends on that round's standard template.
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

      <!-- 1. Checklist. One column; each item has pass / fail / N/A boxes
           (QcMarks). Still grouped under the boss's Tuning/Action/
           Electronics/Cosmetics headings (Q4). N/A strikes the text. -->
      <section class="qc-section">
        <div class="row qc-section-head">
          <h3>Checklist</h3>
          <div class="spacer" />
          <span v-if="check.results.length" :class="['small', itemTally(check).failed ? 'qc-has-fail' : 'muted']">
            {{ itemTally(check).text }}
          </span>
        </div>
        <!-- Anyone can switch an open round to another checklist; a signed-off
             round just names the one it used. -->
        <div v-if="!check.signed_off_at" class="row qc-checklist-pick">
          <label class="muted small" :for="`qc-checklist-${check.id}`">Checklist</label>
          <select
            :id="`qc-checklist-${check.id}`" :value="currentChecklistId(check)" :disabled="busy"
            @change="switchChecklist(check, $event)"
          >
            <option v-if="currentChecklistId(check) === ''" value="">— none set up for this round —</option>
            <option v-if="currentMissing(check)" :value="currentChecklistId(check)">{{ currentName(check) }}</option>
            <optgroup v-if="familyTemplates.length" :label="family ? `${family} / general` : 'General'">
              <option v-for="t in familyTemplates" :key="t.id" :value="t.id">{{ templateLabel(t) }}</option>
            </optgroup>
            <optgroup v-if="otherTemplates.length" label="Other instrument types">
              <option v-for="t in otherTemplates" :key="t.id" :value="t.id">{{ templateLabel(t) }}</option>
            </optgroup>
          </select>
          <span v-if="check.checklist_template_id" class="pill amber small">Overridden</span>
        </div>
        <p v-else-if="check.checklist_override_name" class="muted small" style="margin: 0 0 4px">
          Checklist: {{ check.checklist_override_name }} (overridden)
        </p>
        <p v-if="!check.results.length" class="muted small" style="margin: 0">
          No checklist items for this round yet (Settings → QC checklist templates).
        </p>
        <div v-for="group in groupedResults(check)" :key="group.key || 'general'" style="margin-top: 8px">
          <p class="muted small qc-group-label">{{ group.label }}</p>
          <ul class="qc-list">
            <li v-for="r in group.items" :key="r.index" :class="['qc-row', r.status && `is-${r.status}`]">
              <QcMarks
                :status="r.status" :label="r.label" :disabled="!!check.signed_off_at"
                @pick="markItem(check, r.index, $event)"
              />
              <span :class="['qc-text', { struck: r.status === 'na' }]">
                {{ r.label }}
                <span v-if="r.note" class="item-note">{{ r.note }}</span>
              </span>
              <!-- A fail opens an explanation box under the line. -->
              <div v-if="r.status === 'fail'" class="qc-explain">
                <p v-if="check.signed_off_at" class="qc-explain-text">
                  {{ r.comment || 'No explanation was given.' }}
                </p>
                <textarea
                  v-else :value="r.comment || ''" rows="2" maxlength="2000"
                  placeholder="What failed? (optional)"
                  @change="saveItemComment(check, r.index, $event.target.value)"
                />
              </div>
            </li>
          </ul>
        </div>
      </section>

      <!-- 2. Completed tasks. Every task on the ticket that's been checked
           off gets the same three boxes, scoped to this round. -->
      <section class="qc-section">
        <div class="row qc-section-head">
          <h3>Completed tasks</h3>
          <div class="spacer" />
          <span v-if="doneTasks.length" :class="['small', taskTally(check).failed ? 'qc-has-fail' : 'muted']">
            {{ taskTally(check).text }}
          </span>
        </div>
        <p v-if="!doneTasks.length" class="muted small" style="margin: 0">
          No completed tasks on this ticket yet — each one shows up here to review once it's checked off.
        </p>
        <ul v-else class="qc-list">
          <li v-for="t in doneTasks" :key="t.id" :class="['qc-row', taskMark(check, t) && `is-${taskMark(check, t)}`]">
            <QcMarks
              :status="taskMark(check, t)" :label="t.title" :disabled="!!check.signed_off_at"
              @pick="markTask(check, t, $event)"
            />
            <span :class="['qc-text', { struck: taskMark(check, t) === 'na' }]">
              {{ t.title }}
              <span v-if="t.done_by_name || t.logged_hours" class="item-note">
                <template v-if="t.done_by_name">Done by {{ t.done_by_name }}</template>
                <template v-if="t.done_by_name && t.logged_hours"> · </template>
                <template v-if="t.logged_hours">{{ t.logged_hours }} h</template>
              </span>
            </span>
            <div v-if="taskMark(check, t) === 'fail'" class="qc-explain">
              <p v-if="check.signed_off_at" class="qc-explain-text">
                {{ taskComment(check, t) || 'No explanation was given.' }}
              </p>
              <textarea
                v-else :value="taskComment(check, t)" rows="2" maxlength="2000"
                placeholder="What failed? (optional)"
                @change="saveTaskComment(check, t, $event.target.value)"
              />
            </div>
          </li>
        </ul>
        <p v-if="openTaskCount" class="muted small" style="margin: 6px 0 0">
          {{ openTaskCount }} more task(s) still open — they can be reviewed once they're done.
        </p>
      </section>

      <!-- 3. Photos for this round — separate from the ticket's Photos card. -->
      <section class="qc-section">
        <div class="row qc-section-head">
          <h3>Photos</h3>
        </div>
        <QcPhotos :check-id="check.id" :locked="!!check.signed_off_at" :caps="caps" />
      </section>

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
      <div class="row" style="margin-top: 8px">
        <label class="muted small" for="qc-start-checklist">Checklist</label>
        <select id="qc-start-checklist" v-model="startChecklistId">
          <option value="">Standard for round {{ checks.length + 1 }} on this instrument type</option>
          <optgroup v-if="familyTemplates.length" :label="family ? `${family} / general` : 'General'">
            <option v-for="t in familyTemplates" :key="t.id" :value="t.id">{{ templateLabel(t) }}</option>
          </optgroup>
          <optgroup v-if="otherTemplates.length" label="Other instrument types">
            <option v-for="t in otherTemplates" :key="t.id" :value="t.id">{{ templateLabel(t) }}</option>
          </optgroup>
        </select>
      </div>
      <p class="muted small" style="margin: 8px 0 0">
        By default pulls whatever checklist is standardized for round {{ checks.length + 1 }} on this
        instrument type (Settings → QC checklist templates) — blank if none is set up yet. Pick
        another above to start the round on a different checklist.
      </p>
    </div>
  </div>
</template>

<style scoped>
.qc-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.qc-section-head { margin-bottom: 6px; }
.qc-section-head h3 { margin: 0; }
.qc-group-label { margin: 0 0 2px; text-transform: uppercase; letter-spacing: 0.04em; }
.qc-has-fail { color: var(--red); font-weight: 600; }
.qc-checklist-pick { margin: 0 0 6px; gap: 8px; flex-wrap: nowrap; }
.qc-checklist-pick select { flex: 1; min-width: 0; }

/* One column: the boxes, then the text. align-items:flex-start keeps the
   boxes pinned to the first line when a long label wraps. */
.qc-list { list-style: none; margin: 0; padding: 0; }
.qc-row {
  display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px;
  padding: 5px 6px; border-radius: var(--radius);
}
.qc-row.is-fail { background: rgba(239, 68, 68, 0.1); }
.qc-text { flex: 1; min-width: 0; padding-top: 5px; overflow-wrap: anywhere; }
/* The explanation drops onto its own line, lined up under the label (3 boxes
   of 34px + 2 gaps of 4px + the row gap = 120px); full width on a phone,
   where that much indent would squeeze the box. */
.qc-explain { flex: 0 0 100%; padding-left: 120px; }
.qc-explain textarea { min-height: 0; font-size: 14px; resize: vertical; }
.qc-explain-text { margin: 0; font-size: 14px; white-space: pre-wrap; color: var(--text); }
@media (max-width: 640px) { .qc-explain { padding-left: 0; } }
.qc-text.struck { text-decoration: line-through; color: var(--text-dim); }
.qc-text .item-note { display: block; font-size: 12px; color: var(--text-dim); text-decoration: none; }
</style>
