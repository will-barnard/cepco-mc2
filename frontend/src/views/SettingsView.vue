<script setup>
/**
 * Admin configuration (PLAN §8).
 *
 * The `key` of a settings row is deliberately not editable — tickets reference
 * it, and its immutability is what lets a rename propagate safely to historical
 * tickets. Renaming edits the label only. Deleting is refused while any ticket
 * still carries the key; retiring hides it from new tickets instead.
 */
import { ref, onMounted } from 'vue';
import api from '../api';
import { useSettings, useRefData } from '../stores';

const settings = useSettings();
const refData = useRefData();

const CATEGORIES = [
  ['ticket_category', 'Ticket categories'],
  ['ticket_status', 'Ticket statuses'],
  ['priority_tier', 'Priority tiers'],
  ['qc_tier', 'QC rigor tiers'],
  ['tech_level', 'Tech levels'],
];

const error = ref('');
const notice = ref('');
const newLabel = ref({});

// --- employees -------------------------------------------------------------
const showNewEmployee = ref(false);
const employeeForm = ref({ name: '', email: '', password: '', role: 'junior', initials: '' });

async function refresh() {
  await settings.load(true);
  await refData.load(true);
}

async function addValue(category) {
  error.value = '';
  notice.value = '';
  const label = (newLabel.value[category] || '').trim();
  if (!label) return;
  try {
    const rows = settings.data[category] || [];
    await api.post('/settings', {
      category,
      label,
      sort_order: (rows[rows.length - 1]?.sort_order || 0) + 10,
    });
    newLabel.value[category] = '';
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function rename(row, label) {
  if (label === row.label) return;
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, { label });
    notice.value = `Renamed to "${label}". Existing tickets follow the new name automatically.`;
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function toggleRetired(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, { retired: !row.retired });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function reorder(row, delta) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, { sort_order: row.sort_order + delta });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function remove(row) {
  error.value = '';
  notice.value = '';
  if (!confirm(`Delete "${row.label}" permanently?`)) return;
  try {
    await api.del(`/settings/${row.id}`);
    await refresh();
  } catch (err) {
    // The API refuses when the value is in use and says by how many tickets.
    error.value = err.message;
  }
}

async function setShopValue(row, value) {
  error.value = '';
  notice.value = '';
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    error.value = 'Enter a positive number.';
    return;
  }
  try {
    await api.patch(`/settings/${row.id}`, { meta: { ...row.meta, value: num } });
    notice.value = `${row.label} is now ${num}. Estimates already written keep the rate `
      + 'they were quoted at.';
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Which ticket_category a new Shopify order is filed under (Settings ->
// Shop configuration). Stored as a shop_config row whose meta.value is the
// category key, same slot as labor_rate but string-valued instead of
// numeric, hence its own handler instead of reusing setShopValue.
async function setShopifyCategory(row, categoryKey) {
  error.value = '';
  notice.value = '';
  try {
    await api.patch(`/settings/${row.id}`, { meta: { ...row.meta, value: categoryKey } });
    notice.value = 'Incoming Shopify orders will now be filed under this category.';
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Per-category auto-assignment (e.g. every Shipping ticket goes straight to
// the shipping manager). Stored on the ticket_category row's own meta so no
// new table is needed; resolveNewTicketFields (backend) reads it whenever a
// ticket is created without an explicit assignee — manual, Shopify-order,
// and inventory-purchase tickets alike.
async function setDefaultAssignee(row, employeeId) {
  error.value = '';
  notice.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, default_assignee_id: employeeId ? Number(employeeId) : null },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function setRequiredRounds(row, value) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, required_rounds: Number(value) },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function toggleDistinct(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, require_distinct_reviewers: !row.meta.require_distinct_reviewers },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function createEmployee() {
  error.value = '';
  try {
    await api.post('/employees', employeeForm.value);
    employeeForm.value = { name: '', email: '', password: '', role: 'junior', initials: '' };
    showNewEmployee.value = false;
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function toggleEmployee(emp) {
  error.value = '';
  try {
    await api.patch(`/employees/${emp.id}`, { active: !emp.active });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Settings</h1>
        <p class="muted small" style="margin: 0">
          Renaming a value updates it everywhere. Deleting is blocked while tickets still use it —
          retire it instead to hide it from new tickets.
        </p>
      </div>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="notice" class="alert ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div class="stack">
      <!-- ------------------------------------------------ shop-wide values -->
      <div class="card">
        <h2>Shop configuration</h2>
        <p class="muted small" style="margin-top: -6px">
          Changing the rate affects new estimates only. Estimates already written keep the
          rate they were quoted at.
        </p>
        <div class="field-row">
          <div v-for="row in settings.data.shop_config || []" :key="row.id" class="field">
            <label>{{ row.label }}</label>
            <select
              v-if="row.key === 'shopify_default_category'"
              :value="row.meta.value"
              @change="setShopifyCategory(row, $event.target.value)"
            >
              <option
                v-for="cat in (settings.data.ticket_category || []).filter((c) => !c.retired)"
                :key="cat.key" :value="cat.key"
              >
                {{ cat.label }}
              </option>
            </select>
            <input
              v-else
              type="number" step="1" min="1" :value="row.meta.value"
              @change="setShopValue(row, $event.target.value)"
            />
          </div>
        </div>
      </div>

      <div v-for="[category, title] in CATEGORIES" :key="category" class="card">
        <h2>{{ title }}</h2>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Label</th><th>Key</th>
                <th v-if="category === 'qc_tier'">Rounds required</th>
                <th v-if="category === 'qc_tier'">Two reviewers</th>
                <th v-if="category === 'ticket_category'">Default assignee</th>
                <th>Order</th><th>State</th><th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in settings.data[category] || []" :key="row.id">
                <td>
                  <input
                    :value="row.label" style="min-width: 180px"
                    @change="rename(row, $event.target.value)"
                  />
                </td>
                <td><code class="muted small">{{ row.key }}</code></td>

                <td v-if="category === 'qc_tier'">
                  <input
                    type="number" min="1" max="5" style="width: 80px"
                    :value="row.meta.required_rounds || 1"
                    @change="setRequiredRounds(row, $event.target.value)"
                  />
                </td>
                <td v-if="category === 'qc_tier'">
                  <label class="checkbox">
                    <input
                      type="checkbox" :checked="row.meta.require_distinct_reviewers"
                      @change="toggleDistinct(row)"
                    />
                  </label>
                </td>

                <td v-if="category === 'ticket_category'">
                  <select
                    :value="row.meta.default_assignee_id || ''"
                    @change="setDefaultAssignee(row, $event.target.value)"
                  >
                    <option value="">— none —</option>
                    <option
                      v-for="e in refData.employees.filter((emp) => emp.active)"
                      :key="e.id" :value="e.id"
                    >
                      {{ e.name }}
                    </option>
                  </select>
                </td>

                <td class="nowrap">
                  <button class="small" @click="reorder(row, -15)">↑</button>
                  <button class="small" @click="reorder(row, 15)">↓</button>
                </td>
                <td>
                  <span :class="['pill', row.retired ? 'slate' : 'green']">
                    {{ row.retired ? 'Retired' : 'Active' }}
                  </span>
                </td>
                <td class="right nowrap">
                  <button class="small" @click="toggleRetired(row)">
                    {{ row.retired ? 'Restore' : 'Retire' }}
                  </button>
                  <button class="small danger" @click="remove(row)">Delete</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="row" style="margin-top: 12px">
          <input
            v-model="newLabel[category]" placeholder="New value label"
            style="max-width: 280px" @keyup.enter="addValue(category)"
          />
          <button @click="addValue(category)">Add</button>
        </div>
      </div>

      <!-- ------------------------------------------------------ staff -->
      <div class="card">
        <div class="row" style="margin-bottom: 12px">
          <h2 style="margin: 0">Staff accounts</h2>
          <div class="spacer" />
          <button class="small" @click="showNewEmployee = !showNewEmployee">
            {{ showNewEmployee ? 'Cancel' : 'Add staff member' }}
          </button>
        </div>

        <form
          v-if="showNewEmployee" class="card tight" style="margin-bottom: 12px"
          @submit.prevent="createEmployee"
        >
          <div class="field-row">
            <div class="field">
              <label>Name *</label>
              <input v-model="employeeForm.name" required />
            </div>
            <div class="field">
              <label>Email *</label>
              <input v-model="employeeForm.email" type="email" required />
            </div>
            <div class="field">
              <label>Initials</label>
              <input v-model="employeeForm.initials" maxlength="6" placeholder="MB" />
            </div>
            <div class="field">
              <label>Role *</label>
              <select v-model="employeeForm.role">
                <option value="junior">Junior tech</option>
                <option value="senior">Senior tech</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div class="field">
              <label>Password * (min 10 chars)</label>
              <input v-model="employeeForm.password" type="password" minlength="10" required />
            </div>
          </div>
          <button class="primary" type="submit">Create account</button>
        </form>

        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Initials</th><th>State</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="e in refData.employees" :key="e.id">
                <td>{{ e.name }}</td>
                <td class="small muted">{{ e.email }}</td>
                <td><span class="tag">{{ e.role }}</span></td>
                <td class="small">{{ e.initials || '—' }}</td>
                <td>
                  <span :class="['pill', e.active ? 'green' : 'slate']">
                    {{ e.active ? 'Active' : 'Inactive' }}
                  </span>
                </td>
                <td class="right">
                  <button class="small" @click="toggleEmployee(e)">
                    {{ e.active ? 'Deactivate' : 'Reactivate' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
