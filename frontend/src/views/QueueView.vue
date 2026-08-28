<script setup>
/**
 * Queue — dedicated drag-and-drop reordering, split out of TicketsView.vue
 * (which stays focused on filtering/finding a ticket; NOTES.md). A ticket
 * sits in up to three kinds of queue — its category's, each of its assigned
 * techs' own (migration 007, extended to one position per assignment in
 * 013), and its instrument's family (migration 015, e.g. every Rhodes job)
 * — this page reorders one of those at a time, picked from the single
 * dropdown below.
 *
 * Open to any signed-in user, not just admins — same as assigning
 * technicians to a ticket already was.
 *
 * The picker's value is "category:<key>", "tech:<employee id>", or
 * "family:<family key>" so one <select> can switch between all three queue
 * types. The list itself is just GET /tickets?category=..., ?technician_id=
 * ..., or ?instrument_family=..., already returned in that queue's own
 * order (see routes/tickets.js's GET / ORDER BY) — this page reads and
 * writes the exact same ordering TicketsView shows when it's filtered down
 * to one category, one tech, or one instrument family.
 */
import { ref, computed, watch, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const settings = useSettings();
const refData = useRefData();

const selected = ref('');
const scope = computed(() => {
  if (selected.value.startsWith('tech:')) return 'tech';
  if (selected.value.startsWith('family:')) return 'family';
  return 'category';
});
const categoryKey = computed(
  () => (scope.value === 'category' ? selected.value.slice('category:'.length) : ''),
);
const employeeId = computed(
  () => (scope.value === 'tech' ? Number(selected.value.slice('tech:'.length)) : null),
);
const familyKey = computed(
  () => (scope.value === 'family' ? selected.value.slice('family:'.length) : ''),
);

const tickets = ref([]);
const loading = ref(false);
const error = ref('');
const saving = ref(false);
const dragIndex = ref(null);

async function load() {
  if (!selected.value) { tickets.value = []; return; }
  loading.value = true;
  error.value = '';
  try {
    let params;
    if (scope.value === 'category') params = { category: categoryKey.value };
    else if (scope.value === 'tech') params = { technician_id: employeeId.value };
    else params = { instrument_family: familyKey.value };
    tickets.value = await api.get('/tickets', params);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

watch(selected, load);

// Default to the first category once settings has loaded, so this isn't a
// blank picker on first visit.
watch(() => settings.categories, (cats) => {
  if (!selected.value && cats.length) selected.value = `category:${cats[0].key}`;
}, { immediate: true });

onMounted(async () => {
  await Promise.all([settings.load(), refData.load()]);
});

function onDragStart(index, event) {
  dragIndex.value = index;
  event.dataTransfer.effectAllowed = 'move';
  // Firefox won't start a drag at all unless setData is called.
  event.dataTransfer.setData('text/plain', String(tickets.value[index].id));
}

// Live-reorders the on-screen list as the dragged row passes over others —
// the actual save happens once, on drop/dragend, not on every one of these.
function onDragOver(index) {
  if (dragIndex.value === null || dragIndex.value === index) return;
  const moved = tickets.value.splice(dragIndex.value, 1)[0];
  tickets.value.splice(index, 0, moved);
  dragIndex.value = index;
}

async function onDragEnd() {
  if (dragIndex.value === null) return;
  dragIndex.value = null;
  await persistOrder();
}

// Sends the whole reordered id list — the server checks it's exactly the
// set of tickets currently in this queue (nobody else changed it mid-drag)
// and renumbers positions to match. A mismatch reloads the queue instead of
// silently applying a stale order on top of whatever changed.
async function persistOrder() {
  error.value = '';
  saving.value = true;
  try {
    const ticketIds = tickets.value.map((t) => t.id);
    let body;
    if (scope.value === 'category') body = { scope: 'category', category_key: categoryKey.value, ticket_ids: ticketIds };
    else if (scope.value === 'tech') body = { scope: 'tech', employee_id: employeeId.value, ticket_ids: ticketIds };
    else body = { scope: 'family', family: familyKey.value, ticket_ids: ticketIds };
    await api.post('/tickets/reorder-queue', body);
  } catch (err) {
    error.value = `${err.message} The queue below has been reloaded.`;
    await load();
  } finally {
    saving.value = false;
  }
}

/** "Sam Tech, Jamie Tech" — shown in category and family view, where who's
 * on each ticket isn't otherwise implied by which queue you're looking at
 * (the tech view doesn't need it — that's the one axis it *is* the queue). */
function techNames(t) {
  return (t.technicians || []).map((x) => x.name).join(', ') || 'unassigned';
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Queue</h1>
        <p class="muted small" style="margin: 0">
          Drag a ticket to move it within a category's queue, a technician's own queue, or an
          instrument family's queue — the new order saves as soon as you drop it.
        </p>
      </div>
    </div>

    <div class="card tight" style="margin-bottom: 16px">
      <div class="field" style="margin: 0; max-width: 320px">
        <label>Queue</label>
        <select v-model="selected">
          <option value="" disabled>— choose a queue —</option>
          <optgroup label="By category">
            <option v-for="c in settings.categories" :key="c.key" :value="`category:${c.key}`">
              {{ c.label }}
            </option>
          </optgroup>
          <optgroup label="By technician">
            <option v-for="e in refData.employees" :key="e.id" :value="`tech:${e.id}`">
              {{ e.name }}
            </option>
          </optgroup>
          <optgroup label="By instrument family">
            <option v-for="f in refData.families" :key="f" :value="`family:${f}`">
              {{ f }}
            </option>
          </optgroup>
        </select>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!selected" class="empty">Pick a category or technician above to see its queue.</div>
    <div v-else-if="!tickets.length" class="empty">No tickets in this queue.</div>

    <div v-else class="stack" :style="saving ? 'opacity: 0.6; pointer-events: none' : ''">
      <div
        v-for="(t, i) in tickets" :key="t.id"
        class="card tight"
        :style="dragIndex === i ? 'opacity: 0.4' : ''"
        draggable="true"
        @dragstart="onDragStart(i, $event)"
        @dragover.prevent="onDragOver(i)"
        @drop.prevent
        @dragend="onDragEnd"
      >
        <div class="row" style="align-items: center; gap: 14px">
          <span class="muted" style="font-size: 18px; line-height: 1; cursor: grab" title="Drag to reorder">
            ⠿
          </span>
          <span class="muted small nowrap">#{{ i + 1 }}</span>
          <div style="flex: 1; min-width: 0">
            <RouterLink :to="{ name: 'ticket', params: { id: t.id } }">
              <strong>{{ t.title }}</strong>
            </RouterLink>
            <div class="muted small">
              {{ t.customer_name || (t.instrument_is_fleet ? 'CEPCo fleet' : '—') }}
              <span v-if="t.instrument_family && scope !== 'family'"> · {{ t.instrument_family }}</span>
            </div>
          </div>
          <span :class="['pill', settings.colorFor(t.status_key)]">
            {{ t.status_label || t.status_label_snapshot }}
          </span>
          <span
            v-if="scope !== 'tech'" class="muted small nowrap"
            style="min-width: 140px; text-align: right"
          >
            {{ techNames(t) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
