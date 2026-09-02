'use strict';

/**
 * Xero customer sync — a single admin-only manual-trigger endpoint over
 * services/xeroSync.js. The schedule itself isn't a bespoke endpoint any
 * more than Ceppys' is: it's an ordinary shop_config settings row (key
 * 'xero_sync'), edited through the same generic PATCH /settings/:id
 * SettingsView.vue/CeppysView.vue already use — see routes/ceppys.js's
 * header for the identical reasoning. useSettings already loads it as
 * part of the normal settings fetch, so the Customers page's config panel
 * just finds that one row and patches it directly.
 */

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../middleware/errors');
const { runXeroSync } = require('../services/xeroSync');

const router = express.Router();
router.use(requireAuth);

// Runs the exact same sync the nightly schedule uses (services/
// xeroScheduler.js) — never a behavioral difference between "it fired on
// its own" and "an admin fired it," same as Ceppys' send-now.
router.post('/sync', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const result = await runXeroSync();
    res.json(result);
  } catch (err) {
    throw badRequest(err.message);
  }
}));

module.exports = router;
