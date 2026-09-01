<script setup>
/**
 * N7 (boss-list scope, scaffold — see migration 036 and NOTES.md). A
 * cascading picker over instrument_models' ragged tree, meant to help fill
 * the plain-text `model` field rather than replace it: v-model is just a
 * string, same as the `<input v-model="instrument.model">` it's dropped in
 * to replace, so a form that adopts this component doesn't change shape
 * anywhere else (submit payloads, backend validation, etc. are untouched).
 *
 * Ragged depth is treated as a first-class UX property, not just a schema
 * one: every level change emits the joined ancestor-path string, not only
 * a true leaf, so a user can stop at whatever depth this family's tree
 * actually goes (some families are just "1970s" -> "Mark I" -> "Stage 73",
 * others are one flat list) and that partial selection is already a valid,
 * usable value. A manual free-text fallback is always offered — not only
 * where `allow_manual` is set — since the tree is placeholder seed data
 * right now (the boss's real list arrives later as a CSV; see NOTES.md)
 * and forcing a pick from it today would just get in the way.
 */
import { ref, computed, watch } from 'vue';
import api from '../api';

const props = defineProps({
  family: { type: String, default: '' },
  modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const nodes = ref([]); // every active node for the current family, flat
const manual = ref(false);
const manualText = ref('');
// One entry per depth reached so far: the id chosen at that level.
const path = ref([]);

function childrenOf(parentId) {
  return nodes.value
    .filter((n) => (n.parent_id || null) === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

// Root options, then one more select per chosen level's children — stops
// naturally once a chosen node has no children left to descend into.
const levels = computed(() => {
  const out = [childrenOf(null)];
  for (const id of path.value) {
    const kids = childrenOf(id);
    if (kids.length) out.push(kids);
    else break;
  }
  return out;
});

async function loadFamily() {
  nodes.value = [];
  path.value = [];
  if (!props.family) return;
  nodes.value = await api.get(`/instrument-models?family=${encodeURIComponent(props.family)}`);
}

function nameChain() {
  return path.value
    .map((id) => nodes.value.find((n) => n.id === id))
    .filter(Boolean)
    .map((n) => n.name)
    .join(' / ');
}

function pickAt(depth, id) {
  const numId = id ? Number(id) : null;
  path.value = path.value.slice(0, depth);
  if (numId) {
    path.value.push(numId);
    manual.value = false;
  }
  emit('update:modelValue', nameChain());
}

function toggleManual(checked) {
  manual.value = checked;
  if (checked) {
    path.value = [];
    emit('update:modelValue', manualText.value);
  } else {
    manualText.value = '';
    emit('update:modelValue', nameChain());
  }
}

watch(manualText, (v) => { if (manual.value) emit('update:modelValue', v); });

watch(() => props.family, loadFamily, { immediate: true });

// If a value already exists (editing, or a family with no tree yet) and it
// doesn't match anything walkable in the tree, treat it as manual text
// rather than silently discarding it or forcing a re-pick.
watch([() => props.modelValue, nodes], () => {
  if (manual.value || path.value.length) return;
  if (!props.modelValue) return;
  const parts = props.modelValue.split(' / ');
  let parentId = null;
  const found = [];
  for (const part of parts) {
    const match = childrenOf(parentId).find((n) => n.name === part);
    if (!match) { found.length = 0; break; }
    found.push(match.id);
    parentId = match.id;
  }
  if (found.length) path.value = found;
  else { manual.value = true; manualText.value = props.modelValue; }
}, { immediate: true });
</script>

<template>
  <div class="model-picker">
    <div v-if="!family" class="muted small">Pick a family first.</div>
    <template v-else>
      <select
        v-for="(options, depth) in levels" :key="depth"
        :value="path[depth] || ''"
        @change="pickAt(depth, $event.target.value)"
      >
        <option value="">{{ depth === 0 ? 'Choose a model…' : 'Choose…' }}</option>
        <option v-for="n in options" :key="n.id" :value="n.id">{{ n.name }}</option>
      </select>
      <label class="small">
        <input type="checkbox" :checked="manual" @change="toggleManual($event.target.checked)" /> Type it in instead
      </label>
      <input
        v-if="manual" v-model="manualText"
        placeholder="Model (free text)"
      />
    </template>
  </div>
</template>

<style scoped>
.model-picker { display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-start; }
.model-picker select, .model-picker input[type='text'], .model-picker input:not([type]) { width: 100%; }
</style>
