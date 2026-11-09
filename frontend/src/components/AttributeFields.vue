<script setup>
/**
 * One dropdown per instrument attribute that applies to the family -- Mark,
 * suitcase amp, ... (migration 089) -- or a checkbox for a one-option flag
 * (Chopped, migration 091). Renders bare `.field`s, so it sits inside
 * whatever field-row the form already has.
 *
 * v-model is the piece's overrides ({ key: value }); the blank option means
 * "as the model says" and names what that is ("Janus (from model)"). The
 * API stores a value equal to the model's own as no override, so picking
 * the same thing the model has is harmless.
 */
import { computed } from 'vue';
import { useRefData } from '../stores';
import { attributesFor, valueLabel } from '../instrumentAttrs';

const props = defineProps({
  family: { type: String, default: '' },
  modelValue: { type: Object, default: () => ({}) },
  catalogAttrs: { type: Object, default: () => ({}) }, // the picked model's (inherited) attrs
  // The picked model is a suitcase (true), known not to be (false), or
  // there's no model to ask (null) -- decides whether the amp shows.
  suitcase: { type: Boolean, default: null },
  // Same three-way answer for "is the picked model a console" (Chopped).
  console: { type: Boolean, default: null },
});
const emit = defineEmits(['update:modelValue']);
const refData = useRefData();

const shown = computed(() => attributesFor(refData.attributes, props.family, {
  suitcase: props.suitcase,
  console: props.console,
  values: { ...(props.catalogAttrs || {}), ...(props.modelValue || {}) },
}));

function blankLabel(a) {
  const fromModel = (props.catalogAttrs || {})[a.key];
  return fromModel ? `${valueLabel(refData.attributes, a.key, props.family, fromModel)} (from model)` : '—';
}

function set(key, value) {
  const next = { ...(props.modelValue || {}) };
  if (value) next[key] = value; else delete next[key];
  emit('update:modelValue', next);
}
</script>

<template>
  <div v-for="a in shown" :key="a.key" class="field">
    <label>{{ a.label }}</label>
    <label v-if="a.flag" class="checkbox flag-check" :title="a.families[family][0].hint">
      <input
        type="checkbox" :checked="!!(modelValue || {})[a.key]"
        @change="set(a.key, $event.target.checked ? a.families[family][0].key : '')"
      />
      <span class="small">{{ a.families[family][0].hint || a.families[family][0].label }}</span>
    </label>
    <select v-else :value="(modelValue || {})[a.key] || ''" @change="set(a.key, $event.target.value)">
      <option value="">{{ blankLabel(a) }}</option>
      <option v-for="o in a.families[family]" :key="o.key" :value="o.key">
        {{ o.label }}{{ o.hint ? ` (${o.hint})` : '' }}
      </option>
    </select>
  </div>
</template>

<style scoped>
/* Line up with the dropdowns beside it. */
.flag-check { min-height: 38px; align-items: center; }
</style>
