<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '../stores';
import { titleWithoutCustomer } from '../ticketNaming';

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
  if (!props.groupByStatus) return [{ key: null, label: null, tickets: props.tickets }];
  const out = [];
  for (const t of props.tickets) {
    const last = out[out.length - 1];
    if (last && last.key === t.status_key) {
      last.tickets.push(t);
    } else {
      out.push({ key: t.status_key, label: t.status_label || t.status_label_snapshot, tickets: [t] });
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
function rowClass(sectionKey) {
  if (!props.highlightStatus || sectionKey !== props.highlightStatus) return '';
  return `row-highlight ${settings.colorFor(sectionKey)}`;
}
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
        <col style="width: 190px" />
        <col />
        <col v-if="showStatus" style="width: 130px" />
        <col style="width: 100px" />
        <col style="width: 140px" />
      </colgroup>
      <thead v-if="queueLayout">
        <tr>
          <th>Customer</th>
          <th>Ticket</th>
          <th v-if="showStatus">Status</th>
          <th class="nowrap">Order date</th>
          <th class="right">Tech</th>
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
              <span :class="['pill', settings.colorFor(section.key)]">{{ section.label }}</span>
              <span class="muted small" style="margin-left: 6px">{{ section.tickets.length }}</span>
            </td>
          </tr>
        <tr
          v-for="t in section.tickets" :key="t.id"
          :class="['clickable', rowClass(section.key)]" @click="open(t.id)"
        >
          <td v-if="queueLayout" class="ellipsis" :title="customerLabel(t)">
            <strong>{{ customerLabel(t) }}</strong>
          </td>
          <td>
            <strong v-if="queueLayout">{{ titleWithoutCustomer(t.title, t.customer_name) || t.title }}</strong>
            <strong v-else>{{ t.title }}</strong>
            <span v-if="t.fast_track" class="tag fast-track-tag">Fast Track</span>
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
            <td class="nowrap small muted">{{ dropOff(t) }}</td>
            <td class="small muted right ellipsis">{{ techNames(t) }}</td>
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
</style>
