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
 *
 * Migration 086: the instrument now remembers *which* catalog node it is,
 * not just the text. `v-model:model-id` carries the deepest picked node's
 * id (null for typed-in text -- the API links typed text itself when it
 * names exactly one model), and a `facts` event hands the parent that
 * node's inherited facts ({ attrs, key_count, is_suitcase }, straight from
 * GET /instrument-models, i.e. the instrument_model_facts view) so a form
 * can show "Mark I (from model)" before anything is saved. An existing
 * value opens on its node when it has a model_id, even if the node has
 * since been renamed or deactivated.
 */
import { ref, computed, watch } from 'vue';
import api from '../api';

const props = defineProps({
  family: { type: String, default: '' },
  modelValue: { type: String, default: '' },
  modelId: { type: Number, default: null },
});
const emit = defineEmits(['update:modelValue', 'update:modelId', 'facts']);

const nodes = ref([]); // every node for the current family, flat (inactive ones only offered on the current path)
const manual = ref(false);
const manualText = ref('');
// One entry per depth reached so far: the id chosen at that level.
const path = ref([]);

function childrenOf(parentId) {
  return nodes.value
    .filter((n) => (n.parent_id || null) === parentId && (n.active || path.value.includes(n.id)))
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

// A family whose tree comes back empty has nothing to pick from, so start
// on the free-text box instead. (This used to special-case the 'other'
// family, which never had a tree; it's part of Kombo+ since migration 083,
// which does -- the organ brands -- and an amp or synth goes in the
// free-text option.) `initial` is the first run on mount: a value that
// already exists (editing, or a restored draft) is kept as the text rather
// than cleared; after a brand change the old model no longer applies.

function defaultToManual(initial) {
  if (manual.value) return;
  manual.value = true;
  path.value = [];
  if (initial) {
    manualText.value = props.modelValue || '';
  } else {
    manualText.value = '';
    emit('update:modelValue', '');
  }
}

async function loadFamily(family, oldFamily) {
  const initial = oldFamily === undefined;
  nodes.value = [];
  path.value = [];
  if (!initial) { manual.value = false; manualText.value = ''; emitPicked(); } // a brand change drops the old link
  if (!family) return;
  const loaded = await api.get(`/instrument-models?family=${encodeURIComponent(family)}&include_inactive=true`);
  if (props.family !== family) return; // brand changed again while loading
  nodes.value = loaded;
  if (!loaded.filter((n) => n.active).length) defaultToManual(initial);
}

function nameChain() {
  return path.value
    .map((id) => nodes.value.find((n) => n.id === id))
    .filter(Boolean)
    .map((n) => n.name)
    .join(' / ');
}

// The deepest picked node (or none, when typing) -> its id and facts.
function emitPicked() {
  const id = manual.value ? null : (path.value[path.value.length - 1] ?? null);
  const node = id ? nodes.value.find((n) => n.id === id) : null;
  emit('update:modelId', id);
  emit('facts', node
    ? { attrs: node.effective_attrs || {}, key_count: node.effective_key_count ?? null, is_suitcase: !!node.effective_is_suitcase }
    : null);
}

function pickAt(depth, id) {
  const numId = id ? Number(id) : null;
  path.value = path.value.slice(0, depth);
  if (numId) {
    path.value.push(numId);
    manual.value = false;
  }
  emit('update:modelValue', nameChain());
  emitPicked();
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
  emitPicked();
}

watch(manualText, (v) => { if (manual.value) emit('update:modelValue', v); });

watch(() => props.family, loadFamily, { immediate: true });

// If a value already exists (editing, or a family with no tree yet) and it
// doesn't match anything walkable in the tree, treat it as manual text
// rather than silently discarding it or forcing a re-pick.
watch([() => props.modelValue, nodes], () => {
  if (manual.value || path.value.length) return;
  // A linked instrument opens on its node (and its ancestors) -- by id, so
  // a renamed node or text that no longer matches the chain still works.
  if (props.modelId && nodes.value.length) {
    const byId = new Map(nodes.value.map((n) => [n.id, n]));
    const chain = [];
    for (let n = byId.get(props.modelId); n && chain.length <= byId.size; n = n.parent_id ? byId.get(n.parent_id) : null) {
      chain.unshift(n.id);
    }
    if (chain.length) { path.value = chain; return; }
  }
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
    <div v-if="!family" class="muted small">Pick a brand first.</div>
    <template v-else>
      <select
        v-for="(options, depth) in levels" :key="depth"
        :value="path[depth] || ''"
        @change="pickAt(depth, $event.target.value)"
      >
        <option value="">{{ depth === 0 ? 'Choose a model…' : 'Choose…' }}</option>
        <option v-for="n in options" :key="n.id" :value="n.id">{{ n.name }}</option>
      </select>
      <label class="checkbox small manual-toggle">
        <input type="checkbox" :checked="manual" @change="toggleManual($event.target.checked)" />
        <span>Type it in instead</span>
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
/* The global `input` rule (full width, 40px tall) would otherwise stretch
   the checkbox; keep it a normal-sized box beside its label. */
.manual-toggle { margin: 0; gap: 6px; cursor: pointer; }
.manual-toggle input[type='checkbox'] {
  width: 16px; height: 16px; min-height: 16px; padding: 0; margin: 0;
  flex: none; accent-color: var(--accent); cursor: pointer;
}
</style>
