'use strict';

/**
 * Settings -> Shopify orders (NOTES §2.111): intake switches, tag rules, and
 * the order log with per-order "Re-run". Admin-only. Mounted at
 * /api/shopify-orders — deliberately not under /api/shopify, whose router
 * HMAC-checks every request as a Shopify webhook.
 */

const express = require('express');
const { query } = require('../db');
const config = require('../config');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../middleware/errors');
const settings = require('../services/settings');
const shopify = require('../shopify');
const shopifyOrders = require('../services/shopifyOrders');

const router = express.Router();
router.use(requireAuth, requireAdmin);

function connectionStatus() {
  return {
    webhook_secret: Boolean(config.shopify.webhookSecret),
    admin_api: shopify.adminApiMode(), // 'client_credentials' | 'static_token' | null
    shop_domain: config.shopify.shopDomain || null,
    xero: Boolean(config.xero.clientId && config.xero.clientSecret),
  };
}

router.get('/settings', asyncHandler(async (req, res) => {
  const [intake, rules] = await Promise.all([shopifyOrders.intakeSettings(), shopifyOrders.loadRules()]);
  res.json({ intake, rules, connection: connectionStatus() });
}));

router.patch('/settings', asyncHandler(async (req, res) => {
  res.json({ intake: await shopifyOrders.updateIntakeSettings(req.body || {}) });
}));

// "Test connection": proves the Admin API credentials work (the part the
// tag lookup depends on) without waiting for a real order.
router.post('/test-connection', asyncHandler(async (req, res) => {
  try {
    const shop = await shopify.shopInfo();
    res.json({ ok: true, shop });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

// --- tag rules --------------------------------------------------------------

async function validateRule(b) {
  const tag = String(b.tag || '').trim();
  if (!tag) throw badRequest('tag is required');
  if (!['no_ticket', 'ticket', 'restoration'].includes(b.action)) {
    throw badRequest("action must be 'no_ticket', 'ticket' or 'restoration'");
  }
  let categoryKey = null;
  let subcategoryKey = null;
  if (b.action === 'ticket') {
    if (!b.category_key) throw badRequest('Pick a ticket category for this rule');
    const category = await settings.resolveActive('ticket_category', b.category_key);
    if (category.meta && category.meta.parent_key) throw badRequest('Pick a top-level category, then a sub-category');
    categoryKey = category.key;
    if (b.subcategory_key) {
      const sub = await settings.resolveActive('ticket_category', b.subcategory_key);
      if (!sub.meta || sub.meta.parent_key !== categoryKey) {
        throw badRequest(`'${sub.label}' is not a sub-category of '${category.label}'`);
      }
      subcategoryKey = sub.key;
    }
  }
  return {
    tag, action: b.action, categoryKey, subcategoryKey,
  };
}

function duplicateTag(err) {
  return err.code === '23505' ? badRequest('There is already a rule for that tag') : err;
}

router.post('/rules', asyncHandler(async (req, res) => {
  const r = await validateRule(req.body || {});
  try {
    const { rows } = await query(
      `INSERT INTO shopify_tag_rules (tag, action, category_key, subcategory_key, sort_order)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 10 FROM shopify_tag_rules), 10))
       RETURNING *`,
      [r.tag, r.action, r.categoryKey, r.subcategoryKey],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    throw duplicateTag(err);
  }
}));

router.patch('/rules/:id', asyncHandler(async (req, res) => {
  const { rows: existing } = await query('SELECT * FROM shopify_tag_rules WHERE id = $1', [req.params.id]);
  if (!existing[0]) throw notFound('Rule not found');
  const merged = { ...existing[0], ...(req.body || {}) };
  const r = await validateRule(merged);
  const sortOrder = Number.isFinite(Number(merged.sort_order)) ? Number(merged.sort_order) : existing[0].sort_order;
  try {
    const { rows } = await query(
      `UPDATE shopify_tag_rules
          SET tag = $2, action = $3, category_key = $4, subcategory_key = $5, sort_order = $6, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.params.id, r.tag, r.action, r.categoryKey, r.subcategoryKey, sortOrder],
    );
    res.json(rows[0]);
  } catch (err) {
    throw duplicateTag(err);
  }
}));

router.delete('/rules/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM shopify_tag_rules WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Rule not found');
  res.status(204).end();
}));

// --- order log ----------------------------------------------------------------

router.get('/orders', asyncHandler(async (req, res) => {
  res.json(await shopifyOrders.listOrders({
    limit: req.query.limit,
    onlyProblems: req.query.problems === '1',
  }));
}));

router.post('/orders/:id/reprocess', asyncHandler(async (req, res) => {
  const ran = await shopifyOrders.reprocessOrder(Number(req.params.id));
  if (ran === null) {
    // Either no such order, or another run holds it right now.
    const current = await shopifyOrders.getOrder(Number(req.params.id));
    if (!current) throw notFound('Order not found');
    return res.json(current);
  }
  res.json(await shopifyOrders.getOrder(ran.id));
}));

module.exports = router;
