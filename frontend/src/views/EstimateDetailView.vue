<script setup>
/**
 * Estimate detail — the itemized quote, its current status, and the two
 * actions the shop takes on it: email it to the customer (routes/quotes.js
 * POST /:id/send — includes the public confirm/decline link), or convert
 * it to ticket(s) directly without waiting on the customer
 * (POST /:id/create-tickets). Both call the same
 * createTicketsForEstimate() on the backend as the customer's own confirm
 * click, so whichever happens first "wins" and the other is a no-op — see
 * NOTES.md.
 */
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings } from '../stores';

const props = defineProps({ id: { type: String, required: true } });
const settings = useSettings();

const estimate = ref(null);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const sending = ref(false);
const converting = ref(false);

const PILL = {
  draft: 'slate', sent: 'blue', confirmed: 'violet', declined: 'red', ticket_created: 'green',
};

async function load() {
  loading.value = true;
  try {
    estimate.value = await api.get(`/quotes/${props.id}`);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const costRange = computed(() => {
  if (!estimate.value) return '';
  const { min_cost: min, max_cost: max } = estimate.value;
  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
});
// parts_cost (migration 043) is additive to an hours-based item's labor,
// shown alongside so the line item's own price stays legible.
const itemCost = (item) => {
  if (item.pricing_type === 'flat') return money(item.flat_cost);
  let label = `${item.min_hours}–${item.max_hours} hrs`;
  if (item.parts_cost) label += ` + ${money(item.parts_cost)} parts`;
  return label;
};

// Internal-only "assume one outlier" buffer (migration 043 / routes/
// quotes.js's outlierBufferFor) — staff-facing only, never sent to the
// customer (publicQuotes.js and quoteEmail.js both omit it).
const outlierBuffer = computed(() => {
  if (!estimate.value || !estimate.value.outlier_buffer_hours) return null;
  return {
    hours: estimate.value.outlier_buffer_hours,
    cost: money(estimate.value.outlier_buffer_cost),
  };
});

const canEmail = computed(() => estimate.value && estimate.value.status !== 'ticket_created');
const canConvert = computed(() => estimate.value && estimate.value.status !== 'ticket_created');

async function sendEmailToCustomer() {
  error.value = ''; notice.value = '';
  sending.value = true;
  try {
    estimate.value = { ...estimate.value, ...await api.post(`/quotes/${props.id}/send`) };
    notice.value = `Estimate emailed to ${estimate.value.customer_email}.`;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    sending.value = false;
  }
}

async function createTicketsNow() {
  error.value = ''; notice.value = '';
  if (!confirm('Create ticket(s) for this estimate now, without waiting for the customer to confirm?')) return;
  converting.value = true;
  try {
    const result = await api.post(`/quotes/${props.id}/create-tickets`);
    notice.value = `Created ${result.tickets.length} ticket(s).`;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    converting.value = false;
  }
}
</script>

<template>
  <div v-if="loading" class="page"><div class="empty">Loading…</div></div>
  <div v-else-if="estimate" class="page" style="max-width: 820px">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">{{ estimate.title || `Estimate #${estimate.id}` }}</h1>
        <p class="muted small" style="margin: 0">
          {{ estimate.customer_name }}
          <span v-if="estimate.customer_email">· {{ estimate.customer_email }}</span>
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'estimates' }">← Estimates</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="card" style="margin-bottom: 16px">
      <div class="row" style="margin-bottom: 14px">
        <span :class="['pill', PILL[estimate.status] || 'slate']">{{ estimate.status.replace('_', ' ') }}</span>
        <span v-if="estimate.sent_at" class="muted small">
          Sent {{ new Date(estimate.sent_at).toLocaleString() }}
        </span>
        <span v-if="estimate.confirmed_at" class="muted small">
          · Confirmed {{ new Date(estimate.confirmed_at).toLocaleString() }}
        </span>
        <span v-if="estimate.declined_at" class="muted small">
          · Declined {{ new Date(estimate.declined_at).toLocaleString() }}
        </span>
      </div>

      <ul class="checklist" style="margin-bottom: 14px">
        <li v-for="item in estimate.items" :key="item.id" style="align-items: flex-start">
          <span style="flex: 1">
            {{ item.procedure_name }}
            <span class="item-note">
              {{ [item.instrument_family, item.instrument_model].filter(Boolean).join(' ') || 'General' }}
              <template v-if="item.parts_variant_label_snapshot">· {{ item.parts_variant_label_snapshot }}</template>
            </span>
          </span>
          <strong class="small">{{ itemCost(item) }}</strong>
        </li>
      </ul>

      <div class="row" style="border-top: 1px solid var(--border); padding-top: 12px">
        <span>Estimated total</span>
        <div class="spacer" />
        <strong style="font-size: 18px">{{ costRange }}</strong>
      </div>

      <p v-if="outlierBuffer" class="muted small" style="margin: 10px 0 0">
        Internal only — budget ~{{ outlierBuffer.hours }} extra hrs ({{ outlierBuffer.cost }}) assuming
        one line item on this estimate runs long. Never shown to the customer.
      </p>

      <p v-if="estimate.notes" class="muted small" style="margin: 14px 0 0">{{ estimate.notes }}</p>
    </div>

    <div v-if="estimate.tickets.length" class="card" style="margin-bottom: 16px">
      <h2 style="margin-bottom: 10px">Ticket(s) created</h2>
      <ul class="checklist">
        <li v-for="t in estimate.tickets" :key="t.id">
          <RouterLink :to="{ name: 'ticket', params: { id: t.id } }" style="flex: 1">
            #{{ t.id }} — {{ t.title }}
          </RouterLink>
          <span class="tag">{{ t.category_label_snapshot }}</span>
          <span :class="['pill', settings.colorFor(t.status_key)]">{{ t.status_label_snapshot }}</span>
        </li>
      </ul>
    </div>

    <div class="card">
      <div class="row">
        <button
          v-if="canEmail" class="primary" :disabled="sending"
          @click="sendEmailToCustomer"
        >
          {{ sending ? 'Sending…' : (estimate.sent_at ? 'Re-send estimate' : 'Email estimate to customer') }}
        </button>
        <button v-if="canConvert" :disabled="converting" @click="createTicketsNow">
          {{ converting ? 'Creating…' : 'Create ticket manually' }}
        </button>
        <span v-if="!canEmail && !canConvert" class="muted small">
          This estimate has already been converted to ticket(s) above.
        </span>
      </div>
    </div>
  </div>
</template>
