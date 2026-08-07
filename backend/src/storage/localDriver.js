'use strict';

/**
 * Local-disk driver. Objects land under STORAGE_LOCAL_DIR, which is a named
 * Docker volume so they survive a Beachhead blue/green swap.
 *
 * Caveat, deliberately loud: a container volume is a single point of failure
 * with no backup story. This driver is for development and for the window
 * before the GCS bucket exists. See NOTES.md.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

const ROOT = config.storage.localDir;

fs.mkdirSync(ROOT, { recursive: true });

const resolveSafe = (key) => {
  const full = path.resolve(ROOT, key);
  // Refuse anything that escapes the root via ../ segments.
  if (!full.startsWith(path.resolve(ROOT) + path.sep)) {
    throw new Error('Invalid storage key');
  }
  return full;
};

async function putObject({ key, buffer }) {
  const full = resolveSafe(key);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, buffer);
}

async function readObject(key) {
  return fsp.readFile(resolveSafe(key));
}

async function deleteObject(key) {
  try {
    await fsp.unlink(resolveSafe(key));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Served back through the API (GET /api/attachments/:id/file) rather than a
 * signed URL, so auth still applies.
 */
function getDownloadUrl(key) {
  return `/api/attachments/file/${encodeURIComponent(key)}`;
}

module.exports = {
  name: 'local',
  supportsDirectUpload: false,
  createUploadUrl: null,
  putObject,
  readObject,
  deleteObject,
  getDownloadUrl,
};
