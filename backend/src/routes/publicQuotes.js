'use strict';

/**
 * Public, unauthenticated endpoints for the customer-facing side of a
 * quote — the page a "Review & respond to this estimate" email link opens
 * (frontend `/quote/:token`, router.js's `alwaysPublic` route). No
 * `requireAuth`: a customer has no MC2 account. Looked up by
 * `confirm_token` (a random 24-byte hex value, migration 011), never by
 * numeric id, so a link can't be guessed or enumerated the way sequential
 * estimate ids could be.
 *
 * Both actions are POSTs the page's own buttons trigger — never something
 * that fires from the GET that loads the page — because a GET link that
 * changes state is unsafe in email (mail security scanners and some
 * clients prefetch every link in a message body, which would silently
 * "confirm" or "decline" an estimate nobody actually looked at).
 */

const express = require('express');
const { query } = require('../db');
const { asyncHandler, notFound, badRequest } = require('../middleware/errors');
const { createTicketsForEstimate } = require('./quotes');

const router = express.Router();

async function findByToken(token) {
  const { rows } = await query(
    `SELECT e.*, c.name AS customer_name
       FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
      WHERE e.confirm_token = $1 AND e.kind = 'customer_quote'`,
    [token],
  );
  if (!rows[0]) throw notFound('This estimate link is invalid or has expired.');
  return rows[0];
}

router.get('/:token', asyncHandler(async (req, res) => {
  const estimate = await findByToken(req.params.token);
  const { rows: items } = await query(
    'SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order, id',
    [estimate.id],
  );

  // Customer-safe subset only — no internal ids, notes, or created_by.
  // parts_cost/parts_variant_label_snapshot are real, included-in-the-
  // price numbers (migration 043) so they belong here; outlier_hours
  // (same migration) is deliberately left out — it's an internal
  // planning reference (routes/quotes.js's outlierBufferFor), never
  // something a customer's own total should reflect or a customer should
  // see at all.
  res.json({
    title: estimate.title,
    customer_name: estimate.customer_name,
    status: estimate.status,
    labor_rate: estimate.labor_rate,
    items: items.map((i) => ({
      procedure_name: i.procedure_name,
      instrument_family: i.instrument_family,
      instrument_model: i.instrument_model,
      pricing_type: i.pricing_type,
      min_hours: i.min_hours,
      max_hours: i.max_hours,
      flat_cost: i.flat_cost,
      parts_cost: i.parts_cost,
      parts_variant_label_snapshot: i.parts_variant_label_snapshot,
    })),
  });
}));

router.post('/:token/confirm', asyncHandler(async (req, res) => {
  const estimate = await findByToken(req.params.token);

  await query(
    "UPDATE estimates SET confirmed_at = now(), status = CASE WHEN status != 'ticket_created' THEN 'confirmed' ELSE status END WHERE id = $1",
    [estimate.id],
  );

  // No employee behind this — createTicketsForEstimate treats a null
  // createdById the same way any other nullable created_by column does.
  const result = await createTicketsForEstimate(estimate, null);
  res.json({ status: result.estimate.status });
}));

router.post('/:token/decline', asyncHandler(async (req, res) => {
  const estimate = await findByToken(req.params.token);
  if (estimate.status === 'ticket_created') {
    throw badRequest('This estimate already has work scheduled and can\'t be declined.');
  }
  const { rows } = await query(
    "UPDATE estimates SET declined_at = now(), status = 'declined' WHERE id = $1 RETURNING status",
    [estimate.id],
  );
  res.json({ status: rows[0].status });
}));

module.exports = router;
