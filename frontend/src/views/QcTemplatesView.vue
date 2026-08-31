<script setup>
/**
 * QC checklist templates (Settings -> QC templates). Admin screen for
 * managing `qc_templates` rows — the actual checklist content (`items`:
 * [{label, note}]) a tech works through in TicketQc.vue and signs off on.
 *
 * Rigor tiers are retired (migration 021): a template's stage in the
 * progression is now `round_number`, scoped within its (family, kind) —
 * e.g. Wurlitzer/qc round 1 is a different row from Wurlitzer/qc round 2.
 * Rounds always run in that order on a ticket (routes/qc.js assigns the
 * next round_number automatically; there's no picker that could start
 * round 2 before round 1), so the templates list below is grouped and
 * sorted the same way — round 1 always listed before round 2 for a given
 * family, so the progression reads top-to-bottom exactly how it plays out
 * on a ticket.
 *
 * `family` is nullable by design (migration 001): NULL means "applies to
 * every instrument family," a specific family means the template only
 * shows up for tickets on that family's instruments.
 */
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useRefData } from '../stores';

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

// Round order is the point: within a matching family+kind, round 1 always
// sorts before round 2. family NULLS LAST mirrors the backend's own
// family-specific-before-general precedence (routes/qc.js).
const filtered = computed(() => templates.value
  .filter((t) => (
    (showInactive.value || t.active)
    && (!familyFilter.value || t.family === familyFilter.value)
    && (!kindFilter.value || t.kind === kindFilter.value)
  ))
  .sort((a, b) => {
    // Family-agnostic (null) rows sort after every specific family, same
    // NULLS LAST precedence as the backend uses when resolving a round's
    // template (routes/qc.js) — this list reads in the same order a
    // ticket's rounds would actually pick templates in.
    if ((a.family || null) !== (b.family || null)) {
      if (!a.family) return 1;
      if (!b.family) return -1;
      return a.family.localeCompare(b.family);
    }
    return a.kind.localeCompare(b.kind) || a.round_number - b.round_number;
  }));

// --- create --------------------------------------------------------------
const showNew = ref(false);
const blankForm = () => ({
  name: '', family: '', kind: 'qc', round_number: 1,
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
  try {
    const created = await api.post('/qc/templates', {
      name: form.value.name.trim(),
      family: form.value.family || null,
      kind: form.value.kind,
      round_number: Number(form.value.round_number) || 1,
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

// --- edit template's own fields (name/family/kind/round), autosaved like ---
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
          Every instrument type works through the same standardized round progression —
          Round 1, Round 2, and so on, always in that order on a ticket. Give a round's
          template a specific instrument type to have it show up only for that type;
          leave it blank to apply to every type that doesn't have its own.
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'settings' }">← Settings</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="card" style="margin-bottom: 16px">
      <div class="field" style="margin-bottom: 12px">
        <label>Instrument type</label>
        <div class="row">
          <button
            type="button" :class="familyFilter === '' ? 'primary' : 'small'"
            @click="familyFilter = ''"
          >All types</button>
          <button
            v-for="f in refData.families" :key="f" type="button"
            :class="familyFilter === f ? 'primary' : 'small'"
            @click="familyFilter = f"
          >{{ f }}</button>
        </div>
      </div>

      <div class="field" style="margin-bottom: 0">
        <label>Category</label>
        <div class="row">
          <button
            type="button" :class="kindFilter === '' ? 'primary' : 'small'"
            @click="kindFilter = ''"
          >All categories</button>
          <button
            v-for="[k, label] in KINDS" :key="k" type="button"
            :class="kindFilter === k ? 'primary' : 'small'"
            @click="kindFilter = k"
          >{{ label }}</button>
        </div>
      </div>

      <div class="row" style="margin-top: 14px">
        <label class="checkbox">
          <input v-model="showInactive" type="checkbox" />
          <span class="small">Show retired</span>
        </label>
        <div class="spacer" />
        <button class="small" @click="showNew ? (showNew = false) : openNew()">
          {{ showNew ? 'Cancel' : '+ New template' }}
        </button>
      </div>
    </div>

    <form v-if="showNew" class="card tight" style="margin-bottom: 16px" @submit.prevent="createTemplate">
      <div class="field-row" style="align-items: end">
        <div class="field" style="flex: 2; margin: 0">
          <label>Name *</label>
          <input v-model="form.name" required placeholder="Rhodes — round 1" />
        </div>
        <div class="field" style="margin: 0">
          <label>Instrument type</label>
          <select v-model="form.family">
            <option value="">All types</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Category</label>
          <select v-model="form.kind">
            <option v-for="[k, label] in KINDS" :key="k" :value="k">{{ label }}</option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Round *</label>
          <input v-model="form.round_number" type="number" min="1" step="1" style="width: 90px" />
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
          <span class="row" style="gap: 4px; flex: none">
            <label class="small muted" style="margin: 0">Round</label>
            <input
              :value="t.round_number" type="number" min="1" step="1" style="width: 70px"
              @change="updateField(t, { round_number: Number($event.target.value) || 1 })"
            />
          </span>
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
