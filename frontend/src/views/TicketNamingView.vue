<script setup>
/**
 * Ticket naming panel (Settings -> Ticket naming). Lets an admin design a
 * per-category title template — routes/tickets.js's composeTicketTitle
 * renders it for a new ticket whose title wasn't typed by hand, and PATCH
 * /tickets/:id keeps it in sync afterward for any category that's opted
 * into "Standardize" below. NewTicketForm.vue shows the same live preview
 * while someone's filling out a new ticket, reading the exact same
 * template through stores.js's namingTemplateFor.
 *
 * migration 057 added two tokens beyond customer/instrument:
 * {category} (that category's own label, always available) and
 * {ticket_name} (a free-typed slot, e.g. `{category}: {ticket_name}` ->
 * "Housekeeping: Mop the floors") -- the one way a Standardize category
 * can still carry someone's own words instead of only auto-derived
 * pieces. ticket_name lives on the ticket itself (not this row's meta),
 * since it's per-ticket; NewTicketForm.vue only shows an input for it
 * once a category is both Standardize and actually uses the token
 * (stores.js's namingTemplateUsesTicketName).
 *
 * Only applies going forward: saving a template here, or turning
 * Standardize on/off, never touches a ticket that already exists — there's
 * no bulk "rename everything in this category" action, deliberately, since
 * a free-naming category's existing titles were typed by hand and aren't
 * this page's business to overwrite.
 *
 * Each category's own template/mode lives in the same ticket_category
 * settings row every other per-category toggle already does
 * (meta.naming_template / meta.naming_mode) — see migration 056 for the
 * default every existing category was seeded with.
 *
 * Migration 062 added:
 *   - three modes instead of the Standardize on/off (Suggest / Pre-fill /
 *     Standardize -- ticketNaming.js's NAMING_MODES); naming_enforced is
 *     still written alongside, true exactly for Standardize.
 *   - sub-categories listed under their parent, each able to carry its
 *     own template (Orders & Shipping -> Shipping / Shopify / uShip). A
 *     sub-category with no template of its own uses its parent's.
 *   - per-row label for the {ticket_name} box ("What's being shipped",
 *     "Order #"), and whether to pre-fill it from the instrument.
 */
import { reactive, computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings } from '../stores';
import {
  DEFAULT_NAMING_TEMPLATE, NAMING_TOKEN_HELP, NAMING_SAMPLE_CONTEXT, NAMING_MODES,
  renderNamingTemplate, renderPrefill, namingModeOf, templateUsesToken, sampleTicketName,
} from '../ticketNaming';

const settings = useSettings();
const loading = ref(true);
const error = ref('');

// Top-level categories, each followed by its own sub-categories.
const rows = computed(() => {
  const active = settings.active('ticket_category');
  const out = [];
  for (const parent of active.filter((r) => !r.meta?.parent_key)) {
    out.push({ row: parent, parent: null });
    for (const child of active.filter((r) => r.meta?.parent_key === parent.key)) {
      out.push({ row: child, parent });
    }
  }
  return out;
});

// Local editable copy of each row's template (and name label), keyed by
// settings row id -- kept separate from the store so the preview updates
// as someone types, without saving on every keystroke. Only PATCHes on
// change (blur/enter), same as every other inline-editable Settings field.
const drafts = reactive({});
const labelDrafts = reactive({});

async function refresh() {
  await settings.load(true);
  for (const { row } of rows.value) {
    if (!(row.id in drafts)) drafts[row.id] = row.meta.naming_template || '';
    if (!(row.id in labelDrafts)) labelDrafts[row.id] = row.meta.naming_name_label || '';
  }
}

onMounted(async () => {
  await refresh();
  loading.value = false;
});

// A sub-category with no template of its own is named by its parent's.
function inheritsFromParent(entry) {
  return Boolean(entry.parent) && !drafts[entry.row.id];
}

function effectiveMeta(entry) {
  return inheritsFromParent(entry) ? entry.parent.meta : entry.row.meta;
}

function modeOf(entry) {
  return namingModeOf(effectiveMeta(entry));
}

function templateOf(entry) {
  return inheritsFromParent(entry) ? (drafts[entry.parent.id] || '') : drafts[entry.row.id];
}

function usesName(entry) {
  return modeOf(entry) === 'standardize' && templateUsesToken(templateOf(entry), 'ticket_name');
}

function previewFor(entry) {
  const template = templateOf(entry);
  // categoryLabel is the real top-level label -- {category} always
  // resolves to a ticket's real category, never its sub-category.
  const categoryLabel = (entry.parent || entry.row).label;
  const nameLabel = inheritsFromParent(entry) ? labelDrafts[entry.parent.id] : labelDrafts[entry.row.id];
  const ctx = { ...NAMING_SAMPLE_CONTEXT, categoryLabel, ticketName: sampleTicketName(nameLabel) };
  if (modeOf(entry) === 'prefill') {
    const start = renderPrefill(template, { categoryLabel });
    return start ? `${start}…  (the rest is typed)` : '';
  }
  return renderNamingTemplate(template, ctx);
}

async function patchMeta(row, changes) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, { meta: { ...row.meta, ...changes } });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

function saveTemplate(entry, value) {
  drafts[entry.row.id] = value;
  const changes = { naming_template: value.trim() || null };
  // A sub-category getting its first template of its own starts from the
  // parent's mode, rather than silently dropping back to Suggest.
  if (entry.parent && value.trim() && !entry.row.meta.naming_mode) {
    const mode = namingModeOf(entry.parent.meta);
    Object.assign(changes, { naming_mode: mode, naming_enforced: mode === 'standardize' });
  }
  patchMeta(entry.row, changes);
}

function resetTemplate(entry) {
  saveTemplate(entry, '');
}

function setMode(entry, mode) {
  patchMeta(entry.row, { naming_mode: mode, naming_enforced: mode === 'standardize' });
}

function saveNameLabel(entry, value) {
  labelDrafts[entry.row.id] = value;
  patchMeta(entry.row, { naming_name_label: value.trim() || null });
}

function toggleNameFromInstrument(entry) {
  patchMeta(entry.row, { naming_name_from_instrument: !entry.row.meta.naming_name_from_instrument });
}

const modeHelp = (mode) => NAMING_MODES.find((m) => m.value === mode)?.description || '';
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 style="margin-bottom: 4px">Ticket naming</h1>
        <p class="muted small" style="margin: 0">
          Design how each category's tickets get named, and whether a technician can still type
          their own title or has to use the generated one.
        </p>
      </div>
      <RouterLink class="btn small" :to="{ name: 'settings' }">← Settings</RouterLink>
    </div>

    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>

    <div class="card" style="margin-bottom: 16px">
      <h2>How templates work</h2>
      <p class="muted small">
        <code>{token}</code> is replaced with a value, or nothing if this ticket doesn't have that
        piece. Wrap a chunk in <code>[…]</code> to drop it entirely — including any punctuation
        typed inside it — whenever every token inside it is empty. That's how the default template
        below only shows a dash when there's a customer, and only shows quotes when there's a
        nickname.
      </p>
      <div class="table-wrap" style="margin-bottom: 10px">
        <table>
          <tbody>
            <tr v-for="t in NAMING_TOKEN_HELP" :key="t.token">
              <td><code>{{ t.token }}</code></td>
              <td class="muted small">{{ t.description }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="muted small" style="margin-bottom: 0">
        Default, used by any category that hasn't set its own:
        <code>{{ DEFAULT_NAMING_TEMPLATE }}</code>
      </p>
      <p class="muted small" style="margin: 8px 0 0">
        <strong>Title box</strong> decides how the New Ticket form uses the template:
        <em>Suggest</em> — type anything, blank uses the template;
        <em>Pre-fill</em> — the box starts with the template (e.g. <code>To-Do:</code> → "To-Do: ")
        and the rest is typed; <em>Standardize</em> — the template is the title, locked.
        In Standardize, <code>{ticket_name}</code> adds one typed box to the form (e.g.
        <code>Shipping: {ticket_name}[ - {customer}]</code>, with the box labelled
        "What's being shipped").
        A sub-category with no template of its own uses its parent's.
      </p>
    </div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else class="stack">
      <div
        v-for="entry in rows" :key="entry.row.id" class="card"
        :class="{ 'naming-child': entry.parent }"
      >
        <div class="row" style="margin-bottom: 8px">
          <h2 style="margin: 0">
            <span v-if="entry.parent" class="muted">{{ entry.parent.label }} › </span>{{ entry.row.label }}
          </h2>
          <div class="spacer" />
          <label class="small muted" style="margin: 0">Title box</label>
          <select
            :value="modeOf(entry)" style="width: auto" :disabled="inheritsFromParent(entry)"
            :title="inheritsFromParent(entry) ? `Uses ${entry.parent.label}'s format — give it a template of its own to change this` : modeHelp(modeOf(entry))"
            @change="setMode(entry, $event.target.value)"
          >
            <option v-for="m in NAMING_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
        </div>
        <p class="muted small" style="margin: 0 0 8px">{{ modeHelp(modeOf(entry)) }}</p>

        <label>Template</label>
        <div class="row">
          <input
            :value="drafts[entry.row.id]" style="flex: 1"
            :placeholder="entry.parent ? `(uses ${entry.parent.label}'s: ${drafts[entry.parent.id] || DEFAULT_NAMING_TEMPLATE})` : DEFAULT_NAMING_TEMPLATE"
            @input="drafts[entry.row.id] = $event.target.value"
            @change="saveTemplate(entry, $event.target.value)"
          />
          <button
            v-if="drafts[entry.row.id]" type="button" class="small"
            :title="entry.parent ? `Clear back to ${entry.parent.label}'s format` : 'Clear back to the default template'"
            @click="resetTemplate(entry)"
          >Reset</button>
        </div>

        <div v-if="usesName(entry) && !inheritsFromParent(entry)" class="field-row" style="margin-top: 10px; align-items: end">
          <div class="field" style="margin: 0">
            <label>Label for the {ticket_name} box</label>
            <input
              :value="labelDrafts[entry.row.id]" placeholder="Name"
              @input="labelDrafts[entry.row.id] = $event.target.value"
              @change="saveNameLabel(entry, $event.target.value)"
            />
          </div>
          <label class="checkbox" style="margin: 0 0 8px">
            <input
              type="checkbox" :checked="!!entry.row.meta.naming_name_from_instrument"
              @change="toggleNameFromInstrument(entry)"
            />
            <span class="small">Pre-fill it with the instrument's brand + model</span>
          </label>
        </div>

        <p class="muted small" style="margin: 6px 0 0">
          Preview (sample instrument): <strong>{{ previewFor(entry) || '(nothing — try adding a token)' }}</strong>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.naming-child { margin-left: 24px; }
</style>
