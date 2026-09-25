'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncHandler } = require('../middleware/errors');
const settings = require('../services/settings');
const { verifyWebhookHmac } = require('../shopify');
const {
  resolveNewTicketFields, insertTicketRow, renderNamingTemplate, namingFor,
  activeSubcategoryKey, SHOPIFY_SUBCATEGORY_KEY,
} = require('./tickets');
const { insertNote } = require('../services/ticketNotes');

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
// routes/purchases.js's PREFERRED_PRIORITY_KEY for the same reason) — the
// old 'daily_todo' tier matched PLAN's description of routine Orders &
// Shipping work; N4b retired it along with the rest of the old tiers, and
// 'low_priority' (routine, no rush) is its closest successor among the
// three new urgency-based ones. Anything that turns out to need more time
// gets re-triaged from the queue like any other ticket. Preferred, not
// guaranteed (N4a) — Settings can retire it, so it's resolved through
// settings.defaultKeyPreferring() below.
const PREFERRED_ORDER_PRIORITY_KEY = 'low_priority';
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

// Shopify's order address is already structured, so it maps straight onto
// customers' address columns (migration 060) -- and from there onto the
// Xero contact's billing address when the customer gets pushed.
function addressFromOrder(order) {
  const a = order.shipping_address || order.billing_address || {};
  return [
    a.address1 || null,
    a.address2 || null,
    a.city || null,
    a.province_code || a.province || null,
    a.zip || null,
    a.country_code || a.country || null,
  ];
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
    `INSERT INTO customers (name, email, phone, source, address_line1, address_line2, city,
                            region, postal_code, country)
     VALUES ($1,$2,$3,'shopify',$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      customerNameFromOrder(order),
      email || null,
      order.phone || (order.customer && order.customer.phone) || null,
      ...addressFromOrder(order),
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
  // Filed under Orders & Shipping -> Shopify when that sub-category exists
  // (migration 062), which is also what names it: "Shopify: #1001 - Joe".
  const resolved = await resolveNewTicketFields({
    category_key: categoryKey,
    subcategory_key: await activeSubcategoryKey(categoryKey, SHOPIFY_SUBCATEGORY_KEY),
    priority_key: await settings.defaultKeyPreferring('priority_tier', PREFERRED_ORDER_PRIORITY_KEY),
  });
  const naming = namingFor(resolved.category, resolved.subcategory);

  try {
    await withTransaction(async (client) => {
      const customer = await findOrCreateCustomer(client, order);
      const orderNumber = order.name || `#${shopifyOrderId}`;
      // Rendered directly rather than via composeTicketTitle: that reads
      // the customer through the pool, and a customer created a line above
      // in this still-open transaction isn't visible there yet.
      const title = (naming.template && renderNamingTemplate(naming.template, {
        customerName: customer.name, ticketName: orderNumber, categoryLabel: resolved.category.label,
      })) || `Shopify order ${orderNumber} — ${customer.name}`;
      await insertTicketRow(
        client,
        {
          title,
          ticket_name: orderNumber,
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
    'SELECT id, archived FROM tickets WHERE shopify_order_id = $1',
    [shopifyOrderId],
  );
  const ticket = rows[0];
  if (!ticket || ticket.archived) return;

  // A published note (migration 061) rather than appending to the old
  // tickets.notes text. No author, so it isn't posted to Xero.
  await withTransaction(async (client) => {
    await insertNote(client, { ticketId: ticket.id, body: 'Order cancelled in Shopify.', createdBy: null });
    await client.query('UPDATE tickets SET archived = TRUE, updated_at = now() WHERE id = $1', [ticket.id]);
  });
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
