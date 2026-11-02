<script setup>
/**
 * Settings -> Parts / Supplies vendors. The `vendors` table (migration 001)
 * had no editor at all until now -- rows only came from the CSV import and
 * seed, which is why "Other…" free text (migration 025) carried so much.
 *
 * Rename, reorder (the order vendor boxes appear on Parts / Supplies and in
 * every vendor picker), hide/unhide, add. No delete on purpose: the FK is
 * ON DELETE SET NULL, so deleting would strip the vendor off every order
 * that ever used it. Hiding takes it out of the pickers while existing
 * orders keep its name.
 *
 * Adding a vendor whose name matches orders filed under "Other…" moves those
 * orders under it (routes/parts.js POST /vendors) -- the notice says how many.
 */
import { ref, computed, onMounted } from 'vue';
import api from '../api';

const vendors = ref([]);
const newName = ref('');
const error = ref('');
const notice = ref('');

const active = computed(() => vendors.value.filter((v) => v.active));
const hidden = computed(() => vendors.value.filter((v) => !v.active));

async function load() {
  vendors.value = await api.get('/parts/vendors', { all: 'true' });
}

async function run(fn) {
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (err) {
    error.value = err.message;
    await load(); // put a rejected rename back the way it was
  }
}

function rename(v, value) {
  const name = value.trim();
  if (!name || name === v.name) return;
  run(async () => {
    await api.patch(`/parts/vendors/${v.id}`, { name });
    await load();
  });
}

// Renumbers the whole active list in steps of 10 and saves only the rows
// whose number changed -- a handful of vendors, so a few small PATCHes.
function move(i, dir) {
  run(async () => {
    const list = [...active.value];
    [list[i], list[i + dir]] = [list[i + dir], list[i]];
    const changes = list
      .map((v, idx) => ({ v, sort: (idx + 1) * 10 }))
      .filter(({ v, sort }) => v.sort_order !== sort);
    await Promise.all(changes.map(({ v, sort }) => api.patch(`/parts/vendors/${v.id}`, { sort_order: sort })));
    await load();
  });
}

function setActive(v, value) {
  run(async () => {
    await api.patch(`/parts/vendors/${v.id}`, { active: value });
    await load();
  });
}

function add() {
  const name = newName.value.trim();
  if (!name) return;
  run(async () => {
    const created = await api.post('/parts/vendors', { name });
    newName.value = '';
    if (created.moved_orders) {
      notice.value = `Moved ${created.moved_orders} existing "Other…" order${created.moved_orders === 1 ? '' : 's'} under ${created.name}.`;
    }
    await load();
  });
}

onMounted(load);
</script>

<template>
  <div class="card">
    <h2>Parts / Supplies vendors</h2>
    <p class="muted small" style="margin-top: -6px">
      Order here is the order vendor boxes show on Parts / Supplies and in the vendor pickers.
      Hiding a vendor takes it out of the pickers; orders already filed under it keep its name.
    </p>

    <div v-if="error" class="alert" style="margin-bottom: 12px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 12px">{{ notice }}</div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Name</th><th>Open orders</th><th>Order</th><th>State</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="(v, i) in active" :key="v.id">
            <td>
              <input :value="v.name" style="min-width: 200px" @change="rename(v, $event.target.value)" />
            </td>
            <td class="small">{{ v.open_orders || '—' }}</td>
            <td class="nowrap">
              <button class="small" :disabled="i === 0" @click="move(i, -1)">↑</button>
              <button class="small" :disabled="i === active.length - 1" @click="move(i, 1)">↓</button>
            </td>
            <td><span class="pill green">Active</span></td>
            <td class="right"><button class="small" @click="setActive(v, false)">Hide</button></td>
          </tr>
          <tr v-for="v in hidden" :key="v.id" class="muted">
            <td>
              <input :value="v.name" style="min-width: 200px" @change="rename(v, $event.target.value)" />
            </td>
            <td class="small">{{ v.open_orders || '—' }}</td>
            <td />
            <td><span class="pill slate">Hidden</span></td>
            <td class="right"><button class="small" @click="setActive(v, true)">Unhide</button></td>
          </tr>
          <tr v-if="!vendors.length">
            <td colspan="5" class="muted small">No vendors yet.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="row" style="margin-top: 12px" @submit.prevent="add">
      <input v-model="newName" placeholder="New vendor name" style="max-width: 280px" />
      <button type="submit" :disabled="!newName.trim()">Add</button>
    </form>
  </div>
</template>
