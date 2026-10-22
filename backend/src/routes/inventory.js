'use strict';

/**
 * Unified inventory (migration 072) — everything the shop holds: its own
 * stock, the old showroom/rental fleet (now just "not for sale"), and
 * consignments. Customer instruments live in the same `instruments` table
 * but never appear here (ownership = 'customer').
 *
 *   GET    /api/inventory/meta                 vocab for the UI
 *   GET    /api/inventory                      list (filters below)
 *   POST   /api/inventory                      add a piece
 *   GET    /api/inventory/:id                  detail (+ photos, tickets, history)
 *   PATCH  /api/inventory/:id                  edit
 *
 *   Parts & accessories (counted stock, inventory_parts):
 *   GET/POST /api/inventory/parts, PATCH/DELETE /api/inventory/parts/:id
 *
 *   Photo sets (named batches: "Intake", "Listing", ...):
 *   POST   /api/inventory/:id/photo-sets
 *   PATCH  /api/inventory/photo-sets/:setId    rename / redate
 *   DELETE /api/inventory/photo-sets/:setId    removes its photos too
 *   GET    /api/inventory/photo-sets/:setId/zip
 *   POST   /api/inventory/photo-sets/:setId/upload-url   (GCS: signed PUT)
 *   POST   /api/inventory/photo-sets/:setId/confirm      (GCS: record it)
 *   POST   /api/inventory/photo-sets/:setId/photos       (local: multipart)
 *   GET    /api/inventory/photos/:photoId/view           <img src> target
 *   PATCH  /api/inventory/photos/:photoId                caption / set / order
 *   DELETE /api/inventory/photos/:photoId
 *
 * Literal sub-paths (meta, parts, photo-sets, photos) are registered before
 * '/:id' — Express matches in registration order.
 */

const express = require('express');
const multer = require('multer');
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  asyncHandler, badRequest, notFound, HttpError,
} = require('../middleware/errors');
const storage = require('../storage');
const config = require('../config');
const inv = require('../services/inventory');
const { createZipWriter } = require('../services/zipStream');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadBytes, files: 10 },
});

const forbidden = (msg) => new HttpError(403, msg);
const isAdmin = (req) => req.user?.role === 'admin';

const assertMime = (mime) => {
  if (!config.storage.allowedMimeTypes.includes(mime)) {
    throw badRequest(`Unsupported file type: ${mime}`);
  }
};

// ---------------------------------------------------------------------------
// Field normalisers — shared by POST and PATCH. Each returns the value to
// store, or throws a 400 the form can show. `undefined` in a body means
// "leave it alone"; '' or null means "clear it".
// ---------------------------------------------------------------------------
const text = (max = 2000) => (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const money = (field) => (v) => {
  if (v === null || v === '') return null;
  const n = inv.parseMoney(v);
  if (n === null || n < 0) throw badRequest(`${field} must be a non-negative amount`);
  return n;
};
const oneOf = (field, allowed) => (v) => {
  if (!allowed.includes(v)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return v;
};
const bool = (v) => v === true || v === 'true' || v === 1;
const intOrNull = (field) => (v) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be a whole number`);
  return n;
};
const dateOrNull = (field) => (v) => {
  if (v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw badRequest(`${field} must be YYYY-MM-DD`);
  return String(v);
};
const condition = (v) => {
  if (v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('condition must be an object');
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const s = val === null || val === undefined ? '' : String(val).trim();
    if (s) out[String(k).slice(0, 40)] = s.slice(0, 200);
  }
  return out;
};

const FIELDS = {
  family: oneOf('family', inv.FAMILIES),
  model: text(300),
  year: text(40),
  serial_no: text(120),
  nickname: text(120),
  identifying_notes: text(4000),
  model_group: text(120),
  ownership: oneOf('ownership', inv.OWNERSHIPS),
  sale_status: oneOf('sale_status', inv.SALE_STATUSES),
  nfs_reason: text(200),
  hold_for: text(200),
  asking_price: money('asking_price'),
  price_note: text(500),
  on_website: bool,
  condition,
  customer_id: intOrNull('customer_id'), // the consignor, for a consignment
  consignor_name: text(200),
  consignment_rate: (v) => {
    if (v === null || v === '') return null;
    const n = Number(String(v).replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('consignment_rate must be 0-100');
    return n;
  },
  sold_at: dateOrNull('sold_at'),
  sold_price: money('sold_price'),
  sold_to_name: text(200),
  sold_to_customer_id: intOrNull('sold_to_customer_id'),
  qc_notes: text(4000),
  last_qc_at: dateOrNull('last_qc_at'),
  qc_interval_months: (v) => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (![3, 6, 12].includes(n)) throw badRequest('qc_interval_months must be 3, 6, 12, or empty');
    return n;
  },
  cover_photo_id: intOrNull('cover_photo_id'),
  // admin only — see ADMIN_FIELDS
  cost_paid: money('cost_paid'),
  cost_note: text(500),
};
const ADMIN_FIELDS = new Set(['cost_paid', 'cost_note']);

// Changes to these are written to instrument_events — the sales-relevant
// history ("who dropped the price, when did it go on hold").
const LOGGED_FIELDS = new Set([
  'sale_status', 'asking_price', 'ownership', 'on_website', 'hold_for',
  'nfs_reason', 'sold_price', 'customer_id', 'cost_paid',
]);

function pickFields(body, req) {
  const out = {};
  for (const [field, normalise] of Object.entries(FIELDS)) {
    if (body[field] === undefined) continue;
    if (ADMIN_FIELDS.has(field) && !isAdmin(req)) {
      throw forbidden('Only admins can change what was paid');
    }
    out[field] = normalise(body[field]);
  }
  return out;
}

const eventValue = (v) => {
  if (v === null || v === undefined) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------
router.get('/meta', (req, res) => {
  res.json({
    families: inv.FAMILIES,
    ownerships: inv.OWNERSHIPS,
    sale_statuses: inv.SALE_STATUSES,
    sale_status_labels: inv.SALE_STATUS_LABELS,
    condition_fields: inv.CONDITION_FIELDS,
    nfs_reason_presets: inv.NFS_REASON_PRESETS,
    photo_set_presets: inv.PHOTO_SET_PRESETS,
  });
});

// ---------------------------------------------------------------------------
// Parts & accessories
// ---------------------------------------------------------------------------
const PART_FIELDS = {
  family: oneOf('family', inv.FAMILIES),
  category: text(120),
  name: text(300),
  model: text(300),
  quantity: (v) => {
    const n = intOrNull('quantity')(v);
    if (n !== null && n < 0) throw badRequest('quantity cannot be negative');
    return n;
  },
  quantity_note: text(200),
  condition: text(300),
  price: money('price'),
  price_note: text(500),
  for_sale: bool,
  on_website: bool,
  notes: text(4000),
  sort_order: intOrNull('sort_order'),
  cost_paid: money('cost_paid'),
  cost_note: text(500),
};

function pickPartFields(body, req) {
  const out = {};
  for (const [field, normalise] of Object.entries(PART_FIELDS)) {
    if (body[field] === undefined) continue;
    if (ADMIN_FIELDS.has(field) && !isAdmin(req)) throw forbidden('Only admins can change what was paid');
    out[field] = normalise(body[field]);
  }
  return out;
}

const redactPart = (row, req) => {
  const out = { ...row };
  delete out.import_raw;
  if (!isAdmin(req)) { delete out.cost_paid; delete out.cost_note; }
  return out;
};

router.get('/parts', asyncHandler(async (req, res) => {
  const params = [];
  const clauses = [];
  if (req.query.family) { params.push(req.query.family); clauses.push(`family = $${params.length}`); }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    clauses.push(`(name ILIKE $${params.length} OR model ILIKE $${params.length}
                   OR notes ILIKE $${params.length} OR category ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM inventory_parts ${where}
      ORDER BY array_position($${params.length + 1}::text[], family), sort_order NULLS LAST, id`,
    [...params, inv.FAMILIES],
  );
  res.json(rows.map((r) => redactPart(r, req)));
}));

router.post('/parts', asyncHandler(async (req, res) => {
  const f = pickPartFields(req.body || {}, req);
  if (!f.family) throw badRequest('family is required');
  if (!f.name) throw badRequest('name is required');
  const cols = Object.keys(f);
  const { rows } = await query(
    `INSERT INTO inventory_parts (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    cols.map((c) => f[c]),
  );
  res.status(201).json(redactPart(rows[0], req));
}));

router.patch('/parts/:id', asyncHandler(async (req, res) => {
  const f = pickPartFields(req.body || {}, req);
  if ('name' in f && !f.name) throw badRequest('name cannot be blank');
  const cols = Object.keys(f);
  if (!cols.length) throw badRequest('Nothing to update');
  const { rows } = await query(
    `UPDATE inventory_parts SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
      WHERE id = $1 RETURNING *`,
    [req.params.id, ...cols.map((c) => f[c])],
  );
  if (!rows[0]) throw notFound('Part not found');
  res.json(redactPart(rows[0], req));
}));

router.delete('/parts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM inventory_parts WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Part not found');
  res.json({ deleted: true });
}));

// ---------------------------------------------------------------------------
// Photo sets & photos
// ---------------------------------------------------------------------------
async function loadSet(setId) {
  const { rows } = await query('SELECT * FROM instrument_photo_sets WHERE id = $1', [setId]);
  if (!rows[0]) throw notFound('Photo set not found');
  return rows[0];
}

const photoKey = (instrumentId, fileName) => storage.buildObjectKey(`instruments/${instrumentId}`, fileName);

async function insertPhoto(set, req, {
  key, fileName, contentType, size, caption,
}) {
  const { rows } = await query(
    `INSERT INTO instrument_photos
       (set_id, instrument_id, uploader_id, storage_key, driver, file_name, content_type,
        size_bytes, caption, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM instrument_photos WHERE set_id = $1))
     RETURNING *`,
    [set.id, set.instrument_id, req.user.id, key, storage.name,
      fileName || null, contentType || null, size || null, caption || null],
  );
  // First photo on a piece becomes its cover automatically — the list page
  // thumbnail shouldn't need a separate click to show up.
  await query(
    'UPDATE instruments SET cover_photo_id = $2 WHERE id = $1 AND cover_photo_id IS NULL',
    [set.instrument_id, rows[0].id],
  );
  return rows[0];
}

router.patch('/photo-sets/:setId', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = b.name === undefined ? undefined : text(120)(b.name);
  if (name === null) throw badRequest('name cannot be blank');
  const takenOn = b.taken_on === undefined ? undefined : dateOrNull('taken_on')(b.taken_on);
  const { rows } = await query(
    `UPDATE instrument_photo_sets SET
       name = COALESCE($2, name),
       taken_on = COALESCE($3, taken_on)
     WHERE id = $1 RETURNING *`,
    [req.params.setId, name ?? null, takenOn ?? null],
  );
  if (!rows[0]) throw notFound('Photo set not found');
  res.json(rows[0]);
}));

router.delete('/photo-sets/:setId', asyncHandler(async (req, res) => {
  const set = await loadSet(req.params.setId);
  if (!isAdmin(req) && set.created_by !== req.user.id) {
    throw forbidden('Only an admin or whoever created this set can delete it');
  }
  const { rows: photos } = await query('SELECT storage_key FROM instrument_photos WHERE set_id = $1', [set.id]);
  // Storage first, rows second: a half-failed delete then leaves rows
  // pointing at missing objects (visible, retryable) rather than orphaned
  // objects nobody can see.
  for (const p of photos) {
    // eslint-disable-next-line no-await-in-loop
    await storage.deleteObject(p.storage_key);
  }
  await query('DELETE FROM instrument_photo_sets WHERE id = $1', [set.id]);
  res.json({ deleted: true, photos_deleted: photos.length });
}));

router.get('/photo-sets/:setId/zip', asyncHandler(async (req, res) => {
  const set = await loadSet(req.params.setId);
  if (!storage.readObject) throw badRequest('This storage driver cannot read objects back');
  const { rows: photos } = await query(
    'SELECT * FROM instrument_photos WHERE set_id = $1 ORDER BY sort_order, uploaded_at, id',
    [set.id],
  );
  if (!photos.length) throw badRequest('This set has no photos yet');
  const { rows: instRows } = await query(
    'SELECT id, family, nickname, model FROM instruments WHERE id = $1', [set.instrument_id],
  );
  const inst = instRows[0];
  const slug = (s) => String(s || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const base = [inv.stockNumber(inst), inst.nickname || inst.model, set.name].map(slug).filter(Boolean).join('-');

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${base}.zip"`);
  const zip = createZipWriter(res);
  const used = new Set();
  for (const [i, p] of photos.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const data = await storage.readObject(p.storage_key);
    const ext = p.content_type === 'image/png' ? '.png' : p.content_type === 'image/webp' ? '.webp' : '.jpg';
    let name = `${String(i + 1).padStart(2, '0')}-${slug(p.caption) || slug((p.file_name || 'photo').replace(/\.\w+$/, ''))}${ext}`;
    while (used.has(name)) name = name.replace(ext, `_${i}${ext}`);
    used.add(name);
    zip.addFile(name, data, new Date(p.uploaded_at));
  }
  zip.finish();
}));

router.post('/photo-sets/:setId/upload-url', asyncHandler(async (req, res) => {
  if (!storage.supportsDirectUpload) {
    throw badRequest(`Storage driver '${storage.name}' does not support direct upload`);
  }
  const { file_name: fileName, content_type: contentType } = req.body || {};
  if (!contentType) throw badRequest('content_type is required');
  assertMime(contentType);
  const set = await loadSet(req.params.setId);
  const key = photoKey(set.instrument_id, fileName);
  const target = await storage.createUploadUrl({ key, contentType });
  res.json({ storage_key: key, ...target });
}));

router.post('/photo-sets/:setId/confirm', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.storage_key) throw badRequest('storage_key is required');
  const set = await loadSet(req.params.setId);
  // Only a key this route could have issued — no registering some other
  // record's object as this instrument's photo.
  if (!String(b.storage_key).startsWith(`instruments/${set.instrument_id}/`)) {
    throw badRequest('storage_key does not belong to this instrument');
  }
  let size = b.size_bytes || null;
  if (storage.statObject) {
    const stat = await storage.statObject(b.storage_key);
    if (!stat) throw badRequest('Upload was not found in storage — it may have failed');
    size = stat.size;
  }
  const row = await insertPhoto(set, req, {
    key: b.storage_key, fileName: b.file_name, contentType: b.content_type, size, caption: b.caption,
  });
  res.status(201).json(row);
}));

router.post('/photo-sets/:setId/photos', upload.array('files', 10), asyncHandler(async (req, res) => {
  if (!req.files || !req.files.length) throw badRequest('No files were uploaded');
  const set = await loadSet(req.params.setId);
  const created = [];
  for (const file of req.files) {
    assertMime(file.mimetype);
    const key = photoKey(set.instrument_id, file.originalname);
    // eslint-disable-next-line no-await-in-loop
    await storage.putObject({ key, buffer: file.buffer, contentType: file.mimetype });
    // eslint-disable-next-line no-await-in-loop
    created.push(await insertPhoto(set, req, {
      key, fileName: file.originalname, contentType: file.mimetype, size: file.size, caption: req.body.caption,
    }));
  }
  res.status(201).json(created);
}));

/**
 * Stable URL for an <img> tag. GCS: redirect to a short-lived signed URL
 * (so the list page doesn't sign 200 URLs up front — the browser only asks
 * for thumbnails it actually renders). Local: stream the file, auth applies.
 */
router.get('/photos/:photoId/view', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT storage_key, content_type FROM instrument_photos WHERE id = $1', [req.params.photoId],
  );
  if (!rows[0]) throw notFound('Photo not found');
  res.set('Cache-Control', 'private, max-age=300');
  if (storage.supportsDirectUpload) {
    return res.redirect(302, await storage.getDownloadUrl(rows[0].storage_key));
  }
  const buffer = await storage.readObject(rows[0].storage_key);
  res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
  return res.send(buffer);
}));

router.patch('/photos/:photoId', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { rows: existing } = await query('SELECT * FROM instrument_photos WHERE id = $1', [req.params.photoId]);
  const photo = existing[0];
  if (!photo) throw notFound('Photo not found');

  let setId = photo.set_id;
  if (b.set_id !== undefined && Number(b.set_id) !== photo.set_id) {
    const target = await loadSet(b.set_id);
    if (target.instrument_id !== photo.instrument_id) throw badRequest('That set belongs to a different instrument');
    setId = target.id;
  }
  const caption = b.caption === undefined ? photo.caption : text(500)(b.caption);
  const sortOrder = b.sort_order === undefined ? photo.sort_order : intOrNull('sort_order')(b.sort_order) ?? 0;
  const { rows } = await query(
    'UPDATE instrument_photos SET caption = $2, set_id = $3, sort_order = $4 WHERE id = $1 RETURNING *',
    [photo.id, caption, setId, sortOrder],
  );
  res.json(rows[0]);
}));

router.delete('/photos/:photoId', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM instrument_photos WHERE id = $1', [req.params.photoId]);
  const photo = rows[0];
  if (!photo) throw notFound('Photo not found');
  if (!isAdmin(req) && photo.uploader_id !== req.user.id) {
    throw forbidden('You can only delete your own uploads');
  }
  await storage.deleteObject(photo.storage_key);
  await query('DELETE FROM instrument_photos WHERE id = $1', [photo.id]);
  res.json({ deleted: true });
}));

// ---------------------------------------------------------------------------
// List
//   status   active (default: everything not sold) | for_sale (available +
//            on_hold) | available | on_hold | not_for_sale | sold | all
//   family, ownership, q, on_website=true|false
// ---------------------------------------------------------------------------
const STATUS_FILTERS = {
  active: ["i.sale_status <> 'sold'"],
  for_sale: ["i.sale_status IN ('available', 'on_hold')"],
  available: ["i.sale_status = 'available'"],
  on_hold: ["i.sale_status = 'on_hold'"],
  not_for_sale: ["i.sale_status = 'not_for_sale'"],
  sold: ["i.sale_status = 'sold'"],
  all: [],
};

const LIST_SELECT = `
  SELECT i.*, c.name AS customer_name, c.xero_contact_id AS customer_xero_contact_id,
         (SELECT count(*)::int FROM tickets t WHERE t.instrument_id = i.id AND t.archived = FALSE)
           AS open_tickets,
         (SELECT count(*)::int FROM instrument_photos p WHERE p.instrument_id = i.id)
           AS photo_count
    FROM instruments i
    LEFT JOIN customers c ON c.id = i.customer_id
`;

router.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status || 'active';
  if (!STATUS_FILTERS[status]) {
    throw badRequest(`status must be one of: ${Object.keys(STATUS_FILTERS).join(', ')}`);
  }
  const clauses = ["i.ownership <> 'customer'", ...STATUS_FILTERS[status]];
  const params = [];
  if (req.query.family) { params.push(req.query.family); clauses.push(`i.family = $${params.length}`); }
  if (req.query.ownership) { params.push(req.query.ownership); clauses.push(`i.ownership = $${params.length}`); }
  if (req.query.on_website === 'true') clauses.push('i.on_website = TRUE');
  if (req.query.on_website === 'false') clauses.push('i.on_website = FALSE');
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    clauses.push(`(i.nickname ILIKE ${p} OR i.model ILIKE ${p} OR i.serial_no ILIKE ${p}
                   OR i.identifying_notes ILIKE ${p} OR i.consignor_name ILIKE ${p}
                   OR i.sold_to_name ILIKE ${p} OR c.name ILIKE ${p})`);
  }
  params.push(inv.FAMILIES);
  const familyOrder = `array_position($${params.length}::text[], i.family)`;
  // Sold pieces read best newest-first; everything else in sheet order
  // (family, then section in the order it first appears, then row).
  const order = status === 'sold'
    ? `i.sold_at DESC NULLS LAST, ${familyOrder}, i.sort_order NULLS LAST, i.id DESC`
    : `${familyOrder},
       MIN(i.sort_order) OVER (PARTITION BY i.family, COALESCE(i.model_group, '')) NULLS LAST,
       i.model_group NULLS LAST, i.sort_order NULLS LAST, i.id`;

  const { rows } = await query(
    `${LIST_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT 2000`,
    params,
  );
  res.json(rows.map((r) => inv.redactForRole(r, req.user)));
}));

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const f = pickFields(req.body || {}, req);
  if (!f.family) throw badRequest('family is required');
  if (!f.model && !f.nickname) throw badRequest('Give it a name or a model');
  f.ownership = f.ownership || 'shop';
  f.sale_status = f.sale_status || 'available';
  if (f.sale_status === 'sold' && !f.sold_at) f.sold_at = new Date().toISOString().slice(0, 10);
  delete f.cover_photo_id;

  const cols = Object.keys(f);
  const row = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO instruments (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      cols.map((c) => f[c]),
    );
    await client.query(
      `INSERT INTO instrument_events (instrument_id, employee_id, field, new_value)
       VALUES ($1, $2, 'created', $3)`,
      [rows[0].id, req.user.id, rows[0].sale_status],
    );
    return rows[0];
  });
  res.status(201).json(inv.redactForRole(row, req.user));
}));

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
async function loadInventoryRow(id) {
  const { rows } = await query(`${LIST_SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw notFound('Instrument not found');
  if (rows[0].ownership === 'customer') {
    throw badRequest('That instrument belongs to a customer — it is not part of inventory');
  }
  return rows[0];
}

router.get('/:id', asyncHandler(async (req, res) => {
  const row = await loadInventoryRow(req.params.id);
  const id = row.id;

  const [tickets, rentals, purchases, sets, photos, ticketPhotos, events, soldTo] = await Promise.all([
    query(
      `SELECT t.id, t.title, t.status_key, t.archived, t.updated_at, t.category_key,
              s.label AS status_label
         FROM tickets t
         LEFT JOIN settings s ON s.category = 'ticket_status' AND s.key = t.status_key
        WHERE t.instrument_id = $1 ORDER BY t.archived, t.updated_at DESC`,
      [id],
    ),
    query('SELECT * FROM instrument_rentals WHERE instrument_id = $1 ORDER BY start_date DESC', [id]),
    // What the shop paid the seller is cost information — admins only.
    isAdmin(req)
      ? query('SELECT * FROM instrument_purchases WHERE instrument_id = $1 ORDER BY purchase_date DESC', [id])
      : Promise.resolve({ rows: [] }),
    query(
      `SELECT s.*, e.name AS created_by_name, t.title AS ticket_title
         FROM instrument_photo_sets s
         LEFT JOIN employees e ON e.id = s.created_by
         LEFT JOIN tickets t ON t.id = s.ticket_id
        WHERE s.instrument_id = $1 ORDER BY s.taken_on DESC, s.id DESC`,
      [id],
    ),
    query(
      `SELECT p.*, e.name AS uploader_name FROM instrument_photos p
         LEFT JOIN employees e ON e.id = p.uploader_id
        WHERE p.instrument_id = $1 ORDER BY p.sort_order, p.uploaded_at, p.id`,
      [id],
    ),
    // Read-only: photos taken on this piece's tickets, so the history is in
    // one place without copying files around.
    query(
      `SELECT a.id, a.ticket_id, a.caption, a.file_name, a.uploaded_at, t.title AS ticket_title
         FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id
        WHERE t.instrument_id = $1 ORDER BY a.uploaded_at DESC`,
      [id],
    ),
    query(
      `SELECT ev.*, e.name AS employee_name FROM instrument_events ev
         LEFT JOIN employees e ON e.id = ev.employee_id
        WHERE ev.instrument_id = $1 ORDER BY ev.created_at DESC, ev.id DESC LIMIT 100`,
      [id],
    ),
    row.sold_to_customer_id
      ? query('SELECT id, name, email FROM customers WHERE id = $1', [row.sold_to_customer_id])
      : Promise.resolve({ rows: [] }),
  ]);

  const photosBySet = {};
  for (const p of photos.rows) (photosBySet[p.set_id] ||= []).push(p);

  res.json({
    ...inv.redactForRole(row, req.user),
    sold_to_customer: soldTo.rows[0] || null,
    tickets: tickets.rows,
    rentals: rentals.rows,
    purchases: purchases.rows,
    photo_sets: sets.rows.map((s) => ({ ...s, photos: photosBySet[s.id] || [] })),
    ticket_photos: ticketPhotos.rows,
    events: events.rows.filter((e) => isAdmin(req) || e.field !== 'cost_paid'),
  });
}));

router.post('/:id/photo-sets', asyncHandler(async (req, res) => {
  const row = await loadInventoryRow(req.params.id);
  const b = req.body || {};
  const name = text(120)(b.name);
  if (!name) throw badRequest('Give the set a name (e.g. "Intake")');
  const takenOn = b.taken_on ? dateOrNull('taken_on')(b.taken_on) : null;
  const ticketId = b.ticket_id ? intOrNull('ticket_id')(b.ticket_id) : null;
  const { rows } = await query(
    `INSERT INTO instrument_photo_sets (instrument_id, name, taken_on, ticket_id, created_by)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5) RETURNING *`,
    [row.id, name, takenOn, ticketId, req.user.id],
  );
  res.status(201).json({ ...rows[0], photos: [] });
}));

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const f = pickFields(req.body || {}, req);
  const cols = Object.keys(f);
  if (!cols.length) throw badRequest('Nothing to update');

  const updated = await withTransaction(async (client) => {
    const { rows: before } = await client.query(
      'SELECT * FROM instruments WHERE id = $1 FOR UPDATE', [req.params.id],
    );
    const old = before[0];
    if (!old) throw notFound('Instrument not found');
    if (old.ownership === 'customer') throw badRequest('That instrument belongs to a customer — edit it from Customers');

    if ('model' in f && !f.model && !(f.nickname ?? old.nickname)) {
      throw badRequest('Give it a name or a model');
    }
    if (f.cover_photo_id) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM instrument_photos WHERE id = $1 AND instrument_id = $2', [f.cover_photo_id, old.id],
      );
      if (!rowCount) throw badRequest("That photo isn't one of this instrument's");
    }
    // Marking something sold without a date: today. Moving it back out of
    // sold keeps the sale fields — easy to see what was undone, and a mistaken
    // click doesn't wipe the buyer.
    if (f.sale_status === 'sold' && old.sale_status !== 'sold' && f.sold_at === undefined && !old.sold_at) {
      f.sold_at = new Date().toISOString().slice(0, 10);
    }

    const setCols = Object.keys(f);
    const { rows } = await client.query(
      `UPDATE instruments SET ${setCols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
        WHERE id = $1 RETURNING *`,
      [old.id, ...setCols.map((c) => f[c])],
    );

    for (const field of setCols) {
      if (!LOGGED_FIELDS.has(field)) continue;
      const was = eventValue(old[field]);
      const now = eventValue(rows[0][field]);
      // NUMERIC comes back as '7750.00' — compare as numbers where both are.
      const same = was === now || (was !== null && now !== null && Number(was) === Number(now));
      if (same) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5)`,
        [old.id, req.user.id, field, was, now],
      );
    }
    return rows[0];
  });

  const row = await loadInventoryRow(updated.id);
  res.json(inv.redactForRole(row, req.user));
}));

module.exports = router;
