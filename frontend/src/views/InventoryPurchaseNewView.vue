<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useRefData } from '../stores';
import InstrumentModelPicker from '../components/InstrumentModelPicker.vue';

const router = useRouter();
const refData = useRefData();

const shopToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

const instrument = ref({
  family: 'rhodes', model: '', year: '', serial_no: '', identifying_notes: '',
});
const seller = ref({
  name: '', email: '', phone: '', address: '',
});
const price = ref('');
const purchaseDate = ref(shopToday);
const notes = ref('');

const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const result = await api.post('/purchases', {
      instrument: instrument.value,
      seller: seller.value,
      price: price.value,
      purchase_date: purchaseDate.value,
      notes: notes.value || null,
    });
    router.push({ name: 'ticket', params: { id: result.ticket.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 780px">
    <div class="page-head"><h1>Add instrument purchase</h1></div>
    <p class="muted small" style="margin-top: -12px; margin-bottom: 20px">
      Records the instrument and what was paid for it, then drops it into the
      restoration queue as a new ticket.
    </p>

    <form class="card" @submit.prevent="submit">
      <h2>Instrument</h2>
      <div class="field-row">
        <div class="field">
          <label>Family *</label>
          <select v-model="instrument.family" required>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="field">
          <label>Model</label>
          <InstrumentModelPicker :family="instrument.family" v-model="instrument.model" />
        </div>
        <div class="field">
          <label>Year</label>
          <input v-model="instrument.year" placeholder="1972" />
        </div>
        <div class="field">
          <label>Serial</label>
          <input v-model="instrument.serial_no" />
        </div>
      </div>
      <div class="field">
        <label>Condition / identifying notes</label>
        <textarea v-model="instrument.identifying_notes" placeholder="What shape it's in, missing parts, etc." />
      </div>

      <h2 style="margin-top: 20px">Bought from</h2>
      <div class="field-row">
        <div class="field">
          <label>Name *</label>
          <input v-model="seller.name" required placeholder="Who sold it to us" />
        </div>
        <div class="field">
          <label>Email *</label>
          <input v-model="seller.email" type="email" required placeholder="For the purchase receipt" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Phone</label>
          <input v-model="seller.phone" />
        </div>
        <div class="field">
          <label>Address</label>
          <input v-model="seller.address" />
        </div>
      </div>

      <h2 style="margin-top: 20px">Purchase</h2>
      <div class="field-row">
        <div class="field">
          <label>Price paid *</label>
          <input v-model="price" type="number" min="0" step="0.01" required placeholder="0.00" />
        </div>
        <div class="field">
          <label>Purchase date *</label>
          <input v-model="purchaseDate" type="date" required />
        </div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea v-model="notes" placeholder="Anything else worth flagging for the restoration" />
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>

      <div class="row">
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? 'Adding…' : 'Add purchase' }}
        </button>
        <button type="button" @click="router.back()">Cancel</button>
      </div>
    </form>
  </div>
</template>
