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
import { ref, computed, onMounted } from 'vue';
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

// --- create ----------------------------------------------------------------
const showNew = ref(false);
const blankForm = () => ({
  name: '', family: '', pricing_type: 'hours', min_hours: '', max_hours: '', flat_cost: '', description: '',
  default_tech_level_key: '',
});
const form = ref(blankForm());

function openNew() {
  form.value = blankForm();
  showNew.value = true;
}

async function createProcedure() {
  error.value = '';
  notice.value = '';
  if (!form.value.name.trim()) { error.value = 'Name is required'; return; }
  try {
    await api.post('/procedures', {
      name: form.value.name.trim(),
      family: form.value.family || null,
      pricing_type: form.value.pricing_type,
      min_hours: form.value.pricing_type === 'hours' ? form.value.min_hours : null,
      max_hours: form.value.pricing_type === 'hours' ? form.value.max_hours : null,
      flat_cost: form.value.pricing_type === 'flat' ? form.value.flat_cost : null,
      description: form.value.description || null,
      // N8: lets tasks created from this procedure (TicketTasks.vue) arrive
      // pre-tagged with the level its work usually calls for.
      default_tech_level_key: form.value.default_tech_level_key || null,
    });
    showNew.value = false;
    notice.value = 'Procedure created.';
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

// --- inline edit -------------------------------------------------------------
async function updateField(p, patch) {
  error.value = '';
  notice.value = '';
  try {
    await api.patch(`/procedures/${p.id}`, patch);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

function setPricingType(p, pricingType) {
  updateField(p, pricingType === 'hours'
    ? { pricing_type: 'hours', min_hours: p.min_hours || 0, max_hours: p.max_hours || 0 }
    : { pricing_type: 'flat', flat_cost: p.flat_cost || 0 });
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
        </template>
        <div v-else class="field" style="margin: 0">
          <label>Flat cost *</label>
          <input v-model="form.flat_cost" type="number" min="0" step="0.01" style="width: 110px" required />
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
        <div class="field" style="flex: none; margin: 0">
          <button class="primary" type="submit">Create</button>
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
          <template v-else>
            <span class="muted small">$</span>
            <input
              :value="p.flat_cost" type="number" min="0" step="0.01" style="width: 100px"
              @change="updateField(p, { flat_cost: $event.target.value })"
            />
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
        <input
          :value="p.description" placeholder="Description (optional, shown to customers)"
          style="margin-top: 10px"
          @change="updateField(p, { description: $event.target.value })"
        />
      </div>
    </div>
  </div>
</template>
