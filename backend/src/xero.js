'use strict';

const config = require('./config');

/**
 * Thin Xero Accounting API client — Custom Connection auth (single
 * organisation, OAuth2 client_credentials grant, no per-user consent
 * screen: see NOTES.md's Xero sync entry). Same no-SDK, native-`fetch`
 * approach as backend/src/mailer.js and shopify.js's adminApiRequest.
 *
 * Two things get cached at module scope rather than re-fetched per call:
 * the access token (30-minute lifetime; Xero's own guidance is to hold
 * onto it and only refresh near expiry, not fetch one per request) and
 * the tenant id (a Custom Connection authorizes exactly one Xero
 * organisation, and that mapping doesn't change during this process's
 * lifetime — this backend runs as one long-lived Node process under
 * Beachhead, same "module-level state is fine here" reasoning as
 * services/ceppyScheduler.js). Both are cleared and re-fetched
 * automatically once they're within a minute of what we know their
 * lifetime to be; the tenant id has no real expiry, so it's just fetched
 * once per process and kept.
 */

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

// Read + write access to Contacts only — this integration never touches
// invoices, payroll, or anything else Xero's granular scopes gate, on the
// same "don't grant more than the feature actually uses" principle
// backend/src/config.js's other integrations follow.
const SCOPE = 'accounting.contacts';

let cachedToken = null; // { accessToken, expiresAt (epoch ms) }
let cachedTenantId = null;

function assertConfigured() {
  if (!config.xero.clientId || !config.xero.clientSecret) {
    throw new Error('Xero is not configured — set XERO_CLIENT_ID and XERO_CLIENT_SECRET');
  }
}

async function fetchAccessToken() {
  assertConfigured();
  const basic = Buffer.from(`${config.xero.clientId}:${config.xero.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error_description || payload?.error || `HTTP ${res.status}`;
    throw new Error(`Xero token request failed: ${detail}`);
  }
  return {
    accessToken: payload.access_token,
    // expires_in is seconds; refresh a minute early so a call in flight
    // never gets a token that expires mid-request.
    expiresAt: Date.now() + (payload.expires_in - 60) * 1000,
  };
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  cachedToken = await fetchAccessToken();
  return cachedToken.accessToken;
}

async function getTenantId() {
  if (cachedTenantId) return cachedTenantId;
  const token = await getAccessToken();
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(`Xero connections lookup failed: HTTP ${res.status}`);
  // A Custom Connection authorizes exactly one organisation; filtering to
  // ORGANISATION (rather than just taking [0]) is cheap insurance against
  // whatever else Xero's /connections response might ever include.
  const org = (Array.isArray(payload) ? payload : []).find((c) => c.tenantType === 'ORGANISATION');
  if (!org) throw new Error('Xero returned no authorized organisation for this connection');
  cachedTenantId = org.tenantId;
  return cachedTenantId;
}

/**
 * Pull whatever detail Xero's error response actually offers — a 400
 * validation failure (e.g. a bad EmailAddress) comes back shaped very
 * differently from a 401/403 — rather than collapsing every failure to a
 * bare status code.
 */
function describeError(payload, status) {
  const fromElements = payload?.Elements?.[0]?.ValidationErrors?.map((v) => v.Message).join('; ');
  return fromElements || payload?.Detail || payload?.Title || payload?.Message || `HTTP ${status}`;
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const [token, tenantId] = [await getAccessToken(), await getTenantId()];
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'xero-tenant-id': tenantId,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Xero API error: ${describeError(payload, res.status)}`);
  return payload;
}

/**
 * Every contact in the org, unpaged for the caller — a piano shop's
 * customer list is small enough that walking Xero's own page=N pagination
 * (100 contacts/page) internally and handing back one flat array is
 * simpler and safer than making every caller re-implement paging.
 */
async function listContacts() {
  const all = [];
  for (let page = 1; ; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { Contacts: contacts = [] } = await apiRequest(`/Contacts?page=${page}`);
    all.push(...contacts);
    if (contacts.length < 100) break; // short page — that was the last one
  }
  return all;
}

async function createContact(payload) {
  const { Contacts: contacts = [] } = await apiRequest('/Contacts', { method: 'POST', body: { Contacts: [payload] } });
  return contacts[0];
}

async function updateContact(contactId, payload) {
  const { Contacts: contacts = [] } = await apiRequest(`/Contacts/${contactId}`, {
    method: 'POST',
    body: { Contacts: [payload] },
  });
  return contacts[0];
}

module.exports = {
  listContacts, createContact, updateContact,
};
