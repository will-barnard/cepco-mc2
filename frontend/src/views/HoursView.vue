<script setup>
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useAuth, useRefData } from '../stores';

const auth = useAuth();
const refData = useRefData();

const entries = ref([]);
const workload = ref([]);
const accuracy = ref([]);

const today = new Date();
const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

const filters = ref({
  employee_id: '',
  from: monthStart.toISOString().slice(0, 10),
  to: today.toISOString().slice(0, 10),
});

const total = computed(
  () => entries.value.reduce((sum, e) => sum + Number(e.hours), 0),
);

async function load() {
  entries.value = await api.get('/hours', filters.value);
}

onMounted(async () => {
  await load();
  if (auth.isAdmin) {
    [workload.value, accuracy.value] = await Promise.all([
      api.get('/hours/by-employee'),
      api.get('/estimates/reference'),
    ]);
  }
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Hours</h1>
      <span class="muted">{{ total.toFixed(1) }} hrs in range</span>
    </div>

    <div class="card tight" style="margin-bottom: 16px">
      <div class="field-row" style="align-items: end">
        <div v-if="auth.isAdmin">
          <label>Tech</label>
          <select v-model="filters.employee_id" @change="load">
            <option value="">Everyone</option>
            <option v-for="e in refData.employees" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </div>
        <div>
          <label>From</label>
          <input v-model="filters.from" type="date" @change="load" />
        </div>
        <div>
          <label>To</label>
          <input v-model="filters.to" type="date" @change="load" />
        </div>
      </div>
    </div>

    <div v-if="auth.isAdmin" class="grid cols-2" style="margin-bottom: 16px">
      <div class="card tight">
        <h2>Tech workload</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Tech</th><th class="right">Week</th><th class="right">Month</th><th class="right">Open</th></tr>
            </thead>
            <tbody>
              <tr v-for="w in workload" :key="w.id">
                <td>{{ w.name }} <span class="tag">{{ w.role }}</span></td>
                <td class="right">{{ Number(w.hours_this_week).toFixed(1) }}</td>
                <td class="right">{{ Number(w.hours_this_month).toFixed(1) }}</td>
                <td class="right">{{ w.open_tickets }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card tight">
        <h2>Estimate accuracy</h2>
        <p class="muted small" style="margin-top: -6px">
          Actual minus estimated, by instrument and tier. This is what feeds
          confidence scoring once there's enough history.
        </p>
        <div v-if="!accuracy.length" class="empty">
          Not enough completed jobs with both an estimate and logged hours yet.
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Family</th><th>Tier</th><th class="right">n</th>
                <th class="right">Est</th><th class="right">Actual</th><th class="right">Var</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(a, i) in accuracy" :key="i">
                <td>{{ a.family }}</td>
                <td class="small">{{ a.priority_label }}</td>
                <td class="right">{{ a.sample_size }}</td>
                <td class="right">{{ a.avg_estimated }}</td>
                <td class="right">{{ a.avg_actual }}</td>
                <td class="right" :style="a.avg_variance > 0 ? 'color: var(--amber)' : 'color: var(--green)'">
                  {{ a.avg_variance > 0 ? '+' : '' }}{{ a.avg_variance }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card tight">
      <h2>Entries</h2>
      <div v-if="!entries.length" class="empty">No hours logged in this range.</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr><th>Date</th><th>Tech</th><th>Ticket</th><th>Task</th><th class="right">Hours</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in entries" :key="e.id">
              <td class="nowrap">{{ e.worked_on }}</td>
              <td>{{ e.employee_name }}</td>
              <td><RouterLink :to="`/tickets/${e.ticket_id}`">{{ e.ticket_title }}</RouterLink></td>
              <td class="small muted">{{ e.task_description || '—' }}</td>
              <td class="right">{{ Number(e.hours).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
