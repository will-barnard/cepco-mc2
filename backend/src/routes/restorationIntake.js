'use strict';

/**
 * Restoration sales from Shopify (migration 100, services/restorationIntake.js).
 * Mounted at /api/restoration-intake. Reading is for any signed-in user (the
 * dashboard asks whether to show the card); acting checks for a reviewer
 * or an admin inside the service.
 */

const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../middleware/errors');
const intake = require('../services/restorationIntake');

const router = express.Router();
router.use(requireAuth);

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Bad id');
  return id;
};

// Homepage card. Reviewers (or every admin, when none are picked) get the
// open items; everyone else gets an empty list, so the card stays hidden.
router.get('/', asyncHandler(async (req, res) => {
  if (!(await intake.isReviewer(req.user))) return res.json({ reviewer: false, items: [] });
  res.json({ reviewer: true, ...(await intake.listOpen()) });
}));

// Settings -> Shopify orders: the full history.
router.get('/recent', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await intake.listRecent(req.query.limit));
}));

// Who reviews -- for the settings picker's "falls back to admins" hint.
router.get('/reviewers', requireAdmin, asyncHandler(async (req, res) => {
  const [ids, effective] = await Promise.all([intake.reviewerIds(), intake.effectiveReviewers()]);
  res.json({ ids, effective: effective.rows, fallback: effective.fallback });
}));

router.get('/instruments', asyncHandler(async (req, res) => {
  res.json(await intake.searchStock(req.query.q));
}));

router.get('/instruments/:id', asyncHandler(async (req, res) => {
  const row = await intake.loadCandidate(db, idParam(req));
  if (!row) return res.status(404).json({ error: 'Instrument not found' });
  res.json(row);
}));

router.post('/:id/preview', asyncHandler(async (req, res) => {
  res.json(await intake.preview(idParam(req), req.body || {}));
}));

router.post('/:id/confirm', asyncHandler(async (req, res) => {
  res.json(await intake.confirm(idParam(req), req.body || {}, req.user));
}));

router.post('/:id/dismiss', asyncHandler(async (req, res) => {
  await intake.dismiss(idParam(req), req.body || {}, req.user);
  res.status(204).end();
}));

router.post('/:id/cancellation', asyncHandler(async (req, res) => {
  await intake.reviewCancellation(idParam(req), req.body || {}, req.user);
  res.status(204).end();
}));

module.exports = router;
