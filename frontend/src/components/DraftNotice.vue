<script setup>
/**
 * "Restored your unsaved draft" banner for a form using useDraft()
 * (drafts.js). Renders nothing unless that draft actually restored
 * something, so it can sit permanently above any form.
 */
import { computed } from 'vue';

const props = defineProps({
  draft: { type: Object, required: true },
});

const when = computed(() => {
  const at = props.draft.restoredAt.value;
  if (!at) return '';
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
});
</script>

<template>
  <div v-if="draft.restoredAt.value" class="draft-notice small">
    <span>Restored your unsaved draft from {{ when }}.</span>
    <button type="button" class="link small" @click="draft.discard()">Discard</button>
  </div>
</template>

<style scoped>
.draft-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  background: var(--surface-2);
}
</style>
