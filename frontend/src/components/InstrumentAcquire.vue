<script setup>
/**
 * "Add to inventory" for a customer's instrument (migration 087): the shop
 * buys it, or takes it on consignment. It's the same instrument either
 * way -- its tickets, photos, model and history carry over -- and the
 * ownership history records who it came from.
 *
 *   Buy:     price, date, notes; optionally opens a restoration ticket and
 *            emails the seller the purchase receipt (same as Record a
 *            purchase). What the shop paid is the piece's cost (admins see it).
 *   Consign: commission and terms; the owner becomes the consignor.
 *
 * Emits `done` with the whole instrument page afterwards.
 */
import { ref, computed } from 'vue';
import api from '../api';

const props = defineProps({ item: { type: Object, required: true } });
const emit = defineEmits(['done', 'cancel']);

const owner = computed(() => props.item.owner || null);
const mode = ref('buy');
const form = ref({
  price: '',
  purchase_date: new Date().toISOString().slice(0, 10),
  notes: '',
  open_ticket: true,
  send_receipt: !!props.item.owner?.email,
  seller_name: '',
  consignment_rate: '',
  consignment_terms: '',
  asking_price: '',
});
const busy = ref(false);
const error = ref('');
const warning = ref('');

async function submit() {
  error.value = '';
  warning.value = '';
  const f = form.value;
  if (mode.value === 'buy' && f.price === '') { error.value = 'What did the shop pay?'; return; }
  if (mode.value === 'buy' && !owner.value && !f.seller_name.trim()) { error.value = 'Who did the shop buy it from?'; return; }
  busy.value = true;
  try {
    const body = mode.value === 'buy'
      ? {
        mode: 'buy', price: f.price, purchase_date: f.purchase_date || null, notes: f.notes.trim() || null,
        open_ticket: f.open_ticket, seller_name: f.seller_name.trim() || null,
      }
      : {
        mode: 'consign', consignment_rate: f.consignment_rate === '' ? null : f.consignment_rate,
        consignment_terms: f.consignment_terms.trim() || null,
        asking_price: f.asking_price === '' ? null : f.asking_price,
      };
    const result = await api.post(`/instruments/${props.item.id}/acquire`, body);
    if (mode.value === 'buy' && f.send_receipt && result.purchase_id) {
      try {
        await api.post(`/purchases/${result.purchase_id}/send-receipt`);
      } catch (err) {
        // The purchase stands; the receipt can be resent from its ticket.
        warning.value = `Bought, but the receipt didn't send: ${err.message}`;
        alert(warning.value);
      }
    }
    emit('done', result);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="card acquire" @submit.prevent="submit">
    <h2 style="margin-bottom: 8px">Add to inventory</h2>
    <div class="row mode-row">
      <label class="checkbox"><input v-model="mode" type="radio" value="buy" /> The shop is buying it</label>
      <label class="checkbox" :class="{ muted: !owner }">
        <input v-model="mode" type="radio" value="consign" :disabled="!owner" />
        Taking it on consignment<span v-if="!owner" class="small"> (needs the owner's customer record)</span>
      </label>
    </div>

    <template v-if="mode === 'buy'">
      <p class="muted small" style="margin-top: 0">
        Bought from <strong>{{ owner ? owner.name : 'the owner' }}</strong>. It becomes shop stock, for sale, with
        what the shop paid as its cost.
      </p>
      <div v-if="!owner" class="field"><label>Bought from (name) *</label><input v-model="form.seller_name" /></div>
      <div class="field-row">
        <div class="field"><label>Paid *</label><input v-model="form.price" inputmode="decimal" placeholder="1500" /></div>
        <div class="field"><label>Date</label><input v-model="form.purchase_date" type="date" /></div>
      </div>
      <div class="field"><label>Notes</label><input v-model="form.notes" placeholder="Condition, what's included…" /></div>
      <label class="checkbox"><input v-model="form.open_ticket" type="checkbox" /> Open a restoration ticket</label>
      <label class="checkbox" :class="{ muted: !owner?.email }">
        <input v-model="form.send_receipt" type="checkbox" :disabled="!owner?.email" />
        Email {{ owner?.email || 'the seller' }} the purchase receipt
        <span v-if="!owner?.email" class="small">(no email on file)</span>
      </label>
    </template>

    <template v-else>
      <p class="muted small" style="margin-top: 0">
        <strong>{{ owner?.name }}</strong> keeps owning it as the consignor until it sells; the shop lists it for sale.
      </p>
      <div class="field-row">
        <div class="field"><label>Commission %</label><input v-model="form.consignment_rate" inputmode="decimal" placeholder="25" /></div>
        <div class="field"><label>Asking price</label><input v-model="form.asking_price" inputmode="decimal" /></div>
      </div>
      <div class="field"><label>Terms</label><input v-model="form.consignment_terms" placeholder="Services + 25% of sale" /></div>
    </template>

    <div v-if="error" class="alert" style="margin: 10px 0">{{ error }}</div>
    <div class="row" style="margin-top: 10px">
      <button class="primary" type="submit" :disabled="busy">
        {{ busy ? 'Saving…' : mode === 'buy' ? 'Record purchase' : 'Start consignment' }}
      </button>
      <button type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>

<style scoped>
.acquire { border-color: var(--accent); }
.mode-row { gap: 18px; margin-bottom: 10px; }
.mode-row input[type='radio'] { width: 16px; height: 16px; min-height: 16px; }
.acquire .checkbox input[type='checkbox'] { width: 16px; height: 16px; min-height: 16px; }
</style>
