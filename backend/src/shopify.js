'use strict';

const crypto = require('crypto');
const config = require('./config');

/**
 * Verify an inbound Shopify webhook request. Per Shopify's docs: HMAC-SHA256
 * over the *raw* (unparsed) request body, keyed with the webhook secret,
 * base64-encoded, compared against the X-Shopify-Hmac-Sha256 header. index.js
 * captures that raw buffer as req.rawBody alongside the normal JSON parse
 * (express.json's `verify` option) specifically so this has bytes to check —
 * body-parsed-and-reserialized JSON is not guaranteed to match what Shopify
 * actually signed.
 *
 * For subscriptions declared in a Dev Dashboard app's config, the signing
 * key is the app's client secret — config.shopify.webhookSecret falls back
 * to SHOPIFY_CLIENT_SECRET for exactly that reason.
 */
function verifyWebhookHmac(rawBody, hmacHeader) {
  if (!config.shopify.webhookSecret || !hmacHeader || !rawBody) return false;
  const digest = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(rawBody)
    .digest('base64');

  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  // Buffers must be equal length for timingSafeEqual, or it throws — a
  // length mismatch already means "not equal," so short-circuit instead.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Admin API access token.
//
// A Dev Dashboard app installed on a store in the same organisation gets its
// tokens from the client credentials grant: POST the client id + secret to
// the shop's /admin/oauth/access_token, get back a short-lived token, ask
// again when it runs out. There is no token to copy out of an admin screen
// any more. A static SHOPIFY_ADMIN_API_TOKEN (a legacy admin-created app's
// shpat_ token) still wins if set, so nothing breaks for a deploy that has
// one.
// ---------------------------------------------------------------------------

let cachedToken = null; // { token, expiresAt }

function adminApiMode() {
  const {
    shopDomain, adminApiToken, clientId, clientSecret,
  } = config.shopify;
  if (!shopDomain) return null;
  if (adminApiToken) return 'static_token';
  if (clientId && clientSecret) return 'client_credentials';
  return null;
}

function configError(message) {
  const err = new Error(message);
  err.status = 503;
  err.configError = true; // retrying won't help until someone fixes env vars
  return err;
}

async function getAdminToken({ forceRefresh = false } = {}) {
  const {
    shopDomain, adminApiToken, clientId, clientSecret,
  } = config.shopify;
  const mode = adminApiMode();
  if (!mode) {
    throw configError(
      'Shopify Admin API is not configured: set SHOPIFY_SHOP_DOMAIN plus either '
      + 'SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET or SHOPIFY_ADMIN_API_TOKEN',
    );
  }
  if (mode === 'static_token') return adminApiToken;
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) {
    // 4xx here means the credentials, the shop domain, or the install is
    // wrong — not something a retry fixes. 5xx is Shopify having a moment.
    const detail = payload.error_description || payload.error || `HTTP ${res.status}`;
    if (res.status >= 500) {
      const err = new Error(`Shopify token request failed: ${detail}`);
      err.status = 502;
      throw err;
    }
    throw configError(`Shopify token request failed: ${detail}`);
  }
  // expires_in is seconds (about a day). Refresh five minutes early; if it's
  // ever missing, assume an hour rather than caching forever.
  const ttl = Number(payload.expires_in) > 600 ? Number(payload.expires_in) : 3600;
  cachedToken = { token: payload.access_token, expiresAt: Date.now() + (ttl - 300) * 1000 };
  return cachedToken.token;
}

async function adminFetch(path, init, { retried = false } = {}) {
  const { shopDomain, apiVersion } = config.shopify;
  const token = await getAdminToken();
  const res = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/${path}`, {
    ...init,
    headers: { ...(init.headers || {}), 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  // A client-credentials token can stop working before its expiry (secret
  // rotated, app reinstalled) — get a fresh one and try once more.
  if (res.status === 401 && !retried && adminApiMode() === 'client_credentials') {
    await getAdminToken({ forceRefresh: true });
    return adminFetch(path, init, { retried: true });
  }
  return res;
}

/**
 * Thin Shopify Admin REST API client — used by
 * scripts/registerShopifyWebhooks.js. Same no-SDK, native-`fetch` approach
 * as backend/src/mailer.js.
 */
async function adminApiRequest(path, { method = 'GET', body } = {}) {
  const res = await adminFetch(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.errors ? JSON.stringify(payload.errors) : `HTTP ${res.status}`;
    const err = new Error(`Shopify Admin API error: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

/** GraphQL Admin API. Throws on transport errors and on a top-level
 * `errors` array (which is also how Shopify reports THROTTLED). */
async function graphql(queryText, variables = {}) {
  const res = await adminFetch('graphql.json', {
    method: 'POST',
    body: JSON.stringify({ query: queryText, variables }),
  });
  const payload = await res.json().catch(() => ({}));
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (!res.ok || errors.length || typeof payload.errors === 'string') {
    const detail = errors.map((e) => e.message).join('; ')
      || (typeof payload.errors === 'string' ? payload.errors : '')
      || `HTTP ${res.status}`;
    const err = new Error(`Shopify GraphQL error: ${detail}`);
    err.status = errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED') ? 429 : res.status;
    throw err;
  }
  return payload.data;
}

/**
 * Tags for a set of products, by numeric product id (what an order
 * webhook's line items carry — tags aren't in the order payload at all).
 * Returns Map<string id, string[] tags>. A product that's since been
 * deleted simply isn't in the map, and its line item counts as untagged.
 */
async function productTags(productIds) {
  const ids = [...new Set(productIds.filter(Boolean).map(String))];
  const out = new Map();
  // nodes() takes up to 250 ids; an order never gets near that, but chunk
  // anyway so this stays correct if it's ever reused for something bigger.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    // eslint-disable-next-line no-await-in-loop
    const data = await graphql(
      'query ProductTags($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id tags } } }',
      { ids: chunk.map((id) => `gid://shopify/Product/${id}`) },
    );
    for (const node of data.nodes || []) {
      if (node && node.id) out.set(node.id.split('/').pop(), node.tags || []);
    }
  }
  return out;
}

/** Cheap "are the credentials right" check for Settings -> Shopify orders. */
async function shopInfo() {
  const data = await graphql('{ shop { name myshopifyDomain } }');
  return data.shop;
}

module.exports = {
  verifyWebhookHmac, adminApiRequest, graphql, productTags, shopInfo, adminApiMode,
};
