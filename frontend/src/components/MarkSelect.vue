<script setup>
/**
 * Mark (Rhodes generation) for one instrument -- migration 086.
 *
 * v-model is the piece's *override*: '' means "whatever its model says"
 * (the catalog mark, shown in the blank option as "Mark I (from model)"),
 * a key means this piece differs from stock. The API stores a value equal
 * to the model's own mark as no override, so picking the same Mark the
 * model already has is harmless. Renders nothing for a family without
 * Marks.
 */
import { computed } from 'vue';
import { useRefData } from '../stores';

const props = defineProps({
  family: { type: String, default: '' },
  catalogMark: { type: String, default: null }, // the picked model's (inherited) mark
  modelValue: { type: String, default: '' },
  label: { type: String, default: 'Mark' },
});
const emit = defineEmits(['update:modelValue']);
const refData = useRefData();

const marks = computed(() => refData.marksFor(props.family));
const blankLabel = computed(() => (props.catalogMark
  ? `${refData.markLabel(props.family, props.catalogMark)} (from model)`
  : '—'));
</script>

<template>
  <div v-if="marks.length" class="field">
    <label>{{ label }}</label>
    <select :value="modelValue || ''" @change="emit('update:modelValue', $event.target.value)">
      <option value="">{{ blankLabel }}</option>
      <option v-for="m in marks" :key="m.key" :value="m.key">
        {{ m.label }} ({{ m.years }}){{ m.key === catalogMark ? '' : (catalogMark ? ' — differs from model' : '') }}
      </option>
    </select>
  </div>
</template>
