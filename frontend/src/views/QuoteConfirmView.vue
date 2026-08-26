<script setup>
/**
 * Public, unauthenticated estimate page — what the "Review & respond to
 * this estimate" email button opens (backend/src/templates/quoteEmail.js).
 * Confirm/Decline are real button clicks here, deliberately not something
 * that happens from the link itself landing on this page — see
 * backend/src/routes/publicQuotes.js for why (mail scanners/clients
 * prefetching links). Looked up by the random confirm_token in the URL,
 * never by a numeric id.
 */
import { ref, onMounted } from 'vue';
import api from '../api';

const props = defineProps({ token: { type: String, required: true } });

const quote = ref(null);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
// Set right after a successful action so the page updates instantly,
// without waiting on (or needing) a second round trip.
const finalStatus = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    quote.value = await api.get(`/public/quotes/${props.token}`);
    finalStatus.value = quote.value.status;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const itemCost = (item) => (item.pricing_type === 'flat'
  ? money(item.flat_cost)
  : `${item.min_hours}–${item.max_hours} hrs`);

function total() {
  let min = 0; let max = 0;
  for (const item of quote.value.items) {
    if (item.pricing_type === 'flat') { min += Number(item.flat_cost); max += Number(item.flat_cost); } else {
      min += Number(item.min_hours) * Number(quote.value.labor_rate);
      max += Number(item.max_hours) * Number(quote.value.labor_rate);
    }
  }
  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
}

async function confirm() {
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post(`/public/quotes/${props.token}/confirm`);
    finalStatus.value = res.status;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function decline() {
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post(`/public/quotes/${props.token}/decline`);
    finalStatus.value = res.status;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div style="max-width: 560px; margin: 40px auto; padding: 0 16px">
    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="error && !quote" class="card">
      <p class="alert">{{ error }}</p>
    </div>
    <div v-else-if="quote" class="card">
      <h1 style="margin-bottom: 4px">{{ quote.title || 'Your estimate' }}</h1>
      <p class="muted small" style="margin: 0 0 20px">
        Chicago Electric Piano Company — for {{ quote.customer_name }}
      </p>

      <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

      <template v-if="finalStatus === 'ticket_created'">
        <p style="font-size: 15px; line-height: 1.5">
          Thanks — this estimate is confirmed and the work is in our queue.
          We'll be in touch as it gets scheduled.
        </p>
      </template>
      <template v-else-if="finalStatus === 'declined'">
        <p style="font-size: 15px; line-height: 1.5">
          Got it — we've marked this estimate as declined. If that was a mistake, or you'd like
          to go ahead after all, use the button below.
        </p>
        <button class="primary" :disabled="busy" @click="confirm">
          {{ busy ? 'Working…' : 'Actually, let\'s proceed' }}
        </button>
      </template>
      <template v-else>
        <ul class="checklist" style="margin-bottom: 14px">
          <li v-for="(item, i) in quote.items" :key="i" style="align-items: flex-start">
            <span style="flex: 1">
              {{ item.procedure_name }}
              <span class="item-note">
                {{ [item.instrument_family, item.instrument_model].filter(Boolean).join(' ') || 'General' }}
              </span>
            </span>
            <strong class="small">{{ itemCost(item) }}</strong>
          </li>
        </ul>
        <div class="row" style="border-top: 1px solid var(--border); padding-top: 12px; margin-bottom: 20px">
          <span>Estimated total</span>
          <div class="spacer" />
          <strong style="font-size: 18px">{{ total() }}</strong>
        </div>

        <div class="row">
          <button class="primary" :disabled="busy" @click="confirm">
            {{ busy ? 'Working…' : 'Confirm & proceed' }}
          </button>
          <button :disabled="busy" @click="decline">Decline</button>
        </div>
      </template>
    </div>
  </div>
</template>
