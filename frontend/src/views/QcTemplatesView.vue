<script setup>
/**
 * QC checklist templates (Settings -> QC templates). Admin screen for
 * managing `qc_templates` rows — the actual checklist content (`items`:
 * [{label, note}]) a tech works through in TicketQc.vue and signs off on.
 * Settings' own "QC rigor tiers" table only configures the required-
 * rounds/two-reviewer *rules*; the checklist text itself previously had no
 * UI at all — it only existed via the seed script or raw API calls (see
 * NOTES.md).
 *
 * `family` is nullable by design (migration 001): NULL means "applies to
 * every instrument family," a specific family means the template only
 * shows up for tickets on that family's instruments. TicketQc.vue's
 * template dropdown already requests `?family=<ticket's instrument
 * family>`, and GET /qc/templates already returns that family's rows
 * *and* the family-NULL ones together — so a different checklist per
 * instrument type was already fully supported by the data model. This
 * screen is what was missing: a way to actually create one per type
 * without touching the seed script or hand-rolling API calls.
 */
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const settings = useSettings();
const refData = useRefData();

const KINDS = [
  ['qc', 'Quality control'],
  ['shipping', 'Shipping'],
  ['evaluation', 'Evaluation'],
];

const templates = ref([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

const familyFilter = ref('');
const kindFilter = ref('');
const showInactive = ref(false);

async function load() {
  loading.value = true;
  try {
    // Always pulls every template (active + retired) — filtering for the
    // "Show retired" checkbox happens client-side below, same pattern as
    // FleetView's family filter, so toggling it doesn't need a re-fetch.
    templates.value = await api.get('/qc/templates', { include_inactive: 'true' });
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const filtered = computed(() => templates.value.filter((t) => (
  (showInactive.value || t.active)
  && (!familyFilter.value || t.family === familyFilter.value)
  && (!kindFilter.value || t.kind === kindFilter.value)
)));

// --- create --------------------------------------------------------------
const showNew = ref(false);
const blankForm = () => ({
  name: '', family: '', kind: 'qc', tier_key: settings.active('qc_tier')[0]?.key || '',
});
const form = ref(blankForm());

function openNew() {
  form.value = blankForm();
  showNew.value = true;
}

async function createTemplate() {
  error.value = '';
  notice.value = '';
  if (!form.value.name.trim()) { error.value = 'Name is required'; return; }
  if (!form.value.tier_key) { error.value = 'Rigor tier is required'; return; }
  try {
    const created = await api.post('/qc/templates', {
      name: form.value.name.trim(),
      family: form.value.family || null,
      kind: form.value.kind,
      tier_key: form.value.tier_key,
      items: [],
    });
    showNew.value = false;
    notice.value = `Created "${created.name}" — add checklist items below.`;
    await load();
    openItems(created);
  } catch (err) {
    error.value = err.message;
  }
}

// --- edit template's own fields (name/family/kind/tier), autosaved like ---
// --- Settings' other tables -----------------------------------------------
async function updateField(t, patch) {
  error.value = '';
  notice.value = '';
  try {
    await api.patch(`/qc/templates/${t.id}`, patch);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// --- items editor: buffered per-template until "Save checklist" ----------
const openId = ref(null);
const drafts = ref({});

function openItems(t) {
  drafts.value[t.id] = (t.items || []).map((i) => ({ ...i }));
  openId.value = t.id;
}
function closeItems() {
  openId.value = null;
}
function addItem(id) {
  drafts.value[id].push({ label: '', note: '' });
}
function removeItem(id, index) {
  drafts.value[id].splice(index, 1);
}
function moveItem(id, index, delta) {
  const arr = drafts.value[id];
  const target = index + delta;
  if (target < 0 || target >= arr.length) return;
  [arr[index], arr[target]] = [arr[target], arr[index]];
}

async function saveItems(t) {
  error.value = '';
  notice.value = '';
  const items = (drafts.value[t.id] || [])
    .map((i) => ({ label: (i.label || '').trim(), note: (i.note || '').trim() || null }))
    .filter((i) => i.label);
  try {
    await api.patch(`/qc/templates/${t.id}`, { items });
    notice.value = `Saved "${t.name}".`;
    openId.value = null;
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
        <h1 style="margin-bottom: 4px">QC checklist templates</h1>
        <p class="muted small" style="margin: 0">
          A template's items are what a tech checks off during a QC round or a
          shipment pack-out. Give one a specific instrument type to have it show
          up only for that type's tickets — leave it blank to apply to every type.
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'settings' }">← Settings</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="card" style="margin-bottom: 16px">
      <div class="row">
        <div class="field" style="margin: 0">
          <label>Instrument type</label>
          <select v-model="familyFilter" style="width: auto; min-width: 160px">
            <option value="">All types</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Kind</label>
          <select v-model="kindFilter" style="width: auto; min-width: 160px">
            <option value="">All kinds</option>
            <option v-for="[k, label] in KINDS" :key="k" :value="k">{{ label }}</option>
          </select>
        </div>
        <label class="checkbox" style="margin-top: 18px">
          <input v-model="showInactive" type="checkbox" />
          <span class="small">Show retired</span>
        </label>
        <div class="spacer" />
        <button class="small" style="margin-top: 18px" @click="showNew ? (showNew = false) : openNew()">
          {{ showNew ? 'Cancel' : '+ New template' }}
        </button>
      </div>
    </div>

    <form v-if="showNew" class="card tight" style="margin-bottom: 16px" @submit.prevent="createTemplate">
      <div class="field-row" style="align-items: end">
        <div class="field" style="flex: 2; margin: 0">
          <label>Name *</label>
          <input v-model="form.name" required placeholder="Rhodes — full restoration QC" />
        </div>
        <div class="field" style="margin: 0">
          <label>Instrument type</label>
          <select v-model="form.family">
            <option value="">All types</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Kind</label>
          <select v-model="form.kind">
            <option v-for="[k, label] in KINDS" :key="k" :value="k">{{ label }}</option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Rigor tier *</label>
          <select v-model="form.tier_key">
            <option v-for="t in settings.active('qc_tier')" :key="t.key" :value="t.key">
              {{ t.label }}
            </option>
          </select>
        </div>
        <div class="field" style="flex: none; margin: 0">
          <button class="primary" type="submit">Create</button>
        </div>
      </div>
    </form>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!filtered.length" class="empty">No templates match this filter.</div>

    <div v-else class="stack">
      <div v-for="t in filtered" :key="t.id" class="card">
        <div class="row">
          <input
            :value="t.name" style="min-width: 220px; font-weight: 600"
            @change="updateField(t, { name: $event.target.value })"
          />
          <select
            :value="t.family || ''"
            @change="updateField(t, { family: $event.target.value || null })"
          >
            <option value="">All types</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
          <select :value="t.kind" @change="updateField(t, { kind: $event.target.value })">
            <option v-for="[k, label] in KINDS" :key="k" :value="k">{{ label }}</option>
          </select>
          <select :value="t.tier_key" @change="updateField(t, { tier_key: $event.target.value })">
            <option v-for="tier in settings.active('qc_tier')" :key="tier.key" :value="tier.key">
              {{ tier.label }}
            </option>
          </select>
          <span :class="['pill', t.active ? 'green' : 'slate']">
            {{ t.active ? 'Active' : 'Retired' }}
          </span>
          <div class="spacer" />
          <span class="muted small">
            {{ (t.items || []).length }} item{{ (t.items || []).length === 1 ? '' : 's' }}
          </span>
          <button class="small" @click="openId === t.id ? closeItems() : openItems(t)">
            {{ openId === t.id ? 'Close' : 'Edit checklist' }}
          </button>
          <button class="small" @click="updateField(t, { active: !t.active })">
            {{ t.active ? 'Retire' : 'Restore' }}
          </button>
        </div>

        <div v-if="openId === t.id" class="card tight" style="margin-top: 12px">
          <div v-if="!drafts[t.id].length" class="empty" style="padding: 16px">
            No items yet — add the first one below.
          </div>
          <ul v-else class="checklist" style="margin-bottom: 12px">
            <li v-for="(item, i) in drafts[t.id]" :key="i">
              <input v-model="item.label" placeholder="Checklist item" style="flex: 2" />
              <input v-model="item.note" placeholder="Note (optional)" style="flex: 2" />
              <button class="small" :disabled="i === 0" @click="moveItem(t.id, i, -1)">↑</button>
              <button
                class="small" :disabled="i === drafts[t.id].length - 1"
                @click="moveItem(t.id, i, 1)"
              >↓</button>
              <button class="small danger" @click="removeItem(t.id, i)">Remove</button>
            </li>
          </ul>
          <div class="row">
            <button class="small" @click="addItem(t.id)">+ Add item</button>
            <div class="spacer" />
            <button class="primary" @click="saveItems(t)">Save checklist</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
