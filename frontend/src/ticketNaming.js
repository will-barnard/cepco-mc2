/**
 * Ticket naming panel — a client-side mirror of backend/src/routes/
 * tickets.js's renderNamingTemplate/DEFAULT_NAMING_TEMPLATE, kept here so
 * SettingsView's naming panel (TicketNamingView.vue) and the New Ticket
 * form (NewTicketForm.vue) can both show a live preview of a category's
 * template without a round trip to the server. The actual title a ticket
 * gets still always comes from the backend (composeTicketTitle) — this is
 * preview-only, so a drift between the two would only ever misdraw a
 * preview, never save the wrong thing.
 *
 * Template syntax: `{token}` substitutes a value (empty string if that
 * piece isn't on this ticket/sample), and a `[...]` group is dropped in
 * its entirety — including any literal punctuation inside it — unless at
 * least one token inside it has a value. Groups don't nest. See the
 * backend copy of this file for the full reasoning.
 */

export const NAMING_TOKEN_HELP = [
  { token: '{category}', description: "the ticket's category name" },
  { token: '{ticket_name}', description: 'a short name typed for this ticket (Standardize mode) — e.g. what\'s being shipped, or a Shopify order #' },
  { token: '{customer}', description: "the ticket's customer name" },
  { token: '{nickname}', description: "the instrument's nickname, if it has one" },
  { token: '{year}', description: "the instrument's year, if known" },
  { token: '{family}', description: 'the instrument brand (Rhodes, Wurlitzer, …)' },
  { token: '{model}', description: 'the specific model picked (last segment of the model path)' },
];

export const DEFAULT_NAMING_TEMPLATE = '[{customer} - ]["{nickname}"][ {year}][ {family}][ {model}]';

const NAMING_TOKENS = {
  category: (ctx) => ctx.categoryLabel,
  ticket_name: (ctx) => ctx.ticketName,
  customer: (ctx) => ctx.customerName,
  nickname: (ctx) => ctx.nickname,
  year: (ctx) => ctx.year,
  family: (ctx) => ctx.familyLabel,
  model: (ctx) => ctx.modelLeaf,
};

export function renderNamingTemplate(template, ctx) {
  let out = String(template || DEFAULT_NAMING_TEMPLATE).replace(/\[([^[\]]*)\]/g, (_, inner) => {
    let any = false;
    const rendered = inner.replace(/\{(\w+)\}/g, (m, name) => {
      const val = (NAMING_TOKENS[name] ? NAMING_TOKENS[name](ctx) : '') || '';
      if (val) any = true;
      return val;
    });
    return any ? rendered : '';
  });
  out = out.replace(/\{(\w+)\}/g, (m, name) => (NAMING_TOKENS[name] ? NAMING_TOKENS[name](ctx) : '') || '');
  // ':' joins the strip set alongside the original dash/comma/pipe --
  // {category}: {ticket_name} is exactly the shape this feature exists
  // for, and a blank {ticket_name} used to leave a dangling "Category:"
  // behind (migration 057).
  // Migration 062: "Shipping: - Joe Biden" (a blank token right after a
  // colon) collapses to "Shipping: Joe Biden" -- same as the backend.
  return out.replace(/\s+/g, ' ')
    .replace(/:\s*[-–—,|]\s*/g, ': ')
    .trim()
    .replace(/^[-–—,:|]\s*/, '')
    .replace(/\s*[-–—,:|]$/, '')
    .trim();
}

// True when `template` actually references `{token}` -- used to decide
// whether a category's own naming UI needs to show anything for that
// token at all (e.g. NewTicketForm.vue's free-text "Name" field only
// appears for a Standardize category whose template uses {ticket_name} --
// no point showing an input that would render into nothing).
export function templateUsesToken(template, token) {
  return new RegExp(`\\{${token}\\}`).test(String(template || DEFAULT_NAMING_TEMPLATE));
}

// A representative sample so an admin editing a template on the Settings
// page can see what it'd actually render, without needing a real ticket
// on hand. Deliberately has every token filled in (a real ticket in
// progress often won't), since the point here is showing what the
// template *does*, not modeling every empty-field edge case — those are
// exercised for real the moment a ticket is created. categoryLabel is
// left out here (TicketNamingView.vue fills in each row's own real label
// instead, which previews better than a made-up one).
export const NAMING_SAMPLE_CONTEXT = {
  customerName: 'Dolly Jones',
  nickname: 'Old Betsy',
  year: '1973',
  familyLabel: 'Rhodes',
  modelLeaf: 'Stage 73',
  ticketName: 'Mop the floors',
};

// Per-row sample name for {ticket_name} in the Settings preview -- "Mop
// the floors" reads oddly under "What's being shipped" or "Order #".
export function sampleTicketName(nameLabel) {
  if (/order/i.test(nameLabel || '')) return '#1001';
  if (/ship/i.test(nameLabel || '')) return 'Rhodes Stage 73';
  return NAMING_SAMPLE_CONTEXT.ticketName;
}

// Migration 062: how the New Ticket form's Title box uses a template.
export const NAMING_MODES = [
  {
    value: 'suggest',
    label: 'Suggest',
    description: 'Type any title; left blank, the template is used.',
  },
  {
    value: 'prefill',
    label: 'Pre-fill',
    description: 'The Title box starts with the template (e.g. "To-Do: ") and you type the rest. The prefix can be deleted.',
  },
  {
    value: 'standardize',
    label: 'Standardize',
    description: 'The template is the title, locked. {ticket_name} is the one thing typed.',
  },
];

/** A row's mode, falling back to the pre-062 naming_enforced flag. */
export function namingModeOf(meta) {
  if (NAMING_MODES.some((m) => m.value === meta?.naming_mode)) return meta.naming_mode;
  return meta?.naming_enforced ? 'standardize' : 'suggest';
}

/**
 * The text a Pre-fill category's Title box starts with: the rendered
 * template, keeping the trailing separator the normal renderer strips
 * ("To-Do:" -> "To-Do: "), so the cursor lands where the name goes.
 */
export function renderPrefill(template, ctx) {
  const rendered = renderNamingTemplate(template, ctx);
  if (!rendered) return '';
  const trailing = /([:\-–—|,])\s*$/.exec(String(template || '').trim());
  return trailing && !rendered.endsWith(trailing[1]) ? `${rendered}${trailing[1]} ` : `${rendered} `;
}

/** The bare prefix a Pre-fill title must add something to ("To-Do"). */
export function prefillPrefix(template, ctx) {
  return renderNamingTemplate(template, ctx);
}

/** "Rhodes Mark I" -- the brand + model a Standardize template's name box
 * can be pre-filled with (meta.naming_name_from_instrument). */
export function instrumentShortName(familyLabel, model) {
  const segments = String(model || '').split('/').map((x) => x.trim()).filter(Boolean);
  return [familyLabel, segments[segments.length - 1]].filter(Boolean).join(' ');
}
