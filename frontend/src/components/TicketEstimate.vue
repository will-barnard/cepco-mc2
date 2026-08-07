<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const auth = useAuth();
const showForm = ref(false);
const error = ref('');
const busy = ref(false);

const form = ref({
  estimated_hours: '',
  additional_hours: '',
  additional_hours_note: '',
  parts_cost: '',
  labor_rate: null,
  confidence: 'med',
  notes: '',
});

// The default rate is shop configuration, not a hardcoded number — an admin
// can change it under Settings without a deploy.
onMounted(async () => {
  const { labor_rate: rate } = await api.get('/estimates/labor-rate');
  form.value.labor_rate = rate;
});

const current = computed(() => props.ticket.estimates?.[0]);

const totalCost = (e) => (
  Number(e.parts_cost)
  + (Number(e.estimated_hours) + Number(e.additional_hours)) * Number(e.labor_rate)
);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/estimates', {
      ticket_id: props.ticket.id,
      estimated_hours: Number(form.value.estimated_hours) || 0,
      additional_hours: Number(form.value.additional_hours) || 0,
      additional_hours_note: form.value.additional_hours_note || null,
      parts_cost: Number(form.value.parts_cost) || 0,
      labor_rate: form.value.labor_rate,
      confidence: form.value.confidence,
      notes: form.value.notes || null,
    });
    showForm.value = false;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function approve(estimate) {
  error.value = '';
  try {
    await api.post(`/estimates/${estimate.id}/approve`);
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

const confidencePill = { high: 'green', med: 'amber', low: 'red' };
const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Estimate</h2>
      <div class="spacer" />
      <button
        v-if="auth.isSenior" class="small"
        @click="showForm = !showForm"
      >{{ showForm ? 'Cancel' : (current ? 'New revision' : 'Add estimate') }}</button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <form v-if="showForm" class="card tight" style="margin-bottom: 12px" @submit.prevent="submit">
      <div class="field-row">
        <div class="field">
          <label>Labor hours</label>
          <input v-model="form.estimated_hours" type="number" step="0.25" min="0" />
        </div>
        <div class="field">
          <label>Parts cost</label>
          <input v-model="form.parts_cost" type="number" step="0.01" min="0" />
        </div>
        <div class="field">
          <label>Labor rate ($/hr)</label>
          <input v-model="form.labor_rate" type="number" step="1" min="0" />
        </div>
        <div class="field">
          <label>Confidence</label>
          <select v-model="form.confidence">
            <option value="high">High</option>
            <option value="med">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Additional hours</label>
          <input v-model="form.additional_hours" type="number" step="0.25" min="0" />
        </div>
        <div class="field" style="flex: 2">
          <label>What the additional hours cover</label>
          <input v-model="form.additional_hours_note" placeholder="Scope outside the template" />
        </div>
      </div>

      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" style="min-height: 60px" />
      </div>

      <button class="primary" type="submit" :disabled="busy">Save estimate</button>
    </form>

    <div v-if="!ticket.estimates?.length" class="empty">No estimate on this ticket yet.</div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Created</th><th>Hours</th><th>Parts</th><th>Total</th>
            <th>Confidence</th><th>Approved</th><th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in ticket.estimates" :key="e.id">
            <td class="nowrap small">{{ new Date(e.created_at).toLocaleDateString() }}</td>
            <td class="nowrap">
              {{ Number(e.estimated_hours).toFixed(1) }}
              <span v-if="Number(e.additional_hours)" class="muted">
                + {{ Number(e.additional_hours).toFixed(1) }}
              </span>
              <div v-if="e.additional_hours_note" class="muted small">
                {{ e.additional_hours_note }}
              </div>
            </td>
            <td class="nowrap">{{ money(e.parts_cost) }}</td>
            <td class="nowrap"><strong>{{ money(totalCost(e)) }}</strong></td>
            <td><span :class="['pill', confidencePill[e.confidence]]">{{ e.confidence }}</span></td>
            <td class="small">
              {{ e.approved_at ? new Date(e.approved_at).toLocaleDateString() : '—' }}
            </td>
            <td class="right">
              <button
                v-if="!e.approved_at && auth.isSenior"
                class="small" @click="approve(e)"
              >Approve</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
