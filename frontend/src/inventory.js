/**
 * Display helpers shared by the inventory pages (InventoryView.vue,
 * InventoryDetailView.vue, InventoryParts.vue).
 */

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function formatPrice(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? money.format(n) : String(value);
}

// Parts costs (migration 078) need cents — $42.50 x 1.5 shouldn't read "$64".
const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
export function formatCents(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? cents.format(n) : String(value);
}

const OWNERSHIP_LABELS = { shop: 'Shop-owned', consignment: 'Consignment', customer: 'Customer' };
export const ownershipLabel = (o) => OWNERSHIP_LABELS[o] || o;

/** { label, color, title } for a piece's sale-status pill. */
export function statusPill(i) {
  switch (i.sale_status) {
    case 'available': return { label: 'For sale', color: 'green', title: '' };
    case 'on_hold': return { label: 'On hold', color: 'amber', title: i.hold_for ? `Held for ${i.hold_for}` : '' };
    case 'not_for_sale': return {
      label: i.nfs_reason ? `NFS · ${i.nfs_reason}` : 'Not for sale', color: 'slate', title: i.nfs_reason || '',
    };
    case 'sold': return { label: 'Sold', color: 'blue', title: i.sold_to_name ? `Sold to ${i.sold_to_name}` : '' };
    default: return { label: i.sale_status || '—', color: 'slate', title: '' };
  }
}

/**
 * Condition grades (migration 084) are keys from a fixed scale -- the list
 * and labels come from GET /inventory/meta's condition_grades. These colour
 * a grade the way the sheet read: Mint / Near Mint green through Poor red.
 * Free text (anything from before 084 that slipped through) still gets
 * coloured by its leading grade word, and otherwise stays plain.
 */
const GRADE_CLASS = {
  mint: 'grade-mint', near_mint: 'grade-mint', excellent: 'grade-ex',
  very_good: 'grade-vg', good: 'grade-g', poor: 'grade-poor',
};
export function gradeClass(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (GRADE_CLASS[v]) return GRADE_CLASS[v];
  if (/^(mint|m|nm|near mint)\b/.test(v)) return 'grade-mint';
  if (/^(ex|excellent)\b/.test(v)) return 'grade-ex';
  if (/^(vg|very good)\b/.test(v)) return 'grade-vg';
  if (/^(g|good)\b/.test(v)) return 'grade-g';
  if (/^(f|fair|poor|bad|rough)\b/.test(v)) return 'grade-poor';
  return '';
}

/** "very_good" -> "Very Good", given meta.condition_grades; unknown values as-is. */
export function gradeLabel(value, grades) {
  if (!value) return '';
  return (grades || []).find((g) => g.key === value)?.label || value;
}

/** Next QC due date from last_qc_at + qc_interval_months, or null. */
export function nextQcDue(i) {
  if (!i.last_qc_at || !i.qc_interval_months) return null;
  const d = new Date(`${String(i.last_qc_at).slice(0, 10)}T00:00:00`);
  d.setMonth(d.getMonth() + Number(i.qc_interval_months));
  return d;
}
