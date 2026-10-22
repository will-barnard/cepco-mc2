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
 * Colour a free-text condition grade by its leading grade word, the way
 * the sheet reads: MINT/NM green through F/Poor red. Anything that
 * doesn't start with a grade ("OG Cube", "yellow") stays uncoloured.
 */
export function gradeClass(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (/^(mint|m|nm|near mint)\b/.test(v)) return 'grade-mint';
  if (/^(ex|excellent)\b/.test(v)) return 'grade-ex';
  if (/^(vg|very good)\b/.test(v)) return 'grade-vg';
  if (/^(g|good)\b/.test(v)) return 'grade-g';
  if (/^(f|fair|poor|bad|rough)\b/.test(v)) return 'grade-poor';
  return '';
}

/** Next QC due date from last_qc_at + qc_interval_months, or null. */
export function nextQcDue(i) {
  if (!i.last_qc_at || !i.qc_interval_months) return null;
  const d = new Date(`${String(i.last_qc_at).slice(0, 10)}T00:00:00`);
  d.setMonth(d.getMonth() + Number(i.qc_interval_months));
  return d;
}
