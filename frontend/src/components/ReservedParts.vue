<script setup>
/**
 * Inventory -> Reserved parts: every part set aside for an instrument but
 * not installed yet (instrument_parts.reserved, migration 078), grouped by
 * instrument. Deliberately not part of Parts / Supplies — that page is
 * what to *buy*; this is what's already on hand and spoken for.
 *
 * "Installed" unticks reserved (the line stays on the instrument as a used
 * part). "Release" removes the line entirely — anything it took from Parts
 * & Accessories goes back on the shelf.
 */
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { formatCents, statusPill } from '../inventory';

const rows = ref([]);
const loading = ref(true);
const error = ref('');
const search = ref('');

async function load() {
  try {
    rows.value = await api.get('/inventory/reserved-parts');
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter((r) => [r.description, r.nickname, r.instrument_model, r.stock_number, r.notes, r.stock_name]
    .some((v) => v && String(v).toLowerCase().includes(q)));
});

const groups = computed(() => {
  const out = [];
  for (const r of filtered.value) {
    let g = out.find((x) => x.id === r.instrument_id);
    if (!g) {
      g = {
        id: r.instrument_id,
        name: r.nickname || r.instrument_model || 'Unnamed',
        model: r.nickname ? r.instrument_model : '',
        stock_number: r.stock_number,
        pill: statusPill(r),
        rows: [],
      };
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
});

const lineTotal = (r) => (r.unit_cost === null ? null : Number(r.unit_cost) * Number(r.quantity));
const totalValue = computed(() => filtered.value.reduce((sum, r) => sum + (lineTotal(r) || 0), 0));

async function installed(r) {
  error.value = '';
  try {
    await api.patch(`/inventory/parts-used/${r.id}`, { reserved: false });
    rows.value = rows.value.filter((x) => x.id !== r.id);
  } catch (err) {
    error.value = err.message;
  }
}

async function release(r) {
  const back = r.stock_taken > 0 ? ` ${r.stock_taken} will go back on the Parts & Accessories shelf.` : '';
  if (!confirm(`Release "${r.description}" from this instrument?${back}`)) return;
  error.value = '';
  try {
    await api.del(`/inventory/parts-used/${r.id}`);
    rows.value = rows.value.filter((x) => x.id !== r.id);
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="row" style="margin-bottom: 12px">
      <input v-model="search" type="search" placeholder="Search parts or instruments…" style="max-width: 300px; min-height: 34px; padding: 6px 10px" />
      <span v-if="!loading" class="muted small">
        {{ filtered.length }} part{{ filtered.length === 1 ? '' : 's' }} reserved across
        {{ groups.length }} instrument{{ groups.length === 1 ? '' : 's' }}
        <template v-if="totalValue"> · {{ formatCents(totalValue) }}</template>
      </span>
    </div>
    <p class="muted small" style="margin-top: 0">
      Parts set aside for a piece but not installed yet. Add them from an instrument's Parts &amp; labor card.
    </p>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>
    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!filtered.length" class="empty">Nothing reserved.</div>

    <div v-else class="table-wrap">
      <table class="reserved-table">
        <thead>
          <tr>
            <th>Part</th><th class="right">Qty</th><th class="right">Each</th><th class="right">Total</th>
            <th>Reserved</th><th>Notes</th><th />
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.id">
          <tr class="group-row">
            <td colspan="99">
              <RouterLink :to="{ name: 'instrument', params: { id: g.id } }"><strong>{{ g.name }}</strong></RouterLink>
              <span class="muted small"> · {{ g.stock_number }}<template v-if="g.model"> · {{ g.model }}</template></span>
              <span :class="['pill', g.pill.color]" style="margin-left: 8px">{{ g.pill.label }}</span>
            </td>
          </tr>
          <tr v-for="r in g.rows" :key="r.id">
            <td>
              {{ r.description }}
              <span v-if="r.inventory_part_id" class="pill slate tiny" title="Taken from Parts & Accessories">stock</span>
            </td>
            <td class="right">{{ Number(r.quantity) }}</td>
            <td class="right nowrap">{{ r.unit_cost === null ? '—' : formatCents(r.unit_cost) }}</td>
            <td class="right nowrap">{{ lineTotal(r) === null ? '—' : formatCents(lineTotal(r)) }}</td>
            <td class="small nowrap">
              {{ r.reserved_at ? new Date(r.reserved_at).toLocaleDateString() : '' }}
              <span v-if="r.created_by_name" class="muted"> · {{ r.created_by_name }}</span>
            </td>
            <td class="small muted">{{ r.notes }}</td>
            <td class="right nowrap">
              <button type="button" class="small" title="It's in — keep it on the piece as a used part" @click="installed(r)">Installed</button>
              <button type="button" class="small" style="margin-left: 6px" @click="release(r)">Release</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.reserved-table { font-size: 13px; }
.reserved-table th, .reserved-table td { padding: 6px 8px; }
.reserved-table .group-row td { background: var(--surface-2); padding-top: 8px; padding-bottom: 8px; }
.pill.tiny { font-size: 10px; padding: 0 6px; margin-left: 4px; }
</style>
