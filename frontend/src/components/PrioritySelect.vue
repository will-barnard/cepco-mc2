<script setup>
/**
 * Inline priority-tier picker for a ticket row (shop feedback, Sep 2026:
 * change a ticket's priority from the Queue without opening it). PATCHes
 * the ticket on change and emits `changed` so the list can re-fetch --
 * the unfiltered queue sorts by priority, so a row may move.
 *
 * Click/mousedown are stopped here so picking a priority doesn't also
 * trigger the row's own click-to-open (TicketTable) or start a drag
 * (QueueView's reorderable cards).
 */
import { ref, computed } from 'vue';
import api from '../api';
import { useSettings } from '../stores';

const props = defineProps({ ticket: { type: Object, required: true } });
const emit = defineEmits(['changed', 'error']);

const settings = useSettings();
const saving = ref(false);

// Active tiers, plus this ticket's own if it's since been retired -- a
// select whose value isn't among its options renders blank.
const options = computed(() => {
  const active = settings.active('priority_tier');
  if (!props.ticket.priority_key || active.some((p) => p.key === props.ticket.priority_key)) return active;
  return [...active, {
    key: props.ticket.priority_key,
    label: props.ticket.priority_label || props.ticket.priority_label_snapshot || props.ticket.priority_key,
  }];
});

async function change(event) {
  const key = event.target.value;
  if (!key || key === props.ticket.priority_key) return;
  saving.value = true;
  try {
    await api.patch(`/tickets/${props.ticket.id}`, { priority_key: key });
    emit('changed', key);
  } catch (err) {
    // Put the select back to what's actually saved.
    event.target.value = props.ticket.priority_key || '';
    emit('error', err.message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <select
    class="priority-select" :value="ticket.priority_key || ''" :disabled="saving"
    :title="saving ? 'Saving…' : 'Change priority'"
    @change="change" @click.stop @mousedown.stop
  >
    <option v-for="p in options" :key="p.key" :value="p.key">{{ p.label }}</option>
  </select>
</template>

<style scoped>
.priority-select { width: auto; min-width: 0; padding: 4px 8px; font-size: 13px; }
</style>
