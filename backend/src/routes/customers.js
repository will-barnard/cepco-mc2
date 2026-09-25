'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const {
  pushCustomerToXero, createCustomerInXero, ADDRESS_FIELDS,
} = require('../services/xeroSync');
const { contactHistory } = require('../services/ticketNotes');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

// Mirrors customers_source_check (migrations 047/060). 'xero' is set by
// the sync itself when it pulls in a Xero-only contact, but is accepted
// here too so editing such a customer doesn't fail on save.
const SOURCES = ['direct', 'email', 'shopify', 'reverb', 'ebay', 'instagram', 'facebook', 'xero'];

function cleanSource(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const source = String(raw).trim().toLowerCase();
  if (!SOURCES.includes(source)) throw badRequest(`source must be one of: ${SOURCES.join(', ')}`);
  return source;
}

/** The structured address columns (migration 060) from a request body,
 * or null when the body doesn't mention any of them -- a caller that only
 * knows the old single `address` field (EstimateNewView's contact step)
 * leaves the structured ones alone, and the DB trigger takes it from
 * there. */
function addressFromBody(b) {
  if (!ADDRESS_FIELDS.some((k) => b[k] !== undefined)) return null;
  return Object.fromEntries(ADDRESS_FIELDS.map((k) => {
    const v = b[k] === undefined || b[k] === null ? '' : String(b[k]).trim();
    return [k, v || null];
  }));
}

router.get('/', asyncHandler(async (req, res) => {
  const params = [];
  let where = '';
  const clauses = [];
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    clauses.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length}
                   OR c.phone ILIKE $${params.length})`);
  }
  // Customers page "Source" filter -- e.g. everyone who came in through
  // Reverb, to know which inbox a past conversation is sitting in.
  if (req.query.source) {
    params.push(cleanSource(req.query.source));
    clauses.push(`c.source = $${params.length}`);
  }
  if (clauses.length) where = `WHERE ${clauses.join(' AND ')}`;
  const { rows } = await query(
    `SELECT c.*,
            (SELECT count(*)::int FROM tickets t WHERE t.customer_id = c.id AND t.archived = FALSE)
              AS open_tickets,
            (SELECT count(*)::int FROM instruments i WHERE i.customer_id = c.id) AS instrument_count
       FROM customers c ${where} ORDER BY c.name LIMIT 500`,
    params,
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Customer not found');
  const [instruments, tickets] = await Promise.all([
    query('SELECT * FROM instruments WHERE customer_id = $1 ORDER BY family, model', [req.params.id]),
    query(`SELECT t.*, s.label AS status_label FROM tickets t
             LEFT JOIN settings s ON s.category='ticket_status' AND s.key=t.status_key
            WHERE t.customer_id = $1 ORDER BY t.updated_at DESC`, [req.params.id]),
  ]);
  res.json({ ...rows[0], instruments: instruments.rows, tickets: tickets.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) throw badRequest('name is required');
  const email = b.email ? String(b.email).trim() : '';

  // Every "add a customer" screen in the app (this wizard's own quick-add
  // form, the Tickets and Estimates new-item wizards' inline "add a new
  // customer instead" checkbox) calls this same endpoint, and none of them
  // know about each other's in-flight state. If a later step in the same
  // wizard submission fails (a bad send, a network blip) after the customer
  // was already created here, retrying re-runs the whole form from scratch
  // and would otherwise insert a second row for the same person. Treat
  // email as the dedup key — it's the one field customers reliably repeat
  // across attempts, and the shop already relies on it being unique enough
  // to use for quote-confirmation lookups elsewhere — and hand back the
  // existing customer instead of creating a duplicate.
  if (email) {
    const { rows: existing } = await query(
      'SELECT * FROM customers WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    );
    if (existing[0]) {
      res.status(200).json(existing[0]);
      return;
    }
  }

  // Structured fields when the caller sent them; otherwise the legacy
  // single `address` string, which the DB trigger files under line 1.
  const address = addressFromBody(b);
  const { rows } = await query(
    `INSERT INTO customers (name, email, phone, address, source, notes,
                            address_line1, address_line2, city, region, postal_code, country)
     VALUES ($1,$2,$3,$4,COALESCE($5,'direct'),$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [String(b.name).trim(), email || null, b.phone ? String(b.phone).trim() : null,
      address ? null : (b.address || null),
      cleanSource(b.source), b.notes || null,
      ...ADDRESS_FIELDS.map((k) => (address ? address[k] : null))],
  );
  let customer = rows[0];

  // Same "reach Xero now, don't wait for the next sync" reasoning as the
  // PATCH handler below, just for the create side instead of the edit
  // side — skipped entirely (no error surfaced) when Xero isn't
  // configured at all, rather than trying and failing on every single
  // customer a shop that's never touched Xero creates.
  let xeroPushError = null;
  if (config.xero.clientId && config.xero.clientSecret) {
    try {
      const xeroContactId = await createCustomerInXero(customer);
      customer = { ...customer, xero_contact_id: xeroContactId, xero_synced_at: new Date().toISOString() };
    } catch (err) {
      xeroPushError = err.message;
    }
  }

  res.status(201).json({ ...customer, xero_push_error: xeroPushError });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  // Unlike the COALESCE'd fields, a structured address is replaced as a
  // whole whenever any part of it is sent -- clearing "Apt 2" has to be
  // possible, and COALESCE can't express "set this back to empty".
  const address = addressFromBody(b);
  const { rows } = await query(
    `UPDATE customers SET
       name = COALESCE($2, name), email = COALESCE($3, email),
       phone = COALESCE($4, phone),
       address = CASE WHEN $8::boolean THEN address ELSE COALESCE($5, address) END,
       source = COALESCE($6, source), notes = COALESCE($7, notes),
       address_line1 = CASE WHEN $8::boolean THEN $9  ELSE address_line1 END,
       address_line2 = CASE WHEN $8::boolean THEN $10 ELSE address_line2 END,
       city          = CASE WHEN $8::boolean THEN $11 ELSE city END,
       region        = CASE WHEN $8::boolean THEN $12 ELSE region END,
       postal_code   = CASE WHEN $8::boolean THEN $13 ELSE postal_code END,
       country       = CASE WHEN $8::boolean THEN $14 ELSE country END
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name || null, b.email || null, b.phone || null,
      b.address || null, cleanSource(b.source), b.notes === undefined ? null : b.notes,
      Boolean(address), ...ADDRESS_FIELDS.map((k) => (address ? address[k] : null))],
  );
  if (!rows[0]) throw notFound('Customer not found');
  let customer = rows[0];

  // A linked customer's edit here should reach Xero right away, not wait
  // for the next "Sync now" or nightly run — but a Xero-side failure
  // (network blip, a field Xero's own validation rejects) shouldn't make
  // this look like the edit itself failed: the MC2 write above already
  // succeeded and stays that way. Surface the failure to the caller
  // instead so the edit form can show it as a warning alongside the
  // otherwise-successful save.
  let xeroPushError = null;
  if (customer.xero_contact_id) {
    try {
      await pushCustomerToXero(customer);
      customer = { ...customer, xero_synced_at: new Date().toISOString() };
    } catch (err) {
      xeroPushError = err.message;
    }
  }

  res.json({ ...customer, xero_push_error: xeroPushError });
}));

// Xero's own History & Notes for this customer's linked contact -- read
// live, never stored here (see services/ticketNotes.js's contactHistory).
// 200 with `linked: false` rather than a 404 for an unlinked customer, so
// the ticket page can simply not show the section.
router.get('/:id/xero-history', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id, xero_contact_id FROM customers WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Customer not found');
  if (!rows[0].xero_contact_id || !config.xero.clientId) {
    res.json({ linked: false, records: [] });
    return;
  }
  try {
    res.json({ linked: true, records: await contactHistory(rows[0].xero_contact_id) });
  } catch (err) {
    // Xero being unreachable shouldn't break the page this is embedded in.
    res.json({ linked: true, records: [], error: err.message });
  }
}));

module.exports = router;
