'use strict';

/**
 * Friday Lunch (frontend FridayLunchView.vue; phase model in migration 094;
 * all rules in services/fridayLunch.js). Everyone signed in can suggest and
 * vote; only admins open rounds, move phases and edit the list.
 *
 * Every write answers with the caller's refreshed view of the round, so the
 * page never has to make a second request after a click.
 */

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../middleware/errors');
const lunch = require('../services/fridayLunch');

const router = express.Router();
router.use(requireAuth);

const id = (value, label = 'id') => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${label}`);
  return n;
};

// The newest round from the caller's side, or { round: null }. Always
// includes upcoming_friday so the admin's "start" form can default to it.
router.get('/current', asyncHandler(async (req, res) => {
  res.json(await lunch.currentState(req.user));
}));

router.get('/history', asyncHandler(async (req, res) => {
  res.json(await lunch.history(req.query.limit));
}));

router.get('/rounds/:id', asyncHandler(async (req, res) => {
  res.json(await lunch.roundState(id(req.params.id), req.user));
}));

// --- everyone -------------------------------------------------------------

router.post('/rounds/:id/suggestions', asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.suggest({ roundId, name: req.body?.name, user: req.user });
  res.status(201).json(await lunch.roundState(roundId, req.user));
}));

router.delete('/suggestions/:id', asyncHandler(async (req, res) => {
  await lunch.withdrawSuggestion({ suggestionId: id(req.params.id), user: req.user });
  res.json(await lunch.currentState(req.user));
}));

router.put('/rounds/:id/ballot', asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.castBallot({ roundId, choices: req.body?.choices, user: req.user });
  res.json(await lunch.roundState(roundId, req.user));
}));

router.delete('/rounds/:id/ballot', asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.withdrawBallot({ roundId, user: req.user });
  res.json(await lunch.roundState(roundId, req.user));
}));

// --- admin ----------------------------------------------------------------

router.post('/rounds', requireAdmin, asyncHandler(async (req, res) => {
  const round = await lunch.openRound({ lunchDate: req.body?.lunch_date, user: req.user });
  res.status(201).json(await lunch.roundState(round.id, req.user));
}));

// body: { to: 'reviewing' | 'suggesting' | 'voting' | 'closed' | 'cancelled' }
router.post('/rounds/:id/phase', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  const to = String(req.body?.to || '');
  await lunch.setPhase({ roundId, to });
  res.json(await lunch.roundState(roundId, req.user));
}));

router.post('/rounds/:id/places', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.addPlace({ roundId, name: req.body?.name });
  res.status(201).json(await lunch.roundState(roundId, req.user));
}));

router.patch('/places/:id', requireAdmin, asyncHandler(async (req, res) => {
  const place = await lunch.renamePlace({ placeId: id(req.params.id), name: req.body?.name });
  res.json(await lunch.roundState(place.round_id, req.user));
}));

router.post('/places/:id/merge', requireAdmin, asyncHandler(async (req, res) => {
  const target = await lunch.mergePlace({
    placeId: id(req.params.id), intoPlaceId: id(req.body?.into_place_id, 'into_place_id'),
  });
  res.json(await lunch.roundState(target.round_id, req.user));
}));

router.delete('/places/:id', requireAdmin, asyncHandler(async (req, res) => {
  await lunch.removePlace({ placeId: id(req.params.id) });
  res.json(await lunch.currentState(req.user));
}));

module.exports = router;
