'use strict';

/**
 * The instrument model catalog (migrations 036, 050, 086, 089) — what kinds
 * of instrument exist, and the facts that come with each kind.
 *
 * instrument_models is a tree per family (Rhodes -> Mark I -> Stage 73).
 * A node can carry a key_count and attributes (`attrs`, e.g. { mark: 'mk1',
 * suitcase_amp: 'janus' }); the view instrument_model_facts resolves them
 * down the tree (a node's own value, else its nearest ancestor's), plus
 * is_suitcase (true anywhere on the path) and the " / " name chain the
 * pickers write.
 *
 * instruments.model_id points at the node a piece *is*; instruments.model
 * stays the text as written. instruments.attr_overrides holds only what a
 * piece has that differs from its model (a Mark II harp in a Mark I case, a
 * swapped amp). Every read returns the effective result as `attrs` (model's
 * attrs, then the piece's overrides on top), plus `mark` on its own since
 * that one shows in lists.
 *
 * Deliberately free of route imports (routes/instruments.js requires this).
 */

const { badRequest } = require('../middleware/errors');

// ---------------------------------------------------------------------------
// Attributes (migration 089). Which exist, their options per family, and
// where they apply. Adding one is an entry here -- the database just stores
// keys, and every form renders this list (GET /instruments/attributes).
//   suitcaseOnly  shown for a piece whose model is a suitcase / self-
//                 contained model, or that isn't linked to one (the model
//                 might be -- a spare cabinet, typed-in text), or that
//                 already has a value. Hidden for a known Stage model.
// ---------------------------------------------------------------------------
const ATTRIBUTES = [
  {
    key: 'mark',
    label: 'Mark',
    families: {
      // Rhodes generations. Mark IV and VI were prototypes only.
      rhodes: [
        { key: 'pre_mark', label: 'Pre-Mark', hint: '1965–69' },
        { key: 'mk1', label: 'Mark I', hint: '1969–79' },
        { key: 'mk2', label: 'Mark II', hint: '1979–83' },
        { key: 'mk3', label: 'Mark III', hint: 'EK-10, 1980' },
        { key: 'mk5', label: 'Mark V', hint: '1984' },
        { key: 'mk7', label: 'Mark 7', hint: '2007' },
        { key: 'mk8', label: 'Mark 8', hint: '2021–' },
      ],
    },
  },
  {
    key: 'suitcase_amp',
    label: 'Suitcase amp',
    suitcaseOnly: true,
    families: {
      // The suitcase cabinet's amp system; cables, preamps and speaker
      // parts are specific to each.
      rhodes: [
        { key: 'jordan', label: 'Jordan', hint: '50W mono, 1965–69' },
        { key: 'peterson', label: 'Peterson', hint: '80W, 4-pin, 1970–77' },
        { key: 'janus', label: 'Janus', hint: '100W, 5-pin XLR, 1977–82' },
      ],
    },
  },
];
const ATTRIBUTE_BY_KEY = Object.fromEntries(ATTRIBUTES.map((a) => [a.key, a]));
const optionKeys = (attrKey, family) => (ATTRIBUTE_BY_KEY[attrKey]?.families[family] || []).map((o) => o.key);

/** { key: value } -> validated copy; '' / null values mean "inherit" and are kept as null. */
function validateAttrs(input, family, what = 'attribute') {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw badRequest(`${what}s must be an object`);
  const out = {};
  for (const [k, raw] of Object.entries(input)) {
    const attr = ATTRIBUTE_BY_KEY[k];
    if (!attr) throw badRequest(`Unknown ${what} "${k}"`);
    const v = raw === null || raw === undefined || raw === '' ? null : String(raw);
    if (v !== null) {
      const keys = optionKeys(k, family);
      if (!keys.length) throw badRequest(`${attr.label} doesn't apply to ${family}`);
      if (!keys.includes(v)) {
        throw badRequest(`${attr.label} must be one of: ${attr.families[family].map((o) => o.label).join(', ')}`);
      }
    }
    out[k] = v;
  }
  return out;
}

// Mark and amp named in free text -- "Mark II", "Mk 2", "MKII", "Peterson
// cabinet". Same rules as migrations 085 / 089's SQL; used by the inventory
// importer. Rhodes only.
const MARK_RE = /\b(?:mark|mk)\s*\.?\s*(viii|vii|iii|ii|i|v|[1-8])\b/i;
const MARK_OF = {
  i: 'mk1', 1: 'mk1', ii: 'mk2', 2: 'mk2', iii: 'mk3', 3: 'mk3',
  v: 'mk5', 5: 'mk5', vii: 'mk7', 7: 'mk7', viii: 'mk8', 8: 'mk8',
};
function markFromText(text) {
  const m = MARK_RE.exec(String(text ?? ''));
  return (m && MARK_OF[m[1].toLowerCase()]) || null;
}
const AMP_RE = /\b(peterson|janus|jordan)\b/i;
function ampFromText(text) {
  const m = AMP_RE.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}
/** Attributes a Rhodes row's own texts name; the first text that says each one wins. */
function attrsFromText(family, ...texts) {
  if (family !== 'rhodes') return {};
  const out = {};
  for (const t of texts) {
    if (!out.mark) { const m = markFromText(t); if (m) out.mark = m; }
    if (!out.suitcase_amp) { const a = ampFromText(t); if (a) out.suitcase_amp = a; }
  }
  return out;
}

// Parts pricing by key count (migration 043's parts_cost_* columns). The
// Rhodes Piano Bass is the 32-key model.
const VARIANT_BY_KEY_COUNT = { 32: 'piano_bass', 54: '54_key', 73: '73_key', 88: '88_key' };

// For any query over `instruments i`: join + the catalog-derived columns.
const FACTS_JOIN = 'LEFT JOIN instrument_model_facts mf ON mf.id = i.model_id';
const FACTS_COLUMNS = `COALESCE(mf.attrs, '{}'::jsonb) || i.attr_overrides AS attrs,
       COALESCE(mf.attrs, '{}'::jsonb) AS catalog_attrs,
       (COALESCE(mf.attrs, '{}'::jsonb) || i.attr_overrides)->>'mark' AS mark,
       mf.chain AS model_chain, mf.key_count, mf.is_suitcase AS model_is_suitcase`;

async function factsFor(db, modelId) {
  if (!modelId) return null;
  const { rows } = await db.query('SELECT * FROM instrument_model_facts WHERE id = $1', [modelId]);
  return rows[0] || null;
}

/** One instrument with its catalog facts — what POST/PATCH responses return. */
async function selectWithFacts(db, id, extraColumns = '', extraJoin = '') {
  const { rows } = await db.query(
    `SELECT i.*, ${FACTS_COLUMNS}${extraColumns}
       FROM instruments i ${FACTS_JOIN} ${extraJoin}
      WHERE i.id = $1`,
    [id],
  );
  return rows[0] || null;
}

const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('model_id must be a catalog model id');
  return n;
};

/** Overrides minus what the model already says (SQL: instrument_attrs_prune). */
function pruneAttrs(overrides, modelAttrs) {
  const out = {};
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== null && v !== undefined && (modelAttrs || {})[k] !== v) out[k] = v;
  }
  return out;
}
const sameAttrs = (a, b) => JSON.stringify(Object.entries(a || {}).sort())
  === JSON.stringify(Object.entries(b || {}).sort());

/**
 * Normalises model_id / model / attributes for a write, shared by every
 * route that creates or edits an instrument. `f` holds the fields being
 * written (any of family, model, model_id, attrs, and `mark` -- shorthand
 * for attrs.mark) and is mutated in place: it ends up with model_id and
 * attr_overrides where they change, and never `attrs` or `mark`.
 * `old` is the row before the change ({} for a new piece).
 *
 *  - model_id given: must be a catalog node of the piece's family (the
 *    composite FK would refuse it anyway; this says why). With no model
 *    text alongside, the text becomes the node's chain.
 *  - model text or family changed with no model_id: re-linked by the same
 *    unambiguous-only rule migration 086 used (instrument_model_match), so
 *    typing "Suitcase 73" for a Mark I links it, and editing the text away
 *    from what the link says unlinks it rather than leaving it stale.
 *  - attrs given ({ key: value }, '' / null = "as the model says"): each
 *    validated against the family's options and merged over the piece's
 *    current overrides.
 *  - afterwards the overrides are pruned: anything the (new) model already
 *    says, and anything the family doesn't have, isn't an override.
 */
async function resolveModel(db, f, old = {}) {
  const family = f.family ?? old.family;
  const familyChanged = f.family !== undefined && f.family !== old.family;
  const isNew = old.id === undefined;
  const oldFacts = old.model_id ? await factsFor(db, old.model_id) : null;

  let requested;
  if (f.attrs !== undefined || f.mark !== undefined) {
    requested = validateAttrs({ ...(f.attrs || {}), ...(f.mark !== undefined ? { mark: f.mark } : {}) }, family);
  }

  let facts = oldFacts;
  if (f.model_id !== undefined) {
    f.model_id = intOrNull(f.model_id);
    facts = await factsFor(db, f.model_id);
    if (f.model_id && !facts) throw badRequest(`Model #${f.model_id} isn't in the catalog`);
    if (facts && facts.family !== family) {
      throw badRequest(`"${facts.chain}" is a ${facts.family} model, not ${family}`);
    }
    if (facts && !f.model) f.model = facts.chain;
  } else if (f.model !== undefined || familyChanged) {
    const text = f.model !== undefined ? f.model : old.model;
    const oldMark = (old.attr_overrides || {}).mark ?? oldFacts?.attrs?.mark ?? null;
    const hint = requested && 'mark' in requested ? requested.mark : oldMark;
    const { rows } = await db.query('SELECT instrument_model_match($1, $2, $3) AS id', [family, text, hint]);
    f.model_id = rows[0].id;
    facts = await factsFor(db, f.model_id);
  }

  if (isNew || requested !== undefined || f.model_id !== undefined || familyChanged) {
    const current = old.attr_overrides || {};
    const merged = { ...current };
    for (const [k, v] of Object.entries(requested || {})) {
      if (v === null) delete merged[k]; else merged[k] = v;
    }
    // Drop what the family doesn't have (after a family change).
    for (const k of Object.keys(merged)) {
      if (!optionKeys(k, family).includes(merged[k])) delete merged[k];
    }
    const next = pruneAttrs(merged, facts?.attrs);
    if (isNew || !sameAttrs(next, current)) f.attr_overrides = next;
  }
  delete f.attrs;
  delete f.mark;
  return f;
}

module.exports = {
  ATTRIBUTES,
  optionKeys,
  validateAttrs,
  markFromText,
  ampFromText,
  attrsFromText,
  pruneAttrs,
  VARIANT_BY_KEY_COUNT,
  FACTS_JOIN,
  FACTS_COLUMNS,
  factsFor,
  selectWithFacts,
  resolveModel,
};
