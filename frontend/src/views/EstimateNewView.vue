<script setup>
/**
 * New estimate builder — N10 (boss-list scope): reworked from one long
 * scrolling form into an iPad-friendly wizard, one decision per screen,
 * big tap targets throughout. Matches the boss's hand-drawn flow: customer
 * info up top, then per instrument a chain of full-screen button pickers
 * (category -> model, walking instrument_models' tree one level at a
 * time) followed by four procedure screens split by category ("Standard
 * Setup & Actions" / "Electronics" / "Cosmetics" / "Parts" — see migration
 * 045's standard_procedures.category), then a Review/Breakdown screen that
 * can jump back into any instrument, and a Final/Approval screen (summary,
 * then the customer's email & contact info) before saving.
 *
 * One addition beyond the sketch: if the chosen customer already has
 * instruments on file, a block offers to reuse one instead of walking the
 * whole family/model picker again — the sketch only shows the "new
 * instrument" path, but losing that shortcut for a repeat customer would
 * be a real regression from the old form. An existing instrument skips
 * straight to the procedure screens.
 *
 * Same division of labor as before: this view resolves any new customer/
 * instrument to a real id, then flattens the per-instrument procedure
 * picks into the flat {instrument_id, procedure_id}[] POST /quotes wants.
 */
import {
  ref, computed, onMounted, watch,
} from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';
import CustomerSearchSelect from '../components/CustomerSearchSelect.vue';

const router = useRouter();
const settings = useSettings();
const refData = useRefData();

// --- reference data ---------------------------------------------------------
const customerInstruments = ref([]);
const allProcedures = ref([]);
const laborRate = ref(185);
const modelNodesByFamily = ref({}); // family -> instrument_models rows, fetched once per family and cached

const error = ref('');
const busy = ref(false);

// N10: the wizard's screens 3-6, in order. Mirrors routes/procedures.js's
// CATEGORY_KEYS exactly (kept as a small hardcoded list here rather than
// another network round trip — there are exactly four of these and they
// aren't admin-editable, unlike instrument families). A procedure with no
// category (anything an admin created before this existed, or hasn't
// gotten around to categorizing) is bucketed under Standard Setup &
// Actions — the most permissive of the four screens — rather than
// vanishing from the wizard entirely.
const CATEGORY_LABELS = {
  standard_setup: 'Standard Setup & Actions',
  electronics: 'Electronics',
  cosmetics: 'Cosmetics',
  parts: 'Parts',
};
const categoryOf = (p) => p.category || 'standard_setup';

// --- stage / customer --------------------------------------------------------
// 'customer' -> 'instrument' (one block at a time) -> 'review' -> 'final'
const stage = ref('customer');

const customerId = ref('');
// N10: email/phone dropped from this quick "add a customer" form — the
// boss's sketch puts "Email & Contact" on the very last screen instead, so
// a walk-in doesn't need to stop and think about contact info before
// they've even said what instrument they're bringing in. Just enough here
// (name, source) to get moving into the instrument wizard.
const newCustomer = ref({ enabled: false, name: '', source: 'direct' });
const contact = ref({ email: '', phone: '', address: '' });

// CustomerSearchSelect (a type-ahead replacing the old "every customer in
// one <select>" picker — search-and-select is a lot less friction once a
// shop has more than a couple dozen customers on file) doesn't hold onto
// a full customer list, so the currently-picked row is kept here instead
// of re-derived by searching one.
const selectedCustomer = ref(null);
const customerLabel = computed(() => (
  newCustomer.value.enabled ? newCustomer.value.name.trim() : (selectedCustomer.value?.name || '')
));
const hasCustomer = computed(() => (
  !!customerId.value || (newCustomer.value.enabled && !!newCustomer.value.name.trim())
));

async function loadCustomerInstruments() {
  // Changing the customer mid-build would leave any already-picked
  // "existing instrument" blocks pointed at the wrong customer's
  // instruments — simplest correct thing is to drop back to a clean
  // instrument list, same as the old form clearing instrumentId on every
  // block when the customer changed.
  blocks.value = [];
  customerInstruments.value = [];
  if (!customerId.value) return;
  customerInstruments.value = await api.get('/instruments', { customer_id: customerId.value });
}
// CustomerSearchSelect's @change hands back the full row (or null, once
// cleared/typed-over) the moment the pick actually changes — same two
// things the old watch(customerId) did by re-deriving from the full
// customers array, just without needing that array kept around.
function onCustomerChange(row) {
  selectedCustomer.value = row;
  contact.value = { email: row?.email || '', phone: row?.phone || '', address: row?.address || '' };
  loadCustomerInstruments();
}
watch(() => newCustomer.value.enabled, (enabled) => {
  if (enabled) {
    contact.value = { email: '', phone: '', address: '' };
    customerId.value = '';
    selectedCustomer.value = null;
    customerInstruments.value = [];
    blocks.value = [];
  }
});

// --- instrument blocks --------------------------------------------------------
function blankBlock() {
  return {
    key: Math.random().toString(36).slice(2),
    mode: '', // 'existing' | 'new'
    instrumentId: '',
    family: '',
    path: [], // instrument_models node ids, root to the chosen depth
    manual: false,
    manualText: '',
    year: '',
    nickname: '',
    step: 'pick-existing', // set properly by addAnotherInstrument()
    selected: {}, // procedure_id -> true
    variants: {}, // procedure_id -> parts variant key
  };
}
const blocks = ref([]);
const activeBlockKey = ref('');
const activeBlock = computed(() => blocks.value.find((b) => b.key === activeBlockKey.value) || null);

function addAnotherInstrument() {
  const block = blankBlock();
  block.step = customerInstruments.value.length ? 'pick-existing' : 'family';
  blocks.value.push(block);
  activeBlockKey.value = block.key;
  stage.value = 'instrument';
}
function beginInstruments() {
  if (!blocks.value.length) addAnotherInstrument();
  else { activeBlockKey.value = blocks.value[0].key; stage.value = 'instrument'; }
}
function exitBlock(block) {
  const idx = blocks.value.findIndex((b) => b.key === block.key);
  if (blocks.value.length > 1) {
    blocks.value = blocks.value.filter((b) => b.key !== block.key);
    const prev = blocks.value[Math.max(0, idx - 1)];
    prev.step = 'instrument-done';
    activeBlockKey.value = prev.key;
  } else {
    blocks.value = [];
    stage.value = 'customer';
  }
}
// Review's own "Back" used to hardcode stage = 'customer' — a single
// click from Review skipped over every instrument screen straight back
// to the very first one, regardless of how many instruments/screens it
// took to get there. Land on the last instrument's "done" screen
// instead, the same re-entry point exitBlock() already leaves things at
// when backing out of a later block — one real step back, not a reset.
function backFromReview() {
  if (!blocks.value.length) { stage.value = 'customer'; return; }
  const last = blocks.value[blocks.value.length - 1];
  last.step = 'instrument-done';
  activeBlockKey.value = last.key;
  stage.value = 'instrument';
}

// --- family / model tree navigation ------------------------------------------
async function ensureFamilyNodes(family) {
  if (!family || modelNodesByFamily.value[family]) return;
  modelNodesByFamily.value = {
    ...modelNodesByFamily.value,
    [family]: await api.get('/instrument-models', { family }),
  };
}
function nodesFor(block) { return modelNodesByFamily.value[block.family] || []; }
function nodeById(block, id) { return nodesFor(block).find((n) => n.id === id); }
function childrenOf(block, parentId) {
  return nodesFor(block)
    .filter((n) => (n.parent_id || null) === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}
function currentLevelNodes(block) {
  const parentId = block.path.length ? block.path[block.path.length - 1] : null;
  return childrenOf(block, parentId);
}
function modelBreadcrumb(block) {
  const names = block.path.map((id) => nodeById(block, id)?.name).filter(Boolean);
  return names.length ? ` — ${names.join(' / ')}` : '';
}
function blockModelChain(block) {
  if (block.manual) return block.manualText.trim();
  return block.path.map((id) => nodeById(block, id)?.name).filter(Boolean).join(' / ');
}
// Suitcase-style/self-contained-amp variant (migration 045's is_suitcase) —
// gates whether the Electronics screen shows at all for a *new* instrument.
// Only meaningful along a real tree path; a manually-typed model carries no
// such flag.
function blockIsSuitcase(block) {
  if (block.manual) return false;
  return block.path.some((id) => nodeById(block, id)?.is_suitcase);
}

function chooseExistingInstrument(block, instrumentId) {
  block.mode = 'existing';
  block.instrumentId = instrumentId;
  block.step = 'standard_setup';
}
function chooseNewInstrument(block) {
  block.mode = 'new';
  block.step = 'family';
}
async function pickFamily(block, family) {
  block.family = family;
  block.path = [];
  block.manual = false;
  block.manualText = '';
  await ensureFamilyNodes(family);
  block.step = 'model';
}
function pickModelNode(block, node) {
  block.path.push(node.id);
  if (!childrenOf(block, node.id).length) block.step = 'details'; // reached a leaf
}
function continueFromManual(block) {
  block.step = 'details';
}

function backFromPickExisting(block) { exitBlock(block); }
function backFromFamily(block) {
  if (customerInstruments.value.length) { block.step = 'pick-existing'; block.mode = ''; return; }
  exitBlock(block);
}
function backFromModel(block) {
  if (block.manual) { block.manual = false; block.manualText = ''; return; }
  if (block.path.length) { block.path.pop(); return; }
  backFromFamily(block);
}
function backFromDetails(block) {
  block.step = 'model';
  if (!block.manual && block.path.length) block.path.pop(); // re-show the leaf's siblings
}
function continueFromDetails(block) { block.step = 'standard_setup'; }

// --- procedure picking (screens 3-6) -----------------------------------------
function blockFamily(block) {
  if (block.mode === 'existing') {
    return customerInstruments.value.find((i) => i.id === block.instrumentId)?.family || '';
  }
  return block.family;
}
function proceduresForCategory(block, categoryKey) {
  const family = blockFamily(block);
  return allProcedures.value.filter((p) => (
    (!p.family || p.family === family) && categoryOf(p) === categoryKey
  ));
}
function blockShowsElectronics(block) {
  if (!proceduresForCategory(block, 'electronics').length) return false;
  if (block.mode === 'new') return blockIsSuitcase(block);
  // An existing instrument has no stored is_suitcase (that lives on the
  // instrument_models tree node it was picked from, not on the instrument
  // row) — shown whenever its family has electronics procedures at all
  // rather than hiding real available work for lack of that one flag.
  return true;
}

// Parts-by-variant (migration 043) — unchanged from the original builder.
const VARIANT_FIELDS = [
  { key: 'piano_bass', label: 'Piano Bass' },
  { key: '54_key', label: '54-Key' },
  { key: '73_key', label: '73-Key' },
  { key: '88_key', label: '88-Key' },
];
function variantsFor(p) {
  return VARIANT_FIELDS.filter((v) => p[`parts_cost_${v.key}`] !== null && p[`parts_cost_${v.key}`] !== undefined);
}
function resolvedAmount(p, block) {
  const variants = variantsFor(p);
  if (variants.length) {
    const chosen = block.variants[p.id];
    return chosen ? Number(p[`parts_cost_${chosen}`]) : null;
  }
  if (p.flat_cost !== null && p.flat_cost !== undefined) return Number(p.flat_cost);
  return p.pricing_type === 'flat' ? null : 0;
}
const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
function itemCostDisplay(p, block) {
  const amount = resolvedAmount(p, block);
  if (variantsFor(p).length && amount === null) return 'select variant';
  if (p.pricing_type === 'flat') return money(amount || 0);
  return `${p.min_hours}-${p.max_hours} hrs${amount ? ` + ${money(amount)} parts` : ''}`;
}
function blockTotal(block) {
  let minCost = 0; let maxCost = 0;
  for (const p of allProcedures.value) {
    if (!block.selected[p.id]) continue;
    const amount = resolvedAmount(p, block) || 0;
    if (p.pricing_type === 'flat') {
      minCost += amount; maxCost += amount;
    } else {
      minCost += Number(p.min_hours) * laborRate.value + amount;
      maxCost += Number(p.max_hours) * laborRate.value + amount;
    }
  }
  return { minCost, maxCost };
}
function rangeDisplay({ minCost, maxCost }) {
  return minCost === maxCost ? money(minCost) : `${money(minCost)} – ${money(maxCost)}`;
}
const grandTotal = computed(() => blocks.value.reduce((acc, b) => {
  const t = blockTotal(b);
  return { minCost: acc.minCost + t.minCost, maxCost: acc.maxCost + t.maxCost };
}, { minCost: 0, maxCost: 0 }));
const hasAnySelection = computed(() => blocks.value.some((b) => Object.values(b.selected).some(Boolean)));
function selectedProceduresFor(block) {
  return allProcedures.value.filter((p) => block.selected[p.id]);
}

function backFromCategoryStep(block) {
  if (block.step === 'standard_setup') {
    block.step = block.mode === 'existing' ? 'pick-existing' : 'details';
    return;
  }
  if (block.step === 'electronics') { block.step = 'standard_setup'; return; }
  if (block.step === 'cosmetics') { block.step = blockShowsElectronics(block) ? 'electronics' : 'standard_setup'; return; }
  if (block.step === 'parts') { block.step = 'cosmetics'; }
}
function continueFromCategoryStep(block) {
  if (block.step === 'standard_setup') { block.step = blockShowsElectronics(block) ? 'electronics' : 'cosmetics'; return; }
  if (block.step === 'electronics') { block.step = 'cosmetics'; return; }
  if (block.step === 'cosmetics') { block.step = 'parts'; return; }
  if (block.step === 'parts') { block.step = 'instrument-done'; }
}

function instrumentLabel(block) {
  if (block.mode === 'existing') {
    const inst = customerInstruments.value.find((i) => i.id === block.instrumentId);
    if (!inst) return 'Instrument';
    const bits = [];
    if (inst.nickname) bits.push(`"${inst.nickname}"`);
    if (inst.year) bits.push(inst.year);
    bits.push(refData.familyLabel(inst.family));
    if (inst.model) bits.push(inst.model);
    return bits.join(' ');
  }
  const bits = [];
  if (block.nickname.trim()) bits.push(`"${block.nickname.trim()}"`);
  if (block.year.trim()) bits.push(block.year.trim());
  if (block.family) bits.push(refData.familyLabel(block.family));
  const model = blockModelChain(block);
  if (model) bits.push(model);
  return bits.join(' ') || 'Instrument';
}

// --- review stage --------------------------------------------------------------
function editBlock(block) {
  activeBlockKey.value = block.key;
  block.step = 'standard_setup'; // one safe re-entry point; Back/Next from here reaches every other screen
  stage.value = 'instrument';
}
function removeBlockFromReview(block) {
  blocks.value = blocks.value.filter((b) => b.key !== block.key);
}

// --- category/priority defaults + load ------------------------------------------
const categoryKey = ref('');
const priorityKey = ref('');
const notes = ref('');

onMounted(async () => {
  await refData.load();
  allProcedures.value = await api.get('/procedures');
  try {
    const res = await api.get('/estimates/labor-rate');
    laborRate.value = res.labor_rate;
  } catch { /* keep the fallback default */ }
  const activeCategories = settings.active('ticket_category');
  categoryKey.value = activeCategories.find((c) => c.key === 'repairs_restoration')?.key
    || activeCategories[0]?.key || '';
  const activePriorities = settings.active('priority_tier');
  priorityKey.value = activePriorities.find((p) => p.key === 'standard_priority')?.key
    || activePriorities[0]?.key || '';
});

// --- submit ----------------------------------------------------------------------
// Each of these remembers what a previous, failed submit already managed to
// create. Without this, retrying after any failure here (most commonly the
// final `/send` call — e.g. the APP_BASE_URL misconfiguration fixed
// separately) re-ran the whole function from scratch: the customer,
// instruments, and estimate created by the first attempt were still sitting
// in the database, and the retry created a second full set on top of them.
// (POST /customers now also dedups by email as a backstop, but the estimate
// and instrument rows have no such natural key, so this file has to avoid
// recreating them itself.)
const createdCustomerId = ref(null);
const createdInstrumentByBlock = ref(new Map());
const createdEstimateId = ref(null);

async function submit(sendAfterCreate) {
  error.value = '';

  const items = [];
  for (const block of blocks.value) {
    for (const p of selectedProceduresFor(block)) {
      if (variantsFor(p).length && !block.variants[p.id]) {
        error.value = `Select a key-count variant for "${p.name}".`;
        return;
      }
      items.push({ block, procedure_id: p.id, parts_variant: block.variants[p.id] || null });
    }
  }
  if (!items.length) { error.value = 'Select at least one procedure for at least one instrument.'; return; }
  if (!hasCustomer.value) { error.value = 'Select or add a customer.'; return; }
  if (sendAfterCreate && !contact.value.email.trim()) { error.value = 'Add an email to send this estimate to the customer.'; return; }

  busy.value = true;
  try {
    if (!createdEstimateId.value) {
      let resolvedCustomerId = createdCustomerId.value || customerId.value;
      if (!createdCustomerId.value && newCustomer.value.enabled && newCustomer.value.name.trim()) {
        const created = await api.post('/customers', {
          name: newCustomer.value.name.trim(),
          email: contact.value.email.trim() || null,
          phone: contact.value.phone.trim() || null,
          address: contact.value.address.trim() || null,
          source: newCustomer.value.source || null,
        });
        resolvedCustomerId = created.id;
        createdCustomerId.value = created.id;
      } else if (!createdCustomerId.value && selectedCustomer.value
        && (contact.value.email.trim() !== (selectedCustomer.value.email || '')
          || contact.value.phone.trim() !== (selectedCustomer.value.phone || '')
          || contact.value.address.trim() !== (selectedCustomer.value.address || ''))) {
        // Final/Approval screen doubles as "confirm this is still how to
        // reach them" — only writes back when something actually changed.
        await api.patch(`/customers/${resolvedCustomerId}`, {
          email: contact.value.email.trim() || null,
          phone: contact.value.phone.trim() || null,
          address: contact.value.address.trim() || null,
        });
      }

      for (const block of blocks.value) {
        if (createdInstrumentByBlock.value.has(block.key)) continue;
        if (block.mode === 'existing') {
          createdInstrumentByBlock.value.set(block.key, block.instrumentId || null);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const created = await api.post('/instruments', {
          family: block.family,
          model: blockModelChain(block) || null,
          year: block.year.trim() || null,
          nickname: block.nickname.trim() || null,
          customer_id: resolvedCustomerId || null,
        });
        createdInstrumentByBlock.value.set(block.key, created.id);
      }

      const payload = {
        customer_id: resolvedCustomerId,
        category_key: categoryKey.value,
        priority_key: priorityKey.value,
        notes: notes.value || null,
        items: items.map((it) => ({
          instrument_id: createdInstrumentByBlock.value.get(it.block.key),
          procedure_id: it.procedure_id,
          parts_variant: it.parts_variant,
        })),
      };

      const estimate = await api.post('/quotes', payload);
      createdEstimateId.value = estimate.id;
    }

    if (sendAfterCreate) await api.post(`/quotes/${createdEstimateId.value}/send`);
    router.push({ name: 'estimate', params: { id: createdEstimateId.value } });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page wiz-page">
    <div class="page-head">
      <h1>New estimate</h1>
      <button type="button" @click="router.back()">Cancel</button>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <!-- STAGE: customer ------------------------------------------------- -->
    <div v-if="stage === 'customer'" class="card">
      <h2>Customer</h2>
      <div class="field">
        <CustomerSearchSelect
          v-model="customerId" :disabled="newCustomer.enabled"
          placeholder="Search customers…"
          @change="onCustomerChange"
        />
      </div>
      <div class="field">
        <label class="checkbox">
          <input v-model="newCustomer.enabled" type="checkbox" />
          <span>Add a new customer instead</span>
        </label>
      </div>
      <div v-if="newCustomer.enabled" class="card tight" style="margin-bottom: 16px">
        <div class="field-row">
          <div class="field">
            <label>Name *</label>
            <input v-model="newCustomer.name" required placeholder="Dolly Jones" />
          </div>
          <div class="field">
            <label>Source</label>
            <select v-model="newCustomer.source">
              <option value="direct">Direct</option>
              <option value="email">Email</option>
              <option value="shopify">Shopify</option>
            </select>
          </div>
        </div>
      </div>
      <button class="primary" :disabled="!hasCustomer" @click="beginInstruments">Start →</button>
    </div>

    <!-- STAGE: instrument ------------------------------------------------- -->
    <template v-else-if="stage === 'instrument' && activeBlock">
      <p class="wiz-progress muted small">
        {{ customerLabel }} · Instrument {{ blocks.findIndex((b) => b.key === activeBlock.key) + 1 }} of {{ blocks.length }}
      </p>

      <div v-if="activeBlock.step === 'pick-existing'" class="wiz-screen">
        <h2>Which instrument?</h2>
        <div class="wiz-grid">
          <button
            v-for="inst in customerInstruments" :key="inst.id" type="button" class="wiz-btn"
            @click="chooseExistingInstrument(activeBlock, inst.id)"
          >
            {{ refData.familyLabel(inst.family) }}
            <span class="wiz-btn-sub"><template v-if="inst.nickname">"{{ inst.nickname }}" </template>{{ inst.model }}</span>
          </button>
          <button type="button" class="wiz-btn ghost" @click="chooseNewInstrument(activeBlock)">+ Add a new instrument</button>
        </div>
        <div class="wiz-actions"><button type="button" @click="backFromPickExisting(activeBlock)">← Back</button></div>
      </div>

      <div v-else-if="activeBlock.step === 'family'" class="wiz-screen">
        <h2>Instrument type</h2>
        <div class="wiz-grid">
          <button
            v-for="f in refData.families" :key="f" type="button" class="wiz-btn"
            @click="pickFamily(activeBlock, f)"
          >{{ refData.familyLabel(f) }}</button>
        </div>
        <div class="wiz-actions"><button type="button" @click="backFromFamily(activeBlock)">← Back</button></div>
      </div>

      <div v-else-if="activeBlock.step === 'model'" class="wiz-screen">
        <h2>{{ refData.familyLabel(activeBlock.family) }}<span class="muted">{{ modelBreadcrumb(activeBlock) }}</span></h2>
        <template v-if="!activeBlock.manual">
          <div class="wiz-grid">
            <button
              v-for="n in currentLevelNodes(activeBlock)" :key="n.id" type="button" class="wiz-btn"
              @click="pickModelNode(activeBlock, n)"
            >{{ n.name }}</button>
            <button type="button" class="wiz-btn ghost" @click="activeBlock.manual = true">Other / type it in</button>
          </div>
          <div v-if="!currentLevelNodes(activeBlock).length" class="muted small" style="margin-top: 10px">
            Nothing listed yet for this family — use "Other / type it in."
          </div>
        </template>
        <template v-else>
          <div class="field">
            <input v-model="activeBlock.manualText" placeholder="Type the model" autofocus />
          </div>
          <button
            class="primary" type="button" :disabled="!activeBlock.manualText.trim()"
            @click="continueFromManual(activeBlock)"
          >Continue →</button>
        </template>
        <div class="wiz-actions"><button type="button" @click="backFromModel(activeBlock)">← Back</button></div>
      </div>

      <div v-else-if="activeBlock.step === 'details'" class="wiz-screen">
        <h2>Instrument details</h2>
        <p class="muted small">{{ refData.familyLabel(activeBlock.family) }}{{ modelBreadcrumb(activeBlock) }}</p>
        <div class="field-row">
          <div class="field">
            <label>Year</label>
            <input v-model="activeBlock.year" placeholder="1973" />
          </div>
          <div class="field">
            <label>Nickname</label>
            <input v-model="activeBlock.nickname" placeholder="e.g. Old Betsy" />
          </div>
        </div>
        <div class="wiz-actions">
          <button type="button" @click="backFromDetails(activeBlock)">← Back</button>
          <button class="primary" type="button" @click="continueFromDetails(activeBlock)">Next →</button>
        </div>
      </div>

      <div
        v-else-if="['standard_setup', 'electronics', 'cosmetics', 'parts'].includes(activeBlock.step)"
        class="wiz-screen wide"
      >
        <h2>{{ CATEGORY_LABELS[activeBlock.step] }}</h2>
        <p class="muted small">{{ instrumentLabel(activeBlock) }}</p>
        <ul class="checklist">
          <li v-for="p in proceduresForCategory(activeBlock, activeBlock.step)" :key="p.id" style="align-items: center">
            <label class="checkbox" style="flex: 1">
              <input v-model="activeBlock.selected[p.id]" type="checkbox" />
              <span>
                {{ p.name }}
                <span class="item-note">{{ itemCostDisplay(p, activeBlock) }}</span>
              </span>
            </label>
            <select
              v-if="activeBlock.selected[p.id] && variantsFor(p).length"
              v-model="activeBlock.variants[p.id]" class="small" style="max-width: 140px"
            >
              <option value="">— select variant —</option>
              <option v-for="v in variantsFor(p)" :key="v.key" :value="v.key">{{ v.label }}</option>
            </select>
          </li>
          <li v-if="!proceduresForCategory(activeBlock, activeBlock.step).length" class="muted small" style="padding: 6px 0">
            Nothing configured under {{ CATEGORY_LABELS[activeBlock.step] }} for this instrument type yet.
          </li>
        </ul>
        <div class="wiz-actions">
          <button type="button" @click="backFromCategoryStep(activeBlock)">← Back</button>
          <button class="primary" type="button" @click="continueFromCategoryStep(activeBlock)">Next →</button>
        </div>
      </div>

      <div v-else-if="activeBlock.step === 'instrument-done'" class="wiz-screen">
        <h2>Instrument added</h2>
        <p>{{ instrumentLabel(activeBlock) }} — subtotal <strong>{{ rangeDisplay(blockTotal(activeBlock)) }}</strong></p>
        <div class="wiz-actions">
          <button type="button" @click="activeBlock.step = 'parts'">← Back</button>
          <button type="button" @click="addAnotherInstrument">+ Add another instrument</button>
          <button class="primary" type="button" @click="stage = 'review'">Review estimate →</button>
        </div>
      </div>
    </template>

    <!-- STAGE: review / breakdown ------------------------------------------- -->
    <template v-else-if="stage === 'review'">
      <div class="page-head"><h2>Review &amp; breakdown</h2></div>
      <div v-if="!blocks.length" class="empty">No instruments added yet.</div>
      <div v-for="block in blocks" :key="block.key" class="card" style="margin-bottom: 14px">
        <div class="row" style="margin-bottom: 10px">
          <strong>{{ instrumentLabel(block) }}</strong>
          <div class="spacer" />
          <button class="small" type="button" @click="editBlock(block)">Edit</button>
          <button class="small danger" type="button" @click="removeBlockFromReview(block)">Remove</button>
        </div>
        <ul class="checklist">
          <li v-for="p in selectedProceduresFor(block)" :key="p.id">
            <span style="flex: 1">
              {{ p.name }}
              <span class="item-note">{{ CATEGORY_LABELS[categoryOf(p)] }}</span>
            </span>
            <strong class="small">{{ itemCostDisplay(p, block) }}</strong>
          </li>
          <li v-if="!selectedProceduresFor(block).length" class="muted small" style="padding: 6px 0">Nothing selected yet.</li>
        </ul>
        <div class="row" style="margin-top: 8px">
          <span class="muted small">Subtotal:</span>
          <strong class="small">{{ rangeDisplay(blockTotal(block)) }}</strong>
        </div>
      </div>

      <div class="card tight" style="margin-bottom: 16px">
        <div class="row">
          <span>Estimated total</span>
          <div class="spacer" />
          <strong style="font-size: 18px">{{ rangeDisplay(grandTotal) }}</strong>
        </div>
      </div>

      <div class="wiz-actions">
        <button type="button" @click="backFromReview()">← Back</button>
        <button type="button" @click="addAnotherInstrument">+ Add another instrument</button>
        <button class="primary" type="button" :disabled="!hasAnySelection" @click="stage = 'final'">
          Continue to approval →
        </button>
      </div>
    </template>

    <!-- STAGE: final / approval ------------------------------------------- -->
    <template v-else-if="stage === 'final'">
      <div class="page-head"><h2>Final / approval</h2></div>

      <div class="card" style="margin-bottom: 16px">
        <h2>Summary</h2>
        <div v-for="block in blocks" :key="block.key" class="row">
          <span>{{ instrumentLabel(block) }}</span>
          <div class="spacer" />
          <span class="small">{{ rangeDisplay(blockTotal(block)) }}</span>
        </div>
        <div class="row" style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 8px">
          <span>Estimated total</span>
          <div class="spacer" />
          <strong style="font-size: 18px">{{ rangeDisplay(grandTotal) }}</strong>
        </div>
      </div>

      <div class="card" style="margin-bottom: 16px">
        <h2>Ticket details</h2>
        <div class="field-row">
          <div class="field">
            <label>Ticket category *</label>
            <select v-model="categoryKey" required>
              <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">{{ c.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>Priority *</label>
            <select v-model="priorityKey" required>
              <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">{{ p.label }}</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Notes</label>
          <textarea v-model="notes" placeholder="Anything else worth including on the estimate or the resulting ticket(s)" />
        </div>
      </div>

      <div class="card" style="margin-bottom: 16px">
        <h2>Email &amp; contact</h2>
        <div class="field-row">
          <div class="field">
            <label>Email</label>
            <input v-model="contact.email" type="email" placeholder="dolly@example.com" />
          </div>
          <div class="field">
            <label>Phone</label>
            <input v-model="contact.phone" placeholder="(555) 555-0100" />
          </div>
        </div>
        <div class="field">
          <label>Address</label>
          <input v-model="contact.address" placeholder="123 Main St, Springfield" />
        </div>
        <p v-if="!contact.email.trim()" class="muted small" style="margin: 0">
          Add an email to send this estimate straight to the customer — you can still save it without one.
        </p>
      </div>

      <div class="wiz-actions">
        <button type="button" @click="stage = 'review'">← Back</button>
        <button class="primary" type="button" :disabled="busy" @click="submit(false)">
          {{ busy ? 'Saving…' : 'Save estimate' }}
        </button>
        <button
          class="primary" type="button" :disabled="busy || !contact.email.trim()"
          @click="submit(true)"
        >{{ busy ? 'Saving…' : 'Save & send to customer' }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* N10: big, iPad-friendly tap targets for the estimate wizard — every
   other picker in the app (InstrumentModelPicker.vue, category buttons in
   TicketNewView.vue) is sized for a mouse/keyboard desk; this screen is
   meant to be run standing at the bench next to an open piano. */
.wiz-page { max-width: 900px; }
.wiz-progress { margin: 0 0 10px; }
.wiz-screen { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; }
.wiz-screen.wide { max-width: none; }
.wiz-screen h2 { margin-bottom: 18px; }
.wiz-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px; margin-bottom: 8px;
}
.wiz-btn {
  min-height: 84px; padding: 14px; font-size: 17px; font-weight: 600;
  border-radius: var(--radius); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 4px; text-align: center;
}
.wiz-btn-sub { font-size: 12px; font-weight: 400; color: var(--text-dim); }
.wiz-btn.ghost { background: transparent; border-style: dashed; font-weight: 500; }
.wiz-actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
.wiz-actions button { min-height: 48px; padding: 10px 18px; font-size: 15px; }
</style>
