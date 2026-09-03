<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useAuth, useSettings } from '../stores';
import TicketTable from '../components/TicketTable.vue';

const auth = useAuth();
const settings = useSettings();

const summary = ref(null);
const myTasks = ref([]);
const myPriorityTicketsRaw = ref([]);
const myTickets = ref([]);
const unassigned = ref([]);
const departing = ref([]);
const loading = ref(true);

// Same shop-local "today" the rental calendar and the /rentals/departing
// query use — see NOTES.md §2.13.
const shopToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

function daysUntil(dateStr) {
  const asLocal = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  return Math.round((asLocal(dateStr) - asLocal(shopToday)) / 86400000);
}
function departureLabel(dateStr) {
  const n = daysUntil(dateStr);
  if (n <= 0) return 'Leaves today';
  if (n === 1) return 'Leaves tomorrow';
  return `Leaves in ${n} days`;
}

// "Assigned to me" and "Unassigned" both paginate independently — neither
// list is capped at a fixed size anymore (they used to just silently drop
// anything past 15/10), backed by GET /tickets' offset support and the
// X-Total-Count header api.js exposes as .totalCount (see routes/tickets.js
// and api.js). Page size kept at the old limits so the common case (few
// enough tickets to fit on one page) looks exactly like it used to.
const MINE_PAGE_SIZE = 15;
const UNASSIGNED_PAGE_SIZE = 10;

const minePage = ref(1);
const mineTotal = ref(0);
const unassignedPage = ref(1);
const unassignedTotal = ref(0);

const minePageCount = computed(() => Math.max(1, Math.ceil(mineTotal.value / MINE_PAGE_SIZE)));
const unassignedPageCount = computed(() => Math.max(1, Math.ceil(unassignedTotal.value / UNASSIGNED_PAGE_SIZE)));

// "My tasks" (NOTES.md §2.28) intentionally isn't paginated like the two
// ticket lists below it — tasks are meant to be short-lived and few at a
// time (a handful of open, assigned, unlocked tasks), not a long-running
// backlog someone pages through.
async function loadMyTasks() {
  myTasks.value = await api.get('/tasks', {
    technician_id: auth.user.id, unlocked_only: 'true', done: 'false',
  });
}

// Settings -> Priority tiers' "Highlight in tasks" toggle (see stores.js's
// highlightTasksForPriority) splits one flat list into two boxes rather
// than just re-sorting it — a priority already sorts to the top via
// sort_order, so a separate box is the actual ask here: visually pull it
// out, not just rank it first among everything else.
const priorityTasks = computed(
  () => myTasks.value.filter((t) => settings.highlightTasksForPriority(t.priority_key)),
);
const regularTasks = computed(
  () => myTasks.value.filter((t) => !settings.highlightTasksForPriority(t.priority_key)),
);

// "Priority tickets" — a flagged priority tier is meant to make a ticket
// impossible to miss even when nobody's added it any tasks yet (e.g. a
// shipping ticket before this same change started auto-creating one — see
// routes/tickets.js). priorityTasks above only ever surfaces *tasks*, so a
// ticket with zero ticket_tasks rows never showed up there no matter how
// urgent it was. This pulls in the raw tickets themselves — assigned to
// me, sitting in a status that unlocks tasks (same gate as the tasks
// list, so this only surfaces tickets actively being worked, not every
// high-priority ticket regardless of progress), at a flagged priority
// tier — and excludes any ticket already represented by a row in
// priorityTasks above, so an urgent ticket that *does* have tasks doesn't
// show up twice in the same card.
async function loadMyPriorityTickets() {
  myPriorityTicketsRaw.value = await api.get('/tickets', { technician_id: auth.user.id });
}
const priorityTaskTicketIds = computed(() => new Set(priorityTasks.value.map((t) => t.ticket_id)));
const priorityTickets = computed(
  () => myPriorityTicketsRaw.value.filter((t) => settings.highlightTasksForPriority(t.priority_key)
    && settings.unlocksTasks(t.status_key)
    && !priorityTaskTicketIds.value.has(t.id)),
);

async function toggleMyTask(task) {
  await api.patch(`/tasks/${task.id}`, { done: !task.done });
  await loadMyTasks();
}

async function loadMine() {
  const rows = await api.get('/tickets', {
    technician_id: auth.user.id,
    limit: MINE_PAGE_SIZE,
    offset: (minePage.value - 1) * MINE_PAGE_SIZE,
  });
  myTickets.value = rows;
  mineTotal.value = rows.totalCount ?? rows.length;
}

async function loadUnassigned() {
  const rows = await api.get('/tickets', {
    technician_id: 'unassigned',
    limit: UNASSIGNED_PAGE_SIZE,
    offset: (unassignedPage.value - 1) * UNASSIGNED_PAGE_SIZE,
  });
  unassigned.value = rows;
  unassignedTotal.value = rows.totalCount ?? rows.length;
}

// Re-fetch (not client-side re-slice) on page change — each page is its own
// GET /tickets call, same pattern as everywhere else in the app that reads
// from the server rather than holding a full unpaginated list in memory.
watch(minePage, loadMine);
watch(unassignedPage, loadUnassigned);

onMounted(async () => {
  await Promise.all([
    api.get('/tickets/summary').then((s) => { summary.value = s; }),
    loadMyTasks(),
    loadMyPriorityTickets(),
    loadMine(),
    loadUnassigned(),
    // Fleet departures are an admin-only headline (§ per NOTES.md) — skip
    // the request entirely for everyone else.
    auth.isAdmin ? api.get('/rentals/departing', { within_days: 7 }).then((r) => { departing.value = r; }) : null,
  ]);
  loading.value = false;
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>Shop overview</h1>
      <RouterLink to="/tickets/new" class="btn primary">New ticket</RouterLink>
    </div>

    <div v-if="loading" class="empty">Loading…</div>

    <template v-else>
      <div
        v-if="auth.isAdmin && departing.length" class="card"
        style="margin-bottom: 24px; border-color: var(--amber)"
      >
        <h2>Fleet departing soon</h2>
        <ul class="timeline">
          <li v-for="r in departing" :key="r.id">
            <strong>
              {{ r.instrument_family }}<template v-if="r.instrument_model"> {{ r.instrument_model }}</template>
            </strong>
            <span :class="['pill', daysUntil(r.start_date) <= 1 ? 'red' : 'amber']" style="margin-left: 8px">
              {{ departureLabel(r.start_date) }}
            </span>
            <div v-if="r.renter" class="muted small">{{ r.renter }}</div>
          </li>
        </ul>
        <RouterLink :to="{ name: 'fleet-calendar' }" class="small">View rental calendar →</RouterLink>
      </div>

      <div class="grid cols-3" style="margin-bottom: 24px">
        <div class="card stat">
          <div class="value">{{ summary.totals.open_tickets }}</div>
          <div class="label">Open tickets</div>
        </div>
        <div class="card stat">
          <div class="value">{{ Number(summary.totals.hours_this_week).toFixed(1) }}</div>
          <div class="label">Hours logged this week</div>
        </div>
        <div class="card stat">
          <div class="value">{{ summary.totals.unassigned }}</div>
          <div class="label">Unassigned</div>
        </div>
      </div>

      <div class="card" style="margin-bottom: 24px">
        <h2>By status</h2>
        <div class="row">
          <RouterLink
            v-for="s in summary.by_status" :key="s.key"
            :to="{ name: 'queue', query: { status: s.key } }"
            class="btn small"
          >
            <span :class="['pill', settings.colorFor(s.key)]">{{ s.label }}</span>
            <strong style="margin-left: 8px">{{ s.count }}</strong>
          </RouterLink>
        </div>
      </div>

      <div class="card" style="margin-bottom: 24px">
        <h2>My tasks</h2>
        <p class="muted small" style="margin: 0 0 10px">
          Short-lived work items from your tickets, ranked by that ticket's priority.
        </p>
        <ul v-if="regularTasks.length" class="checklist">
          <li v-for="t in regularTasks" :key="t.id">
            <input type="checkbox" :checked="t.done" @change="toggleMyTask(t)" />
            <div style="flex: 1; min-width: 0">
              <RouterLink :to="{ name: 'ticket', params: { id: t.ticket_id } }">{{ t.title }}</RouterLink>
              <div class="muted small">{{ t.ticket_title }} · {{ t.priority_label }}</div>
            </div>
          </li>
        </ul>
        <div v-else class="empty">No open tasks right now.</div>
      </div>

      <div
        v-if="priorityTasks.length || priorityTickets.length" class="card"
        style="margin-bottom: 24px; border-color: var(--red)"
      >
        <h2>Priority tasks</h2>
        <p class="muted small" style="margin: 0 0 10px">
          From tickets at a priority level flagged to stand out — see Settings → Priority tiers.
        </p>
        <ul v-if="priorityTasks.length" class="checklist">
          <li v-for="t in priorityTasks" :key="t.id">
            <input type="checkbox" :checked="t.done" @change="toggleMyTask(t)" />
            <div style="flex: 1; min-width: 0">
              <RouterLink :to="{ name: 'ticket', params: { id: t.ticket_id } }">{{ t.title }}</RouterLink>
              <div class="muted small">{{ t.ticket_title }} · {{ t.priority_label }}</div>
            </div>
          </li>
        </ul>
        <template v-if="priorityTickets.length">
          <p class="muted small" style="margin: 14px 0 10px">
            Tickets at this priority with no tasks of their own yet.
          </p>
          <ul class="checklist">
            <li v-for="t in priorityTickets" :key="t.id">
              <div style="flex: 1; min-width: 0">
                <RouterLink :to="{ name: 'ticket', params: { id: t.id } }">{{ t.title }}</RouterLink>
                <div class="muted small">{{ t.category_label }} · {{ t.priority_label }}</div>
              </div>
            </li>
          </ul>
        </template>
      </div>

      <div class="card" style="margin-bottom: 24px">
        <h2>Assigned to me</h2>
        <TicketTable :tickets="myTickets" group-by-status empty-text="Nothing assigned to you right now." />
        <div v-if="mineTotal > MINE_PAGE_SIZE" class="row" style="align-items: center; margin-top: 10px">
          <button class="small" :disabled="minePage <= 1" @click="minePage -= 1">‹ Prev</button>
          <span class="muted small">Page {{ minePage }} of {{ minePageCount }} · {{ mineTotal }} ticket(s)</span>
          <button class="small" :disabled="minePage >= minePageCount" @click="minePage += 1">Next ›</button>
        </div>
      </div>

      <div class="card">
        <h2>Unassigned</h2>
        <TicketTable :tickets="unassigned" group-by-status empty-text="Every ticket has a tech." />
        <div v-if="unassignedTotal > UNASSIGNED_PAGE_SIZE" class="row" style="align-items: center; margin-top: 10px">
          <button class="small" :disabled="unassignedPage <= 1" @click="unassignedPage -= 1">‹ Prev</button>
          <span class="muted small">
            Page {{ unassignedPage }} of {{ unassignedPageCount }} · {{ unassignedTotal }} ticket(s)
          </span>
          <button class="small" :disabled="unassignedPage >= unassignedPageCount" @click="unassignedPage += 1">
            Next ›
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
