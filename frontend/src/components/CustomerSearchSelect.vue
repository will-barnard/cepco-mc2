<script setup>
/**
 * Type-ahead customer picker — replaces a plain <select> listing every
 * customer (EstimateNewView.vue, TicketNewView.vue) now that scrolling a
 * giant native dropdown to find one customer is real friction on the
 * shop floor. Same open/close convention as QueueView.vue's hide-statuses
 * menu — click-outside + Escape to close (see styles.css's
 * .customer-search-* rules, styled the same way as that menu's
 * .hide-status-* rules).
 *
 * v-model is the customer id, exactly like the <select> it replaces, so
 * callers don't need to change how they read the chosen id. A `change`
 * event additionally hands back the full customer row (or null once
 * cleared) since both callers here also want the name/email/phone off
 * the selected row without a second lookup.
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import api from '../api';

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: 'Search customers…' },
});
const emit = defineEmits(['update:modelValue', 'change']);

const query = ref('');
const results = ref([]);
const open = ref(false);
const loading = ref(false);
const highlighted = ref(-1);
const wrapEl = ref(null);
const inputEl = ref(null);

let debounceTimer;
let searchToken = 0; // guards against a slow early request landing after a faster later one

async function search() {
  const token = ++searchToken;
  loading.value = true;
  try {
    const rows = await api.get('/customers', { q: query.value });
    if (token !== searchToken) return;
    results.value = rows;
    highlighted.value = rows.length ? 0 : -1;
  } finally {
    if (token === searchToken) loading.value = false;
  }
}

function onInput(event) {
  query.value = event.target.value;
  // Typing invalidates whatever was selected before — same as a native
  // <select> snapping back to its blank option the moment you pick a
  // different one, just triggered by the first keystroke instead.
  if (props.modelValue) {
    emit('update:modelValue', '');
    emit('change', null);
  }
  open.value = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(search, 250);
}

function onFocus() {
  open.value = true;
  if (!results.value.length && !loading.value) search();
}

function select(row) {
  query.value = row.name;
  results.value = [];
  open.value = false;
  emit('update:modelValue', row.id);
  emit('change', row);
}

function clearSelection() {
  query.value = '';
  emit('update:modelValue', '');
  emit('change', null);
  open.value = true;
  inputEl.value?.focus();
  search();
}

function close() {
  open.value = false;
  // An unmatched, half-typed search shouldn't linger looking like a real
  // value once focus leaves — revert to whatever's actually selected
  // (nothing, if the field was cleared without picking a new result).
  if (!props.modelValue) query.value = '';
}

function onKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (!open.value) { open.value = true; search(); return; }
    highlighted.value = Math.min(highlighted.value + 1, results.value.length - 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlighted.value = Math.max(highlighted.value - 1, 0);
  } else if (event.key === 'Enter') {
    if (open.value && results.value[highlighted.value]) {
      event.preventDefault();
      select(results.value[highlighted.value]);
    }
  } else if (event.key === 'Escape') {
    close();
  }
}

function onDocumentClick(event) {
  if (open.value && wrapEl.value && !wrapEl.value.contains(event.target)) close();
}
function onDocumentKeydown(event) {
  if (event.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
  if (props.modelValue) {
    api.get(`/customers/${props.modelValue}`).then((row) => { query.value = row.name; }).catch(() => {});
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onDocumentKeydown);
});

// External resets (e.g. EstimateNewView.vue blanking customerId when the
// "add a new customer instead" checkbox is ticked) need to blank the
// visible text too — this component owns `query`, so it has to hear
// about modelValue changes it didn't cause itself via select()/
// clearSelection() (which already keep query in sync on their own).
watch(() => props.modelValue, (id, prevId) => {
  if (id === prevId) return;
  if (!id) { query.value = ''; return; }
  const known = results.value.find((r) => r.id === id);
  if (known) query.value = known.name;
});
</script>

<template>
  <div ref="wrapEl" class="customer-search">
    <div class="customer-search-input-wrap">
      <input
        ref="inputEl"
        :value="query"
        type="search"
        class="customer-search-input"
        :placeholder="placeholder"
        :disabled="disabled"
        autocomplete="off"
        @input="onInput"
        @focus="onFocus"
        @keydown="onKeydown"
      />
      <button
        v-if="modelValue && !disabled"
        type="button" class="link customer-search-clear"
        title="Clear selected customer"
        @click="clearSelection"
      >
        ×
      </button>
    </div>
    <div v-if="open && !disabled" class="customer-search-menu">
      <div v-if="loading" class="customer-search-empty muted small">Searching…</div>
      <div v-else-if="!results.length" class="customer-search-empty muted small">No customers found.</div>
      <ul v-else>
        <li
          v-for="(r, i) in results" :key="r.id"
          :class="{ highlighted: i === highlighted }"
          @mousedown.prevent
          @click="select(r)"
          @mouseenter="highlighted = i"
        >
          <span>{{ r.name }}</span>
          <span v-if="r.email" class="muted small">{{ r.email }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
