<script setup>
/**
 * The three review buttons used next to every QC checklist item and every
 * completed task: a checkbox for pass, an X for fail, and a "/" for N/A.
 * Purely presentational — it reports which button was pressed and the parent
 * decides what that means. Pressing the button that's already active
 * clears the mark (the parent turns "same as current" into null), which is
 * what makes a mark changeable after it's been set.
 */
defineProps({
  status: { type: String, default: null }, // 'pass' | 'fail' | 'na' | null
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' }, // what's being marked, for screen readers
});
defineEmits(['pick']);

const MARKS = [
  { key: 'pass', glyph: '✓', title: 'Pass' },
  { key: 'fail', glyph: '✕', title: 'Fail' },
  { key: 'na', glyph: '/', title: 'Not applicable' },
];
</script>

<template>
  <span class="qc-marks" role="group" :aria-label="`Review: ${label}`">
    <button
      v-for="m in MARKS" :key="m.key" type="button"
      :class="['qc-mark', m.key, { on: status === m.key }]"
      :aria-pressed="status === m.key" :title="status === m.key ? `${m.title} (tap to clear)` : m.title"
      :disabled="disabled" @click="$emit('pick', m.key)"
    >{{ m.glyph }}</button>
  </span>
</template>

<style scoped>
.qc-marks { display: inline-flex; gap: 4px; flex: none; }
/* Square boxes, big enough to hit with a thumb next to an open piano. The
   global button rule's padding/min-height are reset so the glyph centres. */
.qc-mark {
  width: 34px; height: 34px; min-height: 0; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 700; line-height: 1;
  background: transparent; color: var(--text-dim);
  border: 1.5px solid var(--border); border-radius: 6px;
}
.qc-mark:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.qc-mark:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.qc-mark.on.pass { background: var(--green); border-color: var(--green); color: #0b1f17; }
.qc-mark.on.fail { background: var(--red); border-color: var(--red); color: #2a0b0b; }
.qc-mark.on.na   { background: var(--slate); border-color: var(--slate); color: #f3f4f6; }
/* A signed-off round is read-only: keep the recorded marks fully visible and
   fade only the buttons that weren't chosen. */
.qc-mark:disabled { cursor: default; }
.qc-mark:disabled:not(.on) { opacity: 0.3; }
.qc-mark:disabled.on { opacity: 1; }
</style>
