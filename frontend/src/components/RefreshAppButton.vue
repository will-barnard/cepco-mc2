<script setup>
/**
 * "Refresh app" button -- see appRefresh.js for what it actually does and why
 * a plain reload isn't enough on an iOS Home Screen app. `compact` is the small
 * button for the Settings header; the Account page uses the full-size one.
 */
import { ref } from 'vue';
import { hardRefresh, builtLabel } from '../appRefresh';

defineProps({ compact: { type: Boolean, default: false } });

const busy = ref(false);
async function refreshNow() {
  busy.value = true;
  await hardRefresh(); // navigates away; busy stays on until the page reloads
}
const built = builtLabel();
const tip = built
  ? `Clears the cached copy on this device and reloads. This copy was built ${built}.`
  : 'Clears the cached copy on this device and reloads.';
</script>

<template>
  <button
    type="button" :class="{ small: compact }" :disabled="busy"
    :title="tip"
    @click="refreshNow"
  >
    {{ busy ? 'Refreshing…' : '↻ Refresh app' }}
  </button>
</template>
