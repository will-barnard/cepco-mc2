<script setup>
/**
 * Ownership history (migration 087) -- every period of an instrument's life,
 * newest first: who owned it, how it came to them, how it left. Owners and
 * buyers with a customer record link to it.
 *
 * Editable here, saved on its own (PATCH /instruments/ownership/:id, which
 * hands back the whole instrument page as `changed`):
 *   - a sale's date, price and buyer -- linking the buyer's customer record
 *     also makes the piece theirs if they still own it;
 *   - a sold consignment's payout status, kept in step with its payout
 *     ticket (migration 090), which is linked beside it;
 *   - undo the most recent sale (seniors and admins), while the buyer still
 *     owns it.
 */
import { ref, computed } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useAuth } from '../stores';
import CustomerSearchSelect from './CustomerSearchSelect.vue';
import { formatPrice } from '../inventory';

const props = defineProps({ item: { type: Object, required: true } });
const emit = defineEmits(['changed']);
const auth = useAuth();

const history = computed(() => props.item.ownership_history || []);
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString() : '');
const PAYOUT = [
  { key: 'payout_due', label: 'Payout due' },
  { key: 'paid_out', label: 'Paid out' },
  { key: 'contracted', label: 'Contracted' },
  { key: 'for_sale', label: 'For sale' },
];

function who(h) {
  if (h.kind === 'shop') return null;
  return h.customer_id ? { id: h.customer_id, name: h.customer_name } : null;
}
const KIND = { customer: 'Owned by', shop: 'CEPCo stock', consignment: 'Consigned by' };
const STARTED = {
  added: 'Added', sale: 'Bought from CEPCo', consignment: 'Consigned to CEPCo',
  consignment_returned: 'Returned unsold', changed: 'Owner changed', purchase: 'Bought by CEPCo',
};

// The sale that opened the current owner's period, when its buyer has no
// customer record yet -- the "Link buyer" box goes on that sale.
const unlinkedSale = computed(() => {
  const [cur, prev] = history.value;
  if (!cur || cur.end_reason || cur.customer_id || cur.start_reason !== 'sale') return null;
  return prev && prev.end_reason === 'sale' ? prev : null;
});

const error = ref('');
const busy = ref(false);
async function patchPeriod(h, body) {
  error.value = '';
  busy.value = true;
  try {
    emit('changed', await api.patch(`/instruments/ownership/${h.id}`, body));
    editing.value = null;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const editing = ref(null); // period id whose sale is being edited
const saleForm = ref({});
function editSale(h) {
  editing.value = h.id;
  saleForm.value = {
    sold_on: h.ended_on ? String(h.ended_on).slice(0, 10) : '',
    sale_price: h.sale_price ?? '',
    sold_to_name: h.sold_to_name || '',
    sold_to_customer_id: h.sold_to_customer_id || '',
  };
}
function saveSale(h) {
  const f = saleForm.value;
  patchPeriod(h, {
    sold_on: f.sold_on || null,
    sale_price: f.sale_price === '' ? null : f.sale_price,
    sold_to_name: f.sold_to_name,
    sold_to_customer_id: f.sold_to_customer_id || null,
  });
}

const linkBuyerId = ref('');
function linkBuyer(row) {
  if (!row || !unlinkedSale.value) return;
  patchPeriod(unlinkedSale.value, { sold_to_customer_id: row.id });
}

async function undoSale() {
  if (!confirm('Undo this sale? The piece goes back into stock (or back to an active consignment), and the buyer no longer owns it.')) return;
  error.value = '';
  busy.value = true;
  try {
    emit('changed', await api.post(`/instruments/${props.item.id}/undo-sale`));
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h2>Ownership history</h2>
    <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>
    <p v-if="!history.length" class="muted small" style="margin: 0">Nothing recorded.</p>
    <ol v-else class="owner-list">
      <li v-for="h in history" :key="h.id" :class="{ current: !h.end_reason }">
        <div class="row" style="gap: 6px; align-items: baseline">
          <strong>{{ KIND[h.kind] }}</strong>
          <template v-if="h.kind !== 'shop'">
            <RouterLink v-if="who(h)" :to="{ name: 'customers', query: { id: who(h).id } }">{{ who(h).name }}</RouterLink>
            <span v-else-if="h.owner_name">{{ h.owner_name }} <span class="muted small">(no customer record)</span></span>
            <span v-else class="muted">unknown</span>
          </template>
          <span v-if="!h.end_reason" class="pill green tiny">Now</span>
        </div>

        <div class="muted small">
          <template v-if="h.started_on || h.ended_on">
            {{ h.started_on ? day(h.started_on) : '…' }} – {{ h.end_reason ? (h.ended_on ? day(h.ended_on) : '…') : 'now' }}
          </template>
          <template v-else-if="h.start_reason === 'on_file' && !h.end_reason">On file before the history began</template>
          <template v-if="STARTED[h.start_reason]"> · {{ STARTED[h.start_reason] }}</template>
        </div>

        <!-- How the shop got it -->
        <div v-if="h.purchase_id && h.kind === 'shop'" class="small">
          Bought from
          <RouterLink v-if="h.seller_customer_id" :to="{ name: 'customers', query: { id: h.seller_customer_id } }">
            {{ h.seller_customer_name || h.seller_name }}
          </RouterLink>
          <template v-else>{{ h.seller_name }}</template>
          on {{ day(h.purchase_date) }}<template v-if="h.purchase_price !== undefined && h.purchase_price !== null"> for {{ formatPrice(h.purchase_price) }}</template>
          <template v-if="h.receipt_sent_at"> · receipt sent</template>
          <RouterLink v-if="h.purchase_ticket_id" :to="{ name: 'ticket', params: { id: h.purchase_ticket_id } }"> · ticket #{{ h.purchase_ticket_id }}</RouterLink>
        </div>
        <div v-else-if="h.end_reason === 'purchase'" class="small">Sold to CEPCo</div>
        <div v-else-if="h.end_reason === 'consignment'" class="small">Consigned to CEPCo</div>
        <div v-else-if="h.end_reason === 'consignment_returned'" class="small">
          Went back to its owner unsold<template v-if="h.consignment_terms || h.consignment_rate !== null"> · deal was
            {{ h.consignment_terms || `${Number(h.consignment_rate)}%` }}</template>
        </div>
        <div v-else-if="h.end_reason === 'changed'" class="small muted">Owner changed</div>

        <!-- The sale that ended it -->
        <template v-if="h.end_reason === 'sale'">
          <div v-if="editing !== h.id" class="small sale-line">
            Sold<template v-if="h.ended_on"> {{ day(h.ended_on) }}</template>
            <template v-if="h.sale_price !== null"> for <strong>{{ formatPrice(h.sale_price) }}</strong></template>
            to
            <RouterLink v-if="h.sold_to_customer_id" :to="{ name: 'customers', query: { id: h.sold_to_customer_id } }">
              {{ h.sold_to_customer_name || h.sold_to_name }}
            </RouterLink>
            <template v-else>{{ h.sold_to_name || 'someone not recorded' }}</template>
            <template v-if="h.kind === 'consignment' && (h.consignment_terms || h.consignment_rate !== null)">
              · deal {{ h.consignment_terms || `${Number(h.consignment_rate)}%` }}
            </template>
            <button type="button" class="link small" @click="editSale(h)">Edit</button>
            <button v-if="h.can_undo && auth.isSenior" type="button" class="link small" :disabled="busy" @click="undoSale">Undo sale</button>
          </div>
          <form v-else class="sale-edit" @submit.prevent="saveSale(h)">
            <div class="field-row">
              <div class="field"><label>Sold on</label><input v-model="saleForm.sold_on" type="date" /></div>
              <div class="field"><label>Price</label><input v-model="saleForm.sale_price" inputmode="decimal" /></div>
            </div>
            <div class="field"><label>Buyer (name)</label><input v-model="saleForm.sold_to_name" /></div>
            <div class="field">
              <label>Buyer's customer record</label>
              <CustomerSearchSelect v-model="saleForm.sold_to_customer_id" placeholder="Link the buyer…" />
            </div>
            <div class="row">
              <button class="small primary" type="submit" :disabled="busy">Save</button>
              <button class="small" type="button" @click="editing = null">Cancel</button>
            </div>
          </form>
          <div v-if="h.kind === 'consignment'" class="row small" style="gap: 6px; margin-top: 4px">
            <label :for="`payout-${h.id}`" class="muted">Consignor payout</label>
            <select
              :id="`payout-${h.id}`" :value="h.payout_status || ''" class="payout-select" :disabled="busy"
              @change="patchPeriod(h, { payout_status: $event.target.value || null })"
            >
              <option value="">Not recorded</option>
              <option v-for="p in PAYOUT" :key="p.key" :value="p.key">{{ p.label }}</option>
            </select>
            <!-- Migration 090: the ticket paying this consignor. Finishing it
                 marks the payout Paid out, and Paid out here finishes it. -->
            <RouterLink v-if="h.payout_ticket_id" :to="{ name: 'ticket', params: { id: h.payout_ticket_id } }">
              Payout ticket #{{ h.payout_ticket_id }}
            </RouterLink>
            <span v-if="h.payout_ticket_id" class="muted">
              ({{ h.payout_ticket_archived ? 'archived' : h.payout_ticket_status }})
            </span>
          </div>
        </template>

        <!-- Buyer known only by name: link their customer record -->
        <div v-if="!h.end_reason && unlinkedSale" class="field link-buyer">
          <label class="small">Link the buyer's customer record (it moves onto their page)</label>
          <CustomerSearchSelect v-model="linkBuyerId" placeholder="Search customers…" @change="linkBuyer" />
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.owner-list { list-style: none; margin: 0; padding: 0; }
.owner-list li { padding: 8px 0 8px 12px; border-left: 2px solid var(--border); margin-left: 4px; }
.owner-list li + li { margin-top: 4px; }
.owner-list li.current { border-left-color: var(--green); }
.sale-line .link { margin-left: 6px; }
.sale-edit { margin-top: 8px; }
.payout-select { width: auto; min-height: 0; padding: 2px 6px; font-size: 13px; }
.link-buyer { margin: 8px 0 0; }
</style>
