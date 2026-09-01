<script setup>
/**
 * Shipment record for a "Shipping" category ticket (PLAN §7's "Shipping
 * Checklist" pattern — method, contact info, international flag, tracking,
 * and a packing checklist auto-seeded per instrument family). Created
 * alongside the ticket by TicketDetailView's "Create shipping ticket"
 * button (routes/tickets.js), so in practice there's exactly one shipment
 * per ticket, though the schema doesn't enforce that — this just renders
 * the first one, same as TicketPurchase does for instrument_purchases.
 *
 * Fields patch individually on change (matching TicketDetailView's own
 * Details card), not a buffered form + save button — that way there's
 * nothing to go stale when `ticket` gets replaced wholesale on @changed.
 *
 * Instruments (migration 040): a shipment isn't always just this ticket's
 * own instrument anymore — "+ Add instrument" below pulls in another
 * already-existing ticket's instrument (its own repair job, its own
 * status) so it travels in *this* shipment instead of "Ship this
 * instrument" spinning up a second, disconnected shipping ticket for it.
 * Each added instrument can share this shipment's own box/tracking number
 * or get its own — that toggle is shipment_items.own_tracking_number.
 */
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const shipment = computed(() => props.ticket.shipments?.[0]);
const items = computed(() => shipment.value?.items || []);
const locked = computed(() => !!shipment.value?.shipped_at);
const doneCount = computed(() => (shipment.value?.checklist || []).filter((i) => i.checked).length);

async function patchShipment(payload) {
  await api.patch(`/shipments/${shipment.value.id}`, payload);
  emit('changed');
}

// --- additional instruments ---------------------------------------------
const showAdd = ref(false);
const candidateQuery = ref('');
const candidates = ref([]);
const addError = ref('');

async function searchCandidates() {
  candidates.value = await api.get(
    `/shipments/${shipment.value.id}/candidate-tickets`,
    candidateQuery.value ? { q: candidateQuery.value } : {},
  );
}

function openAdd() {
  showAdd.value = true;
  addError.value = '';
  candidateQuery.value = '';
  searchCandidates();
}

async function addItem(ticketId) {
  addError.value = '';
  try {
    await api.post(`/shipments/${shipment.value.id}/items`, { source_ticket_id: ticketId });
    showAdd.value = false;
    emit('changed');
  } catch (err) {
    addError.value = err.message;
  }
}

async function removeItem(item) {
  if (!confirm(`Remove ${item.instrument_label} from this shipment?`)) return;
  await api.del(`/shipments/${shipment.value.id}/items/${item.id}`);
  emit('changed');
}

/** Checked = this item gets its own box/tracking number (starts blank,
 * filled in via setItemTracking below); unchecked = it folds back into
 * sharing the shipment's own box/tracking number. Sending '' (not null)
 * when turning it on is what keeps it "own box" even before a tracking
 * number is typed in — see shipments.js's PATCH /items/:itemId. */
async function toggleOwnBox(item, wantsOwnBox) {
  await api.patch(
    `/shipments/${shipment.value.id}/items/${item.id}`,
    { own_tracking_number: wantsOwnBox ? (item.own_tracking_number ?? '') : null },
  );
  emit('changed');
}

async function setItemTracking(item, value) {
  await api.patch(`/shipments/${shipment.value.id}/items/${item.id}`, { own_tracking_number: value });
  emit('changed');
}

async function toggleItem(index) {
  const checklist = shipment.value.checklist.map((item, i) => (
    i === index ? { ...item, checked: !item.checked } : item
  ));
  await patchShipment({ checklist });
}

async function markShipped() {
  if (!confirm('Mark this shipment as shipped? Its details lock after that.')) return;
  await patchShipment({ mark_shipped: true });
}
</script>

<template>
  <div v-if="shipment" class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Shipment</h2>
      <div class="spacer" />
      <span v-if="shipment.shipped_at" class="pill green">
        Shipped {{ new Date(shipment.shipped_at).toLocaleDateString() }}
      </span>
      <span v-else class="pill amber">Not yet shipped</span>
    </div>

    <div class="field-row">
      <div class="field">
        <label>Type</label>
        <select
          :value="shipment.type" :disabled="locked"
          @change="patchShipment({ type: $event.target.value })"
        >
          <option value="basic">Basic</option>
          <option value="deep_pack">Deep pack</option>
        </select>
      </div>
      <div class="field" style="flex: 2">
        <label>Method</label>
        <input
          :value="shipment.method" :disabled="locked"
          placeholder="UPS Ground, freight carrier, local delivery…"
          @change="patchShipment({ method: $event.target.value })"
        />
      </div>
      <div class="field">
        <label class="checkbox" style="margin-top: 22px">
          <input
            type="checkbox" :checked="shipment.international" :disabled="locked"
            @change="patchShipment({ international: $event.target.checked })"
          />
          <span>International</span>
        </label>
      </div>
    </div>

    <div class="field-row">
      <div class="field" style="flex: 2">
        <label>Contact info</label>
        <input
          :value="shipment.contact_info" :disabled="locked"
          placeholder="Recipient name, address, phone"
          @change="patchShipment({ contact_info: $event.target.value })"
        />
      </div>
      <div class="field">
        <label>Scheduled date</label>
        <input
          type="date" :value="shipment.scheduled_date" :disabled="locked"
          @change="patchShipment({ scheduled_date: $event.target.value })"
        />
      </div>
      <div class="field">
        <label>Tracking #</label>
        <input
          :value="shipment.tracking_number"
          @change="patchShipment({ tracking_number: $event.target.value })"
        />
      </div>
    </div>

    <div class="field">
      <label>
        Packing checklist
        <span v-if="shipment.checklist.length" class="muted small">
          ({{ doneCount }} / {{ shipment.checklist.length }})
        </span>
      </label>
      <ul v-if="shipment.checklist.length" class="checklist">
        <li v-for="(item, i) in shipment.checklist" :key="i">
          <input
            type="checkbox" :checked="item.checked" :disabled="locked"
            @change="toggleItem(i)"
          />
          <span>
            {{ item.label }}
            <span v-if="item.note" class="item-note">{{ item.note }}</span>
          </span>
        </li>
      </ul>
      <p v-else class="muted small">
        No shipping checklist template for this instrument family yet — add one in Settings.
      </p>
    </div>

    <div class="field">
      <label>Notes</label>
      <textarea
        :value="shipment.notes" :disabled="locked" style="min-height: 60px"
        @change="patchShipment({ notes: $event.target.value })"
      />
    </div>

    <div class="field">
      <label>Instruments in this shipment</label>
      <ul class="checklist">
        <li>
          <span style="flex: 1">
            {{ ticket.instrument_model || ticket.title }}
            <span class="muted small">(this ticket — shares the shipment's own box/tracking #)</span>
          </span>
        </li>
        <li v-for="item in items" :key="item.id">
          <span style="flex: 1">
            {{ item.instrument_label }}
            <RouterLink
              v-if="item.source_ticket_id"
              :to="{ name: 'ticket', params: { id: item.source_ticket_id } }" class="muted small"
            >
              — #{{ item.source_ticket_id }} {{ item.source_ticket_title }}
            </RouterLink>
          </span>
          <label class="checkbox small" style="margin: 0">
            <input
              type="checkbox" :checked="item.own_tracking_number !== null"
              @change="toggleOwnBox(item, $event.target.checked)"
            />
            <span>Separate box</span>
          </label>
          <input
            v-if="item.own_tracking_number !== null"
            :value="item.own_tracking_number" placeholder="Tracking #" style="width: 140px"
            @change="setItemTracking(item, $event.target.value)"
          />
          <button class="small" title="Remove from this shipment" @click="removeItem(item)">✕</button>
        </li>
      </ul>

      <button v-if="!showAdd" class="small" @click="openAdd">+ Add instrument from another ticket</button>
      <div v-else class="card tight">
        <div v-if="addError" class="alert" style="margin-bottom: 8px">{{ addError }}</div>
        <div class="row" style="margin-bottom: 8px">
          <input
            v-model="candidateQuery" placeholder="Search by customer, title, or instrument…"
            style="flex: 1" @keyup.enter="searchCandidates"
          />
          <button class="small" @click="searchCandidates">Search</button>
          <button class="small" @click="showAdd = false">Cancel</button>
        </div>
        <ul v-if="candidates.length" class="checklist">
          <li v-for="c in candidates" :key="c.id">
            <span style="flex: 1">
              #{{ c.id }} — {{ c.title }}
              <span class="muted small">{{ c.customer_name }} · {{ c.instrument_label }}</span>
            </span>
            <button class="small" @click="addItem(c.id)">Add</button>
          </li>
        </ul>
        <p v-else class="muted small">No matching tickets, or everything that matched is already part of a shipment.</p>
      </div>
    </div>

    <button v-if="!locked" class="primary" @click="markShipped">Mark shipped</button>
  </div>
</template>
