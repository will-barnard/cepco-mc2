<script setup>
/**
 * "Mark sold" for a shop piece or consignment (migration 087). The sale
 * makes the piece its buyer's instrument: linked to their customer record
 * it's on their page from now on (and every future ticket finds it there);
 * a buyer known only by name can be linked later from the ownership
 * history. Emits `done` with the whole instrument page after the sale.
 */
import { ref, computed } from 'vue';
import api from '../api';
import CustomerSearchSelect from './CustomerSearchSelect.vue';

const props = defineProps({ item: { type: Object, required: true } });
const emit = defineEmits(['done', 'cancel']);

const form = ref({
  sold_at: new Date().toISOString().slice(0, 10),
  sold_price: props.item.asking_price !== null && props.item.asking_price !== undefined ? String(Number(props.item.asking_price)) : '',
  sold_to_customer_id: '',
  sold_to_name: '',
});
const busy = ref(false);
const error = ref('');
const isConsignment = computed(() => props.item.ownership === 'consignment');

function onBuyer(row) {
  if (row) form.value.sold_to_name = row.name;
}

async function submit() {
  error.value = '';
  if (!form.value.sold_to_customer_id && !form.value.sold_to_name.trim()) {
    error.value = 'Who bought it? Link their customer record, or type a name.';
    return;
  }
  busy.value = true;
  try {
    emit('done', await api.post(`/inventory/${props.item.id}/sell`, {
      sold_at: form.value.sold_at || null,
      sold_price: form.value.sold_price === '' ? null : form.value.sold_price,
      sold_to_customer_id: form.value.sold_to_customer_id || null,
      sold_to_name: form.value.sold_to_name.trim() || null,
    }));
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="sell-form" @submit.prevent="submit">
    <h3 style="margin: 0 0 8px">Mark sold</h3>
    <div class="field-row">
      <div class="field"><label>Sold for</label><input v-model="form.sold_price" inputmode="decimal" placeholder="7750" /></div>
      <div class="field"><label>Sold on</label><input v-model="form.sold_at" type="date" /></div>
    </div>
    <div class="field">
      <label>Buyer's customer record</label>
      <CustomerSearchSelect v-model="form.sold_to_customer_id" placeholder="Search customers…" @change="onBuyer" />
    </div>
    <div class="field">
      <label>Buyer's name <span class="muted">(if they have no customer record yet)</span></label>
      <input v-model="form.sold_to_name" />
    </div>
    <p class="muted small" style="margin-top: -4px">
      It becomes the buyer's instrument<template v-if="form.sold_to_customer_id"> and shows on their customer page</template>.
      <template v-if="isConsignment"> The consignor's payout is marked due.</template>
      A mistake can be undone from the ownership history.
    </p>
    <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>
    <div class="row">
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Saving…' : 'Mark sold' }}</button>
      <button type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>

<style scoped>
.sell-form { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 4px; }
</style>
