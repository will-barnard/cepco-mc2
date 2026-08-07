<script setup>
/**
 * Ticket photos (PLAN §10) — built to be the least annoying part of the app.
 *
 * Design decisions, all in service of "as easy to use as possible":
 *   - Photos upload the moment they're chosen. No separate submit button to
 *     forget, no modal.
 *   - Every input route works: camera, photo library, drag & drop, and paste.
 *   - Files are normalised in the browser first (see imagePipeline.js) so HEIC
 *     from an iPhone Just Works and a 5 MB photo becomes ~400 KB.
 *   - Uploads are optimistic: the thumbnail appears immediately from a local
 *     object URL, with progress on top of it.
 *   - Captions are optional and edited inline afterwards, so nothing blocks
 *     the upload itself.
 *   - A failed upload keeps its file in the queue and offers Retry rather than
 *     making someone re-pick it.
 */
import {
  ref, computed, onMounted, onBeforeUnmount,
} from 'vue';
import api from '../api';
import { prepareImage, isProbablyImage, formatBytes } from '../imagePipeline';

const props = defineProps({ ticketId: { type: [String, Number], required: true } });

const attachments = ref([]);
const urls = ref({});
const caps = ref(null);
const error = ref('');
const dragging = ref(false);
const fileInput = ref(null);
const cameraInput = ref(null);
const dropZone = ref(null);

// In-flight uploads, newest first. Each: { id, name, previewUrl, status,
// message, bytesBefore, bytesAfter, file }
const queue = ref([]);
let queueId = 0;

const busy = computed(() => queue.value.some((q) => q.status === 'preparing' || q.status === 'uploading'));
const savedBytes = computed(() => queue.value
  .filter((q) => q.status === 'done')
  .reduce((sum, q) => sum + Math.max(0, (q.bytesBefore || 0) - (q.bytesAfter || 0)), 0));

// --- loading ---------------------------------------------------------------
async function loadUrls(list) {
  await Promise.all(list.map(async (a) => {
    if (urls.value[a.id]) return;
    try {
      const { url } = await api.get(`/attachments/${a.id}/url`);
      urls.value[a.id] = url;
    } catch { /* leave the tile blank rather than break the gallery */ }
  }));
}

async function load() {
  attachments.value = await api.get(`/attachments/ticket/${props.ticketId}`);
  await loadUrls(attachments.value);
}

// --- uploading -------------------------------------------------------------
async function uploadDirect(prepared) {
  const target = await api.post('/attachments/upload-url', {
    ticket_id: props.ticketId,
    file_name: prepared.name,
    content_type: prepared.type,
  });
  const res = await fetch(target.url, {
    method: target.method, headers: target.headers, body: prepared.blob,
  });
  if (!res.ok) throw new Error(`Storage rejected the upload (${res.status})`);

  return api.post('/attachments/confirm', {
    ticket_id: props.ticketId,
    storage_key: target.storage_key,
    file_name: prepared.name,
    content_type: prepared.type,
    size_bytes: prepared.blob.size,
  });
}

async function uploadViaApi(prepared) {
  const body = new FormData();
  body.append('ticket_id', String(props.ticketId));
  body.append('files', prepared.blob, prepared.name);
  const created = await api.post('/attachments', body);
  return Array.isArray(created) ? created[0] : created;
}

async function processItem(item) {
  try {
    item.status = 'preparing';
    item.message = '';
    const prepared = await prepareImage(item.file);

    item.bytesBefore = prepared.originalBytes;
    item.bytesAfter = prepared.finalBytes;
    item.status = 'uploading';

    // Swap the preview to the prepared blob — for HEIC this is the first
    // moment a thumbnail can actually render.
    if (prepared.converted) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      item.previewUrl = URL.createObjectURL(prepared.blob);
    }

    if (caps.value?.direct_upload) await uploadDirect(prepared);
    else await uploadViaApi(prepared);

    item.status = 'done';
    await load();

    // Leave the finished tile up briefly so the size saving is visible, then
    // let the real gallery entry take over.
    setTimeout(() => {
      const idx = queue.value.findIndex((q) => q.id === item.id);
      if (idx !== -1) {
        if (queue.value[idx].previewUrl) URL.revokeObjectURL(queue.value[idx].previewUrl);
        queue.value.splice(idx, 1);
      }
    }, 2500);
  } catch (err) {
    item.status = 'error';
    item.message = err.message;
  }
}

/**
 * Sequential on purpose: a phone on shop wifi finishes ten photos one at a
 * time far more reliably than ten at once, and the per-file progress stays
 * honest.
 */
async function addFiles(fileList) {
  error.value = '';
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const rejected = files.filter((f) => !isProbablyImage(f));
  if (rejected.length) {
    error.value = `Skipped ${rejected.length} non-image file(s): `
      + `${rejected.map((f) => f.name).join(', ')}`;
  }

  const items = files.filter(isProbablyImage).map((file) => ({
    id: (queueId += 1),
    name: file.name || 'photo',
    file,
    previewUrl: URL.createObjectURL(file),
    status: 'queued',
    message: '',
    bytesBefore: file.size,
    bytesAfter: null,
  }));

  queue.value.unshift(...items);
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    await processItem(item);
  }
}

const retry = (item) => processItem(item);

function dismiss(item) {
  const idx = queue.value.findIndex((q) => q.id === item.id);
  if (idx !== -1) {
    if (queue.value[idx].previewUrl) URL.revokeObjectURL(queue.value[idx].previewUrl);
    queue.value.splice(idx, 1);
  }
}

// --- input routes ----------------------------------------------------------
function onPicked(event) {
  addFiles(event.target.files);
  event.target.value = ''; // let the same file be picked again
}

function onDrop(event) {
  dragging.value = false;
  addFiles(event.dataTransfer?.files);
}

function onPaste(event) {
  const files = Array.from(event.clipboardData?.files || []);
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
}

onMounted(async () => {
  caps.value = await api.get('/attachments/capabilities');
  await load();
  window.addEventListener('paste', onPaste);
});

onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste);
  queue.value.forEach((q) => q.previewUrl && URL.revokeObjectURL(q.previewUrl));
});

// --- gallery actions -------------------------------------------------------
async function saveCaption(attachment, value) {
  if (value === (attachment.caption || '')) return;
  try {
    await api.patch(`/attachments/${attachment.id}`, { caption: value });
    attachment.caption = value;
  } catch (err) {
    error.value = err.message;
  }
}

async function remove(attachment) {
  if (!confirm('Delete this photo?')) return;
  try {
    await api.del(`/attachments/${attachment.id}`);
    delete urls.value[attachment.id];
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

const when = (ts) => new Date(ts).toLocaleString();
const statusLabel = {
  queued: 'Waiting', preparing: 'Preparing', uploading: 'Uploading',
  done: 'Uploaded', error: 'Failed',
};
</script>

<template>
  <div class="card">
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">Photos</h2>
      <div class="spacer" />
      <span v-if="attachments.length" class="muted small">{{ attachments.length }}</span>
    </div>

    <!-- Drop zone doubles as the whole upload UI -->
    <div
      ref="dropZone"
      :class="['dropzone', { dragging }]"
      @dragover.prevent="dragging = true"
      @dragenter.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="row" style="justify-content: center">
        <button class="primary" type="button" :disabled="busy" @click="cameraInput.click()">
          Take photo
        </button>
        <button type="button" :disabled="busy" @click="fileInput.click()">
          Choose photos
        </button>
      </div>
      <p class="muted small" style="margin: 10px 0 0">
        Or drag photos here, or paste from the clipboard.
        <br />
        iPhone HEIC photos are converted automatically — they upload and display fine.
      </p>

      <!-- capture=environment makes a phone open the rear camera directly -->
      <input
        ref="cameraInput" type="file" accept="image/*,.heic,.heif"
        capture="environment" multiple class="visually-hidden" @change="onPicked"
      />
      <input
        ref="fileInput" type="file" accept="image/*,.heic,.heif"
        multiple class="visually-hidden" @change="onPicked"
      />
    </div>

    <div v-if="error" class="alert" style="margin-top: 12px">{{ error }}</div>

    <p v-if="savedBytes > 0" class="muted small" style="margin: 10px 0 0">
      Shrunk by {{ formatBytes(savedBytes) }} before upload.
    </p>

    <!-- In-flight uploads -->
    <div v-if="queue.length" class="gallery" style="margin-top: 14px">
      <figure v-for="item in queue" :key="item.id" :class="['upload-tile', item.status]">
        <img :src="item.previewUrl" :alt="item.name" />
        <figcaption>
          <div class="row" style="gap: 6px">
            <span :class="['pill', item.status === 'error' ? 'red'
              : (item.status === 'done' ? 'green' : 'blue')]">
              {{ statusLabel[item.status] }}
            </span>
          </div>
          <div class="truncate">{{ item.name }}</div>
          <div v-if="item.status === 'done' && item.bytesAfter" class="muted">
            {{ formatBytes(item.bytesBefore) }} → {{ formatBytes(item.bytesAfter) }}
          </div>
          <div v-if="item.message" class="upload-error">{{ item.message }}</div>
          <div v-if="item.status === 'error'" class="row" style="gap: 6px">
            <button class="link" @click="retry(item)">Retry</button>
            <button class="link" @click="dismiss(item)">Dismiss</button>
          </div>
        </figcaption>
      </figure>
    </div>

    <!-- Uploaded -->
    <div v-if="!attachments.length && !queue.length" class="empty">
      No photos on this ticket yet.
    </div>

    <div v-else-if="attachments.length" class="gallery" style="margin-top: 14px">
      <figure v-for="a in attachments" :key="a.id">
        <a :href="urls[a.id]" target="_blank" rel="noopener">
          <img :src="urls[a.id]" :alt="a.caption || a.file_name" loading="lazy" />
        </a>
        <figcaption>
          <input
            class="caption-input" :value="a.caption" placeholder="Add a caption…"
            @change="saveCaption(a, $event.target.value)"
          />
          <div class="muted">{{ a.uploader_name || 'Unknown' }} · {{ when(a.uploaded_at) }}</div>
          <button class="link" @click="remove(a)">Delete</button>
        </figcaption>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.dropzone {
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  padding: 20px 16px;
  text-align: center;
  transition: border-color 0.15s, background 0.15s;
}
.dropzone.dragging {
  border-color: var(--accent);
  background: rgba(212, 129, 63, 0.08);
}

.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.upload-tile img { opacity: 0.55; }
.upload-tile.done img { opacity: 1; }
.upload-tile.error img { opacity: 0.3; }

.upload-error { color: var(--red); font-size: 12px; }

.caption-input {
  min-height: 32px;
  padding: 4px 7px;
  font-size: 12px;
  margin-bottom: 3px;
}

.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
