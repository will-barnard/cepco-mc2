'use strict';

/**
 * Google Cloud Storage driver (PLAN §11).
 *
 * Auth resolution order:
 *   1. GCS_SERVICE_ACCOUNT_KEY — full service-account JSON, single line.
 *   2. Application Default Credentials — used automatically when the var is
 *      absent. This is the Workload Identity / attached-service-account path
 *      for a GCE host, and requires no secret in the Beachhead dashboard.
 *
 * The bucket must stay private. Reads go out as V4 signed URLs with a short
 * TTL; nothing is ever made public.
 */

const { Storage } = require('@google-cloud/storage');
const config = require('../config');

const { bucket: bucketName, projectId, serviceAccountKey, signedUrlTtlSeconds } = config.storage.gcs;

if (!bucketName) {
  throw new Error('STORAGE_DRIVER=gcs requires GCS_BUCKET_NAME');
}

let credentials;
if (serviceAccountKey) {
  try {
    credentials = JSON.parse(serviceAccountKey);
  } catch (err) {
    throw new Error('GCS_SERVICE_ACCOUNT_KEY is not valid JSON');
  }
}

const storage = new Storage({
  ...(projectId ? { projectId } : {}),
  ...(credentials ? { credentials } : {}),
});
const bucket = storage.bucket(bucketName);

const expires = () => Date.now() + signedUrlTtlSeconds * 1000;

/**
 * Signed PUT URL — the browser/phone uploads straight to the bucket.
 * Content-Type is bound into the signature, so the client must send the exact
 * same header or GCS rejects the upload.
 */
async function createUploadUrl({ key, contentType }) {
  const [url] = await bucket.file(key).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: expires(),
    contentType,
  });
  return { url, method: 'PUT', headers: { 'Content-Type': contentType } };
}

async function putObject({ key, buffer, contentType }) {
  await bucket.file(key).save(buffer, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'private, max-age=0' },
  });
}

async function readObject(key) {
  const [buf] = await bucket.file(key).download();
  return buf;
}

async function deleteObject(key) {
  await bucket.file(key).delete({ ignoreNotFound: true });
}

async function getDownloadUrl(key) {
  const [url] = await bucket.file(key).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: expires(),
  });
  return url;
}

/** Confirm an object actually landed after a direct upload. */
async function statObject(key) {
  const file = bucket.file(key);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [meta] = await file.getMetadata();
  return { size: Number(meta.size), contentType: meta.contentType };
}

module.exports = {
  name: 'gcs',
  supportsDirectUpload: true,
  createUploadUrl,
  putObject,
  readObject,
  deleteObject,
  getDownloadUrl,
  statObject,
};
