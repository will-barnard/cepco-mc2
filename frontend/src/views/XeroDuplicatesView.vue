<script setup>
/**
 * Duplicate customer review (services/xeroDuplicates.js). Started as a
 * Xero-sync cleanup screen — pre-existing customers the sync's exact-
 * email/exact-name matching missed and created a second, Xero-linked row
 * for instead — then generalized (§2.64) to score and merge any two
 * customer records that look like the same person, whatever created the
 * second one (a Xero sync miss is still the most common case in
 * practice, hence "survivor"/"duplicate" naming and the Xero-specific
 * card at the bottom). Same confirm/reject shape as XeroBackfillView.vue,
 * reusing the same scoring approach.
 *
 * Merging is the only destructive action here — it reassigns every child
 * record (tickets, instruments, emails, estimates, progress updates) from
 * the duplicate onto the survivor, moves over a Xero link the duplicate
 * has and the survivor doesn't, and deletes the duplicate row. There's no
 * undo once that's clicked, so unlike the backfill screen's "link" this
 * doesn't get a bulk "merge all" button — each pair is confirmed one at
 * a time.
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

async function mergePair(survivorId, duplicateId, survivorName, duplicateXeroLinked) {
  if (!confirm(
    `Merge into "${survivorName}"? This moves all of that duplicate's tickets, instruments, `
    + 'estimates, and history onto this customer'
    + (duplicateXeroLinked ? ', links this customer to Xero instead,' : '')
    + ' and deletes the duplicate record. This cannot be undone.',
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
        <h1 style="margin-bottom: 4px">Duplicate customer review</h1>
        <p class="muted small" style="margin: 0">
          Customer records that look like the same person — most often one the Xero sync created
          for an existing customer it couldn't match exactly, but any other duplicate (e.g. a
          repeated estimate or ticket submission) shows up here too. Merging moves the duplicate's
          history over and removes it.
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
              <tr><th>Existing customer</th><th>Duplicate</th><th>Matched on</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="r in data.confident" :key="`${r.survivor.id}:${r.duplicate.id}`">
                <td>
                  <strong>{{ r.survivor.name }}</strong>
                  <div class="muted small">{{ [r.survivor.email, r.survivor.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td>
                  <strong>{{ r.duplicate.name }}</strong>
                  <span v-if="r.duplicate.xero_linked" class="muted small">· Xero</span>
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
                      @click="mergePair(r.survivor.id, r.duplicate.id, r.survivor.name, r.duplicate.xero_linked)"
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
              <tr><th>Existing customer</th><th>Duplicate</th><th>Matched on</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="r in data.possible" :key="`${r.survivor.id}:${r.duplicate.id}`">
                <td>
                  <strong>{{ r.survivor.name }}</strong>
                  <div class="muted small">{{ [r.survivor.email, r.survivor.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td>
                  <strong>{{ r.duplicate.name }}</strong>
                  <span v-if="r.duplicate.xero_linked" class="muted small">· Xero</span>
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
                      @click="mergePair(r.survivor.id, r.duplicate.id, r.survivor.name, r.duplicate.xero_linked)"
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
