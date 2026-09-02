<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import api from '../api';
import { useAuth, useSettings } from '../stores';

const auth = useAuth();
const settings = useSettings();
const route = useRoute();

const customers = ref([]);
const selected = ref(null);
const search = ref('');
const showNew = ref(false);
const error = ref('');
const form = ref({ name: '', email: '', phone: '', address: '', source: 'direct', notes: '' });

async function load() {
  customers.value = await api.get('/customers', { q: search.value });
}

async function select(id) {
  selected.value = await api.get(`/customers/${id}`);
}

async function create() {
  error.value = '';
  try {
    const created = await api.post('/customers', form.value);
    form.value = { name: '', email: '', phone: '', address: '', source: 'direct', notes: '' };
    showNew.value = false;
    await load();
    await select(created.id);
  } catch (err) {
    error.value = err.message;
  }
}

let debounce;
watch(search, () => {
  clearTimeout(debounce);
  debounce = setTimeout(load, 250);
});

// TicketDetailView's "Customer" link goes to /customers?id=<id> so clicking
// a customer's name from a ticket actually opens that customer's detail
// pane, not just the bare customer list. Watched (not just read once) so
// following a second such link while already on this page — e.g. from one
// ticket's customer to another via browser back/forward — re-selects too,
// since Vue Router reuses this component instance across same-route
// navigations that only change the query string.
watch(() => route.query.id, (id) => {
  if (id) select(id);
}, { immediate: true });

onMounted(load);

// --- admin: Xero sync panel -------------------------------------------------
// Same "not a bespoke endpoint, just a shop_config settings row edited
// through the generic PATCH /settings/:id" shape as CeppysView.vue's own
// Configure panel — see routes/xero.js's header. useSettings already
// loaded this row as part of the normal settings fetch (App.vue), so this
// panel just finds it and patches it.
const showXeroConfig = ref(false);
const xeroScheduleRow = computed(() => (settings.data.shop_config || []).find((r) => r.key === 'xero_sync'));
const xeroScheduleDraft = ref({ enabled: false, time: '02:00' });
const savingXeroSchedule = ref(false);
const xeroScheduleNotice = ref('');
const syncingXero = ref(false);
const xeroSyncResult = ref(null);

function openXeroConfig() {
  if (xeroScheduleRow.value) {
    xeroScheduleDraft.value = {
      enabled: !!xeroScheduleRow.value.meta.enabled,
      time: xeroScheduleRow.value.meta.time || '02:00',
    };
  }
  xeroScheduleNotice.value = '';
  xeroSyncResult.value = null;
  showXeroConfig.value = true;
}

async function saveXeroSchedule() {
  if (!xeroScheduleRow.value) return;
  error.value = '';
  xeroScheduleNotice.value = '';
  savingXeroSchedule.value = true;
  try {
    await api.patch(`/settings/${xeroScheduleRow.value.id}`, {
      meta: {
        ...xeroScheduleRow.value.meta,
        enabled: xeroScheduleDraft.value.enabled,
        time: xeroScheduleDraft.value.time,
      },
    });
    await settings.load(true);
    xeroScheduleNotice.value = 'Schedule saved.';
  } catch (err) {
    error.value = err.message;
  } finally {
    savingXeroSchedule.value = false;
  }
}

async function syncXeroNow() {
  if (!confirm('Sync customers with Xero right now? This can create or update records on both sides.')) return;
  error.value = '';
  xeroSyncResult.value = null;
  syncingXero.value = true;
  try {
    xeroSyncResult.value = await api.post('/xero/sync');
    await settings.load(true); // picks up the new last_synced_at
    await load(); // the sync may have created or renamed customers
    if (selected.value) await select(selected.value.id);
  } catch (err) {
    error.value = err.message;
  } finally {
    syncingXero.value = false;
  }
}

const when = (ts) => new Date(ts).toLocaleString();
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Customers</h1>
      <div class="row">
        <button v-if="auth.isAdmin" class="small" @click="showXeroConfig ? (showXeroConfig = false) : openXeroConfig()">
          {{ showXeroConfig ? 'Close' : 'Xero sync' }}
        </button>
        <button class="primary" @click="showNew = !showNew">
          {{ showNew ? 'Cancel' : 'New customer' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div v-if="showXeroConfig && auth.isAdmin" class="card" style="margin-bottom: 16px">
      <h2>Xero customer sync</h2>
      <p class="muted small">
        Two-way: a customer created here gets pushed to Xero, a contact created or edited in
        Xero gets pulled in here. When both sides changed the same record since the last sync,
        whichever change is newer wins — see the conflict list below when that happens.
      </p>
      <p class="muted small">
        First time connecting? <RouterLink to="/customers/xero-backfill">Review backfill matches</RouterLink>
        before your first sync, so pre-existing records that don't match exactly (a typo, a
        missing email) get linked instead of duplicated.
      </p>
      <div class="field-row">
        <div class="field">
          <label class="checkbox" style="margin-top: 22px">
            <input v-model="xeroScheduleDraft.enabled" type="checkbox" />
            <span>Sync automatically every day</span>
          </label>
        </div>
        <div class="field">
          <label>Time</label>
          <input v-model="xeroScheduleDraft.time" type="time" />
        </div>
        <div class="field" style="flex: none">
          <label>&nbsp;</label>
          <button class="primary" :disabled="savingXeroSchedule" @click="saveXeroSchedule">
            {{ savingXeroSchedule ? 'Saving…' : 'Save schedule' }}
          </button>
        </div>
      </div>
      <p v-if="xeroScheduleNotice" class="small" style="color: #4ade80; margin: 8px 0 0">{{ xeroScheduleNotice }}</p>
      <p v-if="xeroScheduleRow?.meta?.last_synced_at" class="muted small" style="margin: 8px 0 0">
        Last synced {{ when(xeroScheduleRow.meta.last_synced_at) }}.
      </p>

      <div class="row" style="margin-top: 16px; align-items: center">
        <button class="small" :disabled="syncingXero" @click="syncXeroNow">
          {{ syncingXero ? 'Syncing…' : 'Sync now' }}
        </button>
        <span v-if="xeroSyncResult" class="muted small">
          MC2: +{{ xeroSyncResult.mc2_created }} created, {{ xeroSyncResult.mc2_updated }} updated ·
          Xero: +{{ xeroSyncResult.xero_created }} created, {{ xeroSyncResult.xero_updated }} updated
          <span v-if="xeroSyncResult.conflicts.length"> · {{ xeroSyncResult.conflicts.length }} conflict(s)</span>
        </span>
      </div>
      <ul v-if="xeroSyncResult?.conflicts.length" class="timeline" style="margin-top: 10px">
        <li v-for="(c, i) in xeroSyncResult.conflicts" :key="i" class="small">{{ c }}</li>
      </ul>
    </div>

    <form v-if="showNew" class="card" style="margin-bottom: 16px" @submit.prevent="create">
      <div class="field-row">
        <div class="field">
          <label>Name *</label>
          <input v-model="form.name" required />
        </div>
        <div class="field">
          <label>Email</label>
          <input v-model="form.email" type="email" />
        </div>
        <div class="field">
          <label>Phone</label>
          <input v-model="form.phone" />
        </div>
        <div class="field">
          <label>Source</label>
          <select v-model="form.source">
            <option value="direct">Direct</option>
            <option value="email">Email</option>
            <option value="shopify">Shopify</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" style="min-height: 60px" />
      </div>
      <button class="primary" type="submit">Create customer</button>
    </form>

    <div class="grid cols-2">
      <div class="card tight">
        <input v-model="search" type="search" placeholder="Search customers" style="margin-bottom: 12px" />
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th class="right">Instruments</th><th class="right">Open</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="c in customers" :key="c.id" class="clickable"
                @click="select(c.id)"
              >
                <td>
                  <strong>{{ c.name }}</strong>
                  <div v-if="c.email" class="muted small">{{ c.email }}</div>
                </td>
                <td class="right">{{ c.instrument_count }}</td>
                <td class="right">{{ c.open_tickets }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!customers.length" class="empty">No customers found.</div>
      </div>

      <div v-if="selected" class="card">
        <h2>
          {{ selected.name }}
          <span v-if="selected.xero_contact_id" class="pill blue" style="margin-left: 8px">Linked to Xero</span>
        </h2>
        <p class="muted small">
          {{ [selected.email, selected.phone, selected.source].filter(Boolean).join(' · ') }}
        </p>
        <p v-if="selected.notes">{{ selected.notes }}</p>

        <h3 style="margin-top: 20px">Instruments</h3>
        <div v-if="!selected.instruments.length" class="muted small">None recorded.</div>
        <ul v-else class="timeline">
          <li v-for="i in selected.instruments" :key="i.id">
            <strong>{{ i.model || i.family }}</strong>
            <div class="muted small">{{ i.family }}<span v-if="i.year"> · {{ i.year }}</span></div>
          </li>
        </ul>

        <h3 style="margin-top: 20px">Tickets</h3>
        <div v-if="!selected.tickets.length" class="muted small">No tickets.</div>
        <ul v-else class="timeline">
          <li v-for="t in selected.tickets" :key="t.id">
            <RouterLink :to="`/tickets/${t.id}`">{{ t.title }}</RouterLink>
            <span :class="['pill', settings.colorFor(t.status_key)]" style="margin-left: 8px">
              {{ t.status_label }}
            </span>
          </li>
        </ul>
      </div>

      <div v-else class="card"><div class="empty">Select a customer to see details.</div></div>
    </div>
  </div>
</template>
