<script setup>
/**
 * Ephemeral tasks (migration 054) -- the same lightweight, per-tech work
 * item ticket_tasks already models for a ticket (TicketTasks.vue,
 * routes/tasks.js), just with no ticket_id at all: a shop-wide scratch
 * to-do list for things that don't belong on a customer's job ("restock
 * solder", "call the landlord about the leak"). Reusing ticket_tasks means
 * these get the same assignee/tech-level fields and the same toggle-done
 * API as a real ticket task, and one assigned to you also shows up in the
 * Dashboard's "My tasks" box (DashboardView.vue) right alongside real
 * ticket tasks -- routes/tasks.js's `unlocked_only` treats a task with no
 * ticket as always "unlocked" for exactly that reason.
 *
 * Lives on the admin-only Settings page (Settings -> "Ephemeral tasks"),
 * unlike ticket tasks themselves, which stay open to everyone -- reading
 * this list is unrestricted (GET /tasks has no role check), but creating,
 * editing or removing an ephemeral task requires an admin, same "GET open
 * to everyone, mutations admin-only" split as routes/procedures.js and
 * routes/recurringTicketTemplates.js. The route itself is admin-gated
 * (router.js's meta.admin) so a non-admin never lands here in the first
 * place.
 *
 * Completed tasks are collapsed behind a toggle by default: unlike a
 * ticket's own task list (which naturally goes away once the ticket is
 * archived), nothing here ever ages out on its own, so the open list would
 * otherwise slowly fill up with old completed odds and ends.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const settings = useSettings();
const refData = useRefData();

const tasks = ref([]);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const showDone = ref(false);

const newTitle = ref('');
const newTechLevel = ref('');

// `silent` mirrors TicketTasks.vue's own load() -- only the very first
// load, before anything's on screen, blanks the page to "Loading…"; every
// reload after a mutation (adding/toggling/assigning/removing a task) just
// swaps the list in place.
async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    tasks.value = await api.get('/tasks', { ephemeral_only: 'true' });
  } finally {
    if (!silent) loading.value = false;
  }
}

onMounted(() => {
  load();
  settings.load();
  refData.load();
});

const openTasks = computed(() => tasks.value.filter((t) => !t.done));
const doneTasks = computed(() => tasks.value.filter((t) => t.done));

async function addTask() {
  const title = newTitle.value.trim();
  if (!title) return;
  error.value = '';
  busy.value = true;
  try {
    await api.post('/tasks', { title, tech_level_key: newTechLevel.value || null });
    newTitle.value = '';
    newTechLevel.value = '';
    await load(true);
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
    await load(true);
  } catch (err) {
    error.value = err.message;
  }
}

async function assign(task, technicianId) {
  error.value = '';
  try {
    await api.patch(`/tasks/${task.id}`, { technician_id: technicianId || null });
    await load(true);
  } catch (err) {
    error.value = err.message;
  }
}

async function setTechLevel(task, techLevelKey) {
  error.value = '';
  try {
    await api.patch(`/tasks/${task.id}`, { tech_level_key: techLevelKey || null });
    await load(true);
  } catch (err) {
    error.value = err.message;
  }
}

async function removeTask(task) {
  error.value = '';
  try {
    await api.del(`/tasks/${task.id}`);
    await load(true);
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Ephemeral Tasks</h1>
        <p class="muted small" style="margin: 0">
          A shop-wide scratch to-do list for work that isn't tied to any ticket. Assign one to
          yourself and it also shows up in your Dashboard "My tasks" box.
        </p>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div class="card tight" style="margin-bottom: 16px">
      <div class="row">
        <input
          v-model="newTitle" style="flex: 1" placeholder="Restock solder, call the landlord…"
          @keyup.enter="addTask"
        />
        <select v-model="newTechLevel" style="max-width: 160px">
          <option value="">Any level</option>
          <option v-for="lvl in settings.active('tech_level')" :key="lvl.key" :value="lvl.key">
            {{ lvl.label }}
          </option>
        </select>
        <button class="small primary" :disabled="busy || !newTitle.trim()" @click="addTask">
          + Add task
        </button>
      </div>
    </div>

    <div v-if="loading" class="empty">Loading…</div>
    <template v-else>
      <div class="card tight">
        <div v-if="!openTasks.length" class="empty">No open ephemeral tasks.</div>
        <ul v-else class="checklist">
          <li v-for="t in openTasks" :key="t.id">
            <input type="checkbox" :checked="t.done" @change="toggleDone(t)" />
            <span style="flex: 1">{{ t.title }}</span>
            <select
              class="small" style="max-width: 140px"
              :value="t.tech_level_key || ''" @change="setTechLevel(t, $event.target.value)"
            >
              <option value="">Any level</option>
              <option v-for="lvl in settings.active('tech_level')" :key="lvl.key" :value="lvl.key">
                {{ lvl.label }}
              </option>
            </select>
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
      </div>

      <div style="margin: 16px 0">
        <button type="button" class="small" @click="showDone = !showDone">
          {{ showDone ? 'Hide' : 'Show' }} completed ({{ doneTasks.length }})
        </button>
      </div>

      <div v-if="showDone" class="card tight">
        <div v-if="!doneTasks.length" class="empty">Nothing completed yet.</div>
        <ul v-else class="checklist">
          <li v-for="t in doneTasks" :key="t.id">
            <input type="checkbox" :checked="t.done" @change="toggleDone(t)" />
            <span style="flex: 1; text-decoration: line-through; color: var(--text-dim)">
              {{ t.title }}
            </span>
            <span class="muted small nowrap">{{ t.technician_name || 'Unassigned' }}</span>
            <button type="button" class="small" title="Remove task" @click="removeTask(t)">✕</button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
