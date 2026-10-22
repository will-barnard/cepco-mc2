'use strict';

/**
 * Storage adapter (PLAN §10).
 *
 * Two drivers behind one interface, chosen by STORAGE_DRIVER:
 *   local — writes to a container volume. Dev and pre-GCS production.
 *   gcs   — Google Cloud Storage with signed URLs, direct browser->bucket
 *           upload so large phone photos never transit the Express process.
 *
 * Interface:
 *   name
 *   supportsDirectUpload  -> whether createUploadUrl() is usable
 *   createUploadUrl({ key, contentType })  -> { url, method, headers }
 *   putObject({ key, buffer, contentType }) -> void   (server-side fallback)
 *   getDownloadUrl(key)   -> string (may be signed & time-limited)
 *   deleteObject(key)     -> void
 */

const config = require('../config');

const drivers = {
  local: () => require('./localDriver'),
  gcs: () => require('./gcsDriver'),
};

const factory = drivers[config.storage.driver];
if (!factory) {
  throw new Error(
    `Unknown STORAGE_DRIVER '${config.storage.driver}'. Expected one of: ${Object.keys(drivers).join(', ')}`,
  );
}

const driver = factory();

console.log(`[storage] driver=${driver.name} directUpload=${driver.supportsDirectUpload}`);

/** Collision-proof object key under any prefix (e.g. `instruments/12`). */
function buildObjectKey(prefix, fileName) {
  const safe = String(fileName || 'photo')
    .replace(/[^\w.\-]+/g, '_')
    .slice(-80);
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}/${stamp}-${rand}-${safe}`;
}

/** Build a collision-proof object key for a ticket attachment. */
function buildKey(ticketId, fileName) {
  return buildObjectKey(`tickets/${ticketId}`, fileName);
}

module.exports = { ...driver, buildKey, buildObjectKey };
