<script setup>
import { ref } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const auth = useAuth();
const showEdit = ref(false);
const error = ref('');
const notice = ref('');
const busy = ref(false);
const sending = ref(false);

const form = ref({
  seller_name: props.ticket.seller_name || '',
  seller_email: props.ticket.seller_email || '',
  seller_phone: props.ticket.seller_phone || '',
  seller_address: props.ticket.seller_address || '',
  price: props.ticket.purchase_price || '',
  purchase_date: props.ticket.purchase_date || '',
  notes: props.ticket.purchase_notes || '',
});

function openEdit() {
  form.value = {
    seller_name: props.ticket.seller_name || '',
    seller_email: props.ticket.seller_email || '',
    seller_phone: props.ticket.seller_phone || '',
    seller_address: props.ticket.seller_address || '',
    price: props.ticket.purchase_price || '',
    purchase_date: props.ticket.purchase_date || '',
    notes: props.ticket.purchase_notes || '',
  };
  error.value = '';
  showEdit.value = true;
}

async function saveEdit() {
  error.value = '';
  busy.value = true;
  try {
    await api.patch(`/purchases/${props.ticket.purchase_id}`, form.value);
    showEdit.value = false;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function sendReceipt() {
  error.value = '';
  notice.value = '';
  sending.value = true;
  try {
    await api.post(`/purchases/${props.ticket.purchase_id}/send-receipt`);
    notice.value = `Receipt sent to ${props.ticket.seller_email}.`;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    sending.value = false;
  }
}

const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

/** purchase_date is a plain 'YYYY-MM-DD' string — parse from parts, not
 * `new Date(str)`, so it can't display a day off (see NOTES.md §2.13). */
function formatDate(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Purchase</h2>
      <div class="spacer" />
      <button v-if="auth.isSenior" class="small" @click="showEdit ? (showEdit = false) : openEdit()">
        {{ showEdit ? 'Cancel' : 'Edit' }}
      </button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 12px">{{ notice }}</div>

    <form v-if="showEdit" class="card tight" style="margin-bottom: 12px" @submit.prevent="saveEdit">
      <div class="field-row">
        <div class="field">
          <label>Seller name</label>
          <input v-model="form.seller_name" required />
        </div>
        <div class="field">
          <label>Seller email</label>
          <input v-model="form.seller_email" type="email" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Phone</label>
          <input v-model="form.seller_phone" />
        </div>
        <div class="field">
          <label>Address</label>
          <input v-model="form.seller_address" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Price paid</label>
          <input v-model="form.price" type="number" min="0" step="0.01" />
        </div>
        <div class="field">
          <label>Purchase date</label>
          <input v-model="form.purchase_date" type="date" />
        </div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" style="min-height: 60px" />
      </div>
      <button class="primary" type="submit" :disabled="busy">
        {{ busy ? 'Saving…' : 'Save' }}
      </button>
    </form>

    <div class="field-row">
      <div>
        <label>Bought from</label>
        <p style="margin: 0">
          {{ ticket.seller_name }}
          <span v-if="ticket.seller_email" class="muted small"> · {{ ticket.seller_email }}</span>
        </p>
        <p v-if="ticket.seller_phone || ticket.seller_address" class="muted small" style="margin: 2px 0 0">
          {{ [ticket.seller_phone, ticket.seller_address].filter(Boolean).join(' · ') }}
        </p>
      </div>
      <div>
        <label>Price paid</label>
        <p style="margin: 0"><strong>{{ money(ticket.purchase_price) }}</strong></p>
      </div>
      <div>
        <label>Purchase date</label>
        <p style="margin: 0">{{ formatDate(ticket.purchase_date) }}</p>
      </div>
    </div>

    <p v-if="ticket.purchase_notes" class="small" style="margin-top: 8px">{{ ticket.purchase_notes }}</p>

    <div class="row" style="margin-top: 16px; align-items: center">
      <button class="small" :disabled="sending || !ticket.seller_email" @click="sendReceipt">
        {{ sending ? 'Sending…' : (ticket.receipt_sent_at ? 'Resend purchase receipt' : 'Send purchase receipt') }}
      </button>
      <span v-if="ticket.receipt_sent_at" class="muted small">
        Sent {{ new Date(ticket.receipt_sent_at).toLocaleString() }}
      </span>
      <span v-else-if="!ticket.seller_email" class="muted small">No seller email on file — add one to send a receipt.</span>
    </div>
  </div>
</template>
