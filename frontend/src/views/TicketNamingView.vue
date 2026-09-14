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
 * Each category's own template/enforced flag lives in the same
 * ticket_category settings row every other per-category toggle already
 * does (meta.naming_template / meta.naming_enforced) — see migration 056
 * for the default every existing category was seeded with. Subcategories
 * (meta.parent_key set — SideQuests' Hunt/R&D/etc.) don't get their own
 * row here: a ticket's title always comes from its top-level category's
 * template, never its subcategory's.
 */
import { reactive, computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import api from '../api';
import { useSettings } from '../stores';
import { DEFAULT_NAMING_TEMPLATE, NAMING_TOKEN_HELP, NAMING_SAMPLE_CONTEXT, renderNamingTemplate } from '../ticketNaming';

const settings = useSettings();
const loading = ref(true);
const error = ref('');

const categories = computed(() => settings.active('ticket_category').filter((r) => !r.meta?.parent_key));

// Local editable copy of each row's template, keyed by settings row id --
// kept separate from the store so the preview below updates as someone
// types, without saving (and re-rendering every other admin's screen)
// on every keystroke. Only actually PATCHes on blur/enter, same as every
// other inline-editable field in Settings (see ProceduresView.vue's
// updateField for the same :value/@change convention).
const drafts = reactive({});

async function refresh() {
  await settings.load(true);
  for (const row of categories.value) {
    if (!(row.id in drafts)) drafts[row.id] = row.meta.naming_template || '';
  }
}

onMounted(async () => {
  await refresh();
  loading.value = false;
});

function previewFor(row) {
  const template = drafts[row.id];
  // categoryLabel comes from the row itself rather than a made-up sample
  // -- {category} always resolves to a ticket's real category, so showing
  // the real label here previews exactly what {category} will render.
  return renderNamingTemplate(template, { ...NAMING_SAMPLE_CONTEXT, categoryLabel: row.label });
}

async function saveTemplate(row, value) {
  error.value = '';
  drafts[row.id] = value;
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, naming_template: value.trim() || null },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}

function resetTemplate(row) {
  saveTemplate(row, '');
}

async function toggleEnforced(row) {
  error.value = '';
  try {
    await api.patch(`/settings/${row.id}`, {
      meta: { ...row.meta, naming_enforced: !row.meta.naming_enforced },
    });
    await refresh();
  } catch (err) {
    error.value = err.message;
  }
}
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
        <code>{ticket_name}</code> only does anything once "Standardize" is on below -- turn it on,
        then work <code>{ticket_name}</code> into the template (e.g.
        <code>{category}: {ticket_name}</code> → "Housekeeping: Mop the floors") to let someone
        type a short name for the ticket instead of it coming entirely from the customer/instrument.
        The New Ticket form only shows that free-text field once the template actually uses it.
      </p>
    </div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else class="stack">
      <div v-for="row in categories" :key="row.id" class="card">
        <div class="row" style="margin-bottom: 8px">
          <h2 style="margin: 0">{{ row.label }}</h2>
          <div class="spacer" />
          <label
            class="checkbox"
            title="Nobody can type a whole title for this category -- the template above is all of it, unless the template itself includes {ticket_name}"
          >
            <input type="checkbox" :checked="!!row.meta.naming_enforced" @change="toggleEnforced(row)" />
            Standardize (generated name)
          </label>
        </div>

        <label>Template</label>
        <div class="row">
          <input
            :value="drafts[row.id]" style="flex: 1" :placeholder="DEFAULT_NAMING_TEMPLATE"
            @input="drafts[row.id] = $event.target.value"
            @change="saveTemplate(row, $event.target.value)"
          />
          <button
            v-if="drafts[row.id]" type="button" class="small" title="Clear back to the default template"
            @click="resetTemplate(row)"
          >Reset</button>
        </div>

        <p class="muted small" style="margin: 6px 0 0">
          Preview (sample instrument): <strong>{{ previewFor(row) || '(nothing — try adding a token)' }}</strong>
        </p>
      </div>
    </div>
  </div>
</template>
