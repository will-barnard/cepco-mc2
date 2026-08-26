<script setup>
/**
 * Estimates — customer-facing quotes (routes/quotes.js; `estimates` rows
 * with kind='customer_quote', see NOTES.md). Defaults to "Ongoing" (the
 * backend's own default when no ?status= is given): everything short of a
 * finished conversion to ticket(s), since once tickets exist the Tickets
 * page is where the work actually gets tracked.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const STATUSES = [
  ['', 'Ongoing'],
  ['draft', 'Draft'],
  ['sent', 'Sent'],
  ['confirmed', 'Confirmed'],
  ['declined', 'Declined'],
  ['ticket_created', 'Ticket created'],
  ['all', 'All'],
];

const PILL = {
  draft: 'slate', sent: 'blue', confirmed: 'violet', declined: 'red', ticket_created: 'green',
};

const estimates = ref([]);
const loading = ref(true);
const status = ref('');

async function load() {
  loading.value = true;
  try {
    estimates.value = await api.get('/quotes', { status: status.value });
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const costRange = (e) => (e.min_cost === e.max_cost ? money(e.min_cost) : `${money(e.min_cost)} – ${money(e.max_cost)}`);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Estimates</h1>
      <div class="row">
        <select v-model="status" style="width: auto; min-width: 150px" @change="load">
          <option v-for="[k, label] in STATUSES" :key="k" :value="k">{{ label }}</option>
        </select>
        <RouterLink class="btn primary" :to="{ name: 'estimate-new' }">+ New estimate</RouterLink>
      </div>
    </div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!estimates.length" class="empty">No estimates match this filter.</div>

    <div v-else class="table-wrap card">
      <table>
        <thead>
          <tr>
            <th>Title</th><th>Customer</th><th>Status</th><th>Items</th>
            <th>Estimated cost</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in estimates" :key="e.id" class="clickable"
            @click="$router.push({ name: 'estimate', params: { id: e.id } })"
          >
            <td>{{ e.title || '—' }}</td>
            <td>{{ e.customer_name || '—' }}</td>
            <td><span :class="['pill', PILL[e.status] || 'slate']">{{ e.status.replace('_', ' ') }}</span></td>
            <td class="small muted">{{ e.item_count }}</td>
            <td>{{ costRange(e) }}</td>
            <td class="small muted">{{ new Date(e.created_at).toLocaleDateString() }}</td>
            <td class="right"><RouterLink :to="{ name: 'estimate', params: { id: e.id } }">View →</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
