<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
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
import TicketVendorOrders from '../components/TicketVendorOrders.vue';
import TicketVendorWork from '../components/TicketVendorWork.vue';
import TicketServiceLog from '../components/TicketServiceLog.vue';
import { xeroContactUrl } from '../xeroLinks';
import TicketTasks from '../components/TicketTasks.vue';
import TicketLinks from '../components/TicketLinks.vue';
import TicketNotes from '../components/TicketNotes.vue';
import DraftNotice from '../components/DraftNotice.vue';
import { useDraft } from '../drafts';
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
// Same "page header button opens the card's own form" wiring as the two
// above -- TicketVendorOrders.vue's card only renders once it has an order,
// an open form, or an error, so this is what puts something in it for a
// ticket that didn't get a Vendor Orders order at creation time.
const vendorOrdersRef = ref(null);
// Same idea for Vendor work (migration 064) — "+ Vendor work" up top.
const vendorWorkRef = ref(null);
// "Xero contact" button by the customer's name — resolved async since the
// link may need the org's short code (xeroLinks.js).
const xeroUrl = ref(null);
const loading = ref(true);
const error = ref('');
const statusNote = ref('');
// "Service needed" (Settings -> Ticket categories -> "Service log & notes"
// toggle) — free text for what's still outstanding on the job, distinct
// from the status-CHANGE note above. Its old sibling "Service done" became
// the Service Log (TicketServiceLog.vue, migration 064); anything typed in
// it before is shown read-only there.
const serviceNeededDraft = ref('');
const savingStatusNotes = ref(false);

// Unsaved-text autosave (drafts.js, kiosk feedback Oct 2026). The status
// note starts blank, so it drafts from the get-go. "Service needed" edits a
// server value, so it only starts once load() has put that value in place,
// and only restores if nobody has saved a different value since.
const statusNoteDraft = useDraft(() => `ticket-status-note:${props.id}`, statusNote);
const serviceNeededDraftStore = useDraft(() => `ticket-service-needed:${props.id}`, serviceNeededDraft, {
  manual: true, requireSameBase: true,
});
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

// "(312) 555-0142 ext 3" -> "tel:3125550142" -- keep digits and a leading +
// so tapping the number on an iPad/phone dials it.
function telHref(phone) {
  const digits = String(phone || '').replace(/(?!^\+)[^\d]/g, '');
  return `tel:${digits}`;
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
// on NewTicketForm.vue -- or to the fleet when there's no customer, since
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
// one, now their instrument needs to exist too." Mirrors NewTicketForm.vue's
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
// Rename popover (top-row "Rename" button). For legacy tickets whose title
// predates the current naming scheme: type a new title by hand, or let the
// ticket's category naming template (Settings -> Ticket naming) rebuild it
// from the current customer/instrument. Both go through POST
// /tickets/:id/rename, which -- unlike PATCH -- never second-guesses a
// hand-typed title on a Standardize category.
const renameOpen = ref(false);
const renameEl = ref(null);
const renameInputEl = ref(null);
const renameDraft = ref('');
const renameSuggestion = ref(null); // null = still loading; '' = nothing to build from
const renameBusy = ref(false);
const renameError = ref('');

async function toggleRename() {
  if (renameOpen.value) { renameOpen.value = false; return; }
  renameDraft.value = ticket.value.title || '';
  renameSuggestion.value = null;
  renameError.value = '';
  renameOpen.value = true;
  nextTick(() => renameInputEl.value?.focus());
  try {
    const r = await api.get(`/tickets/${ticket.value.id}/suggested-title`);
    renameSuggestion.value = r.title || '';
  } catch (err) {
    renameSuggestion.value = '';
    renameError.value = err.message;
  }
}

async function submitRename(payload) {
  renameBusy.value = true;
  renameError.value = '';
  try {
    const r = await api.post(`/tickets/${ticket.value.id}/rename`, payload);
    ticket.value.title = r.title;
    renameOpen.value = false;
  } catch (err) {
    renameError.value = err.message;
  } finally {
    renameBusy.value = false;
  }
}
const renameManual = () => submitRename({ title: renameDraft.value });
const renameAuto = () => submitRename({ auto: true });

function onDocumentClick(event) {
  if (customerMenuOpen.value && customerMenuEl.value && !customerMenuEl.value.contains(event.target)) {
    closeCustomerMenu();
  }
  if (renameOpen.value && renameEl.value && !renameEl.value.contains(event.target)) {
    renameOpen.value = false;
  }
}
function onDocumentKeydown(event) {
  if (event.key === 'Escape') {
    closeCustomerMenu();
    renameOpen.value = false;
  }
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
    // shouldn't clobber text someone is still mid-typing in the status
    // notes with whatever the server happened to have at that moment.
    if (!silent) {
      serviceNeededDraft.value = ticket.value.service_needed_notes || '';
      serviceNeededDraftStore.start();
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
watch(() => ticket.value?.customer_xero_contact_id, async (contactId) => {
  xeroUrl.value = contactId ? await xeroContactUrl(contactId) : null;
}, { immediate: true });

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
  statusNoteDraft.clear();
}

// Blank clears it; anything else has to be a whole number 1-100 (the
// backend checks the same). A bad value snaps the box back to what's saved
// rather than leaving an unsaved number sitting there looking saved.
async function saveProgress(event) {
  const raw = String(event.target.value).trim();
  if (raw === '') {
    if (ticket.value.progress_percent != null) await patch({ progress_percent: null });
    return;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    error.value = 'Progress must be a whole number from 1 to 100, or blank.';
    event.target.value = ticket.value.progress_percent ?? '';
    return;
  }
  if (n !== ticket.value.progress_percent) await patch({ progress_percent: n });
}

async function saveStatusNotes() {
  savingStatusNotes.value = true;
  await patch({
    service_needed_notes: serviceNeededDraft.value,
  });
  // patch() reports failures through error.value rather than throwing --
  // keep the draft unless the save actually landed.
  if (!error.value) serviceNeededDraftStore.clear();
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

async function unarchive() {
  await patch({ archived: false });
}

// Permanent delete of an archived ticket (errors / duplicates only). The
// confirm spells out what goes with it; the API refuses if it has a
// sent/paid/Xero invoice.
async function deleteTicket() {
  const t = ticket.value;
  const gone = [
    [t.hours_log, 'hours entr', 'y', 'ies'],
    [t.estimates, 'estimate', '', 's'],
    [t.attachments, 'attachment', '', 's'],
    [t.invoices, 'invoice record', '', 's'],
  ].filter(([list]) => list?.length)
    .map(([list, word, one, many]) => `${list.length} ${word}${list.length === 1 ? one : many}`);
  const kids = t.child_tickets?.length || 0;
  const msg = `Permanently delete #${t.id} "${t.title}"? This can't be undone.`
    + (gone.length ? `\n\nIt will also delete: ${gone.join(', ')}, plus its notes, tasks and history.` : '')
    + (kids ? `\n\n${kids} sub-ticket${kids === 1 ? '' : 's'} will stay but lose the link to this one.` : '')
    + '\n\nNotes already pushed to Xero stay in Xero.';
  if (!confirm(msg)) return;
  error.value = '';
  try {
    await api.del(`/tickets/${t.id}`);
    router.push({ name: 'queue' });
  } catch (err) {
    error.value = err.message;
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
        <span v-if="ticket.archived" class="pill slate">Archived</span>

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
        <button class="small" @click="vendorOrdersRef?.openForm()">+ Vendor Orders</button>
        <button class="small" @click="vendorWorkRef?.openForm()">+ Vendor work</button>
        <button
          v-if="showProgressUpdate && !progressUpdate" class="small"
          :disabled="generatingUpdate" @click="generateUpdate"
        >{{ generatingUpdate ? 'Generating…' : 'Generate progress update' }}</button>
        <button
          v-if="!isShipping && auth.isSenior && !ticket.invoices.length" class="small"
          @click="createInvoice"
        >Create invoice record</button>

        <!-- Rename: manual title, or rebuild it from the naming conventions. -->
        <div ref="renameEl" class="rename-wrap">
          <button
            class="small" type="button" aria-haspopup="true"
            :aria-expanded="renameOpen" @click="toggleRename"
          >Rename</button>
          <div v-if="renameOpen" class="rename-menu" role="dialog" aria-label="Rename ticket">
            <form class="rename-section" @submit.prevent="renameManual">
              <label for="rename-title">Rename manually</label>
              <input
                id="rename-title" ref="renameInputEl" v-model="renameDraft"
                maxlength="300" autocomplete="off"
              />
              <button
                class="primary small" type="submit"
                :disabled="renameBusy || !renameDraft.trim() || renameDraft.trim() === ticket.title"
              >Save name</button>
            </form>
            <div class="rename-section rename-auto">
              <label>Or use the naming conventions</label>
              <div v-if="renameSuggestion === null" class="muted small">Working out the name…</div>
              <template v-else-if="renameSuggestion">
                <div class="rename-suggestion">{{ renameSuggestion }}</div>
                <button
                  class="small" type="button"
                  :disabled="renameBusy || renameSuggestion === ticket.title" @click="renameAuto"
                >{{ renameSuggestion === ticket.title ? 'Already named this way' : 'Rename automatically' }}</button>
              </template>
              <div v-else class="muted small">
                Nothing to build a name from — add a customer or instrument first.
              </div>
            </div>
            <div v-if="renameError" class="alert">{{ renameError }}</div>
          </div>
        </div>

        <span class="row" style="border-left: 1px solid var(--border); padding-left: 10px; margin-left: 2px">
          <button v-if="auth.isAdmin && !ticket.archived" class="small" @click="archive">Archive</button>
          <button v-if="auth.isAdmin && ticket.archived" class="small" @click="unarchive">Unarchive</button>
          <button v-if="auth.isAdmin && ticket.archived" class="small danger" @click="deleteTicket">
            Delete…
          </button>
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
              <!-- Fast Track (migration 063) sits beside priority rather
                   than being a tier of it: a quick job can be Fast Track
                   at any priority. The Queue page filters on it. -->
              <div class="row" style="flex-wrap: nowrap">
                <select
                  :value="ticket.priority_key" style="flex: 1; min-width: 0"
                  @change="patch({ priority_key: $event.target.value })"
                >
                  <option v-for="p in settings.active('priority_tier')" :key="p.key" :value="p.key">
                    {{ p.label }}
                  </option>
                </select>
                <label class="checkbox nowrap" style="margin: 0">
                  <input
                    type="checkbox" :checked="!!ticket.fast_track"
                    @change="patch({ fast_track: $event.target.checked })"
                  />
                  <span>Fast Track</span>
                </label>
              </div>
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

          <!-- Progress bar (migration 066): optional 1-100, a judgement call
               typed in by hand. When set, this ticket's row on the Queue
               fills green to that width. Blank = no bar. -->
          <div class="field">
            <label>Progress (optional)</label>
            <div class="row progress-edit">
              <input
                type="number" min="1" max="100" step="1" inputmode="numeric" placeholder="—"
                :value="ticket.progress_percent ?? ''" style="width: 90px"
                @change="saveProgress($event)"
              />
              <span class="muted">%</span>
              <div v-if="ticket.progress_percent" class="progress-preview" :title="`${ticket.progress_percent}%`">
                <div class="progress-preview-fill" :style="{ width: `${ticket.progress_percent}%` }" />
              </div>
              <button v-if="ticket.progress_percent" class="small" type="button" @click="patch({ progress_percent: null })">
                Clear
              </button>
            </div>
          </div>

          <!-- Who / what / where, as one key-value list: label, value, and a
               quiet action on the right, instead of a scatter of fields with
               a boxed "Change" button each. The customer's name is a real
               button (outlined, "Contact info ▾") that opens their email /
               phone / address; the Xero contact and the full profile live in
               that popover rather than as loose buttons under the name. -->
          <div class="detail-rows">
            <div class="detail-row">
              <span class="detail-label">Technicians</span>
              <div class="detail-value">
                <span v-if="ticket.technicians.length">{{ ticket.technicians.map((t) => t.name).join(', ') }}</span>
                <span v-else class="muted">Unassigned</span>
              </div>
              <button
                v-if="assignedTechIds.length" type="button" class="detail-action"
                @click="showTechnicians = !showTechnicians"
              >{{ showTechnicians ? 'Done' : 'Change' }}</button>
              <div v-if="showTechnicians" class="detail-extra">
                <TechnicianPicker
                  :model-value="assignedTechIds"
                  @update:model-value="(ids) => patch({ technician_ids: ids })"
                />
              </div>
            </div>

            <div class="detail-row">
              <span class="detail-label">Customer</span>
              <div class="detail-value">
                <div
                  v-if="ticket.customer_id && !editingCustomer" ref="customerMenuEl"
                  class="customer-contact-field"
                >
                  <button
                    type="button" class="customer-contact-toggle" aria-haspopup="true"
                    :aria-expanded="customerMenuOpen" title="Show this customer's contact info"
                    @click="customerMenuOpen = !customerMenuOpen"
                  >
                    <svg
                      class="customer-contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                    >
                      <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
                    </svg>
                    <span class="customer-contact-name">{{ ticket.customer_name }}</span>
                    <span class="customer-contact-hint">
                      <span class="customer-contact-hint-text">Contact info</span>
                      <span class="customer-contact-caret">▾</span>
                    </span>
                  </button>
                  <div v-if="customerMenuOpen" class="customer-contact-menu">
                    <div class="customer-contact-menu-name">{{ ticket.customer_name }}</div>
                    <div v-if="ticket.customer_email" class="customer-contact-item">
                      <span class="muted small">Email</span>
                      <a :href="`mailto:${ticket.customer_email}`">{{ ticket.customer_email }}</a>
                    </div>
                    <div v-if="ticket.customer_phone" class="customer-contact-item">
                      <span class="muted small">Phone</span>
                      <a :href="telHref(ticket.customer_phone)">{{ ticket.customer_phone }}</a>
                    </div>
                    <div v-if="ticket.customer_address" class="customer-contact-item">
                      <span class="muted small">Address</span>
                      <span>{{ ticket.customer_address }}</span>
                    </div>
                    <p
                      v-if="!ticket.customer_email && !ticket.customer_phone && !ticket.customer_address"
                      class="muted small" style="margin: 0"
                    >
                      No contact info on file.
                    </p>
                    <!-- xeroUrl is only set for a customer linked to a Xero
                         contact (the nightly sync / Customers page link them);
                         see xeroLinks.js. -->
                    <div class="customer-contact-actions">
                      <RouterLink
                        :to="`/customers?id=${ticket.customer_id}`" class="btn small"
                        @click="closeCustomerMenu"
                      >Full profile →</RouterLink>
                      <a
                        v-if="xeroUrl" class="btn small" :href="xeroUrl" target="_blank" rel="noopener"
                        title="Open this customer's contact in Xero"
                      >Open in Xero ↗</a>
                    </div>
                  </div>
                </div>
                <span v-else-if="editingCustomer" class="muted">Choose a customer below</span>
                <span v-else class="muted">
                  {{ ticket.instrument_is_fleet ? 'CEPCo fleet (internal)' : 'None' }}
                </span>
              </div>
              <button type="button" class="detail-action" @click="toggleEditCustomer">
                {{ editingCustomer ? 'Cancel' : 'Change' }}
              </button>
              <div v-if="editingCustomer" class="detail-extra">
                <CustomerSearchSelect
                  v-model="customerEditValue"
                  placeholder="Search customers (leave blank for internal / fleet)…"
                />
                <button class="small primary" style="margin-top: 6px" @click="saveCustomer">
                  Save
                </button>
              </div>
            </div>

            <div class="detail-row">
              <span class="detail-label">Instrument</span>
              <div class="detail-value">
                <span v-if="ticket.instrument_family">
                  {{ refData.familyLabel(ticket.instrument_family) }} · {{ ticket.instrument_model }}
                </span>
                <span v-else class="muted">None</span>
              </div>
              <button type="button" class="detail-action" @click="toggleEditInstrument">
                {{ editingInstrument ? 'Cancel' : 'Change' }}
              </button>
              <div v-if="editingInstrument" class="detail-extra">
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
                        <label>Brand</label>
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
            </div>

            <div class="detail-row">
              <span class="detail-label">Shop contact</span>
              <div class="detail-value">
                <span v-if="ticket.shop_contact_name || ticket.shop_contact_raw">
                  {{ ticket.shop_contact_name || ticket.shop_contact_raw }}
                </span>
                <span v-else class="muted">—</span>
              </div>
            </div>

            <TicketLinks :ticket="ticket" @changed="load(true)" />
          </div>

          <!-- Imported vendor_tracks moved into the Vendor work card
               (TicketVendorWork.vue, migration 064), editable now. -->

          <!-- Published notes (migration 061) — replaced the live-edited
               textarea; also posted to / read from the customer's Xero
               history. -->
          <TicketNotes :ticket="ticket" @changed="load(true)" />

          <div v-if="settings.statusNotesAllowed(ticket.category_key)" class="field">
            <label>Service needed</label>
            <DraftNotice :draft="serviceNeededDraftStore" />
            <textarea v-model="serviceNeededDraft" style="min-height: 80px" />
            <button class="small" style="margin-top: 6px" :disabled="savingStatusNotes" @click="saveStatusNotes">
              {{ savingStatusNotes ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>

        <TicketPhotos v-if="isMobile" :ticket-id="ticket.id" />

        <TicketSubTickets ref="subTicketsRef" :ticket="ticket" @changed="load(true)" />
        <TicketTasks ref="ticketTasksRef" :ticket="ticket" @changed="load(true)" />
        <!-- Service Log (migration 064) — completed tasks land here on their
             own; the reload after an edit also refreshes Tasks, since a
             task's hours live on its log entry. Same per-category toggle
             the old Service done / Service needed boxes used. -->
        <TicketServiceLog
          v-if="!isShipping && settings.statusNotesAllowed(ticket.category_key)" :ticket="ticket"
          @changed="load(true); ticketTasksRef?.load(true)"
        />

        <TicketPurchase v-if="ticket.purchase_id" :ticket="ticket" @changed="load(true)" />
        <TicketEstimate v-if="!isShipping" ref="estimateRef" :ticket="ticket" @changed="load(true)" />
        <TicketVendorOrders ref="vendorOrdersRef" :ticket="ticket" />
        <TicketVendorWork ref="vendorWorkRef" :ticket="ticket" @changed="load(true)" />
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

<style scoped>
/* Progress (migration 066): same green fill the Queue rows use, as a small
   preview beside the number. */
.progress-edit { flex-wrap: nowrap; align-items: center; }
.progress-preview {
  flex: 1; min-width: 60px; max-width: 220px; height: 8px;
  border-radius: 999px; background: var(--surface-2); overflow: hidden;
}
.progress-preview-fill { height: 100%; background: var(--green); border-radius: 999px; }
</style>
