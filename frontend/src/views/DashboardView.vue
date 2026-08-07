<script setup>
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useAuth, useSettings } from '../stores';
import TicketTable from '../components/TicketTable.vue';

const auth = useAuth();
const settings = useSettings();

const summary = ref(null);
const myTickets = ref([]);
const unassigned = ref([]);
const loading = ref(true);

onMounted(async () => {
  const [s, mine, un] = await Promise.all([
    api.get('/tickets/summary'),
    api.get('/tickets', { assigned_tech_id: auth.user.id, limit: 15 }),
    api.get('/tickets', { assigned_tech_id: 'unassigned', limit: 10 }),
  ]);
  summary.value = s;
  myTickets.value = mine;
  unassigned.value = un;
  loading.value = false;
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Shop overview</h1>
      <RouterLink to="/tickets/new" class="btn primary">New ticket</RouterLink>
    </div>

    <div v-if="loading" class="empty">Loading…</div>

    <template v-else>
      <div class="grid cols-3" style="margin-bottom: 24px">
        <div class="card stat">
          <div class="value">{{ summary.totals.open_tickets }}</div>
          <div class="label">Open tickets</div>
        </div>
        <div class="card stat">
          <div class="value">{{ Number(summary.totals.hours_this_week).toFixed(1) }}</div>
          <div class="label">Hours logged this week</div>
        </div>
        <div class="card stat">
          <div class="value">{{ summary.totals.unassigned }}</div>
          <div class="label">Unassigned</div>
        </div>
      </div>

      <div class="card" style="margin-bottom: 24px">
        <h2>By status</h2>
        <div class="row">
          <RouterLink
            v-for="s in summary.by_status" :key="s.key"
            :to="{ name: 'tickets', query: { status: s.key } }"
            class="btn small"
          >
            <span :class="['pill', settings.colorFor(s.key)]">{{ s.label }}</span>
            <strong style="margin-left: 8px">{{ s.count }}</strong>
          </RouterLink>
        </div>
      </div>

      <div class="card" style="margin-bottom: 24px">
        <h2>Assigned to me</h2>
        <TicketTable :tickets="myTickets" empty-text="Nothing assigned to you right now." />
      </div>

      <div class="card">
        <h2>Unassigned</h2>
        <TicketTable :tickets="unassigned" empty-text="Every ticket has a tech." />
      </div>
    </template>
  </div>
</template>
