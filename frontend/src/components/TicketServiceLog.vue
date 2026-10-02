<script setup>
/**
 * Service Log (shop feedback, Oct 2026; migration 064) — replaced the
 * ticket's "Service done" free-text box. Each entry is what was done plus
 * the hours it took, who did it, and when.
 *
 * It's hours_log under the hood (same table TicketHours.vue / the Hours
 * timesheet read), not a parallel table, so time is never counted twice:
 *   - checking a task off adds its entry automatically (routes/tasks.js),
 *     and the hours typed on the task land on that same entry — editing
 *     the hours here changes the task's number too;
 *   - unchecking the task takes its entry back out, which is why a task's
 *     entry can't be deleted from here (DELETE /hours/:id refuses);
 *   - work that wasn't a task gets added by hand below.
 * Hours are optional on an entry — a completed task registers before
 * anyone has typed a number.
 *
 * Whatever was in the old "Service done" box (tickets.service_done_notes)
 * is shown read-only at the bottom so it isn't lost.
 */
import { ref, computed } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const auth = useAuth();
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local

const error = ref('');
const busy = ref(false);
const form = ref({ task_description: '', hours: '', worked_on: today() });
const editingId = ref(null);
const draft = ref({ task_description: '', hours: '', worked_on: '' });

const entries = computed(() => props.ticket.hours_log || []);
const total = computed(() => entries.value.reduce((sum, e) => sum + Number(e.hours || 0), 0));
const canEdit = (e) => auth.isAdmin || e.employee_id === auth.user?.id;

// worked_on arrives as a bare 'YYYY-MM-DD' (db.js's DATE parser) -- built
// as a *local* date, since new Date('YYYY-MM-DD') would be UTC midnight
// and show as the day before in Central time.
function fmtDate(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}
const fmtHours = (h) => (h == null || h === '' ? '—' : Number(h).toFixed(2).replace(/\.?0+$/, ''));

async function add() {
  error.value = '';
  if (!form.value.task_description.trim() && form.value.hours === '') {
    error.value = 'Describe the work, log hours, or both.';
    return;
  }
  busy.value = true;
  try {
    await api.post('/hours', {
      ticket_id: props.ticket.id,
      task_description: form.value.task_description.trim() || null,
      hours: form.value.hours === '' ? null : Number(form.value.hours),
      worked_on: form.value.worked_on || null,
    });
    form.value = { task_description: '', hours: '', worked_on: today() };
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

function startEdit(e) {
  error.value = '';
  editingId.value = e.id;
  draft.value = {
    task_description: e.task_description || '',
    hours: e.hours == null ? '' : Number(e.hours),
    worked_on: String(e.worked_on || '').slice(0, 10),
  };
}

async function saveEdit(e) {
  error.value = '';
  busy.value = true;
  try {
    await api.patch(`/hours/${e.id}`, {
      task_description: draft.value.task_description,
      hours: draft.value.hours === '' ? null : Number(draft.value.hours),
      worked_on: draft.value.worked_on || null,
    });
    editingId.value = null;
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function remove(e) {
  if (!confirm('Delete this service log entry?')) return;
  error.value = '';
  try {
    await api.del(`/hours/${e.id}`);
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Service Log</h2>
      <div class="spacer" />
      <span class="muted small">{{ fmtHours(total) === '—' ? 0 : fmtHours(total) }} hrs total</span>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <p v-if="!entries.length" class="muted small" style="margin: 0 0 12px">
      Nothing logged yet. Completed tasks show up here automatically.
    </p>
    <div v-else class="table-wrap" style="margin-bottom: 14px">
      <table class="service-log">
        <thead>
          <tr>
            <th class="nowrap">Date</th><th>Service</th><th>By</th><th class="right">Hrs</th><th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in entries" :key="e.id">
            <template v-if="editingId === e.id">
              <td><input v-model="draft.worked_on" type="date" /></td>
              <td><input v-model="draft.task_description" maxlength="2000" /></td>
              <td class="small">{{ e.employee_name }}</td>
              <td>
                <input v-model="draft.hours" type="number" min="0" max="24" step="0.25" style="max-width: 80px" />
              </td>
              <td class="right nowrap">
                <button class="small primary" :disabled="busy" @click="saveEdit(e)">Save</button>
                <button class="small" @click="editingId = null">Cancel</button>
              </td>
            </template>
            <template v-else>
              <td class="nowrap small">{{ fmtDate(e.worked_on) }}</td>
              <td>
                {{ e.task_description || '—' }}
                <span v-if="e.ticket_task_id" class="tag" style="margin-left: 6px" title="Logged by completing a task">task</span>
              </td>
              <td class="small">{{ e.employee_name }}</td>
              <td class="right nowrap" :class="{ muted: e.hours == null }">{{ fmtHours(e.hours) }}</td>
              <td class="right nowrap">
                <template v-if="canEdit(e)">
                  <button class="small" @click="startEdit(e)">Edit</button>
                  <button
                    v-if="!e.ticket_task_id" class="small" title="Delete entry"
                    @click="remove(e)"
                  >×</button>
                </template>
              </td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="row service-log-add" @submit.prevent="add">
      <input
        v-model="form.task_description" class="desc" maxlength="2000"
        placeholder="What was done — e.g. Replaced tines, regulated action"
      />
      <input
        v-model="form.hours" type="number" min="0" max="24" step="0.25" placeholder="hrs"
        style="max-width: 90px"
      />
      <input v-model="form.worked_on" type="date" style="max-width: 160px" />
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Adding…' : 'Add' }}</button>
    </form>

    <div v-if="ticket.service_done_notes" class="field" style="margin: 14px 0 0">
      <label class="small muted">Earlier "Service done" notes</label>
      <p class="small" style="margin: 0; white-space: pre-wrap">{{ ticket.service_done_notes }}</p>
    </div>
  </div>
</template>

<style scoped>
.service-log-add .desc { flex: 1; min-width: 200px; }
</style>
