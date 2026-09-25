<script setup>
/**
 * A customer's Xero History & Notes, read live from Xero (GET
 * /customers/:id/xero-history -> services/ticketNotes.js's contactHistory)
 * and shown read-only. Notes MC2 itself posted to Xero are filtered out
 * server-side -- they're already on their tickets.
 *
 * Used on the ticket page (under the ticket's own notes, collapsed by
 * default so it doesn't cost a Xero call on every ticket view) and on the
 * Customers page's detail pane (open).
 */
import { ref, watch } from 'vue';
import api from '../api';

const props = defineProps({
  customerId: { type: [Number, String], required: true },
  collapsible: { type: Boolean, default: false },
});

const open = ref(!props.collapsible);
const loading = ref(false);
const loaded = ref(false);
const records = ref([]);
const error = ref('');
// Xero's own audit trail ("Contact edited", "Invoice sent") is useful but
// noisy -- notes people typed are what matter most, so those show by
// default and the rest is one click away.
const showActivity = ref(false);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.get(`/customers/${props.customerId}/xero-history`);
    records.value = res.records || [];
    if (res.error) error.value = `Couldn't reach Xero: ${res.error}`;
    loaded.value = true;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

watch(() => props.customerId, () => {
  loaded.value = false;
  records.value = [];
  if (open.value) load();
}, { immediate: true });

function toggle() {
  open.value = !open.value;
  if (open.value && !loaded.value) load();
}

const visible = () => records.value.filter((r) => showActivity.value || r.kind === 'note');
const when = (ts) => (ts ? new Date(ts).toLocaleString([], {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '');
</script>

<template>
  <div class="xero-history">
    <div class="row" style="align-items: center">
      <button
        v-if="collapsible" type="button" class="disclosure-toggle"
        :class="{ open }" :aria-expanded="open ? 'true' : 'false'" @click="toggle"
      >
        <span class="disclosure-caret">▸</span> History from Xero
      </button>
      <h3 v-else style="margin: 0">History from Xero</h3>
      <div class="spacer" />
      <label v-if="open && loaded" class="checkbox small" style="margin: 0">
        <input v-model="showActivity" type="checkbox" />
        <span>Show Xero activity</span>
      </label>
      <button v-if="open && loaded" type="button" class="link small" :disabled="loading" @click="load">
        Refresh
      </button>
    </div>

    <template v-if="open">
      <div v-if="loading && !loaded" class="muted small" style="margin-top: 6px">Loading from Xero…</div>
      <div v-if="error" class="muted small" style="margin-top: 6px; color: var(--amber)">{{ error }}</div>
      <ul v-if="visible().length" class="timeline" style="margin-top: 8px">
        <li v-for="(r, i) in visible()" :key="i">
          <div class="muted small">
            {{ when(r.at) }}<span v-if="r.user"> · {{ r.user }}</span>
            <span v-if="r.kind !== 'note'"> · {{ r.changes }}</span>
          </div>
          <div class="xero-history-details">{{ r.details }}</div>
        </li>
      </ul>
      <p v-else-if="loaded && !error" class="muted small" style="margin: 6px 0 0">
        {{ showActivity ? 'Nothing in Xero for this contact yet.' : 'No notes in Xero for this contact.' }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.xero-history-details { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
