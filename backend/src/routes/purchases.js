'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const { sendEmail } = require('../mailer');
const { buildPurchaseReceiptEmail } = require('../templates/purchaseReceipt');
const { FAMILIES } = require('./instruments');
const settings = require('../services/settings');
const { resolveNewTicketFields, insertTicketRow } = require('./tickets');

const router = express.Router();
router.use(requireAuth);

// Matches TicketNewView's default priority for a fresh ticket — the intake
// form doesn't expose a priority picker (not part of what was asked for),
// so every inventory purchase lands here and gets triaged from the queue.
// Preferred, not guaranteed — Settings can retire it (N4a), so it goes
// through settings.defaultKeyPreferring() below rather than straight to
// resolveActive(). Same for the category key just below.
const PREFERRED_PRIORITY_KEY = 'standard_priority'; // N4b replaced the old tiers
const PREFERRED_CATEGORY_KEY = 'inventory_restoration';

function validPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Create — instrument + inventory_restoration ticket + purchase record, all
// in one transaction. insertTicketRow (from routes/tickets.js) is called
// directly on this transaction's client rather than through POST /tickets,
// so a failure partway through can't leave an orphaned instrument or ticket
// with no purchase behind it.
// ---------------------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const instrument = b.instrument || {};
  const seller = b.seller || {};

  if (!instrument.family || !FAMILIES.includes(instrument.family)) {
    throw badRequest(`instrument.family must be one of: ${FAMILIES.join(', ')}`);
  }
  if (!seller.name || !String(seller.name).trim()) throw badRequest('seller.name is required');
  if (!seller.email || !String(seller.email).trim()) throw badRequest('seller.email is required');
  const price = validPrice(b.price);
  if (price === null) throw badRequest('price must be a non-negative number');
  if (!b.purchase_date) throw badRequest('purchase_date is required');

  const resolved = await resolveNewTicketFields({
    category_key: await settings.defaultKeyPreferring('ticket_category', PREFERRED_CATEGORY_KEY),
    priority_key: b.priority_key || await settings.defaultKeyPreferring('priority_tier', PREFERRED_PRIORITY_KEY),
  });

  const result = await withTransaction(async (client) => {
    const { rows: instRows } = await client.query(
      `INSERT INTO instruments (family, model, year, serial_no, identifying_notes, is_fleet)
       VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *`,
      [
        instrument.family,
        instrument.model || null,
        instrument.year || null,
        instrument.serial_no || null,
        instrument.identifying_notes || null,
      ],
    );
    const instrumentRow = instRows[0];

    const title = `Inventory — ${instrumentRow.family}${instrumentRow.model ? ` ${instrumentRow.model}` : ''}`;
    const ticket = await insertTicketRow(
      client,
      { title, notes: b.notes || null, instrument_id: instrumentRow.id },
      resolved,
      req.user.id,
    );

    const { rows: purchaseRows } = await client.query(
      `INSERT INTO instrument_purchases
         (instrument_id, ticket_id, seller_name, seller_email, seller_phone,
          seller_address, price, purchase_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        instrumentRow.id, ticket.id,
        String(seller.name).trim(), String(seller.email).trim(),
        seller.phone || null, seller.address || null,
        price, b.purchase_date, b.notes || null, req.user.id,
      ],
    );

    return { instrument: instrumentRow, ticket, purchase: purchaseRows[0] };
  });

  res.status(201).json(result);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  let price;
  if (b.price !== undefined) {
    price = validPrice(b.price);
    if (price === null) throw badRequest('price must be a non-negative number');
  }

  const { rows } = await query(
    `UPDATE instrument_purchases SET
        seller_name    = COALESCE($2, seller_name),
        seller_email   = COALESCE($3, seller_email),
        seller_phone   = CASE WHEN $4::boolean THEN $5 ELSE seller_phone END,
        seller_address = CASE WHEN $6::boolean THEN $7 ELSE seller_address END,
        price          = COALESCE($8, price),
        purchase_date  = COALESCE($9, purchase_date),
        notes          = CASE WHEN $10::boolean THEN $11 ELSE notes END
      WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      b.seller_name === undefined ? null : String(b.seller_name).trim(),
      b.seller_email === undefined ? null : String(b.seller_email).trim(),
      b.seller_phone !== undefined, b.seller_phone || null,
      b.seller_address !== undefined, b.seller_address || null,
      price === undefined ? null : price,
      b.purchase_date || null,
      b.notes !== undefined, b.notes || null,
    ],
  );
  if (!rows[0]) throw notFound('Purchase not found');
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Send (or resend) the branded purchase-receipt email. Logged to `emails`
// either way — a failed attempt (most likely: Resend isn't configured yet)
// still leaves a record, with the error, rather than vanishing silently.
// ---------------------------------------------------------------------------
router.post('/:id/send-receipt', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, i.family AS instrument_family, i.model AS instrument_model,
            i.year AS instrument_year, i.serial_no AS instrument_serial_no
       FROM instrument_purchases p
       JOIN instruments i ON i.id = p.instrument_id
      WHERE p.id = $1`,
    [req.params.id],
  );
  const purchase = rows[0];
  if (!purchase) throw notFound('Purchase not found');
  if (!purchase.seller_email) {
    throw badRequest('This purchase has no seller email on file — add one first');
  }

  const { subject, html, attachments } = buildPurchaseReceiptEmail(purchase);

  try {
    await sendEmail({
      to: purchase.seller_email, subject, html, attachments,
    });
    await query(
      `INSERT INTO emails (recipient, template, subject, ticket_id, status, sent_at)
       VALUES ($1, 'purchase_receipt', $2, $3, 'sent', now())`,
      [purchase.seller_email, subject, purchase.ticket_id],
    );
    const { rows: updated } = await query(
      'UPDATE instrument_purchases SET receipt_sent_at = now() WHERE id = $1 RETURNING *',
      [purchase.id],
    );
    res.json(updated[0]);
  } catch (err) {
    await query(
      `INSERT INTO emails (recipient, template, subject, ticket_id, status, error)
       VALUES ($1, 'purchase_receipt', $2, $3, 'failed', $4)`,
      [purchase.seller_email, subject, purchase.ticket_id, err.message],
    );
    throw badRequest(`Could not send receipt: ${err.message}`);
  }
}));

module.exports = router;
