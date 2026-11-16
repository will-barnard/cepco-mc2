'use strict';

/**
 * One-off (re-runnable) setup script: registers the Shopify Admin API
 * webhook subscriptions that routes/shopifyWebhooks.js needs, pointed at
 * this deployment's public URL. Safe to run more than once — it skips any
 * topic that's already registered to the same address.
 *
 * Requires SHOPIFY_SHOP_DOMAIN, PUBLIC_BASE_URL, and either SHOPIFY_CLIENT_ID +
 * SHOPIFY_CLIENT_SECRET or SHOPIFY_ADMIN_API_TOKEN (see .env.example). Run
 * with: npm run shopify:register-webhooks
 *
 * Prefer declaring these in the Dev Dashboard app version's webhook
 * subscriptions instead (NOTES §2.111): those are app-level and survive
 * delivery failures, while subscriptions made here are shop-level and
 * Shopify removes them after repeated failed deliveries. This script is
 * kept for a quick re-point after PUBLIC_BASE_URL changes.
 */

const config = require('../config');
const { adminApiRequest } = require('../shopify');

// orders/paid releases tickets that wait for payment. orders/updated was
// dropped: it fires on every edit of every order and intake doesn't need
// it (the route still accepts it if something else subscribes it).
const TOPICS = ['orders/create', 'orders/paid', 'orders/cancelled'];

async function registerShopifyWebhooks() {
  if (!config.storage.publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL must be set so Shopify has a reachable address to call');
  }
  const address = `${config.storage.publicBaseUrl}/api/shopify/webhooks`;

  const { webhooks: existing } = await adminApiRequest('webhooks.json?limit=250');
  const already = new Set(
    (existing || [])
      .filter((w) => w.address === address)
      .map((w) => w.topic),
  );

  for (const topic of TOPICS) {
    if (already.has(topic)) {
      console.log(`[shopify] ${topic} already registered -> ${address}`);
      continue;
    }
    const { webhook } = await adminApiRequest('webhooks.json', {
      method: 'POST',
      body: { webhook: { address, topic, format: 'json' } },
    });
    console.log(`[shopify] registered ${topic} -> ${address} (id ${webhook.id})`);
  }
}

module.exports = { registerShopifyWebhooks };

if (require.main === module) {
  registerShopifyWebhooks()
    .then(() => console.log('[shopify] done'))
    .catch((err) => {
      console.error('[shopify]', err);
      process.exit(1);
    });
}
