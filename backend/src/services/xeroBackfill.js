'use strict';

/**
 * Backfill review — Will's ask: before the regular two-way sync
 * (xeroSync.js) runs for the first time against an org that already has
 * its own customer history on both sides, find likely "these are the
 * same person" pairs that don't already match exactly (xeroSync.js's own
 * matcher already handles exact email/name for free — this is for
 * everything messier than that: a typo, a nickname, an email on file in
 * one system but not the other) and let a human confirm or reject each
 * one before anything gets linked or created. See
 * frontend/src/views/XeroBackfillView.vue for the review screen this
 * backs, and migration 048 for where a rejection ("not a match") is
 * remembered.
 *
 * Scoring, dependency-free (no fuzzy-matching package — same "no SDK,
 * hand-roll the small thing" posture as xero.js's plain-fetch API
 * client): exact email match scores highest; otherwise a bigram (Dice
 * coefficient) similarity on the name, a standard, simple, and
 * reasonably reliable measure of "how much do these two strings share"
 * that doesn't need a library; a matching phone number (compared by its
 * last 7 digits, so country/area-code formatting differences don't break
 * an otherwise-real match) nudges the score up as a supporting signal.
 * Every candidate the UI shows includes *which* signals fired, so a
 * human reviewing "Bob Smith" vs "Robert Smith" can see it's a name-only
 * match and judge it accordingly rather than trusting a bare percentage.
 *
 * Assignment is greedy, not an optimal bipartite matching (Hungarian
 * algorithm etc.) — walk every candidate pair above the floor, highest
 * score first, and claim it if neither side has already been claimed by
 * a better-scoring pair. Good enough for a shop's customer list, and
 * simple enough that a human reviewing the result can reason about why a
 * given pair was or wasn't suggested.
 */

const { query } = require('../db');
const xero = require('../xero');
const { phoneFromXero } = require('./xeroSync');

const CONFIDENT_THRESHOLD = 0.82;
const POSSIBLE_FLOOR = 0.45;

const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

function bigrams(s) {
  const clean = s.replace(/[^a-z0-9 ]/g, '');
  const grams = [];
  for (let i = 0; i < clean.length - 1; i += 1) grams.push(clean.slice(i, i + 2));
  return grams;
}

/** Dice's coefficient: 2x shared bigrams over the total bigram count of
 * both strings. 1 for identical strings, 0 for nothing in common — a
 * cheap, well-known measure for exactly this "are these two names
 * probably the same" job. */
function nameSimilarity(a, b) {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  if (!A.length || !B.length) return 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let shared = 0;
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) { shared += 1; counts.set(g, c - 1); }
  }
  return (2 * shared) / (A.length + B.length);
}

function phonesMatch(a, b) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  return da.length >= 7 && db.length >= 7 && da.slice(-7) === db.slice(-7);
}

function scorePair(mc, xc) {
  const signals = [];
  let score = 0;

  const mcEmail = normalize(mc.email);
  const xcEmail = normalize(xc.EmailAddress);
  if (mcEmail && xcEmail && mcEmail === xcEmail) {
    signals.push('email');
    score = 0.95;
  }

  const nameSim = nameSimilarity(mc.name, xc.Name);
  if (nameSim > score) score = nameSim;
  if (nameSim >= 0.6) signals.push('name');

  if (phonesMatch(mc.phone, phoneFromXero(xc))) {
    signals.push('phone');
    score = Math.min(1, score + 0.15);
  }

  return { score, signals };
}

function summarizeMc(mc) {
  return {
    id: mc.id, name: mc.name, email: mc.email, phone: mc.phone, address: mc.address,
  };
}

function summarizeXero(xc) {
  return {
    xero_contact_id: xc.ContactID,
    name: xc.Name,
    email: xc.EmailAddress || null,
    phone: phoneFromXero(xc),
  };
}

async function computeBackfillCandidates() {
  const [xeroContacts, mcResult, dismissedResult] = await Promise.all([
    xero.listContacts(),
    query('SELECT * FROM customers WHERE xero_contact_id IS NULL'),
    query('SELECT customer_id, xero_contact_id FROM xero_dismissed_matches'),
  ]);
  const unlinkedMc = mcResult.rows;
  const dismissed = new Set(dismissedResult.rows.map((r) => `${r.customer_id}:${r.xero_contact_id}`));

  const unlinkedXero = xeroContacts.filter(
    (c) => c.IsCustomer === true && c.ContactStatus !== 'ARCHIVE',
  );

  // Every pair above the floor, best first.
  const scored = [];
  for (const mc of unlinkedMc) {
    for (const xc of unlinkedXero) {
      if (dismissed.has(`${mc.id}:${xc.ContactID}`)) continue; // eslint-disable-line no-continue
      const { score, signals } = scorePair(mc, xc);
      if (score >= POSSIBLE_FLOOR) scored.push({
        mc, xc, score, signals,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const claimedMc = new Set();
  const claimedXero = new Set();
  const confident = [];
  const possible = [];
  for (const pair of scored) {
    if (claimedMc.has(pair.mc.id) || claimedXero.has(pair.xc.ContactID)) continue; // eslint-disable-line no-continue
    claimedMc.add(pair.mc.id);
    claimedXero.add(pair.xc.ContactID);
    const row = {
      mc: summarizeMc(pair.mc), xero: summarizeXero(pair.xc), score: pair.score, signals: pair.signals,
    };
    (pair.score >= CONFIDENT_THRESHOLD ? confident : possible).push(row);
  }

  const mcUnmatched = unlinkedMc.filter((mc) => !claimedMc.has(mc.id)).map(summarizeMc);
  const xeroUnmatched = unlinkedXero.filter((xc) => !claimedXero.has(xc.ContactID)).map(summarizeXero);

  return {
    confident,
    possible,
    mc_unmatched: mcUnmatched,
    // Every still-unlinked Xero contact (not just the unmatched ones) —
    // the review screen's manual "search Xero contacts" box searches this
    // full list, since the algorithm can miss a real match (a big enough
    // typo, a maiden name) that a human recognizes instantly.
    xero_all_unlinked: unlinkedXero.map(summarizeXero),
    _xero_unmatched_count: xeroUnmatched.length,
  };
}

async function linkCustomerToXero(customerId, xeroContactId) {
  // Deliberately does NOT stamp xero_synced_at — leaving it null makes
  // the next regular sync (manual or nightly) treat this exactly like
  // any other first-time link: it reconciles field values by comparing
  // which side changed more recently, rather than this tool having to
  // duplicate that logic. See xeroSync.js's header.
  const { rows } = await query(
    'UPDATE customers SET xero_contact_id = $1 WHERE id = $2 RETURNING id',
    [xeroContactId, customerId],
  );
  if (!rows[0]) throw new Error('Customer not found');
}

async function dismissMatch(customerId, xeroContactId) {
  await query(
    `INSERT INTO xero_dismissed_matches (customer_id, xero_contact_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [customerId, xeroContactId],
  );
}

module.exports = { computeBackfillCandidates, linkCustomerToXero, dismissMatch };
