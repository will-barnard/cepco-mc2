<script setup>
/**
 * Ticket photo gallery + upload (PLAN §10).
 *
 * Works against either storage driver. When the backend reports direct upload
 * (GCS), the file goes browser -> bucket via a signed PUT and only the metadata
 * comes back through the API. Otherwise it posts multipart to the API.
 *
 * `capture="environment"` on the file input is what makes a phone open the
 * camera straight away instead of the photo library.
 */
import { ref, onMounted } from 'vue';
import api from '../api';

const props = defineProps({ ticketId: { type: [String, Number], required: true } });

const attachments = ref([]);
const urls = ref({});
const caps = ref(null);
const caption = ref('');
const uploading = ref(false);
const progress = ref('');
const error = ref('');
const fileInput = ref(null);

async function loadUrls(list) {
  await Promise.all(list.map(async (a) => {
    try {
      const { url } = await api.get(`/attachments/${a.id}/url`);
      urls.value[a.id] = url;
    } catch { /* thumbnail just stays blank */ }
  }));
}

async function load() {
  attachments.value = await api.get(`/attachments/ticket/${props.ticketId}`);
  await loadUrls(attachments.value);
}

onMounted(async () => {
  caps.value = await api.get('/attachments/capabilities');
  await load();
});

async function uploadDirect(file) {
  const target = await api.post('/attachments/upload-url', {
    ticket_id: props.ticketId,
    file_name: file.name,
    content_type: file.type,
  });
  const res = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: file,
  });
  if (!res.ok) throw new Error(`Upload to storage failed (${res.status})`);

  await api.post('/attachments/confirm', {
    ticket_id: props.ticketId,
    storage_key: target.storage_key,
    file_name: file.name,
    content_type: file.type,
    size_bytes: file.size,
    caption: caption.value || null,
  });
}

async function uploadViaApi(files) {
  const body = new FormData();
  body.append('ticket_id', props.ticketId);
  if (caption.value) body.append('caption', caption.value);
  for (const f of files) body.append('files', f);
  await api.post('/attachments', body);
}

async function onFiles(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  error.value = '';
  uploading.value = true;
  try {
    if (caps.value?.direct_upload) {
      for (let i = 0; i < files.length; i += 1) {
        progress.value = `Uploading ${i + 1} of ${files.length}…`;
        // Sequential: a phone on shop wifi handles one large image at a time
        // far more reliably than several in parallel.
        // eslint-disable-next-line no-await-in-loop
        await uploadDirect(files[i]);
      }
    } else {
      progress.value = `Uploading ${files.length} file(s)…`;
      await uploadViaApi(files);
    }
    caption.value = '';
    if (fileInput.value) fileInput.value.value = '';
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    uploading.value = false;
    progress.value = '';
  }
}

async function remove(a) {
  if (!confirm('Delete this photo?')) return;
  try {
    await api.del(`/attachments/${a.id}`);
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

const when = (ts) => new Date(ts).toLocaleString();
</script>

<template>
  <div class="card">
    <h2>Photos</h2>

    <div class="field">
      <label>Caption (applies to this upload)</label>
      <input v-model="caption" placeholder="e.g. hammer tips before" />
    </div>

    <div class="field">
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        :disabled="uploading"
        @change="onFiles"
      />
      <p class="muted small" style="margin: 6px 0 0">
        Camera or library, multiple at once.
        <span v-if="caps">Stored via {{ caps.driver }}.</span>
      </p>
    </div>

    <div v-if="progress" class="muted small">{{ progress }}</div>
    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>

    <div v-if="!attachments.length" class="empty">No photos on this ticket yet.</div>

    <div v-else class="gallery">
      <figure v-for="a in attachments" :key="a.id">
        <a :href="urls[a.id]" target="_blank" rel="noopener">
          <img :src="urls[a.id]" :alt="a.caption || a.file_name" loading="lazy" />
        </a>
        <figcaption>
          <div v-if="a.caption">{{ a.caption }}</div>
          <div>{{ a.uploader_name || 'Unknown' }} · {{ when(a.uploaded_at) }}</div>
          <button class="link" @click="remove(a)">Delete</button>
        </figcaption>
      </figure>
    </div>
  </div>
</template>
