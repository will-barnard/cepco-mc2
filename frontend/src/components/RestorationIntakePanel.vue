<script setup>
/**
 * Homepage: restoration sales from Shopify waiting on a reviewer
 * (migration 100, services/restorationIntake.js). Renders nothing for
 * anyone who isn't a reviewer, or when there's nothing to do.
 *
 * For each sale: who bought it (from the order), which inventory piece was
 * sold (mc2's suggestion, other candidates, or a search), which queue the
 * restoration goes in, and the full price. "Record sale & open ticket"
 * does it all in one go. If the piece already has an open ticket (someone
 * started restoring it on spec), that ticket can be used instead: the
 * buyer goes on it and it keeps its place in the queue.
 *
 * A sale that was set up and whose order was cancelled afterwards comes
 * back here too: undo the sale, or keep it.
 */
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings } from '../stores';
import CustomerSearchSelect from './CustomerSearchSelect.vue';
import { formatPrice } from '../inventory';

const settings = useSettings();

const loaded = ref(false);
const items = ref([]);
const choices = ref([]);
const defaultChoice = ref(null);
const error = ref('');
const notice = ref('');

// Per-item form state, keyed by intake id.
const forms = reactive({});
const busy = reactive({});

const priorities = computed(() => settings.active('priority_tier'));
const defaultPriority = computed(() => (priorities.value.find((p) => p.key === 'standard_priority') || priorities.value[0] || {}).key || '');

function instrumentLabel(i) {
  if (!i) return '';
  const name = i.nickname ? `“${i.nickname}”` : null;
  return [name, i.year, i.family, i.model].filter(Boolean).join(' ') || `Instrument #${i.id}`;
}

function initForm(it) {
  const pick = it.suggestion ? it.suggestion.instrument : null;
  forms[it.id] = {
    instrument: pick,
    search: '',
    results: [],
    category_choice: defaultChoice.value,
    priority_key: defaultPriority.value,
    ticket_mode: 'new',
    reuse_ticket_id: null,
    sold_price: it.item.full_price ?? (pick && pick.asking_price !== null ? Number(pick.asking_price) : ''),
    customer_id: it.customer ? it.customer.id : '',
    title: '',
    showDismiss: false,
    dismiss_note: '',
  };
  refreshTicketMode(it);
  preview(it);
}

async function load() {
  try {
    const data = await api.get('/restoration-intake');
    items.value = data.items || [];
    choices.value = data.category_choices || [];
    defaultChoice.value = data.default_category_choice || (choices.value[0] && choices.value[0].key);
    for (const it of items.value) if (it.needs === 'setup' && !forms[it.id]) initForm(it);
  } catch (err) {
    error.value = err.message;
  } finally {
    loaded.value = true;
  }
}

function candidatesFor(it) {
  const f = forms[it.id];
  const seen = new Set();
  const out = [];
  const add = (i, reason) => {
    if (!i || seen.has(i.id)) return;
    seen.add(i.id);
    out.push({ ...i, reason });
  };
  if (it.suggestion) add(it.suggestion.instrument, it.suggestion.reason);
  for (const c of it.candidates || []) add(c, null);
  for (const r of (f && f.results) || []) add(r, null);
  if (f && f.instrument) add(f.instrument, null);
  return out;
}

// Its stock restoration tickets (nobody on them yet) -- a new ticket
// replaces them.
const stockTicketsOf = (inst) => ((inst && inst.open_tickets) || [])
  .filter((t) => t.category_key === 'repairs_restoration' && !t.customer_id
    && !/^(Inventory|Fleet) QC —/i.test(t.title || ''));
const forSaleIds = (inst) => stockTicketsOf(inst).map((t) => t.id);

function refreshTicketMode(it) {
  const f = forms[it.id];
  // Default to the piece's on-spec restoration ticket when there is one --
  // a second ticket for the same job is the thing to avoid.
  const stock = forSaleIds(f.instrument);
  if (stock.length) {
    f.ticket_mode = 'reuse';
    f.reuse_ticket_id = stock[0];
  } else {
    f.ticket_mode = 'new';
    f.reuse_ticket_id = null;
  }
}

function pickInstrument(it, inst) {
  const f = forms[it.id];
  f.instrument = inst;
  if (it.item.full_price === null && inst && inst.asking_price !== null && inst.asking_price !== undefined) {
    f.sold_price = Number(inst.asking_price);
  }
  refreshTicketMode(it);
  preview(it);
}

let searchTimer = null;
function search(it) {
  clearTimeout(searchTimer);
  const f = forms[it.id];
  searchTimer = setTimeout(async () => {
    if (!f.search.trim()) { f.results = []; return; }
    try {
      f.results = await api.get('/restoration-intake/instruments', { q: f.search.trim() });
    } catch (err) {
      error.value = err.message;
    }
  }, 250);
}

async function preview(it) {
  const f = forms[it.id];
  if (!f || f.ticket_mode !== 'new' || !f.category_choice) { if (f) f.title = ''; return; }
  try {
    const { title } = await api.post(`/restoration-intake/${it.id}/preview`, {
      category_choice: f.category_choice,
      priority_key: f.priority_key,
      instrument_id: f.instrument ? f.instrument.id : null,
      customer_id: f.customer_id || null,
    });
    f.title = title;
  } catch (err) {
    f.title = '';
  }
}

const canConfirm = (it) => {
  const f = forms[it.id];
  if (!f || !f.instrument) return false;
  if (!it.customer && !f.customer_id) return false;
  if (!f.category_choice) return false;
  if (f.ticket_mode === 'reuse' && !f.reuse_ticket_id) return false;
  const needsPrice = f.instrument.ownership !== 'customer';
  return !needsPrice || (f.sold_price !== '' && f.sold_price !== null);
};

async function confirmItem(it) {
  const f = forms[it.id];
  error.value = '';
  notice.value = '';
  busy[it.id] = true;
  try {
    const result = await api.post(`/restoration-intake/${it.id}/confirm`, {
      instrument_id: f.instrument.id,
      category_choice: f.category_choice,
      priority_key: f.priority_key,
      ticket_mode: f.ticket_mode,
      reuse_ticket_id: f.reuse_ticket_id,
      sold_price: f.sold_price,
      customer_id: f.customer_id || null,
    });
    notice.value = `${it.order.name || 'Order'}: ${result.sale_recorded ? 'sale recorded, ' : ''}ticket #${result.ticket_id} ready.`;
    lastTicketId.value = result.ticket_id;
    items.value = items.value.filter((x) => x.id !== it.id);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy[it.id] = false;
  }
}
const lastTicketId = ref(null);

async function dismissItem(it) {
  error.value = '';
  busy[it.id] = true;
  try {
    await api.post(`/restoration-intake/${it.id}/dismiss`, { note: forms[it.id].dismiss_note || null });
    items.value = items.value.filter((x) => x.id !== it.id);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy[it.id] = false;
  }
}

async function decideCancellation(it, outcome) {
  const msg = outcome === 'undo_sale'
    ? `Undo the sale of ${it.instrument_label || 'this instrument'}? It goes back to shop stock.`
    : 'Keep the sale and reopen the ticket?';
  if (!window.confirm(msg)) return;
  error.value = '';
  busy[it.id] = true;
  try {
    await api.post(`/restoration-intake/${it.id}/cancellation`, { outcome });
    items.value = items.value.filter((x) => x.id !== it.id);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy[it.id] = false;
  }
}

const balance = (it) => {
  const f = forms[it.id];
  const full = Number(f && f.sold_price);
  if (!f || f.sold_price === '' || !Number.isFinite(full) || it.item.deposit === null) return null;
  return Math.max(full - it.item.deposit, 0);
};

watch(() => settings.data.priority_tier, () => {
  for (const it of items.value) {
    if (forms[it.id] && !forms[it.id].priority_key) forms[it.id].priority_key = defaultPriority.value;
  }
});

onMounted(async () => {
  await settings.load();
  await load();
});
</script>

<template>
  <div v-if="loaded && (items.length || notice)" class="card resto-panel">
    <h2>Restoration sales to set up</h2>
    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 12px">
      {{ notice }}
      <RouterLink v-if="lastTicketId" :to="{ name: 'ticket', params: { id: lastTicketId } }">Open the ticket →</RouterLink>
    </div>

    <div v-for="it in items" :key="it.id" class="resto-item">
      <div class="row" style="align-items: baseline">
        <strong>{{ it.item.title }}</strong>
        <span class="spacer" />
        <span class="muted small">
          Order
          <a v-if="it.order.admin_url" :href="it.order.admin_url" target="_blank" rel="noopener">{{ it.order.name || it.order.shopify_order_id }} ↗</a>
          <template v-else>{{ it.order.name || it.order.shopify_order_id }}</template>
          · {{ it.order.date }}
        </span>
      </div>

      <!-- ------------------------------------------ cancelled after setup -->
      <template v-if="it.needs === 'cancel_review'">
        <p class="small" style="margin: 6px 0">
          <span class="pill red">Order cancelled</span>
          This was set up<span v-if="it.resolved_by_name"> by {{ it.resolved_by_name }}</span>:
          <RouterLink v-if="it.instrument_id" :to="{ name: 'instrument', params: { id: it.instrument_id } }">{{ it.instrument_label }}</RouterLink>
          <template v-if="it.sale_recorded"> is recorded as sold to {{ it.customer ? it.customer.name : 'the buyer' }}</template>,
          ticket
          <RouterLink v-if="it.ticket_id" :to="{ name: 'ticket', params: { id: it.ticket_id } }">#{{ it.ticket_id }}</RouterLink>
          <template v-if="it.reused_ticket"> (the shop's own, kept open — undoing the sale makes it stock again)</template><template v-else> (archived)</template>.
        </p>
        <div class="row">
          <button class="small danger" :disabled="busy[it.id]" @click="decideCancellation(it, 'undo_sale')">
            Undo the sale
          </button>
          <button class="small" :disabled="busy[it.id]" @click="decideCancellation(it, 'keep')">Keep the sale</button>
        </div>
      </template>

      <!-- ------------------------------------------------------- set up -->
      <template v-else-if="forms[it.id]">
        <div class="grid cols-2" style="margin-top: 8px">
          <div>
            <div class="resto-label">Buyer</div>
            <template v-if="it.customer">
              <RouterLink :to="{ name: 'customers', query: { id: it.customer.id } }">{{ it.customer.name }}</RouterLink>
              <div class="muted small">
                <span v-if="it.customer.email">{{ it.customer.email }}</span>
                <span v-if="it.customer.phone"> · {{ it.customer.phone }}</span>
              </div>
              <div v-if="it.customer.address" class="muted small">{{ it.customer.address }}</div>
            </template>
            <template v-else>
              <p class="muted small" style="margin: 0 0 4px">No customer on this order — pick who bought it.</p>
              <CustomerSearchSelect v-model="forms[it.id].customer_id" placeholder="Find the buyer…" @change="preview(it)" />
            </template>
            <div v-if="it.order.note" class="small" style="margin-top: 4px">Note: {{ it.order.note }}</div>
          </div>
          <div>
            <div class="resto-label">Paid</div>
            <div>{{ it.item.deposit_label || '—' }} deposit</div>
            <div class="field" style="margin: 6px 0 0">
              <label class="small">Full price (recorded as the sale price)</label>
              <input v-model="forms[it.id].sold_price" inputmode="decimal" placeholder="7750" style="max-width: 160px" />
              <div v-if="balance(it) !== null" class="muted small">Balance due {{ formatPrice(balance(it)) }}</div>
              <div v-if="it.item.full_price === null" class="muted small">The listing has no full value — check the price.</div>
            </div>
          </div>
        </div>

        <div class="resto-label" style="margin-top: 12px">Which instrument was sold?</div>
        <div class="resto-options">
          <label v-for="c in candidatesFor(it)" :key="c.id" class="checkbox resto-option">
            <input
              type="radio" :name="`resto-inst-${it.id}`" :checked="forms[it.id].instrument && forms[it.id].instrument.id === c.id"
              @change="pickInstrument(it, c)"
            />
            <span>
              <RouterLink :to="{ name: 'instrument', params: { id: c.id } }" target="_blank">{{ instrumentLabel(c) }}</RouterLink>
              <span v-if="c.serial_no" class="muted small"> · s/n {{ c.serial_no }}</span>
              <span v-if="c.asking_price !== null && c.asking_price !== undefined" class="muted small"> · {{ formatPrice(c.asking_price) }}</span>
              <span v-if="c.reason" class="pill green" style="margin-left: 6px">{{ c.reason }}</span>
              <span v-if="c.ownership === 'customer'" class="pill amber" style="margin-left: 6px">already sold</span>
            </span>
          </label>
          <p v-if="!candidatesFor(it).length" class="muted small" style="margin: 0">
            No match in inventory. Search below, or add the piece to inventory first.
          </p>
        </div>
        <input
          v-model="forms[it.id].search" placeholder="Search inventory by name, model, serial…"
          style="max-width: 360px; margin-top: 6px" @input="search(it)"
        />

        <template v-if="forms[it.id].instrument">
          <div class="resto-label" style="margin-top: 12px">Ticket</div>
          <template v-if="stockTicketsOf(forms[it.id].instrument).length">
            <label
              v-for="t in stockTicketsOf(forms[it.id].instrument)" :key="t.id" class="checkbox resto-option"
            >
              <input
                type="radio" :name="`resto-ticket-${it.id}`"
                :checked="forms[it.id].ticket_mode === 'reuse' && forms[it.id].reuse_ticket_id === t.id"
                @change="forms[it.id].ticket_mode = 'reuse'; forms[it.id].reuse_ticket_id = t.id"
              />
              <span>
                Use its open ticket
                <RouterLink :to="{ name: 'ticket', params: { id: t.id } }" target="_blank">#{{ t.id }} {{ t.title }}</RouterLink>
                <span class="muted small"> · {{ t.category_label }} · {{ t.status_label }} — its work and history carry over</span>
              </span>
            </label>
            <label class="checkbox resto-option">
              <input
                type="radio" :name="`resto-ticket-${it.id}`" :checked="forms[it.id].ticket_mode === 'new'"
                @change="forms[it.id].ticket_mode = 'new'; forms[it.id].reuse_ticket_id = null; preview(it)"
              />
              <span>
                Open a new ticket
                <span v-if="forSaleIds(forms[it.id].instrument).length" class="muted small">
                  (archives #{{ forSaleIds(forms[it.id].instrument).join(', #') }} — replaced)
                </span>
              </span>
            </label>
          </template>

          <div class="row" style="flex-wrap: wrap; margin-top: 6px">
            <span class="muted small">Type:</span>
            <button
              v-for="c in choices" :key="c.key" type="button" class="small"
              :class="{ primary: forms[it.id].category_choice === c.key }"
              @click="forms[it.id].category_choice = c.key; preview(it)"
            >
              {{ c.label }}
            </button>
            <select
              v-if="forms[it.id].ticket_mode === 'new'" v-model="forms[it.id].priority_key"
              style="max-width: 200px" @change="preview(it)"
            >
              <option v-for="p in priorities" :key="p.key" :value="p.key">{{ p.label }}</option>
            </select>
          </div>
          <div v-if="forms[it.id].ticket_mode === 'new' && forms[it.id].title" class="muted small" style="margin-top: 6px">
            New ticket: <strong style="color: var(--text)">{{ forms[it.id].title }}</strong> — at the back of the queue
          </div>
          <div v-else-if="forms[it.id].ticket_mode === 'reuse'" class="muted small" style="margin-top: 6px">
            Ticket #{{ forms[it.id].reuse_ticket_id }} becomes {{ it.customer ? it.customer.name : 'the buyer' }}'s restoration and keeps its place in line.
          </div>
        </template>

        <div class="row" style="margin-top: 12px">
          <button class="primary" :disabled="busy[it.id] || !canConfirm(it)" @click="confirmItem(it)">
            {{ busy[it.id] ? 'Saving…' : (forms[it.id].instrument && forms[it.id].instrument.ownership === 'customer'
              ? 'Open ticket' : 'Record sale & open ticket') }}
          </button>
          <button v-if="!forms[it.id].showDismiss" class="small" @click="forms[it.id].showDismiss = true">Nothing to set up…</button>
          <template v-else>
            <input v-model="forms[it.id].dismiss_note" placeholder="Why? (test order, done by hand…)" style="max-width: 260px" />
            <button class="small danger" :disabled="busy[it.id]" @click="dismissItem(it)">Dismiss</button>
            <button class="small" @click="forms[it.id].showDismiss = false">Cancel</button>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.resto-panel { margin-bottom: 24px; border-color: var(--amber); }
.resto-item { padding: 12px 0; border-top: 1px solid var(--border); }
.resto-item:first-of-type { border-top: none; padding-top: 0; }
.resto-label {
  font-size: 12px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase;
  color: var(--muted); margin-bottom: 4px;
}
.resto-options { display: flex; flex-direction: column; gap: 4px; }
.resto-option { align-items: flex-start; }
.resto-option input { margin-top: 2px; }
</style>
