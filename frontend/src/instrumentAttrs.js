/**
 * Instrument attributes (migration 089) -- Mark, suitcase amp, and whatever
 * gets added to the list in services/instrumentCatalog.js (ATTRIBUTES,
 * served at GET /instruments/attributes and kept in the refData store).
 *
 * A piece's effective attributes are its model's (`catalog_attrs`) with its
 * own `attr_overrides` on top; reads return the result as `attrs`. Forms
 * edit the overrides only: '' means "as the model says".
 */

/**
 * The attributes a form shows for a family. A suitcase-only one (the amp)
 * is hidden only when the picked model is known not to be a suitcase
 * (`suitcase === false`) and the piece has no value for it.
 */
export function attributesFor(list, family, { suitcase = null, values = {} } = {}) {
  return (list || [])
    .filter((a) => (a.families[family] || []).length)
    .filter((a) => !a.suitcaseOnly || suitcase !== false || values[a.key]);
}

export function valueLabel(list, key, family, value) {
  if (!value) return '';
  const attr = (list || []).find((a) => a.key === key);
  return (attr?.families[family] || []).find((o) => o.key === value)?.label || value;
}

/** ["Mark I", "Peterson"] -- a piece's effective attributes, in list order. */
export function attrsSummary(list, item) {
  if (!item) return [];
  const attrs = item.attrs || {};
  return (list || [])
    .filter((a) => attrs[a.key])
    .map((a) => valueLabel(list, a.key, item.family, attrs[a.key]));
}

/**
 * What to send for a change of overrides: { key: value } for set / changed
 * keys, { key: null } for removed ones (the API merges over what's stored).
 * null when nothing changed.
 */
export function overridesPatch(before, now) {
  const out = {};
  const b = before || {};
  const n = now || {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(n)])) {
    const was = b[k] || null;
    const is = n[k] || null;
    if (was !== is) out[k] = is;
  }
  return Object.keys(out).length ? out : null;
}

/** Overrides minus keys the family doesn't have (after a family change). */
export function keepForFamily(list, family, overrides) {
  const out = {};
  for (const [k, v] of Object.entries(overrides || {})) {
    const attr = (list || []).find((a) => a.key === k);
    if ((attr?.families[family] || []).some((o) => o.key === v)) out[k] = v;
  }
  return out;
}
