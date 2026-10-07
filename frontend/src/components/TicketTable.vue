<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '../stores';
import { titleWithoutCustomer } from '../ticketNaming';
import { progressOf, progressStyle } from '../progress';

const props = defineProps({
  tickets: { type: Array, required: true },
  emptyText: { type: String, default: 'No tickets match those filters.' },
  // Opt-in — TicketsView.vue's plain flat table is untouched. When set,
  // tickets (which the backend already returns sorted status-first for
  // every queue-scoped list, see routes/tickets.js's GET / ordering) are
  // broken into consecutive-run sections with a status header row, the
  // same grouping DashboardView.vue's "Assigned to me"/"Unassigned" lists
  // and QueueView.vue's queues use.
  groupByStatus: { type: Boolean, default: false },
  // DashboardView.vue's "In-Progress Tickets" card: one status's rows get
  // visually called out (tinted background + accent bar, in that status's
  // own pill color) rather than just sitting in a labeled section like
  // every other groupByStatus consumer. Requires groupByStatus — a status
  // is only ever its own contiguous section when the list is grouped.
  // Default null leaves every existing usage unaffected.
  highlightStatus: { type: String, default: null },
  // Opt-in (QueueView, shop feedback Oct 2026): Customer becomes the first
  // column with the title (customer stripped off it — ticketNaming.js's
  // titleWithoutCustomer) right after, and column widths are fixed so
  // several of these tables stacked in separate status boxes line up with
  // each other. (This replaced the inline priority picker the Queue used
  // to have here — priority is changed on the ticket page now.)
  queueLayout: { type: Boolean, default: false },
  // Off when every row is already known to share one status (each Queue
  // status box), where the column would just repeat the box's own header.
  showStatus: { type: Boolean, default: true },
  // Progress bar (migration 066): fill rows green to progress_percent and
  // show the number beside the title. Always on in queueLayout (the
  // Queue's read-only fallback tables); opt-in elsewhere (the dashboard).
  showProgress: { type: Boolean, default: false },
});

const router = useRouter();
const settings = useSettings();

const open = (id) => router.push({ name: 'ticket', params: { id } });

const customerLabel = (t) => t.customer_name || (t.instrument_is_fleet ? 'CEPCo fleet' : '—');
const columnCount = computed(() => (props.queueLayout ? 4 : 6) + (props.showStatus ? 1 : 0));
const dropOff = (t) => (t.drop_off_date ? new Date(t.drop_off_date).toLocaleDateString() : '—');

// Consecutive-run grouping, not a full group-by — the list already arrives
// status-sorted, so this just finds where status_key changes from the
// previous row. When groupByStatus is false, everything is one unlabeled
// section so the template below only has one rendering path.
const sections = computed(() => {
  if (!props.groupByStatus) return [{ key: null, statusKey: null, label: null, tickets: props.tickets }];
  const out = [];
  // Grouped by queue *section* (migration 065), not raw status: statuses
  // sharing a queue_group (Reservation + Not Started) arrive interleaved
  // in one shared order, and grouping on status_key would chop that into
  // a header per run. statusKey is the section's lead status, for its
  // pill color and highlightStatus.
  for (const t of props.tickets) {
    const key = t.queue_section || t.status_key;
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.tickets.push(t);
    } else {
      out.push({
        key,
        statusKey: t.queue_section_status_key || t.status_key,
        label: t.queue_section_label || t.status_label || t.status_label_snapshot,
        tickets: [t],
      });
    }
  }
  return out;
});

/** Estimate-vs-actual: the number the shop actually cares about (PLAN §3). */
function hoursLabel(t) {
  const actual = Number(t.actual_hours || 0);
  const est = Number(t.estimated_hours || 0);
  if (!est && !actual) return '—';
  if (!est) return `${actual.toFixed(1)}`;
  return `${actual.toFixed(1)} / ${est.toFixed(1)}`;
}

function hoursOver(t) {
  const est = Number(t.estimated_hours || 0);
  return est > 0 && Number(t.actual_hours || 0) > est;
}

/** "Sam Tech, Jamie Tech" — a ticket can have zero or more assigned techs. */
function techNames(t) {
  return (t.technicians || []).map((x) => x.name).join(', ') || '—';
}

// Row class for the highlighted section (see highlightStatus above) --
// reuses that status's own pill color (settings.colorFor) so the accent
// always matches, rather than a second hardcoded color choice.
function rowClass(statusKey) {
  if (!props.highlightStatus || statusKey !== props.highlightStatus) return '';
  return `row-highlight ${settings.colorFor(statusKey)}`;
}

// A row whose own status isn't the one its section is named after (a
// Reservation inside the shared "Not Started" box) -- flagged inline when
// the Status column is off, so it isn't mistaken for a ticket on hand.
// Progress bar (migration 066): same green fill QueueCard.vue gives the
// Queue's draggable rows (global .progress-fill), when this table shows it.
const progressOn = computed(() => props.queueLayout || props.showProgress);
const rowProgress = (t) => (progressOn.value ? progressOf(t) : null);

const statusDiffers = (t) => t.queue_section_status_key && t.status_key !== t.queue_section_status_key;
</script>

<template>
  <div v-if="!tickets.length" class="empty">{{ emptyText }}</div>

  <div v-else class="table-wrap">
    <table :class="{ 'queue-layout-table': queueLayout }">
      <!-- queueLayout: the same columns as the Queue's drag cards
           (QueueCard.vue) — customer, ticket, date of order, techs — so
           switching between the two (e.g. toggling Fast Track) doesn't
           reshuffle the page. Priority/hours live on the ticket page. -->
      <colgroup v-if="queueLayout">
        <col class="c-customer" />
        <col />
        <col v-if="showStatus" class="c-status" />
        <col class="c-date" />
        <col class="c-tech" />
      </colgroup>
      <thead v-if="queueLayout">
        <tr>
          <th>Customer</th>
          <th>Ticket</th>
          <th v-if="showStatus">Status</th>
          <th class="nowrap c-date">Order date</th>
          <th class="right c-tech">Tech</th>
        </tr>
      </thead>
      <thead v-else>
        <tr>
          <th>Ticket</th>
          <th class="nowrap">Created</th>
          <th>Customer</th>
          <th v-if="showStatus">Status</th>
          <th>Priority</th>
          <th>Tech</th>
          <th class="right nowrap">Hrs act/est</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="section in sections" :key="section.key ?? 'all'">
          <tr v-if="groupByStatus" class="status-section-row">
            <td :colspan="columnCount" style="padding-top: 16px; border-top: none">
              <span :class="['pill', settings.colorFor(section.statusKey)]">{{ section.label }}</span>
              <span class="muted small" style="margin-left: 6px">{{ section.tickets.length }}</span>
            </td>
          </tr>
        <tr
          v-for="t in section.tickets" :key="t.id"
          :class="['clickable', rowClass(section.statusKey), { 'progress-fill': rowProgress(t) !== null }]"
          :style="rowProgress(t) !== null ? progressStyle(t) : null" @click="open(t.id)"
        >
          <td v-if="queueLayout" class="ellipsis" :title="customerLabel(t)">
            <strong>{{ customerLabel(t) }}</strong>
          </td>
          <td>
            <strong v-if="queueLayout">{{ titleWithoutCustomer(t.title, t.customer_name) || t.title }}</strong>
            <strong v-else>{{ t.title }}</strong>
            <span v-if="t.fast_track" class="tag fast-track-tag">Fast Track</span>
            <span v-if="rowProgress(t) !== null" class="small progress-pct" style="margin-left: 6px">{{ rowProgress(t) }}%</span>
            <span
              v-if="!showStatus && statusDiffers(t)"
              :class="['pill', settings.colorFor(t.status_key)]" style="margin-left: 6px"
            >{{ t.status_label || t.status_label_snapshot }}</span>
            <!-- queueLayout, narrow box: the date/tech columns are hidden
                 (see the container queries below) and live here instead. -->
            <div v-if="queueLayout" class="sub muted small">{{ dropOff(t) }} · {{ techNames(t) }}</div>
            <div v-if="t.instrument_family && !queueLayout" class="muted small">
              {{ t.instrument_family }}<span v-if="t.instrument_model"> · {{ t.instrument_model }}</span>
              <span v-if="t.attachment_count" class="tag" style="margin-left: 6px">
                {{ t.attachment_count }} photo{{ t.attachment_count === 1 ? '' : 's' }}
              </span>
            </div>
          </td>
          <td v-if="!queueLayout" class="nowrap small">{{ new Date(t.created_at).toLocaleDateString() }}</td>
          <td v-if="!queueLayout">{{ customerLabel(t) }}</td>
          <td v-if="showStatus">
            <span :class="['pill', settings.colorFor(t.status_key)]">
              {{ t.status_label || t.status_label_snapshot }}
            </span>
          </td>
          <template v-if="queueLayout">
            <td class="nowrap small muted c-date">{{ dropOff(t) }}</td>
            <td class="small muted right ellipsis c-tech">{{ techNames(t) }}</td>
          </template>
          <template v-else>
            <td class="small">{{ t.priority_label || t.priority_label_snapshot }}</td>
            <td class="small">{{ techNames(t) }}</td>
            <td class="right nowrap" :style="hoursOver(t) ? 'color: var(--amber)' : ''">
              {{ hoursLabel(t) }}
            </td>
          </template>
        </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
/* Fixed layout so separate tables (one per Queue status box) share column
   positions — auto layout would size each table to its own contents. */
.queue-layout-table { table-layout: fixed; width: 100%; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.queue-layout-table col.c-customer { width: 190px; }
.queue-layout-table col.c-status { width: 130px; }
.queue-layout-table col.c-date { width: 100px; }
.queue-layout-table col.c-tech { width: 140px; }
.queue-layout-table .sub { display: none; }

/* Same idea as QueueCard.vue: these fixed columns add up to 560px, which left
   the title nothing in a ~560px iPad column. Sized by the Queue box
   (QueueView's .queue-box container), not the viewport. */
@container queue-box (max-width: 759px) {
  .queue-layout-table col.c-customer { width: 150px; }
  .queue-layout-table .c-date, .queue-layout-table .c-tech { display: none; }
  .queue-layout-table .sub { display: block; }
}
@container queue-box (max-width: 519px) {
  .queue-layout-table col.c-customer { width: 110px; }
  .queue-layout-table col.c-status { width: 100px; }
}
</style>
