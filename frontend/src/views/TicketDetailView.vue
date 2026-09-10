<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import api from '../api';
import { useAuth, useSettings, useRefData } from '../stores';
import TicketPhotos from '../components/TicketPhotos.vue';
import CustomerSearchSelect from '../components/CustomerSearchSelect.vue';
import InstrumentModelPicker from '../components/InstrumentModelPicker.vue';
import TicketQc from '../components/TicketQc.vue';
import TicketEstimate from '../components/TicketEstimate.vue';
import TicketPurchase from '../components/TicketPurchase.vue';
import TicketShipment from '../components/TicketShipment.vue';
import TicketSubTickets from '../components/TicketSubTickets.vue';
import TicketTasks from '../components/TicketTasks.vue';
import TechnicianPicker from '../components/TechnicianPicker.vue';

const props = defineProps({ id: { type: String, required: true } });

const auth = useAuth();
const settings = useSettings();
const refData = useRefData();
const router = useRouter();

const ticket = ref(null);
// Q5: lets TicketQc.vue's "report an issue" flow refresh the Tasks panel
// it doesn't otherwise talk to (see TicketTasks.vue's defineExpose).
const ticketTasksRef = ref(null);
// Let the page header's consolidated quick-action buttons reach into
// TicketSubTickets.vue/TicketEstimate.vue and open their own "+ Add…"
// forms, the same way ticketTasksRef reaches into TicketTasks.vue above —
// those forms still need to live in their own cards, which now only
// render once there's something in them (see each component's own
// defineExpose/docstring).
const subTicketsRef = ref(null);
const estimateRef = ref(null);
const loading = ref(true);
const error = ref('');
const statusNote = ref('');
const notesDraft = ref('');
const savingNotes = ref(false);
// "Status notes" (Settings -> Ticket categories -> "Status notes" toggle) —
// two free-text fields distinct from the status-CHANGE note above
// (statusNote, attached to the audit log entry when the status dropdown
// changes) and from the general Notes & parts field: these track what was
// actually done on the job vs. what's still outstanding, editable any time
// rather than only at the moment of a status change.
const serviceDoneDraft = ref('');
const serviceNeededDraft = ref('');
const savingStatusNotes = ref(false);
const progressUpdate = ref(null);
const generatingUpdate = ref(false);
// "Assigned technicians" takes up a lot of space once a ticket has people
// on it, so it starts collapsed behind a summary + "Show" toggle whenever
// someone's already assigned, and expanded when nobody is (there's nothing
// to summarize, and it's the thing you'd want to fill in first). Only
// initialized once per ticket — see lastInitializedTicketId below — so
// assigning the first tech mid-edit doesn't yank the picker away right
// as it re-fetches after that save.
const showTechnicians = ref(true);
const lastInitializedTicketId = ref(null);

// Customer contact popover — the customer's email/phone/address inline
// instead of navigating to /customers just to read one of them (the
// RouterLink there still exists, inside the popover, for anything that
// actually needs the full profile). Same click-outside/Escape convention
// as QueueView.vue's hide-statuses menu (see styles.css's
// .customer-contact-* rules, styled the same way as that menu's
// .hide-status-* rules).
const customerMenuOpen = ref(false);
const customerMenuEl = ref(null);

function closeCustomerMenu() {
  customerMenuOpen.value = false;
}

// Customer/instrument used to be set once at intake and never touched
// again -- a ticket created without one (or with the wrong one) had no way
// to fix that short of editing the DB directly. Both follow the same
// "Change" toggle shape as Assigned technicians above/below. Customer goes
// through an explicit Save rather than patching on every CustomerSearchSelect
// `change` event, because that component fires `change: null` on the very
// first keystroke of a new search (see its onInput) -- patching immediately
// would clear the ticket's customer the moment someone started typing to
// replace it. Instrument uses a plain native <select>, which only fires
// `change` on an actual pick, so it can patch straight away like Status/
// Priority/Category above do.
const editingCustomer = ref(false);
const customerEditValue = ref('');
function startEditCustomer() {
  customerEditValue.value = ticket.value.customer_id || '';
  editingCustomer.value = true;
}
function toggleEditCustomer() {
  if (editingCustomer.value) editingCustomer.value = false;
  else startEditCustomer();
}
async function saveCustomer() {
  await patch({ customer_id: customerEditValue.value || null });
  if (!error.value) editingCustomer.value = false;
}

const editingInstrument = ref(false);
const instrumentOptions = ref([]);
const loadingInstrumentOptions = ref(false);
// Scoped to the ticket's current customer, same as the instrument dropdown
// on TicketNewView.vue -- or to the fleet when there's no customer, since
// that's the only other place a ticket's instrument comes from.
async function startEditInstrument() {
  editingInstrument.value = true;
  loadingInstrumentOptions.value = true;
  try {
    instrumentOptions.value = ticket.value.customer_id
      ? await api.get('/instruments', { customer_id: ticket.value.customer_id })
      : await api.get('/instruments', { fleet: 'true' });
  } finally {
    loadingInstrumentOptions.value = false;
  }
}
function toggleEditInstrument() {
  if (editingInstrument.value) editingInstrument.value = false;
  else startEditInstrument();
}
async function onInstrumentChange(event) {
  await patch({ instrument_id: event.target.value || null });
  if (!error.value) editingInstrument.value = false;
}

// A brand-new customer (just attached via the Customer "Change" control
// above) has no instruments of their own yet, so the existing-instrument
// dropdown alone can't cover "this ticket had no customer, someone added
// one, now their instrument needs to exist too." Mirrors TicketNewView.vue's
// "Add a new instrument instead" card almost exactly, just POSTing
// immediately and attaching it instead of waiting on a create-time submit.
const addingInstrument = ref(false);
const creatingInstrument = ref(false);
const blankNewInstrument = () => ({
  family: refData.families[0] || '', model: '', year: '', serial_no: '', nickname: '',
});
const newInstrumentDraft = ref(blankNewInstrument());
function startAddInstrument() {
  newInstrumentDraft.value = blankNewInstrument();
  addingInstrument.value = true;
}
async function createAndAttachInstrument() {
  if (!newInstrumentDraft.value.model) {
    error.value = 'Model is required to add a new instrument.';
    return;
  }
  error.value = '';
  creatingInstrument.value = true;
  try {
    const created = await api.post('/instruments', {
      family: newInstrumentDraft.value.family,
      model: newInstrumentDraft.value.model,
      year: newInstrumentDraft.value.year || null,
      serial_no: newInstrumentDraft.value.serial_no || null,
      nickname: newInstrumentDraft.value.nickname.trim() || null,
      customer_id: ticket.value.customer_id || null,
    });
    await patch({ instrument_id: created.id });
    if (!error.value) {
      addingInstrument.value = false;
      editingInstrument.value = false;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    creatingInstrument.value = false;
  }
}
function onDocumentClick(event) {
  if (customerMenuOpen.value && customerMenuEl.value && !customerMenuEl.value.contains(event.target)) {
    closeCustomerMenu();
  }
}
function onDocumentKeydown(event) {
  if (event.key === 'Escape') closeCustomerMenu();
}

// Below 640px -- the breakpoint styles.css already uses elsewhere (e.g.
// .page's rules) and where .grid.cols-2 itself collapses to one column --
// Photos moves up to sit right under Details instead of trailing after
// QC/Shipment further down. Kept as a single conditionally-placed instance
// rather than one hidden with CSS in each spot: TicketPhotos registers a
// page-wide paste listener onMounted, so two live copies would
// double-handle every pasted photo.
const mobileQuery = window.matchMedia('(max-width: 640px)');
const isMobile = ref(mobileQuery.matches);
function onMobileQueryChange(event) {
  isMobile.value = event.matches;
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
  mobileQuery.addEventListener('change', onMobileQueryChange);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onDocumentKeydown);
  mobileQuery.removeEventListener('change', onMobileQueryChange);
});

// `silent` distinguishes a genuine page load (first mount, or switching to
// a different ticket -- nothing on screen yet, so blanking to "Loading..."
// below is fine) from a refresh after some small edit elsewhere on this
// page (patch(), or a child panel's @changed -- a shipment checkbox, a QC
// note, etc). Those refreshes used to share the same `loading` flag, which
// tore the *entire* ticket page down to "Loading..." on every single field
// edit or checkbox click. Call them silently instead so they swap in the
// fresh ticket data in place, without the flash.
async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    ticket.value = await api.get(`/tickets/${props.id}`);
    // Only resync the drafts on a real load -- a silent background refresh
    // shouldn't clobber text someone is still mid-typing in Notes / status
    // notes with whatever the server happened to have at that moment.
    if (!silent) {
      notesDraft.value = ticket.value.notes || '';
      serviceDoneDraft.value = ticket.value.service_done_notes || '';
      serviceNeededDraft.value = ticket.value.service_needed_notes || '';
    }
    if (lastInitializedTicketId.value !== ticket.value.id) {
      showTechnicians.value = !(ticket.value.technicians || []).length;
      lastInitializedTicketId.value = ticket.value.id;
    }
    const updates = await api.get('/progress-updates', { ticket_id: props.id });
    progressUpdate.value = updates[0] || null;
  } finally {
    if (!silent) loading.value = false;
  }
}

onMounted(() => load());
watch(() => props.id, () => load());

async function patch(payload) {
  error.value = '';
  try {
    await api.patch(`/tickets/${props.id}`, payload);
    await load(true);
  } catch (err) {
    error.value = err.message;
  }
}

async function changeStatus(event) {
  await patch({ status_key: event.target.value, status_note: statusNote.value || null });
  statusNote.value = '';
}

async function saveNotes() {
  savingNotes.value = true;
  await patch({ notes: notesDraft.value });
  savingNotes.value = false;
}

async function saveStatusNotes() {
  savingStatusNotes.value = true;
  await patch({
    service_done_notes: serviceDoneDraft.value,
    service_needed_notes: serviceNeededDraft.value,
  });
  savingStatusNotes.value = false;
}

async function generateUpdate() {
  generatingUpdate.value = true;
  error.value = '';
  try {
    progressUpdate.value = await api.post('/progress-updates', { ticket_id: ticket.value.id });
    router.push({ name: 'progress-update', params: { id: progressUpdate.value.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    generatingUpdate.value = false;
  }
}

async function createInvoice() {
  error.value = '';
  try {
    await api.post('/invoices', { ticket_id: ticket.value.id });
    await load(true);
  } catch (err) {
    error.value = err.message;
  }
}

// "Ship this instrument" — moved here from TicketSubTickets.vue (see that
// file's updated docstring) since it's a page-header quick action now,
// same one-click "create the shipping sub-ticket, then jump straight to
// it" shortcut as before (routes/tickets.js's create-shipping-ticket
// route). hasShippingChild/shipButtonVisible mirror what that component
// used to compute internally.
const shippingBusy = ref(false);
const hasShippingChild = computed(() => (ticket.value?.child_tickets || []).some((c) => c.is_shipping));
// Settings -> Ticket categories -> "Ship button" lets an admin turn this
// quick-action off per category (e.g. a Shipping ticket has no business
// offering to spin off *another* shipping ticket) — see stores.js's
// shipButtonAllowed.
const shipButtonVisible = computed(() => (
  !!ticket.value?.instrument_id && !hasShippingChild.value
    && settings.shipButtonAllowed(ticket.value?.category_key)
));
async function createShippingTicket() {
  error.value = '';
  shippingBusy.value = true;
  try {
    const created = await api.post(`/tickets/${ticket.value.id}/create-shipping-ticket`);
    router.push({ name: 'ticket', params: { id: created.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    shippingBusy.value = false;
  }
}

async function archive() {
  if (!confirm('Archive this ticket? It stays searchable under "Show archived".')) return;
  await patch({ archived: true });
  router.push({ name: 'queue' });
}

const when = (ts) => new Date(ts).toLocaleString();

// A ticket can now be on more than one tech's plate (migration 013) —
// TechnicianPicker's v-model is just the list of assigned ids.
const assignedTechIds = computed(() => (ticket.value?.technicians || []).map((t) => t.id));

// Shipping tickets are pack-and-send jobs, not billable repair work — no QC
// round, no labor estimate, no hours logging, no invoice. Just the shared
// Details card plus the Shipment card (TicketShipment.vue). See NOTES.md.
// Driven by the ticket's own is_shipping flag (migration 028), not its
// category — N2b retired the old dedicated 'shipping' category, so this
// can no longer be a category_key check (see that migration's header for
// why the category and this flag aren't the same thing).
const isShipping = computed(() => !!ticket.value?.is_shipping);

// Customer progress update card (right column) — no customer to update
// on a non-repair ticket. is_shipping covers Shipping specifically (see
// isShipping above); settings.progressUpdateAllowed covers every other
// opted-out category (Housekeeping by default — migration 041).
const showProgressUpdate = computed(() => (
  !isShipping.value && settings.progressUpdateAllowed(ticket.value?.category_key)
));
</script>

<template>
  <div v-if="loading" class="page"><div class="empty">Loading…</div></div>

  <div v-else-if="ticket" class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">{{ ticket.title }}</h1>
        <div class="row muted small">
          <span>#{{ ticket.id }}</span>
          <span>· opened {{ new Date(ticket.created_at).toLocaleDateString() }}</span>
          <span v-if="ticket.legacy_ref">· sheet ref {{ ticket.legacy_ref }}</span>
          <span v-if="ticket.source_sheet">· imported from {{ ticket.source_sheet }}</span>
          <span v-if="ticket.source_ticket_id">
            · created from
            <RouterLink :to="{ name: 'ticket', params: { id: ticket.source_ticket_id } }">
              #{{ ticket.source_ticket_id }} — {{ ticket.source_ticket_title }}
            </RouterLink>
          </span>
          <!-- N9: siblings share this ticket's own source_ticket_id (the
               primary's id) rather than pointing at each other — see
               GET /tickets/:id's sibling_tickets query. -->
          <span v-if="ticket.sibling_tickets?.length">
            · part of a multi-instrument job with
            <template v-for="(s, i) in ticket.sibling_tickets" :key="s.id">
              <RouterLink :to="{ name: 'ticket', params: { id: s.id } }">#{{ s.id }}</RouterLink>
              <template v-if="i < ticket.sibling_tickets.length - 1">, </template>
            </template>
          </span>
        </div>
      </div>
      <div class="row">
        <span :class="['pill', settings.colorFor(ticket.status_key)]">
          {{ ticket.status_label }}
        </span>

        <!-- Quick actions, consolidated here from their own cards below
             (NOTES.md-style rationale: those cards were cumbersome to have
             all showing at once) — each card now only appears once it
             actually has something in it, or its own form is open; these
             buttons are what puts something in it. -->
        <button
          v-if="shipButtonVisible" class="small"
          :disabled="shippingBusy" @click="createShippingTicket"
        >{{ shippingBusy ? 'Creating…' : 'Ship this instrument' }}</button>
        <button class="small" @click="subTicketsRef?.openForm()">+ Add sub-ticket</button>
        <button v-if="!isShipping && auth.isSenior" class="small" @click="estimateRef?.openForm()">
          + Add estimate
        </button>
        <button
          v-if="showProgressUpdate && !progressUpdate" class="small"
          :disabled="generatingUpdate" @click="generateUpdate"
        >{{ generatingUpdate ? 'Generating…' : 'Generate progress update' }}</button>
        <button
          v-if="!isShipping && auth.isSenior && !ticket.invoices.length" class="small"
          @click="createInvoice"
        >Create invoice record</button>

        <span class="row" style="border-left: 1px solid var(--border); padding-left: 10px; margin-left: 2px">
          <button v-if="auth.isAdmin" class="small" @click="archive">Archive</button>
        </span>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div class="grid cols-2">
      <!-- ------------------------------------------------ left: the job -->
      <div class="stack">
        <div class="card">
          <h2>Details</h2>
          <div class="field-row">
            <div class="field">
              <label>Status</label>
              <select :value="ticket.status_key" @change="changeStatus">
                <option
                  v-for="s in settings.statusesForCategory(ticket.category_key, ticket.is_shipping)"
                  :key="s.key" :value="s.key"
                >
                  {{ s.label }}
                </option>
              </select>
            </div>
            <div class="field">
              <label>Note for this change (optional)</label>
              <input v-model="statusNote" placeholder="Why the status moved" />
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label>Priority</label>
              <select
                :value="ticket.priority_key"
                @change="patch({ priority_key: $event.target.value })"
              >
                <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
                  {{ p.label }}
                </option>
              </select>
            </div>
            <div class="field">
              <label>Category</label>
              <select
                :value="ticket.category_key"
                @change="patch({ category_key: $event.target.value })"
              >
                <option v-for="c in settings.active('ticket_category')" :key="c.key" :value="c.key">
                  {{ c.label }}
                </option>
              </select>
            </div>
            <!-- N8: tech level moved to the per-task picker (TicketTasks
                 further down) — a ticket's own tasks can span more than one
                 level, which this single ticket-wide field never could.
                 ticket.tech_level_key stays in the DB (costs nothing to
                 leave it there), it just isn't edited from here anymore. -->
          </div>

          <div class="field">
            <div class="row" style="margin-bottom: 4px">
              <label style="margin: 0">Assigned technicians</label>
              <span v-if="!showTechnicians" class="muted small">
                {{ ticket.technicians.map((t) => t.name).join(', ') }}
              </span>
              <div class="spacer" />
              <button
                v-if="assignedTechIds.length" class="small"
                @click="showTechnicians = !showTechnicians"
              >{{ showTechnicians ? 'Hide' : 'Show' }}</button>
            </div>
            <TechnicianPicker
              v-if="showTechnicians"
              :model-value="assignedTechIds"
              @update:model-value="(ids) => patch({ technician_ids: ids })"
            />
          </div>

          <div class="field-row">
            <div>
              <div class="row" style="margin-bottom: 4px">
                <label style="margin: 0">Customer</label>
                <div class="spacer" />
                <button class="small" @click="toggleEditCustomer">
                  {{ editingCustomer ? 'Cancel' : 'Change' }}
                </button>
              </div>
              <div v-if="editingCustomer">
                <CustomerSearchSelect
                  v-model="customerEditValue"
                  placeholder="Search customers (leave blank for internal / fleet)…"
                />
                <button class="small primary" style="margin-top: 6px" @click="saveCustomer">
                  Save
                </button>
              </div>
              <template v-else>
                <div v-if="ticket.customer_id" ref="customerMenuEl" class="customer-contact-field">
                  <button
                    type="button" class="customer-contact-toggle"
                    @click="customerMenuOpen = !customerMenuOpen"
                  >
                    <span>{{ ticket.customer_name }}</span>
                    <span class="customer-contact-caret">▾</span>
                  </button>
                  <div v-if="customerMenuOpen" class="customer-contact-menu">
                    <div v-if="ticket.customer_email"><span class="muted small">Email</span><br />{{ ticket.customer_email }}</div>
                    <div v-if="ticket.customer_phone"><span class="muted small">Phone</span><br />{{ ticket.customer_phone }}</div>
                    <div v-if="ticket.customer_address"><span class="muted small">Address</span><br />{{ ticket.customer_address }}</div>
                    <p
                      v-if="!ticket.customer_email && !ticket.customer_phone && !ticket.customer_address"
                      class="muted small"
                    >
                      No contact info on file.
                    </p>
                    <RouterLink
                      :to="`/customers?id=${ticket.customer_id}`" class="small"
                      style="margin-top: 4px" @click="closeCustomerMenu"
                    >
                      View full profile →
                    </RouterLink>
                  </div>
                </div>
                <p v-else style="margin: 0">
                  <span class="muted">
                    {{ ticket.instrument_is_fleet ? 'CEPCo fleet (internal)' : '—' }}
                  </span>
                </p>
              </template>
            </div>
            <div>
              <div class="row" style="margin-bottom: 4px">
                <label style="margin: 0">Instrument</label>
                <div class="spacer" />
                <button class="small" @click="toggleEditInstrument">
                  {{ editingInstrument ? 'Cancel' : 'Change' }}
                </button>
              </div>
              <div v-if="editingInstrument">
                <select
                  :value="ticket.instrument_id || ''"
                  :disabled="loadingInstrumentOptions || addingInstrument"
                  @change="onInstrumentChange"
                >
                  <option value="">— none —</option>
                  <option v-for="i in instrumentOptions" :key="i.id" :value="i.id">
                    {{ i.family }} · <template v-if="i.nickname">"{{ i.nickname }}" </template>{{ i.model }}
                  </option>
                </select>
                <p v-if="!ticket.customer_id" class="muted small" style="margin: 4px 0 0">
                  Showing CEPCo fleet instruments — this ticket has no customer.
                </p>

                <div v-if="ticket.customer_id" style="margin-top: 8px">
                  <button v-if="!addingInstrument" type="button" class="link small" @click="startAddInstrument">
                    + Add a new instrument for {{ ticket.customer_name }}
                  </button>
                  <div v-else class="card tight" style="margin-top: 6px">
                    <div class="field-row">
                      <div class="field">
                        <label>Family</label>
                        <select v-model="newInstrumentDraft.family">
                          <option v-for="f in refData.families" :key="f" :value="f">
                            {{ refData.familyLabel(f) }}
                          </option>
                        </select>
                      </div>
                      <div class="field">
                        <label>Model</label>
                        <InstrumentModelPicker
                          :family="newInstrumentDraft.family" v-model="newInstrumentDraft.model"
                        />
                      </div>
                    </div>
                    <div class="field-row">
                      <div class="field">
                        <label>Year</label>
                        <input v-model="newInstrumentDraft.year" placeholder="1972" />
                      </div>
                      <div class="field">
                        <label>Serial</label>
                        <input v-model="newInstrumentDraft.serial_no" />
                      </div>
                      <div class="field">
                        <label>Nickname</label>
                        <input v-model="newInstrumentDraft.nickname" placeholder="e.g. Old Betsy" />
                      </div>
                    </div>
                    <div class="row">
                      <button
                        class="small primary" :disabled="creatingInstrument"
                        @click="createAndAttachInstrument"
                      >
                        {{ creatingInstrument ? 'Adding…' : 'Add & attach' }}
                      </button>
                      <button class="small" :disabled="creatingInstrument" @click="addingInstrument = false">
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
                <p v-else class="muted small" style="margin: 8px 0 0">
                  Set a customer above before adding a new instrument for them.
                </p>
              </div>
              <p v-else style="margin: 0">
                <span v-if="ticket.instrument_family">
                  {{ ticket.instrument_family }} · {{ ticket.instrument_model }}
                </span>
                <span v-else class="muted">—</span>
              </p>
            </div>
            <div>
              <label>Shop contact</label>
              <p style="margin: 0">
                {{ ticket.shop_contact_name || ticket.shop_contact_raw || '—' }}
              </p>
            </div>
          </div>

          <div
            v-if="ticket.vendor_tracks && Object.keys(ticket.vendor_tracks).length"
            class="field"
          >
            <label>Vendor work</label>
            <div class="row">
              <span v-for="(v, k) in ticket.vendor_tracks" :key="k" class="tag">
                {{ k }}: {{ v }}
              </span>
            </div>
          </div>

          <div class="field">
            <label>Notes &amp; parts</label>
            <textarea v-model="notesDraft" />
            <button class="small" :disabled="savingNotes" @click="saveNotes">
              {{ savingNotes ? 'Saving…' : 'Save notes' }}
            </button>
          </div>

          <div v-if="settings.statusNotesAllowed(ticket.category_key)" class="field">
            <label>Status notes</label>
            <div class="field-row">
              <div class="field">
                <label class="small muted">Service done</label>
                <textarea v-model="serviceDoneDraft" style="min-height: 80px" />
              </div>
              <div class="field">
                <label class="small muted">Service needed</label>
                <textarea v-model="serviceNeededDraft" style="min-height: 80px" />
              </div>
            </div>
            <button class="small" :disabled="savingStatusNotes" @click="saveStatusNotes">
              {{ savingStatusNotes ? 'Saving…' : 'Save status notes' }}
            </button>
          </div>
        </div>

        <TicketPhotos v-if="isMobile" :ticket-id="ticket.id" />

        <TicketSubTickets ref="subTicketsRef" :ticket="ticket" @changed="load(true)" />
        <TicketTasks ref="ticketTasksRef" :ticket="ticket" />

        <TicketPurchase v-if="ticket.purchase_id" :ticket="ticket" @changed="load(true)" />
        <TicketEstimate v-if="!isShipping" ref="estimateRef" :ticket="ticket" @changed="load(true)" />
        <!-- TicketHours.vue (ticket-level manual hours entry) is hidden for now —
             hours are captured per-task instead, right where a task is marked done
             (see TicketTasks.vue's inline hours field, and routes/tasks.js's PATCH
             /:id, migration 055). -->
      </div>

      <!-- --------------------------------------- right: photos, QC, log -->
      <div class="stack">
        <!-- Shipping tickets lead with the checklist they're actually here
             to work through, then photos — TicketQc never renders for a
             shipping ticket anyway (below), so these two never actually
             compete for the same ticket. Every other ticket leads with
             photos, then QC. -->
        <TicketShipment v-if="ticket.shipments?.length" :ticket="ticket" @changed="load(true)" />
        <TicketPhotos v-if="!isMobile" :ticket-id="ticket.id" />
        <TicketQc
          v-if="!isShipping && settings.qcAllowed(ticket.category_key)" :ticket="ticket"
          @changed="load(true)" @task-created="ticketTasksRef?.load(true)"
        />

        <!-- Generating one navigates straight to it (see generateUpdate),
             so this card only has anything to show once one already
             exists — the "Generate progress update" action itself lives
             in the page header now. -->
        <div v-if="progressUpdate" class="card">
          <div class="row" style="margin-bottom: 12px">
            <h2 style="margin: 0">Customer progress update</h2>
          </div>
          <div class="row">
            <span :class="['pill', progressUpdate.status === 'sent' ? 'green' : 'slate']">
              {{ progressUpdate.status === 'sent' ? 'Sent' : 'Draft' }}
            </span>
            <span v-if="progressUpdate.sent_at" class="muted small">
              Sent {{ new Date(progressUpdate.sent_at).toLocaleString() }}
            </span>
            <span v-if="progressUpdate.viewed_at" class="muted small">
              · Viewed {{ new Date(progressUpdate.viewed_at).toLocaleString() }}
            </span>
            <div class="spacer" />
            <RouterLink class="btn small" :to="{ name: 'progress-update', params: { id: progressUpdate.id } }">
              View update →
            </RouterLink>
          </div>
        </div>

        <!-- "Create invoice record" lives in the page header now; a ticket
             that isn't invoiced yet has nothing else this card would show
             (the old "QC must pass first" hint was informational only —
             invoices.js already rejects the attempt with that exact
             reason, which surfaces through the page's own error banner
             above), so this only renders once an invoice actually exists. -->
        <div v-if="!isShipping && ticket.invoices.length" class="card">
          <div class="row" style="margin-bottom: 12px">
            <h2 style="margin: 0">Invoicing</h2>
          </div>
          <ul class="timeline">
            <li v-for="inv in ticket.invoices" :key="inv.id">
              <strong>{{ inv.status }}</strong>
              <span v-if="inv.amount"> · ${{ inv.amount }}</span>
              <div class="muted small">
                {{ inv.xero_invoice_id ? `Xero ${inv.xero_invoice_id}` : 'Not yet linked to Xero' }}
              </div>
            </li>
          </ul>
        </div>

        <div class="card">
          <h2>Status history</h2>
          <ul class="timeline">
            <li v-for="h in ticket.status_history" :key="h.id">
              <strong>{{ h.new_label || h.new_status }}</strong>
              <span v-if="h.old_status" class="muted"> ← {{ h.old_label || h.old_status }}</span>
              <div class="muted small">
                {{ h.changed_by_name || 'System' }} · {{ when(h.changed_at) }}
              </div>
              <div v-if="h.note" class="small">{{ h.note }}</div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
