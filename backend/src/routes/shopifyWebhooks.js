'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncHandler } = require('../middleware/errors');
const settings = require('../services/settings');
const { verifyWebhookHmac } = require('../shopify');
const { resolveNewTicketFields, insertTicketRow } = require('./tickets');

const router = express.Router();

// No requireAuth here — Shopify calls this endpoint directly with no
// session cookie. HMAC verification is the actual gate: it proves the
// request was signed with our webhook secret, which only Shopify and we
// know (see backend/src/shopify.js). index.js captures req.rawBody
// globally so this can check the exact bytes Shopify signed.
router.use((req, res, next) => {
  const ok = verifyWebhookHmac(req.rawBody, req.get('X-Shopify-Hmac-Sha256'));
  if (!ok) return res.status(401).json({ error: 'invalid webhook signature' });
  next();
});

// A freshly-arrived order has no priority picker of its own (mirrors
// routes/purchases.js's PREFERRED_PRIORITY_KEY for the same reason) — Daily
// To-Do matches PLAN's description of routine Orders & Shipping work;
// anything that turns out to need more time gets re-triaged from the queue
// like any other ticket. Preferred, not guaranteed (N4a) — Settings can
// retire it, so it's resolved through settings.defaultKeyPreferring() below.
const PREFERRED_ORDER_PRIORITY_KEY = 'daily_todo';
// Belt-and-suspenders alongside the shop_config-driven category below: if
// that setting is ever unset, deleted, or points at a retired category,
// orders still land somewhere sane instead of failing the webhook outright.
// Also just a preference now, not a guarantee — resolveOrderCategoryKey()
// falls all the way through to settings.firstActive() if even this is
// retired, rather than handing a possibly-retired key to resolveActive().
const FALLBACK_CATEGORY_KEY = 'orders_shipping';

function customerNameFromOrder(order) {
  const c = order.customer || {};
  const fromParts = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  if (fromParts) return fromParts;
  const addr = order.shipping_address || order.billing_address || {};
  const fromAddr = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim();
  if (fromAddr) return fromAddr;
  return order.email || `Shopify order ${order.name || order.id}`;
}

function addressFromOrder(order) {
  const a = order.shipping_address || order.billing_address;
  if (!a) return null;
  return [
    a.address1,
    a.address2,
    [a.city, a.province, a.zip].filter(Boolean).join(', '),
    a.country,
  ].filter(Boolean).join('\n') || null;
}

// Match an existing customer by email first (the reliable key Shopify
// always sends on an order), falling back to creating one tagged
// source='shopify' so the Customers list can tell shop-direct customers
// apart from storefront ones.
async function findOrCreateCustomer(client, order) {
  const email = String(order.email || (order.customer && order.customer.email) || '')
    .trim().toLowerCase();
  if (email) {
    const { rows } = await client.query(
      'SELECT * FROM customers WHERE lower(email) = $1 LIMIT 1',
      [email],
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await client.query(
    `INSERT INTO customers (name, email, phone, address, source)
     VALUES ($1,$2,$3,$4,'shopify') RETURNING *`,
    [
      customerNameFromOrder(order),
      email || null,
      order.phone || (order.customer && order.customer.phone) || null,
      addressFromOrder(order),
    ],
  );
  return rows[0];
}

function lineItemsSummary(order) {
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  if (!items.length) return '';
  return items
    .map((li) => `- ${li.quantity}x ${li.title}${li.variant_title ? ` (${li.variant_title})` : ''}`)
    .join('\n');
}

function orderNotes(order) {
  const parts = [];
  const items = lineItemsSummary(order);
  if (items) parts.push(`Order items:\n${items}`);
  if (order.total_price) parts.push(`Total: ${order.total_price} ${order.currency || ''}`.trim());
  if (order.note) parts.push(`Customer note: ${order.note}`);
  return parts.join('\n\n') || null;
}

// Reads the admin-configured default category (Settings -> Shop
// configuration -> "Default category for Shopify orders"); falls back to
// orders_shipping if it's missing or retired, and all the way to whatever's
// first active in sort order if even that's been retired since (N4a).
async function resolveOrderCategoryKey() {
  const configured = await settings.shopConfigString('shopify_default_category', null);
  return settings.defaultKeyPreferring('ticket_category', configured, FALLBACK_CATEGORY_KEY);
}

async function handleOrderCreate(order) {
  if (!order || !order.id) return;
  const shopifyOrderId = String(order.id);

  // Fast path: skip the whole transaction on a redelivery we've already
  // processed. The unique index (migration 006) is the real guarantee —
  // this just avoids doing the work twice in the common case.
  const { rows: existing } = await query(
    'SELECT id FROM tickets WHERE shopify_order_id = $1',
    [shopifyOrderId],
  );
  if (existing[0]) return;

  const categoryKey = await resolveOrderCategoryKey();
  // Assignment (Settings -> that category's "Default assignee") is resolved
  // inside resolveNewTicketFields itself, same as every other ticket-
  // creation path — see routes/tickets.js.
  const resolved = await resolveNewTicketFields({
    category_key: categoryKey,
    priority_key: await settings.defaultKeyPreferring('priority_tier', PREFERRED_ORDER_PRIORITY_KEY),
  });

  try {
    await withTransaction(async (client) => {
      const customer = await findOrCreateCustomer(client, order);
      const title = `Shopify order ${order.name || `#${shopifyOrderId}`} — ${customer.name}`;
      await insertTicketRow(
        client,
        {
          title,
          notes: orderNotes(order),
          customer_id: customer.id,
          shopify_order_id: shopifyOrderId,
        },
        resolved,
        // createdById is null: no staff member created this ticket.
        null,
      );
    });
  } catch (err) {
    // 23505 = unique_violation on tickets_shopify_order_id_idx: another
    // delivery of the same webhook won the race between the check above and
    // this insert. Not an error — the ticket exists, which is the whole
    // point of the idempotency guarantee.
    if (err.code === '23505') return;
    throw err;
  }
}

async function handleOrderCancelled(order) {
  if (!order || !order.id) return;
  const shopifyOrderId = String(order.id);
  const { rows } = await query(
    'SELECT id, notes, archived FROM tickets WHERE shopify_order_id = $1',
    [shopifyOrderId],
  );
  const ticket = rows[0];
  if (!ticket || ticket.archived) return;

  const note = 'Order cancelled in Shopify.';
  const newNotes = ticket.notes ? `${ticket.notes}\n\n${note}` : note;
  await query(
    'UPDATE tickets SET notes = $1, archived = TRUE, updated_at = now() WHERE id = $2',
    [newNotes, ticket.id],
  );
}

router.post('/webhooks', asyncHandler(async (req, res) => {
  const topic = req.get('X-Shopify-Topic') || '';
  const order = req.body;

  if (topic === 'orders/create') {
    await handleOrderCreate(order);
  } else if (topic === 'orders/cancelled') {
    await handleOrderCancelled(order);
  }
  // Any other subscribed topic (e.g. orders/updated, if ever registered) is
  // acknowledged but intentionally not acted on — see NOTES.md.

  res.status(200).json({ ok: true });
}));

module.exports = router;
