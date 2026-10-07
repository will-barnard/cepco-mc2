<script setup>
/**
 * Vendor work (migration 064) — outside work on this ticket (Painting,
 * Woodshop, Key Tops, ...) and where each one stands: "Woodshop:
 * Completed/Delivered". Replaces the read-only tags the CSV import left in
 * tickets.vendor_tracks; anything the migration couldn't map onto a type +
 * status is still shown, read-only, under "From the old sheet".
 *
 * Types and statuses are Settings lists (Settings -> Vendor work types /
 * Vendor work statuses). Changing a status saves straight away (PUT
 * /tickets/:id/vendor-work/:trackKey is an upsert), stamping who and when.
 *
 * Same "only shows up once there's something in it" shape as
 * TicketVendorOrders.vue — TicketDetailView's "+ Vendor work" quick action
 * calls openForm().
 */
import { ref, computed } from 'vue';
import api from '../api';
import { useSettings } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const settings = useSettings();
const error = ref('');
const busy = ref(false);
const showForm = ref(false);
const form = ref({ track_key: '', status_key: '' });

const rows = computed(() => props.ticket.vendor_work || []);
const legacy = computed(() => Object.entries(props.ticket.vendor_tracks || {}));

const addableTracks = computed(() => settings.active('vendor_track')
  .filter((t) => !rows.value.some((r) => r.track_key === t.key)));

// Active statuses, plus a row's own if it's since been retired — a select
// whose value isn't among its options renders blank.
function statusOptions(row) {
  const active = settings.active('vendor_status');
  if (!row || active.some((s) => s.key === row.status_key)) return active;
  return [...active, { key: row.status_key, label: row.status_label || row.status_key }];
}
const colorFor = (key) => (settings.data.vendor_status || []).find((s) => s.key === key)?.meta?.color || 'slate';

function openForm() {
  error.value = '';
  form.value = {
    track_key: addableTracks.value[0]?.key || '',
    status_key: settings.active('vendor_status')[0]?.key || '',
  };
  showForm.value = true;
}

async function save(trackKey, body) {
  error.value = '';
  busy.value = true;
  try {
    await api.put(`/tickets/${props.ticket.id}/vendor-work/${encodeURIComponent(trackKey)}`, body);
    emit('changed');
    return true;
  } catch (err) {
    error.value = err.message;
    return false;
  } finally {
    busy.value = false;
  }
}

async function add() {
  if (!form.value.track_key || !form.value.status_key) return;
  if (await save(form.value.track_key, { status_key: form.value.status_key })) showForm.value = false;
}

function setStatus(row, statusKey) {
  if (statusKey !== row.status_key) save(row.track_key, { status_key: statusKey });
}

function setNote(row, note) {
  if ((note || '') !== (row.note || '')) save(row.track_key, { status_key: row.status_key, note });
}

async function remove(row) {
  if (!confirm(`Remove ${row.track_label || row.track_key} from this ticket?`)) return;
  error.value = '';
  try {
    await api.del(`/tickets/${props.ticket.id}/vendor-work/${encodeURIComponent(row.track_key)}`);
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

function stamp(row) {
  const when = new Date(row.updated_at).toLocaleDateString();
  return row.updated_by_name ? `${row.updated_by_name}, ${when}` : when;
}

defineExpose({ openForm });
</script>

<template>
  <div v-if="rows.length || legacy.length || showForm || error" class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Vendor work</h2>
      <div class="spacer" />
      <button v-if="addableTracks.length" class="small" @click="showForm ? (showForm = false) : openForm()">
        {{ showForm ? 'Cancel' : '+ Add vendor' }}
      </button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-if="showForm" class="row" style="margin-bottom: 14px">
      <select v-model="form.track_key" style="max-width: 200px">
        <option v-for="t in addableTracks" :key="t.key" :value="t.key">{{ t.label }}</option>
      </select>
      <select v-model="form.status_key" style="max-width: 220px">
        <option v-for="s in statusOptions(null)" :key="s.key" :value="s.key">{{ s.label }}</option>
      </select>
      <button class="primary small" :disabled="busy || !form.track_key" @click="add">Add</button>
    </div>

    <div v-if="rows.length" class="vendor-rows">
      <div v-for="row in rows" :key="row.id" class="vendor-row">
        <strong class="vendor-name">{{ row.track_label || row.track_key }}</strong>
        <select
          :class="['vendor-status', 'pill-select', colorFor(row.status_key)]"
          :value="row.status_key" :disabled="busy"
          @change="setStatus(row, $event.target.value)"
        >
          <option v-for="s in statusOptions(row)" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <div class="vendor-note">
          <input
            :value="row.note || ''" placeholder="Note (vendor, ETA, …)" maxlength="500"
            @change="setNote(row, $event.target.value)"
          />
          <div class="muted small" title="Last changed">{{ stamp(row) }}</div>
        </div>
        <button class="small" title="Remove from this ticket" @click="remove(row)">×</button>
      </div>
    </div>

    <div v-if="legacy.length" class="field" style="margin: 12px 0 0">
      <label class="small muted">From the old sheet</label>
      <div class="row">
        <span v-for="[k, v] in legacy" :key="k" class="tag">{{ k }}: {{ v }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vendor-rows { display: flex; flex-direction: column; }
.vendor-row {
  display: grid; grid-template-columns: 110px 215px minmax(0, 1fr) auto;
  gap: 10px; align-items: start; padding: 8px 0; border-top: 1px solid var(--border);
}
.vendor-row:first-child { border-top: none; }
.vendor-name { padding-top: 10px; }
.vendor-status { font-weight: 600; }
.vendor-note input { width: 100%; }
.vendor-note .small { margin-top: 3px; }
.pill-select.slate  { color: var(--slate); }
.pill-select.blue   { color: var(--blue); }
.pill-select.violet { color: var(--violet); }
.pill-select.amber  { color: var(--amber); }
.pill-select.green  { color: var(--green); }
.pill-select.red    { color: var(--red); }
.pill-select.cyan   { color: var(--cyan); }
.pill-select.teal   { color: var(--teal); }
.pill-select.lime   { color: var(--lime); }
.pill-select.orange { color: var(--orange); }
.pill-select.pink   { color: var(--pink); }

@media (max-width: 640px) {
  .vendor-row { grid-template-columns: minmax(0, 1fr) auto; }
  .vendor-status, .vendor-note { grid-column: 1 / -1; }
  /* × stays on the name's line, top right. */
  .vendor-row > button { grid-row: 1; grid-column: 2; }
}
</style>
