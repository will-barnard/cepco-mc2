<script setup>
/**
 * One inventory piece — everything the sheet row had, editable, plus what
 * the sheet couldn't hold: photo sets, tickets, rentals, QC cycle, and a
 * history of status/price changes.
 *
 * Editing is one form with a sticky Save bar that appears once something
 * changes, and only the changed fields are sent (PATCH /inventory/:id).
 * Photos save on their own as they upload.
 */
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import api from '../api';
import { useAuth, useRefData, useSettings } from '../stores';
import CustomerSearchSelect from '../components/CustomerSearchSelect.vue';
import InstrumentPhotoSets from '../components/InstrumentPhotoSets.vue';
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
  'nickname', 'family', 'model', 'year', 'serial_no', 'model_group', 'identifying_notes',
  'ownership', 'sale_status', 'nfs_reason', 'hold_for', 'asking_price', 'price_note', 'on_website',
  'customer_id', 'consignor_name', 'consignment_rate',
  'sold_at', 'sold_price', 'sold_to_name', 'sold_to_customer_id',
  'qc_notes', 'last_qc_at', 'qc_interval_months',
  'cost_paid', 'cost_note',
];
const form = ref({});
const conditionForm = ref({});

const norm = (v) => (v === null || v === undefined ? '' : String(v));
const moneyNorm = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

function fillForm(row) {
  const f = {};
  for (const k of EDITABLE) {
    if (k === 'on_website') f[k] = !!row[k];
    else if (['asking_price', 'sold_price', 'cost_paid', 'consignment_rate'].includes(k)) f[k] = moneyNorm(row[k]);
    else if (['last_qc_at', 'sold_at'].includes(k)) f[k] = row[k] ? String(row[k]).slice(0, 10) : '';
    else f[k] = norm(row[k]);
  }
  form.value = f;
  conditionForm.value = { ...(row.condition || {}) };
}

const original = computed(() => {
  if (!item.value) return {};
  const f = {};
  for (const k of EDITABLE) {
    const row = item.value;
    if (k === 'on_website') f[k] = !!row[k];
    else if (['asking_price', 'sold_price', 'cost_paid', 'consignment_rate'].includes(k)) f[k] = moneyNorm(row[k]);
    else if (['last_qc_at', 'sold_at'].includes(k)) f[k] = row[k] ? String(row[k]).slice(0, 10) : '';
    else f[k] = norm(row[k]);
  }
  return f;
});

const changes = computed(() => {
  const out = {};
  for (const k of EDITABLE) {
    if (!auth.isAdmin && (k === 'cost_paid' || k === 'cost_note')) continue;
    const now = form.value[k];
    const was = original.value[k];
    let differs;
    if (k === 'on_website') differs = !!now !== was;
    else if (['asking_price', 'sold_price', 'cost_paid', 'consignment_rate'].includes(k)) {
      differs = moneyNorm(String(now).replace(/[$,%]/g, '') || null) !== was;
    } else {
      // CustomerSearchSelect hands back numbers, the form holds strings.
      differs = norm(now) !== was;
    }
    if (differs) out[k] = now === '' ? null : now;
  }
  const condNow = Object.fromEntries(Object.entries(conditionForm.value).filter(([, v]) => String(v || '').trim()));
  const condWas = item.value?.condition || {};
  if (JSON.stringify(Object.entries(condNow).sort()) !== JSON.stringify(Object.entries(condWas).sort())) {
    out.condition = condNow;
  }
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

async function save() {
  if (!dirty.value) return;
  saving.value = true;
  error.value = '';
  try {
    const updated = await api.patch(`/inventory/${props.id}`, changes.value);
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
    await api.patch(`/inventory/${props.id}`, { cover_photo_id: photoId });
    await reloadKeepingEdits();
  } catch (err) {
    error.value = err.message;
  }
}

// --- derived display --------------------------------------------------------
const conditionFields = computed(() => {
  const listed = meta.value?.condition_fields[form.value.family] || [];
  const listedKeys = new Set(listed.map((f) => f.key));
  // Keep any grade the row has that this family's list doesn't name (a
  // family change, or an odd sheet column) — visible and editable, not lost.
  const extra = Object.keys(conditionForm.value)
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
const coverUrl = computed(() => (item.value?.cover_photo_id ? `/api/inventory/photos/${item.value.cover_photo_id}/view` : null));

const consignorLinkedName = computed(() => item.value?.customer_name || '');
const sheetConsignorDiffers = computed(() => form.value.consignor_name
  && (!consignorLinkedName.value || consignorLinkedName.value.toLowerCase() !== form.value.consignor_name.toLowerCase()));

watch(() => item.value?.customer_xero_contact_id, async (id) => {
  xeroUrl.value = id ? await xeroContactUrl(id) : null;
});

// Picking "Sold" fills today's date in the form so it's visible before
// saving (the API would do the same).
watch(() => form.value.sale_status, (s, prev) => {
  if (s === 'sold' && prev && prev !== 'sold' && !form.value.sold_at) {
    form.value.sold_at = new Date().toISOString().slice(0, 10);
    if (!form.value.sold_price && form.value.asking_price) form.value.sold_price = form.value.asking_price;
  }
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

// --- delete ------------------------------------------------------------
async function deletePiece() {
  if (!confirm(`Delete ${title.value} from inventory entirely? Tickets keep their titles but lose the link. This can't be undone.`)) return;
  try {
    await api.del(`/instruments/${item.value.id}`);
    router.push({ name: 'inventory' });
  } catch (err) {
    error.value = err.message;
  }
}

// --- history ------------------------------------------------------------
const FIELD_LABELS = {
  sale_status: 'Status', asking_price: 'Price', ownership: 'Ownership', on_website: 'On website',
  hold_for: 'Held for', nfs_reason: 'NFS reason', sold_price: 'Sold price', customer_id: 'Consignor',
  cost_paid: 'Paid', created: 'Added',
};
function eventText(e) {
  const label = FIELD_LABELS[e.field] || e.field;
  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (['asking_price', 'sold_price', 'cost_paid'].includes(e.field)) return formatPrice(v);
    if (e.field === 'sale_status' || e.field === 'created') return meta.value?.sale_status_labels[v] || v;
    if (e.field === 'on_website') return v === 'true' ? 'yes' : 'no';
    if (e.field === 'customer_id') return `customer #${v}`;
    return v;
  };
  if (e.field === 'created') return `Added (${fmt(e.new_value)})`;
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
      <RouterLink :to="{ name: 'inventory' }">← Back to inventory</RouterLink>
    </div>

    <template v-else>
      <RouterLink :to="{ name: 'inventory', query: { family: item.family } }" class="small muted">
        ← {{ refData.familyLabel(item.family) }} inventory
      </RouterLink>

      <div class="page-head detail-head">
        <div class="row" style="gap: 14px; align-items: flex-start; flex-wrap: nowrap">
          <img v-if="coverUrl" :src="coverUrl" alt="" class="cover" />
          <div>
            <h1 style="margin: 0 0 4px">{{ title }}</h1>
            <div class="muted">
              <span class="stock-no">{{ item.stock_number }}</span>
              · {{ refData.familyLabel(item.family) }}
              <template v-if="item.model && item.nickname"> · {{ item.model }}</template>
              <template v-if="item.year"> · {{ item.year }}</template>
              <template v-if="item.serial_no"> · SN {{ item.serial_no }}</template>
            </div>
            <div class="row" style="margin-top: 8px">
              <span :class="['pill', pill.color]" :title="pill.title">{{ pill.label }}</span>
              <span v-if="item.ownership === 'consignment'" class="pill violet">Consignment</span>
              <span v-if="item.on_website" class="pill green">On website</span>
              <strong v-if="item.asking_price !== null && item.sale_status !== 'sold'" style="font-size: 18px">
                {{ formatPrice(item.asking_price) }}
              </strong>
              <strong v-if="item.sale_status === 'sold' && item.sold_price !== null">
                Sold for {{ formatPrice(item.sold_price) }}
              </strong>
            </div>
          </div>
        </div>
        <div class="row nowrap">
          <!-- On a phone, Photos is three cards down — this is the shortcut for
               shooting an intake set at the bench. -->
          <a href="#photos" class="btn small">Photos ({{ item.photo_count }})</a>
          <button type="button" class="small" :disabled="creatingTicket" @click="createTicket">New ticket</button>
          <button v-if="auth.isAdmin" type="button" class="small danger" @click="deletePiece">Delete</button>
        </div>
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>

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
            </div>
            <div class="field-row">
              <div class="field"><label>Model</label><input v-model="form.model" /></div>
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

          <section class="card">
            <h2>Condition</h2>
            <div class="cond-grid">
              <div v-for="f in conditionFields" :key="f.key" class="field">
                <label>{{ f.label }}</label>
                <input v-model="conditionForm[f.key]" :class="gradeClass(conditionForm[f.key])" placeholder="EX, VG, OG…" />
              </div>
            </div>
          </section>

          <section id="photos" class="card">
            <h2>Photos</h2>
            <InstrumentPhotoSets
              :instrument-id="item.id" :sets="item.photo_sets" :cover-photo-id="item.cover_photo_id"
              :presets="meta?.photo_set_presets || []" :tickets="openTickets"
              @changed="reloadKeepingEdits" @cover="setCover"
            />
            <template v-if="item.ticket_photos.length">
              <h3 style="margin-top: 16px">From tickets</h3>
              <p class="muted small" style="margin-top: -6px">Photos attached to this piece's tickets — open the ticket to manage them.</p>
              <ul class="ticket-photo-list">
                <li v-for="p in item.ticket_photos" :key="p.id">
                  <RouterLink :to="{ name: 'ticket', params: { id: p.ticket_id } }">#{{ p.ticket_id }} {{ p.ticket_title }}</RouterLink>
                  <span class="muted small"> · {{ p.caption || p.file_name }} · {{ day(p.uploaded_at) }}</span>
                </li>
              </ul>
            </template>
          </section>
        </div>

        <!-- Right column: sale, ownership, cost, QC, links ---------------- -->
        <div class="stack">
          <section class="card">
            <h2>Sale</h2>
            <div class="field">
              <label>Status</label>
              <select v-model="form.sale_status">
                <option v-for="s in meta?.sale_statuses || []" :key="s" :value="s">{{ meta.sale_status_labels[s] }}</option>
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
            <template v-if="form.sale_status === 'sold'">
              <div class="field-row">
                <div class="field"><label>Sold for</label><input v-model="form.sold_price" inputmode="decimal" /></div>
                <div class="field"><label>Sold on</label><input v-model="form.sold_at" type="date" /></div>
              </div>
              <div class="field"><label>Sold to (name)</label><input v-model="form.sold_to_name" /></div>
              <div class="field" style="margin-bottom: 0">
                <label>Buyer's customer record</label>
                <CustomerSearchSelect v-model="form.sold_to_customer_id" placeholder="Link the buyer (optional)…" />
              </div>
            </template>
          </section>

          <section class="card">
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
            </template>
          </section>

          <section v-if="auth.isAdmin" class="card">
            <h2>Cost <span class="muted small">(admins only)</span></h2>
            <div class="field-row">
              <div class="field"><label>Paid</label><input v-model="form.cost_paid" inputmode="decimal" /></div>
              <div class="field"><label>Note</label><input v-model="form.cost_note" placeholder="labor trade, +repairs…" /></div>
            </div>
            <div v-for="p in item.purchases" :key="p.id" class="small muted">
              Bought from {{ p.seller_name }} on {{ day(p.purchase_date) }} for {{ formatPrice(p.price) }}
              <template v-if="p.receipt_sent_at"> · receipt sent</template>
            </div>
          </section>

          <section class="card">
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

          <section v-if="item.rentals.length || item.sale_status === 'not_for_sale'" class="card">
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

          <section class="card">
            <h2>History</h2>
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
.cond-grid { display: grid; gap: 0 12px; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
.preset-row { gap: 10px; margin-top: 6px; }
.consignor-hint {
  margin-bottom: 12px; font-size: 13px; color: var(--text);
  border-color: var(--amber); background: rgba(245, 158, 11, 0.08);
}
.plain-list { list-style: none; margin: 0; padding: 0; }
.plain-list li { padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.plain-list li:last-child { border-bottom: none; }
.ticket-photo-list { margin: 0; padding-left: 18px; font-size: 14px; }
.save-bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 20px; background: var(--surface); border-top: 1px solid var(--accent);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.35);
}
.saved-note { position: fixed; right: 20px; bottom: 14px; }
</style>
