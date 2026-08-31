<script setup>
/**
 * Tasks (migration 022, NOTES.md §2.28) — the ticket's short-lived,
 * per-tech work items, deliberately lighter than sub-tickets/QC: just a
 * title, an optional assignee, and a done/not-done checkbox. A task either
 * snapshots a Standard Procedures catalog row ("+ Add procedure" below,
 * family-filtered the same way EstimateNewView.vue's procedure picker is)
 * or is free-form ("+ Add custom task") for work that isn't on the
 * catalog. A quote's procedures already arrive here automatically at
 * conversion (routes/quotes.js's createTicketsForEstimate) — this panel's
 * "+ Add procedure" is for everything else: tickets that never went
 * through a quote, or extra work discovered after the fact.
 *
 * Takes the whole `ticket` object (same convention as TicketSubTickets.vue/
 * TicketQc.vue) since it needs `instrument_family` (to filter procedures)
 * and `status_key` (to know whether tasks are currently "live" — see
 * unlockedNote below). Unlike those siblings, it doesn't emit `changed`:
 * tasks aren't embedded in GET /tickets/:id's payload, so a parent reload
 * wouldn't show anything new — this component just re-fetches its own
 * list after a mutation, the same self-contained way TicketPhotos.vue
 * manages its own attachments off of a ticket id.
 *
 * The task list itself is always visible and editable regardless of the
 * ticket's status, so staff can plan a job's tasks during intake — the
 * status only gates whether these show up on anyone's *dashboard*
 * (routes/tasks.js's `unlocked_only`), not whether they can be worked with
 * here.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });

const settings = useSettings();
const refData = useRefData();

const tasks = ref([]);
const procedures = ref([]);
const loading = ref(true);
const error = ref('');
const busy = ref(false);

const selectedProcedureId = ref('');
const customTitle = ref('');

async function load() {
  loading.value = true;
  try {
    tasks.value = await api.get('/tasks', { ticket_id: props.ticket.id });
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  load();
  // Loaded once per mount, not re-filtered server-side per keystroke — the
  // catalog is small enough (same assumption EstimateNewView.vue already
  // makes) to just fetch everything active and filter client-side below.
  procedures.value = await api.get('/procedures');
});

// NULL family on a procedure = applies to every instrument type (same
// convention as qc_templates.family) — same filter EstimateNewView.vue
// uses for its own per-instrument procedure picker.
const availableProcedures = computed(() => procedures.value.filter(
  (p) => !p.family || p.family === props.ticket.instrument_family,
));

const unlocked = computed(() => settings.unlocksTasks(props.ticket.status_key));

async function addProcedureTask() {
  if (!selectedProcedureId.value) return;
  error.value = '';
  busy.value = true;
  try {
    await api.post('/tasks', { ticket_id: props.ticket.id, standard_procedure_id: selectedProcedureId.value });
    selectedProcedureId.value = '';
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function addCustomTask() {
  const title = customTitle.value.trim();
  if (!title) return;
  error.value = '';
  busy.value = true;
  try {
    await api.post('/tasks', { ticket_id: props.ticket.id, title });
    customTitle.value = '';
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function toggleDone(task) {
  error.value = '';
  try {
    await api.patch(`/tasks/${task.id}`, { done: !task.done });
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function assign(task, technicianId) {
  error.value = '';
  try {
    await api.patch(`/tasks/${task.id}`, { technician_id: technicianId || null });
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function removeTask(task) {
  error.value = '';
  try {
    await api.del(`/tasks/${task.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 4px">
      <h2 style="margin: 0">Tasks</h2>
      <div class="spacer" />
      <span class="muted small">{{ tasks.filter((t) => !t.done).length }} open</span>
    </div>
    <p v-if="!unlocked" class="muted small" style="margin: 0 0 12px">
      Not on anyone's dashboard yet — tasks only show up there once this ticket reaches a status
      marked "Unlocks tasks" (Settings → Ticket statuses). You can still plan and assign them now.
    </p>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-if="loading" class="empty">Loading…</div>
    <template v-else>
      <div v-if="!tasks.length" class="empty">No tasks yet.</div>
      <ul v-else class="checklist" style="margin-bottom: 14px">
        <li v-for="t in tasks" :key="t.id">
          <input type="checkbox" :checked="t.done" @change="toggleDone(t)" />
          <span :style="t.done ? 'text-decoration: line-through; color: var(--text-dim)' : ''" style="flex: 1">
            {{ t.title }}
          </span>
          <select
            class="small" style="max-width: 160px"
            :value="t.technician_id || ''" @change="assign(t, $event.target.value)"
          >
            <option value="">Unassigned</option>
            <option v-for="e in refData.employees" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
          <button type="button" class="small" title="Remove task" @click="removeTask(t)">✕</button>
        </li>
      </ul>

      <div class="field-row">
        <div>
          <label>Add from Standard Procedures</label>
          <div class="row">
            <select v-model="selectedProcedureId" style="flex: 1">
              <option value="">Select a procedure…</option>
              <option v-for="p in availableProcedures" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <button class="small" :disabled="busy || !selectedProcedureId" @click="addProcedureTask">
              + Add
            </button>
          </div>
          <p v-if="!availableProcedures.length" class="muted small" style="margin: 4px 0 0">
            No standard procedures configured for this instrument type yet — add some under
            Settings → Standard procedures.
          </p>
        </div>
        <div>
          <label>Add a custom task</label>
          <div class="row">
            <input
              v-model="customTitle" style="flex: 1" placeholder="Call customer about finish color"
              @keyup.enter="addCustomTask"
            />
            <button class="small" :disabled="busy || !customTitle.trim()" @click="addCustomTask">
              + Add
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
