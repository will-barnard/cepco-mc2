<script setup>
/**
 * Photos attached to one QC round — separate from the ticket's general
 * Photos card (TicketPhotos.vue), which is untouched. Same ethos as that
 * card: photos upload the instant they're picked (camera, library, or drag &
 * drop), are normalised in the browser first (HEIC -> JPEG, rotation baked
 * in, capped size — imagePipeline.js), captions are optional and inline, and
 * a failed upload keeps its file and offers Retry.
 *
 * Deliberately NOT wired to clipboard paste: every TicketQc round renders one
 * of these, and TicketPhotos already owns the page-wide paste handler, so a
 * second listener here would drop one pasted image into several galleries.
 *
 * A signed-off round is read-only (`locked`): the gallery stays visible, the
 * upload controls and delete buttons go away. Captions remain editable.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import api from '../api';
import { prepareImage, isProbablyImage } from '../imagePipeline';

const props = defineProps({
  checkId: { type: Number, required: true },
  locked: { type: Boolean, default: false },
  // GET /attachments/capabilities, fetched once by TicketQc for all rounds.
  caps: { type: Object, default: null },
});

const photos = ref([]);
const urls = ref({});
const error = ref('');
const dragging = ref(false);
const cameraInput = ref(null);
const fileInput = ref(null);

// In-flight uploads: { id, name, file, previewUrl, status, message }
const queue = ref([]);
let queueId = 0;
const busy = computed(() => queue.value.some((q) => q.status === 'preparing' || q.status === 'uploading'));

const base = () => `/qc/checks/${props.checkId}/attachments`;

async function load() {
  photos.value = await api.get(base());
  await Promise.all(photos.value.map(async (a) => {
    if (urls.value[a.id]) return;
    try {
      const { url } = await api.get(`/qc/attachments/${a.id}/url`);
      urls.value[a.id] = url;
    } catch { /* leave the tile blank rather than break the gallery */ }
  }));
}

async function uploadDirect(prepared) {
  const target = await api.post(`${base()}/upload-url`, {
    file_name: prepared.name, content_type: prepared.type,
  });
  const res = await fetch(target.url, { method: target.method, headers: target.headers, body: prepared.blob });
  if (!res.ok) throw new Error(`Storage rejected the upload (${res.status})`);
  return api.post(`${base()}/confirm`, {
    storage_key: target.storage_key,
    file_name: prepared.name,
    content_type: prepared.type,
    size_bytes: prepared.blob.size,
  });
}

async function uploadViaApi(prepared) {
  const body = new FormData();
  body.append('files', prepared.blob, prepared.name);
  return api.post(base(), body);
}

function drop(item) {
  const idx = queue.value.findIndex((q) => q.id === item.id);
  if (idx === -1) return;
  if (queue.value[idx].previewUrl) URL.revokeObjectURL(queue.value[idx].previewUrl);
  queue.value.splice(idx, 1);
}

async function processItem(item) {
  try {
    item.status = 'preparing';
    item.message = '';
    const prepared = await prepareImage(item.file);
    item.status = 'uploading';
    if (props.caps?.direct_upload) await uploadDirect(prepared);
    else await uploadViaApi(prepared);
    await load();
    drop(item); // the real gallery tile takes over
  } catch (err) {
    item.status = 'error';
    item.message = err.message;
  }
}

/** Sequential on purpose — same reasoning as TicketPhotos.vue (shop wifi). */
async function addFiles(fileList) {
  error.value = '';
  const files = Array.from(fileList || []);
  const rejected = files.filter((f) => !isProbablyImage(f));
  if (rejected.length) {
    error.value = `Skipped ${rejected.length} non-image file(s): ${rejected.map((f) => f.name).join(', ')}`;
  }
  const items = files.filter(isProbablyImage).map((file) => ({
    id: (queueId += 1),
    name: file.name || 'photo',
    file,
    previewUrl: URL.createObjectURL(file),
    status: 'queued',
    message: '',
  }));
  queue.value.unshift(...items);
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    await processItem(item);
  }
}

function onPicked(event) {
  addFiles(event.target.files);
  event.target.value = ''; // allow re-picking the same file
}

function onDrop(event) {
  dragging.value = false;
  if (!props.locked) addFiles(event.dataTransfer?.files);
}

async function saveCaption(a, value) {
  if (value === (a.caption || '')) return;
  try {
    await api.patch(`/qc/attachments/${a.id}`, { caption: value });
    a.caption = value;
  } catch (err) {
    error.value = err.message;
  }
}

async function remove(a) {
  if (!confirm('Delete this QC photo?')) return;
  try {
    await api.del(`/qc/attachments/${a.id}`);
    delete urls.value[a.id];
    await load();
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(() => load().catch((err) => { error.value = err.message; }));
onBeforeUnmount(() => queue.value.forEach((q) => q.previewUrl && URL.revokeObjectURL(q.previewUrl)));

const when = (ts) => new Date(ts).toLocaleString();
const statusLabel = { queued: 'Waiting', preparing: 'Preparing', uploading: 'Uploading', error: 'Failed' };
</script>

<template>
  <div
    :class="['qc-photos', { dragging }]"
    @dragover.prevent="!locked && (dragging = true)"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <div v-if="!locked" class="row" style="margin-bottom: 8px">
      <button type="button" class="small primary" :disabled="busy" @click="cameraInput.click()">Take photo</button>
      <button type="button" class="small" :disabled="busy" @click="fileInput.click()">Choose photos</button>
      <span class="muted small">or drop them here</span>
      <!-- capture=environment opens the rear camera directly on a phone -->
      <input
        ref="cameraInput" type="file" accept="image/*,.heic,.heif" capture="environment"
        multiple class="visually-hidden" @change="onPicked"
      />
      <input
        ref="fileInput" type="file" accept="image/*,.heic,.heif"
        multiple class="visually-hidden" @change="onPicked"
      />
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 8px">{{ error }}</div>

    <p v-if="!photos.length && !queue.length" class="muted small" style="margin: 0">
      {{ locked ? 'No photos were attached to this round.' : 'No photos on this round yet.' }}
    </p>

    <div v-else class="gallery">
      <figure v-for="item in queue" :key="`q${item.id}`" class="upload-tile">
        <img :src="item.previewUrl" :alt="item.name" style="opacity: 0.5" />
        <figcaption>
          <span :class="['pill', item.status === 'error' ? 'red' : 'blue']">{{ statusLabel[item.status] }}</span>
          <div v-if="item.message" class="upload-error">{{ item.message }}</div>
          <div v-if="item.status === 'error'" class="row" style="gap: 6px">
            <button class="link" @click="processItem(item)">Retry</button>
            <button class="link" @click="drop(item)">Dismiss</button>
          </div>
        </figcaption>
      </figure>

      <figure v-for="a in photos" :key="a.id">
        <a :href="urls[a.id]" target="_blank" rel="noopener">
          <img :src="urls[a.id]" :alt="a.caption || a.file_name" loading="lazy" />
        </a>
        <figcaption>
          <input
            class="caption-input" :value="a.caption" placeholder="Add a caption…"
            @change="saveCaption(a, $event.target.value)"
          />
          <div class="muted">{{ a.uploader_name || 'Unknown' }} · {{ when(a.uploaded_at) }}</div>
          <button v-if="!locked" class="link" @click="remove(a)">Delete</button>
        </figcaption>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.qc-photos { border-radius: var(--radius); }
.qc-photos.dragging { outline: 2px dashed var(--accent); outline-offset: 4px; background: rgba(212, 129, 63, 0.06); }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.upload-error { color: var(--red); font-size: 12px; }
.caption-input { min-height: 32px; padding: 4px 7px; font-size: 12px; margin-bottom: 3px; }
</style>
