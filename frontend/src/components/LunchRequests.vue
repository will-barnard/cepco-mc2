<script setup>
/**
 * Friday Lunch requests (migration 097): the first phase of a round. One
 * short, anonymous request per person ("no Chinese, no Mexican"), shown to
 * everyone through suggestions, review and voting to steer what gets
 * suggested and picked. `editable` is the requests phase; otherwise it's a
 * read-only list (admins can still
 * remove one). In a runoff the requests come from its parent round, so
 * that's the round id writes go to.
 */
import { ref, computed, watch } from 'vue';
import api from '../api';
import { useAuth } from '../stores';

const props = defineProps({
  state: { type: Object, required: true },
  editable: { type: Boolean, default: false },
});
const emit = defineEmits(['update']);
const auth = useAuth();

const requests = computed(() => props.state.requests || []);
const mine = computed(() => requests.value.find((r) => r.mine) || null);
const requestRoundId = computed(() => props.state.round.parent_round_id || props.state.round.id);

const draft = ref('');
watch(() => mine.value?.request_text, (t) => { draft.value = t || ''; }, { immediate: true });
const dirty = computed(() => draft.value.trim() !== (mine.value?.request_text || ''));

const busy = ref(false);
const error = ref('');
async function run(fn, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  error.value = '';
  busy.value = true;
  try {
    const next = await fn();
    // In a runoff the response is the parent round's state; the page only
    // needs the refreshed list, so splice that into the runoff's state.
    emit('update', next.round.id === props.state.round.id ? next : { ...props.state, requests: next.requests });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
const base = computed(() => `/lunch/rounds/${requestRoundId.value}`);
const save = () => run(() => api.put(`${base.value}/request`, { text: draft.value }));
const removeMine = () => run(() => api.del(`${base.value}/request`), 'Remove your request?');
const removeOther = (r) => run(() => api.del(`${base.value}/requests/${r.id}`), `Remove the request “${r.request_text}”?`);
</script>

<template>
  <div v-if="editable || requests.length" class="lunch-requests">
    <h3>Requests</h3>
    <p v-if="editable" class="muted small" style="margin-top: 0">
      Before anyone suggests a place: anything people should keep in mind, like “no Mexican this week” or “somewhere
      with vegetarian options”. One each, and anonymous.
    </p>
    <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>

    <form v-if="editable" class="row nowrap" style="margin-bottom: 10px" @submit.prevent="save">
      <input v-model="draft" maxlength="200" placeholder="Your request…" autocomplete="off" />
      <button class="small primary" type="submit" :disabled="busy || !draft.trim() || !dirty">
        {{ mine ? 'Update' : 'Add' }}
      </button>
      <button v-if="mine" class="small" type="button" :disabled="busy" @click="removeMine">Remove</button>
    </form>

    <div v-if="!requests.length" class="muted small">No requests yet.</div>
    <ul v-else class="lunch-request-list">
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
