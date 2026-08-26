<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import api from '../api';
import { useAuth, useSettings, useRefData } from '../stores';
import TicketPhotos from '../components/TicketPhotos.vue';
import TicketQc from '../components/TicketQc.vue';
import TicketHours from '../components/TicketHours.vue';
import TicketEstimate from '../components/TicketEstimate.vue';
import TicketPurchase from '../components/TicketPurchase.vue';
import TicketShipment from '../components/TicketShipment.vue';
import TicketSubTickets from '../components/TicketSubTickets.vue';

const props = defineProps({ id: { type: String, required: true } });

const auth = useAuth();
const settings = useSettings();
const refData = useRefData();
const router = useRouter();

const ticket = ref(null);
const loading = ref(true);
const error = ref('');
const statusNote = ref('');
const notesDraft = ref('');
const savingNotes = ref(false);

async function load() {
  loading.value = true;
  try {
    ticket.value = await api.get(`/tickets/${props.id}`);
    notesDraft.value = ticket.value.notes || '';
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
  router.push({ name: 'tickets' });
}

const when = (ts) => new Date(ts).toLocaleString();

// Shipping tickets are pack-and-send jobs, not billable repair work — no QC
// round, no labor estimate, no hours logging, no invoice. Just the shared
// Details card plus the Shipment card (TicketShipment.vue). See NOTES.md.
const isShipping = computed(() => ticket.value?.category_key === 'shipping');
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
                  v-for="s in settings.statusesForCategory(ticket.category_key)"
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
          </div>

          <div class="field-row">
            <div class="field">
              <label>Assigned tech</label>
              <select
                :value="ticket.assigned_tech_id || ''"
                @change="patch({ assigned_tech_id: $event.target.value || null })"
              >
                <option value="">— unassigned —</option>
                <option v-for="e in refData.employees" :key="e.id" :value="e.id">
                  {{ e.name }} ({{ e.role }})
                </option>
              </select>
            </div>
            <div class="field">
              <label>Tech level required</label>
              <select
                :value="ticket.tech_level_key || ''"
                @change="patch({ tech_level_key: $event.target.value || null })"
              >
                <option value="">— any —</option>
                <option v-for="t in settings.active('tech_level')" :key="t.key" :value="t.key">
                  {{ t.label }}
                </option>
              </select>
            </div>
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
        </div>

        <TicketSubTickets :ticket="ticket" @changed="load" />

        <TicketPurchase v-if="ticket.purchase_id" :ticket="ticket" @changed="load" />
        <TicketShipment v-if="ticket.shipments?.length" :ticket="ticket" @changed="load" />
        <TicketEstimate v-if="!isShipping" :ticket="ticket" @changed="load" />
        <TicketHours v-if="!isShipping" :ticket="ticket" @changed="load" />
      </div>

      <!-- --------------------------------------- right: QC, photos, log -->
      <div class="stack">
        <TicketQc v-if="!isShipping" :ticket="ticket" @changed="load" />
        <TicketPhotos :ticket-id="ticket.id" />

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
