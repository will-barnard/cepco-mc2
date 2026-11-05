<script setup>
/**
 * Published ticket notes (migration 061, routes/ticketNotes.js) -- replaces
 * the old live-edited "Notes & parts" textarea. Each note is posted once,
 * stamped with who and when, like Xero's own History & Notes; when the
 * ticket's customer is linked to Xero it's also posted to that contact's
 * history there, and the little status beside each note says whether that
 * happened.
 *
 * Notes typed directly in Xero are merged into the same list, tagged
 * "Xero" (Nov 2026 -- replaced the separate collapsed "History from Xero"
 * section with its Show-activity toggle and Refresh button). Xero notes
 * are immutable, so there's nothing to edit or reconcile: they're fetched
 * automatically when the ticket opens (cached server-side for five
 * minutes, see services/ticketNotes.js's contactHistory, which is what
 * keeps this inside Xero's rate limits) and simply interleaved by date.
 * Xero's own audit entries ("Contact edited", "Invoice sent") are left out
 * -- they're still on the Customers page.
 *
 * Xero history is per *contact*, so for a repeat customer it reaches back
 * past this job. Notes from before this ticket existed (earlier of created
 * and Date of Order/Queue) are tucked behind one "earlier notes" link
 * rather than burying this ticket's own notes.
 *
 * List comes from the ticket itself (`ticket.notes_log`, from GET
 * /tickets/:id); a post emits `changed` so the parent re-fetches, same as
 * TicketLinks.vue.
 */
import { computed, ref, watch } from 'vue';
import api from '../api';
import DraftNotice from './DraftNotice.vue';
import { useDraft } from '../drafts';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const draft = ref('');
// Kiosk feedback (Oct 2026): a half-typed note survives a user switch,
// refresh or crash -- see drafts.js. Keyed per ticket, so it follows the
// prop when the ticket page is reused for a different ticket.
const noteDraft = useDraft(() => `ticket-note:${props.ticket.id}`, draft);
const posting = ref(false);
const error = ref('');
const retrying = ref(null);

async function post() {
  if (!draft.value.trim()) return;
  error.value = '';
  posting.value = true;
  try {
    const note = await api.post(`/tickets/${props.ticket.id}/notes`, { body: draft.value });
    draft.value = '';
    noteDraft.clear();
    if (note.xero_status === 'failed') {
      error.value = `Note posted, but it didn't reach Xero: ${note.xero_error}. It'll be retried on the next Xero sync.`;
    }
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    posting.value = false;
  }
}

// Cmd/Ctrl+Enter posts, plain Enter is a newline -- notes are often a
// parts list, one per line.
function onKeydown(event) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    post();
  }
}

async function retry(note) {
  retrying.value = note.id;
  error.value = '';
  try {
    const updated = await api.post(`/tickets/${props.ticket.id}/notes/${note.id}/push-xero`);
    if (updated.xero_status === 'failed') error.value = `Still couldn't reach Xero: ${updated.xero_error}`;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    retrying.value = null;
  }
}

// --- Notes typed in Xero ----------------------------------------------------

const xeroNotes = ref([]);
const xeroLoading = ref(false);
const xeroError = ref('');
const showEarlierXero = ref(false);

async function loadXeroNotes() {
  xeroNotes.value = [];
  xeroError.value = '';
  showEarlierXero.value = false;
  const { customer_id: customerId, customer_xero_contact_id: contactId } = props.ticket;
  if (!customerId || !contactId) return;
  xeroLoading.value = true;
  try {
    const res = await api.get(`/customers/${customerId}/xero-history`);
    // Bail if the ticket's customer changed while this was in flight.
    if (props.ticket.customer_id !== customerId) return;
    xeroNotes.value = (res.records || []).filter((r) => r.kind === 'note' && r.at);
    if (res.error) xeroError.value = `Couldn't load notes from Xero: ${res.error}`;
  } catch (err) {
    xeroError.value = `Couldn't load notes from Xero: ${err.message}`;
  } finally {
    xeroLoading.value = false;
  }
}

// Keyed on ticket + linked contact, not the whole ticket object: the parent
// re-fetches the ticket after every edit, and that shouldn't re-ask Xero.
watch(
  () => `${props.ticket.id}:${props.ticket.customer_id}:${props.ticket.customer_xero_contact_id}`,
  loadXeroNotes,
  { immediate: true },
);

// When this job started, as far as notes are concerned: the earlier of the
// ticket's creation and its Date of Order/Queue (imported tickets were
// "created" on import day but came in long before).
const ticketStart = computed(() => {
  const created = props.ticket.created_at ? new Date(props.ticket.created_at).getTime() : Infinity;
  const dropOff = props.ticket.drop_off_date ? new Date(`${props.ticket.drop_off_date}T00:00:00`).getTime() : Infinity;
  const start = Math.min(created, dropOff);
  return Number.isFinite(start) ? start : -Infinity;
});

const earlierXeroCount = computed(
  () => xeroNotes.value.filter((r) => new Date(r.at).getTime() < ticketStart.value).length,
);

// One timeline, oldest first (same order as notes_log). Each entry carries
// `source` so the template can tell an MC2 note from a Xero one.
const timeline = computed(() => {
  const mine = (props.ticket.notes_log || []).map((n) => ({ source: 'mc2', key: `mc2-${n.id}`, at: n.created_at, note: n }));
  const fromXero = xeroNotes.value
    .filter((r) => showEarlierXero.value || new Date(r.at).getTime() >= ticketStart.value)
    .map((r, i) => ({ source: 'xero', key: `xero-${r.at}-${i}`, at: r.at, note: r }));
  return [...mine, ...fromXero].sort((a, b) => new Date(a.at) - new Date(b.at));
});

const when = (ts) => new Date(ts).toLocaleString([], {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

function xeroBadge(note) {
  if (note.xero_status === 'pushed') return { cls: 'green', text: 'In Xero', title: `Posted to Xero ${when(note.xero_pushed_at)}` };
  if (note.xero_status === 'failed') return { cls: 'red', text: 'Xero failed', title: note.xero_error };
  if (note.xero_status === 'pending') {
    return {
      cls: 'slate',
      text: 'Xero pending',
      title: props.ticket.customer_xero_contact_id
        ? 'Will be posted to Xero shortly'
        : 'This customer isn\'t linked to Xero yet — posted once they are (next Xero sync)',
    };
  }
  return null;
}
</script>

<template>
  <div class="field ticket-notes">
    <label>Notes &amp; parts</label>

    <button
      v-if="earlierXeroCount && !showEarlierXero" type="button" class="link small"
      style="margin: 2px 0 4px" @click="showEarlierXero = true"
    >
      Show {{ earlierXeroCount }} earlier Xero {{ earlierXeroCount === 1 ? 'note' : 'notes' }} (before this ticket)
    </button>

    <ul v-if="timeline.length" class="ticket-notes-list">
      <li v-for="item in timeline" :key="item.key">
        <template v-if="item.source === 'mc2'">
          <div class="row ticket-note-meta">
            <strong class="small">{{ item.note.created_by_name || 'MC2' }}</strong>
            <span class="muted small">{{ when(item.note.created_at) }}</span>
            <span v-if="item.note.legacy" class="muted small" title="Carried over from the old notes box, which didn't keep dates">
              · from the old notes box
            </span>
            <div class="spacer" />
            <template v-if="xeroBadge(item.note)">
              <span :class="['pill', xeroBadge(item.note).cls]" :title="xeroBadge(item.note).title">{{ xeroBadge(item.note).text }}</span>
              <button
                v-if="item.note.xero_status === 'failed'" type="button" class="link small"
                :disabled="retrying === item.note.id" @click="retry(item.note)"
              >
                {{ retrying === item.note.id ? 'Retrying…' : 'Retry' }}
              </button>
            </template>
          </div>
          <div class="ticket-note-body">{{ item.note.body }}</div>
        </template>
        <template v-else>
          <div class="row ticket-note-meta">
            <strong class="small">{{ item.note.user || 'Xero' }}</strong>
            <span class="muted small">{{ when(item.note.at) }}</span>
            <div class="spacer" />
            <span class="pill blue" title="Typed into this customer's History &amp; Notes in Xero">From Xero</span>
          </div>
          <div class="ticket-note-body">{{ item.note.details }}</div>
        </template>
      </li>
    </ul>
    <p v-else-if="!xeroLoading" class="muted small" style="margin: 4px 0 8px">No notes yet.</p>
    <p v-if="xeroLoading" class="muted small" style="margin: 0 0 8px">Checking Xero for notes…</p>
    <p v-if="xeroError" class="muted small" style="margin: 0 0 8px; color: var(--amber)">{{ xeroError }}</p>

    <form class="ticket-note-compose" @submit.prevent="post">
      <DraftNotice :draft="noteDraft" />
      <textarea
        v-model="draft" placeholder="Add a note — grommets, hammer tips, what the customer said…"
        style="min-height: 70px" @keydown="onKeydown"
      />
      <div class="row">
        <button class="small primary" type="submit" :disabled="posting || !draft.trim()">
          {{ posting ? 'Posting…' : 'Post note' }}
        </button>
        <span class="muted small">
          <template v-if="ticket.customer_xero_contact_id">Also posted to {{ ticket.customer_name }}'s Xero history.</template>
          <template v-else-if="ticket.customer_id">Goes to Xero once this customer is linked.</template>
        </span>
      </div>
    </form>

    <div v-if="error" class="alert" style="margin-top: 8px">{{ error }}</div>
  </div>
</template>

<style scoped>
.ticket-notes-list { list-style: none; margin: 4px 0 10px; padding: 0; }
.ticket-notes-list li { padding: 8px 0; border-bottom: 1px solid var(--border); }
.ticket-note-meta { gap: 8px; align-items: center; margin-bottom: 2px; }
/* Notes are often multi-line parts lists -- keep the author's line breaks. */
.ticket-note-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.ticket-note-compose textarea { width: 100%; margin-bottom: 6px; }
</style>
