<script setup>
/**
 * Status report detail — staff side. Mirrors EstimateDetailView.vue's
 * shape (load, edit, act), but the two actions here are "Update from
 * ticket" (re-pull service notes + photos — routes/statusReports.js POST
 * /:id/refresh, never touches summary) and "Send/Re-send to customer"
 * (POST /:id/send), rather than a status-machine of confirm/decline. The
 * summary and the pulled notes stay editable here at any time, sent or
 * not — see NOTES.md.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const props = defineProps({ id: { type: String, required: true } });

const report = ref(null);
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
    report.value = await api.get(`/status-reports/${props.id}`);
    summaryDraft.value = report.value.summary || '';
    serviceDoneDraft.value = report.value.service_done_notes || '';
    serviceNeededDraft.value = report.value.service_needed_notes || '';
    await loadPhotoUrls(report.value.attachments);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function saveDraft() {
  savingDraft.value = true;
  error.value = '';
  try {
    report.value = { ...report.value, ...await api.patch(`/status-reports/${props.id}`, {
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
    "Pull the ticket's current status notes and photos into this report? "
    + "The summary above is left as-is.",
  )) return;
  refreshing.value = true;
  error.value = ''; notice.value = '';
  try {
    report.value = await api.post(`/status-reports/${props.id}/refresh`);
    serviceDoneDraft.value = report.value.service_done_notes || '';
    serviceNeededDraft.value = report.value.service_needed_notes || '';
    await loadPhotoUrls(report.value.attachments);
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
    report.value = await api.post(`/status-reports/${props.id}/send`);
    notice.value = `Status report emailed to the customer.`;
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
  <div v-else-if="report" class="page" style="max-width: 820px">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">
          <RouterLink :to="{ name: 'ticket', params: { id: report.ticket_id } }">
            {{ report.ticket_title }}
          </RouterLink>
        </h1>
        <p class="muted small" style="margin: 0">
          {{ report.customer_name || 'No customer on file' }}
          <span v-if="report.customer_email">· {{ report.customer_email }}</span>
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'status-reports' }">← Status reports</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="card" style="margin-bottom: 16px">
      <div class="row" style="margin-bottom: 14px">
        <span :class="['pill', report.status === 'sent' ? 'green' : 'slate']">{{ report.status }}</span>
        <span class="muted small">Current ticket status: {{ report.ticket_status_label }}</span>
        <span v-if="when(report.refreshed_at)" class="muted small">
          · Pulled from ticket {{ when(report.refreshed_at) }}
        </span>
        <span v-if="when(report.sent_at)" class="muted small">· Sent {{ when(report.sent_at) }}</span>
        <span v-if="when(report.viewed_at)" class="muted small">· Viewed {{ when(report.viewed_at) }}</span>
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
        Editing here only changes this report — it never writes back to the ticket.
      </p>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <div class="row" style="margin-bottom: 12px">
        <h2 style="margin: 0">Photos on this report</h2>
        <div class="spacer" />
        <span class="muted small">{{ report.attachments.length }}</span>
      </div>
      <div v-if="!report.attachments.length" class="empty">
        No photos were on the ticket when this report was last pulled.
      </div>
      <div v-else class="gallery">
        <figure v-for="a in report.attachments" :key="a.id">
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
          {{ sending ? 'Sending…' : (report.sent_at ? 'Re-send to customer' : 'Send to customer') }}
        </button>
      </div>
      <p v-if="report.public_url" class="muted small" style="margin: 12px 0 0">
        Public link: <a :href="report.public_url" target="_blank" rel="noopener">{{ report.public_url }}</a>
      </p>
    </div>
  </div>
</template>
