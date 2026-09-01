<script setup>
/**
 * New estimate builder: pick (or create) a customer, add one or more
 * instruments (existing or new — same inline-create pattern as
 * TicketNewView.vue), check off the standard procedures that apply to
 * each, and submit. POST /quotes does the actual creation — this view's
 * job is just resolving any new customer/instrument to a real id first
 * (same division of labor TicketNewView.vue already uses for its own
 * inline customer/instrument creation) and flattening the per-instrument
 * procedure checkboxes into the flat {instrument_id, procedure_id}[] the
 * API wants.
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';
import InstrumentModelPicker from '../components/InstrumentModelPicker.vue';

const router = useRouter();
const settings = useSettings();
const refData = useRefData();

const customers = ref([]);
const customerInstruments = ref([]);
const allProcedures = ref([]);
const laborRate = ref(185);
const error = ref('');
const busy = ref(false);

const title = ref('');
// Blank until onMounted resolves a real default from Settings (N4a) —
// hardcoding either here would leave the picker pointed at a value
// Settings can retire at any time, same issue TicketNewView.vue had. Both
// actually did retire (N2b/N4b): 'servicing' is now 'repairs_restoration'
// and 'standard_setup' is now 'standard_priority', below.
const categoryKey = ref('');
const priorityKey = ref('');
const notes = ref('');

const customerId = ref('');
const newCustomer = ref({ enabled: false, name: '', email: '', phone: '', source: 'direct' });

function blankBlock() {
  return {
    key: Math.random().toString(36).slice(2),
    instrumentId: '',
    newInstrument: { enabled: false, family: refData.families[0] || '', model: '', year: '', serial_no: '' },
    selected: {}, // procedure_id -> true
    variants: {}, // procedure_id -> parts variant key, for procedures priced by key count
  };
}

// Parts-by-variant (migration 043) — a procedure prices its parts either a
// single flat_cost (folded straight into its price) or one of these four
// key-count columns, never both. Keys match what routes/quotes.js expects
// as `parts_variant` on each submitted item.
const VARIANT_FIELDS = [
  { key: 'piano_bass', label: 'Piano Bass' },
  { key: '54_key', label: '54-Key' },
  { key: '73_key', label: '73-Key' },
  { key: '88_key', label: '88-Key' },
];
function variantsFor(p) {
  return VARIANT_FIELDS.filter((v) => p[`parts_cost_${v.key}`] !== null && p[`parts_cost_${v.key}`] !== undefined);
}
// The dollar amount this procedure actually resolves to for this block —
// null when it prices by key count and nothing's been picked yet. For a
// 'flat' procedure this is its whole price; for an 'hours' procedure it's
// the additive parts cost on top of labor (0 when it carries no parts at
// all).
function resolvedAmount(p, block) {
  const variants = variantsFor(p);
  if (variants.length) {
    const chosen = block.variants[p.id];
    return chosen ? Number(p[`parts_cost_${chosen}`]) : null;
  }
  if (p.flat_cost !== null && p.flat_cost !== undefined) return Number(p.flat_cost);
  return p.pricing_type === 'flat' ? null : 0;
}
const blocks = ref([blankBlock()]);

async function loadCustomerInstruments() {
  blocks.value.forEach((b) => { b.instrumentId = ''; });
  if (!customerId.value) { customerInstruments.value = []; return; }
  customerInstruments.value = await api.get('/instruments', { customer_id: customerId.value });
}

onMounted(async () => {
  customers.value = await api.get('/customers');
  allProcedures.value = await api.get('/procedures');
  try {
    const res = await api.get('/estimates/labor-rate');
    laborRate.value = res.labor_rate;
  } catch { /* keep the fallback default */ }
  // Prefer the historical default if it's still active; otherwise fall
  // back to whatever sorts first (N4a — same reasoning as TicketNewView.vue).
  const activeCategories = settings.active('ticket_category');
  categoryKey.value = activeCategories.find((c) => c.key === 'repairs_restoration')?.key
    || activeCategories[0]?.key || '';
  const activePriorities = settings.active('priority_tier');
  priorityKey.value = activePriorities.find((p) => p.key === 'standard_priority')?.key
    || activePriorities[0]?.key || '';
});

function familyFor(block) {
  if (block.newInstrument.enabled) return block.newInstrument.family;
  const inst = customerInstruments.value.find((i) => i.id === block.instrumentId);
  return inst ? inst.family : '';
}

function proceduresFor(block) {
  const family = familyFor(block);
  if (!family) return allProcedures.value;
  return allProcedures.value.filter((p) => !p.family || p.family === family);
}

function addBlock() {
  blocks.value.push(blankBlock());
}
function removeBlock(key) {
  blocks.value = blocks.value.filter((b) => b.key !== key);
}

const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function blockTotal(block) {
  let minCost = 0; let maxCost = 0;
  for (const p of proceduresFor(block)) {
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

const grandTotal = computed(() => blocks.value.reduce((acc, b) => {
  const t = blockTotal(b);
  return { minCost: acc.minCost + t.minCost, maxCost: acc.maxCost + t.maxCost };
}, { minCost: 0, maxCost: 0 }));

async function submit() {
  error.value = '';

  const items = [];
  for (const block of blocks.value) {
    const ids = Object.keys(block.selected).filter((id) => block.selected[id]);
    for (const procedureId of ids) {
      const procedure = allProcedures.value.find((p) => String(p.id) === String(procedureId));
      if (procedure && variantsFor(procedure).length && !block.variants[procedureId]) {
        error.value = `Select a key-count variant for "${procedure.name}".`;
        return;
      }
      items.push({ block, procedure_id: Number(procedureId), parts_variant: block.variants[procedureId] || null });
    }
  }
  if (!items.length) { error.value = 'Select at least one procedure for at least one instrument.'; return; }
  if (!customerId.value && !(newCustomer.value.enabled && newCustomer.value.name.trim())) {
    error.value = 'Select or add a customer.'; return;
  }

  busy.value = true;
  try {
    let resolvedCustomerId = customerId.value;
    if (newCustomer.value.enabled && newCustomer.value.name.trim()) {
      const created = await api.post('/customers', {
        name: newCustomer.value.name.trim(),
        email: newCustomer.value.email || null,
        phone: newCustomer.value.phone || null,
        source: newCustomer.value.source || null,
      });
      resolvedCustomerId = created.id;
    }

    // Resolve each block's instrument (create if new) exactly once, even
    // though the block may contribute several items.
    const resolvedInstrumentByBlock = new Map();
    for (const block of blocks.value) {
      if (resolvedInstrumentByBlock.has(block.key)) continue;
      if (block.newInstrument.enabled && block.newInstrument.model) {
        // eslint-disable-next-line no-await-in-loop
        const created = await api.post('/instruments', {
          family: block.newInstrument.family,
          model: block.newInstrument.model,
          year: block.newInstrument.year || null,
          serial_no: block.newInstrument.serial_no || null,
          customer_id: resolvedCustomerId || null,
        });
        resolvedInstrumentByBlock.set(block.key, created.id);
      } else {
        resolvedInstrumentByBlock.set(block.key, block.instrumentId || null);
      }
    }

    const payload = {
      customer_id: resolvedCustomerId,
      title: title.value || null,
      category_key: categoryKey.value,
      priority_key: priorityKey.value,
      notes: notes.value || null,
      items: items.map((it) => ({
        instrument_id: resolvedInstrumentByBlock.get(it.block.key),
        procedure_id: it.procedure_id,
        parts_variant: it.parts_variant,
      })),
    };

    const estimate = await api.post('/quotes', payload);
    router.push({ name: 'estimate', params: { id: estimate.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 900px">
    <div class="page-head"><h1>New estimate</h1></div>

    <form class="card" @submit.prevent="submit">
      <div class="field">
        <label>Title</label>
        <input v-model="title" placeholder="e.g. Steve Dawson — Rhodes + Wurlitzer estimate" />
      </div>

      <h2 style="margin-top: 4px">Customer</h2>
      <div class="field">
        <select v-model="customerId" :disabled="newCustomer.enabled" @change="loadCustomerInstruments">
          <option value="">— select a customer —</option>
          <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
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
            <input v-model="newCustomer.name" required placeholder="Steve Dawson" />
          </div>
          <div class="field">
            <label>Email</label>
            <input v-model="newCustomer.email" type="email" />
          </div>
          <div class="field">
            <label>Phone</label>
            <input v-model="newCustomer.phone" />
          </div>
        </div>
      </div>

      <h2>Instruments &amp; procedures</h2>
      <div v-for="(block, i) in blocks" :key="block.key" class="card tight" style="margin-bottom: 14px">
        <div class="row" style="margin-bottom: 10px">
          <strong class="small muted">Instrument {{ i + 1 }}</strong>
          <div class="spacer" />
          <button v-if="blocks.length > 1" type="button" class="small danger" @click="removeBlock(block.key)">
            Remove
          </button>
        </div>

        <div class="field-row">
          <div class="field">
            <label>Instrument</label>
            <select v-model="block.instrumentId" :disabled="block.newInstrument.enabled || !customerId">
              <option value="">— select —</option>
              <option v-for="inst in customerInstruments" :key="inst.id" :value="inst.id">
                {{ inst.family }} · {{ inst.model }}
              </option>
            </select>
          </div>
        </div>
        <div class="field">
          <label class="checkbox">
            <input v-model="block.newInstrument.enabled" type="checkbox" />
            <span>Add a new instrument instead</span>
          </label>
        </div>
        <div v-if="block.newInstrument.enabled" class="field-row" style="margin-bottom: 14px">
          <div class="field">
            <label>Type</label>
            <select v-model="block.newInstrument.family">
              <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
            </select>
          </div>
          <div class="field">
            <label>Model</label>
            <InstrumentModelPicker :family="block.newInstrument.family" v-model="block.newInstrument.model" />
          </div>
          <div class="field">
            <label>Year</label>
            <input v-model="block.newInstrument.year" placeholder="1972" />
          </div>
        </div>

        <label>Procedures</label>
        <ul class="checklist">
          <li v-for="p in proceduresFor(block)" :key="p.id" style="align-items: center">
            <label class="checkbox" style="flex: 1">
              <input v-model="block.selected[p.id]" type="checkbox" />
              <span>
                {{ p.name }}
                <span class="item-note">
                  <template v-if="variantsFor(p).length">
                    <template v-if="resolvedAmount(p, block) !== null">
                      {{ p.pricing_type === 'flat'
                        ? money(resolvedAmount(p, block))
                        : `${p.min_hours}-${p.max_hours} hrs + ${money(resolvedAmount(p, block))} parts` }}
                    </template>
                    <template v-else>priced by key count — select variant</template>
                  </template>
                  <template v-else>
                    {{ p.pricing_type === 'flat'
                      ? money(p.flat_cost)
                      : `${p.min_hours}-${p.max_hours} hrs${p.flat_cost ? ` + ${money(p.flat_cost)} parts` : ''}` }}
                  </template>
                  <template v-if="p.family">· {{ p.family }} only</template>
                  <template v-else>· all types</template>
                </span>
              </span>
            </label>
            <select
              v-if="block.selected[p.id] && variantsFor(p).length"
              v-model="block.variants[p.id]"
              class="small" style="max-width: 140px"
            >
              <option value="">— select variant —</option>
              <option v-for="v in variantsFor(p)" :key="v.key" :value="v.key">{{ v.label }}</option>
            </select>
          </li>
          <li v-if="!proceduresFor(block).length" class="muted small" style="padding: 6px 0">
            No standard procedures configured for this instrument type yet — add some under
            Settings → Standard procedures.
          </li>
        </ul>

        <div v-if="Object.values(block.selected).some(Boolean)" class="row" style="margin-top: 8px">
          <span class="muted small">Subtotal:</span>
          <strong class="small">
            {{ blockTotal(block).minCost === blockTotal(block).maxCost
              ? money(blockTotal(block).minCost)
              : `${money(blockTotal(block).minCost)} – ${money(blockTotal(block).maxCost)}` }}
          </strong>
        </div>
      </div>

      <button type="button" class="small" @click="addBlock">+ Add another instrument</button>

      <h2 style="margin-top: 20px">Details</h2>
      <div class="field-row">
        <div class="field">
          <label>Ticket category *</label>
          <select v-model="categoryKey" required>
            <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">
              {{ c.label }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>Priority *</label>
          <select v-model="priorityKey" required>
            <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
              {{ p.label }}
            </option>
          </select>
        </div>
      </div>
      <p class="muted small" style="margin-top: -8px">
        Applied to the ticket(s) created once this estimate is confirmed or manually converted.
      </p>

      <div class="field">
        <label>Notes</label>
        <textarea v-model="notes" placeholder="Anything else worth including on the estimate or the resulting ticket(s)" />
      </div>

      <div class="card tight" style="margin-bottom: 16px">
        <div class="row">
          <span>Estimated total</span>
          <div class="spacer" />
          <strong style="font-size: 18px">
            {{ grandTotal.minCost === grandTotal.maxCost
              ? money(grandTotal.minCost)
              : `${money(grandTotal.minCost)} – ${money(grandTotal.maxCost)}` }}
          </strong>
        </div>
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>

      <div class="row">
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? 'Creating…' : 'Save estimate' }}
        </button>
        <button type="button" @click="router.back()">Cancel</button>
      </div>
    </form>
  </div>
</template>
