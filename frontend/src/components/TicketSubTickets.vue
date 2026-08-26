<script setup>
/**
 * Sub-tickets — spin off an independently-assignable, independently-tracked
 * ticket linked back to this one (e.g. a custom metal-fabrication job off a
 * Servicing ticket, or the "Ship this instrument" shipping ticket). Both
 * cases are the same mechanism under the hood: a normal row in `tickets`
 * with `source_ticket_id` set, surfaced back here via `child_tickets` from
 * GET /tickets/:id. See NOTES.md.
 *
 * Design decisions (all per explicit product direction, not just
 * engineering convenience):
 *   - No server-side enforcement blocking parent completion while
 *     sub-tickets are open — a shop lead can still close out the parent
 *     ticket even if the fabrication sub-ticket is still in progress. The
 *     open/closed state of children is visible here, not gated.
 *   - A new sub-ticket defaults to the same category as its parent (a
 *     fabrication sub-ticket off a Servicing job is itself servicing-ish
 *     work) but the category select is editable, since "custom shop task"
 *     doesn't always match the parent's category (e.g. a Shipping ticket
 *     spinning off a Servicing sub-ticket).
 *   - Any ticket can spawn sub-tickets, including sub-tickets themselves —
 *     this component is rendered unconditionally in TicketDetailView, so
 *     nesting is allowed rather than special-cased away.
 *
 * "Ship this instrument" is folded in here as a quick-action rather than
 * living as its own header button, since it's just a sub-ticket creation
 * shortcut (routes/tickets.js's create-shipping-ticket route) that
 * pre-fills category/title/notes for the one sub-ticket type common enough
 * to deserve a single click.
 */
import { ref, computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const settings = useSettings();
const refData = useRefData();
const router = useRouter();

const error = ref('');
const shippingBusy = ref(false);
const showForm = ref(false);
const creating = ref(false);

const children = computed(() => props.ticket.child_tickets || []);
const hasShippingChild = computed(() => children.value.some((c) => c.category_key === 'shipping'));

const blank = () => ({
  title: '',
  category_key: props.ticket.category_key,
  priority_key: props.ticket.priority_key,
  assigned_tech_id: '',
  notes: '',
});
const form = ref(blank());

async function createShippingTicket() {
  error.value = '';
  shippingBusy.value = true;
  try {
    const created = await api.post(`/tickets/${props.ticket.id}/create-shipping-ticket`);
    router.push({ name: 'ticket', params: { id: created.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    shippingBusy.value = false;
  }
}

function openForm() {
  form.value = blank();
  showForm.value = true;
}

async function createSubTicket() {
  error.value = '';
  if (!form.value.title.trim()) {
    error.value = 'Title is required';
    return;
  }
  creating.value = true;
  try {
    await api.post('/tickets', {
      title: form.value.title.trim(),
      notes: form.value.notes || null,
      category_key: form.value.category_key,
      priority_key: form.value.priority_key,
      assigned_tech_id: form.value.assigned_tech_id || null,
      instrument_id: props.ticket.instrument_id || null,
      customer_id: props.ticket.customer_id || null,
      source_ticket_id: props.ticket.id,
    });
    showForm.value = false;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Sub-tickets</h2>
      <div class="spacer" />
      <button
        v-if="ticket.instrument_id && !hasShippingChild"
        class="small" :disabled="shippingBusy" @click="createShippingTicket"
      >{{ shippingBusy ? 'Creating…' : 'Ship this instrument' }}</button>
      <button class="small" @click="showForm ? (showForm = false) : openForm()">
        {{ showForm ? 'Cancel' : '+ Add sub-ticket' }}
      </button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-if="showForm" class="field-row" style="margin-bottom: 16px">
      <div class="field" style="flex: 2">
        <label>Title</label>
        <input v-model="form.title" placeholder="Custom metal fabrication — bell flare bracket" />
      </div>
      <div class="field">
        <label>Category</label>
        <select v-model="form.category_key">
          <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">
            {{ c.label }}
          </option>
        </select>
      </div>
      <div class="field">
        <label>Priority</label>
        <select v-model="form.priority_key">
          <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
            {{ p.label }}
          </option>
        </select>
      </div>
      <div class="field">
        <label>Assign to</label>
        <select v-model="form.assigned_tech_id">
          <option value="">— unassigned —</option>
          <option v-for="e in refData.employees" :key="e.id" :value="e.id">
            {{ e.name }} ({{ e.role }})
          </option>
        </select>
      </div>
      <div class="field" style="flex: 3">
        <label>Notes</label>
        <textarea v-model="form.notes" style="min-height: 38px" />
      </div>
      <div class="field" style="flex: none">
        <label>&nbsp;</label>
        <button class="primary" :disabled="creating" @click="createSubTicket">
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
      </div>
    </div>

    <div v-if="!children.length" class="empty">No sub-tickets yet.</div>
    <ul v-else class="checklist">
      <li v-for="c in children" :key="c.id">
        <RouterLink :to="{ name: 'ticket', params: { id: c.id } }" style="flex: 1">
          #{{ c.id }} — {{ c.title }}
        </RouterLink>
        <span class="tag">{{ c.category_label_snapshot }}</span>
        <span :class="['pill', settings.colorFor(c.status_key)]">{{ c.status_label_snapshot }}</span>
        <span class="muted small">{{ c.assigned_tech_name || 'unassigned' }}</span>
      </li>
    </ul>
  </div>
</template>
