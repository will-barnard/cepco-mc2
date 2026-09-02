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

// QC rigor tiers used to be a category here — retired in migration 021.
// Every ticket now follows the same standardized round progression
// instead (Settings -> QC checklist templates handles that content).
const CATEGORIES = [
  ['ticket_category', 'Ticket categories'],
  ['ticket_status', 'Ticket statuses'],
  ['priority_tier', 'Priority tiers'],
  ['tech_level', 'Tech levels'],
];

const error = ref('');
const notice = ref('');
const newLabel = ref({});
// N2a: only ticket_category rows can have a parent today (the SideQuests
// tree and "Custom Shop as a sub-category" are the two things asking for
// it) — keyed by category the same way newLabel is, in case another
// category ever wants this too.
const newParentKey = ref({});

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

// N2a: values with no parent (retired ones excluded — you can't nest under
// something hidden from new tickets) offered as parent choices when adding
// or reparenting a row. Settings supports only one level of nesting
// (backend/src/services/settings.js's validateParentKey), so a value that
// already has a parent is never itself offered as one.
function topLevelOptions(category, excludeKey) {
  return (settings.data[category] || [])
    .filter((r) => !r.retired && !r.meta?.parent_key && r.key !== excludeKey);
}

// A row that already has sub-values of its own can't also become a child —
// that would chain to three levels of nesting, which validateParentKey on
// the backend refuses (see settings.js). Used to swap the parent picker for
// plain text on rows this applies to, rather than showing choices that
// would just be rejected.
function hasChildren(category, key) {
  return (settings.data[category] || []).some((r) => r.meta?.parent_key === key);
}

async function addValue(category) {
  error.value = '';
  notice.value = '';
  const label = (newLabel.value[category] || '').trim();
  if (!label) return;
  try {
    const rows = settings.data[category] || [];
    const parentKey = newParentKey.value[category] || null;
    await api.post('/settings', {
      category,
      label,
      sort_order: (rows[rows.length - 1]?.sort_order || 0) + 10,
      ...(parentKey ? { meta: { parent_key: parentKey } } : {}),
    });
    newLabel.value[category] = '';
    newParentKey.value[category] = '';
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

async function setParent(row, parentKey) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, { meta: { ...row.meta, parent_key: parentKey || null } });
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

// Per-category "Ship this instrument" quick-action visibility (see
// stores.js's shipButtonAllowed) — same meta-on-the-category-row storage as
// setDefaultAssignee above, just a plain boolean instead of an id.
async function toggleShipButton(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, hide_ship_button: !row.meta.hide_ship_button },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Per-category visibility in the Queue page's "By category" picker (see
// stores.js's categoriesForQueuePicker) — same meta-on-the-category-row
// storage as toggleShipButton above. Meant for narrowing that picker down
// to "catch-all" categories that don't usually carry an instrument
// (Shipping, Daily To-Do's, ...); instrument-tied categories (Servicing,
// Inventory Restorations) are better browsed by instrument family instead.
async function toggleQueuePicker(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, hide_from_category_queue: !row.meta.hide_from_category_queue },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Per-category "Status notes" (Service done / Service needed) visibility on
// the ticket detail page — see stores.js's statusNotesAllowed. Same pattern
// as toggleShipButton, just the opposite starting value (off by default).
async function toggleStatusNotes(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, show_status_notes: !row.meta.show_status_notes },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Per-category "Customer progress update" card visibility on the ticket
// detail page (see stores.js's progressUpdateAllowed) — same pattern and
// same starting value (on by default) as toggleShipButton. Shipping
// tickets are hidden separately via is_shipping, not through this.
async function toggleProgressUpdate(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, hide_progress_update: !row.meta.hide_progress_update },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Per-priority "Highlight in tasks" toggle on the dashboard's My tasks
// card (see stores.js's highlightTasksForPriority) — same pattern as
// toggleStatusNotes, off by default.
async function toggleHighlightTasks(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, highlight_in_tasks: !row.meta.highlight_in_tasks },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Per-status "Unlocks tasks" flag (migration 022, NOTES.md §2.28) — whether
// a ticket sitting in this status has its tasks surfaced on anyone's
// dashboard (stores.js's unlocksTasks). Same on/off-meta-flag pattern as
// every toggle above, just scoped to ticket_status rows instead of
// ticket_category ones.
async function toggleUnlocksTasks(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, unlocks_tasks: !row.meta.unlocks_tasks },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

// Which ticket categories a status is EXCLUDED from (empty/absent meta
// means "every category" — see NOTES.md and services/settings.js). A
// denylist, not an allowlist (N4a) — unchecking a box means "this category
// is excluded," so a category added later in Settings is unaffected by
// this status's existing exclusions and stays available by default,
// instead of needing every status edited by hand to pick it up.
function excludedCategoriesForStatusRow(row) {
  const excluded = row.meta?.excluded_categories;
  return Array.isArray(excluded) && excluded.length ? excluded : [];
}

async function toggleStatusCategory(row, categoryKey, checked) {
  error.value = '';
  const current = excludedCategoriesForStatusRow(row);
  // Checked means "applies to this category," i.e. NOT excluded.
  const next = checked
    ? current.filter((k) => k !== categoryKey)
    : Array.from(new Set([...current, categoryKey]));
  try {
    await api.patch(`/settings/${row.id}`, { meta: { ...row.meta, excluded_categories: next } });
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
        <RouterLink class="btn small" :to="{ name: 'recurring-tickets' }">Recurring tickets →</RouterLink>
        <RouterLink class="btn small" :to="{ name: 'instrument-models' }">Instrument models →</RouterLink>
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
                <th v-if="category === 'ticket_category'">Parent</th>
                <th v-if="category === 'ticket_category'">Default assignee</th>
                <th v-if="category === 'ticket_category'">Ship button</th>
                <th v-if="category === 'ticket_category'">Progress update</th>
                <th v-if="category === 'ticket_category'">Status notes</th>
                <th v-if="category === 'ticket_category'">Queue picker</th>
                <th v-if="category === 'ticket_status'">Applies to</th>
                <th v-if="category === 'ticket_status'">Unlocks tasks</th>
                <th v-if="category === 'priority_tier'">Highlight in tasks</th>
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

                <td v-if="category === 'ticket_category'">
                  <select
                    v-if="!hasChildren(category, row.key)"
                    :value="row.meta.parent_key || ''"
                    @change="setParent(row, $event.target.value)"
                  >
                    <option value="">— top level —</option>
                    <option
                      v-for="p in topLevelOptions(category, row.key)"
                      :key="p.key" :value="p.key"
                    >
                      {{ p.label }}
                    </option>
                  </select>
                  <!-- A row that's already a parent of something else can't
                       become a child itself (one level of nesting only —
                       see validateParentKey) — shown as plain text instead
                       of a picker that would just reject every choice. -->
                  <span v-else class="muted small">— top level —</span>
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

                <td v-if="category === 'ticket_category'">
                  <label class="checkbox" title="Show the &quot;Ship this instrument&quot; quick-action on tickets in this category">
                    <input
                      type="checkbox" :checked="!row.meta.hide_ship_button"
                      @change="toggleShipButton(row)"
                    />
                  </label>
                </td>

                <td v-if="category === 'ticket_category'">
                  <label class="checkbox" title="Show the &quot;Customer progress update&quot; card on tickets in this category">
                    <input
                      type="checkbox" :checked="!row.meta.hide_progress_update"
                      @change="toggleProgressUpdate(row)"
                    />
                  </label>
                </td>

                <td v-if="category === 'ticket_category'">
                  <label class="checkbox" title="Show the Status notes fields (Service done / Service needed) on tickets in this category">
                    <input
                      type="checkbox" :checked="!!row.meta.show_status_notes"
                      @change="toggleStatusNotes(row)"
                    />
                  </label>
                </td>

                <td v-if="category === 'ticket_category'">
                  <label class="checkbox" title="Show this category as its own queue on the Queue page's &quot;By category&quot; picker">
                    <input
                      type="checkbox" :checked="!row.meta.hide_from_category_queue"
                      @change="toggleQueuePicker(row)"
                    />
                  </label>
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
                        :checked="!excludedCategoriesForStatusRow(row).includes(cat.key)"
                        @change="toggleStatusCategory(row, cat.key, $event.target.checked)"
                      />
                      <span class="small">{{ cat.label }}</span>
                    </label>
                  </div>
                </td>

                <td v-if="category === 'ticket_status'">
                  <label class="checkbox" title="Surface this status's tickets' tasks on techs' dashboards (My tasks)">
                    <input
                      type="checkbox" :checked="!!row.meta.unlocks_tasks"
                      @change="toggleUnlocksTasks(row)"
                    />
                  </label>
                </td>

                <td v-if="category === 'priority_tier'">
                  <label class="checkbox" title="Pull this priority's tasks into their own separate box on the dashboard's My tasks card">
                    <input
                      type="checkbox" :checked="!!row.meta.highlight_in_tasks"
                      @change="toggleHighlightTasks(row)"
                    />
                  </label>
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
          <select v-if="category === 'ticket_category'" v-model="newParentKey[category]">
            <option value="">— top level —</option>
            <option v-for="p in topLevelOptions(category)" :key="p.key" :value="p.key">
              Under: {{ p.label }}
            </option>
          </select>
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
              <tr>
                <th>Name</th><th>Email</th><th>Role</th><th>Initials</th>
                <th title="Weekly chore rotation (A2) skips anyone checked here">Skip chores</th>
                <th>State</th><th />
              </tr>
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
                    <input
                      type="checkbox" :checked="e.excluded_from_chore_rotation"
                      @change="updateEmployeeField(e, 'excluded_from_chore_rotation', $event.target.checked)"
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
                  <td colspan="7">
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
