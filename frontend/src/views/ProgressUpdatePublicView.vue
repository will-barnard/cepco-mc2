<script setup>
/**
 * Public, unauthenticated progress update page — what the "View full
 * progress update" email link opens
 * (backend/src/templates/progressUpdateEmail.js). "I've seen this" is a
 * real button click, deliberately not something that fires from the link
 * itself landing on this page — see backend/src/routes/publicProgressUpdates.js
 * for why (mail scanners/clients prefetching links). Looked up by the
 * random confirm_token in the URL, never by a numeric id.
 *
 * Reached via either the canonical /progress-update/:token route or the
 * legacy /status-report/:token alias kept for already-emailed links
 * (router.js, migration 046) — same component either way.
 */
import { ref, onMounted } from 'vue';
import api from '../api';

const props = defineProps({ token: { type: String, required: true } });

const update = ref(null);
const loading = ref(true);
const error = ref('');
const acking = ref(false);
const acked = ref(false);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    update.value = await api.get(`/public/progress-updates/${props.token}`);
    acked.value = !!update.value.viewed_at;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const photoUrl = (attachmentId) => `/api/public/progress-updates/${props.token}/attachments/${attachmentId}`;

async function acknowledge() {
  acking.value = true;
  try {
    await api.post(`/public/progress-updates/${props.token}/acknowledge`);
    acked.value = true;
  } catch (err) {
    error.value = err.message;
  } finally {
    acking.value = false;
  }
}
</script>

<template>
  <div style="max-width: 640px; margin: 40px auto; padding: 0 16px">
    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="error && !update" class="card">
      <p class="alert">{{ error }}</p>
    </div>
    <div v-else-if="update" class="card">
      <h1 style="margin-bottom: 4px">{{ update.ticket_title }}</h1>
      <p class="muted small" style="margin: 0 0 20px">
        Chicago Electric Piano Company — for {{ update.customer_name }}
        <span v-if="update.instrument_family">
          · {{ [update.instrument_family, update.instrument_model].filter(Boolean).join(' ') }}
        </span>
      </p>

      <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

      <div class="row" style="margin-bottom: 18px">
        <span class="pill blue">{{ update.ticket_status_label }}</span>
      </div>

      <p v-if="update.summary" style="font-size: 15px; line-height: 1.6; white-space: pre-line; margin: 0 0 20px">
        {{ update.summary }}
      </p>

      <div v-if="update.service_done_notes" class="field">
        <label class="small muted">Done so far</label>
        <p style="margin: 0; white-space: pre-line">{{ update.service_done_notes }}</p>
      </div>
      <div v-if="update.service_needed_notes" class="field">
        <label class="small muted">Still ahead</label>
        <p style="margin: 0; white-space: pre-line">{{ update.service_needed_notes }}</p>
      </div>

      <div v-if="update.attachments.length" class="field">
        <label class="small muted">Photos</label>
        <div class="gallery">
          <figure v-for="a in update.attachments" :key="a.id">
            <a :href="photoUrl(a.id)" target="_blank" rel="noopener">
              <img :src="photoUrl(a.id)" :alt="a.caption || 'Photo'" loading="lazy" />
            </a>
            <figcaption v-if="a.caption">{{ a.caption }}</figcaption>
          </figure>
        </div>
      </div>

      <div style="text-align: center; margin-top: 24px">
        <button v-if="!acked" class="primary" :disabled="acking" @click="acknowledge">
          {{ acking ? 'Working…' : "I've seen this" }}
        </button>
        <p v-else class="muted small">Thanks — marked as seen.</p>
      </div>
    </div>
  </div>
</template>
