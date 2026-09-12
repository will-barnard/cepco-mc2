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
  { token: '{customer}', description: "the ticket's customer name" },
  { token: '{nickname}', description: "the instrument's nickname, if it has one" },
  { token: '{year}', description: "the instrument's year, if known" },
  { token: '{family}', description: 'the instrument family (Piano, Rhodes, …)' },
  { token: '{model}', description: 'the specific model picked (last segment of the model path)' },
];

export const DEFAULT_NAMING_TEMPLATE = '[{customer} - ]["{nickname}"][ {year}][ {family}][ {model}]';

const NAMING_TOKENS = {
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
  return out.replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—,|]\s*/, '')
    .replace(/\s*[-–—,|]$/, '')
    .trim();
}

// A representative sample so an admin editing a template on the Settings
// page can see what it'd actually render, without needing a real ticket
// on hand. Deliberately has every token filled in (a real ticket in
// progress often won't), since the point here is showing what the
// template *does*, not modeling every empty-field edge case — those are
// exercised for real the moment a ticket is created.
export const NAMING_SAMPLE_CONTEXT = {
  customerName: 'Dolly Jones',
  nickname: 'Old Betsy',
  year: '1973',
  familyLabel: 'Rhodes',
  modelLeaf: 'Stage 73',
};
