'use strict';

/**
 * Duplicate-customer review — cleanup for the gap the backfill screen
 * (xeroBackfill.js) exists to prevent but, run after the fact or skipped
 * entirely, can't undo: the regular sync (xeroSync.js) only matches an
 * existing MC2 customer to a Xero contact by exact email or exact name.
 * Anything messier (a nickname, a typo, an email on file in one system
 * only) doesn't match, so the sync did exactly what its own header says
 * an unmatched Xero contact gets — created a new MC2 customer for it
 * (source = 'xero') — leaving the shop with two rows for one real person:
 * the original, and a freshly-created duplicate that's now the one
 * actually linked to Xero.
 *
 * This mirrors xeroBackfill.js's approach on purpose (same scoring,
 * reused from there rather than reimplemented — see that file's exports)
 * but the pairing is different: instead of "MC2 customer" vs. "Xero
 * contact", it's "pre-existing MC2 customer with no Xero link" (the
 * likely-real one, called `survivor` below) vs. "MC2 customer the sync
 * just created from Xero" (`duplicate`, source = 'xero', already linked).
 * A confirmed pair gets *merged*: every child record (tickets,
 * instruments, emails, estimates, progress updates) pointing at the
 * duplicate is reassigned to the survivor, the survivor takes over the
 * duplicate's xero_contact_id, and the duplicate row is deleted.
 * xero_synced_at is deliberately left null on the survivor afterwards —
 * same reasoning as xeroBackfill.js's linkCustomerToXero — so the next
 * regular sync run reconciles field values (name/email/phone/address)
 * itself by comparing which side actually changed more recently, rather
 * than this merge having to guess which of the two versions is "right".
 */

const { query, withTransaction } = require('../db');
const {
  nameSimilarity, phonesMatch, CONFIDENT_THRESHOLD, POSSIBLE_FLOOR,
} = require('./xeroBackfill');

// Every table with a customer_id FK onto customers(id) — see migrations
// 001, 011, 020/046. Kept as one explicit list here rather than
// discovered from the schema at runtime — a hardcoded, commented list is
// easier to audit than a query against information_schema when the whole
// point is "did I get every table", and this schema doesn't grow a new
// customer_id column often enough for that tradeoff to matter.
const CHILD_TABLES = [
  { table: 'instruments', column: 'customer_id' },
  { table: 'tickets', column: 'customer_id' },
  { table: 'emails', column: 'customer_id' },
  { table: 'estimates', column: 'customer_id' },
  { table: 'progress_updates', column: 'customer_id' },
];

const emailKey = (v) => (v ? String(v).trim().toLowerCase() : '');

function scoreDuplicatePair(survivor, duplicate) {
  const signals = [];
  let score = 0;

  const a = emailKey(survivor.email);
  const b = emailKey(duplicate.email);
  if (a && b && a === b) {
    signals.push('email');
    score = 0.9;
  }

  const nameSim = nameSimilarity(survivor.name, duplicate.name);
  if (nameSim > score) score = nameSim;
  if (nameSim >= 0.6) signals.push('name');

  if (phonesMatch(survivor.phone, duplicate.phone)) {
    signals.push('phone');
    score = Math.min(1, score + 0.15);
  }

  return { score, signals };
}

function summarize(c) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address, source: c.source,
  };
}

async function computeDuplicateCandidates() {
  const [allResult, dismissedResult] = await Promise.all([
    query('SELECT * FROM customers'),
    query('SELECT survivor_id, duplicate_id FROM xero_dismissed_duplicate_pairs'),
  ]);
  const all = allResult.rows;
  const dismissed = new Set(dismissedResult.rows.map((r) => `${r.survivor_id}:${r.duplicate_id}`));

  // A "survivor" candidate is any customer never linked to Xero — that's
  // exactly the set the sync would have matched against, so if one of
  // these is a real duplicate of a source='xero' row, matching failed.
  const survivors = all.filter((c) => !c.xero_contact_id);
  const duplicates = all.filter((c) => c.source === 'xero' && c.xero_contact_id);

  const scored = [];
  for (const survivor of survivors) {
    for (const duplicate of duplicates) {
      if (dismissed.has(`${survivor.id}:${duplicate.id}`)) continue; // eslint-disable-line no-continue
      const { score, signals } = scoreDuplicatePair(survivor, duplicate);
      if (score >= POSSIBLE_FLOOR) scored.push({
        survivor, duplicate, score, signals,
      });
    }
  }
  scored.sort((x, y) => y.score - x.score);

  const claimedSurvivor = new Set();
  const claimedDuplicate = new Set();
  const confident = [];
  const possible = [];
  for (const pair of scored) {
    if (claimedSurvivor.has(pair.survivor.id) || claimedDuplicate.has(pair.duplicate.id)) continue; // eslint-disable-line no-continue
    claimedSurvivor.add(pair.survivor.id);
    claimedDuplicate.add(pair.duplicate.id);
    const row = {
      survivor: summarize(pair.survivor), duplicate: summarize(pair.duplicate), score: pair.score, signals: pair.signals,
    };
    (pair.score >= CONFIDENT_THRESHOLD ? confident : possible).push(row);
  }

  // source='xero' rows that never scored against anything — most likely
  // genuinely new customers the sync was right to create. Shown as a
  // count only, same as xeroBackfill.js's Xero-only-contacts card, since
  // there's nothing to review if nothing was suggested.
  const duplicatesUnmatchedCount = duplicates.filter((d) => !claimedDuplicate.has(d.id)).length;

  return {
    confident, possible, duplicates_unmatched_count: duplicatesUnmatchedCount,
  };
}

async function mergeDuplicate(survivorId, duplicateId) {
  if (survivorId === duplicateId) throw new Error('Cannot merge a customer into itself');

  await withTransaction(async (client) => {
    // Two explicit rows rather than `= ANY($1)` — this codebase's plain-SQL
    // convention elsewhere doesn't lean on Postgres array params, and FOR
    // UPDATE here just needs both rows locked before either gets touched.
    const { rows } = await client.query(
      'SELECT id, source, xero_contact_id FROM customers WHERE id = $1 OR id = $2 FOR UPDATE',
      [survivorId, duplicateId],
    );
    const survivor = rows.find((r) => r.id === survivorId);
    const duplicate = rows.find((r) => r.id === duplicateId);
    if (!survivor) throw new Error('Survivor customer not found');
    if (!duplicate) throw new Error('Duplicate customer not found');
    if (!duplicate.xero_contact_id || duplicate.source !== 'xero') {
      throw new Error('That record was not created by the Xero sync — nothing to merge');
    }
    if (survivor.xero_contact_id) {
      throw new Error('The surviving customer is already linked to a Xero contact');
    }

    for (const { table, column } of CHILD_TABLES) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [survivorId, duplicateId],
      );
    }

    // xero_synced_at left null on purpose — see this file's header.
    await client.query(
      'UPDATE customers SET xero_contact_id = $1, xero_synced_at = NULL WHERE id = $2',
      [duplicate.xero_contact_id, survivorId],
    );
    await client.query('DELETE FROM customers WHERE id = $1', [duplicateId]);
  });
}

async function dismissDuplicate(survivorId, duplicateId) {
  await query(
    `INSERT INTO xero_dismissed_duplicate_pairs (survivor_id, duplicate_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [survivorId, duplicateId],
  );
}

module.exports = { computeDuplicateCandidates, mergeDuplicate, dismissDuplicate };
