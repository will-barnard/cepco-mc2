<script setup>
/**
 * Friday Lunch orders for one round (migration 096). Only rendered once an
 * admin has turned orders on for that result. Unlike votes these are named:
 * whoever places the order needs to know whose is whose.
 *
 * Writes return the round's refreshed state, which is handed up via
 * `update` so the page's copy stays the one source of truth.
 */
import { ref, computed, watch } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const props = defineProps({
  state: { type: Object, required: true },
  readonly: { type: Boolean, default: false }, // history view
});
const emit = defineEmits(['update']);
const auth = useAuth();

const round = computed(() => props.state.round);
const orders = computed(() => props.state.orders || []);
const isOpen = computed(() => round.value.orders_status === 'open');
const mine = computed(() => orders.value.find((o) => o.mine) || null);
const winnerName = computed(() => props.state.places.find((p) => p.id === round.value.winner_place_id)?.name || 'lunch');

const draft = ref('');
watch(() => mine.value?.order_text, (t) => { draft.value = t || ''; }, { immediate: true });
const dirty = computed(() => draft.value.trim() !== (mine.value?.order_text || ''));

const busy = ref(false);
const error = ref('');
const copied = ref(false);

async function run(fn, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  error.value = '';
  busy.value = true;
  try {
    emit('update', await fn());
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const base = computed(() => `/lunch/rounds/${round.value.id}`);
const save = () => run(() => api.put(`${base.value}/order`, { text: draft.value }));
const removeMine = () => run(() => api.del(`${base.value}/order`), 'Remove your order?');
const removeOther = (o) => run(() => api.del(`${base.value}/orders/${o.id}`), `Remove ${o.name}'s order?`);
const closeOrders = () => run(
  () => api.post(`${base.value}/orders/close`),
  'Close orders? Nobody can add or change theirs until you reopen.',
);
const reopenOrders = () => run(() => api.post(`${base.value}/orders/open`));

// Plain text for pasting into a text, an online order's notes, etc.
async function copyAll() {
  const text = `${winnerName.value} order\n\n${orders.value.map((o) => `${o.name}: ${o.order_text}`).join('\n')}`;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    error.value = 'Couldn’t copy on this device. Select the list and copy it by hand.';
  }
}
</script>

<template>
  <div class="lunch-orders">
    <div class="row" style="margin-bottom: 8px">
      <h3 style="margin: 0">Orders for {{ winnerName }}</h3>
      <span class="tag">{{ isOpen ? 'Open' : 'Closed' }}</span>
      <span class="muted small">{{ orders.length }} order{{ orders.length === 1 ? '' : 's' }}</span>
      <span class="spacer" />
      <button v-if="orders.length" class="small" @click="copyAll">{{ copied ? 'Copied ✓' : 'Copy all' }}</button>
      <template v-if="auth.isAdmin && !readonly">
        <button v-if="isOpen" class="small" :disabled="busy" @click="closeOrders">Close orders</button>
        <button v-else class="small" :disabled="busy" @click="reopenOrders">Reopen orders</button>
      </template>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>

    <form v-if="isOpen && !readonly" class="lunch-order-form" @submit.prevent="save">
      <label>Your order <span class="muted">(shows your name)</span></label>
      <textarea v-model="draft" maxlength="500" style="min-height: 64px"
        placeholder="e.g. Italian beef, hot, dipped + fries" />
      <div class="row" style="margin-top: 6px">
        <button class="primary small" type="submit" :disabled="busy || !draft.trim() || !dirty">
          {{ mine ? 'Update my order' : 'Add my order' }}
        </button>
        <span v-if="mine && !dirty" class="small" style="color: var(--green)">✓ Saved</span>
        <span class="spacer" />
        <button v-if="mine" class="small" type="button" :disabled="busy" @click="removeMine">Remove</button>
      </div>
    </form>
    <p v-else-if="!isOpen && !readonly" class="muted small" style="margin: 0 0 10px">
      Orders are closed{{ auth.isAdmin ? '' : '. Ask an admin if you need to change yours' }}.
    </p>

    <div v-if="!orders.length" class="muted small">No orders yet.</div>
    <ul v-else class="lunch-order-list">
      <li v-for="o in orders" :key="o.id">
        <div class="row nowrap" style="align-items: flex-start">
          <strong class="lunch-order-name">{{ o.name }}</strong>
          <span class="lunch-order-text">{{ o.order_text }}</span>
          <span class="spacer" />
          <button v-if="auth.isAdmin && !readonly && !o.mine" class="small" :disabled="busy" @click="removeOther(o)">Remove</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lunch-orders { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.lunch-orders h3 { font-size: 14px; }
.lunch-order-form { margin-bottom: 14px; }
.lunch-order-list { list-style: none; margin: 0; padding: 0; }
.lunch-order-list li { padding: 8px 0; border-bottom: 1px solid var(--border); }
.lunch-order-list li:last-child { border-bottom: none; }
.lunch-order-name { flex: none; min-width: 110px; }
.lunch-order-text { white-space: pre-wrap; }
</style>
