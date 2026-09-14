<script setup>
/**
 * "+ New" -- the consolidated New Ticket / New Task / Parts & Supplies
 * page that replaced the Dashboard's separate "New ticket" and "New
 * ephemeral task" buttons, plus the standalone /parts page (PartsView.vue,
 * removed). See NOTES.md.
 *
 * Three folder-style tabs (styles.css's .folder-tab*), New Ticket first
 * since that's the by-far-most-common reason someone lands here. The
 * active tab lives in the URL (?tab=), not just component state, so
 * App.vue's "Parts / Supplies" nav link and the old /tickets/new redirect
 * can point straight at a specific tab -- and so a reload or a shared
 * link keeps whichever tab was open, rather than always bouncing back to
 * New Ticket.
 *
 * Each tab's content is its own component (NewTicketForm.vue,
 * NewTaskPanel.vue, PartsOrdersPanel.vue) switched with v-if -- not
 * v-show -- so switching tabs is a clean remount rather than something
 * half-filled-out from a previous visit lingering in the background.
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import NewTicketForm from '../components/NewTicketForm.vue';
import NewTaskPanel from '../components/NewTaskPanel.vue';
import PartsOrdersPanel from '../components/PartsOrdersPanel.vue';

const route = useRoute();
const router = useRouter();

const TABS = [
  { key: 'ticket', label: 'New Ticket' },
  { key: 'task', label: 'New Task' },
  { key: 'parts', label: 'Parts / Supplies' },
];

const activeTab = computed(() => {
  const requested = String(route.query.tab || 'ticket');
  return TABS.some((t) => t.key === requested) ? requested : 'ticket';
});

function selectTab(key) {
  if (key === activeTab.value) return;
  router.push({ path: '/new', query: { ...route.query, tab: key } });
}
</script>

<template>
  <div class="page" style="max-width: 900px">
    <div class="page-head">
      <h1>+ New</h1>
    </div>

    <div class="folder-tabs">
      <button
        v-for="t in TABS" :key="t.key" type="button"
        class="folder-tab" :class="{ active: activeTab === t.key }"
        @click="selectTab(t.key)"
      >{{ t.label }}</button>
    </div>
    <div class="folder-tab-panel">
      <NewTicketForm v-if="activeTab === 'ticket'" />
      <NewTaskPanel v-else-if="activeTab === 'task'" />
      <PartsOrdersPanel v-else :allow-create="true" />
    </div>
  </div>
</template>
