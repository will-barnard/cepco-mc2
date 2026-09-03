'use strict';

/**
 * Duplicate-customer review. Originally built (§2.56) for one specific
 * gap: the regular Xero sync (xeroSync.js) only matches an existing MC2
 * customer to a Xero contact by exact email or exact name, so anything
 * messier (a nickname, a typo, an email on file in one system only)
 * doesn't match and the sync creates a brand-new MC2 customer instead
 * (source = 'xero') — leaving two rows for one real person.
 *
 * §2.64 generalized this beyond that one cause, after the estimate
 * wizard turned out to have its own way of producing a duplicate
 * customer (a failed submit, retried, before the fix in that section)
 * that has nothing to do with Xero at all. Scoring and merging now
 * consider every pair of customers, not just "unlinked" vs.
 * "Xero-created" — see `orderPair` and `scoreDuplicatePair` below — but
 * the Xero case stays a first-class citizen of the ordering: given a
 * choice between a customer already linked to Xero and one that isn't,
 * the unlinked one survives and inherits the link, same as always,
 * since the sync only ever creates a new row when matching an existing
 * one failed. Reuses xeroBackfill.js's scoring on purpose rather than
 * reimplementing it — see that file's exports.
 *
 * A confirmed pair gets *merged*: every child record (tickets,
 * instruments, emails, estimates, progress updates) pointing at the
 * duplicate is reassigned to the survivor, the survivor takes over the
 * duplicate's xero_contact_id if it has one the survivor doesn't already
 * have, and the duplicate row is deleted. xero_synced_at is deliberately
 * left null on the survivor afterwards when a Xero link moved over —
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
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    address: c.address,
    source: c.source,
    xero_linked: !!c.xero_contact_id,
  };
}

// Decides which side of a scored pair survives. A customer already
// linked to Xero is always kept over one that isn't, with the link
// moving over on merge — the sync only ever creates a new row when
// matching an existing one failed, so the unlinked side is the
// pre-existing, likely-real one. Outside that case (two ordinary
// customers, or — practically never, since Xero contact ids are
// unique — two already linked to the same or different contacts),
// there's no such signal, so the older row (lower id) survives and the
// newer one, most likely the accidental repeat, is the one merged away.
function orderPair(a, b) {
  const aXero = !!a.xero_contact_id;
  const bXero = !!b.xero_contact_id;
  if (aXero !== bXero) return aXero ? [b, a] : [a, b];
  return a.id < b.id ? [a, b] : [b, a];
}

async function computeDuplicateCandidates() {
  const [allResult, dismissedResult] = await Promise.all([
    query('SELECT * FROM customers'),
    query('SELECT survivor_id, duplicate_id FROM xero_dismissed_duplicate_pairs'),
  ]);
  const all = allResult.rows;
  const dismissed = new Set(dismissedResult.rows.map((r) => `${r.survivor_id}:${r.duplicate_id}`));

  // Every pair, not just "unlinked" vs. "Xero-created" — see this file's
  // header. A shop's customer list is small enough that the full O(n^2)
  // scan is fine for an on-demand admin review screen (only ever run
  // when someone opens this page, never polled).
  const scored = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const [survivor, duplicate] = orderPair(all[i], all[j]);
      if (dismissed.has(`${survivor.id}:${duplicate.id}`)) continue; // eslint-disable-line no-continue
      const { score, signals } = scoreDuplicatePair(survivor, duplicate);
      if (score >= POSSIBLE_FLOOR) scored.push({
        survivor, duplicate, score, signals,
      });
    }
  }
  scored.sort((x, y) => y.score - x.score);

  const claimed = new Set();
  const confident = [];
  const possible = [];
  for (const pair of scored) {
    if (claimed.has(pair.survivor.id) || claimed.has(pair.duplicate.id)) continue; // eslint-disable-line no-continue
    claimed.add(pair.survivor.id);
    claimed.add(pair.duplicate.id);
    const row = {
      survivor: summarize(pair.survivor), duplicate: summarize(pair.duplicate), score: pair.score, signals: pair.signals,
    };
    (pair.score >= CONFIDENT_THRESHOLD ? confident : possible).push(row);
  }

  // source='xero' rows that never scored against anything — most likely
  // genuinely new customers the sync was right to create. Shown as a
  // count only, same as xeroBackfill.js's Xero-only-contacts card, since
  // there's nothing to review if nothing was suggested.
  const duplicatesUnmatchedCount = all.filter(
    (c) => c.source === 'xero' && c.xero_contact_id && !claimed.has(c.id),
  ).length;

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
    // Two different real Xero contacts landing on one merged MC2 customer
    // is genuinely ambiguous — nothing here can safely pick which contact
    // should represent the result — so refuse rather than guess. Every
    // other combination (neither linked, or only one of the two) is safe:
    // the duplicate's link, if it has one, just moves onto the survivor.
    if (survivor.xero_contact_id && duplicate.xero_contact_id
      && survivor.xero_contact_id !== duplicate.xero_contact_id) {
      throw new Error('Both customers are linked to different Xero contacts — unlink one before merging.');
    }

    for (const { table, column } of CHILD_TABLES) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [survivorId, duplicateId],
      );
    }

    if (duplicate.xero_contact_id && !survivor.xero_contact_id) {
      // xero_synced_at left null on purpose — see this file's header.
      await client.query(
        'UPDATE customers SET xero_contact_id = $1, xero_synced_at = NULL WHERE id = $2',
        [duplicate.xero_contact_id, survivorId],
      );
    }
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
