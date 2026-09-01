<script setup>
/**
 * Recurring tickets (Settings -> Recurring tickets, A1/A2 on the boss
 * list). Admin CRUD over recurring_ticket_templates — the config
 * services/recurringTickets.js's scheduler reads once a minute. Same shape
 * of screen as ProceduresView.vue: inline-editable rows that autosave on
 * change, a "+ New template" form, Pause/Resume instead of delete (a
 * template with a firing history is worth keeping around retired rather
 * than losing what it used to do).
 */
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const settings = useSettings();
const refData = useRefData();

const templates = ref([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

async function load() {
  loading.value = true;
  try {
    const [tpls] = await Promise.all([api.get('/recurring-ticket-templates'), refData.load()]);
    templates.value = tpls;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// Active roster only — same "who's pickable as an assignee" filter every
// other assignee dropdown in the app uses (Settings -> Staff accounts'
// default-technician pickers, CeppysView's recipient list, etc.).
const activeEmployees = computed(() => refData.employees.filter((e) => e.active));

function onFixedAssigneeChange(t, value) {
  updateField(t, { fixed_assignee_employee_id: value ? Number(value) : null });
}

const daily = computed(() => templates.value.filter((t) => t.cadence === 'daily'));
const weekly = computed(() => templates.value.filter((t) => t.cadence === 'weekly'));

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// --- create ------------------------------------------------------------
const showNew = ref(false);
const blankForm = () => ({
  title: '', category_key: '', priority_key: '', cadence: 'daily', day_of_week: 1, time_of_day: '08:00',
  rotate_among_active_techs: false, fixed_assignee_employee_id: '', notes: '',
});
const form = ref(blankForm());

function openNew() {
  form.value = blankForm();
  form.value.category_key = settings.active('ticket_category')[0]?.key || '';
  form.value.priority_key = settings.active('priority_tier')[0]?.key || '';
  showNew.value = true;
}

async function createTemplate() {
  error.value = '';
  notice.value = '';
  if (!form.value.title.trim()) { error.value = 'Title is required'; return; }
  try {
    await api.post('/recurring-ticket-templates', {
      title: form.value.title.trim(),
      category_key: form.value.category_key,
      priority_key: form.value.priority_key,
      cadence: form.value.cadence,
      day_of_week: form.value.cadence === 'weekly' ? Number(form.value.day_of_week) : null,
      time_of_day: form.value.time_of_day,
      rotate_among_active_techs: form.value.rotate_among_active_techs,
      fixed_assignee_employee_id: form.value.fixed_assignee_employee_id
        ? Number(form.value.fixed_assignee_employee_id) : null,
      notes: form.value.notes || null,
    });
    showNew.value = false;
    notice.value = 'Template created.';
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// --- inline edit ---------------------------------------------------------
async function updateField(t, patch) {
  error.value = '';
  notice.value = '';
  try {
    await api.patch(`/recurring-ticket-templates/${t.id}`, patch);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function removeTemplate(t) {
  error.value = '';
  try {
    await api.del(`/recurring-ticket-templates/${t.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

function fmtLastGenerated(t) {
  if (!t.last_generated_at) return 'never';
  return new Date(t.last_generated_at).toLocaleDateString();
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Recurring tickets</h1>
        <p class="muted small" style="margin: 0">
          Fires automatically once a day/week at the configured shop-local time — see the four
          daily sweeps and four weekly chores seeded by default. A weekly template with "Rotate
          among active techs" on assigns whoever's next in line, skipping anyone checked "Skip
          chores" on Settings → Staff accounts. Pin "Fixed assignee" on any template — daily or
          weekly — to always assign the same person instead; a pin always wins over rotation,
          and clearing it later just resumes rotation where it left off.
        </p>
      </div>
      <div class="row">
        <RouterLink class="btn small" :to="{ name: 'settings' }">← Settings</RouterLink>
        <button class="small" @click="showNew ? (showNew = false) : openNew()">
          {{ showNew ? 'Cancel' : '+ New template' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <form v-if="showNew" class="card tight" style="margin-bottom: 16px" @submit.prevent="createTemplate">
      <div class="field-row" style="align-items: end">
        <div class="field" style="flex: 2; margin: 0">
          <label>Title *</label>
          <input v-model="form.title" required placeholder="AM Inbox Clearing" />
        </div>
        <div class="field" style="margin: 0">
          <label>Category</label>
          <select v-model="form.category_key">
            <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">
              {{ c.label }}
            </option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Priority</label>
          <select v-model="form.priority_key">
            <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
              {{ p.label }}
            </option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Cadence</label>
          <select v-model="form.cadence">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        <div v-if="form.cadence === 'weekly'" class="field" style="margin: 0">
          <label>Day</label>
          <select v-model="form.day_of_week">
            <option v-for="(d, i) in DOW_LABELS" :key="i" :value="i">{{ d }}</option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Time (shop-local)</label>
          <input v-model="form.time_of_day" type="time" required />
        </div>
        <div class="field" style="flex: none; margin: 0">
          <button class="primary" type="submit">Create</button>
        </div>
      </div>
      <label class="checkbox" style="margin-top: 12px">
        <input v-model="form.rotate_among_active_techs" type="checkbox" />
        <span class="small">Rotate among active techs (weekly chores) instead of the category's default assignee</span>
      </label>
      <div class="field" style="margin-top: 12px; margin-bottom: 0">
        <label>Fixed assignee (optional — overrides rotation/default when set)</label>
        <select v-model="form.fixed_assignee_employee_id">
          <option value="">— none, use rotation / default assignee —</option>
          <option v-for="e in activeEmployees" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </div>
      <div class="field" style="margin-top: 12px; margin-bottom: 0">
        <label>Notes (copied onto every generated ticket)</label>
        <input v-model="form.notes" />
      </div>
    </form>

    <div v-if="loading" class="empty">Loading…</div>
    <template v-else>
      <h3>Daily</h3>
      <div v-if="!daily.length" class="empty">No daily templates.</div>
      <div v-else class="stack" style="margin-bottom: 20px">
        <div v-for="t in daily" :key="t.id" class="card">
          <div class="row">
            <input
              :value="t.title" style="min-width: 200px; font-weight: 600"
              @change="updateField(t, { title: $event.target.value })"
            />
            <select :value="t.category_key" @change="updateField(t, { category_key: $event.target.value })">
              <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">
                {{ c.label }}
              </option>
            </select>
            <select :value="t.priority_key" @change="updateField(t, { priority_key: $event.target.value })">
              <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
                {{ p.label }}
              </option>
            </select>
            <input
              :value="t.time_of_day" type="time" style="width: 110px"
              @change="updateField(t, { time_of_day: $event.target.value })"
            />
            <select
              :value="t.fixed_assignee_employee_id || ''" title="Fixed assignee"
              @change="onFixedAssigneeChange(t, $event.target.value)"
            >
              <option value="">No pin — rotation / default assignee</option>
              <option v-for="e in activeEmployees" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
            <span class="muted small">last: {{ fmtLastGenerated(t) }}</span>
            <span :class="['pill', t.active ? 'green' : 'slate']">{{ t.active ? 'Active' : 'Paused' }}</span>
            <div class="spacer" />
            <button class="small" @click="updateField(t, { active: !t.active })">
              {{ t.active ? 'Pause' : 'Resume' }}
            </button>
            <button class="small" title="Delete" @click="removeTemplate(t)">✕</button>
          </div>
        </div>
      </div>

      <h3>Weekly (chore rotation)</h3>
      <div v-if="!weekly.length" class="empty">No weekly templates.</div>
      <div v-else class="stack">
        <div v-for="t in weekly" :key="t.id" class="card">
          <div class="row">
            <input
              :value="t.title" style="min-width: 160px; font-weight: 600"
              @change="updateField(t, { title: $event.target.value })"
            />
            <select :value="t.day_of_week" @change="updateField(t, { day_of_week: Number($event.target.value) })">
              <option v-for="(d, i) in DOW_LABELS" :key="i" :value="i">{{ d }}</option>
            </select>
            <input
              :value="t.time_of_day" type="time" style="width: 110px"
              @change="updateField(t, { time_of_day: $event.target.value })"
            />
            <select
              :value="t.fixed_assignee_employee_id || ''" title="Fixed assignee — wins over rotation when set"
              @change="onFixedAssigneeChange(t, $event.target.value)"
            >
              <option value="">No pin — rotation / default assignee</option>
              <option v-for="e in activeEmployees" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
            <span v-if="t.fixed_assignee_employee_id" class="muted small">
              fixed: {{ t.fixed_assignee_name }}
            </span>
            <span v-else class="muted small">next up: {{ t.rotation_last_employee_name || '—' }}</span>
            <span class="muted small">last: {{ fmtLastGenerated(t) }}</span>
            <span :class="['pill', t.active ? 'green' : 'slate']">{{ t.active ? 'Active' : 'Paused' }}</span>
            <div class="spacer" />
            <button class="small" @click="updateField(t, { active: !t.active })">
              {{ t.active ? 'Pause' : 'Resume' }}
            </button>
            <button class="small" title="Delete" @click="removeTemplate(t)">✕</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
