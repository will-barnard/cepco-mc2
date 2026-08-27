<script setup>
/**
 * Default instrument assignments (Settings -> Default instrument
 * assignments). Lets an admin say "every Rhodes job goes to Sam and Jamie
 * by default" per instrument family (backend: migration 014,
 * routes/instruments.js's /default-technicians endpoints).
 *
 * Two things live on this one page:
 *   - The defaults themselves, one TechnicianPicker per family, saved as
 *     soon as it changes (same "no separate save button" convention as
 *     everything else in Settings).
 *   - "Backfill unassigned tickets", a one-shot catch-up that assigns every
 *     instrument-bearing, nobody-assigned ticket to its family's current
 *     defaults. It's a real action, not a preview — it runs immediately.
 *
 * Neither of these touches ticket creation's own auto-fill behavior
 * directly; TicketNewView.vue reads the same /default-technicians endpoint
 * itself and pre-fills the picker there, independently, whenever the
 * instrument/family selection changes.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useRefData } from '../stores';
import TechnicianPicker from '../components/TechnicianPicker.vue';

const refData = useRefData();

const defaults = ref({});
const loading = ref(true);
const error = ref('');
const notice = ref('');
const backfillBusy = ref(false);
const backfillResult = ref(null);

async function load() {
  loading.value = true;
  try {
    const [byFamily] = await Promise.all([
      api.get('/instruments/default-technicians'),
      refData.load(),
    ]);
    defaults.value = byFamily;
  } finally {
    loading.value = false;
  }
}

async function saveFamily(family, ids) {
  error.value = '';
  notice.value = '';
  try {
    const result = await api.patch(`/instruments/default-technicians/${family}`, { technician_ids: ids });
    defaults.value = { ...defaults.value, [family]: result.technician_ids };
  } catch (err) {
    error.value = err.message;
  }
}

async function runBackfill() {
  error.value = '';
  notice.value = '';
  const ok = confirm(
    "Assign default technicians to every ticket that has an instrument but nobody assigned? "
    + "There's no bulk undo for this — you'd need to unassign tickets one at a time afterward.",
  );
  if (!ok) return;

  backfillBusy.value = true;
  backfillResult.value = null;
  try {
    backfillResult.value = await api.post('/instruments/default-technicians/backfill');
    const { tickets_assigned: assigned, tickets_skipped_no_defaults: skipped } = backfillResult.value;
    notice.value = `Assigned technicians to ${assigned} ticket(s).`
      + (skipped ? ` ${skipped} more had an instrument but no defaults set for that type — ` : '')
      + (skipped ? 'set one above and run this again to pick those up.' : '');
  } catch (err) {
    error.value = err.message;
  } finally {
    backfillBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Default instrument assignments</h1>
        <p class="muted small" style="margin: 0">
          Whoever's checked off here gets pre-filled onto a new ticket as soon as its instrument
          type is picked — still fully editable per-ticket before it's created.
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'settings' }">← Settings</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="card" style="margin-bottom: 16px">
      <h2>Backfill unassigned tickets</h2>
      <p class="muted small" style="margin-top: -6px">
        Finds every open ticket that has an instrument but nobody assigned, and assigns it to that
        instrument type's defaults below. Tickets with no instrument, and archived tickets, are
        left alone.
      </p>
      <button class="primary" :disabled="backfillBusy" @click="runBackfill">
        {{ backfillBusy ? 'Backfilling…' : 'Backfill unassigned tickets' }}
      </button>
    </div>

    <div v-if="loading" class="empty">Loading…</div>

    <div v-else class="grid cols-2">
      <div v-for="family in refData.families" :key="family" class="card">
        <h2 style="text-transform: capitalize">{{ family }}</h2>
        <TechnicianPicker
          :model-value="defaults[family] || []"
          @update:model-value="(ids) => saveFamily(family, ids)"
        />
      </div>
    </div>
  </div>
</template>
