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

/**
 * Thin Shopify Admin REST API client — used only by
 * scripts/registerShopifyWebhooks.js today. Same no-SDK, native-`fetch`
 * approach as backend/src/mailer.js.
 */
async function adminApiRequest(path, { method = 'GET', body } = {}) {
  const {
    shopDomain, adminApiToken, apiVersion,
  } = config.shopify;
  if (!shopDomain || !adminApiToken) {
    throw new Error('SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_API_TOKEN must both be set');
  }

  const res = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/${path}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': adminApiToken,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.errors ? JSON.stringify(payload.errors) : `HTTP ${res.status}`;
    throw new Error(`Shopify Admin API error: ${detail}`);
  }
  return payload;
}

module.exports = { verifyWebhookHmac, adminApiRequest };
