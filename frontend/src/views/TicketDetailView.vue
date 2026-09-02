<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import api from '../api';
import { useAuth, useSettings } from '../stores';
import TicketPhotos from '../components/TicketPhotos.vue';
import TicketQc from '../components/TicketQc.vue';
import TicketHours from '../components/TicketHours.vue';
import TicketEstimate from '../components/TicketEstimate.vue';
import TicketPurchase from '../components/TicketPurchase.vue';
import TicketShipment from '../components/TicketShipment.vue';
import TicketSubTickets from '../components/TicketSubTickets.vue';
import TicketTasks from '../components/TicketTasks.vue';
import TechnicianPicker from '../components/TechnicianPicker.vue';

const props = defineProps({ id: { type: String, required: true } });

const auth = useAuth();
const settings = useSettings();
const router = useRouter();

const ticket = ref(null);
// Q5: lets TicketQc.vue's "report an issue" flow refresh the Tasks panel
// it doesn't otherwise talk to (see TicketTasks.vue's defineExpose).
const ticketTasksRef = ref(null);
const loading = ref(true);
const error = ref('');
const statusNote = ref('');
const notesDraft = ref('');
const savingNotes = ref(false);
// "Status notes" (Settings -> Ticket categories -> "Status notes" toggle) —
// two free-text fields distinct from the status-CHANGE note above
// (statusNote, attached to the audit log entry when the status dropdown
// changes) and from the general Notes & parts field: these track what was
// actually done on the job vs. what's still outstanding, editable any time
// rather than only at the moment of a status change.
const serviceDoneDraft = ref('');
const serviceNeededDraft = ref('');
const savingStatusNotes = ref(false);
const progressUpdate = ref(null);
const generatingUpdate = ref(false);
// "Assigned technicians" takes up a lot of space once a ticket has people
// on it, so it starts collapsed behind a summary + "Show" toggle whenever
// someone's already assigned, and expanded when nobody is (there's nothing
// to summarize, and it's the thing you'd want to fill in first). Only
// initialized once per ticket — see lastInitializedTicketId below — so
// assigning the first tech mid-edit doesn't yank the picker away right
// as it re-fetches after that save.
const showTechnicians = ref(true);
const lastInitializedTicketId = ref(null);

async function load() {
  loading.value = true;
  try {
    ticket.value = await api.get(`/tickets/${props.id}`);
    notesDraft.value = ticket.value.notes || '';
    serviceDoneDraft.value = ticket.value.service_done_notes || '';
    serviceNeededDraft.value = ticket.value.service_needed_notes || '';
    if (lastInitializedTicketId.value !== ticket.value.id) {
      showTechnicians.value = !(ticket.value.technicians || []).length;
      lastInitializedTicketId.value = ticket.value.id;
    }
    const updates = await api.get('/progress-updates', { ticket_id: props.id });
    progressUpdate.value = updates[0] || null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.id, load);

async function patch(payload) {
  error.value = '';
  try {
    await api.patch(`/tickets/${props.id}`, payload);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function changeStatus(event) {
  await patch({ status_key: event.target.value, status_note: statusNote.value || null });
  statusNote.value = '';
}

async function saveNotes() {
  savingNotes.value = true;
  await patch({ notes: notesDraft.value });
  savingNotes.value = false;
}

async function saveStatusNotes() {
  savingStatusNotes.value = true;
  await patch({
    service_done_notes: serviceDoneDraft.value,
    service_needed_notes: serviceNeededDraft.value,
  });
  savingStatusNotes.value = false;
}

async function generateUpdate() {
  generatingUpdate.value = true;
  error.value = '';
  try {
    progressUpdate.value = await api.post('/progress-updates', { ticket_id: ticket.value.id });
    router.push({ name: 'progress-update', params: { id: progressUpdate.value.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    generatingUpdate.value = false;
  }
}

async function createInvoice() {
  error.value = '';
  try {
    await api.post('/invoices', { ticket_id: ticket.value.id });
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function archive() {
  if (!confirm('Archive this ticket? It stays searchable under "Show archived".')) return;
  await patch({ archived: true });
  router.push({ name: 'queue' });
}

const when = (ts) => new Date(ts).toLocaleString();

// A ticket can now be on more than one tech's plate (migration 013) —
// TechnicianPicker's v-model is just the list of assigned ids.
const assignedTechIds = computed(() => (ticket.value?.technicians || []).map((t) => t.id));

// Shipping tickets are pack-and-send jobs, not billable repair work — no QC
// round, no labor estimate, no hours logging, no invoice. Just the shared
// Details card plus the Shipment card (TicketShipment.vue). See NOTES.md.
// Driven by the ticket's own is_shipping flag (migration 028), not its
// category — N2b retired the old dedicated 'shipping' category, so this
// can no longer be a category_key check (see that migration's header for
// why the category and this flag aren't the same thing).
const isShipping = computed(() => !!ticket.value?.is_shipping);

// Customer progress update card (right column) — no customer to update
// on a non-repair ticket. is_shipping covers Shipping specifically (see
// isShipping above); settings.progressUpdateAllowed covers every other
// opted-out category (Housekeeping by default — migration 041).
const showProgressUpdate = computed(() => (
  !isShipping.value && settings.progressUpdateAllowed(ticket.value?.category_key)
));
</script>

<template>
  <div v-if="loading" class="page"><div class="empty">Loading…</div></div>

  <div v-else-if="ticket" class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">{{ ticket.title }}</h1>
        <div class="row muted small">
          <span>#{{ ticket.id }}</span>
          <span>· opened {{ new Date(ticket.created_at).toLocaleDateString() }}</span>
          <span v-if="ticket.legacy_ref">· sheet ref {{ ticket.legacy_ref }}</span>
          <span v-if="ticket.source_sheet">· imported from {{ ticket.source_sheet }}</span>
          <span v-if="ticket.source_ticket_id">
            · created from
            <RouterLink :to="{ name: 'ticket', params: { id: ticket.source_ticket_id } }">
              #{{ ticket.source_ticket_id }} — {{ ticket.source_ticket_title }}
            </RouterLink>
          </span>
          <!-- N9: siblings share this ticket's own source_ticket_id (the
               primary's id) rather than pointing at each other — see
               GET /tickets/:id's sibling_tickets query. -->
          <span v-if="ticket.sibling_tickets?.length">
            · part of a multi-instrument job with
            <template v-for="(s, i) in ticket.sibling_tickets" :key="s.id">
              <RouterLink :to="{ name: 'ticket', params: { id: s.id } }">#{{ s.id }}</RouterLink>
              <template v-if="i < ticket.sibling_tickets.length - 1">, </template>
            </template>
          </span>
        </div>
      </div>
      <div class="row">
        <span :class="['pill', settings.colorFor(ticket.status_key)]">
          {{ ticket.status_label }}
        </span>
        <button v-if="auth.isAdmin" class="small" @click="archive">Archive</button>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div class="grid cols-2">
      <!-- ------------------------------------------------ left: the job -->
      <div class="stack">
        <div class="card">
          <h2>Details</h2>
          <div class="field-row">
            <div class="field">
              <label>Status</label>
              <select :value="ticket.status_key" @change="changeStatus">
                <option
                  v-for="s in settings.statusesForCategory(ticket.category_key, ticket.is_shipping)"
                  :key="s.key" :value="s.key"
                >
                  {{ s.label }}
                </option>
              </select>
            </div>
            <div class="field">
              <label>Note for this change (optional)</label>
              <input v-model="statusNote" placeholder="Why the status moved" />
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label>Priority</label>
              <select
                :value="ticket.priority_key"
                @change="patch({ priority_key: $event.target.value })"
              >
                <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
                  {{ p.label }}
                </option>
              </select>
            </div>
            <div class="field">
              <label>Category</label>
              <select
                :value="ticket.category_key"
                @change="patch({ category_key: $event.target.value })"
              >
                <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">
                  {{ c.label }}
                </option>
              </select>
            </div>
            <!-- N8: tech level moved to the per-task picker (TicketTasks
                 further down) — a ticket's own tasks can span more than one
                 level, which this single ticket-wide field never could.
                 ticket.tech_level_key stays in the DB (costs nothing to
                 leave it there), it just isn't edited from here anymore. -->
          </div>

          <div class="field">
            <div class="row" style="margin-bottom: 4px">
              <label style="margin: 0">Assigned technicians</label>
              <span v-if="!showTechnicians" class="muted small">
                {{ ticket.technicians.map((t) => t.name).join(', ') }}
              </span>
              <div class="spacer" />
              <button
                v-if="assignedTechIds.length" class="small"
                @click="showTechnicians = !showTechnicians"
              >{{ showTechnicians ? 'Hide' : 'Show' }}</button>
            </div>
            <TechnicianPicker
              v-if="showTechnicians"
              :model-value="assignedTechIds"
              @update:model-value="(ids) => patch({ technician_ids: ids })"
            />
          </div>

          <div class="field-row">
            <div>
              <label>Customer</label>
              <p style="margin: 0">
                <RouterLink v-if="ticket.customer_id" :to="`/customers?id=${ticket.customer_id}`">
                  {{ ticket.customer_name }}
                </RouterLink>
                <span v-else class="muted">
                  {{ ticket.instrument_is_fleet ? 'CEPCo fleet (internal)' : '—' }}
                </span>
              </p>
            </div>
            <div>
              <label>Instrument</label>
              <p style="margin: 0">
                <span v-if="ticket.instrument_family">
                  {{ ticket.instrument_family }} · {{ ticket.instrument_model }}
                </span>
                <span v-else class="muted">—</span>
              </p>
            </div>
            <div>
              <label>Shop contact</label>
              <p style="margin: 0">
                {{ ticket.shop_contact_name || ticket.shop_contact_raw || '—' }}
              </p>
            </div>
          </div>

          <div
            v-if="ticket.vendor_tracks && Object.keys(ticket.vendor_tracks).length"
            class="field"
          >
            <label>Vendor work</label>
            <div class="row">
              <span v-for="(v, k) in ticket.vendor_tracks" :key="k" class="tag">
                {{ k }}: {{ v }}
              </span>
            </div>
          </div>

          <div class="field">
            <label>Notes &amp; parts</label>
            <textarea v-model="notesDraft" />
            <button class="small" :disabled="savingNotes" @click="saveNotes">
              {{ savingNotes ? 'Saving…' : 'Save notes' }}
            </button>
          </div>

          <div v-if="settings.statusNotesAllowed(ticket.category_key)" class="field">
            <label>Status notes</label>
            <div class="field-row">
              <div class="field">
                <label class="small muted">Service done</label>
                <textarea v-model="serviceDoneDraft" style="min-height: 80px" />
              </div>
              <div class="field">
                <label class="small muted">Service needed</label>
                <textarea v-model="serviceNeededDraft" style="min-height: 80px" />
              </div>
            </div>
            <button class="small" :disabled="savingStatusNotes" @click="saveStatusNotes">
              {{ savingStatusNotes ? 'Saving…' : 'Save status notes' }}
            </button>
          </div>
        </div>

        <TicketSubTickets :ticket="ticket" @changed="load" />
        <TicketTasks ref="ticketTasksRef" :ticket="ticket" />

        <TicketPurchase v-if="ticket.purchase_id" :ticket="ticket" @changed="load" />
        <TicketEstimate v-if="!isShipping" :ticket="ticket" @changed="load" />
        <TicketHours v-if="!isShipping" :ticket="ticket" @changed="load" />
      </div>

      <!-- --------------------------------------- right: QC, photos, log -->
      <div class="stack">
        <TicketQc
          v-if="!isShipping" :ticket="ticket"
          @changed="load" @task-created="ticketTasksRef?.load()"
        />
        <!-- Shipping tickets lead with the checklist they're actually here
             to work through — TicketPhotos comes after it instead of
             before, just for this ticket type. -->
        <TicketShipment v-if="ticket.shipments?.length" :ticket="ticket" @changed="load" />
        <TicketPhotos :ticket-id="ticket.id" />

        <div v-if="showProgressUpdate" class="card">
          <div class="row" style="margin-bottom: 12px">
            <h2 style="margin: 0">Customer progress update</h2>
          </div>
          <div v-if="!progressUpdate" class="row">
            <p class="muted small" style="margin: 0; flex: 1">
              Pulls the status notes and photos above into an update you can email the customer.
            </p>
            <button class="small" :disabled="generatingUpdate" @click="generateUpdate">
              {{ generatingUpdate ? 'Generating…' : 'Generate progress update' }}
            </button>
          </div>
          <div v-else class="row">
            <span :class="['pill', progressUpdate.status === 'sent' ? 'green' : 'slate']">
              {{ progressUpdate.status === 'sent' ? 'Sent' : 'Draft' }}
            </span>
            <span v-if="progressUpdate.sent_at" class="muted small">
              Sent {{ new Date(progressUpdate.sent_at).toLocaleString() }}
            </span>
            <span v-if="progressUpdate.viewed_at" class="muted small">
              · Viewed {{ new Date(progressUpdate.viewed_at).toLocaleString() }}
            </span>
            <div class="spacer" />
            <RouterLink class="btn small" :to="{ name: 'progress-update', params: { id: progressUpdate.id } }">
              View update →
            </RouterLink>
          </div>
        </div>

        <div v-if="!isShipping" class="card">
          <div class="row" style="margin-bottom: 12px">
            <h2 style="margin: 0">Invoicing</h2>
            <div class="spacer" />
            <button
              v-if="auth.isSenior && !ticket.invoices.length"
              class="small" @click="createInvoice"
            >Create invoice record</button>
          </div>
          <p v-if="ticket.qc_required && !ticket.qc_passed_at" class="muted small">
            QC must pass before this ticket can be invoiced.
          </p>
          <div v-if="!ticket.invoices.length" class="empty">No invoice yet.</div>
          <ul v-else class="timeline">
            <li v-for="inv in ticket.invoices" :key="inv.id">
              <strong>{{ inv.status }}</strong>
              <span v-if="inv.amount"> · ${{ inv.amount }}</span>
              <div class="muted small">
                {{ inv.xero_invoice_id ? `Xero ${inv.xero_invoice_id}` : 'Not yet linked to Xero' }}
              </div>
            </li>
          </ul>
        </div>

        <div class="card">
          <h2>Status history</h2>
          <ul class="timeline">
            <li v-for="h in ticket.status_history" :key="h.id">
              <strong>{{ h.new_label || h.new_status }}</strong>
              <span v-if="h.old_status" class="muted"> ← {{ h.old_label || h.old_status }}</span>
              <div class="muted small">
                {{ h.changed_by_name || 'System' }} · {{ when(h.changed_at) }}
              </div>
              <div v-if="h.note" class="small">{{ h.note }}</div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
