/**
 * Ticket naming panel — a client-side mirror of backend/src/routes/
 * tickets.js's renderNamingTemplate/DEFAULT_NAMING_TEMPLATE, kept here so
 * SettingsView's naming panel (TicketNamingView.vue) and the New Ticket
 * form (TicketNewView.vue) can both show a live preview of a category's
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
  { token: '{ticket_name}', description: 'free text typed for this ticket (see "Standardize" below)' },
  { token: '{customer}', description: "the ticket's customer name" },
  { token: '{nickname}', description: "the instrument's nickname, if it has one" },
  { token: '{year}', description: "the instrument's year, if known" },
  { token: '{family}', description: 'the instrument family (Piano, Rhodes, …)' },
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
  return out.replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—,:|]\s*/, '')
    .replace(/\s*[-–—,:|]$/, '')
    .trim();
}

// True when `template` actually references `{token}` -- used to decide
// whether a category's own naming UI needs to show anything for that
// token at all (e.g. TicketNewView.vue's free-text "Name" field only
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
