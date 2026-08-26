'use strict';

/**
 * One-off (re-runnable) setup script: registers the Shopify Admin API
 * webhook subscriptions that routes/shopifyWebhooks.js needs, pointed at
 * this deployment's public URL. Safe to run more than once — it skips any
 * topic that's already registered to the same address.
 *
 * Requires SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, and PUBLIC_BASE_URL
 * to be set (see .env.example). Run with: npm run shopify:register-webhooks
 */

const config = require('../config');
const { adminApiRequest } = require('../shopify');

// orders/updated is registered so Shopify doesn't need re-subscribing later
// if that gets acted on, but shopifyWebhooks.js currently just acknowledges
// it without changing anything — see NOTES.md.
const TOPICS = ['orders/create', 'orders/updated', 'orders/cancelled'];

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
