<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';
import TechnicianPicker from '../components/TechnicianPicker.vue';
import InstrumentModelPicker from '../components/InstrumentModelPicker.vue';

const router = useRouter();
const settings = useSettings();
const refData = useRefData();

const customers = ref([]);
const instruments = ref([]);
const error = ref('');
const busy = ref(false);
// N9: set once the primary ticket is actually created, so a partial
// failure creating one of its sibling instruments/tickets (below) can
// still point the user at the ticket that *did* get made, rather than
// stranding them on a form that looks like nothing happened.
const createdTicketId = ref(null);

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
  customer_id: '',
  instrument_id: '',
  technician_ids: [],
  notes: '',
  drop_off_date: '',
  due_date: '',
  multi_instrument: false,
  qc_required: true,
  // Every Orders & Shipping ticket is a shipping/logistics job now — no
  // checkbox to ask (see NOTES.md) — so this is only ever meaningful once
  // isShippingCategory (below) is true. Lets a ticket for an *inbound*
  // shipment (nothing serviced here yet, so no existing ticket to "Ship
  // this instrument" from) carry a destination the same as one spun off
  // that way.
  shipping_contact_info: '',
});

// True exactly when this ticket will land as an is_shipping ticket —
// mirrors the backend's own POST /tickets rule (routes/tickets.js) one
// to one, now that the category *is* the whole decision.
const isShippingCategory = computed(() => form.value.category_key === 'orders_shipping');

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
  if (key === 'orders_shipping') {
    // qc_required is meaningless once is_shipping hides the whole QC/
    // Invoicing story (its checkbox is hidden below too) — keep the
    // stored value honest rather than leaving a stale `true` sitting
    // unused. Safe to set unconditionally here since the checkbox is
    // unreachable while this category is picked, so nothing overwrites it
    // afterward.
    form.value.qc_required = false;
  } else {
    // The contact-info field only ever shows under Orders & Shipping
    // (below) — clear it on the way out so switching categories and back
    // doesn't leave a stale destination the user never actually confirmed
    // under the new category.
    form.value.shipping_contact_info = '';
  }
}

// Status options are category- and is_shipping-aware (mirrors
// TicketDetailView.vue's own edit dropdown and services/settings.js's
// statusAppliesToCategory) — a plain unfiltered list here let someone pick
// e.g. "QC" for a Daily To-Do's or a shipping-flagged ticket, which would
// then fail at submit() with a 400 the form never explained.
const statusOptions = computed(
  () => settings.statusesForCategory(form.value.category_key, isShippingCategory.value),
);
// If the category changes out from under the currently-picked status,
// re-home it to that combination's default rather than silently
// submitting a status the backend will reject.
watch(() => form.value.category_key, () => {
  if (!statusOptions.value.some((s) => s.key === form.value.status_key)) {
    form.value.status_key = statusOptions.value[0]?.key || '';
  }
});

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
const newInstrument = ref({ enabled: false, family: 'rhodes', model: '', year: '', serial_no: '', nickname: '' });

// Creating a customer inline, same reasoning as the instrument above: a walk-in
// customer shouldn't need a trip to the Customers page before we can open their ticket.
const newCustomer = ref({ enabled: false, name: '', email: '', phone: '', source: 'direct' });

// N9: multi-instrument jobs. Boss's call was sibling tickets — one full
// ticket per instrument, linked as a family — over a join table, reusing
// the same source_ticket_id "created from another ticket" mechanism
// TicketSubTickets.vue's sub-tickets already use (migration 008), rather
// than a new dedicated schema. Each row here becomes one extra ticket
// created right after the primary, in submit() below; same
// existing-vs-add-new-inline choice the primary instrument field offers.
const siblingInstruments = ref([]);
function blankSibling() {
  return {
    mode: 'existing', instrument_id: '',
    family: 'rhodes', model: '', year: '', serial_no: '', nickname: '',
  };
}
function addSibling() {
  siblingInstruments.value.push(blankSibling());
}
function removeSibling(index) {
  siblingInstruments.value.splice(index, 1);
}
// Unchecking "Multi-instrument job" drops whatever sibling rows were
// started — same as any other reveal-on-checkbox section in this form,
// nothing here is meant to persist once the checkbox that shows it is off.
watch(() => form.value.multi_instrument, (on) => {
  if (!on) siblingInstruments.value = [];
});

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

// N10: mirrors composeTicketTitle in routes/tickets.js exactly —
// "[Client Name] - [\"Nickname\"] [Year] [Family] [Model leaf]", e.g.
// `Dolly Jones - "Old Betsy" 1973 Rhodes Stage 73` — whichever pieces are
// actually present, no dash when either side is empty. Drives both the
// Title field's placeholder/required-ness below and submit()'s own
// fallback check, so a title is never silently sent blank when the
// auto-generated one would also be blank.
//
// `model` is a plain string (InstrumentModelPicker's cascading tree pick,
// flattened to a " / "-joined chain, or manual free text) — modelLeaf
// takes just its last segment, same "the specific model, not the whole
// era/mark path to it" rule the backend's own modelLeaf() applies.
function modelLeaf(model) {
  if (!model) return '';
  const segments = String(model).split('/').map((s) => s.trim()).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}
const autoTitlePreview = computed(() => {
  const customerName = newCustomer.value.enabled
    ? newCustomer.value.name.trim()
    : (customers.value.find((c) => c.id === form.value.customer_id)?.name || '');

  const inst = newInstrument.value.enabled
    ? newInstrument.value
    : instruments.value.find((i) => i.id === form.value.instrument_id);
  const nicknamePart = inst?.nickname?.trim() ? `"${inst.nickname.trim()}"` : '';
  const instrumentTypeParts = [];
  if (inst?.year) instrumentTypeParts.push(String(inst.year).trim());
  if (inst?.family) instrumentTypeParts.push(refData.familyLabel(inst.family));
  const leaf = modelLeaf(inst?.model);
  if (leaf) instrumentTypeParts.push(leaf);
  const descriptor = [nicknamePart, instrumentTypeParts.join(' ')].filter(Boolean).join(' ');

  if (customerName && descriptor) return `${customerName} - ${descriptor}`;
  return customerName || descriptor;
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
  // N1: title itself is only required when there's nothing to auto-generate
  // one from (see autoTitlePreview and composeTicketTitle in
  // routes/tickets.js — this mirrors that exact rule).
  if (!form.value.title.trim() && !autoTitlePreview.value) {
    error.value = 'Give this ticket a title, or pick a customer/instrument to generate one.';
    return;
  }
  busy.value = true;
  try {
    const payload = { ...form.value };
    if (payload.subcategory_other_text) payload.subcategory_other_text = payload.subcategory_other_text.trim();
    // A blank title is a real, valid submission now (N1) — POST /tickets
    // composes one from the customer/instrument. Trim rather than send a
    // whitespace-only title through as if it were meaningful.
    payload.title = payload.title.trim() || null;

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
        nickname: newInstrument.value.nickname.trim() || null,
        customer_id: payload.customer_id || null,
      });
      payload.instrument_id = created.id;
    }

    // Blank <select> values are '' — the API wants null. (technician_ids is
    // already a real array, so it doesn't need this treatment.)
    for (const k of ['customer_id', 'instrument_id', 'drop_off_date', 'due_date',
      'subcategory_key', 'subcategory_other_text']) {
      if (payload[k] === '') payload[k] = null;
    }

    const ticket = await api.post('/tickets', payload);
    createdTicketId.value = ticket.id;

    // N9: one sibling ticket per additional instrument, each linked back
    // via source_ticket_id — same category/priority/technicians/notes as
    // the primary (not re-resolved per family), title left blank so N1's
    // composeTicketTitle generates a per-instrument one on the backend.
    // Blank rows (nothing picked/typed) are silently skipped, same
    // "only submit if there's actually something there" gating the
    // primary instrument's own inline-add form uses above.
    const siblingFailures = [];
    if (form.value.multi_instrument) {
      for (const sib of siblingInstruments.value) {
        try {
          let instrumentId = null;
          if (sib.mode === 'existing') {
            if (!sib.instrument_id) continue;
            instrumentId = sib.instrument_id;
          } else {
            if (!sib.model.trim()) continue;
            // eslint-disable-next-line no-await-in-loop -- siblings are
            // created one at a time, deliberately: each is an independent
            // POST /tickets call (there's no multi-row transactional
            // endpoint), so sequential keeps a failure attributable to
            // exactly one sibling rather than firing them all at once and
            // untangling which one broke.
            const createdInst = await api.post('/instruments', {
              family: sib.family,
              model: sib.model,
              year: sib.year || null,
              serial_no: sib.serial_no || null,
              nickname: sib.nickname.trim() || null,
              customer_id: payload.customer_id || null,
            });
            instrumentId = createdInst.id;
          }
          // eslint-disable-next-line no-await-in-loop -- see above
          await api.post('/tickets', {
            title: null,
            category_key: payload.category_key,
            subcategory_key: payload.subcategory_key,
            subcategory_other_text: payload.subcategory_other_text,
            priority_key: payload.priority_key,
            status_key: payload.status_key,
            customer_id: payload.customer_id,
            instrument_id: instrumentId,
            technician_ids: payload.technician_ids,
            notes: payload.notes,
            drop_off_date: payload.drop_off_date,
            due_date: payload.due_date,
            multi_instrument: true,
            qc_required: payload.qc_required,
            shipping_contact_info: payload.shipping_contact_info,
            source_ticket_id: ticket.id,
          });
        } catch (err) {
          siblingFailures.push(err.message);
        }
      }
    }

    if (siblingFailures.length) {
      // The primary (and any siblings that DID succeed) are real,
      // already-created tickets — staying put with a link beats
      // navigating away and losing track of a partial failure, or
      // silently swallowing it.
      error.value = `Ticket #${ticket.id} was created, but ${siblingFailures.length} `
        + `additional instrument(s) failed: ${siblingFailures.join('; ')}. `
        + `You can add the missing one(s) as a sub-ticket from the ticket page.`;
      return;
    }

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
        <label>Title{{ autoTitlePreview ? '' : ' *' }}</label>
        <input
          v-model="form.title"
          :required="!autoTitlePreview"
          :placeholder="autoTitlePreview || 'e.g. Steve Dawson — Wurlitzer 200A full resto'"
        />
        <!-- N1: only shown once there's actually something to preview — a
             blank title plus no customer/instrument is still a hard error
             (submit() above), same as before this packet. -->
        <p v-if="autoTitlePreview && !form.title.trim()" class="muted small" style="margin: 4px 0 0">
          Left blank, this ticket will be titled "{{ autoTitlePreview }}".
        </p>
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
            <option v-for="s in statusOptions" :key="s.key" :value="s.key">
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
              {{ i.family }} · <template v-if="i.nickname">"{{ i.nickname }}" </template>{{ i.model }}
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
              <option v-for="f in refData.families" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
            </select>
          </div>
          <div class="field">
            <label>Model</label>
            <InstrumentModelPicker :family="newInstrument.family" v-model="newInstrument.model" />
          </div>
          <div class="field">
            <label>Year</label>
            <input v-model="newInstrument.year" placeholder="1972" />
          </div>
          <div class="field">
            <label>Serial</label>
            <input v-model="newInstrument.serial_no" />
          </div>
          <div class="field">
            <label>Nickname</label>
            <input v-model="newInstrument.nickname" placeholder="e.g. Old Betsy" />
          </div>
        </div>
      </div>

      <!-- N8: tech level moved to the per-task picker (TicketTasks.vue,
           after the ticket exists) — a ticket's tasks can span more than
           one level, which a single ticket-wide field never could. The
           tech_level_key column stays on tickets (it costs nothing to
           leave it), it just isn't set here anymore. -->

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
        <label v-if="!isShippingCategory" class="checkbox" style="margin: 0">
          <input v-model="form.qc_required" type="checkbox" />
          <span>QC required before invoicing</span>
        </label>
      </div>

      <!-- Every Orders & Shipping ticket is a shipping/logistics job now
           (see NOTES.md) — no checkbox to ask, just the destination for
           it. Covers the case "Ship this instrument" can't: an *inbound*
           shipment, where there's no existing ticket yet to launch that
           from. -->
      <div v-if="isShippingCategory" class="field">
        <label>Shipping to / contact info</label>
        <input
          v-model="form.shipping_contact_info"
          placeholder="Name, address, phone — whatever this destination needs"
        />
        <p v-if="form.multi_instrument" class="muted small" style="margin: 4px 0 0">
          Copied onto every additional instrument's ticket below too, since they're going to the same place.
        </p>
      </div>

      <!-- N9: sibling tickets, one per additional instrument, created
           right after the primary (submit() above) and linked back via
           source_ticket_id — same family mechanism as sub-tickets. -->
      <div v-if="form.multi_instrument" class="card tight" style="margin-bottom: 14px">
        <div class="row" style="margin-bottom: 10px">
          <strong class="small">Additional instruments</strong>
          <span class="muted small">— one more ticket per instrument, same customer/category/techs</span>
          <div class="spacer" />
          <button type="button" class="small" @click="addSibling">+ Add instrument</button>
        </div>
        <div v-if="!siblingInstruments.length" class="empty">
          None added yet — this job will just be the one ticket above.
        </div>
        <div
          v-for="(sib, i) in siblingInstruments" :key="i"
          class="field-row" style="align-items: end; margin-bottom: 10px"
        >
          <div class="field" style="flex: none; margin: 0">
            <label>&nbsp;</label>
            <select v-model="sib.mode" style="width: auto">
              <option value="existing">Existing instrument</option>
              <option value="new">Add new</option>
            </select>
          </div>
          <template v-if="sib.mode === 'existing'">
            <div class="field" style="margin: 0">
              <label>Instrument</label>
              <select v-model="sib.instrument_id">
                <option value="">— pick one —</option>
                <option
                  v-for="inst in instruments.filter((x) => x.id !== form.instrument_id)"
                  :key="inst.id" :value="inst.id"
                >
                  {{ inst.family }} · <template v-if="inst.nickname">"{{ inst.nickname }}" </template>{{ inst.model }}
                </option>
              </select>
            </div>
          </template>
          <template v-else>
            <div class="field" style="margin: 0">
              <label>Family</label>
              <select v-model="sib.family">
                <option v-for="f in refData.families" :key="f" :value="f">{{ refData.familyLabel(f) }}</option>
              </select>
            </div>
            <div class="field" style="margin: 0">
              <label>Model</label>
              <InstrumentModelPicker :family="sib.family" v-model="sib.model" />
            </div>
            <div class="field" style="margin: 0">
              <label>Nickname</label>
              <input v-model="sib.nickname" placeholder="e.g. Old Betsy" />
            </div>
          </template>
          <div class="field" style="flex: none; margin: 0">
            <label>&nbsp;</label>
            <button type="button" class="small" @click="removeSibling(i)">Remove</button>
          </div>
        </div>
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 14px">
        {{ error }}
        <RouterLink v-if="createdTicketId" :to="{ name: 'ticket', params: { id: createdTicketId } }">
          Go to ticket #{{ createdTicketId }} →
        </RouterLink>
      </div>

      <div class="row">
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? 'Creating…' : 'Create ticket' }}
        </button>
        <button type="button" @click="router.back()">Cancel</button>
      </div>
    </form>
  </div>
</template>
