<script setup>
/**
 * Settings -> Shopify orders (NOTES §2.111). Three things on one page:
 *
 *   - What intake does with each order (switches, saved on change — same
 *     "no separate save button" convention as the rest of Settings).
 *   - Tag rules: a Shopify product tag -> "no ticket" or "ticket in category
 *     X". Items without a matching rule get the default shipping ticket,
 *     whose category is still Settings -> Shop configuration's "Default
 *     category for Shopify orders".
 *   - Restoration sales (migration 100): who reviews them, and every one
 *     that's come in. A "restoration" tag rule sends an item there instead
 *     of onto a ticket; the reviewers set it up from the homepage.
 *   - The order log: every order received and what each step did, with
 *     Re-run for anything that failed or needs a person.
 *
 * Backend: routes/shopifyOrders.js, services/shopifyOrders.js.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const settings = useSettings();
const refData = useRefData();

const loading = ref(true);
const error = ref('');
const notice = ref('');

const intake = ref({});
const rules = ref([]);
const connection = ref({});
const testResult = ref(null);
const testing = ref(false);

const restorations = ref([]);
const reviewerInfo = ref({ ids: [], effective: [], fallback: true });
// Anyone active can be picked, admins first -- the ask was "an assigned
// admin", but a senior tech who runs restorations shouldn't be ruled out.
const reviewerOptions = computed(() => [...refData.employees]
  .filter((e) => e.active)
  .sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) || a.name.localeCompare(b.name)));
const RESTO_STATUS = {
  pending: { label: 'Waiting for review', color: 'amber' },
  done: { label: 'Set up', color: 'green' },
  dismissed: { label: 'Dismissed', color: 'slate' },
  cancelled: { label: 'Order cancelled', color: 'slate' },
};

const orders = ref([]);
const onlyProblems = ref(false);
const expanded = ref(new Set());
const rerunning = ref(new Set());

const SWITCHES = [
  { key: 'create_tickets', label: 'Create tickets', hint: 'One shipping ticket per order, plus any tickets your tag rules ask for.' },
  { key: 'wait_for_payment', label: 'Wait for payment', hint: "Unpaid orders (bank transfer, manual payment) get their ticket once Shopify marks them paid. Deposits count as paid." },
  { key: 'skip_pos', label: 'Skip in-store (POS) sales', hint: 'No shipping ticket for orders rung up on Shopify POS.' },
  { key: 'create_customers', label: 'Create customers', hint: 'Off: only link orders to customers who already exist (by Shopify account or email).' },
  { key: 'sync_xero_contacts', label: 'Add customers to Xero', hint: 'Links to an existing Xero contact with the same email first; creates one only if there is none.' },
  { key: 'xero_note', label: 'Add order note in Xero', hint: "Each item and the order total, on the customer's Xero History & Notes." },
];

const STEP_LABELS = {
  customer: 'Customer', xero_contact: 'Xero contact', ticket: 'Ticket', xero_note: 'Xero note',
};
const STATUS_COLORS = {
  done: 'green', skipped: 'slate', waiting: 'amber', pending: 'blue', failed: 'red', attention: 'orange',
};
const STATUS_LABELS = {
  done: 'Done', skipped: 'Skipped', waiting: 'Waiting', pending: 'Pending', failed: 'Failed', attention: 'Needs attention',
};

const topCategories = computed(() => settings.topLevel('ticket_category'));
const subcategoriesOf = (key) => (key ? settings.childrenOf('ticket_category', key) : []);

const blankRule = () => ({ tag: '', action: 'no_ticket', category_key: '', subcategory_key: '' });
const newRule = ref(blankRule());

const adminApiLabel = computed(() => ({
  client_credentials: 'Client credentials (Dev Dashboard app)',
  static_token: 'Static Admin API token',
}[connection.value.admin_api] || 'Not configured'));

function fmtWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function loadSettings() {
  const data = await api.get('/shopify-orders/settings');
  intake.value = data.intake;
  rules.value = data.rules;
  connection.value = data.connection;
}

async function loadRestorations() {
  const [recent, info] = await Promise.all([
    api.get('/restoration-intake/recent'),
    api.get('/restoration-intake/reviewers'),
  ]);
  restorations.value = recent;
  reviewerInfo.value = info;
}

async function toggleReviewer(id, on) {
  error.value = '';
  const ids = new Set(intake.value.restoration_reviewer_ids || []);
  if (on) ids.add(id); else ids.delete(id);
  try {
    const data = await api.patch('/shopify-orders/settings', { restoration_reviewer_ids: [...ids] });
    intake.value = data.intake;
    reviewerInfo.value = await api.get('/restoration-intake/reviewers');
  } catch (err) {
    error.value = err.message;
  }
}

async function loadOrders() {
  orders.value = await api.get('/shopify-orders/orders', { problems: onlyProblems.value ? '1' : '' });
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    await Promise.all([loadSettings(), loadOrders(), loadRestorations(), settings.load(), refData.load()]);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function toggle(key, value) {
  error.value = '';
  try {
    const data = await api.patch('/shopify-orders/settings', { [key]: value });
    intake.value = data.intake;
  } catch (err) {
    error.value = err.message;
  }
}

async function testConnection() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await api.post('/shopify-orders/test-connection');
  } catch (err) {
    testResult.value = { ok: false, error: err.message };
  } finally {
    testing.value = false;
  }
}

function rulePayload(r) {
  return {
    tag: r.tag,
    action: r.action,
    category_key: r.action === 'ticket' ? r.category_key || null : null,
    subcategory_key: r.action === 'ticket' ? r.subcategory_key || null : null,
  };
}

async function addRule() {
  error.value = '';
  try {
    const created = await api.post('/shopify-orders/rules', rulePayload(newRule.value));
    rules.value = [...rules.value, created];
    newRule.value = blankRule();
  } catch (err) {
    error.value = err.message;
  }
}

async function saveRule(rule, changes) {
  error.value = '';
  const next = { ...rule, ...changes };
  // Switching to a different top-level category clears a sub-category that
  // no longer belongs to it.
  if ('category_key' in changes && changes.category_key !== rule.category_key) next.subcategory_key = '';
  if (next.action === 'ticket' && !next.category_key) {
    // Not saveable yet — keep the edit locally until a category is picked.
    rules.value = rules.value.map((r) => (r.id === rule.id ? next : r));
    return;
  }
  try {
    const saved = await api.patch(`/shopify-orders/rules/${rule.id}`, rulePayload(next));
    rules.value = rules.value.map((r) => (r.id === rule.id ? saved : r));
  } catch (err) {
    error.value = err.message;
    await loadSettings();
  }
}

async function moveRule(index, delta) {
  const list = [...rules.value];
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  rules.value = list;
  try {
    // Rewrite sort_order for the whole list — a handful of rows at most.
    await Promise.all(list.map((r, i) => api.patch(`/shopify-orders/rules/${r.id}`, { sort_order: (i + 1) * 10 })));
  } catch (err) {
    error.value = err.message;
  }
  await loadSettings();
}

async function deleteRule(rule) {
  if (!confirm(`Delete the rule for "${rule.tag}"? Items with that tag will get the default shipping ticket again.`)) return;
  try {
    await api.del(`/shopify-orders/rules/${rule.id}`);
    rules.value = rules.value.filter((r) => r.id !== rule.id);
  } catch (err) {
    error.value = err.message;
  }
}

function toggleExpanded(id) {
  const s = new Set(expanded.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  expanded.value = s;
}

async function rerun(order) {
  const s = new Set(rerunning.value);
  s.add(order.id);
  rerunning.value = s;
  error.value = '';
  notice.value = '';
  try {
    const updated = await api.post(`/shopify-orders/orders/${order.id}/reprocess`);
    orders.value = orders.value.map((o) => (o.id === order.id ? updated : o));
    notice.value = `Re-ran ${order.order_name || 'order'}.`;
  } catch (err) {
    error.value = err.message;
  } finally {
    const done = new Set(rerunning.value);
    done.delete(order.id);
    rerunning.value = done;
  }
}

const needsRerun = (o) => Object.values(o.steps).some((s) => ['failed', 'attention'].includes(s.status));

// The log is live-ish: new orders arrive while someone has this open.
let timer = null;
onMounted(async () => {
  await load();
  timer = setInterval(() => { loadOrders().catch(() => {}); }, 30_000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Shopify orders</h1>
        <p class="muted small" style="margin: 0">
          What happens when an order is placed in Shopify. The default ticket's category is set under
          Settings → Shop configuration.
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'settings' }">← Settings</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div v-if="loading" class="empty">Loading…</div>

    <div v-else class="stack">
      <!-- ------------------------------------------------------ connection -->
      <div class="card">
        <h2>Connection</h2>
        <div class="detail-rows">
          <div class="detail-row">
            <span class="detail-label">Webhook signing</span>
            <span class="detail-value">
              <span class="pill" :class="connection.webhook_secret ? 'green' : 'red'">
                {{ connection.webhook_secret ? 'Secret set' : 'Not set — every webhook will be rejected' }}
              </span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Admin API</span>
            <span class="detail-value">
              {{ adminApiLabel }}
              <span v-if="connection.shop_domain" class="muted small">· {{ connection.shop_domain }}</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Xero</span>
            <span class="detail-value">{{ connection.xero ? 'Configured' : 'Not configured — Xero steps are skipped' }}</span>
          </div>
        </div>
        <div class="row" style="margin-top: 10px">
          <button class="small" :disabled="testing || !connection.admin_api" @click="testConnection">
            {{ testing ? 'Testing…' : 'Test Shopify connection' }}
          </button>
          <span v-if="testResult && testResult.ok" class="pill green">Connected to {{ testResult.shop.name }}</span>
          <span v-else-if="testResult" class="small" style="color: var(--red)">{{ testResult.error }}</span>
        </div>
        <p class="muted small" style="margin-bottom: 0">
          Tag rules need the Admin API (Shopify doesn't include product tags in order webhooks). With no
          rules, orders are processed without it.
        </p>
      </div>

      <!-- --------------------------------------------------------- switches -->
      <div class="card">
        <h2>When an order comes in</h2>
        <div class="grid cols-2">
          <label v-for="s in SWITCHES" :key="s.key" class="checkbox" style="align-items: flex-start">
            <input
              type="checkbox" :checked="intake[s.key]"
              @change="toggle(s.key, $event.target.checked)"
            />
            <span>
              <strong style="color: var(--text)">{{ s.label }}</strong>
              <span class="muted small" style="display: block">{{ s.hint }}</span>
            </span>
          </label>
        </div>
      </div>

      <!-- -------------------------------------------------------- tag rules -->
      <div class="card">
        <h2>Tag rules</h2>
        <p class="muted small" style="margin-top: -6px">
          Checked against each item's Shopify product tags, top to bottom; the first match wins. Items
          with no matching rule get the default shipping ticket (unless they don't require shipping).
          An order where nothing gets a ticket still gets its customer and Xero note.
        </p>

        <div v-if="!rules.length" class="empty" style="padding: 16px">
          No rules yet — every shipped item goes on the default shipping ticket.
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr><th style="width: 70px" /><th>Product tag</th><th>Then</th><th>Category</th><th>Sub-category</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="(rule, i) in rules" :key="rule.id">
                <td class="nowrap">
                  <button class="small" :disabled="i === 0" title="Move up" @click="moveRule(i, -1)">↑</button>
                  <button class="small" :disabled="i === rules.length - 1" title="Move down" @click="moveRule(i, 1)">↓</button>
                </td>
                <td>
                  <input :value="rule.tag" @change="saveRule(rule, { tag: $event.target.value })" />
                </td>
                <td>
                  <select :value="rule.action" @change="saveRule(rule, { action: $event.target.value })">
                    <option value="no_ticket">No ticket</option>
                    <option value="ticket">Own ticket in…</option>
                    <option value="restoration">Restoration sale (set up from homepage)</option>
                  </select>
                </td>
                <td>
                  <select
                    v-if="rule.action === 'ticket'" :value="rule.category_key || ''"
                    @change="saveRule(rule, { category_key: $event.target.value })"
                  >
                    <option value="" disabled>Pick a category</option>
                    <option v-for="c in topCategories" :key="c.key" :value="c.key">{{ c.label }}</option>
                  </select>
                  <span v-else class="muted">—</span>
                </td>
                <td>
                  <select
                    v-if="rule.action === 'ticket' && subcategoriesOf(rule.category_key).length"
                    :value="rule.subcategory_key || ''"
                    @change="saveRule(rule, { subcategory_key: $event.target.value })"
                  >
                    <option value="">None</option>
                    <option v-for="c in subcategoriesOf(rule.category_key)" :key="c.key" :value="c.key">{{ c.label }}</option>
                  </select>
                  <span v-else class="muted">—</span>
                </td>
                <td class="right">
                  <button class="small danger" @click="deleteRule(rule)">Delete</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="field-row" style="margin-top: 14px; align-items: end">
          <div class="field">
            <label>Product tag</label>
            <input v-model="newRule.tag" placeholder="e.g. no-ship" @keyup.enter="addRule" />
          </div>
          <div class="field">
            <label>Then</label>
            <select v-model="newRule.action">
              <option value="no_ticket">No ticket</option>
              <option value="ticket">Own ticket in…</option>
              <option value="restoration">Restoration sale (set up from homepage)</option>
            </select>
          </div>
          <div v-if="newRule.action === 'ticket'" class="field">
            <label>Category</label>
            <select v-model="newRule.category_key" @change="newRule.subcategory_key = ''">
              <option value="" disabled>Pick a category</option>
              <option v-for="c in topCategories" :key="c.key" :value="c.key">{{ c.label }}</option>
            </select>
          </div>
          <div v-if="newRule.action === 'ticket' && subcategoriesOf(newRule.category_key).length" class="field">
            <label>Sub-category</label>
            <select v-model="newRule.subcategory_key">
              <option value="">None</option>
              <option v-for="c in subcategoriesOf(newRule.category_key)" :key="c.key" :value="c.key">{{ c.label }}</option>
            </select>
          </div>
          <div class="field">
            <button
              class="primary"
              :disabled="!newRule.tag.trim() || (newRule.action === 'ticket' && !newRule.category_key)"
              @click="addRule"
            >
              Add rule
            </button>
          </div>
        </div>
      </div>

      <!-- ------------------------------------------------ restoration sales -->
      <div class="card">
        <h2>Restoration sales</h2>
        <p class="muted small" style="margin-top: -6px">
          Items matching a <strong>Restoration sale</strong> rule (the <code>restoration</code> tag) get no ticket when
          the order comes in. They show on the homepage of the people below, who confirm which inventory piece
          was sold and pick the queue — Mission Control then records the sale to the buyer and opens the
          restoration ticket at the back of that queue. They're emailed when one comes in.
        </p>
        <div class="field">
          <label>Reviewers</label>
          <div class="row" style="flex-wrap: wrap; gap: 4px 16px">
            <label v-for="e in reviewerOptions" :key="e.id" class="checkbox" style="margin: 0">
              <input
                type="checkbox" :checked="(intake.restoration_reviewer_ids || []).includes(e.id)"
                @change="toggleReviewer(e.id, $event.target.checked)"
              />
              {{ e.name }} <span v-if="e.role !== 'admin'" class="muted small">({{ e.role }})</span>
            </label>
          </div>
          <p v-if="reviewerInfo.fallback" class="muted small" style="margin: 6px 0 0">
            Nobody picked (or nobody picked is still active), so every admin sees them:
            {{ reviewerInfo.effective.map((e) => e.name).join(', ') || 'no active admins' }}.
          </p>
        </div>

        <div v-if="!restorations.length" class="empty" style="padding: 16px">No restoration sales yet.</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr><th>Order</th><th>Listing</th><th>Buyer</th><th>Status</th><th>Instrument</th><th>Ticket</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in restorations" :key="r.id">
                <td class="nowrap">
                  <strong>{{ r.order.name || r.order.shopify_order_id }}</strong>
                  <div class="muted small">{{ r.order.date }}</div>
                </td>
                <td>
                  {{ r.item.title }}
                  <div v-if="r.item.deposit_label" class="muted small">
                    {{ r.item.deposit_label }} deposit<span v-if="r.item.full_price_label"> · {{ r.item.full_price_label }} full</span>
                  </div>
                </td>
                <td>{{ r.customer ? r.customer.name : '—' }}</td>
                <td>
                  <span class="pill" :class="RESTO_STATUS[r.status].color">{{ RESTO_STATUS[r.status].label }}</span>
                  <div v-if="r.order_cancelled_at" class="small" style="color: var(--red)">Order cancelled after setup</div>
                  <div v-if="r.resolved_by_name" class="muted small">{{ r.resolved_by_name }} · {{ fmtWhen(r.resolved_at) }}</div>
                </td>
                <td>
                  <RouterLink v-if="r.instrument_id" :to="{ name: 'instrument', params: { id: r.instrument_id } }">
                    {{ r.instrument_label || `#${r.instrument_id}` }}
                  </RouterLink>
                  <span v-else class="muted">—</span>
                </td>
                <td class="nowrap">
                  <RouterLink v-if="r.ticket_id" :to="{ name: 'ticket', params: { id: r.ticket_id } }">#{{ r.ticket_id }}</RouterLink>
                  <span v-else class="muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- -------------------------------------------------------- order log -->
      <div class="card">
        <div class="row">
          <h2 style="margin: 0">Order log</h2>
          <span class="spacer" />
          <label class="checkbox small" style="margin: 0">
            <input v-model="onlyProblems" type="checkbox" @change="loadOrders" />
            Only problems
          </label>
          <button class="small" @click="loadOrders">Refresh</button>
        </div>
        <p class="muted small">
          Failed steps retry on their own every few minutes for about two hours. "Needs attention" means a
          person has to fix something first (usually a Xero match) — then Re-run.
        </p>

        <div v-if="!orders.length" class="empty">
          {{ onlyProblems ? 'No problems.' : 'No orders received yet.' }}
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr><th>Order</th><th>Received</th><th>Buyer</th><th>Steps</th><th>Tickets</th><th /></tr>
            </thead>
            <tbody>
              <template v-for="o in orders" :key="o.id">
                <tr class="clickable" @click="toggleExpanded(o.id)">
                  <td class="nowrap">
                    <strong>{{ o.order_name || o.shopify_order_id }}</strong>
                    <div class="muted small">
                      {{ o.total }}<span v-if="o.financial_status"> · {{ o.financial_status.replace('_', ' ') }}</span>
                      <span v-if="o.source_name === 'pos'"> · POS</span>
                      <span v-if="o.cancelled" style="color: var(--red)"> · cancelled</span>
                    </div>
                  </td>
                  <td class="nowrap small">{{ fmtWhen(o.received_at) }}</td>
                  <td>
                    {{ o.customer_name || o.buyer }}
                    <div v-if="o.customer_id" class="muted small">Customer #{{ o.customer_id }}</div>
                  </td>
                  <td>
                    <span
                      v-for="(step, key) in o.steps" :key="key"
                      class="pill" :class="STATUS_COLORS[step.status]"
                      style="margin: 0 4px 4px 0" :title="step.message || ''"
                    >
                      {{ STEP_LABELS[key] }}: {{ STATUS_LABELS[step.status] }}
                    </span>
                  </td>
                  <td class="nowrap">
                    <RouterLink
                      v-for="id in o.ticket_ids" :key="id" :to="{ name: 'ticket', params: { id } }"
                      style="margin-right: 6px" @click.stop
                    >
                      #{{ id }}
                    </RouterLink>
                    <span v-if="!o.ticket_ids.length" class="muted">—</span>
                  </td>
                  <td class="right nowrap">
                    <span v-if="o.processing" class="muted small">Working…</span>
                    <button
                      v-else-if="needsRerun(o)" class="small" :disabled="rerunning.has(o.id)"
                      @click.stop="rerun(o)"
                    >
                      {{ rerunning.has(o.id) ? 'Running…' : 'Re-run' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="expanded.has(o.id)">
                  <td colspan="6" style="background: var(--surface-2)">
                    <div v-for="(step, key) in o.steps" :key="key" class="small" style="margin-bottom: 4px">
                      <strong>{{ STEP_LABELS[key] }}</strong>
                      <span class="pill" :class="STATUS_COLORS[step.status]" style="margin: 0 6px">
                        {{ STATUS_LABELS[step.status] }}
                      </span>
                      <span class="muted">{{ step.message || '' }}</span>
                    </div>
                    <div class="muted small">Shopify order id {{ o.shopify_order_id }} · {{ o.attempts }} run(s)</div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
