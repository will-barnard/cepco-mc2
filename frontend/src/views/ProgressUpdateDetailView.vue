<script setup>
/**
 * Progress update detail — staff side. Mirrors EstimateDetailView.vue's
 * shape (load, edit, act), but the two actions here are "Update from
 * ticket" (re-pull service notes + photos — routes/progressUpdates.js POST
 * /:id/refresh, never touches summary) and "Send/Re-send to customer"
 * (POST /:id/send), rather than a status-machine of confirm/decline. The
 * summary and the pulled notes stay editable here at any time, sent or
 * not — see NOTES.md.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const props = defineProps({ id: { type: String, required: true } });

const update = ref(null);
const urls = ref({});
const loading = ref(true);
const error = ref('');
const notice = ref('');
const summaryDraft = ref('');
const serviceDoneDraft = ref('');
const serviceNeededDraft = ref('');
const savingDraft = ref(false);
const refreshing = ref(false);
const sending = ref(false);

async function loadPhotoUrls(attachments) {
  await Promise.all(attachments.map(async (a) => {
    if (urls.value[a.id]) return;
    try {
      const { url } = await api.get(`/attachments/${a.id}/url`);
      urls.value[a.id] = url;
    } catch { /* leave the tile blank rather than break the page */ }
  }));
}

async function load() {
  loading.value = true;
  try {
    update.value = await api.get(`/progress-updates/${props.id}`);
    summaryDraft.value = update.value.summary || '';
    serviceDoneDraft.value = update.value.service_done_notes || '';
    serviceNeededDraft.value = update.value.service_needed_notes || '';
    await loadPhotoUrls(update.value.attachments);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function saveDraft() {
  savingDraft.value = true;
  error.value = '';
  try {
    update.value = { ...update.value, ...await api.patch(`/progress-updates/${props.id}`, {
      summary: summaryDraft.value,
      service_done_notes: serviceDoneDraft.value,
      service_needed_notes: serviceNeededDraft.value,
    }) };
    notice.value = 'Saved.';
  } catch (err) {
    error.value = err.message;
  } finally {
    savingDraft.value = false;
  }
}

async function refreshFromTicket() {
  if (!confirm(
    "Pull the ticket's current status notes and photos into this update? "
    + "The summary above is left as-is.",
  )) return;
  refreshing.value = true;
  error.value = ''; notice.value = '';
  try {
    update.value = await api.post(`/progress-updates/${props.id}/refresh`);
    serviceDoneDraft.value = update.value.service_done_notes || '';
    serviceNeededDraft.value = update.value.service_needed_notes || '';
    await loadPhotoUrls(update.value.attachments);
    notice.value = 'Updated from the ticket.';
  } catch (err) {
    error.value = err.message;
  } finally {
    refreshing.value = false;
  }
}

async function sendToCustomer() {
  sending.value = true;
  error.value = ''; notice.value = '';
  try {
    update.value = await api.post(`/progress-updates/${props.id}/send`);
    notice.value = `Progress update emailed to the customer.`;
  } catch (err) {
    error.value = err.message;
  } finally {
    sending.value = false;
  }
}

const when = (ts) => (ts ? new Date(ts).toLocaleString() : null);
</script>

<template>
  <div v-if="loading" class="page"><div class="empty">Loading…</div></div>
  <div v-else-if="update" class="page" style="max-width: 820px">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">
          <RouterLink :to="{ name: 'ticket', params: { id: update.ticket_id } }">
            {{ update.ticket_title }}
          </RouterLink>
        </h1>
        <p class="muted small" style="margin: 0">
          {{ update.customer_name || 'No customer on file' }}
          <span v-if="update.customer_email">· {{ update.customer_email }}</span>
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'progress-updates' }">← Progress updates</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="card" style="margin-bottom: 16px">
      <div class="row" style="margin-bottom: 14px">
        <span :class="['pill', update.status === 'sent' ? 'green' : 'slate']">{{ update.status }}</span>
        <span class="muted small">Current ticket status: {{ update.ticket_status_label }}</span>
        <span v-if="when(update.refreshed_at)" class="muted small">
          · Pulled from ticket {{ when(update.refreshed_at) }}
        </span>
        <span v-if="when(update.sent_at)" class="muted small">· Sent {{ when(update.sent_at) }}</span>
        <span v-if="when(update.viewed_at)" class="muted small">· Viewed {{ when(update.viewed_at) }}</span>
      </div>

      <div class="field">
        <label>Summary</label>
        <textarea v-model="summaryDraft" style="min-height: 90px" placeholder="What should the customer know?" />
      </div>

      <div class="field-row">
        <div class="field">
          <label class="small muted">Service done</label>
          <textarea v-model="serviceDoneDraft" style="min-height: 100px" />
        </div>
        <div class="field">
          <label class="small muted">Service needed</label>
          <textarea v-model="serviceNeededDraft" style="min-height: 100px" />
        </div>
      </div>
      <button class="small" :disabled="savingDraft" @click="saveDraft">
        {{ savingDraft ? 'Saving…' : 'Save changes' }}
      </button>
      <p class="muted small" style="margin: 8px 0 0">
        Editing here only changes this update — it never writes back to the ticket.
      </p>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <div class="row" style="margin-bottom: 12px">
        <h2 style="margin: 0">Photos on this update</h2>
        <div class="spacer" />
        <span class="muted small">{{ update.attachments.length }}</span>
      </div>
      <div v-if="!update.attachments.length" class="empty">
        No photos were on the ticket when this update was last pulled.
      </div>
      <div v-else class="gallery">
        <figure v-for="a in update.attachments" :key="a.id">
          <a :href="urls[a.id]" target="_blank" rel="noopener">
            <img :src="urls[a.id]" :alt="a.caption || a.file_name" loading="lazy" />
          </a>
          <figcaption>{{ a.caption || a.file_name }}</figcaption>
        </figure>
      </div>
    </div>

    <div class="card">
      <div class="row">
        <button :disabled="refreshing" @click="refreshFromTicket">
          {{ refreshing ? 'Updating…' : 'Update from ticket' }}
        </button>
        <button class="primary" :disabled="sending" @click="sendToCustomer">
          {{ sending ? 'Sending…' : (update.sent_at ? 'Re-send to customer' : 'Send to customer') }}
        </button>
      </div>
      <p v-if="update.public_url" class="muted small" style="margin: 12px 0 0">
        Public link: <a :href="update.public_url" target="_blank" rel="noopener">{{ update.public_url }}</a>
      </p>
    </div>
  </div>
</template>
