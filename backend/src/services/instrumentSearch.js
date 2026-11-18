'use strict';

/**
 * Instrument finder (NOTES.md §2.112) -- GET /api/instruments/search.
 *
 * Built for the inventory audit: someone is standing at a piece reading a
 * hand-written tag, and the tag says one of three things -- what the
 * instrument is ("Mk I Stage 73"), whose it is ("Henderson"), or what the
 * customer calls it ("Dave's Wurli", "Big Red"). This searches every
 * instrument in mc2, not just shop stock: customers' pieces in for service,
 * consignments and pieces the shop has sold are all things a tag can be on.
 *
 * A name on a tag isn't always the current owner, so a piece also matches
 * on everyone it's been tied to: previous owners and consignors (the
 * ownership ledger, migration 087), who the shop bought it from
 * (instrument_purchases.seller_name -- a shop piece is often still tagged
 * with the seller's name), who it was sold to, and its ticket titles (which
 * are composed as "Client "Nickname" Model", so they carry names the
 * instrument row may not).
 *
 * Matching: the query is split into words and EVERY word has to appear
 * somewhere on the piece (any field), so "henderson wurli" finds Henderson's
 * Wurlitzer and not every Wurlitzer. Words are substring-matched against a
 * normalised haystack (lower case, punctuation -> spaces), which is why
 * "O'Brien" and "obrien"-style tags both land. On top of that:
 *   - possessives and plurals are folded ("Dave's", "Hendersons" -> dave, henderson);
 *   - "Mk1" / "Mark I" / "mk 1" all mean the same Mark, matched as whole
 *     words so "Mark I" doesn't also match Mark II;
 *   - "Wurli" / "Wurly" match Wurlitzer;
 *   - a stock-number-shaped query ("R-0042", "w42") matches the row id, like
 *     InventoryView's search.
 * Ranking is done here rather than in SQL so the "Matched on" explanation
 * and the order come from the same rules: pieces that are probably in the
 * building (shop stock, live consignments, anything with an open ticket)
 * first, then by how strong the matching fields are (a nickname or current
 * owner outranks a note or an old ticket title).
 *
 * No migration, no extension: at a few thousand instruments a sequential
 * scan with per-row aggregates is a few milliseconds. If it ever isn't,
 * the fix is a stored/trigram-indexed haystack, not a different API.
 */

const { query } = require('../db');
const catalog = require('./instrumentCatalog');
const inv = require('./inventory');

// Keep a query from turning into a 40-clause WHERE.
const MAX_TERMS = 8;
const CANDIDATE_LIMIT = 300;
const RESULT_LIMIT = 100;

const ROMAN = { 1: 'i', 2: 'ii', 3: 'iii', 5: 'v' };
const DIGIT_OF = { i: 1, ii: 2, iii: 3, v: 5 };

// Tag spellings of family names. Each word becomes "any of these".
const ALIASES = {
  wurli: ['wurl'], wurly: ['wurl'], wurlie: ['wurl'], wurlys: ['wurl'], wurlis: ['wurl'],
  fender: ['fender', 'rhodes'],
};

// Accents folded in SQL with translate() (no unaccent extension needed);
// JS folds every combining mark, which covers the same letters and more.
const ACCENTED = 'áàâäãåāéèêëēíìîïīóòôöõøōúùûüūñçýÿ';
const PLAIN = 'aaaaaaaeeeeeiiiiiooooooouuuuuncyy';
// Same length or translate() shifts every later letter by one.
if ([...ACCENTED].length !== PLAIN.length) throw new Error('instrumentSearch: ACCENTED/PLAIN length mismatch');

/**
 * Same normalisation the SQL haystack gets: lower case, accents folded,
 * apostrophes dropped (so "O'Brien" is "obrien" and "Dave's" is "daves"),
 * every other run of non-letters/digits collapsed to one space, padded with
 * a space each side so ' mk1 ' can be matched as a whole word.
 */
function normText(s) {
  const t = String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return t ? ` ${t} ` : ' ';
}

/** Needles that mean Mark `n` (1, 2, 3, 5, 7, 8), as whole words. */
function markNeedles(n) {
  const r = ROMAN[n];
  const forms = [`mk${n}`, `mark ${n}`, `mk ${n}`, `mark${n}`];
  if (r) forms.push(`mark ${r}`, `mk ${r}`, `mk${r}`);
  return forms.map((f) => ` ${f} `);
}

/**
 * The query -> { terms: [[needle, ...], ...], stockId, words }.
 * A row matches when, for every term, the haystack contains at least one
 * of that term's needles.
 */
function parseQuery(raw) {
  const q = String(raw ?? '').trim().slice(0, 200);
  const out = { terms: [], stockId: null, words: [] };
  if (!q) return out;

  // "R-0042" / "w42" / "K-0042": a family letter plus the row id. The
  // letter is required -- a bare "73" is a key count, not a stock number.
  const stock = /^([a-z])\s*-?\s*0*(\d{1,7})$/i.exec(q);
  if (stock) out.stockId = Number(stock[2]);

  // Possessive off ("Dave's" -> "dave"), then the haystack's own folding.
  let s = q.toLowerCase().replace(/['’`]s\b/g, '').normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/['’`]/g, '');

  // Marks first, so "mark i" isn't left as "mark" + a dropped "i".
  s = s.replace(/\b(?:mark|mk)\s*-?\s*(iii|ii|i|v|[1-35-8])\b/g, (_, n) => {
    const digit = DIGIT_OF[n] || Number(n);
    out.terms.push(markNeedles(digit));
    out.words.push(`mk${digit}`);
    return ' ';
  });

  for (let w of s.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    // A lone letter ("O" from O'Brien, "s" from a stray possessive)
    // matches nearly everything; a lone digit ("Mark 7" handled above,
    // "Model 7") is still worth keeping.
    if (w.length === 1 && !/\d/.test(w)) continue;
    // Plurals / possessives without an apostrophe: "hendersons" -> "henderson".
    // Substring matching means the shorter word still finds the longer one.
    if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.terms.push(ALIASES[w] || [w]);
    out.words.push(w);
  }

  // Dedupe identical terms ("rhodes rhodes"), then cap.
  const seen = new Set();
  out.terms = out.terms.filter((t) => {
    const k = t.join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_TERMS);
  return out;
}

// SQL version of normText for a text expression.
// translate() deletes characters with no partner in the second string,
// which is how the apostrophes (straight, curly, backtick) are dropped.
const sqlNorm = (expr) => `(' ' || regexp_replace(
    translate(lower(${expr}), '${ACCENTED}''’\`', '${PLAIN}'),
    '[^[:alnum:]]+', ' ', 'g') || ' ')`;

/** "(position($1 in h) > 0 OR position($2 in h) > 0) AND (...)" for the terms. */
function termClauses(terms, hay, params) {
  return terms.map((needles) => `(${needles.map((n) => {
    params.push(n);
    return `position($${params.length} in ${hay}) > 0`;
  }).join(' OR ')})`);
}

// Every instrument with everything a tag could be naming. Lateral
// aggregates, so each piece is one row however many owners/tickets it has.
const BASE = `
  SELECT i.id, i.family, i.nickname, i.model, i.serial_no, i.year, i.identifying_notes,
         i.model_group, i.ownership, i.sale_status, i.customer_id, i.consignor_name,
         i.cover_photo_id, i.audited_at, i.updated_at,
         (SELECT e.name FROM employees e WHERE e.id = i.audited_by) AS audited_by_name,
         c.name AS customer_name,
         mf.chain AS model_chain,
         (COALESCE(mf.attrs, '{}'::jsonb) || i.attr_overrides) AS attrs,
         COALESCE(own.previous, '{}') AS previous_owners,
         COALESCE(own.sold_to, '{}') AS sold_to,
         own.has_sale,
         COALESCE(buy.names, '{}') AS bought_from,
         COALESCE(tk.titles, '{}') AS ticket_titles,
         COALESCE(tk.open, '[]'::jsonb) AS open_tickets
    FROM instruments i
    LEFT JOIN customers c ON c.id = i.customer_id
    ${catalog.FACTS_JOIN}
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT COALESCE(oc.name, o.owner_name))
               FILTER (WHERE o.end_reason IS NOT NULL AND COALESCE(oc.name, o.owner_name) IS NOT NULL)
               AS previous,
             array_agg(DISTINCT COALESCE(bc.name, o.sold_to_name))
               FILTER (WHERE o.end_reason = 'sale' AND COALESCE(bc.name, o.sold_to_name) IS NOT NULL)
               AS sold_to,
             bool_or(o.end_reason = 'sale') AS has_sale
        FROM instrument_ownership o
        LEFT JOIN customers oc ON oc.id = o.customer_id
        LEFT JOIN customers bc ON bc.id = o.sold_to_customer_id
       WHERE o.instrument_id = i.id
    ) own ON TRUE
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT COALESCE(sc.name, p.seller_name)) AS names
        FROM instrument_purchases p
        LEFT JOIN customers sc ON sc.id = p.seller_customer_id
       WHERE p.instrument_id = i.id
    ) buy ON TRUE
    LEFT JOIN LATERAL (
      SELECT array_agg(t.title ORDER BY t.updated_at DESC) AS titles,
             jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title,
                                          'status_label', COALESCE(st.label, t.status_key))
                       ORDER BY t.updated_at DESC) FILTER (WHERE t.archived = FALSE) AS open
        FROM tickets t
        LEFT JOIN settings st ON st.category = 'ticket_status' AND st.key = t.status_key
       WHERE t.instrument_id = i.id
    ) tk ON TRUE`;

// The text a piece is searched by. $1 is the family-label map.
const HAYSTACK = sqlNorm(`concat_ws(' ',
    b.nickname, b.model, b.model_chain, ($1::jsonb ->> b.family), b.serial_no, b.year,
    b.identifying_notes, b.model_group, b.customer_name, b.consignor_name,
    -- attribute values ("mk1", "janus"); a flag ({ chopped: "yes" }) by its key
    (SELECT string_agg(CASE WHEN a.value = 'yes' THEN a.key ELSE a.value END, ' ')
       FROM jsonb_each_text(b.attrs) a),
    array_to_string(b.previous_owners, ' '), array_to_string(b.sold_to, ' '),
    array_to_string(b.bought_from, ' '), array_to_string(b.ticket_titles, ' '))`);

// Fields in the order "Matched on" lists them, with how much a hit there
// counts. A nickname or the current owner is what a tag most often says.
const FIELDS = [
  { key: 'stock_number', label: 'Stock #', weight: 10 },
  { key: 'nickname', label: 'Name', weight: 6 },
  { key: 'customer_name', label: 'Owner', weight: 5 },
  { key: 'consignor_name', label: 'Consignor', weight: 5 },
  { key: 'model_chain', label: 'Model', weight: 4 },
  { key: 'model', label: 'Model', weight: 4 },
  { key: 'serial_no', label: 'Serial', weight: 4 },
  { key: 'bought_from', label: 'Bought from', weight: 3 },
  { key: 'previous_owners', label: 'Previous owner', weight: 3 },
  { key: 'sold_to', label: 'Sold to', weight: 2 },
  { key: 'family_label', label: 'Family', weight: 2 },
  // "mk1 Mark I": matched on both, shown as the label.
  { key: 'mark_text', label: 'Attribute', weight: 2, show: (v) => v.replace(/^\S+ (?=\S)/, '') },
  { key: 'year', label: 'Year', weight: 1 },
  { key: 'model_group', label: 'Section', weight: 1 },
  { key: 'identifying_notes', label: 'Notes', weight: 1 },
  { key: 'ticket_titles', label: 'Ticket', weight: 1 },
];

/** Score a row and say which fields matched. */
function rank(row, parsed) {
  const hits = [];
  let score = 0;
  for (const needles of parsed.terms) {
    let best = 0;
    for (const f of FIELDS) {
      const vals = Array.isArray(row[f.key]) ? row[f.key] : [row[f.key]];
      for (const v of vals) {
        if (v === null || v === undefined || v === '') continue;
        const hay = normText(v);
        if (needles.some((n) => hay.includes(n))) {
          best = Math.max(best, f.weight);
          const value = f.show ? f.show(String(v)) : String(v);
          if (!hits.some((h) => h.label === f.label && h.value === value)) {
            hits.push({ label: f.label, value, weight: f.weight });
          }
        }
      }
    }
    score += best;
  }
  if (parsed.stockId !== null && row.id === parsed.stockId) {
    score += 20;
    if (!hits.some((h) => h.label === 'Stock #')) hits.push({ label: 'Stock #', value: row.stock_number, weight: 10 });
  }
  // Every word in one strong field ("dave s wurli" all in the nickname)
  // beats the same words scattered across owner, notes and a ticket.
  const strong = ['nickname', 'customer_name', 'consignor_name', 'model_chain', 'model'];
  if (parsed.terms.length > 1 && strong.some((k) => {
    const hay = normText(row[k]);
    return parsed.terms.every((needles) => needles.some((n) => hay.includes(n)));
  })) score += 5;

  // Strongest first, and no more than three -- it's a hint, not a report.
  // Ticket titles repeat the owner's name, so they only show when nothing
  // better explains the match.
  hits.sort((a, b) => b.weight - a.weight);
  const shown = hits.filter((h, idx) => idx === 0 || h.weight > 1).slice(0, 3);
  return { score, matched_on: shown.map(({ label, value }) => ({ label, value })) };
}

/**
 * Probably physically in the shop: stock and live consignments, or
 * anyone's piece with an open ticket. Everything else -- sold, or a
 * customer's with nothing open -- is most likely not on the floor.
 */
const inShop = (r) => (r.ownership !== 'customer' && r.sale_status !== 'sold') || r.open_tickets.length > 0;

async function search(rawQuery, { familyLabels = {} } = {}) {
  const parsed = parseQuery(rawQuery);
  const empty = {
    query: String(rawQuery ?? ''), words: parsed.words, results: [], total: 0, truncated: false, customers: [],
  };
  if (!parsed.terms.length && parsed.stockId === null) return empty;

  const params = [JSON.stringify(familyLabels)];
  const clauses = termClauses(parsed.terms, HAYSTACK, params);
  let where = clauses.length ? clauses.join(' AND ') : 'FALSE';
  if (parsed.stockId !== null) {
    params.push(parsed.stockId);
    where = `(${where}) OR b.id = $${params.length}`;
  }
  params.push(CANDIDATE_LIMIT + 1);
  const { rows } = await query(
    `WITH base AS (${BASE}) SELECT b.* FROM base b WHERE ${where}
      ORDER BY b.updated_at DESC LIMIT $${params.length}`,
    params,
  );
  const truncated = rows.length > CANDIDATE_LIMIT;

  // Attribute labels ("Mark I", "Janus") so a match on the attrs JSON can
  // be explained in words rather than as "mk1".
  const attrLabels = {};
  for (const a of catalog.ATTRIBUTES || []) {
    for (const opts of Object.values(a.families || {})) {
      for (const o of opts) attrLabels[`${a.key}:${o.key}`] = o.label;
    }
  }

  const results = rows.slice(0, CANDIDATE_LIMIT).map((r) => {
    const attrs = r.attrs || {};
    const row = {
      ...r,
      stock_number: inv.stockNumber(r),
      family_label: familyLabels[r.family] || r.family,
      // The haystack has attribute values ("mk1"); "Matched on" shows the
      // label ("Mark I"). Value first so a typed "mk1" still hits it here.
      mark_text: Object.entries(attrs).map(([k, v]) => {
        const label = attrLabels[`${k}:${v}`];
        if (v === 'yes') return label || k;
        return label ? `${v} ${label}` : String(v);
      }),
    };
    const { score, matched_on } = rank(row, parsed);
    return {
      id: r.id,
      stock_number: row.stock_number,
      family: r.family,
      family_label: row.family_label,
      nickname: r.nickname,
      model: r.model,
      model_chain: r.model_chain,
      serial_no: r.serial_no,
      year: r.year,
      ownership: r.ownership,
      sale_status: r.sale_status,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      consignor_name: r.consignor_name,
      cover_photo_id: r.cover_photo_id,
      audited_at: r.audited_at,
      audited_by_name: r.audited_by_name,
      // Same rule as GET /inventory/audit's count: shop-held pieces plus
      // ones the shop has sold. A customer's piece in for service isn't.
      counts_in_audit: r.ownership !== 'customer' || !!r.has_sale,
      sold_by_shop: !!r.has_sale,
      in_shop: inShop(r),
      open_tickets: r.open_tickets,
      matched_on,
      score,
      _updated: r.updated_at,
    };
  });

  results.sort((a, b) => (b.in_shop - a.in_shop) || (b.score - a.score)
    || (new Date(b._updated) - new Date(a._updated)));
  for (const r of results) delete r._updated;

  // Customers the words name who have no instrument on file at all -- the
  // "tag says Henderson, mc2 has Henderson but no piece" case, which is
  // otherwise just an empty result. (A customer *with* instruments already
  // shows up through them, since the owner's name is in every piece's
  // haystack.) Mark terms can't be in a name, so they're left out here.
  let customers = [];
  const nameTerms = parsed.terms.filter((t) => !t[0].startsWith(' '));
  if (nameTerms.length && nameTerms.length === parsed.terms.length) {
    const cparams = [];
    const cclauses = termClauses(nameTerms, sqlNorm('c.name'), cparams);
    const { rows: crows } = await query(
      `SELECT c.id, c.name, c.email, c.phone
         FROM customers c
        WHERE ${cclauses.join(' AND ')}
          AND NOT EXISTS (SELECT 1 FROM instruments i WHERE i.customer_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM instrument_ownership o
                           WHERE o.customer_id = c.id OR o.sold_to_customer_id = c.id)
        ORDER BY c.name LIMIT 10`,
      cparams,
    );
    customers = crows;
  }

  return {
    query: String(rawQuery ?? ''),
    words: parsed.words,
    results: results.slice(0, RESULT_LIMIT),
    total: results.length,
    truncated: truncated || results.length > RESULT_LIMIT,
    customers,
  };
}

module.exports = { search, parseQuery, normText, rank };
