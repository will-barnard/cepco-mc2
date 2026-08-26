<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

// Local, timezone-safe date helpers. Every value here is either a plain
// 'YYYY-MM-DD' string or a Date built from explicit y/m/d components — never
// round-tripped through `new Date(isoString)`, which parses as UTC and can
// land a date-only value on the wrong calendar day depending on the
// viewer's timezone (see backend/src/db.js and NOTES.md §2.13).
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = parseYMD(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

// The shop's own "today", not the viewer's — matches the dashboard headline
// and the backend's /rentals/departing window.
const shopToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const todayParts = parseYMD(shopToday);
const cursor = ref({ year: todayParts.getFullYear(), month: todayParts.getMonth() });

const rentals = ref([]);
const instruments = ref([]);
const loading = ref(true);
const error = ref('');

const showForm = ref(false);
const form = ref({
  instrument_id: '', start_date: shopToday, end_date: '', renter: '', notes: '',
});
const formError = ref('');
const formBusy = ref(false);

const monthLabel = computed(() => new Date(cursor.value.year, cursor.value.month, 1)
  .toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));

// Always a 6-week grid so the page height doesn't jump between months.
const gridDays = computed(() => {
  const first = new Date(cursor.value.year, cursor.value.month, 1);
  const start = new Date(cursor.value.year, cursor.value.month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { date: d, key: ymd(d), inMonth: d.getMonth() === cursor.value.month };
  });
});

// Expands each rental into one entry per visible day it spans, tagged with
// whether that day is the departure, the return, or a day in between —
// clipped to the visible grid so an open-ended rental doesn't loop forever.
const rentalsByDay = computed(() => {
  const map = {};
  const keys = gridDays.value.map((c) => c.key);
  if (!keys.length) return map;
  const gridStart = keys[0];
  const gridEnd = keys[keys.length - 1];
  rentals.value.forEach((r) => {
    let day = r.start_date < gridStart ? gridStart : r.start_date;
    const last = r.end_date && r.end_date < gridEnd ? r.end_date : gridEnd;
    while (day <= last) {
      const kind = day === r.start_date ? 'start' : (day === r.end_date ? 'end' : 'mid');
      (map[day] = map[day] || []).push({ ...r, kind });
      day = addDays(day, 1);
    }
  });
  return map;
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const keys = gridDays.value.map((c) => c.key);
    rentals.value = await api.get('/rentals', { start: keys[0], end: keys[keys.length - 1] });
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function shiftMonth(delta) {
  const d = new Date(cursor.value.year, cursor.value.month + delta, 1);
  cursor.value = { year: d.getFullYear(), month: d.getMonth() };
}
function goToday() {
  cursor.value = { year: todayParts.getFullYear(), month: todayParts.getMonth() };
}

// Re-fetch whenever the visible month changes (not on the very first mount —
// onMounted below handles that after the instrument list is in).
watch(() => `${cursor.value.year}-${cursor.value.month}`, load);

async function submitForm() {
  formError.value = '';
  formBusy.value = true;
  try {
    await api.post('/rentals', {
      instrument_id: form.value.instrument_id,
      start_date: form.value.start_date,
      end_date: form.value.end_date || null,
      renter: form.value.renter || null,
      notes: form.value.notes || null,
    });
    showForm.value = false;
    form.value = {
      instrument_id: '', start_date: shopToday, end_date: '', renter: '', notes: '',
    };
    await load();
  } catch (err) {
    formError.value = err.message;
  } finally {
    formBusy.value = false;
  }
}

async function cancelRental(entry) {
  const label = `${entry.instrument_family}${entry.instrument_model ? ` ${entry.instrument_model}` : ''}`;
  if (!confirm(`Cancel this rental for ${label}?`)) return;
  error.value = '';
  try {
    await api.del(`/rentals/${entry.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(async () => {
  instruments.value = await api.get('/instruments', { fleet: 'true' });
  await load();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Rental calendar</h1>
        <p class="muted small" style="margin: 0">
          When fleet instruments are out. Click an entry to cancel that rental.
        </p>
      </div>
      <div class="row nowrap">
        <RouterLink :to="{ name: 'fleet' }" class="btn small">Back to fleet</RouterLink>
        <button class="primary small" type="button" @click="showForm = !showForm">
          {{ showForm ? 'Cancel' : '+ Schedule rental' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <form v-if="showForm" class="card" style="margin-bottom: 16px" @submit.prevent="submitForm">
      <div class="field-row">
        <div class="field">
          <label>Instrument *</label>
          <select v-model="form.instrument_id" required>
            <option value="" disabled>Select a fleet instrument</option>
            <option v-for="i in instruments" :key="i.id" :value="i.id">
              {{ i.family }} — {{ i.model || 'no model' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>Going to</label>
          <input v-model="form.renter" placeholder="Live event, customer name…" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Leaves *</label>
          <input v-model="form.start_date" type="date" required />
        </div>
        <div class="field">
          <label>Returns</label>
          <input v-model="form.end_date" type="date" :min="form.start_date" />
        </div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" style="min-height: 60px" />
      </div>

      <div v-if="formError" class="alert" style="margin-bottom: 14px">{{ formError }}</div>

      <button class="primary" type="submit" :disabled="formBusy">
        {{ formBusy ? 'Scheduling…' : 'Schedule rental' }}
      </button>
    </form>

    <div class="card tight">
      <div class="row" style="justify-content: space-between; margin-bottom: 14px">
        <div class="row nowrap">
          <button class="small" type="button" @click="shiftMonth(-1)">‹ Prev</button>
          <button class="small" type="button" @click="goToday">Today</button>
          <button class="small" type="button" @click="shiftMonth(1)">Next ›</button>
        </div>
        <h2 style="margin: 0">{{ monthLabel }}</h2>
        <span style="width: 1px" />
      </div>

      <div v-if="loading" class="empty">Loading…</div>
      <div v-else class="calendar-grid">
        <div v-for="wd in WEEKDAY_LABELS" :key="wd" class="calendar-weekday">{{ wd }}</div>
        <div
          v-for="cell in gridDays" :key="cell.key" class="calendar-day"
          :class="{ 'is-out': !cell.inMonth, 'is-today': cell.key === shopToday }"
        >
          <div class="calendar-day-num">{{ cell.date.getDate() }}</div>
          <button
            v-for="entry in (rentalsByDay[cell.key] || [])" :key="`${entry.id}-${entry.kind}`"
            type="button" class="calendar-pill" :class="`kind-${entry.kind}`"
            :title="[entry.renter, entry.notes].filter(Boolean).join(' — ') || 'Click to cancel this rental'"
            @click="cancelRental(entry)"
          >
            <strong v-if="entry.kind === 'start'">OUT ·</strong>
            <strong v-else-if="entry.kind === 'end'">BACK ·</strong>
            {{ entry.instrument_family }}<template v-if="entry.instrument_model"> {{ entry.instrument_model }}</template>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
