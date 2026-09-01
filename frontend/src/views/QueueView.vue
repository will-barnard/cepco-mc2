<script setup>
/**
 * Queue — the merged tickets list + drag-and-drop reordering page (formerly
 * split across TicketsView.vue and this file; see NOTES.md §2.27). This is
 * now the one place to browse, filter, and reorder tickets: /tickets
 * redirects here (router.js) and the old separate "Tickets" nav link is
 * gone (App.vue).
 *
 * A ticket sits in two kinds of queue — its category's, and its instrument's
 * family (migration 015, e.g. every Rhodes job) — the "Instrument type" /
 * "Category" buttons below pick one of those at a time, same as before the
 * merge. New: "All instruments" (the leftmost button, and the default on
 * load — this page used to default to the first instrument family instead)
 * clears both and shows every ticket, same as the old Tickets page's
 * default view. (A per-technician queue axis existed here too until §2.26
 * dropped it.)
 *
 * Below the buttons is the *entire* filter bar the old Tickets page had —
 * search, status, category, priority, instrument, tech, sort, hide-status,
 * archived — wired to the same `filters` object the buttons themselves
 * write to (a button is just a shortcut for setting filters.instrument_family
 * or filters.category). Filters are mirrored into the URL query, same as
 * the old Tickets page, so a filtered/queued view is still bookmarkable.
 *
 * Drag-to-reorder only makes sense against one *complete, unfiltered* queue
 * — POST /tickets/reorder-queue checks that the dragged status section's
 * full membership matches what the client has, so any filter that could
 * hide a ticket that legitimately belongs in that section (search text,
 * priority, "show archived") has to disable dragging, not just picking
 * "All". `canReorder` below mirrors routes/tickets.js's GET / ORDER BY
 * branch selection: the status filter and "Hide statuses" are fine (they
 * only ever drop *whole* status sections, never part of one), but
 * q/priority/archived aren't, and neither is picking both an instrument
 * and a category, or an explicit "Sort by" override. Whenever canReorder
 * is false, the list below falls back to the plain table the old Tickets
 * page used (status-grouped when the backend is still returning one queue's
 * order, same as `isQueueOrdered` — just not draggable).
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';
import TicketTable from '../components/TicketTable.vue';

const route = useRoute();
const router = useRouter();
const settings = useSettings();
const refData = useRefData();

const filters = ref({
  q: route.query.q || '',
  status: route.query.status || '',
  category: route.query.category || '',
  priority: route.query.priority || '',
  instrument_family: route.query.instrument_family || '',
  technician_id: route.query.technician_id || '',
  archived: route.query.archived === 'true',
  // '' = the usual priority/queue order; 'status' = ordered by each
  // status's own position in the shop's workflow (Settings -> Ticket
  // statuses), i.e. status progression rather than alphabetical.
  sort: route.query.sort || '',
  // "Hide statuses" dropdown below — status keys to exclude, e.g. hiding
  // Done/On Hold while otherwise browsing everything.
  hide_status: (route.query.hide_status || '').split(',').filter(Boolean),
});

const tickets = ref([]);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const dragIndex = ref(null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    tickets.value = await api.get('/tickets', {
      ...filters.value,
      archived: filters.value.archived ? 'true' : '',
      hide_status: filters.value.hide_status.join(','),
    });
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

// Keep filters in the URL so a filtered/queued view can be bookmarked or
// shared — same as the old Tickets page.
watch(filters, (f) => {
  const query = Object.fromEntries(
    Object.entries(f)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])
      .filter(([, v]) => v !== '' && v !== false),
  );
  router.replace({ query });
  load();
}, { deep: true });

function reset() {
  filters.value = {
    q: '', status: '', category: '', priority: '',
    instrument_family: '', technician_id: '', archived: false, sort: '',
    hide_status: [],
  };
}

function toggleHiddenStatus(key, hide) {
  const next = new Set(filters.value.hide_status);
  if (hide) next.add(key); else next.delete(key);
  filters.value.hide_status = [...next];
}

// The "Instrument type"/"Category" buttons and the filter bar's own
// Instrument/Category dropdowns all funnel through these — picking a real
// value on one axis clears the other (there's no "family AND category"
// queue), while clearing an axis back to "All" only clears that one axis.
// pickAll() (the dedicated "All instruments" button) is the only thing
// that clears both at once.
function pickFamily(family) {
  filters.value.instrument_family = family;
  if (family) filters.value.category = '';
}
function pickCategory(key) {
  filters.value.category = key;
  if (key) filters.value.instrument_family = '';
}
function pickAll() {
  filters.value.instrument_family = '';
  filters.value.category = '';
}

// Hide-statuses dropdown: open/close, plus the same click-outside/Escape
// pattern App.vue's mobile nav uses.
const hideMenuOpen = ref(false);
const hideMenuEl = ref(null);

function closeHideMenu() {
  hideMenuOpen.value = false;
}

function onDocumentClick(event) {
  if (hideMenuOpen.value && hideMenuEl.value && !hideMenuEl.value.contains(event.target)) {
    closeHideMenu();
  }
}

function onKeydown(event) {
  if (event.key === 'Escape') closeHideMenu();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});

// Mirrors routes/tickets.js's GET / ORDER BY branch selection: true
// whenever the backend is actually returning one queue's own order
// (status-first, then that queue's position column) rather than the plain
// priority/updated_at fallback. Used to group the read-only table by
// status even when dragging itself is disabled (see canReorder below).
const isQueueOrdered = computed(() => {
  const f = filters.value;
  if (f.sort === 'status') return true;
  if (f.category) return !f.technician_id;
  if (f.technician_id === 'unassigned') return !f.instrument_family;
  if (f.instrument_family) return !f.technician_id;
  return false;
});

// Narrower than isQueueOrdered: dragging is only offered when exactly one
// of instrument/category is picked, nothing else is filtering out tickets
// that belong in the section being dragged (search text or priority could;
// "Show archived" pulls in a different set entirely, which the backend's
// reorder-queue mismatch check doesn't recognize), and no explicit sort
// override is replacing the queue's own order. Status/hide-status are
// fine — they only ever drop whole status sections, never part of one.
// 'date' (Q3) is excluded for the same reason 'status' already was: the
// visual order it produces has nothing to do with the persisted queue
// position, so dragging a row wouldn't mean what it looks like it means.
const canReorder = computed(() => {
  const f = filters.value;
  const singleScope = Boolean(f.category) !== Boolean(f.instrument_family);
  return singleScope && !f.technician_id && f.sort !== 'status' && f.sort !== 'date'
    && f.q === '' && f.priority === '' && !f.archived;
});

// Per-row rendering info for the draggable view: which tickets start a new
// status section (the backend already returns every queue status-sorted,
// see routes/tickets.js's GET / ordering) and each ticket's 1-based
// position *within* its own status section, since positions are scoped
// per status (POST /reorder-queue below only ever renumbers one status
// section at a time).
const rowInfo = computed(() => {
  let groupStart = 0;
  return tickets.value.map((t, i) => {
    if (i === 0 || tickets.value[i - 1].status_key !== t.status_key) groupStart = i;
    return { ticket: t, isGroupStart: i === groupStart, posInGroup: i - groupStart + 1 };
  });
});

onMounted(load);
onMounted(() => {
  settings.load();
  refData.load();
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
  // Confines drag-and-drop to one status section: a drag-over that would
  // cross into a different status's rows is simply ignored, so a ticket can
  // never be spliced across the boundary in the first place.
  if (tickets.value[dragIndex.value].status_key !== tickets.value[index].status_key) return;
  const moved = tickets.value.splice(dragIndex.value, 1)[0];
  tickets.value.splice(index, 0, moved);
  dragIndex.value = index;
}

async function onDragEnd() {
  if (dragIndex.value === null) return;
  // Capture before clearing dragIndex — onDragOver's guard above means the
  // dragged ticket's status_key never changed during the drag, so this is
  // exactly the one status section that just got reordered.
  const statusKey = tickets.value[dragIndex.value].status_key;
  dragIndex.value = null;
  await persistOrder(statusKey);
}

// Sends just the reordered id list for the one status section that was
// dragged — the server checks it's exactly the set of tickets currently in
// that queue+status (nobody else changed it mid-drag) and renumbers
// positions to match, leaving every other status section's positions
// untouched. A mismatch reloads the queue instead of silently applying a
// stale order on top of whatever changed.
async function persistOrder(statusKey) {
  error.value = '';
  saving.value = true;
  try {
    const ticketIds = tickets.value.filter((t) => t.status_key === statusKey).map((t) => t.id);
    const body = filters.value.category
      ? {
        scope: 'category', category_key: filters.value.category, status_key: statusKey, ticket_ids: ticketIds,
      }
      : {
        scope: 'family', family: filters.value.instrument_family, status_key: statusKey, ticket_ids: ticketIds,
      };
    await api.post('/tickets/reorder-queue', body);
  } catch (err) {
    error.value = `${err.message} The queue below has been reloaded.`;
    await load();
  } finally {
    saving.value = false;
  }
}

/** "Sam Tech, Jamie Tech" — who's on each ticket isn't otherwise implied by
 * which queue (category or instrument type) you're looking at. */
function techNames(t) {
  return (t.technicians || []).map((x) => x.name).join(', ') || 'unassigned';
}

// Q3 (boss-list scope): drop-off date on every queue card — when the
// instrument physically landed in the shop, both for display and for the
// new "Sort by -> Drop-off date" option below. The flat table
// (TicketTable.vue) already had a Created column; the drag-reorderable
// cards here had no date at all.
function dropOffDate(t) {
  return t.drop_off_date ? new Date(t.drop_off_date).toLocaleDateString() : '—';
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Queue</h1>
        <p class="muted small" style="margin: 0">
          Drag a ticket to move it within an instrument type's queue or a category's queue —
          grouped by status, and only reorderable within a status section, with no other filters
          narrowing the list. The new order saves as soon as you drop it.
        </p>
      </div>
      <RouterLink to="/tickets/new" class="btn primary">New ticket</RouterLink>
    </div>

    <div class="card tight" style="margin-bottom: 16px">
      <div class="field" style="margin: 0 0 14px">
        <label>Instrument type</label>
        <div class="row">
          <button
            type="button" class="small" :class="{ primary: !filters.instrument_family && !filters.category }"
            @click="pickAll"
          >
            All instruments
          </button>
          <button
            v-for="f in refData.families" :key="f"
            type="button" class="small" :class="{ primary: filters.instrument_family === f }"
            @click="pickFamily(f)"
          >
            {{ refData.familyLabel(f) }}
          </button>
        </div>
      </div>

      <div class="field" style="margin: 0">
        <label>Category</label>
        <div v-if="settings.categoriesForQueuePicker.length" class="row">
          <button
            v-for="c in settings.categoriesForQueuePicker" :key="c.key"
            type="button" class="small" :class="{ primary: filters.category === c.key }"
            @click="pickCategory(c.key)"
          >
            {{ c.label }}
          </button>
        </div>
        <p v-else class="muted small" style="margin: 0">
          No categories are shown here — enable some from Settings → Ticket categories'
          "Queue picker" column.
        </p>
      </div>
    </div>

    <!-- Filter bar — unchanged from the old Tickets page (TicketsView.vue,
         pre-merge; NOTES.md §2.27), just living below the picker buttons
         now. Its Category/Instrument fields are the exact same
         filters.category/filters.instrument_family the buttons above set,
         so the two ways of picking a queue can never disagree. -->
    <div class="card tight" style="margin-bottom: 16px">
      <div class="field-row">
        <div>
          <label>Search</label>
          <input v-model="filters.q" type="search" placeholder="Title, notes, customer, model" />
        </div>
        <div>
          <label>Status</label>
          <select v-model="filters.status">
            <option value="">All</option>
            <option v-for="s in settings.statuses" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
        </div>
        <div>
          <label>Category</label>
          <select :value="filters.category" @change="pickCategory($event.target.value)">
            <option value="">All</option>
            <option v-for="c in settings.categories" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
        </div>
        <div>
          <label>Priority</label>
          <select v-model="filters.priority">
            <option value="">All</option>
            <option v-for="p in settings.priorities" :key="p.key" :value="p.key">{{ p.label }}</option>
          </select>
        </div>
        <div>
          <label>Instrument</label>
          <select :value="filters.instrument_family" @change="pickFamily($event.target.value)">
            <option value="">All</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
          </select>
        </div>
        <div>
          <label>Tech</label>
          <select v-model="filters.technician_id">
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            <option v-for="e in refData.employees" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </div>
        <div>
          <label>Sort by</label>
          <select v-model="filters.sort">
            <option value="">Priority / queue order</option>
            <option value="status">Status progression</option>
            <option value="date">Drop-off date</option>
          </select>
        </div>
        <div ref="hideMenuEl" class="hide-status-field">
          <label>Hide statuses</label>
          <button type="button" class="hide-status-toggle" @click="hideMenuOpen = !hideMenuOpen">
            <span>{{ filters.hide_status.length ? `${filters.hide_status.length} hidden` : 'None hidden' }}</span>
            <span class="hide-status-caret">▾</span>
          </button>
          <div v-if="hideMenuOpen" class="hide-status-menu">
            <label v-for="s in settings.statuses" :key="s.key" class="checkbox">
              <input
                type="checkbox" :checked="filters.hide_status.includes(s.key)"
                @change="toggleHiddenStatus(s.key, $event.target.checked)"
              />
              <span class="small">{{ s.label }}</span>
            </label>
          </div>
        </div>
      </div>
      <div class="row" style="margin-top: 4px">
        <label class="checkbox" style="margin: 0">
          <input v-model="filters.archived" type="checkbox" />
          <span>Show archived</span>
        </label>
        <div class="spacer" />
        <span class="muted small">{{ tickets.length }} ticket(s)</span>
        <button class="small" @click="reset">Clear filters</button>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div v-if="loading" class="empty">Loading…</div>

    <!-- Not a clean single queue right now (see canReorder) — same plain,
         optionally status-grouped table the old Tickets page rendered. -->
    <div v-else-if="!canReorder" class="card tight">
      <TicketTable :tickets="tickets" :group-by-status="isQueueOrdered" />
    </div>

    <div v-else-if="!tickets.length" class="empty">No tickets in this queue.</div>

    <div v-else class="stack" :style="saving ? 'opacity: 0.6; pointer-events: none' : ''">
      <template v-for="(row, i) in rowInfo" :key="row.ticket.id">
        <div
          v-if="row.isGroupStart" class="muted small"
          :style="i === 0 ? 'margin: 4px 0 2px' : 'margin: 20px 0 2px'"
        >
          <span :class="['pill', settings.colorFor(row.ticket.status_key)]">
            {{ row.ticket.status_label || row.ticket.status_label_snapshot }}
          </span>
        </div>
        <div
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
            <span class="muted small nowrap">#{{ row.posInGroup }}</span>
            <div style="flex: 1; min-width: 0">
              <RouterLink :to="{ name: 'ticket', params: { id: row.ticket.id } }">
                <strong>{{ row.ticket.title }}</strong>
              </RouterLink>
              <div class="muted small">
                {{ row.ticket.customer_name || (row.ticket.instrument_is_fleet ? 'CEPCo fleet' : '—') }}
                <span v-if="row.ticket.instrument_family && !filters.instrument_family">
                  · {{ row.ticket.instrument_family }}
                </span>
              </div>
            </div>
            <span class="muted small nowrap" title="Drop-off date">
              {{ dropOffDate(row.ticket) }}
            </span>
            <span class="muted small nowrap" style="min-width: 140px; text-align: right">
              {{ techNames(row.ticket) }}
            </span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
