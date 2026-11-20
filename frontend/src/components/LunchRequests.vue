<script setup>
/**
 * Friday Lunch requests (migrations 097-098). One short, anonymous request
 * per person ("no Chinese, no Mexican"), made as the first step of the
 * suggestions phase and shown to everyone through suggestions, review and
 * voting to steer what gets suggested and picked.
 *
 * `step` mode is that first step: write a request or choose "no
 * requests", either of which emits `done` so the page moves the person on
 * to suggesting. Otherwise it's the read-only list (admins can still remove
 * one). In a runoff the requests come from its parent round, so that's the
 * round id writes go to.
 */
import { ref, computed, watch } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const props = defineProps({
  state: { type: Object, required: true },
  step: { type: Boolean, default: false },
});
const emit = defineEmits(['update', 'done']);
const auth = useAuth();

const requests = computed(() => props.state.requests || []);
const myRequest = computed(() => props.state.my_request); // null | { request_text: string|null }
const requestRoundId = computed(() => props.state.round.parent_round_id || props.state.round.id);

const draft = ref('');
watch(() => myRequest.value?.request_text, (t) => { draft.value = t || ''; }, { immediate: true });

const busy = ref(false);
const error = ref('');
async function run(fn, { confirmText, done = false } = {}) {
  if (confirmText && !confirm(confirmText)) return;
  error.value = '';
  busy.value = true;
  try {
    const next = await fn();
    // In a runoff the response is the parent round's state; the page only
    // needs the refreshed list, so splice that into the runoff's state.
    emit('update', next.round.id === props.state.round.id
      ? next
      : { ...props.state, requests: next.requests, my_request: next.my_request });
    if (done) emit('done');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
const base = computed(() => `/lunch/rounds/${requestRoundId.value}`);
const save = () => run(() => api.put(`${base.value}/request`, { text: draft.value }), { done: true });
const noRequests = () => run(() => api.put(`${base.value}/request`, { none: true }), { done: true });
const removeOther = (r) => run(
  () => api.del(`${base.value}/requests/${r.id}`),
  { confirmText: `Remove the request “${r.request_text}”?` },
);
</script>

<template>
  <div v-if="step || requests.length" class="lunch-requests">
    <template v-if="step">
      <h3>First, any requests?</h3>
      <p class="muted small" style="margin-top: 0">
        Anything people should keep in mind when suggesting and voting, like “no Mexican this week”
        or “somewhere with vegetarian options”. One each, and anonymous.
      </p>
      <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>
      <form class="row nowrap" style="margin-bottom: 8px" @submit.prevent="save">
        <input v-model="draft" maxlength="200" placeholder="Your request…" autocomplete="off" />
        <button class="primary" type="submit" :disabled="busy || !draft.trim()">
          {{ myRequest?.request_text ? 'Update and continue' : 'Add and continue' }}
        </button>
      </form>
      <button class="small" type="button" :disabled="busy" @click="noRequests">
        {{ myRequest?.request_text ? 'Remove mine and continue' : 'No requests, continue' }}
      </button>
      <h3 v-if="requests.length" style="margin-top: 16px">Requests so far</h3>
    </template>
    <template v-else>
      <h3>Requests</h3>
      <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>
    </template>

    <ul v-if="requests.length" class="lunch-request-list">
      <li v-for="r in requests" :key="r.id" class="row nowrap">
        <span>{{ r.request_text }}</span>
        <span v-if="r.mine" class="tag">yours</span>
        <span class="spacer" />
        <button v-if="auth.isAdmin && !r.mine" class="small" :disabled="busy" @click="removeOther(r)">Remove</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lunch-requests { margin-bottom: 18px; }
.lunch-requests h3 { font-size: 14px; margin: 0 0 8px; }
.lunch-request-list { list-style: none; margin: 0; padding: 0; }
.lunch-request-list li { padding: 6px 0; border-bottom: 1px solid var(--border); }
.lunch-request-list li:last-child { border-bottom: none; }
</style>
