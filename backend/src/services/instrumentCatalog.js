'use strict';

/**
 * The instrument model catalog (migrations 036, 050, 086) — what kinds of
 * instrument exist, and the facts that come with each kind.
 *
 * instrument_models is a tree per family (Rhodes -> Mark I -> Stage 73).
 * A node can carry a `mark` and a `key_count`; the view
 * instrument_model_facts resolves them down the tree (a node's own value,
 * else its nearest ancestor's), plus is_suitcase (true anywhere on the path)
 * and the " / " name chain the pickers write.
 *
 * instruments.model_id points at the node a piece *is*; instruments.model
 * stays the text as written. instruments.mark_override is set only when a
 * piece differs from its model's mark (a Mark II harp in a Mark I case) —
 * the effective mark is COALESCE(mark_override, catalog mark), and that is
 * what every read returns as `mark`.
 *
 * Deliberately free of route imports (routes/instruments.js requires this).
 */

const { badRequest } = require('../middleware/errors');

// Rhodes generations. Keys are stored (instrument_models.mark,
// instruments.mark_override); labels shown; `years` only in dropdowns. A
// family not listed has no Mark. Mark IV and VI were prototypes only.
const MARKS = {
  rhodes: [
    { key: 'pre_mark', label: 'Pre-Mark', years: '1965–69' },
    { key: 'mk1', label: 'Mark I', years: '1969–79' },
    { key: 'mk2', label: 'Mark II', years: '1979–83' },
    { key: 'mk3', label: 'Mark III', years: 'EK-10, 1980' },
    { key: 'mk5', label: 'Mark V', years: '1984' },
    { key: 'mk7', label: 'Mark 7', years: '2007' },
    { key: 'mk8', label: 'Mark 8', years: '2021–' },
  ],
};
const markKeys = (family) => (MARKS[family] || []).map((m) => m.key);

// "Mark II" / "Mk 2" / "MKII" -> 'mk2', or null. Same rule as migrations
// 085/086's SQL — keep them in step. Used by the inventory importer.
const MARK_RE = /\b(?:mark|mk)\s*\.?\s*(viii|vii|iii|ii|i|v|[1-8])\b/i;
const MARK_OF = {
  i: 'mk1', 1: 'mk1', ii: 'mk2', 2: 'mk2', iii: 'mk3', 3: 'mk3',
  v: 'mk5', 5: 'mk5', vii: 'mk7', 7: 'mk7', viii: 'mk8', 8: 'mk8',
};
function markFromText(text) {
  const m = MARK_RE.exec(String(text ?? ''));
  return (m && MARK_OF[m[1].toLowerCase()]) || null;
}

// Parts pricing by key count (migration 043's parts_cost_* columns). The
// Rhodes Piano Bass is the 32-key model.
const VARIANT_BY_KEY_COUNT = { 32: 'piano_bass', 54: '54_key', 73: '73_key', 88: '88_key' };

// For any query over `instruments i`: join + the catalog-derived columns.
const FACTS_JOIN = 'LEFT JOIN instrument_model_facts mf ON mf.id = i.model_id';
const FACTS_COLUMNS = `COALESCE(i.mark_override, mf.mark) AS mark,
       mf.mark AS catalog_mark, mf.chain AS model_chain,
       mf.key_count, mf.is_suitcase AS model_is_suitcase`;

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

/**
 * Normalises model_id / model / mark for a write, shared by every route
 * that creates or edits an instrument. `f` holds the fields being written
 * (any of family, model, model_id, mark) and is mutated in place: it ends
 * up with model_id and mark_override where they change, and never `mark`.
 * `old` is the row before the change ({} for a new piece).
 *
 *  - model_id given: must be a catalog node of the piece's family (the
 *    composite FK would refuse it anyway; this says why). With no model
 *    text alongside, the text becomes the node's chain.
 *  - model text or family changed with no model_id: re-linked by the same
 *    unambiguous-only rule migration 086 used (instrument_model_match), so
 *    typing "Suitcase 73" for a Mark I links it, and editing the text away
 *    from what the link says unlinks it rather than leaving it stale.
 *  - mark given ('' = "as the model says"): a key from the family's list;
 *    equal to the model's own mark it's stored as no override.
 *  - model or family changed, no mark given: an existing override survives
 *    only while it's still a valid mark for the family and still differs
 *    from the new model's.
 */
async function resolveModel(db, f, old = {}) {
  const family = f.family ?? old.family;
  const familyChanged = f.family !== undefined && f.family !== old.family;
  const oldFacts = old.model_id ? await factsFor(db, old.model_id) : null;

  let requestedMark;
  if (f.mark !== undefined) {
    requestedMark = f.mark === null || f.mark === '' ? null : String(f.mark);
    if (requestedMark && !markKeys(family).includes(requestedMark)) {
      throw badRequest(MARKS[family]
        ? `mark must be one of: ${MARKS[family].map((m) => m.label).join(', ')}`
        : 'Only Rhodes pieces have a Mark');
    }
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
    const hint = requestedMark !== undefined ? requestedMark
      : (old.mark_override ?? oldFacts?.mark ?? null);
    const { rows } = await db.query('SELECT instrument_model_match($1, $2, $3) AS id', [family, text, hint]);
    f.model_id = rows[0].id;
    facts = await factsFor(db, f.model_id);
  }

  const catalogMark = facts?.mark ?? null;
  if (requestedMark !== undefined) {
    f.mark_override = requestedMark === catalogMark ? null : requestedMark;
  } else if (f.model_id !== undefined || familyChanged) {
    const current = old.mark_override ?? null;
    if (current && (!markKeys(family).includes(current) || current === catalogMark)) f.mark_override = null;
  }
  delete f.mark;
  return f;
}

module.exports = {
  MARKS,
  markKeys,
  markFromText,
  VARIANT_BY_KEY_COUNT,
  FACTS_JOIN,
  FACTS_COLUMNS,
  factsFor,
  selectWithFacts,
  resolveModel,
};
