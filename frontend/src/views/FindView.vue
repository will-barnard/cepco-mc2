<script setup>
/**
 * Find an instrument (NOTES.md §2.112) -- one search box over every
 * instrument in mc2: shop stock, consignments, customers' pieces and sold
 * ones. Made for the inventory audit, where the tag on a piece says the
 * instrument ("Mk I 73"), the customer ("Henderson") or the customer's name
 * for it ("Dave's Wurli"), and the person holding the iPad needs to land on
 * the right record.
 *
 * The matching and ranking are server-side (services/instrumentSearch.js):
 * every word has to match somewhere, owners past and present count, and
 * "Matched on" says why each result is there. Results split into what's
 * probably in the building (stock, live consignments, open tickets) and
 * everything else.
 *
 * While the audit is running, pieces that count toward it get a big
 * checkbox right in the result, and ticking one selects the search text so
 * the next tag can just be typed over it.
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import api from '../api';
import { useAuth, useSettings } from '../stores';
import { statusPill } from '../inventory';

const route = useRoute();
const router = useRouter();
const auth = useAuth();
const settings = useSettings();

const auditOn = computed(() => settings.inventoryAuditActive);

const input = ref(null);
const q = ref(String(route.query.q || ''));
const data = ref(null);
const loading = ref(false);
const error = ref('');

// Answers can arrive out of order while typing; only the latest one counts.
let seq = 0;
async function run(text) {
  const mine = ++seq;
  if (!text.trim()) {
    data.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const res = await api.get('/instruments/search', { q: text });
    if (mine === seq) data.value = res;
  } catch (err) {
    if (mine === seq) error.value = err.message;
  } finally {
    if (mine === seq) loading.value = false;
  }
}

let timer;
watch(q, (v) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    router.replace({ path: '/find', query: v.trim() ? { q: v.trim() } : {} });
    run(v);
  }, 250);
});

const groups = computed(() => {
  const rows = data.value?.results || [];
  return [
    { key: 'in', label: 'Probably in the shop', rows: rows.filter((r) => r.in_shop) },
    { key: 'out', label: 'Not in the shop — sold, or a customer’s with nothing open', rows: rows.filter((r) => !r.in_shop) },
  ].filter((g) => g.rows.length);
});

// --- audit ------------------------------------------------------------------
const audit = ref(null); // { instruments: { total, audited } }
async function loadAudit() {
  if (!auditOn.value) return;
  try {
    audit.value = await api.get('/inventory/audit');
  } catch { /* the counter is a nicety; the search works without it */ }
}

async function toggleAudit(r, audited) {
  const before = { audited_at: r.audited_at, audited_by_name: r.audited_by_name };
  // Optimistic, like InventoryView: an audit is a long run of ticks.
  r.audited_at = audited ? new Date().toISOString() : null;
  r.audited_by_name = audited ? auth.user?.name : null;
  if (audit.value) audit.value.instruments.audited += audited ? 1 : -1;
  try {
    const row = await api.put(`/inventory/${r.id}/audit`, { audited });
    r.audited_at = row.audited_at;
    r.audited_by_name = row.audited_by_name;
    // Ready for the next tag: type straight over the last search.
    if (audited) {
      await nextTick();
      input.value?.focus();
      input.value?.select();
    }
  } catch (err) {
    Object.assign(r, before);
    if (audit.value) audit.value.instruments.audited -= audited ? 1 : -1;
    error.value = err.message;
  }
}
const auditTitle = (r) => (r.audited_at
  ? `Audited${r.audited_by_name ? ` by ${r.audited_by_name}` : ''} ${new Date(r.audited_at).toLocaleDateString()}`
  : 'Not audited yet — tick once checked');

// --- display ----------------------------------------------------------------
const title = (r) => r.nickname || r.model_chain || r.model || 'Unnamed';
// The model line, unless the title already is the model.
const subtitle = (r) => {
  const model = r.model_chain || r.model;
  return [r.family_label, r.nickname ? model : (r.model_chain && r.model !== r.model_chain ? r.model : null)]
    .filter(Boolean).join(' · ');
};

/** Who it belongs to, in one line: { text, pill, color, customerId }. */
function owner(r) {
  if (r.ownership === 'consignment') {
    return {
      pill: 'Consignment', color: 'violet', text: r.customer_name || r.consignor_name || '', customerId: r.customer_id,
    };
  }
  if (r.ownership === 'shop') {
    const p = statusPill(r);
    return { pill: `Shop · ${p.label}`, color: p.color, text: '', customerId: null };
  }
  return {
    pill: r.sold_by_shop ? 'Sold' : 'Customer',
    color: r.sold_by_shop ? 'blue' : 'slate',
    text: r.customer_name || '',
    customerId: r.customer_id,
  };
}

function open(r) {
  router.push({ name: 'instrument', params: { id: r.id } });
}

onMounted(() => {
  input.value?.focus();
  if (q.value.trim()) run(q.value);
  loadAudit();
});
watch(auditOn, (on) => { if (on && !audit.value) loadAudit(); });
</script>

<template>
  <div class="page find-page">
    <div class="page-head">
      <h1>Find an instrument</h1>
      <span v-if="auditOn && audit" class="small audit-progress" :class="{ done: audit.instruments.audited >= audit.instruments.total }">
        Audit: {{ audit.instruments.audited }} / {{ audit.instruments.total }}
        <RouterLink :to="{ path: '/inventory', query: { status: 'all', audit: 'todo' } }" class="small">what's left</RouterLink>
      </span>
    </div>

    <input
      ref="input" v-model="q" type="search" class="find-input"
      placeholder="Instrument, customer, nickname, serial or stock #"
      autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
    />
    <p class="muted small hint">
      Every word has to match somewhere — the instrument, its owner (now or before), who it was bought from,
      its nickname or a ticket. Covers shop stock, consignments, customers' pieces and sold ones.
    </p>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-if="!q.trim()" class="empty">Type what the tag says.</div>
    <div v-else-if="loading && !data" class="empty">Searching…</div>

    <template v-else-if="data">
      <div v-if="!data.results.length && !data.customers.length" class="empty">
        Nothing matches “{{ data.query }}”.
        <div class="small" style="margin-top: 8px">
          Try one word from the tag — a last name, or the model (“200A”, “Stage 73”).
        </div>
      </div>

      <section v-for="grp in groups" :key="grp.key" class="find-group">
        <h2 class="find-group-title">{{ grp.label }} <span class="muted">{{ grp.rows.length }}</span></h2>
        <div class="find-list">
          <div
            v-for="r in grp.rows" :key="r.id" class="card tight find-card"
            :class="{ unaudited: auditOn && r.counts_in_audit && !r.audited_at }"
            @click="open(r)"
          >
            <label v-if="auditOn && r.counts_in_audit" class="find-audit" :title="auditTitle(r)" @click.stop>
              <input type="checkbox" :checked="!!r.audited_at" :aria-label="`Audited: ${title(r)}`" @change="toggleAudit(r, $event.target.checked)" />
              <span class="tiny-text">{{ r.audited_at ? 'Audited' : 'Audit' }}</span>
            </label>
            <img
              v-if="r.cover_photo_id" :src="`/api/inventory/photos/${r.cover_photo_id}/view`"
              alt="" loading="lazy" class="find-thumb"
            />
            <div v-else class="find-thumb empty-thumb" />

            <div class="find-body">
              <div class="find-title">
                <RouterLink :to="{ name: 'instrument', params: { id: r.id } }" @click.stop>{{ title(r) }}</RouterLink>
                <span class="muted tiny-text mono">{{ r.stock_number }}</span>
              </div>
              <div v-if="subtitle(r)" class="muted small">{{ subtitle(r) }}<template v-if="r.serial_no"> · SN {{ r.serial_no }}</template></div>
              <div class="row find-owner">
                <span :class="['pill', owner(r).color]">{{ owner(r).pill }}</span>
                <RouterLink
                  v-if="owner(r).text && owner(r).customerId" :to="{ path: '/customers', query: { id: owner(r).customerId } }"
                  class="small" @click.stop
                >{{ owner(r).text }}</RouterLink>
                <span v-else-if="owner(r).text" class="small">{{ owner(r).text }}</span>
                <span v-if="auditOn && !r.counts_in_audit" class="muted tiny-text">not part of the audit</span>
              </div>
              <div v-for="t in r.open_tickets.slice(0, 2)" :key="t.id" class="small find-ticket">
                <RouterLink :to="{ name: 'ticket', params: { id: t.id } }" @click.stop>{{ t.title }}</RouterLink>
                <span class="muted"> · {{ t.status_label }}</span>
              </div>
              <div v-if="r.open_tickets.length > 2" class="muted tiny-text">+{{ r.open_tickets.length - 2 }} more open</div>
              <div v-if="r.matched_on.length" class="muted tiny-text find-why">
                Matched on
                <template v-for="(m, idx) in r.matched_on" :key="idx">
                  <span v-if="idx"> · </span>{{ m.label }}: <strong>{{ m.value }}</strong>
                </template>
              </div>
            </div>
          </div>
        </div>
      </section>

      <p v-if="data.truncated" class="muted small">
        Showing the best {{ data.results.length }} — add another word to narrow it down.
      </p>

      <section v-if="data.customers.length" class="find-group">
        <h2 class="find-group-title">Customers with no instrument on file</h2>
        <p class="muted small" style="margin: 0 0 8px">
          The name matches a customer, but mc2 has no instrument for them. If the piece is here, add it from their page.
        </p>
        <div class="find-list">
          <RouterLink
            v-for="c in data.customers" :key="c.id" :to="{ path: '/customers', query: { id: c.id } }"
            class="card tight find-customer"
          >
            <strong>{{ c.name }}</strong>
            <span v-if="c.email || c.phone" class="muted small"> · {{ c.email || c.phone }}</span>
          </RouterLink>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.find-page { max-width: 900px; }
.find-input {
  width: 100%; font-size: 18px; min-height: 48px; padding: 10px 14px;
}
.hint { margin: 6px 0 16px; }
.find-group { margin-bottom: 20px; }
.find-group-title { font-size: 15px; margin: 0 0 8px; }
.find-list { display: flex; flex-direction: column; gap: 8px; }
.find-card { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
.find-card:hover { border-color: var(--accent-dim); }
/* Same amber edge InventoryView gives an unaudited row. */
.find-card.unaudited { box-shadow: inset 3px 0 0 var(--amber); background: color-mix(in srgb, var(--amber) 5%, var(--surface)); }
.find-audit {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  min-width: 44px; padding-top: 4px; cursor: pointer; color: var(--text-dim);
}
/* A tap target for a thumb on an iPad, not a mouse. */
.find-audit input { width: 26px; height: 26px; min-height: 26px; margin: 0; cursor: pointer; }
.find-thumb { width: 72px; height: 54px; object-fit: cover; border-radius: 6px; flex: none; }
.empty-thumb { background: var(--surface-2); }
.find-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.find-title { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 16px; font-weight: 600; }
.find-owner { gap: 6px; margin-top: 2px; }
.find-body .find-why { font-size: 13px; }
.find-why strong { color: var(--text); font-weight: 600; }
.find-customer { display: block; color: var(--text); }
.find-customer:hover { border-color: var(--accent-dim); }
.audit-progress { color: var(--amber); font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.audit-progress.done { color: var(--green); }
.tiny-text { font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (max-width: 560px) {
  .find-thumb { width: 52px; height: 40px; }
}
</style>
