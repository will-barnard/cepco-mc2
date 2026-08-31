<script setup>
/**
 * Ceppys — a fictional, purely-for-fun staff-recognition award. Any tech
 * can nominate any other tech (including themselves) with a short reason;
 * nominations stay invisible to everyone but their own nominator until the
 * weekly digest email fires (schedule or an admin's manual "Send now"),
 * at which point they move to the Past nominations tab for everyone to
 * see. See backend/src/routes/ceppys.js and migration 017 for the full
 * mechanics — this view is just three tabs plus an admin-only config panel
 * over that API.
 *
 * The schedule itself isn't a bespoke endpoint — it's an ordinary
 * shop_config settings row (key 'ceppys_schedule'), edited through the
 * same generic PATCH /settings/:id SettingsView.vue already uses for the
 * labor rate. useSettings already loads it as part of the normal settings
 * fetch, so the config panel here just finds that one row and patches it.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';
import { useAuth, useSettings, useRefData } from '../stores';

const auth = useAuth();
const settings = useSettings();
const refData = useRefData();

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const tab = ref('nominate');
const error = ref('');

// --- nominate ----------------------------------------------------------
// C1: award category — a Settings-driven picker (ceppy_category) plus the
// same free-text "Other…" escape hatch PartsView.vue uses for vendors
// (OTHER_VENDOR there, OTHER_CATEGORY here) for a one-off award category
// the shop hasn't added to Settings yet.
const OTHER_CATEGORY = '__other__';
const form = ref({
  nominee_id: '', title: '', reason: '', category_key: '', category_other: '',
});
const submitting = ref(false);
const submitted = ref(false);

async function submitNomination() {
  error.value = '';
  submitted.value = false;
  if (!form.value.nominee_id) { error.value = 'Pick who you’re nominating.'; return; }
  if (!form.value.title.trim()) { error.value = 'Give this Ceppy a title.'; return; }
  if (!form.value.reason.trim()) { error.value = 'Add a quick reason for the nomination.'; return; }
  const usingOther = form.value.category_key === OTHER_CATEGORY;
  if (!form.value.category_key) { error.value = 'Pick an award category.'; return; }
  if (usingOther && !form.value.category_other.trim()) { error.value = 'Name the award category.'; return; }
  submitting.value = true;
  try {
    await api.post('/ceppys/nominations', {
      nominee_id: Number(form.value.nominee_id),
      title: form.value.title.trim(),
      reason: form.value.reason.trim(),
      category_key: usingOther ? null : form.value.category_key,
      category_other: usingOther ? form.value.category_other.trim() : null,
    });
    form.value = {
      nominee_id: '', title: '', reason: '', category_key: '', category_other: '',
    };
    submitted.value = true;
    await loadMine();
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}

// --- my (pending) nominations -------------------------------------------
const mine = ref([]);
const loadingMine = ref(false);
async function loadMine() {
  loadingMine.value = true;
  try {
    mine.value = await api.get('/ceppys/nominations/mine');
  } finally {
    loadingMine.value = false;
  }
}

// --- past nominations, grouped by which digest they went out in --------
const past = ref([]);
const loadingPast = ref(false);
async function loadPast() {
  loadingPast.value = true;
  try {
    past.value = await api.get('/ceppys/nominations/past');
  } finally {
    loadingPast.value = false;
  }
}
const pastBatches = computed(() => {
  const groups = [];
  const byTimestamp = new Map();
  for (const n of past.value) {
    if (!byTimestamp.has(n.emailed_at)) {
      const group = { emailed_at: n.emailed_at, nominations: [] };
      byTimestamp.set(n.emailed_at, group);
      groups.push(group);
    }
    byTimestamp.get(n.emailed_at).nominations.push(n);
  }
  return groups; // already newest-first — the API orders by emailed_at DESC
});

function switchTab(next) {
  tab.value = next;
  if (next === 'mine' && !mine.value.length) loadMine();
  if (next === 'past' && !past.value.length) loadPast();
}

// --- admin config panel ---------------------------------------------------
const showConfig = ref(false);
const scheduleRow = computed(() => (settings.data.shop_config || []).find((r) => r.key === 'ceppys_schedule'));
const scheduleDraft = ref({
  enabled: false, day_of_week: 5, time: '15:00',
});
const savingSchedule = ref(false);
const scheduleNotice = ref('');
const sendingNow = ref(false);
const sendNowResult = ref(null);

function openConfig() {
  if (scheduleRow.value) {
    scheduleDraft.value = {
      enabled: !!scheduleRow.value.meta.enabled,
      day_of_week: scheduleRow.value.meta.day_of_week ?? 5,
      time: scheduleRow.value.meta.time || '15:00',
    };
  }
  scheduleNotice.value = '';
  sendNowResult.value = null;
  showConfig.value = true;
}

async function saveSchedule() {
  if (!scheduleRow.value) return;
  error.value = '';
  scheduleNotice.value = '';
  savingSchedule.value = true;
  try {
    await api.patch(`/settings/${scheduleRow.value.id}`, {
      meta: {
        ...scheduleRow.value.meta,
        enabled: scheduleDraft.value.enabled,
        day_of_week: Number(scheduleDraft.value.day_of_week),
        time: scheduleDraft.value.time,
      },
    });
    await settings.load(true);
    scheduleNotice.value = 'Schedule saved.';
  } catch (err) {
    error.value = err.message;
  } finally {
    savingSchedule.value = false;
  }
}

async function sendNow() {
  if (!confirm('Send the Ceppys digest to all staff right now with whatever nominations are pending?')) return;
  error.value = '';
  sendNowResult.value = null;
  sendingNow.value = true;
  try {
    const result = await api.post('/ceppys/send-now');
    sendNowResult.value = result;
    await settings.load(true); // picks up the new last_sent_at
    if (tab.value === 'mine') loadMine();
    if (tab.value === 'past') loadPast();
  } catch (err) {
    error.value = err.message;
  } finally {
    sendingNow.value = false;
  }
}

const when = (ts) => new Date(ts).toLocaleString();

onMounted(async () => {
  await Promise.all([settings.load(), refData.load()]);
  await loadMine();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Ceppys</h1>
        <p class="muted small" style="margin: 0">
          Nominate a teammate any time —
          nominations stay private until the next digest email.
        </p>
      </div>
      <button v-if="auth.isAdmin" class="small" @click="showConfig ? (showConfig = false) : openConfig()">
        {{ showConfig ? 'Close' : 'Configure Ceppys' }}
      </button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div v-if="showConfig && auth.isAdmin" class="card" style="margin-bottom: 16px">
      <h2>Weekly digest schedule</h2>
      <p class="muted small">
        When enabled, the digest fires automatically on this day and time (shop-local) with
        whatever nominations are pending since the last one. "Send now" works regardless of
        this toggle.
      </p>
      <div class="field-row">
        <div class="field">
          <label class="checkbox" style="margin-top: 22px">
            <input v-model="scheduleDraft.enabled" type="checkbox" />
            <span>Send automatically</span>
          </label>
        </div>
        <div class="field">
          <label>Day of week</label>
          <select v-model="scheduleDraft.day_of_week">
            <option v-for="(label, i) in DAY_LABELS" :key="i" :value="i">{{ label }}</option>
          </select>
        </div>
        <div class="field">
          <label>Time</label>
          <input v-model="scheduleDraft.time" type="time" />
        </div>
        <div class="field" style="flex: none">
          <label>&nbsp;</label>
          <button class="primary" :disabled="savingSchedule" @click="saveSchedule">
            {{ savingSchedule ? 'Saving…' : 'Save schedule' }}
          </button>
        </div>
      </div>
      <p v-if="scheduleNotice" class="small" style="color: #4ade80; margin: 8px 0 0">{{ scheduleNotice }}</p>
      <p v-if="scheduleRow?.meta?.last_sent_at" class="muted small" style="margin: 8px 0 0">
        Last digest sent {{ when(scheduleRow.meta.last_sent_at) }}.
      </p>

      <div class="row" style="margin-top: 16px; align-items: center">
        <button class="small" :disabled="sendingNow" @click="sendNow">
          {{ sendingNow ? 'Sending…' : 'Send digest now' }}
        </button>
        <span v-if="sendNowResult" class="muted small">
          Sent to {{ sendNowResult.sent }}/{{ sendNowResult.recipients }} staff —
          {{ sendNowResult.nominations_included }} nomination(s) included.
          <span v-if="sendNowResult.failed"> ({{ sendNowResult.failed }} delivery failure(s))</span>
        </span>
      </div>
    </div>

    <div class="row" style="margin-bottom: 16px; gap: 8px">
      <button :class="['small', { primary: tab === 'nominate' }]" @click="switchTab('nominate')">
        Nominate
      </button>
      <button :class="['small', { primary: tab === 'mine' }]" @click="switchTab('mine')">
        My nominations{{ mine.length ? ` (${mine.length})` : '' }}
      </button>
      <button :class="['small', { primary: tab === 'past' }]" @click="switchTab('past')">
        Past nominations
      </button>
    </div>

    <div v-if="tab === 'nominate'" class="card" style="max-width: 560px">
      <div class="field">
        <label>Who are you nominating?</label>
        <select v-model="form.nominee_id">
          <option value="" disabled>— choose a teammate —</option>
          <option v-for="e in refData.employees.filter((emp) => emp.active)" :key="e.id" :value="e.id">
            {{ e.name }}{{ e.id === auth.user.id ? ' (me)' : '' }}
          </option>
        </select>
      </div>
      <div class="field">
        <label>Award category</label>
        <select v-model="form.category_key">
          <option value="" disabled>— choose a category —</option>
          <option v-for="c in settings.active('ceppy_category')" :key="c.key" :value="c.key">
            {{ c.label }}
          </option>
          <option :value="OTHER_CATEGORY">Other…</option>
        </select>
      </div>
      <div v-if="form.category_key === OTHER_CATEGORY" class="field">
        <label>Category name *</label>
        <input v-model="form.category_other" placeholder="e.g. Cleanest Bench" />
      </div>
      <div class="field">
        <label>Ceppy title</label>
        <input v-model="form.title" type="text"
          placeholder="e.g. Technical Ceppy for Innovation of the Laser Level" />
      </div>
      <div class="field">
        <label>Why do they deserve a Ceppy?</label>
        <textarea v-model="form.reason" style="min-height: 90px" placeholder="What did they do?" />
      </div>
      <button class="primary" :disabled="submitting" @click="submitNomination">
        {{ submitting ? 'Submitting…' : 'Submit nomination' }}
      </button>
      <p v-if="submitted" class="small" style="color: #4ade80; margin: 10px 0 0">
        Nomination submitted — it'll go out in the next Ceppys digest.
      </p>
    </div>

    <div v-else-if="tab === 'mine'">
      <div v-if="loadingMine" class="empty">Loading…</div>
      <div v-else-if="!mine.length" class="empty">
        No pending nominations — anything you submit shows up here until the next digest.
      </div>
      <div v-else class="stack">
        <div v-for="n in mine" :key="n.id" class="card tight">
          <div class="muted small" style="text-transform: uppercase; letter-spacing: .02em; margin-bottom: 2px">
            {{ n.title }}
          </div>
          <strong>{{ n.nominee_name }}</strong>
          <span class="tag" style="margin-left: 6px">{{ n.category_label_snapshot || n.category_other }}</span>
          <div class="muted small" style="margin: 4px 0">Submitted {{ when(n.created_at) }}</div>
          <p style="margin: 0">{{ n.reason }}</p>
        </div>
      </div>
    </div>

    <div v-else-if="tab === 'past'">
      <div v-if="loadingPast" class="empty">Loading…</div>
      <div v-else-if="!pastBatches.length" class="empty">No Ceppys digest has gone out yet.</div>
      <div v-else class="stack">
        <div v-for="batch in pastBatches" :key="batch.emailed_at" class="card">
          <h2 style="margin-bottom: 12px">{{ when(batch.emailed_at) }}</h2>
          <ul class="timeline">
            <li v-for="n in batch.nominations" :key="n.id">
              <div class="muted small" style="text-transform: uppercase; letter-spacing: .02em; margin-bottom: 2px">
                {{ n.title }}
              </div>
              <strong>{{ n.nominee_name }}</strong>
              <span class="tag" style="margin-left: 6px">{{ n.category_label_snapshot || n.category_other }}</span>
              <span class="muted small"> — nominated by {{ n.nominator_name }}</span>
              <div class="small" style="margin-top: 4px">{{ n.reason }}</div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
