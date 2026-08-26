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
 */
import { computed } from 'vue';
import api from '../api';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const shipment = computed(() => props.ticket.shipments?.[0]);
const locked = computed(() => !!shipment.value?.shipped_at);
const doneCount = computed(() => (shipment.value?.checklist || []).filter((i) => i.checked).length);

async function patchShipment(payload) {
  await api.patch(`/shipments/${shipment.value.id}`, payload);
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

    <button v-if="!locked" class="primary" @click="markShipped">Mark shipped</button>
  </div>
</template>
