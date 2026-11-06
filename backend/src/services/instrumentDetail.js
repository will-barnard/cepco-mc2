'use strict';

/**
 * One instrument, everything about it -- the instrument page (InstrumentDetailView)
 * reads this for every instrument, customer-owned or shop stock
 * (GET /api/instruments/:id, and GET /api/inventory/:id for old links).
 * Moved out of routes/inventory.js when customer instruments got the same
 * page (NOTES.md §2.107); the inventory list's row shape (LIST_SELECT)
 * came with it so the list and the page can't drift apart.
 */

const { query } = require('../db');
const { notFound } = require('../middleware/errors');
const inv = require('./inventory');
const catalog = require('./instrumentCatalog');
const ownership = require('./ownership');

const LIST_SELECT = `
  SELECT i.*, c.name AS customer_name, c.xero_contact_id AS customer_xero_contact_id,
         (SELECT e.name FROM employees e WHERE e.id = i.audited_by) AS audited_by_name,
         (SELECT count(*)::int FROM tickets t WHERE t.instrument_id = i.id AND t.archived = FALSE)
           AS open_tickets,
         (SELECT count(*)::int FROM instrument_photos p WHERE p.instrument_id = i.id)
           AS photo_count,
         ${catalog.FACTS_COLUMNS}
    FROM instruments i
    LEFT JOIN customers c ON c.id = i.customer_id
    ${catalog.FACTS_JOIN}
`;

/** The list-shaped row (facts, counts, customer) for any instrument. */
async function loadRow(id, db = { query }) {
  const { rows } = await db.query(`${LIST_SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw notFound('Instrument not found');
  return rows[0];
}

/**
 * The page payload: the row (cost stripped for non-admins), tickets,
 * rentals, purchases (admins), photo sets, ticket photos, change log,
 * ownership history and the owner's contact basics.
 */
async function loadDetail(id0, user, db = { query }) {
  const isAdmin = user?.role === 'admin';
  const row = await loadRow(id0);
  const id = row.id;

  const [tickets, rentals, purchases, sets, photos, ticketPhotos, events, soldTo, logged] = await Promise.all([
    db.query(
      `SELECT t.id, t.title, t.status_key, t.archived, t.updated_at, t.category_key,
              s.label AS status_label
         FROM tickets t
         LEFT JOIN settings s ON s.category = 'ticket_status' AND s.key = t.status_key
        WHERE t.instrument_id = $1 ORDER BY t.archived, t.updated_at DESC`,
      [id],
    ),
    db.query('SELECT * FROM instrument_rentals WHERE instrument_id = $1 ORDER BY start_date DESC', [id]),
    // What the shop paid the seller is cost information — admins only.
    isAdmin
      ? db.query('SELECT * FROM instrument_purchases WHERE instrument_id = $1 ORDER BY purchase_date DESC', [id])
      : Promise.resolve({ rows: [] }),
    db.query(
      `SELECT s.*, e.name AS created_by_name, t.title AS ticket_title
         FROM instrument_photo_sets s
         LEFT JOIN employees e ON e.id = s.created_by
         LEFT JOIN tickets t ON t.id = s.ticket_id
        WHERE s.instrument_id = $1 ORDER BY s.taken_on DESC, s.id DESC`,
      [id],
    ),
    db.query(
      `SELECT p.*, e.name AS uploader_name FROM instrument_photos p
         LEFT JOIN employees e ON e.id = p.uploader_id
        WHERE p.instrument_id = $1 ORDER BY p.sort_order, p.uploaded_at, p.id`,
      [id],
    ),
    // Read-only: photos taken on this piece's tickets, so the history is in
    // one place without copying files around. Images only -- a PDF quote on
    // a ticket isn't a photo of the instrument (and can't be a thumbnail).
    db.query(
      `SELECT a.id, a.ticket_id, a.caption, a.file_name, a.content_type, a.uploaded_at, t.title AS ticket_title
         FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id
        WHERE t.instrument_id = $1
          AND (a.content_type ILIKE 'image/%'
               OR (a.content_type IS NULL AND a.file_name ~* '\\.(jpe?g|png|gif|webp|heic|heif)$'))
        ORDER BY a.uploaded_at DESC`,
      [id],
    ),
    db.query(
      `SELECT ev.*, e.name AS employee_name FROM instrument_events ev
         LEFT JOIN employees e ON e.id = ev.employee_id
        WHERE ev.instrument_id = $1 ORDER BY ev.created_at DESC, ev.id DESC LIMIT 100`,
      [id],
    ),
    row.sold_to_customer_id
      ? db.query('SELECT id, name, email FROM customers WHERE id = $1', [row.sold_to_customer_id])
      : Promise.resolve({ rows: [] }),
    // Shown beside the hand-entered est_hours for reference (migration 078).
    db.query(
      `SELECT COALESCE(sum(h.hours), 0)::float AS hours
         FROM hours_log h JOIN tickets t ON t.id = h.ticket_id WHERE t.instrument_id = $1`,
      [id],
    ),
  ]);

  const photosBySet = {};
  for (const p of photos.rows) (photosBySet[p.set_id] ||= []).push(p);

  const [history, owner] = await Promise.all([
    ownership.historyFor(db, id, user),
    row.customer_id
      ? db.query('SELECT id, name, email, phone FROM customers WHERE id = $1', [row.customer_id])
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    ...inv.redactForRole(row, user),
    sold_to_customer: soldTo.rows[0] || null,
    tickets: tickets.rows,
    rentals: rentals.rows,
    purchases: purchases.rows,
    photo_sets: sets.rows.map((s) => ({ ...s, photos: photosBySet[s.id] || [] })),
    ticket_photos: ticketPhotos.rows,
    logged_hours: logged.rows[0].hours,
    ownership_history: history,
    owner: owner.rows[0] || null,
    events: events.rows.filter((e) => isAdmin || e.field !== 'cost_paid'),
  };
}

module.exports = { LIST_SELECT, loadRow, loadDetail };
