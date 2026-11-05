<script setup>
/**
 * Inventory — everything the shop holds, in one place (migration 072).
 *
 * The old Fleet page is this page filtered to "Not for sale"; the old
 * Inventory Restorations queue is the third tab. Layout follows the CEPCo
 * Inventory Log sheets the bosses already use: grouped by family and sheet
 * section, condition grades in columns, price / serial / web at a glance.
 * Editing happens on the detail page (InventoryDetailView.vue) — this page
 * is for scanning.
 *
 * Tab, family, status and search all live in the URL so a link (or the
 * back button) lands on the same view. Family and search filter
 * client-side; status re-fetches, since "Sold" is a few hundred rows of
 * history nobody needs loaded by default.
 */
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import api from '../api';
import {
  useAuth, useRefData, useSettings, canonicalFamily,
} from '../stores';
import TicketTable from '../components/TicketTable.vue';
import InventoryParts from '../components/InventoryParts.vue';
import ReservedParts from '../components/ReservedParts.vue';
import {
  formatPrice, statusPill, gradeClass, ownershipLabel,
} from '../inventory';

const route = useRoute();
const router = useRouter();
const auth = useAuth();
const settings = useSettings();
const refData = useRefData();

const TABS = [
  { key: 'instruments', label: 'Instruments' },
  { key: 'parts', label: 'Parts & Accessories' },
  // Parts set aside for a piece, not installed yet (migration 078).
  { key: 'reserved', label: 'Reserved parts' },
  { key: 'restorations', label: 'Restoration queue' },
];
const STATUS_OPTIONS = [
  { key: 'active', label: 'In stock' },
  { key: 'for_sale', label: 'For sale' },
  { key: 'not_for_sale', label: 'Not for sale' },
  { key: 'sold', label: 'Sold' },
  // Every consignment, sold or not, grouped by where the deal stands —
  // "Payout due" first, since that's money the shop owes (migration 075).
  { key: 'consignments', label: 'Consignments' },
  // Everything, sold included — mostly for the inventory audit, which
  // covers sold pieces too (Settings -> Inventory audit links here).
  { key: 'all', label: 'All' },
];

const tab = computed(() => (TABS.some((t) => t.key === route.query.tab) ? route.query.tab : 'instruments'));
const status = computed(() => (STATUS_OPTIONS.some((s) => s.key === route.query.status) ? route.query.status : 'active'));
// canonicalFamily: an old ?family=organ / other link opens Kombo+ (migration 083).
const family = computed(() => canonicalFamily(String(route.query.family || '')));
const search = ref(String(route.query.q || ''));
// Inventory audit (migration 077): checkboxes and the unaudited highlight
// only exist while the audit is running (Settings -> Inventory audit).
const auditOn = computed(() => settings.inventoryAuditActive);
const auditTodoOnly = computed(() => auditOn.value && route.query.audit === 'todo');

function setQuery(patch) {
  const query = { ...route.query, ...patch };
  for (const k of Object.keys(query)) if (query[k] === '' || query[k] === undefined) delete query[k];
  router.replace({ path: '/inventory', query });
}

const meta = ref(null);
const items = ref([]);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = await api.get('/inventory', { status: status.value });
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

// --- filtering ------------------------------------------------------------
const needle = computed(() => search.value.trim().toLowerCase());
// "O-0123" / "x123" / "K-0123": stock numbers are a family letter plus the
// row id, and Kombo+ pieces were O- or X- before migration 083 -- so a
// stock-number-shaped search also matches on the id alone, whatever letter
// was on the old tag.
const stockSearchId = computed(() => {
  const m = /^[a-z]-?0*(\d+)$/.exec(needle.value);
  return m ? Number(m[1]) : null;
});
const matchesSearch = (i) => {
  if (!needle.value) return true;
  if (stockSearchId.value !== null && i.id === stockSearchId.value) return true;
  return [i.nickname, i.model, i.serial_no, i.identifying_notes, i.stock_number, i.consignor_name,
    i.customer_name, i.sold_to_name, i.model_group, i.year]
    .some((v) => v && String(v).toLowerCase().includes(needle.value));
};
const searched = computed(() => items.value.filter(
  (i) => matchesSearch(i) && (!auditTodoOnly.value || !i.audited_at),
));
// Progress for the current status/family/search, ignoring the
// "not audited only" toggle itself (or it would always read 0 of N).
const auditProgress = computed(() => {
  const pool = items.value.filter((i) => matchesSearch(i) && (!family.value || i.family === family.value));
  return { total: pool.length, done: pool.filter((i) => i.audited_at).length };
});

async function toggleAudit(i, audited) {
  const before = { audited_at: i.audited_at, audited_by_name: i.audited_by_name };
  // Optimistic: auditing is a long run of clicks down the list.
  i.audited_at = audited ? new Date().toISOString() : null;
  i.audited_by_name = audited ? auth.user?.name : null;
  try {
    const row = await api.put(`/inventory/${i.id}/audit`, { audited });
    i.audited_at = row.audited_at;
    i.audited_by_name = row.audited_by_name;
  } catch (err) {
    Object.assign(i, before);
    error.value = err.message;
  }
}
const auditTitle = (i) => (i.audited_at
  ? `Audited${i.audited_by_name ? ` by ${i.audited_by_name}` : ''} ${new Date(i.audited_at).toLocaleDateString()}`
  : 'Not audited yet — tick once checked');
const filtered = computed(() => (family.value
  ? searched.value.filter((i) => i.family === family.value)
  : searched.value));

const familyCounts = computed(() => {
  const counts = {};
  for (const i of searched.value) counts[i.family] = (counts[i.family] || 0) + 1;
  return counts;
});
const familiesShown = computed(() => (meta.value?.families || []).filter((f) => familyCounts.value[f]));

let searchTimer;
watch(search, (v) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setQuery({ q: v.trim() }), 300);
});

// --- columns --------------------------------------------------------------
// One family selected: its own condition columns, like that sheet tab.
// All families: a compact "grades" summary instead, since the columns
// differ per family.
const conditionFields = computed(() => (family.value && meta.value
  ? meta.value.condition_fields[family.value] || [] : []));

function conditionSummary(i) {
  const fields = meta.value?.condition_fields[i.family] || [];
  return fields
    .filter((f) => i.condition?.[f.key])
    .map((f) => ({ label: f.label.split('/')[0], value: i.condition[f.key] }));
}

const isSold = computed(() => status.value === 'sold');
const isConsign = computed(() => status.value === 'consignments');
const consignLabel = (cs) => (cs ? meta.value?.consignment_status_labels[cs] || cs : 'Not recorded');
const consignorOf = (i) => i.customer_name || i.consignor_name || '';

// --- grouping: family -> sheet section, in the order the API returns ----
const groups = computed(() => {
  const out = [];
  let current = null;
  for (const i of filtered.value) {
    let key;
    let label;
    if (isConsign.value) {
      key = `c|${i.consignment_status || ''}`;
      label = consignLabel(i.consignment_status);
    } else if (isSold.value) {
      key = i.family;
      label = refData.familyLabel(i.family);
    } else {
      key = `${i.family}|${i.model_group || ''}`;
      label = i.model_group || `Other ${refData.familyLabel(i.family)}`;
    }
    if (!current || current.key !== key) {
      current = {
        key,
        family: i.family,
        label,
        rows: [],
      };
      out.push(current);
    }
    current.rows.push(i);
  }
  return out;
});

const totals = computed(() => {
  const forSale = filtered.value.filter((i) => ['available', 'on_hold'].includes(i.sale_status));
  return {
    count: filtered.value.length,
    forSale: forSale.length,
    payoutDue: filtered.value.filter((i) => i.ownership === 'consignment' && i.consignment_status === 'payout_due').length,
    askingTotal: forSale.reduce((sum, i) => sum + (Number(i.asking_price) || 0), 0),
  };
});

function open(i) {
  router.push({ name: 'inventory-item', params: { id: i.id } });
}

// --- add a piece ----------------------------------------------------------
const adding = ref(false);
const addBusy = ref(false);
const addError = ref('');
const blankNew = () => ({
  family: family.value || 'rhodes', nickname: '', model: '', year: '', serial_no: '',
  ownership: 'shop', sale_status: 'available', asking_price: '',
});
const newPiece = ref(blankNew());
function startAdd() {
  newPiece.value = blankNew();
  addError.value = '';
  adding.value = !adding.value;
}
async function submitAdd() {
  addBusy.value = true;
  addError.value = '';
  try {
    const created = await api.post('/inventory', newPiece.value);
    router.push({ name: 'inventory-item', params: { id: created.id } });
  } catch (err) {
    addError.value = err.message;
  } finally {
    addBusy.value = false;
  }
}

// --- CSV of the current view (what the bosses would otherwise copy out
// of the sheet) ------------------------------------------------------------
function downloadCsv() {
  const condKeys = family.value
    ? conditionFields.value
    : [...new Map(Object.values(meta.value?.condition_fields || {}).flat().map((f) => [f.key, f])).values()];
  const header = ['Stock #', 'Name', 'Family', 'Section', 'Year', 'Model', ...condKeys.map((f) => f.label),
    'Notes', 'Status', 'Reason / hold', 'Price', 'Price note', 'Serial', 'On website', 'Ownership', 'Consignor',
    'Consignment status', 'Consignment terms',
    ...(isSold.value ? ['Sold price', 'Sold to', 'Sold on'] : []),
    ...(auth.isAdmin ? ['Paid', 'Paid note'] : [])];
  const rows = filtered.value.map((i) => [
    i.stock_number, i.nickname, refData.familyLabel(i.family), i.model_group, i.year, i.model,
    ...condKeys.map((f) => i.condition?.[f.key] || ''),
    i.identifying_notes, meta.value?.sale_status_labels[i.sale_status], i.nfs_reason || i.hold_for,
    i.asking_price, i.price_note, i.serial_no, i.on_website ? 'yes' : '', ownershipLabel(i.ownership),
    i.customer_name || i.consignor_name,
    i.ownership === 'consignment' ? consignLabel(i.consignment_status) : '', i.consignment_terms,
    ...(isSold.value ? [i.sold_price, i.sold_to_name, i.sold_at] : []),
    ...(auth.isAdmin ? [i.cost_paid, i.cost_note] : []),
  ]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `inventory-${family.value || 'all'}-${status.value}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- restoration queue tab (was InventoryRestorationsView.vue) -----------
const restorationTickets = ref([]);
const restorationsLoading = ref(false);
async function loadRestorations() {
  restorationsLoading.value = true;
  try {
    // A single category makes GET /tickets return that category's
    // admin-reorderable queue order (category_queue_position).
    restorationTickets.value = await api.get('/tickets', { category: 'inventory_restoration' });
  } finally {
    restorationsLoading.value = false;
  }
}

watch(status, () => { if (tab.value === 'instruments') load(); });
watch(tab, (t) => {
  if (t === 'instruments' && !items.value.length) load();
  if (t === 'restorations') loadRestorations();
});

onMounted(async () => {
  refData.load();
  meta.value = await api.get('/inventory/meta');
  if (tab.value === 'instruments') load();
  if (tab.value === 'restorations') loadRestorations();
});
</script>

<template>
  <!-- Wider than the default page: this is a spreadsheet-style table. -->
  <div class="page" style="max-width: 1760px">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Inventory</h1>
        <p class="muted small" style="margin: 0">
          Shop stock, floor &amp; rental pieces, and consignments.
        </p>
      </div>
      <div class="row nowrap">
        <RouterLink :to="{ name: 'fleet-calendar' }" class="btn small">Rental calendar</RouterLink>
        <RouterLink :to="{ name: 'inventory-purchase-new' }" class="btn small">+ Record a purchase</RouterLink>
        <button class="small primary" type="button" @click="startAdd">
          {{ adding ? 'Cancel' : '+ Add piece' }}
        </button>
      </div>
    </div>

    <form v-if="adding" class="card" style="margin-bottom: 16px" @submit.prevent="submitAdd">
      <p class="muted small" style="margin-top: 0">
        For something bought from a person, use <RouterLink :to="{ name: 'inventory-purchase-new' }">Record a
        purchase</RouterLink> instead — it also logs the seller and opens a restoration ticket.
      </p>
      <div class="field-row">
        <div class="field">
          <label>Family *</label>
          <select v-model="newPiece.family" required>
            <option v-for="f in meta?.families || []" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
          </select>
        </div>
        <div class="field"><label>Name</label><input v-model="newPiece.nickname" placeholder="Blitzen" /></div>
        <div class="field"><label>Model</label><input v-model="newPiece.model" placeholder="Suitcase 73" /></div>
        <div class="field"><label>Year</label><input v-model="newPiece.year" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Serial</label><input v-model="newPiece.serial_no" /></div>
        <div class="field">
          <label>Ownership</label>
          <select v-model="newPiece.ownership">
            <option value="shop">Shop-owned</option>
            <option value="consignment">Consignment</option>
          </select>
        </div>
        <div class="field">
          <label>Status</label>
          <select v-model="newPiece.sale_status">
            <option v-for="s in meta?.sale_statuses.filter((x) => x !== 'sold') || []" :key="s" :value="s">
              {{ meta.sale_status_labels[s] }}
            </option>
          </select>
        </div>
        <div class="field"><label>Asking price</label><input v-model="newPiece.asking_price" inputmode="decimal" /></div>
      </div>
      <div v-if="addError" class="alert" style="margin-bottom: 12px">{{ addError }}</div>
      <button class="primary" type="submit" :disabled="addBusy">{{ addBusy ? 'Adding…' : 'Add and open' }}</button>
    </form>

    <div class="folder-tabs">
      <button
        v-for="t in TABS" :key="t.key" type="button"
        class="folder-tab" :class="{ active: tab === t.key }"
        @click="setQuery({ tab: t.key === 'instruments' ? '' : t.key })"
      >{{ t.label }}</button>
    </div>

    <div class="folder-tab-panel">
      <!-- Instruments ---------------------------------------------------- -->
      <template v-if="tab === 'instruments'">
        <div class="row inv-filters">
          <div class="segmented">
            <button
              v-for="s in STATUS_OPTIONS" :key="s.key" type="button" class="small"
              :class="{ active: status === s.key }" @click="setQuery({ status: s.key === 'active' ? '' : s.key })"
            >{{ s.label }}</button>
          </div>
          <input v-model="search" type="search" placeholder="Search name, model, serial, notes…" class="inv-search" />
          <template v-if="auditOn">
            <span class="small audit-progress" :class="{ done: auditProgress.done === auditProgress.total }">
              Audit: {{ auditProgress.done }} / {{ auditProgress.total }}
            </span>
            <button
              type="button" class="small" :class="{ primary: auditTodoOnly }"
              @click="setQuery({ audit: auditTodoOnly ? '' : 'todo' })"
            >Not audited only</button>
          </template>
          <span class="spacer" />
          <button type="button" class="small" :disabled="!filtered.length" @click="downloadCsv">Download CSV</button>
        </div>

        <div class="row inv-families">
          <button
            type="button" class="chip" :class="{ active: !family }" @click="setQuery({ family: '' })"
          >All <span class="muted">{{ searched.length }}</span></button>
          <button
            v-for="f in familiesShown" :key="f" type="button" class="chip" :class="{ active: family === f }"
            @click="setQuery({ family: f })"
          >{{ refData.familyLabel(f) }} <span class="muted">{{ familyCounts[f] }}</span></button>
        </div>

        <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>
        <div v-if="loading" class="empty">Loading…</div>
        <div v-else-if="!filtered.length" class="empty">Nothing matches.</div>

        <template v-else>
          <p class="muted small" style="margin: 0 0 8px">
            {{ totals.count }} piece{{ totals.count === 1 ? '' : 's' }}
            <template v-if="!isSold && totals.forSale">
              · {{ totals.forSale }} for sale, {{ formatPrice(totals.askingTotal) }} asking
            </template>
            <template v-if="isConsign && totals.payoutDue">
              · <strong>{{ totals.payoutDue }} payout{{ totals.payoutDue === 1 ? '' : 's' }} due</strong>
            </template>
          </p>
          <div class="table-wrap">
            <table class="inv-table">
              <thead>
                <!-- Order: what you scan for first (price, status) right after
                     the name; the sheet's condition columns next; free-text
                     notes last, where they can run long without pushing
                     anything important off-screen. -->
                <tr>
                  <th v-if="auditOn" class="audit-col" title="Audited">✓</th>
                  <th class="thumb-col" />
                  <th>Name</th>
                  <th>Year</th>
                  <th>Model</th>
                  <template v-if="isSold">
                    <th class="right">Sold for</th>
                    <th>Sold to</th>
                    <th>Date</th>
                    <th>Serial</th>
                  </template>
                  <template v-else-if="isConsign">
                    <th>Consignor</th>
                    <th>Terms</th>
                    <th class="right">Price</th>
                    <th>Status</th>
                    <th>Sold to</th>
                    <th>Date</th>
                  </template>
                  <template v-else>
                    <th class="right">Price</th>
                    <th>Status</th>
                    <th v-for="f in conditionFields" :key="f.key">{{ f.label }}</th>
                    <th v-if="!family">Condition</th>
                    <th>Serial</th>
                    <th title="Listed on the website">Web</th>
                  </template>
                  <th v-if="auth.isAdmin" class="right">Paid</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody v-for="g in groups" :key="g.key">
                <tr class="group-row">
                  <td :colspan="99">
                    <strong>{{ g.label }}</strong>
                    <span v-if="!family && !isSold && !isConsign" class="muted small"> · {{ refData.familyLabel(g.family) }}</span>
                    <span class="muted small"> · {{ g.rows.length }}</span>
                  </td>
                </tr>
                <tr
                  v-for="i in g.rows" :key="i.id" class="clickable"
                  :class="{ unaudited: auditOn && !i.audited_at }" @click="open(i)"
                >
                  <td v-if="auditOn" class="audit-col" :title="auditTitle(i)" @click.stop>
                    <input
                      type="checkbox" :checked="!!i.audited_at" :aria-label="`Audited: ${i.nickname || i.model}`"
                      @change="toggleAudit(i, $event.target.checked)"
                    />
                  </td>
                  <td class="thumb-col">
                    <img
                      v-if="i.cover_photo_id" :src="`/api/inventory/photos/${i.cover_photo_id}/view`"
                      alt="" loading="lazy" class="thumb"
                    />
                  </td>
                  <td class="name-col">
                    <RouterLink :to="{ name: 'inventory-item', params: { id: i.id } }" @click.stop>
                      {{ i.nickname || i.model || 'Unnamed' }}
                    </RouterLink>
                    <span
                      v-if="i.ownership === 'consignment'" class="pill violet tiny"
                      :title="`Consignment${i.customer_name || i.consignor_name ? ` — ${i.customer_name || i.consignor_name}` : ''}`"
                    >C</span>
                    <div class="muted tiny-text">{{ i.stock_number }}</div>
                  </td>
                  <td class="nowrap">{{ i.year }}</td>
                  <td class="model-col">{{ i.model }}</td>
                  <template v-if="isSold">
                    <td class="right nowrap">{{ formatPrice(i.sold_price) }}</td>
                    <td>{{ i.sold_to_name }}</td>
                    <td class="nowrap small">{{ i.sold_at }}</td>
                    <td class="nowrap small">{{ i.serial_no }}</td>
                  </template>
                  <template v-else-if="isConsign">
                    <td>
                      {{ consignorOf(i) }}
                      <span
                        v-if="i.consignor_name && !i.customer_id" class="muted tiny-text"
                        title="Not linked to a customer record yet"
                      > (unlinked)</span>
                    </td>
                    <td class="small">
                      {{ i.consignment_terms || (i.consignment_rate !== null && i.consignment_rate !== undefined ? `${Number(i.consignment_rate)}%` : '') }}
                    </td>
                    <td class="right nowrap">
                      {{ formatPrice(i.sale_status === 'sold' ? i.sold_price : i.asking_price) }}
                    </td>
                    <td class="status-col">
                      <span :class="['pill', statusPill(i).color]" :title="statusPill(i).title">
                        {{ i.sale_status === 'not_for_sale' ? 'NFS' : statusPill(i).label }}
                      </span>
                    </td>
                    <td>{{ i.sold_to_name }}</td>
                    <td class="nowrap small">{{ i.sold_at }}</td>
                  </template>
                  <template v-else>
                    <td class="right nowrap">
                      <span v-if="i.asking_price !== null">{{ formatPrice(i.asking_price) }}</span>
                      <span v-if="i.price_note" class="muted price-note" :title="i.price_note">
                        {{ i.asking_price !== null ? '*' : i.price_note }}
                      </span>
                    </td>
                    <td class="status-col">
                      <span :class="['pill', statusPill(i).color]" :title="statusPill(i).title">
                        {{ i.sale_status === 'not_for_sale' ? 'NFS' : statusPill(i).label }}
                      </span>
                      <div v-if="i.nfs_reason || i.hold_for" class="muted tiny-text reason">{{ i.nfs_reason || i.hold_for }}</div>
                    </td>
                    <td
                      v-for="f in conditionFields" :key="f.key"
                      :class="['cond-cell', gradeClass(i.condition?.[f.key])]"
                    >{{ i.condition?.[f.key] }}</td>
                    <td v-if="!family" class="small cond-col">
                      <span v-for="c in conditionSummary(i).slice(0, 4)" :key="c.label" class="grade-chip">
                        <span class="muted">{{ c.label }}</span> <span :class="gradeClass(c.value)">{{ c.value }}</span>
                      </span>
                    </td>
                    <td class="nowrap small">{{ i.serial_no }}</td>
                    <td>{{ i.on_website ? '✓' : '' }}</td>
                  </template>
                  <td v-if="auth.isAdmin" class="right nowrap small" :title="i.cost_note">
                    {{ i.cost_paid !== null && i.cost_paid !== undefined ? formatPrice(i.cost_paid) : (i.cost_note || '') }}
                  </td>
                  <td class="notes-col small" :title="i.identifying_notes">{{ i.identifying_notes }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>

      <!-- Parts & accessories ------------------------------------------- -->
      <InventoryParts v-else-if="tab === 'parts'" :families="meta?.families || []" />

      <!-- Reserved parts -------------------------------------------------- -->
      <ReservedParts v-else-if="tab === 'reserved'" />

      <!-- Restoration queue ---------------------------------------------- -->
      <template v-else>
        <p class="muted small" style="margin-top: 0">
          Restoration tickets for inventory pieces — admins can reorder with ↑/↓.
        </p>
        <div v-if="restorationsLoading" class="empty">Loading…</div>
        <TicketTable
          v-else :tickets="restorationTickets" queue="category"
          empty-text="Nothing in the restoration queue." @reordered="loadRestorations"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.inv-filters { margin-bottom: 10px; }
.inv-search { max-width: 320px; min-height: 34px; padding: 6px 10px; font-size: 14px; }
.inv-families { margin-bottom: 12px; gap: 6px; }
.segmented { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.segmented button { border: none; border-radius: 0; background: transparent; color: var(--text-dim); }
.segmented button + button { border-left: 1px solid var(--border); }
.segmented button.active { background: var(--surface-2); color: var(--text); font-weight: 600; }
.chip {
  min-height: 30px; padding: 4px 12px; border-radius: 999px; font-size: 13px;
  background: transparent; color: var(--text-dim);
}
.chip.active { border-color: var(--accent); color: var(--text); background: rgba(212, 129, 63, 0.12); }
.inv-table { font-size: 13px; }
.inv-table th, .inv-table td { padding: 6px 8px; }
.inv-table .group-row td {
  background: var(--surface-2); border-bottom: 1px solid var(--border);
  padding-top: 8px; padding-bottom: 8px;
}
.inv-table .group-row:hover { background: inherit; }
.thumb-col { width: 48px; padding-right: 0 !important; }

/* Inventory audit: anything not yet checked gets an amber edge and a faint
   wash, so the unaudited rows stand out down a long list. */
.audit-col { width: 34px; text-align: center; }
.audit-col input { width: 18px; height: 18px; min-height: 18px; margin: 0; cursor: pointer; vertical-align: middle; }
.inv-table tr.unaudited > td { background: color-mix(in srgb, var(--amber) 7%, transparent); }
.inv-table tr.unaudited > td:first-child { box-shadow: inset 3px 0 0 var(--amber); }
.audit-progress { color: var(--amber); font-weight: 600; }
.audit-progress.done { color: var(--green); }
.thumb { width: 44px; height: 33px; object-fit: cover; border-radius: 4px; display: block; }
.name-col { white-space: nowrap; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.status-col { white-space: nowrap; }
.status-col .reason { max-width: 120px; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.name-col a { font-weight: 600; color: var(--text); }
.tiny-text { font-size: 11px; }
.pill.tiny { padding: 0 5px; font-size: 10px; margin-left: 4px; vertical-align: middle; }
.notes-col { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
.price-note { margin-left: 3px; cursor: help; }
.cond-col { min-width: 200px; max-width: 300px; }
.cond-cell { max-width: 110px; }
.model-col { max-width: 150px; }
.grade-chip { margin-right: 8px; white-space: nowrap; display: inline-block; }
</style>
