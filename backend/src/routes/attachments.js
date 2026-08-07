'use strict';

/**
 * Ticket photo attachments (PLAN §10).
 *
 * Two upload paths, so the same UI works against either storage driver:
 *
 *   GCS (production) — direct-to-bucket:
 *     1. POST /api/attachments/upload-url  -> signed PUT URL + storage_key
 *     2. browser PUTs the file straight to GCS (never touches Express)
 *     3. POST /api/attachments/confirm     -> writes the metadata row
 *
 *   Local (dev) — multipart through the API:
 *     POST /api/attachments  (field name: "files", up to 10)
 *
 * The frontend picks based on GET /api/attachments/capabilities.
 */

const express = require('express');
const multer = require('multer');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const storage = require('../storage');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadBytes, files: 10 },
});

const assertMime = (mime) => {
  if (!config.storage.allowedMimeTypes.includes(mime)) {
    throw badRequest(`Unsupported file type: ${mime}`);
  }
};

router.get('/capabilities', (req, res) => {
  res.json({
    driver: storage.name,
    direct_upload: storage.supportsDirectUpload,
    max_bytes: config.storage.maxUploadBytes,
    allowed_types: config.storage.allowedMimeTypes,
  });
});

// --- direct-upload path (GCS) ----------------------------------------------
router.post('/upload-url', asyncHandler(async (req, res) => {
  if (!storage.supportsDirectUpload) {
    throw badRequest(`Storage driver '${storage.name}' does not support direct upload`);
  }
  const { ticket_id: ticketId, file_name: fileName, content_type: contentType } = req.body || {};
  if (!ticketId) throw badRequest('ticket_id is required');
  if (!contentType) throw badRequest('content_type is required');
  assertMime(contentType);

  const { rowCount } = await query('SELECT 1 FROM tickets WHERE id = $1', [ticketId]);
  if (!rowCount) throw notFound('Ticket not found');

  const key = storage.buildKey(ticketId, fileName);
  const target = await storage.createUploadUrl({ key, contentType });
  res.json({ storage_key: key, ...target });
}));

router.post('/confirm', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.ticket_id || !b.storage_key) throw badRequest('ticket_id and storage_key are required');

  // Verify the object actually landed before recording it, so a failed browser
  // upload doesn't leave a broken thumbnail in the gallery.
  let size = b.size_bytes || null;
  if (storage.statObject) {
    const stat = await storage.statObject(b.storage_key);
    if (!stat) throw badRequest('Upload was not found in storage — it may have failed');
    size = stat.size;
  }

  const { rows } = await query(
    `INSERT INTO ticket_attachments
       (ticket_id, uploader_id, storage_key, driver, file_name, content_type, size_bytes, caption)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.ticket_id, req.user.id, b.storage_key, storage.name,
      b.file_name || null, b.content_type || null, size, b.caption || null],
  );
  res.status(201).json(rows[0]);
}));

// --- multipart path (local driver) -----------------------------------------
router.post('/', upload.array('files', 10), asyncHandler(async (req, res) => {
  const ticketId = req.body.ticket_id;
  if (!ticketId) throw badRequest('ticket_id is required');
  if (!req.files || !req.files.length) throw badRequest('No files were uploaded');

  const { rowCount } = await query('SELECT 1 FROM tickets WHERE id = $1', [ticketId]);
  if (!rowCount) throw notFound('Ticket not found');

  const created = [];
  for (const file of req.files) {
    assertMime(file.mimetype);
    const key = storage.buildKey(ticketId, file.originalname);
    // eslint-disable-next-line no-await-in-loop
    await storage.putObject({ key, buffer: file.buffer, contentType: file.mimetype });
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await query(
      `INSERT INTO ticket_attachments
         (ticket_id, uploader_id, storage_key, driver, file_name, content_type, size_bytes, caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ticketId, req.user.id, key, storage.name,
        file.originalname, file.mimetype, file.size, req.body.caption || null],
    );
    created.push(rows[0]);
  }
  res.status(201).json(created);
}));

// --- read / delete ---------------------------------------------------------
router.get('/ticket/:ticketId', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, e.name AS uploader_name FROM ticket_attachments a
       LEFT JOIN employees e ON e.id = a.uploader_id
      WHERE a.ticket_id = $1 ORDER BY a.uploaded_at DESC`,
    [req.params.ticketId],
  );
  res.json(rows);
}));

/** Resolve a viewable URL — signed for GCS, proxied for local. */
router.get('/:id/url', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM ticket_attachments WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Attachment not found');
  const url = await storage.getDownloadUrl(rows[0].storage_key);
  res.json({ url });
}));

/** Local-driver file proxy. Auth still applies, unlike a public bucket. */
router.get('/file/:key(*)', asyncHandler(async (req, res) => {
  if (!storage.readObject) throw badRequest('This storage driver does not serve files directly');
  const key = decodeURIComponent(req.params.key);
  const { rows } = await query(
    'SELECT content_type FROM ticket_attachments WHERE storage_key = $1', [key],
  );
  if (!rows[0]) throw notFound('Attachment not found');
  const buffer = await storage.readObject(key);
  res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(buffer);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM ticket_attachments WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Attachment not found');
  if (req.user.role !== 'admin' && rows[0].uploader_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own uploads' });
  }
  await storage.deleteObject(rows[0].storage_key);
  await query('DELETE FROM ticket_attachments WHERE id = $1', [req.params.id]);
  return res.json({ deleted: true });
}));

module.exports = router;
