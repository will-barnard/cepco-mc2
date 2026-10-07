<script setup>
// Named links attached to a ticket (migration 059, routes/ticketLinks.js).
// Renders as a `.field` inside TicketDetailView's Details card -- between
// customer/instrument and Notes & parts -- rather than as a card of its
// own. The list itself comes from the ticket (`ticket.links`, returned by
// GET /tickets/:id); every change emits `changed` so the parent re-fetches,
// the same way TicketPhotos/TicketSubTickets do.
import { ref } from 'vue';
import api from '../api';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const error = ref('');
const busy = ref(false);

// null = not editing; 'new' = the add form; otherwise the id being edited.
const editingId = ref(null);
const draft = ref({ name: '', url: '' });

function startAdd() {
  error.value = '';
  draft.value = { name: '', url: '' };
  editingId.value = 'new';
}

function startEdit(link) {
  error.value = '';
  draft.value = { name: link.name, url: link.url };
  editingId.value = link.id;
}

function cancel() {
  error.value = '';
  editingId.value = null;
}

async function save() {
  error.value = '';
  busy.value = true;
  try {
    const body = { name: draft.value.name, url: draft.value.url };
    if (editingId.value === 'new') {
      await api.post('/ticket-links', { ticket_id: props.ticket.id, ...body });
    } else {
      await api.patch(`/ticket-links/${editingId.value}`, body);
    }
    editingId.value = null;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function remove(link) {
  if (!confirm(`Remove the link "${link.name}"?`)) return;
  error.value = '';
  try {
    await api.del(`/ticket-links/${link.id}`);
    if (editingId.value === link.id) editingId.value = null;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

// Just the host, shown dimmed next to the name so two links with similar
// names ("Manual", "Manual (old)") can still be told apart at a glance.
function host(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}
</script>

<template>
  <!-- One more row of TicketDetailView's .detail-rows list (styles.css):
       label, the links themselves, and "+ Add" on the right. The add/edit
       forms open full-width underneath. -->
  <div class="detail-row top ticket-links">
    <span class="detail-label">Links</span>

    <div class="detail-value">
      <ul v-if="ticket.links?.length" class="ticket-links-list">
        <li v-for="l in ticket.links" :key="l.id">
          <div v-if="editingId !== l.id" class="ticket-links-item">
            <a :href="l.url" target="_blank" rel="noopener noreferrer">{{ l.name }}</a>
            <span class="muted small">{{ host(l.url) }}</span>
            <span class="ticket-links-item-actions">
              <button type="button" class="link small" @click="startEdit(l)">Edit</button>
              <button type="button" class="link small" @click="remove(l)">Remove</button>
            </span>
          </div>
          <span v-else class="muted small">Editing "{{ l.name }}" below</span>
        </li>
      </ul>
      <span v-else class="muted">None yet</span>
    </div>

    <button
      v-if="editingId !== 'new'" type="button" class="detail-action" @click="startAdd"
    >
      + Add
    </button>

    <div v-if="error || editingId !== null" class="detail-extra">
      <div v-if="error" class="alert" style="margin: 0 0 8px">{{ error }}</div>

      <form v-if="editingId !== null" class="ticket-links-form" @submit.prevent="save">
        <div class="field-row">
          <input v-model="draft.name" placeholder="Link name" maxlength="200" required />
          <input v-model="draft.url" placeholder="https://…" maxlength="2000" required />
        </div>
        <div class="row">
          <button class="small primary" type="submit" :disabled="busy">
            {{ busy ? 'Saving…' : editingId === 'new' ? 'Add link' : 'Save' }}
          </button>
          <button class="small" type="button" :disabled="busy" @click="cancel">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.ticket-links-list { list-style: none; margin: 0; padding: 0; }
.ticket-links-list li + li { margin-top: 4px; }
.ticket-links-list a { overflow-wrap: anywhere; }
.ticket-links-item { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; }
.ticket-links-item-actions { display: inline-flex; gap: 10px; margin-left: 4px; }
.ticket-links-form { display: flex; flex-direction: column; gap: 8px; }
</style>
