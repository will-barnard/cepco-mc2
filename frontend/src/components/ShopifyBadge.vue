<script setup>
/**
 * Small "came from a Shopify order" marker shown before a ticket's title
 * (queue, ticket lists, dashboard, customer page, ticket detail). Tickets
 * get one when services/shopifyOrders.js created them — i.e. they have a
 * shopify_order_id; `orderName` is the "#1001" stored in ticket_name.
 *
 * The icon is a plain shopping-bag glyph. To show Shopify's own mark
 * instead, download the logo from Shopify's brand assets page and save it
 * as src/assets/shopify-logo.svg — the glob below picks it up at build time
 * and uses it automatically; with no file there, it resolves to nothing and
 * the glyph is used.
 */
import { computed } from 'vue';

const official = Object.values(
  import.meta.glob('../assets/shopify-logo.svg', { eager: true, query: '?url', import: 'default' }),
)[0] || null;

const props = defineProps({
  orderName: { type: String, default: '' },
  // When set (ticket detail page), the badge links to the order in Shopify.
  href: { type: String, default: '' },
  size: { type: Number, default: 14 },
});

const label = computed(() => `Imported from Shopify${props.orderName ? ` order ${props.orderName}` : ''}`);
</script>

<template>
  <component
    :is="href ? 'a' : 'span'" class="shopify-badge"
    :href="href || undefined" :target="href ? '_blank' : undefined" :rel="href ? 'noopener' : undefined"
    :title="label" :aria-label="label" @click="href && $event.stopPropagation()"
  >
    <img v-if="official" :src="official" :width="size" :height="size" alt="" />
    <svg
      v-else :width="size" :height="size" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    >
      <path d="M3 5.5h10l-.8 8.5H3.8z" />
      <path d="M5.8 5.5V4.3a2.2 2.2 0 0 1 4.4 0v1.2" />
    </svg>
  </component>
</template>

<style scoped>
.shopify-badge {
  display: inline-flex; align-items: center; vertical-align: -2px;
  margin-right: 6px; color: var(--green); line-height: 0;
}
a.shopify-badge:hover { opacity: 0.8; }
</style>
