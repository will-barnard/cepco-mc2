<script setup>
/**
 * Parts / Supplies -- used two places:
 *   - The "+ New" page's Parts/Supplies tab (NewView.vue), full view:
 *     filter, add, edit any field, remove, and a "+ Add" button on each
 *     vendor box to add another item for that vendor in place. This
 *     replaced the old standalone /parts route (see NOTES.md).
 *   - DashboardView.vue's Parts/Supplies card, for whichever employees
 *     Settings -> Staff accounts has opted in (employees.show_parts_on_dashboard,
 *     migration 058) -- `allow-create="false"` there: view and "Mark ordered"
 *     only, no filter, no adding or editing, per that same product decision.
 *
 * Two states only: needed -> ordered, plus the day it was ordered
 * (migration 074, NOTES.md §2.102). Delivered/cancelled are gone from the
 * UI; old rows with those statuses are archived and never shown here.
 *
 * A ticket-linked order (Vendor Orders, TicketVendorOrders.vue) is just a
 * normal row here too -- its ticket tag shows alongside vendor/status.
 */
import { ref, computed, nextTick, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { formatYmd, shopDate } from '../dates';

const props = defineProps({
  allowCreate: { type: Boolean, default: true },
});

const OTHER_VENDOR = '__other__';
const FILTERS = [
  { key: 'all', label: 'Needed & ordered' },
  { key: 'needed', label: 'Needed' },
  { key: 'ordered', label: 'Ordered' },
];
const pill = { needed: 'amber', ordered: 'blue' };

const orders = ref([]);
const vendors = ref([]);
const filter = ref('all');
const error = ref('');

// --- vendor picker helpers ---------------------------------------------------
// The picker's value is a vendor id, OTHER_VENDOR (reveals a free-text
// field, migration 025), or '' for none. These convert to/from the API's
// vendor_id / vendor_other pair.
function vendorPayload(f) {
  const usingOther = f.vendor_id === OTHER_VENDOR;
  return {
    vendor_id: usingOther ? null : (f.vendor_id || null),
    vendor_other: usingOther ? (f.vendor_other || '').trim() || null : null,
  };
}
function pickerValue(o) {
  if (o.vendor_id) return o.vendor_id;
  return o.vendor_other ? OTHER_VENDOR : '';
}

// --- grouping --------------------------------------------------------------
// Grouped by vendor *identity*, not display name, so the quick-add on a box
// knows exactly which vendor to file the new item under (a real vendor vs.
// an "Other…" name vs. no vendor at all).
const grouped = computed(() => {
  const map = new Map();
  for (const o of orders.value) {
    let key = 'none';
    if (o.vendor_id) key = `id:${o.vendor_id}`;
    else if (o.vendor_other) key = `other:${o.vendor_other.trim().toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: o.vendor_name || 'No vendor',
        vendor_id: o.vendor_id || null,
        vendor_other: o.vendor_id ? null : (o.vendor_other || null),
        items: [],
      });
    }
    map.get(key).items.push(o);
  }
  return [...map.values()];
});

async function load() {
  // The compact (dashboard) view sends no status/archived params, meaning
  // "every non-archived order" -- the "what's outstanding" glance.
  const params = {};
  if (props.allowCreate && filter.value !== 'all') params.status = filter.value;
  orders.value = await api.get('/parts', params);
}

async function run(fn) {
  error.value = '';
  try {
    await fn();
    return true;
  } catch (err) {
    error.value = err.message;
    return false;
  }
}

// --- top "new order" form ---------------------------------------------------
const form = ref({ vendor_id: '', vendor_other: '', item: '', quantity: '', notes: '' });

async function create() {
  const ok = await run(async () => {
    await api.post('/parts', {
      ...vendorPayload(form.value),
      item: form.value.item,
      quantity: form.value.quantity || null,
      notes: form.value.notes || null,
    });
    await load();
  });
  // Vendor stays picked -- adding several things from one supplier in a
  // row is the common case.
  if (ok) Object.assign(form.value, { item: '', quantity: '', notes: '' });
}

// --- per-vendor quick add ---------------------------------------------------
// One box at a time. Stays open after each add (and refocuses Item) so a
// run of items for one vendor is type, Enter, type, Enter.
const quickAddFor = ref(null);
const quick = ref({ item: '', quantity: '', notes: '' });
const quickItemInput = ref(null);

async function openQuickAdd(group) {
  quickAddFor.value = group.key;
  quick.value = { item: '', quantity: '', notes: '' };
  await nextTick();
  // A ref inside v-for comes back as an array.
  const el = Array.isArray(quickItemInput.value) ? quickItemInput.value[0] : quickItemInput.value;
  el?.focus();
}

async function submitQuickAdd(group) {
  const ok = await run(async () => {
    await api.post('/parts', {
      vendor_id: group.vendor_id,
      vendor_other: group.vendor_other,
      item: quick.value.item,
      quantity: quick.value.quantity || null,
      notes: quick.value.notes || null,
    });
    await load();
  });
  if (ok) await openQuickAdd(group);
}

// --- inline edit ------------------------------------------------------------
const editingId = ref(null);
const edit = ref({});
const saving = ref(false);

function startEdit(o) {
  quickAddFor.value = null;
  editingId.value = o.id;
  edit.value = {
    vendor_id: pickerValue(o),
    vendor_other: o.vendor_other || '',
    item: o.item,
    quantity: o.quantity || '',
    notes: o.notes || '',
    status: o.status,
    ordered_at: o.ordered_at || '',
  };
}

function onEditStatusChange() {
  // Picking "ordered" pre-fills today so the date field is never blank;
  // it's still editable for "we ordered that on Friday."
  if (edit.value.status === 'ordered' && !edit.value.ordered_at) {
    edit.value.ordered_at = shopDate(new Date());
  }
}

async function saveEdit(o) {
  saving.value = true;
  const ok = await run(async () => {
    await api.patch(`/parts/${o.id}`, {
      ...vendorPayload(edit.value),
      item: edit.value.item,
      quantity: edit.value.quantity,
      notes: edit.value.notes,
      status: edit.value.status,
      ordered_at: edit.value.status === 'ordered' ? edit.value.ordered_at || null : null,
    });
    await load();
  });
  saving.value = false;
  if (ok) editingId.value = null;
}

async function removeOrder(o) {
  if (!confirm(`Remove "${o.item}" from the list?`)) return;
  const ok = await run(async () => {
    await api.del(`/parts/${o.id}`);
    await load();
  });
  if (ok) editingId.value = null;
}

async function markOrdered(o) {
  await run(async () => {
    await api.patch(`/parts/${o.id}`, { status: 'ordered' });
    await load();
  });
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
      <div class="seg">
        <button
          v-for="f in FILTERS" :key="f.key" type="button"
          :class="['small', { primary: filter === f.key }]"
          @click="filter = f.key; load()"
        >{{ f.label }}</button>
      </div>
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
      <template v-if="!allowCreate">Nothing outstanding right now.</template>
      <template v-else-if="filter === 'all'">Nothing on the list.</template>
      <template v-else>Nothing {{ filter }} right now.</template>
    </div>

    <div v-else class="stack">
      <div v-for="g in grouped" :key="g.key" class="card tight">
        <div class="row" style="margin-bottom: 12px">
          <h2 style="margin: 0">{{ g.name }}</h2>
          <div class="spacer" />
          <button
            v-if="allowCreate" class="small" type="button"
            :title="`Add another item from ${g.name}`"
            @click="quickAddFor === g.key ? (quickAddFor = null) : openQuickAdd(g)"
          >{{ quickAddFor === g.key ? 'Done' : '+ Add' }}</button>
        </div>

        <form
          v-if="quickAddFor === g.key" class="field-row quick-add"
          @submit.prevent="submitQuickAdd(g)" @keydown.esc="quickAddFor = null"
        >
          <div style="grid-column: span 2">
            <label>Item *</label>
            <input ref="quickItemInput" v-model="quick.item" required />
          </div>
          <div>
            <label>Quantity</label>
            <input v-model="quick.quantity" />
          </div>
          <div>
            <label>Notes</label>
            <input v-model="quick.notes" />
          </div>
          <div style="align-self: end"><button class="primary" type="submit">Add</button></div>
        </form>

        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Item</th><th>Qty</th><th>Notes</th><th>Ticket</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              <template v-for="o in g.items" :key="o.id">
                <tr v-if="editingId !== o.id">
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
                  <td class="nowrap">
                    <span :class="['pill', pill[o.status] || 'slate']">{{ o.status }}</span>
                    <span v-if="o.status === 'ordered' && o.ordered_at" class="small muted" style="margin-left: 6px">
                      {{ formatYmd(o.ordered_at) }}
                    </span>
                  </td>
                  <td class="right nowrap">
                    <button v-if="o.status === 'needed'" class="small" @click="markOrdered(o)">
                      Mark ordered
                    </button>
                    <button v-if="allowCreate" class="small" @click="startEdit(o)">Edit</button>
                  </td>
                </tr>

                <tr v-else class="editing">
                  <td colspan="6">
                    <form @submit.prevent="saveEdit(o)" @keydown.esc="editingId = null">
                      <div class="field-row">
                        <div>
                          <label>Vendor</label>
                          <select v-model="edit.vendor_id">
                            <option value="">— none —</option>
                            <option v-for="v in vendors" :key="v.id" :value="v.id">{{ v.name }}</option>
                            <!-- An order can point at a vendor that's since been
                                 hidden in Settings; keep it selectable so saving
                                 an unrelated field doesn't silently drop it. -->
                            <option
                              v-if="o.vendor_id && !vendors.some((v) => v.id === o.vendor_id)"
                              :value="o.vendor_id"
                            >{{ o.vendor_name }} (hidden)</option>
                            <option :value="OTHER_VENDOR">Other…</option>
                          </select>
                        </div>
                        <div v-if="edit.vendor_id === OTHER_VENDOR">
                          <label>Vendor name *</label>
                          <input v-model="edit.vendor_other" required />
                        </div>
                        <div style="grid-column: span 2">
                          <label>Item *</label>
                          <input v-model="edit.item" required />
                        </div>
                        <div>
                          <label>Quantity</label>
                          <input v-model="edit.quantity" />
                        </div>
                        <div>
                          <label>Notes</label>
                          <input v-model="edit.notes" />
                        </div>
                        <div>
                          <label>Status</label>
                          <select v-model="edit.status" @change="onEditStatusChange">
                            <option value="needed">needed</option>
                            <option value="ordered">ordered</option>
                          </select>
                        </div>
                        <div v-if="edit.status === 'ordered'">
                          <label>Ordered on</label>
                          <input v-model="edit.ordered_at" type="date" />
                        </div>
                      </div>
                      <div class="row" style="margin-top: 10px">
                        <button class="primary small" type="submit" :disabled="saving">
                          {{ saving ? 'Saving…' : 'Save' }}
                        </button>
                        <button class="small" type="button" @click="editingId = null">Cancel</button>
                        <div class="spacer" />
                        <button class="small danger" type="button" @click="removeOrder(o)">Remove</button>
                      </div>
                    </form>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.quick-add {
  margin-bottom: 12px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}
tr.editing > td { background: var(--surface-2); }
</style>
