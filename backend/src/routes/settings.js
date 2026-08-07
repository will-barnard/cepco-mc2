'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');
const settings = require('../services/settings');

const router = express.Router();
router.use(requireAuth);

// Reads are open to all staff — the whole UI needs the enum labels.
router.get('/', asyncHandler(async (req, res) => res.json(await settings.listAll())));

router.get('/:category', asyncHandler(async (req, res) => {
  res.json(await settings.listCategory(req.params.category));
}));

// Writes are admin-only (§8).
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  res.status(201).json(await settings.create(req.body || {}));
}));

router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await settings.update(req.params.id, req.body || {}));
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await settings.remove(req.params.id));
}));

/** How many tickets currently carry this value — powers the delete warning. */
router.get('/:category/:key/usage', requireAdmin, asyncHandler(async (req, res) => {
  const count = await settings.countUsage(req.params.category, req.params.key);
  res.json({ in_use: count });
}));

module.exports = router;
