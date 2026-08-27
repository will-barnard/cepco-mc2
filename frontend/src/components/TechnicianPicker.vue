<script setup>
/**
 * Checkbox list of active technicians for assigning more than one to a
 * ticket (tickets.assigned_tech_id was a single FK; see migration 013 —
 * a ticket now has zero or more rows in ticket_technicians). v-model is a
 * plain array of employee ids, so callers just do
 * `v-model="form.technician_ids"` / `patch({ technician_ids: ids })`.
 */
import { useRefData } from '../stores';

const props = defineProps({ modelValue: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue']);

const refData = useRefData();

function toggle(id) {
  const next = new Set(props.modelValue);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emit('update:modelValue', Array.from(next));
}
</script>

<template>
  <ul class="checklist">
    <li v-if="!refData.employees.length" class="muted small">No technicians on file.</li>
    <li v-for="e in refData.employees" :key="e.id">
      <input
        type="checkbox" :checked="modelValue.includes(e.id)"
        @change="toggle(e.id)"
      />
      <span>{{ e.name }} <span class="muted small">({{ e.role }})</span></span>
    </li>
  </ul>
</template>
