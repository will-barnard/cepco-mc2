<script setup>
/**
 * Parts & Accessories tab on the Inventory page — counted shelf stock
 * (cases, rails, preamps, speaker sets, music racks), the sections of the
 * Inventory Log sheets that aren't individual instruments
 * (inventory_parts, migration 072). Not the same thing as Parts / Supplies
 * (parts_orders), which is what the shop needs to *buy*.
 *
 * Edited inline: these rows are a name, a count and a price, so a detail
 * page would be overkill. Click a row to edit it in place.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useAuth, useRefData } from '../stores';
import { formatPrice } from '../inventory';

const props = defineProps({
  families: { type: Array, default: () => [] },
});

const auth = useAuth();
const refData = useRefData();

const parts = ref([]);
const loading = ref(true);
const error = ref('');
const family = ref('');
const search = ref('');

async function load() {
  loading.value = true;
  try {
    parts.value = await api.get('/inventory/parts');
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return parts.value.filter((p) => (!family.value || p.family === family.value)
    && (!q || [p.name, p.model, p.notes, p.category, p.condition].some((v) => v && v.toLowerCase().includes(q))));
});

const groups = computed(() => {
  const out = [];
  let current = null;
  for (const p of filtered.value) {
    const key = `${p.family}|${p.category || ''}`;
    if (!current || current.key !== key) {
      current = { key, family: p.family, label: p.category || 'Uncategorised', rows: [] };
      out.push(current);
    }
    current.rows.push(p);
  }
  return out;
});

const familiesWithParts = computed(() => props.families.filter((f) => parts.value.some((p) => p.family === f)));
const categoriesFor = (fam) => [...new Set(parts.value.filter((p) => p.family === fam && p.category).map((p) => p.category))];

// --- edit / add -----------------------------------------------------------
const editingId = ref(null); // a part id, or 'new'
const draft = ref({});
const busy = ref(false);

const FIELDS = ['family', 'category', 'name', 'model', 'quantity', 'quantity_note', 'condition', 'price',
  'price_note', 'for_sale', 'on_website', 'notes', 'cost_paid', 'cost_note'];

function startEdit(p) {
  error.value = '';
  editingId.value = p.id;
  draft.value = Object.fromEntries(FIELDS.map((f) => [f, p[f] ?? (f === 'for_sale' ? true : f === 'on_website' ? false : '')]));
}
function startNew() {
  error.value = '';
  editingId.value = 'new';
  draft.value = {
    family: family.value || 'rhodes', category: '', name: '', model: '', quantity: '', quantity_note: '',
    condition: '', price: '', price_note: '', for_sale: true, on_website: false, notes: '', cost_paid: '', cost_note: '',
  };
}
function cancel() { editingId.value = null; }

async function save() {
  busy.value = true;
  error.value = '';
  const body = { ...draft.value };
  if (!auth.isAdmin) { delete body.cost_paid; delete body.cost_note; }
  try {
    if (editingId.value === 'new') {
      const created = await api.post('/inventory/parts', body);
      parts.value.push(created);
    } else {
      const updated = await api.patch(`/inventory/parts/${editingId.value}`, body);
      const idx = parts.value.findIndex((p) => p.id === updated.id);
      if (idx !== -1) parts.value[idx] = updated;
    }
    editingId.value = null;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function adjust(p, delta) {
  const next = Math.max(0, (Number(p.quantity) || 0) + delta);
  try {
    const updated = await api.patch(`/inventory/parts/${p.id}`, { quantity: next });
    Object.assign(p, updated);
  } catch (err) {
    error.value = err.message;
  }
}

async function remove(p) {
  if (!confirm(`Delete "${p.name}" from parts & accessories?`)) return;
  try {
    await api.del(`/inventory/parts/${p.id}`);
    parts.value = parts.value.filter((x) => x.id !== p.id);
    editingId.value = null;
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="row" style="margin-bottom: 12px">
      <select v-model="family" style="width: auto; min-width: 170px; min-height: 34px; padding: 5px 9px">
        <option value="">All families</option>
        <option v-for="f in familiesWithParts" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
      </select>
      <input v-model="search" type="search" placeholder="Search parts…" style="max-width: 280px; min-height: 34px; padding: 6px 10px" />
      <span class="spacer" />
      <button type="button" class="small primary" @click="startNew">+ Add part</button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <form v-if="editingId === 'new'" class="card tight part-form" @submit.prevent="save">
      <h3 style="margin: 0 0 10px">New part / accessory</h3>
      <div class="field-row">
        <div class="field">
          <label>Family *</label>
          <select v-model="draft.family" required>
            <option v-for="f in families" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
          </select>
        </div>
        <div class="field">
          <label>Section</label>
          <input v-model="draft.category" list="part-categories" placeholder="Extra Cases & Pre-amps" />
          <datalist id="part-categories">
            <option v-for="c in categoriesFor(draft.family)" :key="c" :value="c" />
          </datalist>
        </div>
        <div class="field"><label>Name *</label><input v-model="draft.name" required /></div>
        <div class="field"><label>Model / size</label><input v-model="draft.model" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Quantity</label><input v-model="draft.quantity" inputmode="numeric" /></div>
        <div class="field"><label>Price</label><input v-model="draft.price" inputmode="decimal" /></div>
        <div class="field"><label>Condition</label><input v-model="draft.condition" /></div>
        <div v-if="auth.isAdmin" class="field"><label>Paid</label><input v-model="draft.cost_paid" inputmode="decimal" /></div>
      </div>
      <div class="field"><label>Notes</label><input v-model="draft.notes" /></div>
      <div class="row">
        <label class="checkbox"><input v-model="draft.for_sale" type="checkbox" /> For sale</label>
        <label class="checkbox"><input v-model="draft.on_website" type="checkbox" /> On website</label>
        <span class="spacer" />
        <button type="button" class="small" @click="cancel">Cancel</button>
        <button type="submit" class="small primary" :disabled="busy">Add</button>
      </div>
    </form>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!filtered.length" class="empty">No parts or accessories recorded.</div>
    <div v-else class="table-wrap">
      <table class="parts-table">
        <thead>
          <tr>
            <th>Name</th><th>Model / size</th><th class="right">Qty</th><th>Condition</th>
            <th class="right">Price</th><th>Notes</th><th>Sale</th>
            <th v-if="auth.isAdmin" class="right">Paid</th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.key">
          <tr class="group-row">
            <td colspan="99">
              <strong>{{ g.label }}</strong>
              <span class="muted small"> · {{ refData.familyLabel(g.family) }} · {{ g.rows.length }}</span>
            </td>
          </tr>
          <template v-for="p in g.rows" :key="p.id">
            <tr v-if="editingId !== p.id" class="clickable" @click="startEdit(p)">
              <td><strong>{{ p.name }}</strong></td>
              <td class="small">{{ p.model }}</td>
              <td class="right nowrap" @click.stop>
                <button type="button" class="link qty-btn" title="One fewer" @click="adjust(p, -1)">−</button>
                <span :title="p.quantity_note">{{ p.quantity ?? p.quantity_note ?? '—' }}</span>
                <button type="button" class="link qty-btn" title="One more" @click="adjust(p, 1)">+</button>
              </td>
              <td class="small">{{ p.condition }}</td>
              <td class="right nowrap" :title="p.price_note">
                {{ formatPrice(p.price) }}<span v-if="p.price_note" class="muted"> *</span>
              </td>
              <td class="small muted notes-col" :title="p.notes">{{ p.notes }}</td>
              <td>
                <span v-if="!p.for_sale" class="pill slate">NFS</span>
                <span v-else-if="p.on_website" class="pill green">On web</span>
              </td>
              <td v-if="auth.isAdmin" class="right small" :title="p.cost_note">
                {{ p.cost_paid !== null ? formatPrice(p.cost_paid) : (p.cost_note || '') }}
              </td>
            </tr>
            <tr v-else class="edit-row">
              <td colspan="99">
                <form @submit.prevent="save">
                  <div class="field-row">
                    <div class="field"><label>Name</label><input v-model="draft.name" required /></div>
                    <div class="field"><label>Model / size</label><input v-model="draft.model" /></div>
                    <div class="field"><label>Section</label><input v-model="draft.category" /></div>
                    <div class="field"><label>Quantity</label><input v-model="draft.quantity" inputmode="numeric" /></div>
                    <div class="field"><label>Qty note</label><input v-model="draft.quantity_note" /></div>
                  </div>
                  <div class="field-row">
                    <div class="field"><label>Condition</label><input v-model="draft.condition" /></div>
                    <div class="field"><label>Price</label><input v-model="draft.price" inputmode="decimal" /></div>
                    <div class="field"><label>Price note</label><input v-model="draft.price_note" /></div>
                    <template v-if="auth.isAdmin">
                      <div class="field"><label>Paid</label><input v-model="draft.cost_paid" inputmode="decimal" /></div>
                      <div class="field"><label>Paid note</label><input v-model="draft.cost_note" /></div>
                    </template>
                  </div>
                  <div class="field"><label>Notes</label><input v-model="draft.notes" /></div>
                  <div class="row">
                    <label class="checkbox"><input v-model="draft.for_sale" type="checkbox" /> For sale</label>
                    <label class="checkbox"><input v-model="draft.on_website" type="checkbox" /> On website</label>
                    <span class="spacer" />
                    <button v-if="auth.isAdmin" type="button" class="small danger" @click="remove(p)">Delete</button>
                    <button type="button" class="small" @click="cancel">Cancel</button>
                    <button type="submit" class="small primary" :disabled="busy">Save</button>
                  </div>
                </form>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.part-form { margin-bottom: 14px; }
.parts-table { font-size: 13px; }
.parts-table th, .parts-table td { padding: 6px 8px; }
.parts-table .group-row td { background: var(--surface-2); padding-top: 8px; padding-bottom: 8px; }
.edit-row td { background: var(--bg); }
.edit-row .field { margin-bottom: 8px; }
.qty-btn { padding: 0 6px; font-size: 16px; color: var(--text-dim); }
.qty-btn:hover { color: var(--accent); }
.notes-col { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
