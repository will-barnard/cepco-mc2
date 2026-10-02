/**
 * Links into the Xero web app (shop feedback, Oct 2026: a "Xero contact"
 * button by the customer's name on a ticket).
 *
 * With the org's short code (GET /api/xero/org — from XERO_SHORT_CODE on
 * the backend) the link is Xero's current per-org deep link, which opens
 * the right organisation even for a login with several. Without it, Xero's
 * older org-less contact URL, which opens in whichever org the person last
 * used — fine for a single-org shop.
 *
 * The short code is fetched once per page load and shared; it never
 * changes for an org.
 */
import api from './api';

let shortCodePromise = null;

function shortCode() {
  if (!shortCodePromise) {
    shortCodePromise = api.get('/xero/org')
      .then((r) => r?.short_code || null)
      .catch(() => null);
  }
  return shortCodePromise;
}

export async function xeroContactUrl(contactId) {
  if (!contactId) return null;
  const id = encodeURIComponent(contactId);
  const code = await shortCode();
  return code
    ? `https://go.xero.com/app/${encodeURIComponent(code)}/contacts/contact/${id}`
    : `https://go.xero.com/Contacts/View/${id}`;
}
