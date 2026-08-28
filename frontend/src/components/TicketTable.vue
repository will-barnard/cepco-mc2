<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '../stores';

const props = defineProps({
  tickets: { type: Array, required: true },
  emptyText: { type: String, default: 'No tickets match those filters.' },
  // Opt-in — TicketsView.vue's plain flat table is untouched. When set,
  // tickets (which the backend already returns sorted status-first for
  // every queue-scoped list, see routes/tickets.js's GET / ordering) are
  // broken into consecutive-run sections with a status header row, the
  // same grouping DashboardView.vue's "Assigned to me"/"Unassigned" lists
  // and QueueView.vue's queues use.
  groupByStatus: { type: Boolean, default: false },
});

const router = useRouter();
const settings = useSettings();

const open = (id) => router.push({ name: 'ticket', params: { id } });

// Consecutive-run grouping, not a full group-by — the list already arrives
// status-sorted, so this just finds where status_key changes from the
// previous row. When groupByStatus is false, everything is one unlabeled
// section so the template below only has one rendering path.
const sections = computed(() => {
  if (!props.groupByStatus) return [{ key: null, label: null, tickets: props.tickets }];
  const out = [];
  for (const t of props.tickets) {
    const last = out[out.length - 1];
    if (last && last.key === t.status_key) {
      last.tickets.push(t);
    } else {
      out.push({ key: t.status_key, label: t.status_label || t.status_label_snapshot, tickets: [t] });
    }
  }
  return out;
});

/** Estimate-vs-actual: the number the shop actually cares about (PLAN §3). */
function hoursLabel(t) {
  const actual = Number(t.actual_hours || 0);
  const est = Number(t.estimated_hours || 0);
  if (!est && !actual) return '—';
  if (!est) return `${actual.toFixed(1)}`;
  return `${actual.toFixed(1)} / ${est.toFixed(1)}`;
}

function hoursOver(t) {
  const est = Number(t.estimated_hours || 0);
  return est > 0 && Number(t.actual_hours || 0) > est;
}

/** "Sam Tech, Jamie Tech" — a ticket can have zero or more assigned techs. */
function techNames(t) {
  return (t.technicians || []).map((x) => x.name).join(', ') || '—';
}
</script>

<template>
  <div v-if="!tickets.length" class="empty">{{ emptyText }}</div>

  <div v-else class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th class="nowrap">Created</th>
          <th>Customer</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Tech</th>
          <th class="right nowrap">Hrs act/est</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="section in sections" :key="section.key ?? 'all'">
          <tr v-if="groupByStatus" class="status-section-row">
            <td colspan="7" style="padding-top: 16px; border-top: none">
              <span :class="['pill', settings.colorFor(section.key)]">{{ section.label }}</span>
              <span class="muted small" style="margin-left: 6px">{{ section.tickets.length }}</span>
            </td>
          </tr>
        <tr v-for="t in section.tickets" :key="t.id" class="clickable" @click="open(t.id)">
          <td>
            <strong>{{ t.title }}</strong>
            <div v-if="t.instrument_family" class="muted small">
              {{ t.instrument_family }}<span v-if="t.instrument_model"> · {{ t.instrument_model }}</span>
              <span v-if="t.attachment_count" class="tag" style="margin-left: 6px">
                {{ t.attachment_count }} photo{{ t.attachment_count === 1 ? '' : 's' }}
              </span>
            </div>
          </td>
          <td class="nowrap small">{{ new Date(t.created_at).toLocaleDateString() }}</td>
          <td>{{ t.customer_name || (t.instrument_is_fleet ? 'CEPCo fleet' : '—') }}</td>
          <td>
            <span :class="['pill', settings.colorFor(t.status_key)]">
              {{ t.status_label || t.status_label_snapshot }}
            </span>
          </td>
          <td class="small">{{ t.priority_label || t.priority_label_snapshot }}</td>
          <td class="small">{{ techNames(t) }}</td>
          <td class="right nowrap" :style="hoursOver(t) ? 'color: var(--amber)' : ''">
            {{ hoursLabel(t) }}
          </td>
        </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
