<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '../api';

const orders = ref([]);
const vendors = ref([]);
const statusFilter = ref('needed');
// Delivered orders archive themselves (P2) — hidden by default like
// tickets' own archived filter, this just reveals them again.
const showArchived = ref(false);
const error = ref('');
// '__other__' is a picker sentinel, not a real vendor id — resolved into
// vendor_other (free text) at submit time (P3). Vendors have no Settings
// screen of their own, so a bare "Other" row there would be useless;
// nobody could say *who*.
const OTHER_VENDOR = '__other__';
const form = ref({
  vendor_id: '', vendor_other: '', item: '', quantity: '', notes: '',
});

const STATUSES = ['needed', 'ordered', 'delivered', 'cancelled'];
const pill = {
  needed: 'amber', ordered: 'blue', delivered: 'green', cancelled: 'slate',
};

const grouped = computed(() => {
  const map = new Map();
  for (const o of orders.value) {
    const key = o.vendor_name || 'No vendor';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(o);
  }
  return [...map.entries()];
});

async function load() {
  orders.value = await api.get('/parts', {
    status: statusFilter.value,
    archived: showArchived.value ? 'true' : 'false',
  });
}

async function create() {
  error.value = '';
  try {
    const usingOther = form.value.vendor_id === OTHER_VENDOR;
    await api.post('/parts', {
      vendor_id: usingOther ? null : (form.value.vendor_id || null),
      vendor_other: usingOther ? form.value.vendor_other.trim() : null,
      item: form.value.item,
      quantity: form.value.quantity || null,
      notes: form.value.notes || null,
    });
    form.value.item = '';
    form.value.quantity = '';
    form.value.notes = '';
    form.value.vendor_other = '';
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function setStatus(order, status) {
  try {
    await api.patch(`/parts/${order.id}`, { status });
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(async () => {
  vendors.value = await api.get('/parts/vendors');
  await load();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Parts / Supplies</h1>
      <select v-model="statusFilter" style="width: auto; min-width: 160px" @change="load">
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
      </select>
      <label class="checkbox small" style="margin-left: 12px">
        <input type="checkbox" v-model="showArchived" @change="load" />
        Show archived
      </label>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <form class="card" style="margin-bottom: 16px" @submit.prevent="create">
      <div class="field-row" style="align-items: end">
        <div>
          <label>Vendor</label>
          <select v-model="form.vendor_id">
            <option value="">— none —</option>
            <option v-for="v in vendors" :key="v.id" :value="v.id">{{ v.name }}</option>
            <option :value="OTHER_VENDOR">Other…</option>
          </select>
        </div>
        <div v-if="form.vendor_id === OTHER_VENDOR">
          <label>Vendor name *</label>
          <input v-model="form.vendor_other" required placeholder="New supplier's name" />
        </div>
        <div style="flex: 2; min-width: 220px">
          <label>Item *</label>
          <input v-model="form.item" required placeholder="3 packs #5 reeds" />
        </div>
        <div>
          <label>Quantity</label>
          <input v-model="form.quantity" />
        </div>
        <div style="flex: 2; min-width: 200px">
          <label>Notes</label>
          <input v-model="form.notes" />
        </div>
        <div><button class="primary" type="submit">Add</button></div>
      </div>
    </form>

    <div v-if="!orders.length" class="empty">Nothing with status "{{ statusFilter }}".</div>

    <div v-else class="stack">
      <div v-for="[vendor, items] in grouped" :key="vendor" class="card tight">
        <h2>{{ vendor }}</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Item</th><th>Qty</th><th>Notes</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="o in items" :key="o.id">
                <td>{{ o.item }}</td>
                <td class="small">{{ o.quantity || '—' }}</td>
                <td class="small muted">{{ o.notes || '—' }}</td>
                <td><span :class="['pill', pill[o.status]]">{{ o.status }}</span></td>
                <td class="right nowrap">
                  <button
                    v-if="o.status === 'needed'" class="small"
                    @click="setStatus(o, 'ordered')"
                  >Mark ordered</button>
                  <button
                    v-if="o.status === 'ordered'" class="small"
                    @click="setStatus(o, 'delivered')"
                  >Mark delivered</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
