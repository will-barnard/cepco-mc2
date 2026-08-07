<script setup>
import { ref, computed } from 'vue';
import api from '../api';
import { useAuth, useRefData } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const auth = useAuth();
const refData = useRefData();

const form = ref({
  hours: '',
  task_description: '',
  worked_on: new Date().toISOString().slice(0, 10),
  employee_id: '',
});
const error = ref('');
const busy = ref(false);

const total = computed(
  () => (props.ticket.hours_log || []).reduce((sum, h) => sum + Number(h.hours), 0),
);
const estimate = computed(() => props.ticket.estimates?.[0]);
const estimatedTotal = computed(() => (estimate.value
  ? Number(estimate.value.estimated_hours) + Number(estimate.value.additional_hours)
  : 0));
const variance = computed(() => total.value - estimatedTotal.value);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/hours', {
      ticket_id: props.ticket.id,
      hours: Number(form.value.hours),
      task_description: form.value.task_description || null,
      worked_on: form.value.worked_on,
      employee_id: form.value.employee_id || undefined,
    });
    form.value.hours = '';
    form.value.task_description = '';
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function remove(entry) {
  if (!confirm('Delete this time entry?')) return;
  try {
    await api.del(`/hours/${entry.id}`);
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Hours</h2>
      <div class="spacer" />
      <span class="muted small">
        {{ total.toFixed(1) }} logged
        <template v-if="estimatedTotal"> / {{ estimatedTotal.toFixed(1) }} estimated</template>
      </span>
      <span
        v-if="estimatedTotal"
        :class="['pill', variance > 0 ? 'amber' : 'green']"
      >
        {{ variance > 0 ? '+' : '' }}{{ variance.toFixed(1) }} hrs
      </span>
    </div>

    <form class="field-row" style="align-items: end" @submit.prevent="submit">
      <div>
        <label>Hours *</label>
        <input v-model="form.hours" type="number" step="0.25" min="0.25" max="24" required />
      </div>
      <div>
        <label>Date</label>
        <input v-model="form.worked_on" type="date" />
      </div>
      <div v-if="auth.isAdmin">
        <label>Tech</label>
        <select v-model="form.employee_id">
          <option value="">{{ auth.user.name }} (me)</option>
          <option v-for="e in refData.employees" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </div>
      <div style="flex: 2; min-width: 220px">
        <label>What was done</label>
        <input v-model="form.task_description" placeholder="Grommets + hammer tips" />
      </div>
      <div>
        <button class="primary" type="submit" :disabled="busy">Log</button>
      </div>
    </form>

    <div v-if="error" class="alert" style="margin: 12px 0">{{ error }}</div>

    <div v-if="!ticket.hours_log?.length" class="empty">No hours logged yet.</div>
    <div v-else class="table-wrap" style="margin-top: 12px">
      <table>
        <thead>
          <tr><th>Date</th><th>Tech</th><th>Task</th><th class="right">Hours</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="h in ticket.hours_log" :key="h.id">
            <td class="nowrap">{{ h.worked_on }}</td>
            <td>{{ h.employee_name }}</td>
            <td>{{ h.task_description || '—' }}</td>
            <td class="right">{{ Number(h.hours).toFixed(2) }}</td>
            <td class="right">
              <button
                v-if="auth.isAdmin || h.employee_id === auth.user.id"
                class="link" @click="remove(h)"
              >Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
