<script setup>
/**
 * Xero duplicate review — cleanup screen for pre-existing customers the
 * regular sync's exact-email/exact-name matching missed and created a
 * second, Xero-linked row for instead (services/xeroDuplicates.js). Same
 * confirm/reject shape as XeroBackfillView.vue, reusing the same scoring
 * approach, but pairing "a customer never linked to Xero" (survivor)
 * against "a customer the sync just created from Xero" (duplicate)
 * instead of MC2 customers against raw Xero contacts.
 *
 * Merging is the only destructive action here — it reassigns every child
 * record (tickets, instruments, emails, estimates, progress updates) from
 * the duplicate onto the survivor, moves the Xero link over, and deletes
 * the duplicate row. There's no undo once that's clicked, so unlike the
 * backfill screen's "link" this doesn't get a bulk "merge all" button —
 * each pair is confirmed one at a time.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const loading = ref(true);
const error = ref('');
const notice = ref('');
const data = ref(null);
const busyKey = ref(''); // `${survivorId}:${duplicateId}` of whichever row is mid-action

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.get('/xero/duplicates/candidates');
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function mergePair(survivorId, duplicateId, survivorName) {
  if (!confirm(
    `Merge into "${survivorName}"? This moves all of that duplicate's tickets, instruments, `
    + 'estimates, and history onto this customer, links this customer to Xero instead, and '
    + 'deletes the duplicate record. This cannot be undone.',
  )) return;
  busyKey.value = `${survivorId}:${duplicateId}`;
  error.value = '';
  try {
    await api.post('/xero/duplicates/merge', { survivor_id: survivorId, duplicate_id: duplicateId });
    notice.value = 'Merged.';
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busyKey.value = '';
  }
}

async function dismissPair(survivorId, duplicateId) {
  busyKey.value = `${survivorId}:${duplicateId}`;
  error.value = '';
  try {
    await api.post('/xero/duplicates/dismiss', { survivor_id: survivorId, duplicate_id: duplicateId });
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busyKey.value = '';
  }
}

const scorePct = (s) => `${Math.round(s * 100)}%`;
const signalLabel = { email: 'email', name: 'name', phone: 'phone' };
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Xero duplicate review</h1>
        <p class="muted small" style="margin: 0">
          Customers the sync created from Xero that look like the same person as an existing,
          unlinked customer. Merging moves that customer's history over and removes the duplicate.
        </p>
      </div>
      <RouterLink class="btn small" to="/customers">← Customers</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div v-if="loading" class="empty">Loading…</div>

    <div v-else-if="data" class="stack">
      <div class="card">
        <div class="row" style="margin-bottom: 4px">
          <h2 style="margin: 0">Confident matches</h2>
          <span class="muted small">{{ data.confident.length }}</span>
        </div>
        <p class="muted small">
          Exact email match, or a very close name match. Review before merging — a merge cannot be
          undone.
        </p>
        <div v-if="!data.confident.length" class="empty">None found.</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr><th>Existing customer</th><th>Duplicate (from Xero)</th><th>Matched on</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="r in data.confident" :key="`${r.survivor.id}:${r.duplicate.id}`">
                <td>
                  <strong>{{ r.survivor.name }}</strong>
                  <div class="muted small">{{ [r.survivor.email, r.survivor.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td>
                  <strong>{{ r.duplicate.name }}</strong>
                  <div class="muted small">{{ [r.duplicate.email, r.duplicate.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td class="small muted">{{ r.signals.map((s) => signalLabel[s]).join(', ') }} · {{ scorePct(r.score) }}</td>
                <td class="right">
                  <div class="row" style="justify-content: flex-end">
                    <button
                      class="small" :disabled="busyKey === `${r.survivor.id}:${r.duplicate.id}`"
                      @click="dismissPair(r.survivor.id, r.duplicate.id)"
                    >
                      Not a duplicate
                    </button>
                    <button
                      class="small primary" :disabled="busyKey === `${r.survivor.id}:${r.duplicate.id}`"
                      @click="mergePair(r.survivor.id, r.duplicate.id, r.survivor.name)"
                    >
                      Merge
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 4px">
          <h2 style="margin: 0">Possible matches</h2>
          <span class="muted small">{{ data.possible.length }}</span>
        </div>
        <p class="muted small">
          Similar enough to flag, not similar enough to trust automatically — review each one.
        </p>
        <div v-if="!data.possible.length" class="empty">None found.</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr><th>Existing customer</th><th>Duplicate (from Xero)</th><th>Matched on</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="r in data.possible" :key="`${r.survivor.id}:${r.duplicate.id}`">
                <td>
                  <strong>{{ r.survivor.name }}</strong>
                  <div class="muted small">{{ [r.survivor.email, r.survivor.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td>
                  <strong>{{ r.duplicate.name }}</strong>
                  <div class="muted small">{{ [r.duplicate.email, r.duplicate.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td class="small muted">{{ r.signals.map((s) => signalLabel[s]).join(', ') || '—' }} · {{ scorePct(r.score) }}</td>
                <td class="right">
                  <div class="row" style="justify-content: flex-end">
                    <button
                      class="small" :disabled="busyKey === `${r.survivor.id}:${r.duplicate.id}`"
                      @click="dismissPair(r.survivor.id, r.duplicate.id)"
                    >
                      Not a duplicate
                    </button>
                    <button
                      class="small primary" :disabled="busyKey === `${r.survivor.id}:${r.duplicate.id}`"
                      @click="mergePair(r.survivor.id, r.duplicate.id, r.survivor.name)"
                    >
                      Merge
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 4px">
          <h2 style="margin: 0">Unmatched Xero-created customers</h2>
          <span class="muted small">{{ data.duplicates_unmatched_count }}</span>
        </div>
        <p class="muted small">
          Customers the sync created from Xero that didn't look like a duplicate of anything —
          most likely genuinely new customers. Nothing to do here.
        </p>
      </div>
    </div>
  </div>
</template>
