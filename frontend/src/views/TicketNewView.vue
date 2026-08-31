<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';
import TechnicianPicker from '../components/TechnicianPicker.vue';

const router = useRouter();
const settings = useSettings();
const refData = useRefData();

const customers = ref([]);
const instruments = ref([]);
const error = ref('');
const busy = ref(false);

// Family -> default technician ids (Settings -> Default instrument
// assignments). Pre-fills the picker below the moment an instrument type
// is chosen; still just a starting point, edited same as any other field.
const defaultTechsByFamily = ref({});

// category_key/priority_key start blank and are filled in on mount from
// whatever's actually active in Settings (see onMounted below) — hardcoding
// either here would silently break new-ticket creation the moment it gets
// retired (N4a). Both actually did retire, per the boss list's category/
// priority reshuffle (N2b/N4b) — 'servicing' is now 'repairs_restoration'
// and 'standard_setup' is now 'standard_priority', below.
const form = ref({
  title: '',
  category_key: '',
  // N2c/N2a: a category can nest one level (SideQuests' Hunt/R&D/Outreach/
  // Other, Repairs & Restoration's Custom Shop/Inventory Restorations —
  // see NOTES.md §2.30). subcategory_other_text only applies to a child
  // flagged meta.allow_free_text (SideQuests' "Other").
  subcategory_key: '',
  subcategory_other_text: '',
  priority_key: '',
  status_key: '',
  tech_level_key: '',
  customer_id: '',
  instrument_id: '',
  technician_ids: [],
  notes: '',
  drop_off_date: '',
  due_date: '',
  multi_instrument: false,
  qc_required: true,
});

// N2c: category buttons instead of a dropdown, same row-of-buttons pattern
// QueueView.vue already uses for its instrument-type/category pickers.
// Picking a new top-level category clears any previously-chosen
// sub-category — a Custom Shop pick under Repairs & Restoration has no
// business surviving a switch to Housekeeping (mirrors the backend's own
// "re-home or clear" rule for an existing ticket's category change, see
// resolveSubcategory()/PATCH in routes/tickets.js and NOTES.md §2.30).
function pickCategory(key) {
  form.value.category_key = key;
  form.value.subcategory_key = '';
  form.value.subcategory_other_text = '';
}

// The sub-category row only appears once the chosen top-level category
// actually has children (settings.childrenOf — N2a).
const subcategoryOptions = computed(
  () => settings.childrenOf('ticket_category', form.value.category_key),
);
const selectedSubcategory = computed(
  () => subcategoryOptions.value.find((c) => c.key === form.value.subcategory_key),
);

function pickSubcategory(key) {
  form.value.subcategory_key = form.value.subcategory_key === key ? '' : key;
  form.value.subcategory_other_text = '';
}

// Creating an instrument inline: retyping a customer's piano into a separate
// screen first is friction nobody will tolerate at intake.
const newInstrument = ref({ enabled: false, family: 'rhodes', model: '', year: '', serial_no: '' });

// Creating a customer inline, same reasoning as the instrument above: a walk-in
// customer shouldn't need a trip to the Customers page before we can open their ticket.
const newCustomer = ref({ enabled: false, name: '', email: '', phone: '', source: 'direct' });

async function loadCustomerInstruments() {
  form.value.instrument_id = '';
  if (!form.value.customer_id) { instruments.value = []; return; }
  instruments.value = await api.get('/instruments', { customer_id: form.value.customer_id });
}

// Whichever instrument type is currently selected, however it got picked —
// an existing instrument from the customer's list, or the family chosen
// while adding a new one inline. '' means "nothing selected yet."
const selectedFamily = computed(() => {
  if (newInstrument.value.enabled) return newInstrument.value.family || '';
  const inst = instruments.value.find((i) => i.id === form.value.instrument_id);
  return inst ? inst.family : '';
});

// Auto-fill on every *change* of instrument type — not on every keystroke
// elsewhere in the form, and not a one-time default, so switching types
// mid-form updates the picker again rather than leaving it stuck on the
// first type's techs.
watch(selectedFamily, (family) => {
  if (!family) return;
  form.value.technician_ids = [...(defaultTechsByFamily.value[family] || [])];
});

onMounted(async () => {
  const [custs, techDefaults] = await Promise.all([
    api.get('/customers'),
    api.get('/instruments/default-technicians'),
  ]);
  customers.value = custs;
  defaultTechsByFamily.value = techDefaults;
  form.value.status_key = settings.statuses.find((s) => !s.retired)?.key || '';
  // Prefer the historical default if it's still active; otherwise fall
  // back to whatever sorts first, same "don't assume a key survives"
  // reasoning as status_key just above (N4a).
  const activeCategories = settings.active('ticket_category');
  form.value.category_key = activeCategories.find((c) => c.key === 'repairs_restoration')?.key
    || activeCategories[0]?.key || '';
  const activePriorities = settings.active('priority_tier');
  form.value.priority_key = activePriorities.find((p) => p.key === 'standard_priority')?.key
    || activePriorities[0]?.key || '';
});

async function submit() {
  error.value = '';
  // Category is a button row now, not a <select required> (N2c) — no
  // native HTML validation to lean on, so it's checked explicitly here.
  if (!form.value.category_key) { error.value = 'Pick a category.'; return; }
  if (selectedSubcategory.value?.meta?.allow_free_text && !form.value.subcategory_other_text.trim()) {
    error.value = `Say what "${selectedSubcategory.value.label}" is.`;
    return;
  }
  busy.value = true;
  try {
    const payload = { ...form.value };
    if (payload.subcategory_other_text) payload.subcategory_other_text = payload.subcategory_other_text.trim();

    if (newCustomer.value.enabled && newCustomer.value.name.trim()) {
      const created = await api.post('/customers', {
        name: newCustomer.value.name.trim(),
        email: newCustomer.value.email || null,
        phone: newCustomer.value.phone || null,
        source: newCustomer.value.source || null,
      });
      payload.customer_id = created.id;
    }

    if (newInstrument.value.enabled && newInstrument.value.model) {
      const created = await api.post('/instruments', {
        family: newInstrument.value.family,
        model: newInstrument.value.model,
        year: newInstrument.value.year || null,
        serial_no: newInstrument.value.serial_no || null,
        customer_id: payload.customer_id || null,
      });
      payload.instrument_id = created.id;
    }

    // Blank <select> values are '' — the API wants null. (technician_ids is
    // already a real array, so it doesn't need this treatment.)
    for (const k of ['customer_id', 'instrument_id', 'tech_level_key', 'drop_off_date', 'due_date',
      'subcategory_key', 'subcategory_other_text']) {
      if (payload[k] === '') payload[k] = null;
    }

    const ticket = await api.post('/tickets', payload);
    router.push({ name: 'ticket', params: { id: ticket.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 780px">
    <div class="page-head"><h1>New ticket</h1></div>

    <form class="card" @submit.prevent="submit">
      <div class="field">
        <label>Title *</label>
        <input v-model="form.title" required placeholder="e.g. Steve Dawson — Wurlitzer 200A full resto" />
      </div>

      <div class="field">
        <label>Category *</label>
        <div class="row">
          <button
            v-for="c in settings.topLevel('ticket_category')" :key="c.key"
            type="button" class="small" :class="{ primary: form.category_key === c.key }"
            @click="pickCategory(c.key)"
          >{{ c.label }}</button>
        </div>
      </div>

      <!-- N2c: only appears once the chosen category actually has children
           (N2a) — Repairs & Restoration's Custom Shop/Inventory
           Restorations, SideQuests' Hunt/R&D/Outreach/Other. Optional: the
           parent category is a perfectly good bucket on its own. -->
      <div v-if="subcategoryOptions.length" class="field">
        <label>Sub-category</label>
        <div class="row">
          <button
            v-for="c in subcategoryOptions" :key="c.key"
            type="button" class="small" :class="{ primary: form.subcategory_key === c.key }"
            @click="pickSubcategory(c.key)"
          >{{ c.label }}</button>
        </div>
      </div>
      <div v-if="selectedSubcategory?.meta?.allow_free_text" class="field">
        <label>{{ selectedSubcategory.label }} — what is it? *</label>
        <input v-model="form.subcategory_other_text" placeholder="e.g. estate sale walkthrough" />
      </div>

      <div class="field-row">
        <div class="field">
          <label>Priority *</label>
          <select v-model="form.priority_key" required>
            <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
              {{ p.label }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>Status</label>
          <select v-model="form.status_key">
            <option v-for="s in settings.active('ticket_status')" :key="s.key" :value="s.key">
              {{ s.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Customer</label>
          <select v-model="form.customer_id" :disabled="newCustomer.enabled" @change="loadCustomerInstruments">
            <option value="">— none (internal / fleet) —</option>
            <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>Instrument</label>
          <select v-model="form.instrument_id" :disabled="newInstrument.enabled">
            <option value="">— none —</option>
            <option v-for="i in instruments" :key="i.id" :value="i.id">
              {{ i.family }} · {{ i.model }}
            </option>
          </select>
        </div>
      </div>

      <div class="field">
        <label class="checkbox">
          <input v-model="newCustomer.enabled" type="checkbox" />
          <span>Add a new customer instead</span>
        </label>
      </div>

      <div v-if="newCustomer.enabled" class="card tight" style="margin-bottom: 14px">
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

      <div class="field">
        <label class="checkbox">
          <input v-model="newInstrument.enabled" type="checkbox" />
          <span>Add a new instrument instead</span>
        </label>
      </div>

      <div v-if="newInstrument.enabled" class="card tight" style="margin-bottom: 14px">
        <div class="field-row">
          <div class="field">
            <label>Family</label>
            <select v-model="newInstrument.family">
              <option v-for="f in refData.families" :key="f" :value="f">{{ f }}</option>
            </select>
          </div>
          <div class="field">
            <label>Model</label>
            <input v-model="newInstrument.model" placeholder="Wurlitzer 200A" />
          </div>
          <div class="field">
            <label>Year</label>
            <input v-model="newInstrument.year" placeholder="1972" />
          </div>
          <div class="field">
            <label>Serial</label>
            <input v-model="newInstrument.serial_no" />
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Tech level required</label>
          <select v-model="form.tech_level_key">
            <option value="">— any —</option>
            <option v-for="t in settings.active('tech_level')" :key="t.key" :value="t.key">
              {{ t.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Assign to</label>
        <TechnicianPicker v-model="form.technician_ids" />
      </div>

      <div class="field-row">
        <div class="field">
          <label>Drop-off date</label>
          <input v-model="form.drop_off_date" type="date" />
        </div>
        <div class="field">
          <label>Target date</label>
          <input v-model="form.due_date" type="date" />
        </div>
      </div>

      <div class="field">
        <label>Notes &amp; parts</label>
        <textarea v-model="form.notes" placeholder="Grommets, hammer tips, tune & voice…" />
      </div>

      <div class="field row">
        <label class="checkbox" style="margin: 0">
          <input v-model="form.multi_instrument" type="checkbox" />
          <span>Multi-instrument job</span>
        </label>
        <label class="checkbox" style="margin: 0">
          <input v-model="form.qc_required" type="checkbox" />
          <span>QC required before invoicing</span>
        </label>
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">{{ error }}</div>

      <div class="row">
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? 'Creating…' : 'Create ticket' }}
        </button>
        <button type="button" @click="router.back()">Cancel</button>
      </div>
    </form>
  </div>
</template>
