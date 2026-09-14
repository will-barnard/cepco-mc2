<script setup>
/**
 * Custom Shop -- supplies orders named after this ticket, e.g. "Ordered
 * from Stewart-MacDonald for #482 — Dolly Jones - Rhodes Stage 73". Same
 * parts_orders/parts_order_tickets link (migration 001) the general
 * Parts/Supplies view (PartsOrdersPanel.vue, the "+ New" page's
 * Parts/Supplies tab) already reads and writes -- an order created here
 * shows up there too, and vice versa; this is just a ticket-scoped window
 * onto the same table, not a separate concept. "Category" turned out to
 * just mean vendor (parts_orders already had vendor_id/vendor_other), so
 * no schema changed to add this.
 *
 * Fetches with no `archived` param (see routes/parts.js's GET /) so a
 * delivered order's history stays visible here even though it drops out
 * of the general view's default (non-archived) list -- a ticket's own box
 * is a small, bounded thing, not an operational board that needs pruning.
 *
 * Same "only renders once there's something to show" shape as
 * TicketSubTickets.vue: empty and no form open means no card at all,
 * rather than an empty "No Custom Shop orders yet" card on every ticket.
 * One can also start open already -- NewTicketForm.vue's own Custom Shop
 * disclosure creates the first order (if any) at ticket-creation time, so
 * this card shows up already populated the first time the ticket loads,
 * same as it would for one added later via openForm() below.
 */
import { ref, onMounted } from 'vue';
import api from '../api';

const props = defineProps({ ticket: { type: Object, required: true } });

const orders = ref([]);
const loading = ref(true);
const error = ref('');
const showForm = ref(false);
const creating = ref(false);

const OTHER_VENDOR = '__other__';
const vendors = ref([]);
const form = ref({ vendor_id: '', vendor_other: '', quantity: '', notes: '' });

const STATUSES = ['needed', 'ordered', 'delivered', 'cancelled'];
const pill = {
  needed: 'amber', ordered: 'blue', delivered: 'green', cancelled: 'slate',
};

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    orders.value = await api.get('/parts', { ticket_id: props.ticket.id });
  } finally {
    if (!silent) loading.value = false;
  }
}

onMounted(async () => {
  vendors.value = await api.get('/parts/vendors');
  await load();
});

function openForm() {
  form.value = { vendor_id: '', vendor_other: '', quantity: '', notes: '' };
  showForm.value = true;
}

async function createOrder() {
  error.value = '';
  creating.value = true;
  try {
    const usingOther = form.value.vendor_id === OTHER_VENDOR;
    await api.post('/parts', {
      vendor_id: usingOther ? null : (form.value.vendor_id || null),
      vendor_other: usingOther ? form.value.vendor_other.trim() : null,
      // Named after the ticket, always -- not user-editable here, same
      // "named after the ticket" rule NewTicketForm.vue's own Custom Shop
      // section follows for the first order.
      item: props.ticket.title,
      quantity: form.value.quantity || null,
      notes: form.value.notes || null,
      ticket_ids: [props.ticket.id],
    });
    showForm.value = false;
    await load(true);
  } catch (err) {
    error.value = err.message;
  } finally {
    creating.value = false;
  }
}

async function setStatus(order, status) {
  error.value = '';
  try {
    await api.patch(`/parts/${order.id}`, { status });
    await load(true);
  } catch (err) {
    error.value = err.message;
  }
}

defineExpose({ openForm });
</script>

<template>
  <div v-if="!loading && (orders.length || showForm || error)" class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Custom Shop</h2>
      <div class="spacer" />
      <button class="small" @click="showForm ? (showForm = false) : openForm()">
        {{ showForm ? 'Cancel' : '+ Add order' }}
      </button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-if="showForm" class="field-row" style="align-items: end; margin-bottom: 16px">
      <div class="field" style="margin-bottom: 0">
        <label>Vendor</label>
        <select v-model="form.vendor_id">
          <option value="">— none —</option>
          <option v-for="v in vendors" :key="v.id" :value="v.id">{{ v.name }}</option>
          <option :value="OTHER_VENDOR">Other…</option>
        </select>
      </div>
      <div v-if="form.vendor_id === OTHER_VENDOR" class="field" style="margin-bottom: 0">
        <label>Vendor name</label>
        <input v-model="form.vendor_other" placeholder="New supplier's name" />
      </div>
      <div class="field" style="margin-bottom: 0">
        <label>Quantity</label>
        <input v-model="form.quantity" />
      </div>
      <div class="field" style="flex: 2; min-width: 200px; margin-bottom: 0">
        <label>Notes</label>
        <input v-model="form.notes" />
      </div>
      <div class="field" style="flex: none; margin-bottom: 0">
        <label>&nbsp;</label>
        <button class="primary" :disabled="creating" @click="createOrder">
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
      </div>
    </div>

    <div v-if="!orders.length" class="empty">No Custom Shop orders yet.</div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr><th>Vendor</th><th>Qty</th><th>Notes</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.id">
            <td>{{ o.vendor_name || '—' }}</td>
            <td class="small">{{ o.quantity || '—' }}</td>
            <td class="small muted">{{ o.notes || '—' }}</td>
            <td><span :class="['pill', pill[o.status]]">{{ o.status }}</span></td>
            <td class="right nowrap">
              <button v-if="o.status === 'needed'" class="small" @click="setStatus(o, 'ordered')">
                Mark ordered
              </button>
              <button v-if="o.status === 'ordered'" class="small" @click="setStatus(o, 'delivered')">
                Mark delivered
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
