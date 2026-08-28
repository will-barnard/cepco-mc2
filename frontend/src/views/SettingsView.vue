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
import { RouterLink } from 'vue-router';
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

// Admin-only password reset/overwrite for any staff account (including
// another admin's — requireAdmin at the route doesn't special-case the
// target's own role, so there's nothing extra to gate here). No current
// password needed, unlike AccountView.vue's self-service change — an admin
// resetting someone else's forgotten password can't know it. Only one
// row's form is open at a time.
const passwordResetFor = ref(null);
const passwordDraft = ref('');
const passwordConfirmDraft = ref('');

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

// Which ticket categories a status applies to (empty/absent meta means
// "every category" — see NOTES.md and services/settings.js). Returns null
// for "every category" rather than expanding it, so the checkbox render
// below can treat null as "show every box checked" without needing to know
// the full category list up front.
function categoriesForStatusRow(row) {
  const allowed = row.meta?.applicable_categories;
  return Array.isArray(allowed) && allowed.length ? allowed : null;
}

async function toggleStatusCategory(row, categoryKey, checked) {
  error.value = '';
  const allKeys = (settings.data.ticket_category || []).map((c) => c.key);
  const current = categoriesForStatusRow(row) ?? allKeys;
  let next = checked
    ? Array.from(new Set([...current, categoryKey]))
    : current.filter((k) => k !== categoryKey);
  // Every box checked -> collapse back to "applies to all" (empty array) so
  // a category added later automatically gets this status too, instead of
  // needing every status edited by hand.
  if (allKeys.length && allKeys.every((k) => next.includes(k))) next = [];
  try {
    await api.patch(`/settings/${row.id}`, { meta: { ...row.meta, applicable_categories: next } });
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

// Admin-only inline edits for the attributes an account is defined by
// (name, role, initials) — everything else about "who this person is" in
// the app. Each is a no-op if unchanged, mirroring the rename() pattern
// above for settings values. The server still enforces the guardrails
// (e.g. an admin can't demote/deactivate themselves — see routes/employees.js);
// that comes back through the same error banner as everything else here.
async function updateEmployeeField(emp, field, value) {
  error.value = '';
  notice.value = '';
  try {
    await api.patch(`/employees/${emp.id}`, { [field]: value });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function updateEmployeeName(emp, value) {
  const name = value.trim();
  if (!name || name === emp.name) return;
  await updateEmployeeField(emp, 'name', name);
}

async function updateEmployeeInitials(emp, value) {
  const initials = value.trim();
  if (initials === (emp.initials || '')) return;
  await updateEmployeeField(emp, 'initials', initials || null);
}

async function updateEmployeeRole(emp, value) {
  if (value === emp.role) return;
  await updateEmployeeField(emp, 'role', value);
}

function startPasswordReset(emp) {
  error.value = '';
  notice.value = '';
  passwordResetFor.value = emp.id;
  passwordDraft.value = '';
  passwordConfirmDraft.value = '';
}

function cancelPasswordReset() {
  passwordResetFor.value = null;
  passwordDraft.value = '';
  passwordConfirmDraft.value = '';
}

async function submitPasswordReset(emp) {
  error.value = '';
  notice.value = '';
  if (passwordDraft.value.length < 10) {
    error.value = 'New password must be at least 10 characters';
    return;
  }
  if (passwordDraft.value !== passwordConfirmDraft.value) {
    error.value = 'New password and confirmation do not match';
    return;
  }
  try {
    await api.patch(`/employees/${emp.id}`, { password: passwordDraft.value });
    notice.value = `Password reset for ${emp.name}. Give them the new password directly — `
      + `they weren't notified.`;
    cancelPasswordReset();
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
      <div class="row">
        <RouterLink class="btn small" :to="{ name: 'qc-templates' }">QC checklist templates →</RouterLink>
        <RouterLink class="btn small" :to="{ name: 'procedures' }">Standard procedures →</RouterLink>
        <RouterLink class="btn small" :to="{ name: 'instrument-defaults' }">
          Default instrument assignments →
        </RouterLink>
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
                <th v-if="category === 'ticket_status'">Applies to</th>
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

                <td v-if="category === 'ticket_status'">
                  <!-- Styled in styles.css (.status-category-checks), not inline: it needs a
                       mobile override (run single-line, let table-wrap's horizontal scroll
                       handle overflow) instead of the desktop wrapped/capped-width layout,
                       which on a narrow table column was squeezing every label onto its own
                       line and ballooning row height. -->
                  <div class="status-category-checks">
                    <label
                      v-for="cat in settings.active('ticket_category')" :key="cat.key"
                      class="checkbox"
                    >
                      <input
                        type="checkbox"
                        :checked="!categoriesForStatusRow(row) || categoriesForStatusRow(row).includes(cat.key)"
                        @change="toggleStatusCategory(row, cat.key, $event.target.checked)"
                      />
                      <span class="small">{{ cat.label }}</span>
                    </label>
                  </div>
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
              <template v-for="e in refData.employees" :key="e.id">
                <tr>
                  <td>
                    <input
                      :value="e.name" style="min-width: 160px"
                      @change="updateEmployeeName(e, $event.target.value)"
                    />
                  </td>
                  <td class="small muted">{{ e.email }}</td>
                  <td>
                    <select :value="e.role" @change="updateEmployeeRole(e, $event.target.value)">
                      <option value="junior">Junior tech</option>
                      <option value="senior">Senior tech</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>
                    <input
                      :value="e.initials || ''" maxlength="6" style="width: 70px" placeholder="—"
                      @change="updateEmployeeInitials(e, $event.target.value)"
                    />
                  </td>
                  <td>
                    <span :class="['pill', e.active ? 'green' : 'slate']">
                      {{ e.active ? 'Active' : 'Inactive' }}
                    </span>
                  </td>
                  <td class="right nowrap">
                    <button class="small" @click="startPasswordReset(e)">Reset password</button>
                    <button class="small" @click="toggleEmployee(e)">
                      {{ e.active ? 'Deactivate' : 'Reactivate' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="passwordResetFor === e.id">
                  <td colspan="6">
                    <form class="card tight" @submit.prevent="submitPasswordReset(e)">
                      <p class="muted small" style="margin-top: 0">
                        Setting a new password for {{ e.name }}. This overwrites their current
                        password immediately and doesn't require knowing it.
                      </p>
                      <div class="field-row">
                        <div class="field" style="margin-bottom: 0">
                          <label>New password (min 10 chars)</label>
                          <input
                            v-model="passwordDraft" type="password" minlength="10"
                            autocomplete="new-password" required
                          />
                        </div>
                        <div class="field" style="margin-bottom: 0">
                          <label>Confirm password</label>
                          <input
                            v-model="passwordConfirmDraft" type="password" minlength="10"
                            autocomplete="new-password" required
                          />
                        </div>
                      </div>
                      <div class="row" style="margin-top: 10px">
                        <button class="primary small" type="submit">Save new password</button>
                        <button class="small" type="button" @click="cancelPasswordReset">Cancel</button>
                      </div>
                    </form>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
