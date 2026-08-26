<script setup>
/**
 * The inventory-restoration queue: instruments CEPCo bought to restore and
 * resell (as opposed to the rental/showroom fleet in FleetView, or work done
 * for a customer). Every row here is a ticket in the 'inventory_restoration'
 * category — this view is just that same ticket data in a purpose-built
 * order and frame, not a separate record type.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import TicketTable from '../components/TicketTable.vue';

const tickets = ref([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  const rows = await api.get('/tickets', { category: 'inventory_restoration' });
  // The list endpoint orders by priority/recency for the general ticket
  // board — this page is a queue instead: oldest purchase first, newest
  // (just added) at the bottom.
  tickets.value = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  loading.value = false;
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Inventory restorations</h1>
        <p class="muted small" style="margin: 0">
          Instruments the shop bought to restore and sell.
          <template v-if="!loading">{{ tickets.length }} in the queue.</template>
        </p>
      </div>
      <RouterLink :to="{ name: 'inventory-purchase-new' }" class="btn primary">
        + Add instrument purchase
      </RouterLink>
    </div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else class="card tight">
      <TicketTable :tickets="tickets" empty-text="Nothing in the restoration queue yet." />
    </div>
  </div>
</template>
