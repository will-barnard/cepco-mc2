'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const { verifyWebhookHmac } = require('../shopify');
const shopifyOrders = require('../services/shopifyOrders');

const router = express.Router();

// No requireAuth here — Shopify calls this endpoint directly with no
// session cookie. HMAC verification is the actual gate: it proves the
// request was signed with our webhook secret (the app's client secret),
// which only Shopify and we know (see backend/src/shopify.js). index.js
// captures req.rawBody globally so this can check the exact bytes Shopify
// signed.
router.use((req, res, next) => {
  const ok = verifyWebhookHmac(req.rawBody, req.get('X-Shopify-Hmac-Sha256'));
  if (!ok) return res.status(401).json({ error: 'invalid webhook signature' });
  next();
});

// Every order topic just records the latest version of the order and
// replies; services/shopifyOrders.js does the real work right after, off
// the request. Shopify wants a 200 within five seconds and retries anything
// slower — and the real work now includes a Shopify tag lookup and two Xero
// calls, neither of which belongs inside that window. If recording itself
// fails (database down) the 500 makes Shopify retry, which is what we want.
//
// orders/paid is what releases a ticket that was waiting for payment.
// orders/updated is accepted (it carries payment changes too) but isn't
// needed — see NOTES §2.111 for which topics to subscribe.
const ORDER_TOPICS = new Set(['orders/create', 'orders/paid', 'orders/updated', 'orders/cancelled']);

router.post('/webhooks', asyncHandler(async (req, res) => {
  const topic = req.get('X-Shopify-Topic') || '';
  if (ORDER_TOPICS.has(topic)) {
    const row = await shopifyOrders.recordOrder(topic, req.body);
    if (row) shopifyOrders.processOrderSoon(row.id);
  }
  // Any other subscribed topic is acknowledged and ignored.
  res.status(200).json({ ok: true });
}));

module.exports = router;
