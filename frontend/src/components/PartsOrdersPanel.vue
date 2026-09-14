<script setup>
/**
 * Parts / Supplies -- used two places:
 *   - The "+ New" page's Parts/Supplies tab (NewView.vue), full view: filter
 *     by status, show/hide archived (delivered/cancelled), and add a new
 *     order. This replaced the old standalone /parts route (PartsView.vue,
 *     now removed -- router.js no longer has that route; App.vue's nav
 *     link points here instead). See NOTES.md.
 *   - DashboardView.vue's Parts/Supplies card, for whichever employees
 *     Settings -> Staff accounts has opted in (employees.show_parts_on_dashboard,
 *     migration 058) -- `allow-create="false"` there: view and status-change
 *     only, no filter controls and no way to add an order, per that same
 *     product decision -- creating one only ever happens from the tab
 *     above.
 *
 * A ticket-linked order (Vendor Orders, TicketVendorOrders.vue) is just a
 * normal row here too -- parts_order_tickets was already many-to-many
 * (migration 001), so nothing about this component needed to change for
 * that; a ticket tag just shows up in the table alongside vendor/status.
 */
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const props = defineProps({
  allowCreate: { type: Boolean, default: true },
});

const orders = ref([]);
const vendors = ref([]);
const statusFilter = ref('needed');
// Delivered orders archive themselves (P2) -- hidden by default like
// tickets' own archived filter, this just reveals them again. Only
// offered in the full (allowCreate) view -- see this file's header note.
const showArchived = ref(false);
const error = ref('');
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
  // The compact (dashboard) view skips the status/archived filters
  // entirely -- no `status` param and no `archived` param means "every
  // non-archived order, any status," which is the useful "what's
  // outstanding" glance a dashboard card wants, without a dropdown to
  // operate first.
  const params = props.allowCreate ? { status: statusFilter.value, archived: showArchived.value ? 'true' : 'false' } : {};
  orders.value = await api.get('/parts', params);
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
  if (props.allowCreate) vendors.value = await api.get('/parts/vendors');
  await load();
});

defineExpose({ load });
</script>

<template>
  <div>
    <div v-if="allowCreate" class="row" style="margin-bottom: 16px">
      <select v-model="statusFilter" style="width: auto; min-width: 160px" @change="load">
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
      </select>
      <label class="checkbox small" style="margin-left: 12px">
        <input type="checkbox" v-model="showArchived" @change="load" />
        Show archived
      </label>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <form v-if="allowCreate" class="card" style="margin-bottom: 16px" @submit.prevent="create">
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

    <div v-if="!orders.length" class="empty">
      {{ allowCreate ? `Nothing with status "${statusFilter}".` : 'Nothing outstanding right now.' }}
    </div>

    <div v-else class="stack">
      <div v-for="[vendor, items] in grouped" :key="vendor" class="card tight">
        <h2>{{ vendor }}</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Item</th><th>Qty</th><th>Notes</th><th>Ticket</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="o in items" :key="o.id">
                <td>{{ o.item }}</td>
                <td class="small">{{ o.quantity || '—' }}</td>
                <td class="small muted">{{ o.notes || '—' }}</td>
                <td class="small">
                  <template v-if="o.tickets?.length">
                    <RouterLink
                      v-for="t in o.tickets" :key="t.id"
                      :to="{ name: 'ticket', params: { id: t.id } }" class="tag"
                      style="margin-right: 4px"
                    >#{{ t.id }}</RouterLink>
                  </template>
                  <span v-else class="muted">—</span>
                </td>
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
