<script setup>
/**
 * CEPCo's own showroom / rental fleet (PLAN §4 category 4, §9).
 * Internal tracking only — the public-facing view of these instruments is the
 * Shopify storefront, so nothing here is customer-visible.
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import api from '../api';

const router = useRouter();

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

/** Spin up a restoration ticket against a fleet instrument. */
async function createTicket(instrument) {
  error.value = '';
  try {
    const ticket = await api.post('/tickets', {
      title: `Fleet — ${instrument.model || instrument.family}`,
      category_key: 'inventory_restoration',
      priority_key: 'standard_setup',
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

onMounted(load);
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
          <option v-for="f in families" :key="f" :value="f">{{ f }}</option>
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
              <th>Notes</th><th class="right">Open</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in filtered" :key="i.id">
              <td><strong>{{ i.model || '—' }}</strong></td>
              <td class="small">{{ i.family }}</td>
              <td><span :class="['pill', qcPill(i.fleet_last_qc)]">{{ i.fleet_last_qc || 'Unknown' }}</span></td>
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
