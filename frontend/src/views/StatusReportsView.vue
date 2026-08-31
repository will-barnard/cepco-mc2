<script setup>
/**
 * Status Reports — the list of per-ticket customer status reports
 * (routes/statusReports.js). One row per report; "Generate status report"
 * on a ticket's detail page is what creates a new one, so there's no
 * "+ New" action here, unlike Estimates.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const STATUSES = [
  ['', 'All'],
  ['draft', 'Draft'],
  ['sent', 'Sent'],
];

const PILL = { draft: 'slate', sent: 'green' };

const reports = ref([]);
const loading = ref(true);
const status = ref('');

async function load() {
  loading.value = true;
  try {
    reports.value = await api.get('/status-reports', { status: status.value });
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const instrumentLabel = (r) => [r.instrument_family, r.instrument_model].filter(Boolean).join(' ') || '—';
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Status Reports</h1>
      <div class="row">
        <select v-model="status" style="width: auto; min-width: 130px" @change="load">
          <option v-for="[k, label] in STATUSES" :key="k" :value="k">{{ label }}</option>
        </select>
      </div>
    </div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!reports.length" class="empty">
      No status reports yet — generate one from a ticket's detail page.
    </div>

    <div v-else class="table-wrap card">
      <table>
        <thead>
          <tr>
            <th>Ticket</th><th>Customer</th><th>Instrument</th><th>Status</th>
            <th>Generated</th><th>Sent</th><th>Viewed</th><th />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in reports" :key="r.id" class="clickable"
            @click="$router.push({ name: 'status-report', params: { id: r.id } })"
          >
            <td>{{ r.ticket_title }}</td>
            <td>{{ r.customer_name || '—' }}</td>
            <td class="small muted">{{ instrumentLabel(r) }}</td>
            <td><span :class="['pill', PILL[r.status] || 'slate']">{{ r.status }}</span></td>
            <td class="small muted">{{ when(r.generated_at) }}</td>
            <td class="small muted">{{ when(r.sent_at) }}</td>
            <td class="small muted">{{ when(r.viewed_at) }}</td>
            <td class="right"><RouterLink :to="{ name: 'status-report', params: { id: r.id } }">View →</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
