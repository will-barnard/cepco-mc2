<script setup>
/**
 * New Task tab of the consolidated "+ New" page (NewView.vue) -- what used
 * to be the admin-only Settings -> Ephemeral tasks page (EphemeralTasksView.vue,
 * now removed; router.js no longer has that route at all -- see NOTES.md).
 * Ephemeral tasks (migration 054) are the same lightweight, per-tech
 * ticket_tasks row a real ticket's task list already uses, just with no
 * ticket_id -- a shop-wide scratch to-do list for things that don't
 * belong on a customer's job ("restock solder", "call the landlord about
 * the leak"). One assigned to you also shows up in the Dashboard's "My
 * tasks" box (DashboardView.vue) right alongside real ticket tasks.
 *
 * This tab sits on a page every signed-in user opens from the dashboard,
 * so adding a task is open to everyone now (routes/tasks.js's POST /
 * dropped its admin-only check for the no-ticket_id case) -- marking one
 * done/not-done is too, same everyday action a real ticket task already
 * lets anyone do. Reassigning, changing tech level, or removing an
 * *existing* one stays admin-only (the same file's PATCH/DELETE still
 * check req.user.role), so those controls below are hidden for anyone
 * else rather than shown and silently failing.
 *
 * Completed tasks are collapsed behind a toggle by default: unlike a
 * ticket's own task list (which naturally goes away once the ticket is
 * archived), nothing here ever ages out on its own, so the open list would
 * otherwise slowly fill up with old completed odds and ends.
 */
import { ref, computed, onMounted } from 'vue';
import { useAuth, useSettings, useRefData } from '../stores';
import api from '../api';

const auth = useAuth();
const settings = useSettings();
const refData = useRefData();

const tasks = ref([]);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const showDone = ref(false);

const newTitle = ref('');
const newTechLevel = ref('');

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
  <div>
    <p class="muted small" style="margin: 0 0 14px">
      A shop-wide scratch to-do list for work that isn't tied to any ticket. Assign one to
      yourself and it also shows up in your Dashboard "My tasks" box.
    </p>

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
        <div v-if="!openTasks.length" class="empty">No open tasks right now.</div>
        <ul v-else class="checklist">
          <li v-for="t in openTasks" :key="t.id">
            <input type="checkbox" :checked="t.done" @change="toggleDone(t)" />
            <span style="flex: 1">{{ t.title }}</span>
            <!-- Reassigning/tech-level on an existing task stays admin-only
                 (routes/tasks.js's PATCH) -- shown only to an admin so a
                 non-admin never sees a control that would just 403. -->
            <template v-if="auth.isAdmin">
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
            </template>
            <span v-else class="muted small nowrap">{{ t.technician_name || 'Unassigned' }}</span>
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
            <button v-if="auth.isAdmin" type="button" class="small" title="Remove task" @click="removeTask(t)">
              ✕
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
