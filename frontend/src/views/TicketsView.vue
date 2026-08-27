<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';
import TicketTable from '../components/TicketTable.vue';

const route = useRoute();
const router = useRouter();
const settings = useSettings();
const refData = useRefData();

const tickets = ref([]);
const loading = ref(true);

const filters = ref({
  q: route.query.q || '',
  status: route.query.status || '',
  category: route.query.category || '',
  priority: route.query.priority || '',
  instrument_family: route.query.instrument_family || '',
  technician_id: route.query.technician_id || '',
  archived: route.query.archived === 'true',
  // '' = the usual priority/queue order; 'status' = ordered by each
  // status's own position in the shop's workflow (Settings -> Ticket
  // statuses), i.e. status progression rather than alphabetical.
  sort: route.query.sort || '',
});

async function load() {
  loading.value = true;
  try {
    tickets.value = await api.get('/tickets', {
      ...filters.value,
      archived: filters.value.archived ? 'true' : '',
    });
  } finally {
    loading.value = false;
  }
}

// Keep filters in the URL so a filtered view can be bookmarked or shared.
watch(filters, (f) => {
  const query = Object.fromEntries(
    Object.entries(f).filter(([, v]) => v !== '' && v !== false),
  );
  router.replace({ query });
  load();
}, { deep: true });

function reset() {
  filters.value = {
    q: '', status: '', category: '', priority: '',
    instrument_family: '', technician_id: '', archived: false, sort: '',
  };
}

// A "queue" only exists when the list is narrowed to exactly one category
// or one tech (not both at once — those are two different queues, and a
// ticket doesn't have a combined position across them). Anything broader is
// a mixed browse view with no single reorderable order, so the arrows stay
// hidden — see TicketTable's `queue` prop and NOTES.md.
const queueType = computed(() => {
  // sort=status shows a different order than either queue's own position
  // column, so the reorder arrows (which act on that position column)
  // would silently not match what's on screen — hide them in that mode.
  if (filters.value.sort) return null;
  const { category, technician_id: techId } = filters.value;
  if (category && !techId) return 'category';
  if (techId && techId !== 'unassigned' && !category) return 'tech';
  return null;
});

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Tickets</h1>
      <RouterLink to="/tickets/new" class="btn primary">New ticket</RouterLink>
    </div>

    <div class="card tight" style="margin-bottom: 16px">
      <div class="field-row">
        <div>
          <label>Search</label>
          <input v-model="filters.q" type="search" placeholder="Title, notes, customer, model" />
        </div>
        <div>
          <label>Status</label>
          <select v-model="filters.status">
            <option value="">All</option>
            <option v-for="s in settings.statuses" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
        </div>
        <div>
          <label>Category</label>
          <select v-model="filters.category">
            <option value="">All</option>
            <option v-for="c in settings.categories" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
        </div>
        <div>
          <label>Priority</label>
          <select v-model="filters.priority">
            <option value="">All</option>
            <option v-for="p in settings.priorities" :key="p.key" :value="p.key">{{ p.label }}</option>
          </select>
        </div>
        <div>
          <label>Instrument</label>
          <select v-model="filters.instrument_family">
            <option value="">All</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div>
          <label>Tech</label>
          <select v-model="filters.technician_id">
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            <option v-for="e in refData.employees" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </div>
        <div>
          <label>Sort by</label>
          <select v-model="filters.sort">
            <option value="">Priority / queue order</option>
            <option value="status">Status progression</option>
          </select>
        </div>
      </div>
      <div class="row" style="margin-top: 4px">
        <label class="checkbox" style="margin: 0">
          <input v-model="filters.archived" type="checkbox" />
          <span>Show archived</span>
        </label>
        <div class="spacer" />
        <span class="muted small">{{ tickets.length }} ticket(s)</span>
        <button class="small" @click="reset">Clear filters</button>
      </div>
    </div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else class="card tight">
      <TicketTable
        :tickets="tickets" :queue="queueType" :queue-tech-id="filters.technician_id"
        @reordered="load"
      />
    </div>
  </div>
</template>
