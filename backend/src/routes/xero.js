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
const { runXeroSync, fillMissingFieldsFromXero } = require('../services/xeroSync');
const {
  computeBackfillCandidates, linkCustomerToXero, dismissMatch,
} = require('../services/xeroBackfill');
const {
  computeDuplicateCandidates, mergeDuplicate, dismissDuplicate,
} = require('../services/xeroDuplicates');

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

// One-time catch-up for customers linked before listContacts() was fixed
// to request full contact detail — see xeroSync.js's fillMissingFieldsFromXero
// header for why the regular sync can't catch this up on its own.
router.post('/fill-missing-fields', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const result = await fillMissingFieldsFromXero();
    res.json(result);
  } catch (err) {
    throw badRequest(err.message);
  }
}));

// ---------------------------------------------------------------------------
// Backfill review (services/xeroBackfill.js) — one-time-ish, run before the
// regular sync's own exact-match-only linking has a chance to create
// duplicates out of pre-existing records that don't match exactly on
// either side. See that file's header for the scoring approach.
// ---------------------------------------------------------------------------
router.get('/backfill/candidates', requireAdmin, asyncHandler(async (req, res) => {
  try {
    res.json(await computeBackfillCandidates());
  } catch (err) {
    throw badRequest(err.message);
  }
}));

router.post('/backfill/link', requireAdmin, asyncHandler(async (req, res) => {
  const { customer_id: customerId, xero_contact_id: xeroContactId } = req.body || {};
  if (!customerId || !xeroContactId) throw badRequest('customer_id and xero_contact_id are required');
  try {
    await linkCustomerToXero(customerId, xeroContactId);
  } catch (err) {
    throw badRequest(err.message);
  }
  res.json({ linked: true });
}));

// Bulk version of the above — "link all" on the confident-matches list,
// so confirming a few dozen obvious matches isn't a few dozen separate
// clicks.
router.post('/backfill/link-bulk', requireAdmin, asyncHandler(async (req, res) => {
  const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
  let linked = 0;
  for (const pair of pairs) {
    if (!pair.customer_id || !pair.xero_contact_id) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await linkCustomerToXero(pair.customer_id, pair.xero_contact_id);
    linked += 1;
  }
  res.json({ linked });
}));

router.post('/backfill/dismiss', requireAdmin, asyncHandler(async (req, res) => {
  const { customer_id: customerId, xero_contact_id: xeroContactId } = req.body || {};
  if (!customerId || !xeroContactId) throw badRequest('customer_id and xero_contact_id are required');
  await dismissMatch(customerId, xeroContactId);
  res.json({ dismissed: true });
}));

// ---------------------------------------------------------------------------
// Duplicate-customer review (services/xeroDuplicates.js) — cleanup for
// pre-existing customers the regular sync's exact-match-only linking
// missed and created a second, Xero-linked row for instead. See that
// file's header for the merge semantics.
// ---------------------------------------------------------------------------
router.get('/duplicates/candidates', requireAdmin, asyncHandler(async (req, res) => {
  try {
    res.json(await computeDuplicateCandidates());
  } catch (err) {
    throw badRequest(err.message);
  }
}));

router.post('/duplicates/merge', requireAdmin, asyncHandler(async (req, res) => {
  const { survivor_id: survivorId, duplicate_id: duplicateId } = req.body || {};
  if (!survivorId || !duplicateId) throw badRequest('survivor_id and duplicate_id are required');
  try {
    await mergeDuplicate(survivorId, duplicateId);
  } catch (err) {
    throw badRequest(err.message);
  }
  res.json({ merged: true });
}));

router.post('/duplicates/dismiss', requireAdmin, asyncHandler(async (req, res) => {
  const { survivor_id: survivorId, duplicate_id: duplicateId } = req.body || {};
  if (!survivorId || !duplicateId) throw badRequest('survivor_id and duplicate_id are required');
  await dismissDuplicate(survivorId, duplicateId);
  res.json({ dismissed: true });
}));

module.exports = router;
