<script setup>
/**
 * Xero backfill review — a one-time-ish (or "run again whenever it feels
 * useful") screen for reconciling pre-existing customer records on both
 * sides before the regular two-way sync's own exact-email/exact-name
 * matching (routes/xero.js POST /sync, services/xeroSync.js) gets a
 * chance to create duplicates out of anything messier than that: a
 * typo, a nickname, an email on file in one system but not the other.
 *
 * Backed entirely by services/xeroBackfill.js's scoring — this component
 * is just the review/confirm UI over GET /xero/backfill/candidates and
 * the link/dismiss actions. Every action here just sets or records a
 * decision; it never itself creates a customer or a Xero contact or
 * pulls/pushes field data — that's still only ever done by the regular
 * sync, run separately (from the Customers page) once backfill linking
 * is done. Linking here deliberately leaves xero_synced_at unset so that
 * next sync run reconciles the newly-linked pair's actual field values
 * (whichever side is newer) rather than this screen having to guess.
 */
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';

const loading = ref(true);
const error = ref('');
const notice = ref('');
const data = ref(null);

// Confident-matches bulk selection — every row starts checked, since
// "confident" already means email-exact or very-high name similarity;
// unchecking is for the rare one that's still wrong.
const selectedConfident = ref(new Set());
const linkingBulk = ref(false);
const busyKey = ref(''); // `${customerId}:${xeroContactId}` of whichever single row is mid-action

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.get('/xero/backfill/candidates');
    selectedConfident.value = new Set((data.value.confident || []).map((r) => r.mc.id));
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function toggleConfident(customerId) {
  const next = new Set(selectedConfident.value);
  if (next.has(customerId)) next.delete(customerId);
  else next.add(customerId);
  selectedConfident.value = next;
}

async function linkPair(customerId, xeroContactId) {
  busyKey.value = `${customerId}:${xeroContactId}`;
  error.value = '';
  try {
    await api.post('/xero/backfill/link', { customer_id: customerId, xero_contact_id: xeroContactId });
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busyKey.value = '';
  }
}

async function dismissPair(customerId, xeroContactId) {
  busyKey.value = `${customerId}:${xeroContactId}`;
  error.value = '';
  try {
    await api.post('/xero/backfill/dismiss', { customer_id: customerId, xero_contact_id: xeroContactId });
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busyKey.value = '';
  }
}

async function linkSelectedConfident() {
  const pairs = (data.value.confident || [])
    .filter((r) => selectedConfident.value.has(r.mc.id))
    .map((r) => ({ customer_id: r.mc.id, xero_contact_id: r.xero.xero_contact_id }));
  if (!pairs.length) return;
  linkingBulk.value = true;
  error.value = '';
  try {
    const result = await api.post('/xero/backfill/link-bulk', { pairs });
    notice.value = `Linked ${result.linked} customer(s).`;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    linkingBulk.value = false;
  }
}

// --- manual search, per mc_unmatched row ------------------------------------
// The algorithm can miss a real match (a big enough typo, a maiden name,
// a nickname it has no way to know about) — this searches the full list
// of still-unlinked Xero contacts client-side (already fetched with the
// rest of this screen's data, no extra round trip) so a human can catch
// what the scorer didn't.
const openSearchFor = ref(null); // customer id, or null
const searchQuery = ref('');

function openSearch(customerId) {
  openSearchFor.value = openSearchFor.value === customerId ? null : customerId;
  searchQuery.value = '';
}

function searchResults() {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q || !data.value) return [];
  return (data.value.xero_all_unlinked || [])
    .filter((x) => x.name?.toLowerCase().includes(q) || x.email?.toLowerCase().includes(q))
    .slice(0, 8);
}

const scorePct = (s) => `${Math.round(s * 100)}%`;
const signalLabel = { email: 'email', name: 'name', phone: 'phone' };
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Xero backfill review</h1>
        <p class="muted small" style="margin: 0">
          Confirm or reject each suggested match before running the regular sync — nothing here
          creates or overwrites a record on either side, it only links (or rules out) a pair.
        </p>
      </div>
      <RouterLink class="btn small" to="/customers">← Customers</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div v-if="loading" class="empty">Loading…</div>

    <div v-else-if="data" class="stack">
      <!-- ------------------------------------------------ confident matches -->
      <div class="card">
        <div class="row" style="margin-bottom: 4px">
          <h2 style="margin: 0">Confident matches</h2>
          <span class="muted small">{{ data.confident.length }}</span>
        </div>
        <p class="muted small">
          Exact email match, or a very close name match. Checked rows link when you click below —
          uncheck anything that isn't actually the same customer.
        </p>
        <div v-if="!data.confident.length" class="empty">None found.</div>
        <template v-else>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th /><th>MC2 customer</th><th>Xero contact</th><th>Matched on</th><th /></tr>
              </thead>
              <tbody>
                <tr v-for="r in data.confident" :key="r.mc.id">
                  <td><input type="checkbox" :checked="selectedConfident.has(r.mc.id)" @change="toggleConfident(r.mc.id)" /></td>
                  <td>
                    <strong>{{ r.mc.name }}</strong>
                    <div class="muted small">{{ [r.mc.email, r.mc.phone].filter(Boolean).join(' · ') }}</div>
                  </td>
                  <td>
                    <strong>{{ r.xero.name }}</strong>
                    <div class="muted small">{{ [r.xero.email, r.xero.phone].filter(Boolean).join(' · ') }}</div>
                  </td>
                  <td class="small muted">{{ r.signals.map((s) => signalLabel[s]).join(', ') }} · {{ scorePct(r.score) }}</td>
                  <td class="right">
                    <button
                      class="small" :disabled="busyKey === `${r.mc.id}:${r.xero.xero_contact_id}`"
                      @click="dismissPair(r.mc.id, r.xero.xero_contact_id)"
                    >
                      Not a match
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <button
            class="primary" style="margin-top: 12px"
            :disabled="linkingBulk || !selectedConfident.size"
            @click="linkSelectedConfident"
          >
            {{ linkingBulk ? 'Linking…' : `Link ${selectedConfident.size} selected` }}
          </button>
        </template>
      </div>

      <!-- ------------------------------------------------- possible matches -->
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
              <tr><th>MC2 customer</th><th>Xero contact</th><th>Matched on</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="r in data.possible" :key="r.mc.id">
                <td>
                  <strong>{{ r.mc.name }}</strong>
                  <div class="muted small">{{ [r.mc.email, r.mc.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td>
                  <strong>{{ r.xero.name }}</strong>
                  <div class="muted small">{{ [r.xero.email, r.xero.phone].filter(Boolean).join(' · ') }}</div>
                </td>
                <td class="small muted">{{ r.signals.map((s) => signalLabel[s]).join(', ') || '—' }} · {{ scorePct(r.score) }}</td>
                <td class="right">
                  <div class="row" style="justify-content: flex-end">
                    <button
                      class="small" :disabled="busyKey === `${r.mc.id}:${r.xero.xero_contact_id}`"
                      @click="dismissPair(r.mc.id, r.xero.xero_contact_id)"
                    >
                      Not a match
                    </button>
                    <button
                      class="small primary" :disabled="busyKey === `${r.mc.id}:${r.xero.xero_contact_id}`"
                      @click="linkPair(r.mc.id, r.xero.xero_contact_id)"
                    >
                      Link
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- --------------------------------------- mc2 customers, no candidate -->
      <div class="card">
        <div class="row" style="margin-bottom: 4px">
          <h2 style="margin: 0">No candidate found</h2>
          <span class="muted small">{{ data.mc_unmatched.length }}</span>
        </div>
        <p class="muted small">
          These MC2 customers didn't match anything in Xero closely enough to suggest. Left alone,
          the regular sync creates each one as a new Xero contact — search here first if you know
          one of them is already in Xero under a different name or spelling.
        </p>
        <div v-if="!data.mc_unmatched.length" class="empty">None — everything matched or was already linked.</div>
        <ul v-else class="timeline">
          <li v-for="mc in data.mc_unmatched" :key="mc.id">
            <div class="row">
              <div style="flex: 1">
                <strong>{{ mc.name }}</strong>
                <span class="muted small"> {{ [mc.email, mc.phone].filter(Boolean).join(' · ') }}</span>
              </div>
              <button class="small" @click="openSearch(mc.id)">
                {{ openSearchFor === mc.id ? 'Close' : 'Find in Xero' }}
              </button>
            </div>
            <div v-if="openSearchFor === mc.id" style="margin-top: 8px">
              <input v-model="searchQuery" type="search" placeholder="Search Xero contacts by name or email" />
              <ul v-if="searchQuery.trim()" class="timeline" style="margin-top: 6px">
                <li v-for="x in searchResults()" :key="x.xero_contact_id">
                  <div class="row">
                    <div style="flex: 1">
                      {{ x.name }}
                      <span class="muted small"> {{ [x.email, x.phone].filter(Boolean).join(' · ') }}</span>
                    </div>
                    <button
                      class="small primary" :disabled="busyKey === `${mc.id}:${x.xero_contact_id}`"
                      @click="linkPair(mc.id, x.xero_contact_id)"
                    >
                      Link
                    </button>
                  </div>
                </li>
                <li v-if="!searchResults().length" class="muted small">No matches.</li>
              </ul>
            </div>
          </li>
        </ul>
      </div>

      <!-- -------------------------------------------- xero contacts, no candidate -->
      <div class="card">
        <div class="row" style="margin-bottom: 4px">
          <h2 style="margin: 0">Xero-only contacts</h2>
          <span class="muted small">{{ data._xero_unmatched_count }}</span>
        </div>
        <p class="muted small">
          Didn't match any MC2 customer either. Left alone, the regular sync creates each one as a
          new MC2 customer — nothing to do here unless you recognize one from the list above.
        </p>
      </div>
    </div>
  </div>
</template>
