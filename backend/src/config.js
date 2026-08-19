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
};

if (config.env === 'production' && config.jwtSecret === 'dev-only-insecure-secret') {
  // Fail loudly rather than silently signing tokens with a public secret.
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
