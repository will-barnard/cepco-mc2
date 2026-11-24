<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useRefData } from '../stores';
import InstrumentModelPicker from '../components/InstrumentModelPicker.vue';
import DraftNotice from '../components/DraftNotice.vue';
import { useDraft } from '../drafts';

const router = useRouter();
const refData = useRefData();

const shopToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

const instrument = ref({
  family: 'rhodes', nickname: '', model: '', model_id: null, year: '', serial_no: '', identifying_notes: '',
});
const seller = ref({
  name: '', email: '', phone: '', address: '',
});
const price = ref('');
const purchaseDate = ref(shopToday);
const notes = ref('');
// Off by default: most stock sells as-is. A restoration ticket gets opened
// when it sells as a restoration (Shopify) or someone decides to restore it.
const openTicket = ref(false);
// The receipt used to be sent from the ticket's Purchase card; with no
// ticket by default, offer it here.
const sendReceipt = ref(true);

const error = ref('');
const busy = ref(false);

// Unsaved-form autosave (drafts.js, kiosk feedback Oct 2026).
const purchaseDraft = useDraft('inventory-purchase', null, {
  get: () => ({
    instrument: instrument.value,
    seller: seller.value,
    price: price.value,
    purchaseDate: purchaseDate.value,
    notes: notes.value,
  }),
  set: (v) => {
    instrument.value = v.instrument;
    seller.value = v.seller;
    price.value = v.price;
    purchaseDate.value = v.purchaseDate;
    notes.value = v.notes;
  },
});

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
      open_ticket: openTicket.value,
    });
    purchaseDraft.stop();
    if (sendReceipt.value && result.purchase) {
      try {
        await api.post(`/purchases/${result.purchase.id}/send-receipt`);
      } catch (err) {
        // The purchase is saved; the receipt can be re-sent from the
        // instrument's ownership history.
        console.warn('purchase receipt failed', err);
      }
    }
    if (result.ticket) router.push({ name: 'ticket', params: { id: result.ticket.id } });
    else router.push({ name: 'instrument', params: { id: result.instrument.id } });
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
      Records the instrument and what was paid for it and adds it to inventory
      (for sale). It only goes into the restoration queue if you tick the box
      below — otherwise a ticket is opened when it sells as a restoration.
    </p>

    <form class="card" @submit.prevent="submit">
      <DraftNotice :draft="purchaseDraft" />
      <h2>Instrument</h2>
      <div class="field-row">
        <div class="field">
          <label>Family *</label>
          <select v-model="instrument.family" required>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="field">
          <label>Name</label>
          <input v-model="instrument.nickname" placeholder="Shop nickname, e.g. Blitzen" />
        </div>
        <div class="field">
          <label>Model</label>
          <InstrumentModelPicker :family="instrument.family" v-model="instrument.model" v-model:model-id="instrument.model_id" />
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

      <label class="checkbox" style="margin-bottom: 14px">
        <input v-model="openTicket" type="checkbox" /> Restore it now (open an Inventory Restorations ticket)
      </label>
      <label class="checkbox" style="margin-bottom: 14px">
        <input v-model="sendReceipt" type="checkbox" /> Email the seller the purchase receipt
      </label>

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
