'use strict';

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3001),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'cepco_mc2',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },

  // Chicago Electric Piano Company is, well, in Chicago — used wherever
  // "today" needs to mean the shop's calendar day rather than the
  // container's (typically UTC) default. See NOTES.md §2.13.
  shopTimezone: process.env.SHOP_TZ || 'America/Chicago',

  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  // Long-lived on purpose: internal tool on a private domain, techs shouldn't
  // have to re-login on the shop floor. Overridable via JWT_TTL_SECONDS.
  jwtTtlSeconds: int(process.env.JWT_TTL_SECONDS, 60 * 60 * 24 * 365 * 2),

  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local').toLowerCase(),
    localDir: process.env.STORAGE_LOCAL_DIR || '/data/uploads',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    gcs: {
      bucket: process.env.GCS_BUCKET_NAME || '',
      projectId: process.env.GCS_PROJECT_ID || '',
      serviceAccountKey: process.env.GCS_SERVICE_ACCOUNT_KEY || '',
      signedUrlTtlSeconds: int(process.env.GCS_SIGNED_URL_TTL_SECONDS, 15 * 60),
    },
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
    allowedMimeTypes: [
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif',
    ],
  },

  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || '',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  },

  // Purchase-receipt email (PLAN's Resend integration, brought forward from
  // Phase 2 just far enough for this one transactional email). Both unset
  // by default — see backend/src/mailer.js for what happens then.
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.RESEND_FROM_EMAIL || '',
  },

  // The frontend's own public URL, e.g. https://mc2.cepco.shop — used only
  // to build the customer-facing confirm/decline link embedded in a quote
  // email (routes/quotes.js's POST /:id/send). Unset by default like the
  // Resend keys above; that route refuses to send rather than mail out a
  // broken link.
  appBaseUrl: (process.env.APP_BASE_URL || '').replace(/\/$/, ''),

  // Shopify order intake (PLAN §11). webhookSecret verifies inbound webhook
  // requests (backend/src/shopify.js); shopDomain + adminApiToken are only
  // needed to *register* those webhooks (scripts/registerShopifyWebhooks.js)
  // — the receiving endpoint itself never calls back out to Shopify.
  shopify: {
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
    adminApiToken: process.env.SHOPIFY_ADMIN_API_TOKEN || '',
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  },

  // Two-way customer-contact sync (backend/src/xero.js,
  // services/xeroSync.js) via a Xero Custom Connection — single-org,
  // client_credentials, no per-user OAuth consent screen. Both unset by
  // default, same "the feature refuses to run rather than fail confusingly
  // half-configured" posture as resend/shopify above.
  xero: {
    clientId: process.env.XERO_CLIENT_ID || '',
    clientSecret: process.env.XERO_CLIENT_SECRET || '',
  },
};

if (config.env === 'production' && config.jwtSecret === 'dev-only-insecure-secret') {
  // Fail loudly rather than silently signing tokens with a public secret.
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
