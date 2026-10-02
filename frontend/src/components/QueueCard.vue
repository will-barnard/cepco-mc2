<script setup>
/**
 * One ticket card on the Queue page (QueueView.vue). Pulled out of
 * QueueView's template when the split view (migration 063) needed the same
 * card in two columns — the wide main list and the narrower right-hand
 * column — rather than duplicating the markup.
 *
 * It's a row, not a card of its own: the Queue boxes each status section
 * (one panel per status, per the shop's sketch) and these sit inside it,
 * separated by rules.
 *
 * Drag-and-drop stays entirely the parent's business: `draggable` and the
 * native drag listeners are passed as plain attributes and fall through to
 * the root element (none of them are declared in `emits`), so this
 * component never needs to know which index it sits at in the parent's
 * list. `pos` doubles as the "is this a reorderable queue" switch — null
 * hides the grip and the #n position, for a read-only card.
 */
import { RouterLink } from 'vue-router';
import PrioritySelect from './PrioritySelect.vue';

defineProps({
  ticket: { type: Object, required: true },
  // 1-based position within its status section, or null when the list
  // isn't reorderable right now (see QueueView's canReorder).
  pos: { type: Number, default: null },
  // The family is redundant when the whole queue is already one family.
  showFamily: { type: Boolean, default: true },
  // Right-hand column: priority/date/techs drop onto a second line instead
  // of squeezing the title in a narrow column.
  compact: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
});
const emit = defineEmits(['priority-changed', 'priority-error']);

function techNames(t) {
  return (t.technicians || []).map((x) => x.name).join(', ') || 'unassigned';
}

function dropOffDate(t) {
  return t.drop_off_date ? new Date(t.drop_off_date).toLocaleDateString() : '—';
}
</script>

<template>
  <div class="queue-card" :class="{ compact }" :style="dragging ? 'opacity: 0.4' : ''">
    <div class="queue-card-main">
      <span v-if="pos !== null" class="muted grip" title="Drag to reorder">⠿</span>
      <span v-if="pos !== null" class="muted small nowrap">#{{ pos }}</span>
      <div class="queue-card-title">
        <RouterLink :to="{ name: 'ticket', params: { id: ticket.id } }">
          <strong>{{ ticket.title }}</strong>
        </RouterLink>
        <span v-if="ticket.fast_track" class="tag fast-track-tag" title="Fast Track">Fast Track</span>
        <div class="muted small">
          {{ ticket.customer_name || (ticket.instrument_is_fleet ? 'CEPCo fleet' : '—') }}
          <span v-if="ticket.instrument_family && showFamily"> · {{ ticket.instrument_family }}</span>
        </div>
      </div>
      <div class="queue-card-meta">
        <PrioritySelect
          :ticket="ticket"
          @changed="emit('priority-changed', ticket)" @error="(msg) => emit('priority-error', msg)"
        />
        <span class="muted small nowrap" title="Date of Order/Queue">{{ dropOffDate(ticket) }}</span>
        <span class="muted small nowrap techs">{{ techNames(ticket) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.queue-card { padding: 10px 2px; border-top: 1px solid var(--border); }
.queue-card-main { display: flex; align-items: center; gap: 14px; }
.grip { font-size: 18px; line-height: 1; cursor: grab; }
.queue-card-title { flex: 1; min-width: 0; }
.queue-card-meta { display: flex; align-items: center; gap: 14px; }
.techs { min-width: 140px; text-align: right; }

/* Right-hand column: title takes the full width, meta wraps beneath it. */
.compact .queue-card-main { flex-wrap: wrap; gap: 8px 10px; }
.compact .queue-card-meta { flex-basis: 100%; gap: 10px; flex-wrap: wrap; }
.compact .techs { min-width: 0; text-align: left; }

/* Phones: same wrap as the compact card, whichever column it's in. */
@media (max-width: 640px) {
  .queue-card-main { flex-wrap: wrap; gap: 8px 10px; }
  .queue-card-meta { flex-basis: 100%; gap: 10px; flex-wrap: wrap; }
  .techs { min-width: 0; text-align: left; }
}
</style>
