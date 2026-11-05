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
 * Sort modes (shop feedback, Nov 2026) -- a three-way toggle in the page
 * header, applied to whatever queue/filters are picked:
 *   Date      (default) one flat list, oldest Date of Order/Queue first.
 *   Status    one box per status section (workflow order), oldest first
 *             inside each box. This is the only grouped mode, so it's the
 *             only one the split view applies to.
 *   Priority  one flat list, most urgent tier first, oldest first within.
 * The pick is remembered per device (localStorage) and mirrored into the
 * URL like every filter. It is *not* reset by "Clear filters" -- it's how
 * you like to look at the queue, not what you're filtering for.
 *
 * Drag-to-reorder is gone with this change: with Status sub-sorted by date
 * there's no mode where a manual position would show. The saved positions
 * (category/family/tech queue_position columns) and POST
 * /tickets/reorder-queue are left in place untouched -- the dashboard's
 * no-?sort lists still order by them -- so it can come back if wanted.
 *
 * Split view (shop feedback, Oct 2026; migration 063): whenever the list is
 * status-grouped, the statuses picked in Settings -> Queue split view are
 * pulled out of the main list into a right-hand column, in *that* setting's
 * order rather than the workflow order the main list follows. It's purely
 * a rendering split — one fetch, one `tickets` array — and a status
 * section only ever lives in one column. Only in Status sort (the other
 * modes aren't grouped). On narrow screens the two columns stack with the
 * right one first.
 *
 * Lite (same migration; labelled "Fast Track" until Nov 2026, still
 * `fast_track` in the DB and URL): a per-ticket flag with its own
 * quick-filter button. It combines with the instrument/category buttons
 * (e.g. Lite Wurlitzers). Custom Shop (migration 070) is the same kind of
 * flag and behaves identically.
 *
 * Priority (Nov 2026): every row leads with its priority as lightning bolts
 * (PriorityBolts.vue), and tiers flagged in Settings -> Priority tiers'
 * "Queue flag" column also get a tag beside the title, like Lite's.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';
import TicketTable from '../components/TicketTable.vue';
import QueueCard from '../components/QueueCard.vue';

const route = useRoute();
const router = useRouter();

// Sort modes -- see the header. Remembered per device; storage can throw
// (private mode, blocked site data), in which case it's just not remembered.
const SORT_MODES = [
  { key: 'date', label: 'Date' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
];
const SORT_STORAGE_KEY = 'mc2.queue.sort';
const isSortMode = (v) => SORT_MODES.some((m) => m.key === v);
function storedSort() {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    return isSortMode(v) ? v : 'date';
  } catch {
    return 'date';
  }
}
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
  // "Lite" quick-filter button (migration 063; formerly "Fast Track").
  fast_track: route.query.fast_track === 'true',
  // "Custom Shop" quick-filter button (migration 070).
  custom_shop: route.query.custom_shop === 'true',
  // 'date' | 'status' | 'priority' -- the header toggle. A URL wins over
  // the device's remembered pick, so a shared link opens the way it was sent.
  sort: isSortMode(route.query.sort) ? route.query.sort : storedSort(),
  // "Hide statuses" dropdown below — status keys to exclude, e.g. hiding
  // Done/On Hold while otherwise browsing everything.
  hide_status: (route.query.hide_status || '').split(',').filter(Boolean),
});

const tickets = ref([]);
const loading = ref(true);
const error = ref('');

// `silent` keeps a filter tweak (ticking "Hide statuses", flipping "Show
// archived", typing a search term) from blanking the whole list to
// "Loading..." on every change — that used to happen because this same
// `load()`, and the same `loading` flag, backed both the very first fetch
// and every refetch after. Now only the first fetch (onMounted below) does
// the full-page "Loading..." state; filter-driven refetches just dim the
// existing list (see `refreshing` in the template) while the new page of
// tickets comes in.
const refreshing = ref(false);

// Bug fix (Oct 2026): "In Progress" showing up twice on an instrument
// type's queue. Clicking e.g. "Rhodes" changes `filters` instantly, but
// `tickets` still holds the previous view's list (say "All instruments",
// sorted by priority, so statuses interleave) until the new fetch lands.
// Everything that decides the *layout* -- grouped boxes or not, which
// boxes, drag scope -- used to read the live `filters`, so for that moment
// the old interleaved list got chopped into boxes: In Progress, On Hold,
// In Progress, ... with the same status key repeated. Duplicate v-for keys
// then left a stale box behind in the DOM even after the right list
// arrived. Reproduced on production by clicking All instruments ->
// Rhodes.
//
// So: `shownFilters` is the filter set the tickets on screen were actually
// fetched with, and the layout reads that instead of `filters`. And a
// response that's no longer the latest request (a slow "All instruments"
// fetch finishing after a quick "Rhodes" one) is dropped rather than
// overwriting the newer list.
const shownFilters = ref(null);
let loadSeq = 0;

async function load(silent = false) {
  const seq = ++loadSeq;
  const requested = JSON.parse(JSON.stringify(filters.value));
  if (silent) refreshing.value = true; else loading.value = true;
  error.value = '';
  try {
    const rows = await api.get('/tickets', {
      ...requested,
      archived: requested.archived ? 'true' : '',
      fast_track: requested.fast_track ? 'true' : '',
      custom_shop: requested.custom_shop ? 'true' : '',
      hide_status: requested.hide_status.join(','),
    });
    if (seq !== loadSeq) return;
    tickets.value = rows;
    shownFilters.value = requested;
  } catch (err) {
    if (seq === loadSeq) error.value = err.message;
  } finally {
    // The first full-page load can be superseded by a quick filter click
    // (a silent load); it still has to clear its own "Loading..." or the
    // page would sit on it forever. A superseded silent load leaves the
    // dimming to the newer one that's still in flight.
    if (!silent) loading.value = false;
    else if (seq === loadSeq) refreshing.value = false;
  }
}
// What the layout computeds below read -- see shownFilters above.
const layoutFilters = computed(() => shownFilters.value || filters.value);

// Keep filters in the URL so a filtered/queued view can be bookmarked or
// shared — same as the old Tickets page.
watch(filters, (f) => {
  const query = Object.fromEntries(
    Object.entries(f)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])
      .filter(([, v]) => v !== '' && v !== false),
  );
  router.replace({ query });
  load(true);
}, { deep: true });

watch(() => filters.value.sort, (mode) => {
  try { localStorage.setItem(SORT_STORAGE_KEY, mode); } catch { /* not remembered, that's all */ }
});

// Keeps the sort mode: it's a way of viewing, not a filter (see header).
function reset() {
  filters.value = {
    q: '', status: '', category: '', priority: '',
    instrument_family: '', technician_id: '', archived: false, fast_track: false, custom_shop: false,
    sort: filters.value.sort,
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

// Status is the one grouped mode: rows arrive section-first from the
// backend (routes/tickets.js, sort=status), date-ordered inside each.
const grouped = computed(() => layoutFilters.value.sort === 'status');

// "Status section" means queue *section* (migration 065): statuses that
// share a queue_group in Settings (Reservation + Not Started) are one box.
// The backend tags every ticket with its section (`queue_section`); an
// ungrouped status is a section of its own.
const sectionOf = (t) => t.queue_section || t.status_key;

// --- split view (migration 063) -------------------------------------------
// Right-column statuses that can actually appear under the current filters:
// only when the list is status-grouped at all (an ungrouped priority-sorted
// list has no sections to pull out), minus anything "Hide statuses" or the
// single-status filter already excludes — so the column doesn't fill up
// with "None" placeholders for statuses the user asked not to see.
const sideKeys = computed(() => {
  const f = layoutFilters.value;
  if (!grouped.value) return [];
  return settings.queueSideStatuses
    .filter((k) => !f.hide_status.includes(k) && (!f.status || f.status === k));
});
const splitActive = computed(() => sideKeys.value.length > 0);
// Picking one member of a shared section for the right column moves the
// whole section -- it's one list, it can't be split across two columns.
const sideSectionKeys = computed(
  () => [...new Set(sideKeys.value.map((k) => settings.queueSectionOf(k)))],
);
const sideSet = computed(() => new Set(sideSectionKeys.value));

// Main column: every ticket whose section isn't pulled out.
const mainTickets = computed(() => tickets.value.filter((t) => !sideSet.value.has(sectionOf(t))));

// The main column as one boxed panel per status (the shop's sketch: an "In
// Progress" box, a "Not Started" box, ...), same as the right column.
// Consecutive runs, since rows already arrive status-sorted whenever the
// list is grouped at all — this is only used when it is.
const mainSections = computed(() => {
  const out = [];
  const seen = new Map();
  for (const t of mainTickets.value) {
    const last = out[out.length - 1];
    if (last && last.key === sectionOf(t)) last.tickets.push(t);
    else {
      const key = sectionOf(t);
      // Belt and braces for the fix above: if a section ever does come back
      // in two runs, it gets two boxes with distinct v-for keys rather than
      // duplicate keys that leave stale DOM behind.
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      out.push({
        key,
        uid: n === 1 ? key : `${key}#${n}`,
        statusKey: t.queue_section_status_key || t.status_key,
        label: t.queue_section_label || t.status_label || t.status_label_snapshot,
        tickets: [t],
      });
    }
  }
  return out;
});

// Right column: one section per configured status, in Settings order, and
// shown even when empty so the column keeps the same shape from one queue
// to the next instead of jumping around.
const sideSections = computed(() => sideSectionKeys.value.map((key) => {
  const lead = settings.queueSectionLead(key);
  return {
    key,
    statusKey: lead?.key || key,
    label: lead?.label || settings.labelFor('ticket_status', key),
    tickets: tickets.value.filter((t) => sectionOf(t) === key),
  };
}));

onMounted(load);
onMounted(() => {
  settings.load();
  refData.load();
});

// Customer column (QueueCard / TicketTable queueLayout): dropped for a queue
// where nothing has a customer at all — Daily To-Do's, Housekeeping, ... —
// rather than showing a column of dashes. Decided once for the whole page,
// not per box, so the title column starts at the same x in every box.
const showCustomer = computed(
  () => tickets.value.some((t) => t.customer_name || t.instrument_in_inventory),
);
// Progress column (migration 066): on for the whole page once any ticket
// has a progress value, so the percentages line up in every box.
const showProgress = computed(() => tickets.value.some((t) => t.progress_percent));

</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Queue</h1>
        <p class="muted small" style="margin: 0">
          Oldest Date of Order/Queue first. Sort by Status to group into one box per status
          (oldest first inside each), or by Priority for the most urgent jobs first.
        </p>
      </div>
      <div class="row queue-head-actions">
        <div class="sort-toggle" role="group" aria-label="Sort the queue by">
          <span class="muted small">Sort by</span>
          <button
            v-for="m in SORT_MODES" :key="m.key" type="button" class="small"
            :class="{ primary: filters.sort === m.key }" :aria-pressed="filters.sort === m.key"
            @click="filters.sort = m.key"
          >
            {{ m.label }}
          </button>
        </div>
        <RouterLink to="/tickets/new" class="btn primary">New ticket</RouterLink>
      </div>
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

      <!-- Combines with whichever instrument/category is picked above,
           rather than replacing it like those buttons replace each other. -->
      <div class="field" style="margin: 14px 0 0">
        <label>Quick filter</label>
        <div class="row">
          <button
            type="button" class="small" :class="{ primary: filters.fast_track }"
            :aria-pressed="filters.fast_track" @click="filters.fast_track = !filters.fast_track"
          >
            Lite
          </button>
          <button
            type="button" class="small" :class="{ primary: filters.custom_shop }"
            :aria-pressed="filters.custom_shop" @click="filters.custom_shop = !filters.custom_shop"
          >
            Custom Shop
          </button>
        </div>
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

    <div
      v-else :class="['queue-layout', { split: splitActive }]"
      :style="refreshing ? 'opacity: 0.6' : ''"
    >
      <div class="queue-main">
        <!-- Date / Priority: one flat table, in the order the backend sent. -->
        <div v-if="!grouped" class="card tight queue-box">
          <TicketTable :tickets="mainTickets" queue-layout />
        </div>

        <div v-else-if="!mainSections.length" class="empty">
          {{ splitActive ? 'Nothing else in this queue.' : 'No tickets in this queue.' }}
        </div>

        <!-- Status: one box per status section. -->
        <template v-else>
          <section v-for="sec in mainSections" :key="sec.uid" class="card tight queue-section queue-box">
            <div class="queue-section-head">
              <span :class="['pill', settings.colorFor(sec.statusKey)]">{{ sec.label }}</span>
              <span class="muted small">{{ sec.tickets.length }}</span>
            </div>
            <TicketTable :tickets="sec.tickets" queue-layout :show-status="false" />
          </section>
        </template>
      </div>

      <!-- Right column (Settings -> Queue split view) — QC / Shipping /
           Invoiced boxes in the shop's sketch. Compact rows rather than
           the main column's table: a 6-column table doesn't fit a side
           column. Empty boxes stay, showing "None". -->
      <aside v-if="splitActive" class="queue-side">
        <section v-for="sec in sideSections" :key="sec.key" class="card tight queue-section queue-box">
          <div class="queue-section-head">
            <span :class="['pill', settings.colorFor(sec.statusKey)]">{{ sec.label }}</span>
            <span class="muted small">{{ sec.tickets.length }}</span>
          </div>
          <p v-if="!sec.tickets.length" class="muted small" style="margin: 0">None</p>
          <QueueCard
            v-for="t in sec.tickets" :key="t.id"
            :ticket="t" :show-customer="showCustomer" :show-progress="showProgress" compact
          />
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.queue-head-actions { gap: 12px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.sort-toggle { display: flex; align-items: center; gap: 6px; }
/* Split view (migration 063): main statuses on the left, the statuses picked
   in Settings -> Queue split view stacked on the right — each status its own
   box, per the shop's sketch. */
.queue-main, .queue-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.queue-layout.split {
  display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 16px; align-items: start;
}
.queue-section { padding-bottom: 4px; }

/* Every box is a size container named "queue-box": QueueCard and TicketTable
   pick their layout from the width of the box they sit in, not from the
   viewport. An iPad is a wide viewport, but the split view still leaves each
   column narrow, so a viewport media query can't tell the cards they're
   being squeezed. */
.queue-box { container: queue-box / inline-size; }
.queue-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }

/* Phones/tablets: one column, right column first. */
@media (max-width: 900px) {
  .queue-layout.split { grid-template-columns: minmax(0, 1fr); }
  .queue-side { order: -1; }
}
</style>
