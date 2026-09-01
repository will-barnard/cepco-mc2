<script setup>
/**
 * CEPCo's own showroom / rental fleet (PLAN §4 category 4, §9).
 * Internal tracking only — the public-facing view of these instruments is the
 * Shopify storefront, so nothing here is customer-visible.
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const router = useRouter();
const settings = useSettings();
const refData = useRefData();

const instruments = ref([]);
const family = ref('');
const loading = ref(true);
const error = ref('');

const families = computed(
  () => [...new Set(instruments.value.map((i) => i.family))].sort(),
);

const filtered = computed(() => (family.value
  ? instruments.value.filter((i) => i.family === family.value)
  : instruments.value));

async function load() {
  loading.value = true;
  instruments.value = await api.get('/instruments', { fleet: 'true' });
  loading.value = false;
}

/** Spin up a restoration ticket against a fleet instrument. Prefers the
 * historical category/priority if Settings still has them active, else
 * falls back to whatever sorts first — same "don't assume a key survives"
 * reasoning as TicketNewView.vue (N4a). 'inventory_restoration' itself
 * survived the N2b reshuffle (it's now a sub-category of Repairs &
 * Restoration rather than retiring — see migration 029), so this key is
 * unchanged; 'standard_setup' didn't survive N4b's priority-tier
 * replacement, so that one now prefers 'standard_priority'. */
async function createTicket(instrument) {
  error.value = '';
  try {
    const activeCategories = settings.active('ticket_category');
    const categoryKey = activeCategories.find((c) => c.key === 'inventory_restoration')?.key
      || activeCategories[0]?.key;
    const activePriorities = settings.active('priority_tier');
    const priorityKey = activePriorities.find((p) => p.key === 'standard_priority')?.key
      || activePriorities[0]?.key;
    const ticket = await api.post('/tickets', {
      title: `Fleet — ${instrument.model || instrument.family}`,
      category_key: categoryKey,
      priority_key: priorityKey,
      instrument_id: instrument.id,
      notes: instrument.identifying_notes || null,
    });
    router.push({ name: 'ticket', params: { id: ticket.id } });
  } catch (err) {
    error.value = err.message;
  }
}

/** "Pre 2025" / "Upcoming" / "Never" are the shop's own shorthand — keep them. */
function qcPill(value) {
  const v = (value || '').toLowerCase();
  if (!v || v === 'na' || v === 'never') return 'red';
  if (v.startsWith('upcoming')) return 'amber';
  if (v.startsWith('pre')) return 'slate';
  return 'green';
}

// A3: the real per-instrument QC cycle, next to (not replacing) the
// fleet_last_qc shorthand above — see migration 034. Both columns are
// editable here since the eventual backfill is a data-entry pass done by
// hand, one instrument at a time, not a bulk import.
async function updateInstrument(instrument, patch) {
  error.value = '';
  try {
    const updated = await api.patch(`/instruments/${instrument.id}`, patch);
    Object.assign(instrument, updated);
  } catch (err) {
    error.value = err.message;
  }
}

/** Next-due date, purely client-side display — the sweep itself (services/
 * recurringTickets.js) does the same add-months-to-last_qc_at math server-
 * side; this just previews it here. */
function nextQcDue(i) {
  if (!i.last_qc_at || !i.qc_interval_months) return null;
  const d = new Date(`${i.last_qc_at}T00:00:00`);
  d.setMonth(d.getMonth() + i.qc_interval_months);
  return d;
}

function qcCyclePill(i) {
  const due = nextQcDue(i);
  if (!due) return 'slate';
  return due.getTime() <= Date.now() ? 'red' : 'green';
}

onMounted(() => { load(); refData.load(); });
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Showroom &amp; rental fleet</h1>
        <p class="muted small" style="margin: 0">
          CEPCo-owned instruments. Internal tracking only — customers see these on the storefront.
        </p>
      </div>
      <div class="row nowrap">
        <select v-model="family" style="width: auto; min-width: 160px">
          <option value="">All families</option>
          <option v-for="f in families" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
        </select>
        <RouterLink :to="{ name: 'fleet-calendar' }" class="btn">Rental calendar</RouterLink>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="loading" class="empty">Loading…</div>

    <div v-else class="card tight">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Instrument</th><th>Family</th><th>Last QC</th>
              <th title="Real per-instrument QC cycle (A3) — separate from the free-text column to its left">QC cycle</th>
              <th>Notes</th><th class="right">Open</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in filtered" :key="i.id">
              <td><strong>{{ i.model || '—' }}</strong></td>
              <td class="small">{{ refData.familyLabel(i.family) }}</td>
              <td><span :class="['pill', qcPill(i.fleet_last_qc)]">{{ i.fleet_last_qc || 'Unknown' }}</span></td>
              <td>
                <div class="row nowrap" style="gap: 6px">
                  <input
                    :value="i.last_qc_at ? i.last_qc_at.slice(0, 10) : ''" type="date" style="width: 130px"
                    @change="updateInstrument(i, { last_qc_at: $event.target.value || null })"
                  />
                  <select
                    :value="i.qc_interval_months || ''" style="width: auto"
                    @change="updateInstrument(i, { qc_interval_months: $event.target.value || null })"
                  >
                    <option value="">No cycle</option>
                    <option value="3">3 mo</option>
                    <option value="6">6 mo</option>
                    <option value="12">12 mo</option>
                  </select>
                  <span v-if="nextQcDue(i)" :class="['pill', qcCyclePill(i)]">
                    due {{ nextQcDue(i).toLocaleDateString() }}
                  </span>
                </div>
              </td>
              <td class="small muted">{{ i.identifying_notes || '—' }}</td>
              <td class="right">{{ i.open_tickets }}</td>
              <td class="right">
                <button class="small" @click="createTicket(i)">New ticket</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!filtered.length" class="empty">No fleet instruments recorded.</div>
    </div>
  </div>
</template>
