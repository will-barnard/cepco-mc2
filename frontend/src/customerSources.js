/**
 * Where a customer came in from -- the "Source" dropdown on every
 * add/edit-customer form. Mirrors customers_source_check (migrations
 * 047/060) and routes/customers.js's SOURCES. Mostly useful for knowing
 * where to go looking for past conversations (a Reverb customer's
 * history lives in Reverb messages, not the shop inbox).
 *
 * 'xero' isn't offered for new customers -- only the sync sets it, when
 * it pulls in a contact that was created in Xero -- but it has to stay
 * selectable when editing one of those, or the dropdown shows blank.
 */
export const CUSTOMER_SOURCES = [
  { value: 'direct', label: 'Direct / walk-in' },
  { value: 'email', label: 'Email' },
  { value: 'shopify', label: 'Shopify' },
  { value: 'reverb', label: 'Reverb' },
  { value: 'ebay', label: 'eBay' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
];

export const XERO_SOURCE = { value: 'xero', label: 'Xero' };

export function sourceLabel(value) {
  return [...CUSTOMER_SOURCES, XERO_SOURCE].find((s) => s.value === value)?.label || value || '';
}

/** Blank structured address, same keys as customers' columns (migration 060). */
export function blankAddress() {
  return {
    address_line1: '', address_line2: '', city: '', region: '', postal_code: '', country: '',
  };
}

/** A customer row's structured address, ready to bind to <AddressFields>. */
export function addressFrom(row) {
  const out = blankAddress();
  for (const k of Object.keys(out)) out[k] = row?.[k] || '';
  return out;
}
