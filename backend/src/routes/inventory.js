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
 *   PUT    /api/inventory/:id/audit            { audited: bool } (inventory audit)
 *
 *   Parts & labor on a piece (instrument_parts, migration 078):
 *   GET    /api/inventory/:id/parts-used
 *   POST   /api/inventory/:id/parts-used       typed in, or inventory_part_id
 *   PATCH  /api/inventory/parts-used/:lineId
 *   DELETE /api/inventory/parts-used/:lineId   (a trigger returns any stock)
 *   GET    /api/inventory/reserved-parts       every reserved line (Reserved parts tab)
 *   GET    /api/inventory/audit                audit progress (Settings)
 *
 *   Parts & accessories (counted stock, inventory_parts):
 *   GET/POST /api/inventory/parts, PATCH/DELETE /api/inventory/parts/:id
 *   PUT    /api/inventory/parts/:id/audit
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
  asyncHandler, badRequest, notFound, conflict, HttpError,
} = require('../middleware/errors');
const storage = require('../storage');
const config = require('../config');
const inv = require('../services/inventory');
const catalog = require('../services/instrumentCatalog');
const detail = require('../services/instrumentDetail');
const ownership = require('../services/ownership');
const payouts = require('../services/consignmentPayouts');
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
// Links rendered as <a href>, so only http(s) gets through -- a
// "javascript:" URL pasted into the field would otherwise run on click.
const webUrl = (field) => (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  let parsed;
  try { parsed = new URL(s); } catch { throw badRequest(`${field} must be a full link starting with https://`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw badRequest(`${field} must be an http(s) link`);
  return s.slice(0, 1000);
};
// { field: grade key } -- grades are a fixed scale since migration 084
// (services/inventory.js's CONDITION_GRADES), picked from a dropdown, so
// anything else is refused rather than stored. A blank grade drops the
// field. Field keys aren't policed (see CONDITION_FIELDS).
const condition = (v) => {
  if (v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('condition must be an object');
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const s = val === null || val === undefined ? '' : String(val).trim();
    if (!s) continue;
    if (!inv.GRADE_KEYS.has(s)) {
      throw badRequest(`Condition "${s}" isn't a grade — pick one of: ${inv.CONDITION_GRADES.map((g) => g.label).join(', ')}`);
    }
    out[String(k).slice(0, 40)] = s;
  }
  return out;
};
// { field: free text } beside the grades -- "OG Cube", "light scratches".
const conditionNotes = (v) => {
  if (v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('condition_notes must be an object');
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
  // Catalog link + Mark (migration 086) -- both resolved by
  // services/instrumentCatalog.js's resolveModel, not validated here.
  model_id: (v) => (v === null || v === '' ? null : v),
  attrs: (v) => v, // { mark, suitcase_amp, ... } -- validated per family by resolveModel
  mark: text(20), // shorthand for attrs.mark
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
  condition_notes: conditionNotes,
  customer_id: intOrNull('customer_id'), // the consignor, for a consignment
  consignor_name: text(200),
  consignment_rate: (v) => {
    if (v === null || v === '') return null;
    const n = Number(String(v).replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('consignment_rate must be 0-100');
    return n;
  },
  consignment_status: (v) => (v === null || v === '' ? null : oneOf('consignment_status', inv.CONSIGNMENT_STATUSES)(v)),
  consignment_terms: text(500),
  // sold_at / sold_price / sold_to_* aren't editable here any more: a sale
  // is POST /:id/sell (migration 087), and its details live on the sale's
  // ownership period, edited through PATCH /instruments/ownership/:id.
  qc_notes: text(4000),
  last_qc_at: dateOrNull('last_qc_at'),
  qc_interval_months: (v) => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (![3, 6, 12].includes(n)) throw badRequest('qc_interval_months must be 3, 6, 12, or empty');
    return n;
  },
  cover_photo_id: intOrNull('cover_photo_id'),
  // Google Drive photo folder from the old Inventory Log sheet (migration
  // 082), or any album link added since.
  photo_album_url: webUrl('photo_album_url'),
  est_hours: (v) => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 9999) throw badRequest('est_hours must be a number of hours');
    return Math.round(n * 100) / 100;
  },
  // admin only — see ADMIN_FIELDS
  cost_paid: money('cost_paid'),
  cost_note: text(500),
};
const ADMIN_FIELDS = new Set(['cost_paid', 'cost_note']);

// Changes to these are written to instrument_events — the sales-relevant
// history ("who dropped the price, when did it go on hold").
const LOGGED_FIELDS = new Set([
  'sale_status', 'asking_price', 'ownership', 'on_website', 'hold_for',
  'nfs_reason', 'sold_price', 'customer_id', 'cost_paid', 'consignment_status',
]);

/**
 * Keeps consignment_status in step with ownership and sale status, so the
 * Consignments view's "Payout due" group can't silently miss a sale:
 *   - not a consignment            -> no consignment status
 *   - becomes a consignment        -> for sale (or payout due if already sold)
 *   - a consignment is marked sold -> payout due, unless already paid out
 * An explicit consignment_status in the same request always wins.
 * `old` is the row before the change ({} for a new piece); mutates `f`.
 */
function applyConsignmentRules(f, old) {
  const ownership = f.ownership ?? old.ownership;
  const saleStatus = f.sale_status ?? old.sale_status;
  const current = old.consignment_status ?? null;
  if (ownership !== 'consignment') {
    if (current !== null || f.consignment_status) f.consignment_status = null;
    return;
  }
  if (f.consignment_status !== undefined) return;
  const becameConsignment = old.ownership !== 'consignment';
  const becameSold = saleStatus === 'sold' && old.sale_status !== 'sold';
  if (becameSold && current !== 'paid_out') f.consignment_status = 'payout_due';
  else if (becameConsignment && current === null) {
    f.consignment_status = saleStatus === 'sold' ? 'payout_due' : 'for_sale';
  }
}

function pickFields(body, req) {
  if (body.sale_status === 'sold') {
    throw badRequest('Use "Mark sold" — a sale moves the piece to its buyer (and records who and for how much)');
  }
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
    consignment_statuses: inv.CONSIGNMENT_STATUSES,
    consignment_status_labels: inv.CONSIGNMENT_STATUS_LABELS,
    condition_fields: inv.CONDITION_FIELDS,
    condition_grades: inv.CONDITION_GRADES,
    attributes: inv.ATTRIBUTES,
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
  photo_album_url: webUrl('photo_album_url'), // migration 082
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
    `SELECT p.*, (SELECT e.name FROM employees e WHERE e.id = p.audited_by) AS audited_by_name
       FROM inventory_parts p ${where}
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
      WHERE id = $1
      RETURNING *, (SELECT e.name FROM employees e WHERE e.id = audited_by) AS audited_by_name`,
    [req.params.id, ...cols.map((c) => f[c])],
  );
  if (!rows[0]) throw notFound('Part not found');
  res.json(redactPart(rows[0], req));
}));

router.put('/parts/:id/audit', asyncHandler(async (req, res) => {
  const audited = !!(req.body || {}).audited;
  const { rows } = await query(
    `UPDATE inventory_parts SET audited_at = CASE WHEN $2 THEN now() END,
                                audited_by = CASE WHEN $2 THEN $3::int END
      WHERE id = $1
      RETURNING *, (SELECT e.name FROM employees e WHERE e.id = audited_by) AS audited_by_name`,
    [req.params.id, audited, req.user.id],
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
//            on_hold) | available | on_hold | not_for_sale | sold |
//            consignments (every consignment, sold or not) | all
//   family, ownership, q, on_website=true|false
// ---------------------------------------------------------------------------
const STATUS_FILTERS = {
  active: ["i.sale_status <> 'sold'"],
  for_sale: ["i.sale_status IN ('available', 'on_hold')"],
  available: ["i.sale_status = 'available'"],
  on_hold: ["i.sale_status = 'on_hold'"],
  not_for_sale: ["i.sale_status = 'not_for_sale'"],
  sold: ["i.sale_status = 'sold'"],
  consignments: ["i.ownership = 'consignment'"],
  all: [],
};

// The list row shape lives with the instrument page's loader
// (services/instrumentDetail.js) so the two can't drift apart.
const { LIST_SELECT } = detail;

// Sales (migration 087). A sold piece is its buyer's instrument now, so the
// Sold tab -- and sold consignments -- come from the sale periods in
// instrument_ownership, each shaped like the inventory row it was at the
// sale (shop or consignment, the consignor, the deal, the price and buyer).
// `row_key` tells a sale apart from the same instrument back in stock.
const SALES_SELECT = `
  SELECT to_jsonb(i) || jsonb_build_object(
           'ownership', s.kind, 'sale_status', 'sold',
           'customer_id', s.customer_id, 'customer_name', sc.name,
           'consignor_name', s.owner_name,
           'consignment_status', s.payout_status, 'consignment_rate', s.consignment_rate,
           'consignment_terms', s.consignment_terms, 'payout_ticket_id', s.payout_ticket_id,
           'sold_at', s.ended_on, 'sold_price', s.sale_price,
           'sold_to_name', COALESCE(s.sold_to_name, bc.name), 'sold_to_customer_id', s.sold_to_customer_id,
           'sale_id', s.id, 'owner_customer_id', i.customer_id, 'row_key', 's' || s.id) AS row,
         (SELECT e.name FROM employees e WHERE e.id = i.audited_by) AS audited_by_name,
         (SELECT count(*)::int FROM tickets t WHERE t.instrument_id = i.id AND t.archived = FALSE) AS open_tickets,
         (SELECT count(*)::int FROM instrument_photos p WHERE p.instrument_id = i.id) AS photo_count,
         ${catalog.FACTS_COLUMNS}
    FROM instrument_ownership s
    JOIN instruments i ON i.id = s.instrument_id
    LEFT JOIN customers sc ON sc.id = s.customer_id
    LEFT JOIN customers bc ON bc.id = s.sold_to_customer_id
    ${catalog.FACTS_JOIN}
   WHERE s.end_reason = 'sale'`;

async function listSales(req, { consignmentsOnly }) {
  const clauses = [];
  const params = [];
  if (consignmentsOnly) clauses.push("s.kind = 'consignment'");
  if (req.query.family) { params.push(req.query.family); clauses.push(`i.family = $${params.length}`); }
  if (req.query.ownership) { params.push(req.query.ownership); clauses.push(`s.kind = $${params.length}`); }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    clauses.push(`(i.nickname ILIKE ${p} OR i.model ILIKE ${p} OR i.serial_no ILIKE ${p}
                   OR i.identifying_notes ILIKE ${p} OR s.owner_name ILIKE ${p}
                   OR s.sold_to_name ILIKE ${p} OR bc.name ILIKE ${p} OR sc.name ILIKE ${p})`);
  }
  const { rows } = await query(
    `${SALES_SELECT} ${clauses.map((c) => `AND ${c}`).join(' ')}
      ORDER BY s.ended_on DESC NULLS LAST, s.id DESC LIMIT 2000`,
    params,
  );
  return rows.map(({ row, ...rest }) => ({ ...row, ...rest }));
}

router.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status || 'active';
  if (!STATUS_FILTERS[status]) {
    throw badRequest(`status must be one of: ${Object.keys(STATUS_FILTERS).join(', ')}`);
  }
  // Pieces in stock (or consigned) now -- everything but the Sold tab.
  let current = [];
  if (status !== 'sold') {
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
                     OR c.name ILIKE ${p})`);
    }
    params.push(inv.FAMILIES);
    // Sheet order: family, then section in the order it first appears, then row.
    const familyOrder = `array_position($${params.length}::text[], i.family)`;
    const { rows } = await query(
      `${LIST_SELECT} WHERE ${clauses.join(' AND ')}
        ORDER BY ${familyOrder},
          MIN(i.sort_order) OVER (PARTITION BY i.family, COALESCE(i.model_group, '')) NULLS LAST,
          i.model_group NULLS LAST, i.sort_order NULLS LAST, i.id
        LIMIT 2000`,
      params,
    );
    current = rows.map((r) => ({ ...r, row_key: `i${r.id}` }));
  }

  // Sales: the Sold tab, sold consignments, and "all". Website filters
  // don't apply -- a sold piece isn't listed.
  const wantsSales = ['sold', 'consignments', 'all'].includes(status) && req.query.on_website === undefined;
  const sales = wantsSales ? await listSales(req, { consignmentsOnly: status === 'consignments' }) : [];

  let rows = [...current, ...sales];
  if (status === 'consignments') {
    // By where the deal stands, payout due first (money owed), then newest sale.
    const rank = { payout_due: 0, contracted: 1, for_sale: 2, paid_out: 3 };
    const r = (cs) => (cs in rank ? rank[cs] : 4);
    rows = rows.sort((a, b) => r(a.consignment_status) - r(b.consignment_status)
      || String(b.sold_at || '').localeCompare(String(a.sold_at || ''))
      || a.id - b.id);
  }
  res.json(rows.map((r) => inv.redactForRole(r, req.user)));
}));

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const f = pickFields(req.body || {}, req);
  if (!f.family) throw badRequest('family is required');
  // A picked catalog model counts: its chain becomes the model text.
  if (!f.model && !f.nickname && !f.model_id) throw badRequest('Give it a name or a model');
  f.ownership = f.ownership || 'shop';
  f.sale_status = f.sale_status || 'available';
  applyConsignmentRules(f, {});
  delete f.cover_photo_id;

  const created = await withTransaction(async (client) => {
    await catalog.resolveModel(client, f, {});
    await ownership.setContext(client, { reason: 'added', employeeId: req.user.id });
    const cols = Object.keys(f);
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
  const row = await loadInventoryRow(created.id);
  res.status(201).json(inv.redactForRole(row, req.user));
}));

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
// Any instrument -- since migration 087 the instrument page, its photos,
// parts and audit work for customer instruments and sold pieces too. What
// stays inventory-only (sale / ownership edits) checks ownership itself.
const loadInventoryRow = (id) => detail.loadRow(id);

// ---------------------------------------------------------------------------
// Inventory audit (migration 077). The summary counts every shop-held piece
// — sold ones included, since the import rewrote those too — plus every
// parts & accessories row. Registered before '/:id' (see header).
// ---------------------------------------------------------------------------
router.get('/audit', asyncHandler(async (req, res) => {
  const { rows: [i] } = await query(
    // Shop pieces, plus the ones the shop has sold (they're their buyers'
    // instruments since migration 087, but the audit covered them).
    `SELECT count(*)::int AS total, count(audited_at)::int AS audited
       FROM instruments i
      WHERE i.ownership <> 'customer'
         OR EXISTS (SELECT 1 FROM instrument_ownership s WHERE s.instrument_id = i.id AND s.end_reason = 'sale')`,
  );
  const { rows: [p] } = await query(
    'SELECT count(*)::int AS total, count(audited_at)::int AS audited FROM inventory_parts',
  );
  res.json({ instruments: i, parts: p });
}));

// ---------------------------------------------------------------------------
// Parts & labor (instrument_parts, migration 078). Lines save on their own,
// not through the detail page's Save bar. Picking from Parts & Accessories
// takes from its shelf count here (refusing if there aren't enough);
// giving stock back on delete is a DB trigger — see the migration.
// ---------------------------------------------------------------------------
const LINE_SELECT = `
  SELECT l.*, e.name AS created_by_name,
         ip.name AS stock_name, ip.model AS stock_model, ip.quantity AS stock_quantity
    FROM instrument_parts l
    LEFT JOIN employees e ON e.id = l.created_by
    LEFT JOIN inventory_parts ip ON ip.id = l.inventory_part_id
`;

function lineQuantity(v, fromStock) {
  const n = v === undefined || v === null || v === '' ? 1 : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('Quantity must be more than 0');
  // Shelf counts are whole items; a typed-in line can be "1.5" (feet, etc.).
  if (fromStock && !Number.isInteger(n)) throw badRequest('Parts from stock are counted in whole items');
  return Math.round(n * 100) / 100;
}

/** Take `n` more off a stock row (negative = give back). Returns the amount actually taken. */
async function takeStock(client, partId, n) {
  const { rows: [part] } = await client.query(
    'SELECT id, name, quantity FROM inventory_parts WHERE id = $1 FOR UPDATE', [partId],
  );
  if (!part) throw badRequest('That part is no longer in Parts & Accessories');
  if (part.quantity === null) return 0; // "tons" / "5-10 Available": no count to keep
  if (n > part.quantity) {
    throw conflict(`Only ${part.quantity} "${part.name}" on the shelf — fix the count in Parts & Accessories, or type the part in instead`);
  }
  await client.query('UPDATE inventory_parts SET quantity = quantity - $2 WHERE id = $1', [partId, n]);
  return n;
}

router.get('/reserved-parts', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT l.*, e.name AS created_by_name, ip.name AS stock_name,
            i.nickname, i.model AS instrument_model, i.family, i.sale_status, i.ownership
       FROM instrument_parts l
       JOIN instruments i ON i.id = l.instrument_id
       LEFT JOIN employees e ON e.id = l.created_by
       LEFT JOIN inventory_parts ip ON ip.id = l.inventory_part_id
      WHERE l.reserved
      ORDER BY i.id, l.reserved_at NULLS LAST, l.id`,
  );
  res.json(rows.map((r) => ({ ...r, stock_number: inv.stockNumber({ id: r.instrument_id, family: r.family }) })));
}));

router.get('/:id/parts-used', asyncHandler(async (req, res) => {
  const { rows } = await query(`${LINE_SELECT} WHERE l.instrument_id = $1 ORDER BY l.id`, [req.params.id]);
  res.json(rows);
}));

router.post('/:id/parts-used', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const partId = b.inventory_part_id ? Number(b.inventory_part_id) : null;
  const qty = lineQuantity(b.quantity, !!partId);
  const unitCost = b.unit_cost === undefined ? null : money('unit_cost')(b.unit_cost);
  const reserved = !!b.reserved;

  const line = await withTransaction(async (client) => {
    const { rows: [inst] } = await client.query(
      'SELECT id, ownership FROM instruments WHERE id = $1', [req.params.id],
    );
    if (!inst || inst.ownership === 'customer') throw notFound('Instrument not found');

    let description = text(300)(b.description);
    let taken = 0;
    if (partId) {
      taken = await takeStock(client, partId, qty);
      if (!description) {
        const { rows: [p] } = await client.query('SELECT name, model FROM inventory_parts WHERE id = $1', [partId]);
        description = [p.name, p.model].filter(Boolean).join(' — ');
      }
    }
    if (!description) throw badRequest('Say what the part is');

    const { rows: [row] } = await client.query(
      `INSERT INTO instrument_parts (instrument_id, inventory_part_id, description, quantity, unit_cost,
                                     stock_taken, reserved, reserved_at, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 THEN now() END, $8, $9) RETURNING id`,
      [inst.id, partId, description, qty, unitCost, taken, reserved, text(500)(b.notes), req.user.id],
    );
    return row;
  });
  const { rows } = await query(`${LINE_SELECT} WHERE l.id = $1`, [line.id]);
  res.status(201).json(rows[0]);
}));

router.patch('/parts-used/:lineId', asyncHandler(async (req, res) => {
  const b = req.body || {};
  await withTransaction(async (client) => {
    const { rows: [old] } = await client.query(
      'SELECT * FROM instrument_parts WHERE id = $1 FOR UPDATE', [req.params.lineId],
    );
    if (!old) throw notFound('Part line not found');
    const sets = [];
    const params = [old.id];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (b.description !== undefined) {
      const d = text(300)(b.description);
      if (!d) throw badRequest('Say what the part is');
      set('description', d);
    }
    if (b.quantity !== undefined) {
      const qty = lineQuantity(b.quantity, !!old.inventory_part_id);
      set('quantity', qty);
      // Only a line that actually took stock keeps the shelf in step; one
      // whose stock row had no count (or is gone) never did.
      if (old.inventory_part_id && old.stock_taken > 0) {
        const delta = qty - Number(old.quantity);
        if (delta) {
          const taken = await takeStock(client, old.inventory_part_id, delta);
          set('stock_taken', old.stock_taken + taken);
        }
      }
    }
    if (b.unit_cost !== undefined) set('unit_cost', money('unit_cost')(b.unit_cost));
    if (b.notes !== undefined) set('notes', text(500)(b.notes));
    if (b.reserved !== undefined) {
      const r = !!b.reserved;
      set('reserved', r);
      if (r && !old.reserved) sets.push('reserved_at = now()');
      if (!r) sets.push('reserved_at = NULL');
    }
    if (!sets.length) throw badRequest('Nothing to update');
    await client.query(`UPDATE instrument_parts SET ${sets.join(', ')} WHERE id = $1`, params);
  });
  const { rows } = await query(`${LINE_SELECT} WHERE l.id = $1`, [req.params.lineId]);
  res.json(rows[0]);
}));

router.delete('/parts-used/:lineId', asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM instrument_parts WHERE id = $1', [req.params.lineId]);
  if (!rowCount) throw notFound('Part line not found');
  res.json({ deleted: true });
}));

router.put('/:id/audit', asyncHandler(async (req, res) => {
  const audited = !!(req.body || {}).audited;
  await withTransaction(async (client) => {
    const { rows: [old] } = await client.query(
      'SELECT id, ownership, audited_at FROM instruments WHERE id = $1 FOR UPDATE', [req.params.id],
    );
    if (!old || old.ownership === 'customer') throw notFound('Instrument not found');
    if (!!old.audited_at === audited) return;
    await client.query(
      `UPDATE instruments SET audited_at = CASE WHEN $2 THEN now() END,
                              audited_by = CASE WHEN $2 THEN $3::int END
        WHERE id = $1`,
      [old.id, audited, req.user.id],
    );
    // In the piece's History too, so "who signed this off" survives the
    // mark being cleared and re-done.
    await client.query(
      `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
       VALUES ($1, $2, 'audited', $3, $4)`,
      [old.id, req.user.id, String(!audited), String(audited)],
    );
  });
  const row = await loadInventoryRow(req.params.id);
  res.json(inv.redactForRole(row, req.user));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await detail.loadDetail(req.params.id, req.user));
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
    // Owner changes are written to the ownership history by a trigger
    // (migration 087); say why. A different consignor on the same
    // consignment is fixing who it is, not a new owner.
    const newOwnership = f.ownership ?? old.ownership;
    if (newOwnership !== old.ownership
        || (f.customer_id !== undefined && (f.customer_id ?? null) !== (old.customer_id ?? null))) {
      await ownership.setContext(client, {
        reason: newOwnership === old.ownership ? 'correction' : 'changed', employeeId: req.user.id,
      });
    }
    applyConsignmentRules(f, old);
    await catalog.resolveModel(client, f, old);

    const setCols = Object.keys(f);
    // Nothing left after normalising (e.g. picking the Mark the model
    // already has): no write, same row back.
    if (!setCols.length) return old;
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

// ---------------------------------------------------------------------------
// Sell (migration 087): the piece becomes the buyer's instrument -- with a
// customer record, it's on their page from now on; without one, it's held
// under the buyer's name until someone links the record (from the piece's
// ownership history). The sale itself lives on the closed shop/consignment
// period; undo is POST /instruments/:id/undo-sale.
// ---------------------------------------------------------------------------
router.post('/:id/sell', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const soldOn = (b.sold_at ? dateOrNull('sold_at')(b.sold_at) : null) || new Date().toISOString().slice(0, 10);
  const price = money('sold_price')(b.sold_price ?? null);
  const buyerId = intOrNull('sold_to_customer_id')(b.sold_to_customer_id ?? null);
  let buyerName = text(200)(b.sold_to_name);
  if (buyerId) {
    const { rows } = await query('SELECT name FROM customers WHERE id = $1', [buyerId]);
    if (!rows[0]) throw badRequest("That buyer isn't a customer record");
    buyerName = buyerName || rows[0].name;
  }
  if (!buyerId && !buyerName) throw badRequest('Who bought it? Link their customer record or type a name');

  const id = await withTransaction(async (client) => {
    const { rows: [old] } = await client.query('SELECT * FROM instruments WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!old) throw notFound('Instrument not found');
    if (old.ownership === 'customer') throw badRequest('Only shop stock or a consignment can be sold');
    const salePeriodId = await ownership.recordSale(client, old.id, {
      soldOn, price, buyerId, buyerName, employeeId: req.user.id,
    });
    await client.query(
      `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
       VALUES ($1, $2, 'sold', $3, $4)`,
      [old.id, req.user.id, old.sale_status, buyerName],
    );
    // A consignment's sale opens the ticket to pay its consignor (migration
    // 090). Only here, not in instrument_record_sale() itself: the
    // inventory importer and 087's backfill also record sales through that
    // function, and years-old sales shouldn't each open a ticket.
    if (old.ownership === 'consignment') await payouts.openForSale(client, salePeriodId, req.user.id);
    return old.id;
  });
  res.json(await detail.loadDetail(id, req.user));
}));

// A consignment goes back to its owner unsold. The deal as it stood is kept
// on the closed consignment period.
router.post('/:id/return-to-owner', asyncHandler(async (req, res) => {
  const id = await withTransaction(async (client) => {
    const { rows: [old] } = await client.query('SELECT * FROM instruments WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!old) throw notFound('Instrument not found');
    if (old.ownership !== 'consignment') throw badRequest('Only a consignment can go back to its owner');
    if (!old.customer_id) throw badRequest("Link the consignor's customer record first — that's who it goes back to");
    await ownership.setContext(client, { reason: 'consignment_returned', employeeId: req.user.id });
    await client.query(
      `UPDATE instruments
          SET ownership = 'customer', sale_status = NULL, consignment_status = NULL,
              consignment_rate = NULL, consignment_terms = NULL, consignor_name = NULL,
              on_website = FALSE, hold_for = NULL
        WHERE id = $1`,
      [old.id],
    );
    await client.query(
      `UPDATE instrument_ownership
          SET consignment_rate = $2, consignment_terms = $3, payout_status = $4,
              owner_name = COALESCE(owner_name, $5)
        WHERE id = (SELECT max(id) FROM instrument_ownership
                     WHERE instrument_id = $1 AND end_reason = 'consignment_returned')`,
      [old.id, old.consignment_rate, old.consignment_terms, old.consignment_status, old.consignor_name],
    );
    await client.query(
      `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
       VALUES ($1, $2, 'ownership', 'consignment', 'customer')`,
      [old.id, req.user.id],
    );
    return old.id;
  });
  res.json(await detail.loadDetail(id, req.user));
}));

module.exports = router;
