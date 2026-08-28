<script setup>
import { ref, onMounted, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import api from '../api';
import { useSettings } from '../stores';

const settings = useSettings();
const route = useRoute();

const customers = ref([]);
const selected = ref(null);
const search = ref('');
const showNew = ref(false);
const error = ref('');
const form = ref({ name: '', email: '', phone: '', address: '', source: 'direct', notes: '' });

async function load() {
  customers.value = await api.get('/customers', { q: search.value });
}

async function select(id) {
  selected.value = await api.get(`/customers/${id}`);
}

async function create() {
  error.value = '';
  try {
    const created = await api.post('/customers', form.value);
    form.value = { name: '', email: '', phone: '', address: '', source: 'direct', notes: '' };
    showNew.value = false;
    await load();
    await select(created.id);
  } catch (err) {
    error.value = err.message;
  }
}

let debounce;
watch(search, () => {
  clearTimeout(debounce);
  debounce = setTimeout(load, 250);
});

// TicketDetailView's "Customer" link goes to /customers?id=<id> so clicking
// a customer's name from a ticket actually opens that customer's detail
// pane, not just the bare customer list. Watched (not just read once) so
// following a second such link while already on this page — e.g. from one
// ticket's customer to another via browser back/forward — re-selects too,
// since Vue Router reuses this component instance across same-route
// navigations that only change the query string.
watch(() => route.query.id, (id) => {
  if (id) select(id);
}, { immediate: true });

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Customers</h1>
      <button class="primary" @click="showNew = !showNew">
        {{ showNew ? 'Cancel' : 'New customer' }}
      </button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <form v-if="showNew" class="card" style="margin-bottom: 16px" @submit.prevent="create">
      <div class="field-row">
        <div class="field">
          <label>Name *</label>
          <input v-model="form.name" required />
        </div>
        <div class="field">
          <label>Email</label>
          <input v-model="form.email" type="email" />
        </div>
        <div class="field">
          <label>Phone</label>
          <input v-model="form.phone" />
        </div>
        <div class="field">
          <label>Source</label>
          <select v-model="form.source">
            <option value="direct">Direct</option>
            <option value="email">Email</option>
            <option value="shopify">Shopify</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" style="min-height: 60px" />
      </div>
      <button class="primary" type="submit">Create customer</button>
    </form>

    <div class="grid cols-2">
      <div class="card tight">
        <input v-model="search" type="search" placeholder="Search customers" style="margin-bottom: 12px" />
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th class="right">Instruments</th><th class="right">Open</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="c in customers" :key="c.id" class="clickable"
                @click="select(c.id)"
              >
                <td>
                  <strong>{{ c.name }}</strong>
                  <div v-if="c.email" class="muted small">{{ c.email }}</div>
                </td>
                <td class="right">{{ c.instrument_count }}</td>
                <td class="right">{{ c.open_tickets }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!customers.length" class="empty">No customers found.</div>
      </div>

      <div v-if="selected" class="card">
        <h2>{{ selected.name }}</h2>
        <p class="muted small">
          {{ [selected.email, selected.phone, selected.source].filter(Boolean).join(' · ') }}
        </p>
        <p v-if="selected.notes">{{ selected.notes }}</p>

        <h3 style="margin-top: 20px">Instruments</h3>
        <div v-if="!selected.instruments.length" class="muted small">None recorded.</div>
        <ul v-else class="timeline">
          <li v-for="i in selected.instruments" :key="i.id">
            <strong>{{ i.model || i.family }}</strong>
            <div class="muted small">{{ i.family }}<span v-if="i.year"> · {{ i.year }}</span></div>
          </li>
        </ul>

        <h3 style="margin-top: 20px">Tickets</h3>
        <div v-if="!selected.tickets.length" class="muted small">No tickets.</div>
        <ul v-else class="timeline">
          <li v-for="t in selected.tickets" :key="t.id">
            <RouterLink :to="`/tickets/${t.id}`">{{ t.title }}</RouterLink>
            <span :class="['pill', settings.colorFor(t.status_key)]" style="margin-left: 8px">
              {{ t.status_label }}
            </span>
          </li>
        </ul>
      </div>

      <div v-else class="card"><div class="empty">Select a customer to see details.</div></div>
    </div>
  </div>
</template>
