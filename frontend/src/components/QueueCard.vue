<script setup>
/**
 * One ticket row on the Queue page (QueueView.vue). Pulled out of
 * QueueView's template when the split view (migration 063) needed the same
 * row in two columns — the wide main list and the narrower right-hand
 * column — rather than duplicating the markup.
 *
 * It's a row, not a card of its own: the Queue boxes each status section
 * (one panel per status, per the shop's sketch) and these sit inside it,
 * separated by rules.
 *
 * Laid out as fixed columns so the page reads down cleanly (shop feedback,
 * Oct 2026): grip, position, then the customer in a fixed-width column so
 * every name starts at the same x, then the rest of the title (with the
 * customer stripped off it — see ticketNaming.js's titleWithoutCustomer)
 * starting at the same x too. Priority isn't shown here any more; it's
 * changed on the ticket page.
 *
 * Drag-and-drop stays entirely the parent's business: `draggable` and the
 * native drag listeners are passed as plain attributes and fall through to
 * the root element (none of them are declared as props or emits), so this
 * component never needs to know which index it sits at in the parent's
 * list. `pos` doubles as the "is this a reorderable queue" switch — null
 * hides the grip and the #n position, for a read-only row.
 */
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { titleWithoutCustomer } from '../ticketNaming';
import { useSettings } from '../stores';

const props = defineProps({
  ticket: { type: Object, required: true },
  // 1-based position within its status section, or null when the list
  // isn't reorderable right now (see QueueView's canReorder).
  pos: { type: Number, default: null },
  // QueueView turns the customer column off for a queue where no ticket
  // has a customer at all (Daily To-Do's, Housekeeping, ...) rather than
  // showing a column of dashes.
  showCustomer: { type: Boolean, default: true },
  // Right-hand column: narrower customer column, date/techs drop under the
  // title instead of taking columns of their own.
  compact: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
});

const settings = useSettings();

// Shared queue sections (migration 065): a Reservation sits in the "Not
// Started" box, so it carries its own status pill -- the instrument isn't
// in the shop yet, and that's the one thing the box header doesn't say.
const otherStatus = computed(() => (
  props.ticket.queue_section_status_key && props.ticket.status_key !== props.ticket.queue_section_status_key
));

const customer = computed(
  () => props.ticket.customer_name || (props.ticket.instrument_is_fleet ? 'CEPCo fleet' : ''),
);
// Only strip a real customer name — "CEPCo fleet" is never in a title.
const rest = computed(() => (props.showCustomer
  ? titleWithoutCustomer(props.ticket.title, props.ticket.customer_name)
  : props.ticket.title));

const techs = computed(
  () => (props.ticket.technicians || []).map((x) => x.name).join(', ') || 'unassigned',
);
const dropOff = computed(
  () => (props.ticket.drop_off_date ? new Date(props.ticket.drop_off_date).toLocaleDateString() : '—'),
);
</script>

<template>
  <div class="queue-card" :class="{ compact }" :style="dragging ? 'opacity: 0.4' : ''">
    <template v-if="pos !== null">
      <span class="muted grip" title="Drag to reorder">⠿</span>
      <span class="muted small pos">#{{ pos }}</span>
    </template>
    <RouterLink
      v-if="showCustomer" :to="{ name: 'ticket', params: { id: ticket.id } }"
      class="customer" :title="customer || 'No customer'"
    >
      <strong v-if="customer">{{ customer }}</strong>
      <span v-else class="muted">—</span>
    </RouterLink>
    <div class="rest">
      <RouterLink :to="{ name: 'ticket', params: { id: ticket.id } }" class="rest-title">
        {{ rest || ticket.title }}
      </RouterLink>
      <span v-if="ticket.fast_track" class="tag fast-track-tag" title="Fast Track">Fast Track</span>
      <span
        v-if="otherStatus" :class="['pill', 'status-pill', settings.colorFor(ticket.status_key)]"
      >{{ ticket.status_label || ticket.status_label_snapshot }}</span>
      <!-- Under the title in the narrow right column and on phones; the
           wide layout gives date/techs columns of their own instead. -->
      <div class="sub muted small">{{ dropOff }} · {{ techs }}</div>
    </div>
    <span class="muted small nowrap date" title="Date of Order/Queue">{{ dropOff }}</span>
    <span class="muted small nowrap techs">{{ techs }}</span>
  </div>
</template>

<style scoped>
.queue-card {
  --customer-w: 190px;
  display: flex; align-items: baseline; gap: 12px;
  padding: 10px 2px; border-top: 1px solid var(--border);
}
.compact { --customer-w: 130px; }

/* Fixed widths on everything left of the title, so customer names and the
   title text each start at the same x on every row, across boxes too. */
.grip { width: 14px; flex: none; font-size: 16px; line-height: 1; cursor: grab; }
.pos { width: 2.4em; flex: none; }
.customer {
  width: var(--customer-w); flex: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rest { flex: 1; min-width: 0; }
.rest-title { color: var(--text); }
.rest-title:hover { color: var(--accent); }
.status-pill { margin-left: 6px; }
.date { width: 6.5em; flex: none; }
.techs { width: 140px; flex: none; overflow: hidden; text-overflow: ellipsis; text-align: right; }

.sub { display: none; }
.compact .sub { display: block; }
.compact .date, .compact .techs { display: none; }

@media (max-width: 640px) {
  .queue-card { --customer-w: 104px; gap: 8px; }
  .sub { display: block; }
  .date, .techs { display: none; }
}
</style>
