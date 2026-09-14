<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useAuth, useSettings } from '../stores';
import TicketTable from '../components/TicketTable.vue';
import PartsOrdersPanel from '../components/PartsOrdersPanel.vue';

const auth = useAuth();
const settings = useSettings();

const summary = ref(null);
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

// "In-Progress Tickets" and "Unassigned" both paginate independently —
// neither list is capped at a fixed size anymore (they used to just
// silently drop anything past 15/10), backed by GET /tickets' offset
// support and the X-Total-Count header api.js exposes as .totalCount (see
// routes/tickets.js and api.js). Page size kept at the old "Assigned to
// me" limit so the common case (few enough tickets to fit on one page)
// looks exactly like it used to.
const MINE_PAGE_SIZE = 15;
const UNASSIGNED_PAGE_SIZE = 10;

const minePage = ref(1);
const mineTotal = ref(0);
const unassignedPage = ref(1);
const unassignedTotal = ref(0);

const minePageCount = computed(() => Math.max(1, Math.ceil(mineTotal.value / MINE_PAGE_SIZE)));
const unassignedPageCount = computed(() => Math.max(1, Math.ceil(unassignedTotal.value / UNASSIGNED_PAGE_SIZE)));

// "Priority & To-Do's" (replaces the old "My tasks"/"Priority tasks" pair,
// per the boss's dashboard-layout note) -- shop-wide by default, not
// personal: the daily to-do's (category 'daily_todo', which already
// auto-archives itself at end of day -- see recurringTickets.js -- so
// "open" here already means "today's"), plus tickets sitting at whichever
// priority tier(s) Settings -> Priority tiers has flagged "Highlight in
// tasks" (stores.js's highlightTasksForPriority meta -- expedited_sos by
// default, admin-addable). Both are ticket-level lists now, not
// individual ticket_tasks rows -- the per-task checklist (and its
// checkbox-to-mark-done) that used to live here is gone with "My tasks";
// checking off a task still happens on the ticket page itself.
//
// Settings -> Staff accounts' "Priority & To-Do's: mine only" checkbox
// (employees.dashboard_priority_personal_only, migration 059) narrows
// both queries to just this person's own tickets for whoever an admin has
// opted in -- off (shop-wide) by default, same admin-sets-it-for-anyone
// shape as show_parts_on_dashboard.
const dailyTodoTickets = ref([]);
const priorityTickets = ref([]);

const flaggedPriorityKeys = computed(() => (settings.data.priority_tier || [])
  .filter((r) => r.meta?.highlight_in_tasks)
  .map((r) => r.key));

async function loadPriorityAndTodos() {
  const mineOnly = !!auth.user.dashboard_priority_personal_only;
  const scope = mineOnly ? { technician_id: auth.user.id } : {};
  const [dailyTodos, flagged] = await Promise.all([
    api.get('/tickets', { category: 'daily_todo', ...scope }),
    flaggedPriorityKeys.value.length
      ? api.get('/tickets', { priority: flaggedPriorityKeys.value.join(','), ...scope })
      : Promise.resolve([]),
  ]);
  // A finished job (status meta.terminal, e.g. 'done') is done, not
  // outstanding -- exclude it even though nothing ever archived it.
  dailyTodoTickets.value = dailyTodos.filter((t) => !settings.isTerminalStatus(t.status_key));
  const seen = new Set(dailyTodoTickets.value.map((t) => t.id));
  priorityTickets.value = flagged.filter((t) => {
    if (seen.has(t.id) || settings.isTerminalStatus(t.status_key)) return false;
    seen.add(t.id);
    return true;
  });
}

// "In-Progress Tickets" (replaces "Assigned to me") -- yours, not
// shop-wide: defaults to just what you're actually working (In Progress +
// QC) -- everything else assigned to you is either not started yet or
// already past QC, neither of which needs to occupy this list every day.
// mineShowAll flips it back to everything assigned to you regardless of
// status. routes/tickets.js's `status` filter accepts a comma-separated
// list (ANY($n)) for exactly this. QC is pulled visually to the top via
// TicketTable's highlightStatus prop -- riding the existing technician-
// scoped queue order (st.sort_order DESC, same convention every other
// queue view in this app already uses) rather than forcing it independent
// of Settings -> Ticket statuses, since unlike the shop-wide overview this
// replaced, a paginated per-tech list can't cheaply concatenate two
// separately-fetched, independently-paginated result sets.
const mineShowAll = ref(false);

async function loadMine() {
  const rows = await api.get('/tickets', {
    technician_id: auth.user.id,
    ...(mineShowAll.value ? {} : { status: 'in_progress,qc' }),
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
// Toggling the filter changes what "page 1" even means, so reset there
// rather than keeping whatever page the filtered list happened to be on.
watch(mineShowAll, () => {
  minePage.value = 1;
  loadMine();
});

onMounted(async () => {
  await Promise.all([
    api.get('/tickets/summary').then((s) => { summary.value = s; }),
    loadPriorityAndTodos(),
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
      <div class="row nowrap">
        <!-- Consolidated: New ticket/New task/Parts & Supplies are one
             tabbed page now (NewView.vue) -- see NOTES.md. -->
        <RouterLink to="/new" class="btn primary">+ New…</RouterLink>
      </div>
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

      <div
        v-if="dailyTodoTickets.length || priorityTickets.length" class="card"
        style="margin-bottom: 24px; border-color: var(--red)"
      >
        <h2>Priority &amp; To-Do's</h2>
        <p class="muted small" style="margin: 0 0 10px">
          <template v-if="auth.user.dashboard_priority_personal_only">
            Just yours — today's Daily To-Do's, plus anything of yours at a priority level
            flagged to stand out (Settings → Priority tiers).
          </template>
          <template v-else>
            Shop-wide, not just yours — today's Daily To-Do's, plus anything at a priority level
            flagged to stand out (Settings → Priority tiers).
          </template>
        </p>
        <template v-if="dailyTodoTickets.length">
          <p class="muted small" style="margin: 0 0 10px"><strong>Daily To-Do's</strong></p>
          <ul class="checklist">
            <li v-for="t in dailyTodoTickets" :key="t.id">
              <div style="flex: 1; min-width: 0">
                <RouterLink :to="{ name: 'ticket', params: { id: t.id } }">{{ t.title }}</RouterLink>
                <div class="muted small">
                  <span :class="['pill', settings.colorFor(t.status_key)]">
                    {{ t.status_label || t.status_label_snapshot }}
                  </span>
                  <template v-if="t.technicians?.length">
                    · {{ t.technicians.map((x) => x.name).join(', ') }}
                  </template>
                </div>
              </div>
            </li>
          </ul>
        </template>
        <template v-if="priorityTickets.length">
          <p class="muted small" style="margin: 14px 0 10px"><strong>Priority</strong></p>
          <ul class="checklist">
            <li v-for="t in priorityTickets" :key="t.id">
              <div style="flex: 1; min-width: 0">
                <RouterLink :to="{ name: 'ticket', params: { id: t.id } }">{{ t.title }}</RouterLink>
                <div class="muted small">
                  {{ t.category_label || t.category_label_snapshot }} · {{ t.priority_label || t.priority_label_snapshot }}
                  <span :class="['pill', settings.colorFor(t.status_key)]" style="margin-left: 4px">
                    {{ t.status_label || t.status_label_snapshot }}
                  </span>
                </div>
              </div>
            </li>
          </ul>
        </template>
      </div>

      <!-- Settings -> Staff accounts' "Parts on dashboard" checkbox
           (employees.show_parts_on_dashboard, migration 058) -- view and
           status-change only, same PartsOrdersPanel.vue the "+ New" page's
           Parts/Supplies tab uses, just with allow-create off. Creating a
           new order only ever happens from that tab. -->
      <div v-if="auth.user.show_parts_on_dashboard" class="card" style="margin-bottom: 24px">
        <div class="row" style="margin-bottom: 12px">
          <h2 style="margin: 0">Parts / Supplies</h2>
          <div class="spacer" />
          <RouterLink to="/new?tab=parts" class="small">Add an order →</RouterLink>
        </div>
        <PartsOrdersPanel :allow-create="false" />
      </div>

      <div class="card" style="margin-bottom: 24px">
        <div class="row" style="margin-bottom: 12px">
          <h2 style="margin: 0">In-Progress Tickets</h2>
          <div class="spacer" />
          <button class="small" @click="mineShowAll = !mineShowAll">
            {{ mineShowAll ? 'Show in-progress & QC only' : 'Show all' }}
          </button>
        </div>
        <p class="muted small" style="margin: 0 0 10px">
          <template v-if="mineShowAll">Everything assigned to you.</template>
          <template v-else>
            Assigned to you, In Progress or in QC — QC pulled to the top and highlighted.
          </template>
        </p>
        <TicketTable
          :tickets="myTickets" group-by-status highlight-status="qc"
          empty-text="Nothing assigned to you right now."
        />
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
