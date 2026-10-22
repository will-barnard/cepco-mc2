<script setup>
/**
 * Photo sets on an inventory piece — named batches ("Intake", "Listing",
 * "Post-restoration"...) so the pictures from each stage stay together.
 *
 * Same upload ethos as TicketPhotos.vue / QcPhotos.vue: photos upload the
 * moment they're picked (camera, library or drag & drop), are normalised in
 * the browser first (HEIC -> JPEG, rotation baked in, size capped —
 * imagePipeline.js), go one at a time (shop wifi), and a failed upload
 * keeps its file and offers Retry. Two upload paths, picked from
 * GET /attachments/capabilities: signed PUT straight to GCS, or multipart
 * through the API for the local driver.
 *
 * Photos are shown through GET /inventory/photos/:id/view, a stable URL
 * that redirects to a short-lived signed one — so <img> tags never hold an
 * expiring link.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import api from '../api';
import { useAuth } from '../stores';
import { prepareImage, isProbablyImage } from '../imagePipeline';

const props = defineProps({
  instrumentId: { type: Number, required: true },
  sets: { type: Array, required: true },
  coverPhotoId: { type: Number, default: null },
  presets: { type: Array, default: () => [] },
  // Open tickets on this piece, so a set can be tied to the job it was shot for.
  tickets: { type: Array, default: () => [] },
});
const emit = defineEmits(['changed', 'cover']);

const auth = useAuth();
const caps = ref(null);
const error = ref('');

const viewUrl = (p) => `/api/inventory/photos/${p.id}/view`;

// --- new set --------------------------------------------------------------
const creating = ref(false);
const newName = ref('');
const newTicketId = ref('');
const usedNames = computed(() => new Set(props.sets.map((s) => s.name.toLowerCase())));

async function createSet(name = newName.value) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  error.value = '';
  try {
    const set = await api.post(`/inventory/${props.instrumentId}/photo-sets`, {
      name: trimmed, ticket_id: newTicketId.value || null,
    });
    creating.value = false;
    newName.value = '';
    newTicketId.value = '';
    emit('changed', { openSetId: set.id });
  } catch (err) {
    error.value = err.message;
  }
}

// --- set actions ------------------------------------------------------------
async function renameSet(set) {
  const name = prompt('Rename this photo set', set.name);
  if (!name || name.trim() === set.name) return;
  try {
    await api.patch(`/inventory/photo-sets/${set.id}`, { name });
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

async function deleteSet(set) {
  const n = set.photos.length;
  if (!confirm(`Delete the "${set.name}" set${n ? ` and its ${n} photo${n === 1 ? '' : 's'}` : ''}? This can't be undone.`)) return;
  try {
    await api.del(`/inventory/photo-sets/${set.id}`);
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

const canDeleteSet = (set) => auth.isAdmin || set.created_by === auth.user?.id;
const canDeletePhoto = (p) => auth.isAdmin || p.uploader_id === auth.user?.id;

// --- uploads ----------------------------------------------------------------
// queue items: { id, setId, name, file, previewUrl, status, message }
const queue = ref([]);
let queueId = 0;
const queueFor = (setId) => queue.value.filter((q) => q.setId === setId);
const busyFor = (setId) => queueFor(setId).some((q) => q.status === 'preparing' || q.status === 'uploading');

async function uploadDirect(setId, prepared) {
  const target = await api.post(`/inventory/photo-sets/${setId}/upload-url`, {
    file_name: prepared.name, content_type: prepared.type,
  });
  const res = await fetch(target.url, { method: target.method, headers: target.headers, body: prepared.blob });
  if (!res.ok) throw new Error(`Storage rejected the upload (${res.status})`);
  return api.post(`/inventory/photo-sets/${setId}/confirm`, {
    storage_key: target.storage_key,
    file_name: prepared.name,
    content_type: prepared.type,
    size_bytes: prepared.blob.size,
  });
}

async function uploadViaApi(setId, prepared) {
  const body = new FormData();
  body.append('files', prepared.blob, prepared.name);
  return api.post(`/inventory/photo-sets/${setId}/photos`, body);
}

function dropItem(item) {
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
    if (caps.value?.direct_upload) await uploadDirect(item.setId, prepared);
    else await uploadViaApi(item.setId, prepared);
    item.status = 'done';
  } catch (err) {
    item.status = 'error';
    item.message = err.message;
  }
}

async function addFiles(setId, fileList) {
  error.value = '';
  const files = Array.from(fileList || []);
  const rejected = files.filter((f) => !isProbablyImage(f));
  if (rejected.length) {
    error.value = `Skipped ${rejected.length} non-image file(s): ${rejected.map((f) => f.name).join(', ')}`;
  }
  const items = files.filter(isProbablyImage).map((file) => ({
    id: (queueId += 1), setId, name: file.name || 'photo', file,
    previewUrl: URL.createObjectURL(file), status: 'queued', message: '',
  }));
  queue.value.push(...items);
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    await processItem(item);
  }
  // Refresh once per batch, then clear the successful placeholders.
  emit('changed');
  for (const item of items.filter((i) => i.status === 'done')) dropItem(item);
}

async function retry(item) {
  await processItem(item);
  if (item.status === 'done') { emit('changed'); dropItem(item); }
}

const inputs = {};
const setInput = (key) => (el) => { if (el) inputs[key] = el; };
function pick(setId, kind) { inputs[`${kind}-${setId}`]?.click(); }
function onPicked(setId, event) {
  addFiles(setId, event.target.files);
  event.target.value = '';
}

const dragOver = ref(null);
function onDrop(setId, event) {
  dragOver.value = null;
  addFiles(setId, event.dataTransfer?.files);
}

// --- photo actions -----------------------------------------------------------
async function saveCaption(p, value) {
  if (value === (p.caption || '')) return;
  try {
    await api.patch(`/inventory/photos/${p.id}`, { caption: value });
    p.caption = value;
  } catch (err) {
    error.value = err.message;
  }
}

async function moveTo(p, setId) {
  if (!setId || Number(setId) === p.set_id) return;
  try {
    await api.patch(`/inventory/photos/${p.id}`, { set_id: Number(setId) });
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

async function removePhoto(p) {
  if (!confirm('Delete this photo?')) return;
  try {
    await api.del(`/inventory/photos/${p.id}`);
    emit('changed');
  } catch (err) {
    error.value = err.message;
  }
}

const statusLabel = { queued: 'Waiting', preparing: 'Preparing', uploading: 'Uploading', error: 'Failed', done: 'Done' };
const when = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString() : '');

onMounted(async () => {
  try { caps.value = await api.get('/attachments/capabilities'); } catch { caps.value = null; }
});
onBeforeUnmount(() => queue.value.forEach((q) => q.previewUrl && URL.revokeObjectURL(q.previewUrl)));
</script>

<template>
  <div>
    <div v-if="error" class="alert" style="margin-bottom: 10px">{{ error }}</div>

    <div class="row" style="margin-bottom: 12px">
      <span class="muted small">New set:</span>
      <button
        v-for="name in presets.filter((n) => !usedNames.has(n.toLowerCase()))" :key="name"
        type="button" class="small" @click="createSet(name)"
      >+ {{ name }}</button>
      <button type="button" class="small" @click="creating = !creating">{{ creating ? 'Cancel' : 'Custom…' }}</button>
    </div>
    <form v-if="creating" class="row" style="margin-bottom: 12px" @submit.prevent="createSet()">
      <input v-model="newName" placeholder="Set name, e.g. Before tolex" style="max-width: 260px" />
      <select v-if="tickets.length" v-model="newTicketId" style="max-width: 260px">
        <option value="">Not tied to a ticket</option>
        <option v-for="t in tickets" :key="t.id" :value="t.id">#{{ t.id }} {{ t.title }}</option>
      </select>
      <button type="submit" class="small primary" :disabled="!newName.trim()">Create set</button>
    </form>

    <p v-if="!sets.length" class="muted small">No photos yet — start a set above (Intake is a good first one).</p>

    <section
      v-for="set in sets" :key="set.id" :class="['photo-set', { dragging: dragOver === set.id }]"
      @dragover.prevent="dragOver = set.id" @dragleave.prevent="dragOver = null" @drop.prevent="onDrop(set.id, $event)"
    >
      <header class="row">
        <strong>{{ set.name }}</strong>
        <span class="muted small">
          {{ when(set.taken_on) }} · {{ set.photos.length }} photo{{ set.photos.length === 1 ? '' : 's' }}
          <template v-if="set.created_by_name"> · {{ set.created_by_name }}</template>
          <template v-if="set.ticket_id"> · ticket #{{ set.ticket_id }}</template>
        </span>
        <span class="spacer" />
        <button type="button" class="small primary" :disabled="busyFor(set.id)" @click="pick(set.id, 'camera')">Take photo</button>
        <button type="button" class="small" :disabled="busyFor(set.id)" @click="pick(set.id, 'file')">Add photos</button>
        <a
          v-if="set.photos.length" class="btn small" :href="`/api/inventory/photo-sets/${set.id}/zip`"
          title="Download every photo in this set as a .zip"
        >Download</a>
        <button type="button" class="small" @click="renameSet(set)">Rename</button>
        <button v-if="canDeleteSet(set)" type="button" class="small danger" @click="deleteSet(set)">Delete set</button>
        <input
          :ref="setInput(`camera-${set.id}`)" type="file" accept="image/*,.heic,.heif" capture="environment"
          multiple class="visually-hidden" @change="onPicked(set.id, $event)"
        />
        <input
          :ref="setInput(`file-${set.id}`)" type="file" accept="image/*,.heic,.heif"
          multiple class="visually-hidden" @change="onPicked(set.id, $event)"
        />
      </header>

      <div v-if="set.photos.length || queueFor(set.id).length" class="gallery">
        <figure v-for="p in set.photos" :key="p.id">
          <a :href="viewUrl(p)" target="_blank" rel="noopener">
            <img :src="viewUrl(p)" :alt="p.caption || p.file_name" loading="lazy" />
          </a>
          <figcaption>
            <input
              class="caption-input" :value="p.caption" placeholder="Caption…"
              @change="saveCaption(p, $event.target.value)"
            />
            <div class="row photo-actions">
              <span v-if="p.id === coverPhotoId" class="pill accent">Cover</span>
              <button v-else type="button" class="link" @click="emit('cover', p.id)">Make cover</button>
              <select
                v-if="sets.length > 1" class="move-select" :value="''" title="Move to another set"
                @change="moveTo(p, $event.target.value)"
              >
                <option value="">Move…</option>
                <option v-for="s in sets.filter((x) => x.id !== set.id)" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
              <button v-if="canDeletePhoto(p)" type="button" class="link danger-link" @click="removePhoto(p)">Delete</button>
            </div>
          </figcaption>
        </figure>
        <figure v-for="item in queueFor(set.id)" :key="`q${item.id}`" class="upload-tile">
          <img :src="item.previewUrl" :alt="item.name" style="opacity: 0.5" />
          <figcaption>
            <span :class="['pill', item.status === 'error' ? 'red' : 'blue']">{{ statusLabel[item.status] }}</span>
            <div v-if="item.message" class="upload-error">{{ item.message }}</div>
            <div v-if="item.status === 'error'" class="row" style="gap: 6px">
              <button class="link" type="button" @click="retry(item)">Retry</button>
              <button class="link" type="button" @click="dropItem(item)">Dismiss</button>
            </div>
          </figcaption>
        </figure>
      </div>
      <p v-else class="muted small drop-hint">Drop photos here, or use the buttons above.</p>
    </section>
  </div>
</template>

<style scoped>
.photo-set {
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px; margin-bottom: 12px;
}
.photo-set header { margin-bottom: 10px; gap: 6px; }
.photo-set.dragging { outline: 2px dashed var(--accent); outline-offset: 2px; background: rgba(212, 129, 63, 0.06); }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.caption-input { min-height: 30px; padding: 4px 7px; font-size: 12px; margin-bottom: 3px; }
.photo-actions { gap: 8px; font-size: 12px; }
.move-select { width: auto; min-height: 26px; padding: 2px 6px; font-size: 12px; }
.pill.accent { color: var(--accent); }
.danger-link { color: var(--red); }
.upload-error { color: var(--red); font-size: 12px; }
.drop-hint { margin: 0; padding: 14px; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); }
</style>
