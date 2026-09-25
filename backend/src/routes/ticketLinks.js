'use strict';

/**
 * Ticket links — named URLs attached to a ticket (migration 059).
 *
 *   POST   /api/ticket-links        { ticket_id, name, url }
 *   PATCH  /api/ticket-links/:id    { name?, url? }
 *   DELETE /api/ticket-links/:id
 *
 * There's no GET: GET /api/tickets/:id already returns them as `links`
 * (same way it returns `attachments`), so the detail page never needs a
 * second round trip.
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');

const router = express.Router();
router.use(requireAuth);

const MAX_NAME = 200;
const MAX_URL = 2000;

function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw badRequest('Link name is required');
  if (name.length > MAX_NAME) throw badRequest(`Link name must be ${MAX_NAME} characters or fewer`);
  return name;
}

/**
 * Trims, defaults a bare "example.com/foo" to https://, and only accepts
 * http(s) — these get rendered as <a href>, so anything else (notably
 * `javascript:`) is rejected rather than stored.
 */
function cleanUrl(raw) {
  let value = String(raw ?? '').trim();
  if (!value) throw badRequest('URL is required');
  if (value.length > MAX_URL) throw badRequest(`URL must be ${MAX_URL} characters or fewer`);
  // A scheme-looking prefix ("javascript:", "ftp://", "mailto:") that isn't
  // http(s) is an error; anything without one is assumed to be a bare host.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    // "localhost:3000/x" and "nas.local:8080" look like schemes to that
    // regex but are host:port — let those through as bare hosts.
    if (!/^[^/?#\s]+:\d+([/?#]|$)/.test(value)) throw badRequest('URL must start with http:// or https://');
  }
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest('That doesn\'t look like a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw badRequest('URL must start with http:// or https://');
  }
  return value;
}

router.post('/', asyncHandler(async (req, res) => {
  const { ticket_id: ticketId } = req.body || {};
  if (!ticketId) throw badRequest('ticket_id is required');
  const name = cleanName(req.body.name);
  const url = cleanUrl(req.body.url);

  const { rowCount } = await query('SELECT 1 FROM tickets WHERE id = $1', [ticketId]);
  if (!rowCount) throw notFound('Ticket not found');

  const { rows } = await query(
    `INSERT INTO ticket_links (ticket_id, name, url, position, created_by)
     VALUES ($1, $2, $3,
             COALESCE((SELECT MAX(position) FROM ticket_links WHERE ticket_id = $1), 0) + 10,
             $4)
     RETURNING *`,
    [ticketId, name, url, req.user?.id || null],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const params = [];
  if (body.name !== undefined) { params.push(cleanName(body.name)); sets.push(`name = $${params.length}`); }
  if (body.url !== undefined) { params.push(cleanUrl(body.url)); sets.push(`url = $${params.length}`); }
  if (!sets.length) throw badRequest('Nothing to update');

  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE ticket_links SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length} RETURNING *`,
    params,
  );
  if (!rows[0]) throw notFound('Link not found');
  res.json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM ticket_links WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Link not found');
  res.json({ deleted: true });
}));

module.exports = router;
