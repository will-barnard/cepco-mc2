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

// Requests (migrations 097-098) -- one anonymous request each, the first
// step of suggesting. body: { text } or { none: true } for "no requests".
router.put('/rounds/:id/request', asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.saveRequest({
    roundId, text: req.body?.text, none: req.body?.none === true, user: req.user,
  });
  res.json(await lunch.roundState(roundId, req.user));
}));

router.delete('/rounds/:id/request', asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.removeRequest({ roundId, user: req.user });
  res.json(await lunch.roundState(roundId, req.user));
}));

// Orders (migration 096) -- only once an admin has opened them on a result.
router.put('/rounds/:id/order', asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.saveOrder({ roundId, text: req.body?.text, user: req.user });
  res.json(await lunch.roundState(roundId, req.user));
}));

router.delete('/rounds/:id/order', asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.removeOrder({ roundId, user: req.user });
  res.json(await lunch.roundState(roundId, req.user));
}));

// --- admin ----------------------------------------------------------------

router.post('/rounds/:id/orders/open', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.openOrders({ roundId });
  res.json(await lunch.roundState(roundId, req.user));
}));

router.post('/rounds/:id/orders/close', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.closeOrders({ roundId });
  res.json(await lunch.roundState(roundId, req.user));
}));

// Admin moderation: remove anyone's request (round id = the round it was made in).
router.delete('/rounds/:id/requests/:requestId', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.removeRequest({ roundId, requestId: id(req.params.requestId, 'request id'), user: req.user });
  res.json(await lunch.roundState(roundId, req.user));
}));

router.delete('/rounds/:id/orders/:orderId', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.removeOrder({ roundId, orderId: id(req.params.orderId, 'order id'), user: req.user });
  res.json(await lunch.roundState(roundId, req.user));
}));

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

// Re-decide a round closed under the old ranked-choice count by points.
// Answers with the round's refreshed state plus whether the winner changed.
router.post('/rounds/:id/recount', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  const { changed } = await lunch.recountRound({ roundId });
  res.json({ ...(await lunch.roundState(roundId, req.user)), winner_changed: changed });
}));

// body: { top: N } -- send the closed round's top N places to a pick-one
// runoff. Answers with the new runoff round's state.
router.post('/rounds/:id/runoff', requireAdmin, asyncHandler(async (req, res) => {
  const runoffId = await lunch.startRunoff({ roundId: id(req.params.id), top: req.body?.top, user: req.user });
  res.status(201).json(await lunch.roundState(runoffId, req.user));
}));

// Settle a tied runoff by drawing one of the tied places at random.
router.post('/rounds/:id/pick-random', requireAdmin, asyncHandler(async (req, res) => {
  const roundId = id(req.params.id);
  await lunch.pickRandomWinner({ roundId });
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
