<script setup>
/**
 * Standard procedures (Settings -> Standard procedures). Admin screen for
 * `standard_procedures` — the price/hours catalog the Estimates builder
 * (EstimateNewView.vue) picks from. Same shape of screen as
 * QcTemplatesView.vue: filter by instrument type, inline-editable fields
 * that autosave on change, Retire/Restore instead of delete.
 *
 * A procedure prices either as an hours range (billed at the shop's labor
 * rate, shown here for reference but set on the Shop configuration card
 * above, not here) or a flat cost — never both, enforced both by the DB
 * (migration 010's CHECK) and by only ever showing the fields for whichever
 * pricing type is currently selected.
 */
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const settings = useSettings();
const refData = useRefData();

const procedures = ref([]);
const laborRate = ref(null);
const loading = ref(true);
const error = ref('');
const notice = ref('');

const familyFilter = ref('');
const showInactive = ref(false);

async function load() {
  loading.value = true;
  try {
    procedures.value = await api.get('/procedures', { include_inactive: 'true' });
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  await load();
  try {
    const res = await api.get('/estimates/labor-rate');
    laborRate.value = res.labor_rate;
  } catch {
    laborRate.value = null;
  }
});

const filtered = computed(() => procedures.value.filter((p) => (
  (showInactive.value || p.active)
  && (!familyFilter.value || p.family === familyFilter.value)
)));

// Parts-by-variant (migration 043) — a procedure prices its parts either
// nothing at all (hours-only labor), a single flat amount, or one of
// these four key-count columns, never a mix. `outlier_hours` (same
// migration) only applies to hours-based procedures — see NOTES.md and
// routes/quotes.js's outlierBufferFor for what it feeds into.
const VARIANT_FIELDS = [
  { key: 'piano_bass', label: 'Piano Bass' },
  { key: '54_key', label: '54-Key' },
  { key: '73_key', label: '73-Key' },
  { key: '88_key', label: '88-Key' },
];

// N10: which of the estimate wizard's screens 3-6 (EstimateNewView.vue)
// this procedure shows up on — see migration 045 and routes/procedures.js's
// CATEGORY_KEYS, which this mirrors. "— none —" is a real, valid choice
// (the wizard buckets it under Standard Setup & Actions rather than
// hiding it), not just a placeholder.
const CATEGORY_FIELDS = [
  { key: 'standard_setup', label: 'Standard Setup & Actions' },
  { key: 'electronics', label: 'Electronics' },
  { key: 'cosmetics', label: 'Cosmetics' },
  { key: 'parts', label: 'Parts' },
];

// --- create ----------------------------------------------------------------
const showNew = ref(false);
const blankForm = () => ({
  name: '', family: '', pricing_type: 'hours', min_hours: '', max_hours: '', outlier_hours: '',
  parts_mode: 'none', flat_cost: '',
  parts_cost_piano_bass: '', parts_cost_54_key: '', parts_cost_73_key: '', parts_cost_88_key: '',
  description: '', default_tech_level_key: '', category: '',
});
const form = ref(blankForm());

// A flat-priced procedure has nowhere else to get its price from, so
// 'none' isn't a valid parts mode for it — flip away from 'none'
// automatically rather than letting the API reject the submit.
watch(() => form.value.pricing_type, (val) => {
  if (val === 'flat' && form.value.parts_mode === 'none') form.value.parts_mode = 'flat';
});

function openNew() {
  form.value = blankForm();
  showNew.value = true;
}

async function createProcedure() {
  error.value = '';
  notice.value = '';
  if (!form.value.name.trim()) { error.value = 'Name is required'; return; }
  const isVariant = form.value.parts_mode === 'variant';
  const isFlatParts = form.value.parts_mode === 'flat';
  try {
    await api.post('/procedures', {
      name: form.value.name.trim(),
      family: form.value.family || null,
      pricing_type: form.value.pricing_type,
      min_hours: form.value.pricing_type === 'hours' ? form.value.min_hours : null,
      max_hours: form.value.pricing_type === 'hours' ? form.value.max_hours : null,
      outlier_hours: form.value.pricing_type === 'hours' ? (form.value.outlier_hours || null) : null,
      flat_cost: isFlatParts ? form.value.flat_cost : null,
      parts_cost_piano_bass: isVariant ? (form.value.parts_cost_piano_bass || null) : null,
      parts_cost_54_key: isVariant ? (form.value.parts_cost_54_key || null) : null,
      parts_cost_73_key: isVariant ? (form.value.parts_cost_73_key || null) : null,
      parts_cost_88_key: isVariant ? (form.value.parts_cost_88_key || null) : null,
      description: form.value.description || null,
      // N8: lets tasks created from this procedure (TicketTasks.vue) arrive
      // pre-tagged with the level its work usually calls for.
      default_tech_level_key: form.value.default_tech_level_key || null,
      // N10: which estimate-wizard screen this shows up on — see CATEGORY_FIELDS above.
      category: form.value.category || null,
    });
    showNew.value = false;
    notice.value = 'Procedure created.';
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// --- inline edit -------------------------------------------------------------
// Every field on this page autosaves on change through here, so this
// runs constantly while someone's scrolled deep into a long list.
// Re-fetching the whole list (the old `await load()`) flips `loading`
// true, which unmounts the entire table behind the "Loading…" placeholder
// and remounts it fresh once the request comes back — collapsing the
// page and jumping the scroll position to the top on every single edit.
// PATCH already returns the updated row (`RETURNING *`), so splice just
// that row back into place instead: no refetch, no loading flicker, and
// Vue only touches the one row's DOM rather than remounting the list.
async function updateField(p, patch) {
  error.value = '';
  notice.value = '';
  try {
    const updated = await api.patch(`/procedures/${p.id}`, patch);
    const idx = procedures.value.findIndex((row) => row.id === p.id);
    if (idx !== -1) procedures.value.splice(idx, 1, updated);
  } catch (err) {
    error.value = err.message;
  }
}

function setPricingType(p, pricingType) {
  if (pricingType === 'hours') {
    updateField(p, { pricing_type: 'hours', min_hours: p.min_hours || 0, max_hours: p.max_hours || 0 });
    return;
  }
  // A flat-priced procedure needs its price to come from somewhere —
  // keep whatever parts pricing it already had (flat or variant); if it
  // had none at all (an hours-only procedure with no parts cost), default
  // flat_cost to 0 rather than leaving the row invalid.
  const hasVariant = VARIANT_FIELDS.some((v) => (
    p[`parts_cost_${v.key}`] !== null && p[`parts_cost_${v.key}`] !== undefined
  ));
  updateField(p, hasVariant
    ? { pricing_type: 'flat' }
    : { pricing_type: 'flat', flat_cost: p.flat_cost || 0 });
}

// Parts mode is derived from the row's data (which of flat_cost / the
// variant columns is populated) unless the user just picked a different
// mode and hasn't entered a value yet — `partsModeOverride` covers that
// gap so the right inputs show up before anything's actually saved.
const partsModeOverride = ref({});
function partsModeFor(p) {
  if (partsModeOverride.value[p.id]) return partsModeOverride.value[p.id];
  const hasVariant = VARIANT_FIELDS.some((v) => (
    p[`parts_cost_${v.key}`] !== null && p[`parts_cost_${v.key}`] !== undefined
  ));
  if (hasVariant) return 'variant';
  if (p.flat_cost !== null && p.flat_cost !== undefined) return 'flat';
  return 'none';
}
function setPartsMode(p, mode) {
  partsModeOverride.value = { ...partsModeOverride.value, [p.id]: mode };
  if (mode === 'none') {
    // Only reachable for hours-type procedures (flat ones never show
    // "No parts cost") — nothing left to enter, so clear right away.
    updateField(p, {
      flat_cost: null,
      parts_cost_piano_bass: null, parts_cost_54_key: null, parts_cost_73_key: null, parts_cost_88_key: null,
    });
  }
  // For 'flat'/'variant' we just wait for a value — updatePartsFlat/
  // updatePartsVariant below clear whichever mode isn't being used.
}
function updatePartsFlat(p, value) {
  updateField(p, {
    flat_cost: value,
    parts_cost_piano_bass: null, parts_cost_54_key: null, parts_cost_73_key: null, parts_cost_88_key: null,
  });
}
function updatePartsVariant(p, key, value) {
  const patch = { [`parts_cost_${key}`]: value };
  if (p.flat_cost !== null && p.flat_cost !== undefined) patch.flat_cost = null;
  updateField(p, patch);
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Standard procedures</h1>
        <p class="muted small" style="margin: 0">
          The price/hours catalog the Estimates builder picks from for each instrument type.
          Hours-based procedures bill out at the shop rate
          <strong v-if="laborRate">(${{ Number(laborRate).toFixed(2) }}/hr, set on Settings above)</strong>.
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
        <label class="checkbox" style="margin-top: 18px">
          <input v-model="showInactive" type="checkbox" />
          <span class="small">Show retired</span>
        </label>
        <div class="spacer" />
        <button class="small" style="margin-top: 18px" @click="showNew ? (showNew = false) : openNew()">
          {{ showNew ? 'Cancel' : '+ New procedure' }}
        </button>
      </div>
    </div>

    <form v-if="showNew" class="card tight" style="margin-bottom: 16px" @submit.prevent="createProcedure">
      <div class="field-row" style="align-items: end">
        <div class="field" style="flex: 2; margin: 0">
          <label>Name *</label>
          <input v-model="form.name" required placeholder="Action regulation" />
        </div>
        <div class="field" style="margin: 0">
          <label>Instrument type</label>
          <select v-model="form.family">
            <option value="">All types</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Pricing</label>
          <select v-model="form.pricing_type">
            <option value="hours">Hours range</option>
            <option value="flat">Flat cost</option>
          </select>
        </div>
        <template v-if="form.pricing_type === 'hours'">
          <div class="field" style="margin: 0">
            <label>Min hours *</label>
            <input v-model="form.min_hours" type="number" min="0" step="0.25" style="width: 90px" required />
          </div>
          <div class="field" style="margin: 0">
            <label>Max hours *</label>
            <input v-model="form.max_hours" type="number" min="0" step="0.25" style="width: 90px" required />
          </div>
          <div class="field" style="margin: 0">
            <label>Outlier hours</label>
            <input v-model="form.outlier_hours" type="number" min="0" step="0.25" style="width: 90px" placeholder="none" />
          </div>
        </template>
        <div class="field" style="margin: 0">
          <label>Parts</label>
          <select v-model="form.parts_mode">
            <option v-if="form.pricing_type === 'hours'" value="none">No parts cost</option>
            <option value="flat">Single amount</option>
            <option value="variant">By key count (Rhodes)</option>
          </select>
        </div>
        <div v-if="form.parts_mode === 'flat'" class="field" style="margin: 0">
          <label>{{ form.pricing_type === 'flat' ? 'Flat cost *' : 'Parts cost' }}</label>
          <input
            v-model="form.flat_cost" type="number" min="0" step="0.01" style="width: 100px"
            :required="form.pricing_type === 'flat'"
          />
        </div>
        <div class="field" style="margin: 0">
          <label>Default tech level</label>
          <select v-model="form.default_tech_level_key">
            <option value="">— any —</option>
            <option v-for="lvl in settings.active('tech_level')" :key="lvl.key" :value="lvl.key">
              {{ lvl.label }}
            </option>
          </select>
        </div>
        <div class="field" style="margin: 0">
          <label>Estimate wizard screen</label>
          <select v-model="form.category">
            <option value="">— none (defaults to Standard Setup) —</option>
            <option v-for="c in CATEGORY_FIELDS" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
        </div>
        <div class="field" style="flex: none; margin: 0">
          <button class="primary" type="submit">Create</button>
        </div>
      </div>
      <div v-if="form.parts_mode === 'variant'" class="field-row" style="margin-top: 8px">
        <div v-for="v in VARIANT_FIELDS" :key="v.key" class="field" style="margin: 0">
          <label>{{ v.label }}</label>
          <input v-model="form[`parts_cost_${v.key}`]" type="number" min="0" step="0.01" style="width: 90px" />
        </div>
      </div>
      <div class="field" style="margin-top: 12px; margin-bottom: 0">
        <label>Description</label>
        <input v-model="form.description" placeholder="Shown to customers on the estimate (optional)" />
      </div>
    </form>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!filtered.length" class="empty">No procedures match this filter.</div>

    <div v-else class="stack">
      <div v-for="p in filtered" :key="p.id" class="card">
        <div class="row">
          <input
            :value="p.name" style="min-width: 200px; font-weight: 600"
            @change="updateField(p, { name: $event.target.value })"
          />
          <select
            :value="p.family || ''"
            @change="updateField(p, { family: $event.target.value || null })"
          >
            <option value="">All types</option>
            <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
          </select>
          <select
            :value="p.category || ''" class="small" style="max-width: 190px"
            @change="updateField(p, { category: $event.target.value || null })"
          >
            <option value="">Standard Setup (default)</option>
            <option v-for="c in CATEGORY_FIELDS" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
          <select :value="p.pricing_type" @change="setPricingType(p, $event.target.value)">
            <option value="hours">Hours range</option>
            <option value="flat">Flat cost</option>
          </select>

          <template v-if="p.pricing_type === 'hours'">
            <input
              :value="p.min_hours" type="number" min="0" step="0.25" style="width: 80px"
              @change="updateField(p, { min_hours: $event.target.value })"
            />
            <span class="muted small">–</span>
            <input
              :value="p.max_hours" type="number" min="0" step="0.25" style="width: 80px"
              @change="updateField(p, { max_hours: $event.target.value })"
            />
            <span class="muted small">hrs</span>
          </template>

          <select
            class="small" style="max-width: 140px"
            :value="p.default_tech_level_key || ''"
            @change="updateField(p, { default_tech_level_key: $event.target.value || null })"
          >
            <option value="">Any tech level</option>
            <option v-for="lvl in settings.active('tech_level')" :key="lvl.key" :value="lvl.key">
              {{ lvl.label }}
            </option>
          </select>

          <span :class="['pill', p.active ? 'green' : 'slate']">
            {{ p.active ? 'Active' : 'Retired' }}
          </span>
          <div class="spacer" />
          <button class="small" @click="updateField(p, { active: !p.active })">
            {{ p.active ? 'Retire' : 'Restore' }}
          </button>
        </div>

        <div class="row" style="margin-top: 8px">
          <template v-if="p.pricing_type === 'hours'">
            <span class="muted small">Outlier:</span>
            <input
              :value="p.outlier_hours" type="number" min="0" step="0.25" style="width: 80px" placeholder="none"
              @change="updateField(p, { outlier_hours: $event.target.value || null })"
            />
            <span class="muted small">hrs</span>
            <span class="muted small" style="margin-left: 10px">Parts:</span>
          </template>
          <span v-else class="muted small">Price:</span>

          <select
            :value="partsModeFor(p)" class="small" style="max-width: 150px"
            @change="setPartsMode(p, $event.target.value)"
          >
            <option v-if="p.pricing_type === 'hours'" value="none">No parts cost</option>
            <option value="flat">Single amount</option>
            <option value="variant">By key count</option>
          </select>

          <template v-if="partsModeFor(p) === 'flat'">
            <span class="muted small">$</span>
            <input
              :value="p.flat_cost" type="number" min="0" step="0.01" style="width: 100px"
              @change="updatePartsFlat(p, $event.target.value)"
            />
          </template>
          <template v-else-if="partsModeFor(p) === 'variant'">
            <span v-for="v in VARIANT_FIELDS" :key="v.key" class="row" style="gap: 4px; margin: 0; flex: none">
              <span class="muted small">{{ v.label }}</span>
              <input
                :value="p[`parts_cost_${v.key}`]" type="number" min="0" step="0.01" style="width: 74px"
                @change="updatePartsVariant(p, v.key, $event.target.value)"
              />
            </span>
          </template>
        </div>

        <input
          :value="p.description" placeholder="Description (optional, shown to customers)"
          style="margin-top: 10px"
          @change="updateField(p, { description: $event.target.value })"
        />
      </div>
    </div>
  </div>
</template>
