<script setup>
/**
 * A ticket's priority as lightning bolts, the way mail apps show importance
 * with "!" -- the Queue's priority column (shop feedback, Nov 2026). The
 * lowest active priority tier is one bolt, the highest is as many bolts as
 * there are active tiers (stores.js's priorityBolts), so adding a tier in
 * Settings -> Priority tiers rescales the column on its own.
 *
 * Inline SVG rather than the ⚡ emoji: the emoji renders as a full-colour
 * glyph that differs per platform (and per kiosk iPad), and can't take the
 * theme colour.
 */
import { computed } from 'vue';
import { useSettings } from '../stores';

const props = defineProps({
  priorityKey: { type: String, default: null },
  label: { type: String, default: '' },
});

const settings = useSettings();
const count = computed(() => (props.priorityKey ? settings.priorityBolts(props.priorityKey) : 0));
const max = computed(() => settings.priorityBoltMax);
// Most urgent tier gets the louder colour, so a column of them scans fast.
const top = computed(() => count.value > 0 && count.value >= max.value && max.value > 1);
const description = computed(() => (count.value
  ? `Priority: ${props.label || props.priorityKey} (${count.value} of ${Math.max(max.value, count.value)})`
  : 'No priority'));
</script>

<template>
  <span
    v-if="count" :class="['priority-bolts', { top }]" role="img"
    :aria-label="description" :title="description"
  >
    <svg v-for="i in count" :key="i" viewBox="0 0 10 16" aria-hidden="true">
      <path d="M6.5 0 0 9h4l-1 7 7-10H6l.5-6z" />
    </svg>
  </span>
</template>

<style scoped>
.priority-bolts { display: inline-flex; gap: 1px; color: var(--amber); vertical-align: middle; line-height: 1; }
.priority-bolts.top { color: var(--red); }
.priority-bolts svg { width: 9px; height: 14px; fill: currentColor; flex: none; }
</style>
