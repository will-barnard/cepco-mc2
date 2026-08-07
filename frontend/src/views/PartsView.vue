<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '../api';

const orders = ref([]);
const vendors = ref([]);
const statusFilter = ref('needed');
const error = ref('');
const form = ref({ vendor_id: '', item: '', quantity: '', notes: '' });

const STATUSES = ['needed', 'ordered', 'received', 'cancelled'];
const pill = {
  needed: 'amber', ordered: 'blue', received: 'green', cancelled: 'slate',
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
  orders.value = await api.get('/parts', { status: statusFilter.value });
}

async function create() {
  error.value = '';
  try {
    await api.post('/parts', {
      vendor_id: form.value.vendor_id || null,
      item: form.value.item,
      quantity: form.value.quantity || null,
      notes: form.value.notes || null,
    });
    form.value.item = '';
    form.value.quantity = '';
    form.value.notes = '';
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
      <h1>Parts orders</h1>
      <select v-model="statusFilter" style="width: auto; min-width: 160px" @change="load">
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
      </select>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <form class="card" style="margin-bottom: 16px" @submit.prevent="create">
      <div class="field-row" style="align-items: end">
        <div>
          <label>Vendor</label>
          <select v-model="form.vendor_id">
            <option value="">— none —</option>
            <option v-for="v in vendors" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
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
                    @click="setStatus(o, 'received')"
                  >Mark received</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
