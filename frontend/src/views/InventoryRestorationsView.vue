<script setup>
/**
 * The inventory-restoration queue: instruments CEPCo bought to restore and
 * resell (as opposed to the rental/showroom fleet in FleetView, or work done
 * for a customer). Every row here is a ticket in the 'inventory_restoration'
 * category — this view is just that same ticket data in a purpose-built
 * order and frame, not a separate record type. Admins can reorder the queue
 * with the ↑/↓ column (TicketTable's queue="category" mode).
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import TicketTable from '../components/TicketTable.vue';

const tickets = ref([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  // Filtering to a single category makes GET /tickets return this
  // category's explicit, admin-reorderable queue order (category_queue_
  // position — see NOTES.md), oldest-created-first by default and stable
  // until an admin deliberately moves something, instead of the general
  // board's priority/recency sort.
  tickets.value = await api.get('/tickets', { category: 'inventory_restoration' });
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
      <TicketTable
        :tickets="tickets" queue="category"
        empty-text="Nothing in the restoration queue yet." @reordered="load"
      />
    </div>
  </div>
</template>
