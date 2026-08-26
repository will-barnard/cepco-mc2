<script setup>
import { useRouter } from 'vue-router';
import { useSettings, useAuth } from '../stores';
import api from '../api';

const props = defineProps({
  tickets: { type: Array, required: true },
  emptyText: { type: String, default: 'No tickets match those filters.' },
  // Which queue these rows represent, if any: 'category' or 'tech'. Only set
  // this when the parent has already filtered to exactly one category or
  // one assigned tech — reordering only makes sense within a single queue,
  // and this prop is what decides which reorder endpoint gets called. Leave
  // unset (default) for a mixed/unfiltered list to hide the arrows entirely.
  queue: { type: String, default: null },
});

const emit = defineEmits(['reordered']);

const router = useRouter();
const settings = useSettings();
const auth = useAuth();

const open = (id) => router.push({ name: 'ticket', params: { id } });

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

// Admin-only (Settings has the same gate on its own reorder buttons).
// Reordering is server-side (POST /tickets/:id/reorder-category|tech, see
// NOTES.md) — the parent reloads its own list on 'reordered' rather than
// this component guessing at the new order itself.
async function reorder(t, direction) {
  await api.post(`/tickets/${t.id}/reorder-${props.queue}`, { direction });
  emit('reordered');
}
</script>

<template>
  <div v-if="!tickets.length" class="empty">{{ emptyText }}</div>

  <div v-else class="table-wrap">
    <table>
      <thead>
        <tr>
          <th v-if="queue && auth.isAdmin" class="nowrap">Queue</th>
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
        <tr v-for="t in tickets" :key="t.id" class="clickable" @click="open(t.id)">
          <td v-if="queue && auth.isAdmin" class="nowrap">
            <button class="small" @click.stop="reorder(t, 'up')">↑</button>
            <button class="small" @click.stop="reorder(t, 'down')">↓</button>
          </td>
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
          <td class="small">{{ t.assigned_tech_name || '—' }}</td>
          <td class="right nowrap" :style="hoursOver(t) ? 'color: var(--amber)' : ''">
            {{ hoursLabel(t) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
