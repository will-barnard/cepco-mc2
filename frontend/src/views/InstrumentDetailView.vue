<script setup>
/**
 * One instrument -- the same page for every instrument, whoever owns it
 * (NOTES.md §2.107; it was the inventory piece page).
 *
 * Always: details (model, Mark, serial...), photos (sets, plus the photos
 * on its tickets), tickets, ownership history, change log.
 * Shop stock / consignments add the inventory side: condition, cost, parts
 * & labor, sale, ownership terms, QC, rentals -- and "Mark sold", which
 * makes the piece its buyer's instrument.
 * A customer's instrument adds its owner, and "Add to inventory" for when
 * the shop buys it or takes it on consignment.
 *
 * Editing is one form with a sticky Save bar that appears once something
 * changes, and only the changed fields are sent (PATCH /inventory/:id for
 * shop pieces, PATCH /instruments/:id for a customer's). Photos and the
 * ownership actions save on their own.
 */
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import api from '../api';
import { useAuth, useRefData, useSettings } from '../stores';
import CustomerSearchSelect from '../components/CustomerSearchSelect.vue';
import InstrumentPhotoSets from '../components/InstrumentPhotoSets.vue';
import InstrumentPartsUsed from '../components/InstrumentPartsUsed.vue';
import InstrumentModelPicker from '../components/InstrumentModelPicker.vue';
import AttributeFields from '../components/AttributeFields.vue';
import { attrsSummary, overridesPatch, keepForFamily } from '../instrumentAttrs';
import OwnershipHistory from '../components/OwnershipHistory.vue';
import InstrumentAcquire from '../components/InstrumentAcquire.vue';
import InstrumentSell from '../components/InstrumentSell.vue';
import { xeroContactUrl } from '../xeroLinks';
import {
  formatPrice, statusPill, gradeClass, ownershipLabel, nextQcDue,
} from '../inventory';

const props = defineProps({ id: { type: [String, Number], required: true } });

const router = useRouter();
const auth = useAuth();
const refData = useRefData();
const settings = useSettings();

const meta = ref(null);
const item = ref(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const savedAt = ref(null);
const xeroUrl = ref(null);

// Everything the form edits. Money fields are strings in the form so a
// half-typed "7,7" doesn't fight the input.
const EDITABLE = [
  'nickname', 'family', 'model_id', 'model', 'year', 'serial_no', 'model_group', 'identifying_notes', 'photo_album_url',
  'ownership', 'sale_status', 'nfs_reason', 'hold_for', 'asking_price', 'price_note', 'on_website',
  'customer_id', 'consignor_name', 'consignment_rate', 'consignment_status', 'consignment_terms',
  'qc_notes', 'last_qc_at', 'qc_interval_months',
  'cost_paid', 'cost_note', 'est_hours',
];
// A customer's instrument edits only its details (PATCH /instruments/:id);
// everything else on the form is the inventory side.
const CUSTOMER_EDITABLE = ['nickname', 'family', 'model_id', 'model', 'year', 'serial_no', 'identifying_notes'];
const form = ref({});
// Condition (migration 084): a grade key per field from the dropdown, and a
// free-text note per field beside it ("OG Cube", "light scratches").
const conditionForm = ref({});
const conditionNotesForm = ref({});
// Attributes (Mark, suitcase amp...; migration 089): the piece's overrides,
// '' / missing = as its model says. Saved with the Save bar, for any piece.
const attrsForm = ref({});
// The picked model's facts -- from the row on load, then from the picker as
// the model changes, so the attribute dropdowns can say what the model
// implies ("Janus (from model)") before anything is saved.
const pickedFacts = ref(null);

const norm = (v) => (v === null || v === undefined ? '' : String(v));
const moneyNorm = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

function fillForm(row) {
  const f = {};
  for (const k of EDITABLE) {
    if (k === 'model_id') f[k] = row.model_id ?? null;
    else if (k === 'on_website') f[k] = !!row[k];
    else if (['asking_price', 'cost_paid', 'consignment_rate', 'est_hours'].includes(k)) f[k] = moneyNorm(row[k]);
    else if (k === 'last_qc_at') f[k] = row[k] ? String(row[k]).slice(0, 10) : '';
    else f[k] = norm(row[k]);
  }
  form.value = f;
  conditionForm.value = { ...(row.condition || {}) };
  conditionNotesForm.value = { ...(row.condition_notes || {}) };
  attrsForm.value = { ...(row.attr_overrides || {}) };
  pickedFacts.value = row.model_id ? { attrs: row.catalog_attrs || {}, is_suitcase: !!row.model_is_suitcase, is_console: !!row.model_is_console } : null;
}

const original = computed(() => {
  if (!item.value) return {};
  const f = {};
  for (const k of EDITABLE) {
    const row = item.value;
    if (k === 'on_website') f[k] = !!row[k];
    else if (['asking_price', 'cost_paid', 'consignment_rate', 'est_hours'].includes(k)) f[k] = moneyNorm(row[k]);
    else if (k === 'last_qc_at') f[k] = row[k] ? String(row[k]).slice(0, 10) : '';
    else f[k] = norm(row[k]);
  }
  return f;
});

const isInventory = computed(() => !!item.value && item.value.ownership !== 'customer');
// An owner with no customer record (a buyer known by name): the current
// ownership period keeps the name.
const ownerName = computed(() => (item.value?.ownership_history || []).find((h) => !h.end_reason)?.owner_name || '');

const changes = computed(() => {
  const out = {};
  for (const k of EDITABLE) {
    if (!isInventory.value && !CUSTOMER_EDITABLE.includes(k)) continue;
    if (!auth.isAdmin && (k === 'cost_paid' || k === 'cost_note')) continue;
    const now = form.value[k];
    const was = original.value[k];
    let differs;
    if (k === 'on_website') differs = !!now !== was;
    else if (['asking_price', 'cost_paid', 'consignment_rate', 'est_hours'].includes(k)) {
      differs = moneyNorm(String(now).replace(/[$,%]/g, '') || null) !== was;
    } else {
      // CustomerSearchSelect hands back numbers, the form holds strings.
      differs = norm(now) !== was;
    }
    if (differs) out[k] = now === '' ? null : now;
  }
  // Both condition maps are sent whole when they change -- the API stores
  // each as one JSONB object. Blanks are dropped so "picked, then cleared"
  // doesn't count as a change.
  const attrsPatch = overridesPatch(item.value?.attr_overrides, attrsForm.value);
  if (attrsPatch) out.attrs = attrsPatch;
  if (!isInventory.value) return out;
  const filled = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => String(v || '').trim()));
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const condNow = filled(conditionForm.value);
  if (!same(condNow, filled(item.value?.condition))) out.condition = condNow;
  const notesNow = Object.fromEntries(Object.entries(filled(conditionNotesForm.value)).map(([k, v]) => [k, String(v).trim()]));
  if (!same(notesNow, filled(item.value?.condition_notes))) out.condition_notes = notesNow;
  return out;
});
const dirty = computed(() => Object.keys(changes.value).length > 0);

async function load() {
  error.value = '';
  try {
    const row = await api.get(`/inventory/${props.id}`);
    item.value = row;
    fillForm(row);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** Refresh after photos change, without discarding unsaved form edits. */
async function reloadKeepingEdits() {
  const row = await api.get(`/inventory/${props.id}`);
  item.value = row;
}

// Inventory audit (migration 077) — its own request rather than part of the
// Save bar, so ticking it never drags unsaved form edits along with it.
const auditBusy = ref(false);
async function setAudited(audited) {
  auditBusy.value = true;
  error.value = '';
  try {
    await api.put(`/inventory/${props.id}/audit`, { audited });
    await reloadKeepingEdits();
  } catch (err) {
    error.value = err.message;
  } finally {
    auditBusy.value = false;
  }
}

async function save() {
  if (!dirty.value) return;
  saving.value = true;
  error.value = '';
  try {
    let updated;
    if (isInventory.value) {
      updated = await api.patch(`/inventory/${props.id}`, changes.value);
    } else {
      // That endpoint reads a null note as "leave it" -- send '' to clear it.
      const body = { ...changes.value };
      if ('identifying_notes' in body && body.identifying_notes === null) body.identifying_notes = '';
      updated = await api.patch(`/instruments/${props.id}`, body);
    }
    await reloadKeepingEdits();
    fillForm({ ...item.value, ...updated });
    savedAt.value = new Date();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

function discard() {
  fillForm(item.value);
}

async function setCover(photoId) {
  try {
    await api.patch(`/${isInventory.value ? 'inventory' : 'instruments'}/${props.id}`, { cover_photo_id: photoId });
    await reloadKeepingEdits();
  } catch (err) {
    error.value = err.message;
  }
}

// --- derived display --------------------------------------------------------
// A family change drops attributes it doesn't have (the API would refuse them).
watch(() => form.value.family, (fam) => {
  attrsForm.value = keepForFamily(refData.attributes, fam, attrsForm.value);
});
const conditionFields = computed(() => {
  const listed = meta.value?.condition_fields[form.value.family] || [];
  const listedKeys = new Set(listed.map((f) => f.key));
  // Keep any grade the row has that this family's list doesn't name (a
  // family change, or an odd sheet column) — visible and editable, not lost.
  const extra = [...new Set([...Object.keys(conditionForm.value), ...Object.keys(conditionNotesForm.value)])]
    .filter((k) => !listedKeys.has(k))
    .map((k) => ({ key: k, label: k }));
  return [...listed, ...extra];
});

const title = computed(() => item.value?.nickname || item.value?.model || 'Unnamed piece');
const pill = computed(() => (item.value ? statusPill(item.value) : null));
const qcDue = computed(() => nextQcDue({
  last_qc_at: form.value.last_qc_at, qc_interval_months: form.value.qc_interval_months,
}));
const openTickets = computed(() => (item.value?.tickets || []).filter((t) => !t.archived));
// Status options for a piece in stock: "Sold" is the Mark sold action.
const editableStatuses = computed(() => (meta.value?.sale_statuses || []).filter((st) => st !== 'sold'));
const coverUrl = computed(() => (item.value?.cover_photo_id ? `/api/inventory/photos/${item.value.cover_photo_id}/view` : null));

const consignorLinkedName = computed(() => item.value?.customer_name || '');
const sheetConsignorDiffers = computed(() => form.value.consignor_name
  && (!consignorLinkedName.value || consignorLinkedName.value.toLowerCase() !== form.value.consignor_name.toLowerCase()));

watch(() => item.value?.customer_xero_contact_id, async (id) => {
  xeroUrl.value = id ? await xeroContactUrl(id) : null;
});


// --- consignor as a real customer (and so Xero) ---------------------------
const creatingCustomer = ref(false);
async function createConsignorCustomer() {
  if (!form.value.consignor_name) return;
  if (!confirm(`Create a customer record for "${form.value.consignor_name}"? It will sync to Xero.`)) return;
  creatingCustomer.value = true;
  try {
    const c = await api.post('/customers', { name: form.value.consignor_name, source: 'direct' });
    form.value.customer_id = String(c.id);
    await save();
  } catch (err) {
    error.value = err.message;
  } finally {
    creatingCustomer.value = false;
  }
}

// --- tickets ------------------------------------------------------------
// Same "don't assume a settings key survives" fallback the old Fleet page used.
const creatingTicket = ref(false);
async function createTicket() {
  if (!isInventory.value) {
    router.push({
      path: '/new',
      query: { tab: 'ticket', customer_id: item.value.customer_id || undefined, instrument_id: item.value.id },
    });
    return;
  }
  creatingTicket.value = true;
  error.value = '';
  try {
    const cats = settings.active('ticket_category');
    const pris = settings.active('priority_tier');
    const ticket = await api.post('/tickets', {
      title: `Inventory — ${[item.value.nickname, item.value.model || refData.familyLabel(item.value.family)].filter(Boolean).join(' ')}`,
      category_key: cats.find((c) => c.key === 'inventory_restoration')?.key || cats[0]?.key,
      priority_key: pris.find((p) => p.key === 'standard_priority')?.key || pris[0]?.key,
      instrument_id: item.value.id,
      customer_id: item.value.ownership === 'consignment' ? item.value.customer_id || null : null,
    });
    router.push({ name: 'ticket', params: { id: ticket.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    creatingTicket.value = false;
  }
}

// --- ownership (migration 087) ------------------------------------------
// Buying or consigning a customer's instrument, selling a shop piece, and
// sending a consignment back all change who owns it: the server records the
// history and hands back the whole page, which replaces this one.
const showAcquire = ref(false);
const showSell = ref(false);
function applyDetail(d) {
  item.value = d;
  fillForm(d);
  showAcquire.value = false;
  showSell.value = false;
  error.value = '';
}
const returning = ref(false);
async function returnToOwner() {
  if (!confirm(`Give ${title.value} back to ${item.value.customer_name || 'its owner'} unsold? The consignment ends.`)) return;
  returning.value = true;
  try {
    applyDetail(await api.post(`/inventory/${props.id}/return-to-owner`));
  } catch (err) {
    error.value = err.message;
  } finally {
    returning.value = false;
  }
}

// --- delete ------------------------------------------------------------
async function deletePiece() {
  const where = isInventory.value ? 'from inventory entirely' : 'and its photos';
  if (!confirm(`Delete ${title.value} ${where}? Tickets keep their titles but lose the link. This can't be undone.`)) return;
  try {
    await api.del(`/instruments/${item.value.id}`);
    if (isInventory.value) router.push({ name: 'inventory' });
    else router.push({ name: 'customers', query: item.value.customer_id ? { id: item.value.customer_id } : {} });
  } catch (err) {
    error.value = err.message;
  }
}

// --- history ------------------------------------------------------------
const FIELD_LABELS = {
  sale_status: 'Status', asking_price: 'Price', ownership: 'Ownership', on_website: 'On website',
  hold_for: 'Held for', nfs_reason: 'NFS reason', sold_price: 'Sold price', customer_id: 'Consignor',
  cost_paid: 'Paid', created: 'Added', consignment_status: 'Consignment', audited: 'Audited',
  sold: 'Sold',
};
function eventText(e) {
  const label = FIELD_LABELS[e.field] || e.field;
  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (['asking_price', 'sold_price', 'cost_paid'].includes(e.field)) return formatPrice(v);
    if (e.field === 'sale_status' || e.field === 'created') return meta.value?.sale_status_labels[v] || v;
    if (e.field === 'on_website' || e.field === 'audited') return v === 'true' ? 'yes' : 'no';
    if (e.field === 'consignment_status') return meta.value?.consignment_status_labels[v] || v;
    if (e.field === 'customer_id') return `customer #${v}`;
    return v;
  };
  if (e.field === 'created') return `Added (${fmt(e.new_value)})`;
  if (e.field === 'sold') return e.new_value === 'undone' ? 'Sale undone' : `Sold to ${e.new_value || '—'}`;
  return `${label}: ${fmt(e.old_value)} → ${fmt(e.new_value)}`;
}

const when = (ts) => new Date(ts).toLocaleString();
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString() : '');

onMounted(async () => {
  refData.load();
  settings.load?.();
  meta.value = await api.get('/inventory/meta');
  await load();
});
watch(() => props.id, () => { loading.value = true; load(); });
</script>

<template>
  <div class="page" style="max-width: 1100px">
    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!item" class="card">
      <div class="alert">{{ error || 'Not found' }}</div>
      <RouterLink :to="{ name: 'inventory' }">← Inventory</RouterLink>
    </div>

    <template v-else>
      <RouterLink v-if="isInventory" :to="{ name: 'inventory', query: { family: item.family } }" class="small muted">
        ← {{ refData.familyLabel(item.family) }} inventory
      </RouterLink>
      <RouterLink v-else-if="item.customer_id" :to="{ name: 'customers', query: { id: item.customer_id } }" class="small muted">
        ← {{ item.customer_name || 'Customer' }}
      </RouterLink>
      <RouterLink v-else :to="{ name: 'customers' }" class="small muted">← Customers</RouterLink>

      <div class="page-head detail-head">
        <div class="row" style="gap: 14px; align-items: flex-start; flex-wrap: nowrap">
          <img v-if="coverUrl" :src="coverUrl" alt="" class="cover" />
          <div>
            <h1 style="margin: 0 0 4px">{{ title }}</h1>
            <div class="muted">
              <template v-if="isInventory"><span class="stock-no">{{ item.stock_number }}</span> · </template>
              {{ refData.familyLabel(item.family) }}
              <template v-for="a in attrsSummary(refData.attributes, item)" :key="a"> · {{ a }}</template>
              <template v-if="item.model && item.nickname"> · {{ item.model }}</template>
              <template v-if="item.year"> · {{ item.year }}</template>
              <template v-if="item.serial_no"> · SN {{ item.serial_no }}</template>
            </div>
            <div v-if="!isInventory" class="row" style="margin-top: 8px">
              <span class="pill slate">Customer's instrument</span>
              <span v-if="item.owner">
                Owner: <RouterLink :to="{ name: 'customers', query: { id: item.owner.id } }">{{ item.owner.name }}</RouterLink>
              </span>
              <span v-else-if="ownerName" class="muted">
                Owner: {{ ownerName }} <span class="small">(no customer record — link it under Ownership history)</span>
              </span>
              <span v-else class="muted small">No owner on file</span>
            </div>
            <div v-else class="row" style="margin-top: 8px">
              <span :class="['pill', pill.color]" :title="pill.title">{{ pill.label }}</span>
              <span v-if="item.ownership === 'consignment'" class="pill violet">Consignment</span>
              <span
                v-if="item.ownership === 'consignment' && item.consignment_status"
                :class="['pill', item.consignment_status === 'payout_due' ? 'amber' : 'slate']"
              >{{ meta?.consignment_status_labels[item.consignment_status] }}</span>
              <span v-if="item.on_website" class="pill green">On website</span>
              <label
                v-if="settings.inventoryAuditActive" class="checkbox audit-check" :class="{ todo: !item.audited_at }"
                :title="item.audited_at ? '' : 'Not audited yet — tick once every field has been checked'"
              >
                <input
                  type="checkbox" :checked="!!item.audited_at" :disabled="auditBusy"
                  @change="setAudited($event.target.checked)"
                />
                Audited
                <span v-if="item.audited_at" class="muted small">
                  {{ item.audited_by_name ? `by ${item.audited_by_name} · ` : '' }}{{ new Date(item.audited_at).toLocaleDateString() }}
                </span>
              </label>
              <strong v-if="item.asking_price !== null" style="font-size: 18px">
                {{ formatPrice(item.asking_price) }}
              </strong>
            </div>
          </div>
        </div>
        <div class="row nowrap">
          <!-- On a phone, Photos is three cards down — this is the shortcut for
               shooting an intake set at the bench. -->
          <a href="#photos" class="btn small">Photos ({{ item.photo_count }})</a>
          <a
            v-if="item.photo_album_url" :href="item.photo_album_url" target="_blank" rel="noopener"
            class="btn small" title="This piece's photo folder (Google Drive, from the old Inventory Log)"
          >Photo album ↗</a>
          <button type="button" class="small" :disabled="creatingTicket" @click="createTicket">New ticket</button>
          <button v-if="!isInventory" type="button" class="small primary" @click="showAcquire = !showAcquire">
            {{ showAcquire ? 'Cancel' : 'Add to inventory' }}
          </button>
          <button v-if="auth.isAdmin" type="button" class="small danger" @click="deletePiece">Delete</button>
        </div>
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>

      <InstrumentAcquire
        v-if="showAcquire && !isInventory" :item="item" style="margin-bottom: var(--gap)"
        @done="applyDetail" @cancel="showAcquire = false"
      />

      <div class="detail-grid">
        <!-- Left column: the sheet row, editable ------------------------- -->
        <div class="stack">
          <section class="card">
            <h2>Details</h2>
            <div class="field-row">
              <div class="field"><label>Name</label><input v-model="form.nickname" /></div>
              <div class="field">
                <label>Family</label>
                <select v-model="form.family">
                  <option v-for="f in meta?.families || []" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
                </select>
              </div>
              <AttributeFields
                v-model="attrsForm" :family="form.family" :catalog-attrs="pickedFacts?.attrs || {}"
                :suitcase="pickedFacts ? pickedFacts.is_suitcase : null"
                :console="pickedFacts ? pickedFacts.is_console : null"
              />
            </div>
            <div class="field">
              <label>Model</label>
              <InstrumentModelPicker
                v-model="form.model" v-model:model-id="form.model_id" :family="form.family"
                @facts="pickedFacts = $event"
              />
            </div>
            <div class="field-row">
              <div class="field"><label>Year</label><input v-model="form.year" /></div>
              <div class="field"><label>Serial</label><input v-model="form.serial_no" /></div>
            </div>
            <div class="field">
              <label>Section <span class="muted">(groups it on the inventory list)</span></label>
              <input v-model="form.model_group" placeholder="Rhodes Stage" />
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>Notes</label>
              <textarea v-model="form.identifying_notes" />
            </div>
          </section>

          <section v-if="isInventory" class="card">
            <h2>Condition</h2>
            <!-- Migration 084: grades from a fixed scale, plus a short note per
                 field for anything that isn't a grade ("OG Cube"). -->
            <div class="cond-grid">
              <div v-for="f in conditionFields" :key="f.key" class="field">
                <label :for="`cond-${f.key}`">{{ f.label }}</label>
                <!-- :value + @change rather than v-model: an ungraded field
                     is undefined, which v-model would show as a blank select
                     instead of the "—" option. -->
                <select
                  :id="`cond-${f.key}`" :value="conditionForm[f.key] || ''"
                  :class="['cond-select', gradeClass(conditionForm[f.key])]"
                  @change="conditionForm[f.key] = $event.target.value"
                >
                  <option value="">—</option>
                  <option v-for="g in meta?.condition_grades || []" :key="g.key" :value="g.key">{{ g.label }}</option>
                  <!-- A value from before the fixed scale stays visible rather
                       than the select silently showing blank. -->
                  <option
                    v-if="conditionForm[f.key] && !(meta?.condition_grades || []).some((g) => g.key === conditionForm[f.key])"
                    :value="conditionForm[f.key]"
                  >{{ conditionForm[f.key] }}</option>
                </select>
                <input
                  v-model="conditionNotesForm[f.key]" class="cond-note" placeholder="Note"
                  :aria-label="`${f.label} note`"
                />
              </div>
            </div>
          </section>

          <!-- Cost, parts & labor -- one box (Nov 2026; Cost used to be its
               own card in the right column). Cost and hours go through the
               Save bar like every other field; part lines save themselves
               (InstrumentPartsUsed.vue, migration 078). Cost is admins only. -->
          <section v-if="isInventory" class="card">
            <h2 v-if="auth.isAdmin">Cost, parts &amp; labor</h2>
            <h2 v-else>Parts &amp; labor</h2>
            <template v-if="auth.isAdmin">
              <h3 style="margin: 0 0 8px">Cost <span class="muted small">(admins only)</span></h3>
              <div class="field-row">
                <div class="field"><label>Paid</label><input v-model="form.cost_paid" inputmode="decimal" /></div>
                <div class="field"><label>Note</label><input v-model="form.cost_note" placeholder="labor trade, +repairs…" /></div>
              </div>
              <div v-for="p in item.purchases" :key="p.id" class="small muted">
                Bought from {{ p.seller_name }} on {{ day(p.purchase_date) }} for {{ formatPrice(p.price) }}
                <template v-if="p.receipt_sent_at"> · receipt sent</template>
              </div>
              <h3 style="margin: 16px 0 8px">Labor</h3>
            </template>
            <div class="row hours-row">
              <div class="field" style="margin-bottom: 0; max-width: 200px">
                <label>Estimated hours worked</label>
                <input v-model="form.est_hours" inputmode="decimal" placeholder="0" />
              </div>
              <span v-if="item.logged_hours" class="muted small" style="align-self: flex-end; padding-bottom: 10px">
                {{ Number(item.logged_hours) }} h logged on this piece's tickets
              </span>
            </div>
            <h3 style="margin: 16px 0 8px">Parts</h3>
            <InstrumentPartsUsed :instrument-id="item.id" :family="item.family" />
          </section>

          <section id="photos" class="card">
            <h2>Photos</h2>
            <!-- Migration 082: the Google Drive folder the old Inventory Log
                 sheet linked from this piece's name. A link, not a copy --
                 the photos stay in Drive. Saves with the Save bar. -->
            <div v-if="isInventory || item.photo_album_url" class="field album-field">
              <label>Photo album link <span class="muted">(Google Drive folder from the old sheet, or any album)</span></label>
              <div class="row" style="flex-wrap: nowrap">
                <input v-model="form.photo_album_url" type="url" placeholder="https://drive.google.com/…" style="flex: 1; min-width: 0" />
                <a
                  v-if="item.photo_album_url" :href="item.photo_album_url" target="_blank" rel="noopener"
                  class="btn small nowrap"
                >Open ↗</a>
              </div>
            </div>
            <InstrumentPhotoSets
              :instrument-id="item.id" :sets="item.photo_sets" :cover-photo-id="item.cover_photo_id"
              :presets="meta?.photo_set_presets || []" :tickets="openTickets"
              @changed="reloadKeepingEdits" @cover="setCover"
            />
            <template v-if="item.ticket_photos.length">
              <h3 style="margin-top: 16px">From tickets</h3>
              <p class="muted small" style="margin-top: -6px">Photos attached to this piece's tickets — open the ticket to manage them.</p>
              <div class="ticket-photo-grid">
                <figure v-for="p in item.ticket_photos" :key="p.id">
                  <a :href="`/api/attachments/${p.id}/view`" target="_blank" rel="noopener">
                    <img :src="`/api/attachments/${p.id}/view`" :alt="p.caption || p.file_name || 'Ticket photo'" loading="lazy" />
                  </a>
                  <figcaption class="small">
                    <RouterLink :to="{ name: 'ticket', params: { id: p.ticket_id } }">#{{ p.ticket_id }}</RouterLink>
                    <span class="muted"> · {{ p.caption || day(p.uploaded_at) }}</span>
                  </figcaption>
                </figure>
              </div>
            </template>
          </section>
        </div>

        <!-- Right column: sale, ownership, cost, QC, links ---------------- -->
        <div class="stack">
          <section v-if="!isInventory" class="card">
            <h2>Owner</h2>
            <template v-if="item.owner">
              <RouterLink :to="{ name: 'customers', query: { id: item.owner.id } }"><strong>{{ item.owner.name }}</strong></RouterLink>
              <div v-if="item.owner.email" class="small"><a :href="`mailto:${item.owner.email}`">{{ item.owner.email }}</a></div>
              <div v-if="item.owner.phone" class="small">{{ item.owner.phone }}</div>
            </template>
            <p v-else class="muted small" style="margin: 0">
              {{ ownerName ? `${ownerName} — no customer record yet.` : 'No owner on file.' }}
              Link one from the ownership history below.
            </p>
          </section>

          <section v-if="isInventory" class="card">
            <h2>Sale</h2>
            <div class="field">
              <label>Status</label>
              <select v-model="form.sale_status">
                <option v-for="st in editableStatuses" :key="st" :value="st">{{ meta.sale_status_labels[st] }}</option>
              </select>
            </div>
            <div v-if="form.sale_status === 'not_for_sale'" class="field">
              <label>Why not for sale</label>
              <input v-model="form.nfs_reason" placeholder="Floor, Rental, Private Collection…" />
              <div class="row preset-row">
                <button
                  v-for="r in meta?.nfs_reason_presets || []" :key="r" type="button" class="link small"
                  @click="form.nfs_reason = r"
                >{{ r }}</button>
              </div>
            </div>
            <div v-if="form.sale_status === 'on_hold'" class="field">
              <label>Held for</label>
              <input v-model="form.hold_for" placeholder="Who, and until when" />
            </div>
            <div class="field-row">
              <div class="field"><label>Asking price</label><input v-model="form.asking_price" inputmode="decimal" placeholder="7750" /></div>
              <div class="field"><label>Price note</label><input v-model="form.price_note" placeholder="w/ new tolex" /></div>
            </div>
            <label class="checkbox" style="margin-bottom: 12px">
              <input v-model="form.on_website" type="checkbox" /> Listed on the website
            </label>
            <!-- A sale makes the piece its buyer's instrument (migration 087):
                 its own action, saved on its own, not through the Save bar. -->
            <button v-if="!showSell" type="button" class="primary" :disabled="dirty" @click="showSell = true">
              Mark sold…
            </button>
            <p v-if="dirty && !showSell" class="muted small" style="margin: 6px 0 0">Save or discard your changes first.</p>
            <InstrumentSell v-if="showSell" :item="item" @done="applyDetail" @cancel="showSell = false" />
          </section>

          <section v-if="isInventory" class="card">
            <h2>Ownership</h2>
            <div class="field">
              <select v-model="form.ownership">
                <option value="shop">{{ ownershipLabel('shop') }}</option>
                <option value="consignment">{{ ownershipLabel('consignment') }}</option>
              </select>
            </div>
            <template v-if="form.ownership === 'consignment'">
              <div class="field">
                <label>Consignor</label>
                <CustomerSearchSelect v-model="form.customer_id" placeholder="Link the consignor's customer record…" />
                <div v-if="xeroUrl && !changes.customer_id" class="small" style="margin-top: 4px">
                  <a :href="xeroUrl" target="_blank" rel="noopener">Open in Xero ↗</a>
                </div>
              </div>
              <div v-if="sheetConsignorDiffers" class="alert consignor-hint">
                Sheet says <strong>{{ form.consignor_name }}</strong>.
                <template v-if="!form.customer_id">
                  Link their customer record above, or
                  <button type="button" class="link" :disabled="creatingCustomer" @click="createConsignorCustomer">
                    create one
                  </button>
                  (syncs to Xero).
                </template>
              </div>
              <div class="field-row">
                <div class="field"><label>Name as written</label><input v-model="form.consignor_name" /></div>
                <div class="field"><label>Commission %</label><input v-model="form.consignment_rate" inputmode="decimal" placeholder="25" /></div>
              </div>
              <!-- Marking a consignment sold moves this to "Payout due" on
                   save (routes/inventory.js applyConsignmentRules), so the
                   Consignments view always shows what's owed. -->
              <div class="field-row">
                <div class="field">
                  <label>Deal status</label>
                  <select v-model="form.consignment_status">
                    <option value="">Not recorded</option>
                    <option v-for="cs in meta?.consignment_statuses || []" :key="cs" :value="cs">
                      {{ meta.consignment_status_labels[cs] }}
                    </option>
                  </select>
                </div>
                <div class="field">
                  <label>Terms</label>
                  <input v-model="form.consignment_terms" placeholder="Services + 25% of sale" />
                </div>
              </div>
              <button
                v-if="item.ownership === 'consignment'" type="button" class="small"
                :disabled="returning || dirty" :title="dirty ? 'Save or discard your changes first' : ''"
                @click="returnToOwner"
              >Return to owner unsold</button>
            </template>
          </section>


          <section v-if="isInventory" class="card">
            <h2>QC</h2>
            <div class="field-row">
              <div class="field"><label>Last QC</label><input v-model="form.last_qc_at" type="date" /></div>
              <div class="field">
                <label>Cycle</label>
                <select v-model="form.qc_interval_months">
                  <option value="">None</option>
                  <option value="3">3 months</option>
                  <option value="6">6 months</option>
                  <option value="12">12 months</option>
                </select>
              </div>
            </div>
            <p v-if="qcDue" class="small" style="margin-top: -4px">
              Next due <span :class="['pill', qcDue.getTime() <= Date.now() ? 'red' : 'green']">{{ qcDue.toLocaleDateString() }}</span>
              <span class="muted"> — a QC ticket opens automatically when it comes due.</span>
            </p>
            <div class="field" style="margin-bottom: 0">
              <label>QC notes</label>
              <textarea v-model="form.qc_notes" style="min-height: 60px" />
            </div>
          </section>

          <section class="card">
            <h2>Tickets</h2>
            <p v-if="!item.tickets.length" class="muted small" style="margin: 0">No tickets yet.</p>
            <ul v-else class="plain-list">
              <li v-for="t in item.tickets" :key="t.id" :class="{ muted: t.archived }">
                <RouterLink :to="{ name: 'ticket', params: { id: t.id } }">#{{ t.id }} {{ t.title }}</RouterLink>
                <span class="small muted"> · {{ t.archived ? 'archived' : t.status_label }}</span>
              </li>
            </ul>
          </section>

          <section v-if="item.rentals.length || (isInventory && item.sale_status === 'not_for_sale')" class="card">
            <h2>Rentals</h2>
            <p v-if="!item.rentals.length" class="muted small" style="margin: 0 0 8px">None recorded.</p>
            <ul v-else class="plain-list">
              <li v-for="r in item.rentals" :key="r.id">
                {{ day(r.start_date) }} – {{ r.end_date ? day(r.end_date) : 'open' }}
                <span v-if="r.renter" class="muted"> · {{ r.renter }}</span>
              </li>
            </ul>
            <RouterLink :to="{ name: 'fleet-calendar' }" class="small">Rental calendar →</RouterLink>
          </section>

          <OwnershipHistory :item="item" @changed="applyDetail" />

          <section class="card">
            <h2>Change log</h2>
            <p v-if="!item.events.length" class="muted small" style="margin: 0">
              No changes recorded yet<template v-if="item.import_source === 'inventory_log'"> — imported from the Inventory Log sheet</template>.
            </p>
            <ul v-else class="timeline">
              <li v-for="e in item.events" :key="e.id">
                {{ eventText(e) }}
                <div class="muted small">{{ e.employee_name || 'System' }} · {{ when(e.created_at) }}</div>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <div v-if="dirty" class="save-bar">
        <span>Unsaved changes</span>
        <span class="spacer" />
        <button type="button" class="small" :disabled="saving" @click="discard">Discard</button>
        <button type="button" class="small primary" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save changes' }}
        </button>
      </div>
      <div v-else-if="savedAt" class="muted small saved-note">Saved {{ savedAt.toLocaleTimeString() }}</div>
    </template>
  </div>
</template>

<style scoped>
.detail-head { margin-top: 8px; align-items: flex-start; }
.cover { width: 120px; height: 90px; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--border); }
.stock-no { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.detail-grid { display: grid; gap: var(--gap); grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); padding-bottom: 70px; }
@media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }
.album-field { margin-bottom: 14px; }
.cond-select { width: 100%; }
.cond-note { width: 100%; margin-top: 4px; font-size: 13px; padding-top: 4px; padding-bottom: 4px; }
.cond-grid { display: grid; gap: 0 12px; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
.preset-row { gap: 10px; margin-top: 6px; }
.audit-check {
  padding: 3px 10px; border-radius: 999px; border: 1px solid var(--green); font-size: 13px;
}
.audit-check.todo { border-color: var(--amber); background: color-mix(in srgb, var(--amber) 12%, transparent); }
.audit-check input { width: 16px; height: 16px; min-height: 16px; }
.consignor-hint {
  margin-bottom: 12px; font-size: 13px; color: var(--text);
  border-color: var(--amber); background: rgba(245, 158, 11, 0.08);
}
.plain-list { list-style: none; margin: 0; padding: 0; }
.plain-list li { padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.plain-list li:last-child { border-bottom: none; }
.ticket-photo-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
.ticket-photo-grid figure { margin: 0; }
.ticket-photo-grid img {
  width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block;
  border-radius: var(--radius); border: 1px solid var(--border);
}
.save-bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 20px; background: var(--surface); border-top: 1px solid var(--accent);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.35);
}
.saved-note { position: fixed; right: 20px; bottom: 14px; }
</style>
