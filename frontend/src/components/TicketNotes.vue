<script setup>
/**
 * Published ticket notes (migration 061, routes/ticketNotes.js) -- replaces
 * the old live-edited "Notes & parts" textarea. Each note is posted once,
 * stamped with who and when, like Xero's own History & Notes; when the
 * ticket's customer is linked to Xero it's also posted to that contact's
 * history there, and the little status beside each note says whether that
 * happened. Below the notes, the customer's history *from* Xero (notes
 * typed in Xero, invoices sent, etc.) is shown read-only.
 *
 * List comes from the ticket itself (`ticket.notes_log`, from GET
 * /tickets/:id); a post emits `changed` so the parent re-fetches, same as
 * TicketLinks.vue.
 */
import { ref } from 'vue';
import api from '../api';
import XeroHistory from './XeroHistory.vue';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const draft = ref('');
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

    <ul v-if="ticket.notes_log?.length" class="ticket-notes-list">
      <li v-for="n in ticket.notes_log" :key="n.id">
        <div class="row ticket-note-meta">
          <strong class="small">{{ n.created_by_name || 'MC2' }}</strong>
          <span class="muted small">{{ when(n.created_at) }}</span>
          <span v-if="n.legacy" class="muted small" title="Carried over from the old notes box, which didn't keep dates">
            · from the old notes box
          </span>
          <div class="spacer" />
          <template v-if="xeroBadge(n)">
            <span :class="['pill', xeroBadge(n).cls]" :title="xeroBadge(n).title">{{ xeroBadge(n).text }}</span>
            <button
              v-if="n.xero_status === 'failed'" type="button" class="link small"
              :disabled="retrying === n.id" @click="retry(n)"
            >
              {{ retrying === n.id ? 'Retrying…' : 'Retry' }}
            </button>
          </template>
        </div>
        <div class="ticket-note-body">{{ n.body }}</div>
      </li>
    </ul>
    <p v-else class="muted small" style="margin: 4px 0 8px">No notes yet.</p>

    <form class="ticket-note-compose" @submit.prevent="post">
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

    <XeroHistory
      v-if="ticket.customer_id && ticket.customer_xero_contact_id"
      :customer-id="ticket.customer_id" collapsible style="margin-top: 14px"
    />
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
