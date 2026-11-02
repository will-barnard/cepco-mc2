<script setup>
/**
 * Parts on an inventory instrument (instrument_parts, migration 078) — the
 * itemized list of what went into it, with cost and quantity. Lives in the
 * detail page's "Parts & labor" card.
 *
 * Each line saves on its own (not through the page's Save bar), so adding
 * a part can't be lost to an unsaved-changes prompt. A line is typed in, or
 * picked from Parts & Accessories stock — picking takes it off the shelf
 * count, and removing the line puts it back (routes/inventory.js + a DB
 * trigger). "Reserved" = set aside for this piece but not installed yet;
 * every reserved line also shows on Inventory -> Reserved parts.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useAuth, useRefData } from '../stores';
import { formatCents } from '../inventory';

const props = defineProps({
  instrumentId: { type: [Number, String], required: true },
  family: { type: String, default: '' },
});

const auth = useAuth();
const refData = useRefData();

const lines = ref([]);
const loading = ref(true);
const error = ref('');

async function load() {
  try {
    lines.value = await api.get(`/inventory/${props.instrumentId}/parts-used`);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

const lineTotal = (l) => (l.unit_cost === null || l.unit_cost === undefined ? null : Number(l.unit_cost) * Number(l.quantity));
const totals = computed(() => {
  let cost = 0;
  let unpriced = 0;
  for (const l of lines.value) {
    const t = lineTotal(l);
    if (t === null) unpriced += 1; else cost += t;
  }
  return { cost, unpriced, reserved: lines.value.filter((l) => l.reserved).length };
});
const qtyText = (q) => String(Number(q));

async function patch(l, body) {
  error.value = '';
  try {
    const updated = await api.patch(`/inventory/parts-used/${l.id}`, body);
    Object.assign(l, updated);
  } catch (err) {
    error.value = err.message;
    await load(); // put the row back the way the server has it
  }
}

async function remove(l) {
  const back = l.stock_taken > 0 ? ` ${l.stock_taken} will go back on the shelf.` : '';
  if (!confirm(`Remove "${l.description}" from this piece?${back}`)) return;
  error.value = '';
  try {
    await api.del(`/inventory/parts-used/${l.id}`);
    lines.value = lines.value.filter((x) => x.id !== l.id);
  } catch (err) {
    error.value = err.message;
  }
}

// --- add ------------------------------------------------------------------
const adding = ref(false);
const source = ref('typed'); // 'typed' | 'stock'
const stock = ref(null);
const draft = ref({});
const busy = ref(false);

function resetDraft() {
  draft.value = { inventory_part_id: '', description: '', quantity: '1', unit_cost: '', reserved: false, notes: '' };
}

async function openAdd() {
  resetDraft();
  adding.value = true;
  if (!stock.value) {
    try {
      stock.value = await api.get('/inventory/parts');
    } catch (err) {
      error.value = err.message;
      stock.value = [];
    }
  }
}

// This piece's family first — a Rhodes is most likely to use Rhodes stock.
const stockGroups = computed(() => {
  const rows = (stock.value || []).filter((p) => p.quantity === null || p.quantity > 0);
  const fams = [...new Set(rows.map((p) => p.family))]
    .sort((a, b) => (a === props.family ? -1 : b === props.family ? 1 : 0));
  return fams.map((f) => ({ family: f, rows: rows.filter((p) => p.family === f) }));
});
const stockLabel = (p) => {
  const name = [p.name, p.model].filter(Boolean).join(' — ');
  const count = p.quantity === null ? (p.quantity_note || 'uncounted') : `${p.quantity} on shelf`;
  return `${name} (${count})`;
};

function onPickStock() {
  const p = (stock.value || []).find((x) => x.id === Number(draft.value.inventory_part_id));
  // What the shop paid for it is only sent to admins; everyone else types
  // the cost in.
  if (p && p.cost_paid !== undefined && p.cost_paid !== null && !draft.value.unit_cost) {
    draft.value.unit_cost = String(Number(p.cost_paid));
  }
}

async function add() {
  busy.value = true;
  error.value = '';
  try {
    const body = {
      quantity: draft.value.quantity,
      unit_cost: draft.value.unit_cost === '' ? null : draft.value.unit_cost,
      reserved: draft.value.reserved,
      notes: draft.value.notes || null,
    };
    if (source.value === 'stock') body.inventory_part_id = Number(draft.value.inventory_part_id);
    else body.description = draft.value.description;
    const created = await api.post(`/inventory/${props.instrumentId}/parts-used`, body);
    lines.value.push(created);
    // Shelf counts changed — refetch next time the picker opens.
    if (source.value === 'stock') stock.value = null;
    const keepSource = source.value;
    resetDraft();
    source.value = keepSource;
    if (keepSource === 'stock') await openAdd();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>
    <div v-if="loading" class="muted small">Loading…</div>

    <template v-else>
      <p v-if="!lines.length && !adding" class="muted small" style="margin: 0 0 10px">No parts recorded yet.</p>
      <div v-if="lines.length" class="table-wrap">
        <table class="used-table">
          <thead>
            <tr>
              <th>Part</th><th class="num">Qty</th><th class="num">Each</th><th class="right">Total</th>
              <th title="Set aside for this piece, not installed yet">Reserved</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in lines" :key="l.id" :class="{ reserved: l.reserved }">
              <td>
                <input
                  :value="l.description" class="cell-input" :aria-label="`Part ${l.id}`"
                  @change="patch(l, { description: $event.target.value })"
                />
                <div class="tiny-text muted">
                  <template v-if="l.inventory_part_id">From stock<template v-if="l.stock_taken"> · took {{ l.stock_taken }}</template> · </template>
                  {{ l.created_by_name || 'someone' }}, {{ new Date(l.created_at).toLocaleDateString() }}
                </div>
              </td>
              <td class="num">
                <input
                  :value="qtyText(l.quantity)" class="cell-input num" inputmode="decimal" aria-label="Quantity"
                  @change="patch(l, { quantity: $event.target.value })"
                />
              </td>
              <td class="num">
                <input
                  :value="l.unit_cost === null ? '' : Number(l.unit_cost)" class="cell-input num" inputmode="decimal"
                  placeholder="—" aria-label="Cost each"
                  @change="patch(l, { unit_cost: $event.target.value === '' ? null : $event.target.value })"
                />
              </td>
              <td class="right nowrap">{{ lineTotal(l) === null ? '—' : formatCents(lineTotal(l)) }}</td>
              <td class="center">
                <input
                  type="checkbox" class="box" :checked="l.reserved" aria-label="Reserved"
                  @change="patch(l, { reserved: $event.target.checked })"
                />
              </td>
              <td class="right">
                <button type="button" class="link small danger-link" title="Remove this part" @click="remove(l)">✕</button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" class="muted small">
                {{ lines.length }} line{{ lines.length === 1 ? '' : 's' }}<template v-if="totals.reserved"> · {{ totals.reserved }} reserved</template>
                <template v-if="totals.unpriced"> · {{ totals.unpriced }} without a cost</template>
              </td>
              <td class="right nowrap"><strong>{{ formatCents(totals.cost) }}</strong></td>
              <td colspan="2" />
            </tr>
          </tfoot>
        </table>
      </div>

      <form v-if="adding" class="add-form" @submit.prevent="add" @keydown.esc="adding = false">
        <div class="seg">
          <button type="button" class="small" :class="{ primary: source === 'typed' }" @click="source = 'typed'">Type it in</button>
          <button type="button" class="small" :class="{ primary: source === 'stock' }" @click="source = 'stock'">From Parts &amp; Accessories</button>
        </div>
        <div class="form-line">
          <div v-if="source === 'stock'" class="f wide">
            <label>Stock item *</label>
            <select v-model="draft.inventory_part_id" required @change="onPickStock">
              <option value="" disabled>{{ stock ? 'Pick a part…' : 'Loading…' }}</option>
              <optgroup v-for="g in stockGroups" :key="g.family" :label="refData.familyLabel(g.family)">
                <option v-for="p in g.rows" :key="p.id" :value="p.id">{{ stockLabel(p) }}</option>
              </optgroup>
            </select>
          </div>
          <div v-else class="f wide">
            <label>Part *</label>
            <input v-model="draft.description" required placeholder="Tine, hammer tips, grille cloth…" />
          </div>
          <div class="f narrow">
            <label>Qty</label>
            <input v-model="draft.quantity" inputmode="decimal" />
          </div>
          <div class="f narrow">
            <label>Cost each</label>
            <input v-model="draft.unit_cost" inputmode="decimal" placeholder="$" />
          </div>
          <div class="f">
            <label>Notes</label>
            <input v-model="draft.notes" />
          </div>
        </div>
        <div class="row" style="margin-top: 10px">
          <label class="checkbox small"><input v-model="draft.reserved" type="checkbox" /> Reserved (not installed yet)</label>
          <span class="spacer" />
          <button type="button" class="small" @click="adding = false">Done</button>
          <button type="submit" class="small primary" :disabled="busy">{{ busy ? 'Adding…' : 'Add part' }}</button>
        </div>
        <p v-if="source === 'stock'" class="muted tiny-text" style="margin: 6px 0 0">
          Takes it off the shelf count; removing the line puts it back.
          <template v-if="!auth.isAdmin">Enter the cost yourself — stock costs are admin-only.</template>
        </p>
      </form>
      <button v-else type="button" class="small" style="margin-top: 10px" @click="openAdd">+ Add part</button>
    </template>
  </div>
</template>

<style scoped>
.tiny-text { font-size: 11.5px; }
.used-table { font-size: 13px; }
.used-table th, .used-table td { padding: 5px 6px; vertical-align: top; }
.used-table .num { width: 76px; min-width: 76px; }
/* Keep the part name readable on a phone; the table scrolls sideways
   (.table-wrap) rather than squeezing it to a few letters. */
.used-table td:first-child { min-width: 190px; }
.used-table td.right { padding-top: 12px; }
.used-table .center { text-align: center; }
.used-table tfoot td { border-bottom: none; padding-top: 8px; }
.used-table tr.reserved > td { background: color-mix(in srgb, var(--violet) 9%, transparent); }
.cell-input { min-height: 32px; padding: 5px 8px; font-size: 13px; }
.cell-input.num { text-align: right; }
.box { width: 18px; height: 18px; min-height: 18px; margin-top: 6px; }
.danger-link { color: var(--red); padding: 6px 4px; }
.add-form {
  margin-top: 12px; padding: 12px;
  border: 1px dashed var(--border); border-radius: 8px;
}
.seg { display: inline-flex; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
.form-line { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.form-line > .f { flex: 1 1 150px; min-width: 0; }
.form-line > .f.wide { flex: 3 1 240px; }
.form-line > .f.narrow { flex: 1 1 80px; }
</style>
