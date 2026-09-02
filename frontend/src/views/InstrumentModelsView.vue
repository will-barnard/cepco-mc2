<script setup>
/**
 * Instrument models (Settings -> Instrument models, N7 on the boss list —
 * scaffold only, see migration 036 and NOTES.md §2.39). Admin CRUD over
 * instrument_models, one family tab at a time, so the boss's real list can
 * be entered a family at a time once it arrives as a CSV. Same "inline
 * rows, autosave on change" shape as RecurringTicketsView.vue and
 * ProceduresView.vue — there's no bulk import here yet, just the
 * structural pieces (add/edit/delete a node, reparent it, mark it
 * manual-entry-only or inactive).
 */
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useRefData } from '../stores';

const refData = useRefData();

const family = ref('');
const nodes = ref([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

async function load() {
  if (!family.value) { nodes.value = []; return; }
  loading.value = true;
  error.value = '';
  try {
    nodes.value = await api.get('/instrument-models', { family: family.value, include_inactive: 'true' });
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await refData.load();
  family.value = refData.families[0] || '';
});
watch(family, load, { immediate: true });

function childrenOf(parentId) {
  return nodes.value
    .filter((n) => (n.parent_id || null) === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

// Flattened for display with a depth so the template can indent each row
// under its parent — the tree is ragged, so depth varies row to row.
const rows = computed(() => {
  const out = [];
  const walk = (parentId, depth) => {
    for (const n of childrenOf(parentId)) {
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
});

// --- create --------------------------------------------------------------
const showNew = ref(false);
const blankForm = () => ({
  name: '', parent_id: '', allow_manual: false, is_suitcase: false,
});
const form = ref(blankForm());

function openNew() {
  form.value = blankForm();
  showNew.value = true;
}

async function createNode() {
  error.value = '';
  notice.value = '';
  if (!form.value.name.trim()) { error.value = 'Name is required'; return; }
  try {
    await api.post('/instrument-models', {
      family: family.value,
      name: form.value.name.trim(),
      parent_id: form.value.parent_id || null,
      allow_manual: form.value.allow_manual,
      is_suitcase: form.value.is_suitcase,
    });
    showNew.value = false;
    notice.value = 'Node added.';
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// --- inline edit -----------------------------------------------------------
async function updateNode(n, patch) {
  error.value = '';
  notice.value = '';
  try {
    await api.patch(`/instrument-models/${n.id}`, patch);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

async function removeNode(n) {
  error.value = '';
  try {
    await api.del(`/instrument-models/${n.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Instrument models</h1>
        <p class="muted small" style="margin: 0">
          Scaffold only — this is a placeholder tree, not the real model list yet. Deleting a
          node also deletes everything under it. Each family's picker on the ticket/estimate/
          purchase forms always offers "type it in instead" too, so an incomplete tree here
          never blocks anyone from recording a model.
        </p>
      </div>
      <div class="row">
        <RouterLink class="btn small" :to="{ name: 'settings' }">← Settings</RouterLink>
        <button class="small" @click="showNew ? (showNew = false) : openNew()" :disabled="!family">
          {{ showNew ? 'Cancel' : '+ New node' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="row" style="margin-bottom: 16px">
      <button
        v-for="f in refData.families" :key="f" type="button"
        :class="family === f ? 'primary' : 'small'"
        @click="family = f"
      >{{ refData.familyLabel(f) }}</button>
    </div>

    <form v-if="showNew" class="card tight" style="margin-bottom: 16px" @submit.prevent="createNode">
      <div class="field-row" style="align-items: end">
        <div class="field" style="flex: 2; margin: 0">
          <label>Name *</label>
          <input v-model="form.name" required placeholder="Mark I" />
        </div>
        <div class="field" style="margin: 0">
          <label>Parent (blank = top level)</label>
          <select v-model="form.parent_id">
            <option value="">— top level —</option>
            <option v-for="n in rows" :key="n.id" :value="n.id">
              {{ '—'.repeat(n.depth) }} {{ n.name }}
            </option>
          </select>
        </div>
        <div class="field" style="flex: none; margin: 0">
          <button class="primary" type="submit">Add</button>
        </div>
      </div>
      <label class="checkbox" style="margin-top: 12px">
        <input v-model="form.allow_manual" type="checkbox" />
        <span class="small">Also offer "type it in" alongside this node's children (e.g. a catch-all "Other")</span>
      </label>
      <label class="checkbox" style="margin-top: 8px">
        <input v-model="form.is_suitcase" type="checkbox" />
        <span class="small">
          Suitcase-style / self-contained amp (N10) — the estimate wizard's Electronics screen only shows
          for an instrument picked from a node flagged this way
        </span>
      </label>
    </form>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!rows.length" class="empty">No models yet for this family.</div>
    <div v-else class="stack">
      <div v-for="n in rows" :key="n.id" class="card tight">
        <div class="row">
          <span :style="{ display: 'inline-block', width: `${n.depth * 18}px` }" />
          <input
            :value="n.name" style="min-width: 180px; font-weight: 600"
            @change="updateNode(n, { name: $event.target.value })"
          />
          <label class="checkbox">
            <input
              type="checkbox" :checked="n.allow_manual"
              @change="updateNode(n, { allow_manual: $event.target.checked })"
            />
            <span class="small">Allow manual</span>
          </label>
          <label class="checkbox" title="Suitcase-style / self-contained amp — gates the estimate wizard's Electronics screen">
            <input
              type="checkbox" :checked="n.is_suitcase"
              @change="updateNode(n, { is_suitcase: $event.target.checked })"
            />
            <span class="small">Suitcase</span>
          </label>
          <span :class="['pill', n.active ? 'green' : 'slate']">{{ n.active ? 'Active' : 'Inactive' }}</span>
          <div class="spacer" />
          <button class="small" @click="updateNode(n, { active: !n.active })">
            {{ n.active ? 'Deactivate' : 'Reactivate' }}
          </button>
          <button class="small" title="Delete (and everything under it)" @click="removeNode(n)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>
