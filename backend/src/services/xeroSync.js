'use strict';

/**
 * Two-way customer <-> Xero Contact reconciliation — the one place both
 * the manual "Sync now" button (routes/xero.js, admin-only) and the
 * nightly schedule (services/xeroScheduler.js) actually run from, same
 * "exactly one definition of what a sync does" reasoning as
 * services/ceppys.js's sendCeppyDigest. See migration 047 for the two
 * columns this reads/writes on customers (xero_contact_id, xero_synced_at)
 * and NOTES.md for the full design writeup.
 *
 * Algorithm, once per run:
 *   1. Fetch every Xero contact and every MC2 customer in full (small
 *      dataset for a single shop — a full diff each run is simpler and
 *      more robust than tracking an incremental cursor, and Xero's
 *      Starter-tier API pricing doesn't charge for this org's data volume
 *      anyway).
 *   2. Match each Xero contact to an MC2 customer: first by
 *      xero_contact_id (already linked from a previous run), then —
 *      for a customer never linked before — by email, then by exact name,
 *      but only when that email/name is unique on the MC2 side. An
 *      ambiguous match (more than one MC2 customer with the same email)
 *      is deliberately left unmatched rather than guessed at: a duplicate
 *      contact is obvious and easy to fix by hand later; a wrong merge
 *      silently overwrites one customer's data with another's.
 *   3. A Xero contact with no MC2 match at all is a Xero-only contact —
 *      create it here (source = 'xero').
 *   4. An MC2 customer with no Xero match at all (after step 2) is an
 *      MC2-only customer — create it in Xero.
 *   5. For every matched pair, compare xero_synced_at (this row's own
 *      last-reconciled time) against both sides' actual last-changed
 *      time (Xero's UpdatedDateUTC, MC2's updated_at). Whichever side (or
 *      neither, or — a real conflict — both) changed since then decides
 *      what happens: pull, push, or nothing. Both-changed is resolved
 *      last-write-wins by comparing the two timestamps directly, and
 *      recorded in the returned summary's `conflicts` list rather than
 *      resolved silently — an admin glancing at a sync result should be
 *      able to see when that happened and to whom.
 *
 * Known limitation, deliberate: Xero's Addresses/Phones are structured
 * (line1/city/region/postal, typed phone numbers); customers.address and
 * .phone are single free-text fields. Pulling from Xero flattens the
 * structured fields into one string; pushing to Xero sends the whole
 * free-text address as AddressLine1 and the whole phone as a single
 * PhoneNumber. Good enough to have the data present and usable on both
 * sides; not a substitute for entering a new address directly in Xero
 * when its structure actually matters there (e.g. printed on an invoice).
 */

const { query } = require('../db');
const xero = require('../xero');
const settings = require('./settings');

// --- field mapping -----------------------------------------------------

function phoneFromXero(xc) {
  const phones = xc.Phones || [];
  const p = phones.find((x) => x.PhoneType === 'DEFAULT') || phones[0];
  if (!p) return null;
  const joined = [p.PhoneCountryCode, p.PhoneAreaCode, p.PhoneNumber].filter(Boolean).join(' ').trim();
  return joined || null;
}

function addressFromXero(xc) {
  const addrs = xc.Addresses || [];
  const a = addrs.find((x) => x.AddressType === 'STREET') || addrs[0];
  if (!a) return null;
  const joined = [a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4, a.City, a.Region, a.PostalCode]
    .filter(Boolean).join(', ');
  return joined || null;
}

function mcFieldsFromXero(xc) {
  return {
    name: xc.Name || '(unnamed Xero contact)',
    email: xc.EmailAddress || null,
    phone: phoneFromXero(xc),
    address: addressFromXero(xc),
  };
}

function xeroPayloadFromMc(customer) {
  const payload = { Name: customer.name };
  if (customer.email) payload.EmailAddress = customer.email;
  if (customer.phone) payload.Phones = [{ PhoneType: 'DEFAULT', PhoneNumber: String(customer.phone).slice(0, 50) }];
  if (customer.address) {
    payload.Addresses = [{ AddressType: 'STREET', AddressLine1: String(customer.address).slice(0, 500) }];
  }
  return payload;
}

// --- matching ------------------------------------------------------------

const emailKey = (v) => (v ? String(v).trim().toLowerCase() : '');
const nameKey = (v) => (v ? String(v).trim().toLowerCase() : '');

/** A key -> row map built only from keys that are unique across `rows` —
 * an ambiguous key (shared by more than one row) is left out entirely
 * rather than pointing at an arbitrary one of them. */
function uniqueIndex(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key && counts.get(key) === 1) map.set(key, row);
  }
  return map;
}

async function runXeroSync() {
  const [xeroContacts, mcResult, dismissedResult] = await Promise.all([
    xero.listContacts(),
    query('SELECT * FROM customers'),
    query('SELECT customer_id, xero_contact_id FROM xero_dismissed_matches'),
  ]);
  const mcCustomers = mcResult.rows;
  // A pair an admin explicitly said "not the same" to on the backfill
  // review screen (migration 048, services/xeroBackfill.js) never gets
  // auto-linked here either, even if it would otherwise match by exact
  // email or name — a shared household email between two different
  // people is exactly the case that review screen exists to catch.
  const dismissed = new Set(dismissedResult.rows.map((r) => `${r.customer_id}:${r.xero_contact_id}`));

  // Only real, active customers — not the shop's own parts-vendor/supplier
  // contacts this same Xero org also tracks for its AP side, and not a
  // contact either side has already archived.
  const xeroCandidates = xeroContacts.filter((c) => c.IsCustomer === true && c.ContactStatus !== 'ARCHIVE');

  const mcByXeroId = new Map(mcCustomers.filter((c) => c.xero_contact_id).map((c) => [c.xero_contact_id, c]));
  const unlinkedMc = mcCustomers.filter((c) => !c.xero_contact_id);
  const unlinkedMcByEmail = uniqueIndex(unlinkedMc, (c) => emailKey(c.email));
  const unlinkedMcByName = uniqueIndex(unlinkedMc, (c) => nameKey(c.name));

  const handledMcIds = new Set();
  const stats = {
    mc2_created: 0, mc2_updated: 0, xero_created: 0, xero_updated: 0, linked: 0, unchanged: 0,
  };
  const conflicts = [];

  // customers has a BEFORE UPDATE trigger (migration 001's touch_updated_at)
  // that stamps updated_at = now() on every write this function makes,
  // sync's own included — which would make every synced row look
  // "changed since last sync" on the *next* run if xero_synced_at weren't
  // set to that exact same now() in the exact same statement. Postgres's
  // now() is fixed for the life of one transaction, and each query() call
  // here is its own implicit transaction, so the trigger's updated_at and
  // this xero_synced_at always land on the identical instant — mcChanged
  // below correctly reads that as "unchanged" (a strict `>` compare, not
  // `>=`) rather than looping a sync's own write back in as a conflict.
  const stampLink = (customerId, xeroContactId) => query(
    'UPDATE customers SET xero_contact_id = $1, xero_synced_at = now() WHERE id = $2',
    [xeroContactId, customerId],
  );

  for (const xc of xeroCandidates) {
    let mc = mcByXeroId.get(xc.ContactID);
    const isNewLink = !mc;
    if (!mc) {
      // unlinkedMcByEmail/unlinkedMcByName are a static snapshot taken
      // before this loop started, so without the handledMcIds check a
      // customer could get "matched" a second time later in the same run
      // — e.g. two Xero contacts that happen to share an exact email (a
      // real, not even rare, Xero data-quality issue: Xero doesn't
      // enforce contact email uniqueness) would otherwise both claim the
      // same customer, and the second UPDATE would silently steal the
      // link away from the first.
      const candidate = unlinkedMcByEmail.get(emailKey(xc.EmailAddress)) || unlinkedMcByName.get(nameKey(xc.Name));
      if (candidate && !handledMcIds.has(candidate.id) && !dismissed.has(`${candidate.id}:${xc.ContactID}`)) {
        mc = candidate;
      }
    }

    if (!mc) {
      // No match anywhere — a contact that exists only in Xero.
      const fields = mcFieldsFromXero(xc);
      const { rows } = await query( // eslint-disable-line no-await-in-loop
        `INSERT INTO customers (name, email, phone, address, source, xero_contact_id, xero_synced_at)
         VALUES ($1, $2, $3, $4, 'xero', $5, now()) RETURNING id`,
        [fields.name, fields.email, fields.phone, fields.address, xc.ContactID],
      );
      handledMcIds.add(rows[0].id);
      stats.mc2_created += 1;
      continue; // eslint-disable-line no-continue
    }

    handledMcIds.add(mc.id);
    if (isNewLink) stats.linked += 1;

    const lastSync = mc.xero_synced_at ? new Date(mc.xero_synced_at) : null;
    const xeroChanged = !lastSync || new Date(xc.UpdatedDateUTC) > lastSync;
    const mcChanged = !lastSync || new Date(mc.updated_at) > lastSync;

    let action = 'unchanged';
    if (isNewLink) {
      // A fresh link (matched here for the first time, or confirmed on
      // the backfill/duplicate-merge review screens, both of which
      // deliberately leave xero_synced_at null for exactly this branch to
      // handle) has no real "last synced" baseline — comparing timestamps
      // like the branch below does is actively wrong for it, not just
      // unnecessary: mc.updated_at right now often just reflects *when
      // the link itself was made* (linking/merging writes
      // xero_contact_id, and the customers_touch trigger bumps updated_at
      // on any write to the row, that link included), not whether the
      // customer's actual contact info is more current than Xero's. That
      // "just linked" timestamp is almost always more recent than
      // whatever Xero's real UpdatedDateUTC is, so racing them here
      // silently favored MC2 nearly every time — which is exactly why
      // customers linked through backfill or the duplicate-merge tool
      // kept missing their Xero email (and anything else Xero had that
      // MC2 didn't) even after a sync reported success. A first-time link
      // always pulls instead — see the merge-if-missing handling below,
      // which still won't blank out an MC2 field Xero doesn't have.
      action = 'pull';
    } else if (xeroChanged && mcChanged) {
      action = new Date(xc.UpdatedDateUTC) >= new Date(mc.updated_at) ? 'pull' : 'push';
      conflicts.push(
        `${mc.name || xc.Name}: both sides changed since the last sync — kept the `
        + `${action === 'pull' ? 'Xero' : 'MC2'} version (more recently updated).`,
      );
    } else if (xeroChanged) {
      action = 'pull';
    } else if (mcChanged) {
      action = 'push';
    }

    if (action === 'pull') {
      const fields = mcFieldsFromXero(xc);
      // A fresh link's pull fills in whatever MC2 is missing without
      // discarding what it already has — the whole reason a human just
      // linked these two records was to connect them, not to declare
      // Xero's copy authoritative over real MC2 data (e.g. a phone number
      // that was itself part of why the match was confident in the first
      // place). Every later pull (a real "Xero changed since last sync")
      // still overwrites outright, same as always — this merge is only
      // for the first reconciliation of a pair.
      const toWrite = isNewLink
        ? {
          name: mc.name || fields.name,
          email: mc.email || fields.email,
          phone: mc.phone || fields.phone,
          address: mc.address || fields.address,
        }
        : fields;
      await query( // eslint-disable-line no-await-in-loop
        `UPDATE customers SET name = $1, email = $2, phone = $3, address = $4,
                                xero_contact_id = $5, xero_synced_at = now()
          WHERE id = $6`,
        [toWrite.name, toWrite.email, toWrite.phone, toWrite.address, xc.ContactID, mc.id],
      );
      stats.mc2_updated += 1;
    } else if (action === 'push') {
      await xero.updateContact(xc.ContactID, xeroPayloadFromMc(mc)); // eslint-disable-line no-await-in-loop
      await stampLink(mc.id, xc.ContactID); // eslint-disable-line no-await-in-loop
      stats.xero_updated += 1;
    } else {
      await stampLink(mc.id, xc.ContactID); // eslint-disable-line no-await-in-loop
      stats.unchanged += 1;
    }
  }

  // Whatever's left never matched a Xero contact at all — an MC2 customer
  // (walk-in, Shopify order, etc.) that doesn't exist in Xero yet.
  for (const mc of mcCustomers) {
    if (handledMcIds.has(mc.id) || mc.xero_contact_id) continue; // eslint-disable-line no-continue
    const created = await xero.createContact(xeroPayloadFromMc(mc)); // eslint-disable-line no-await-in-loop
    await stampLink(mc.id, created.ContactID); // eslint-disable-line no-await-in-loop
    stats.xero_created += 1;
  }

  // Stamp last_synced_at on the shop_config row itself — same purpose as
  // ceppys_schedule.last_sent_at: what the Customers page's panel shows,
  // and (for the scheduled path) what stops the scheduler from running a
  // second time on the same shop-local day.
  const { rows: scheduleRows } = await query(
    "SELECT id, meta FROM settings WHERE category = 'shop_config' AND key = 'xero_sync'",
  );
  if (scheduleRows[0]) {
    await settings.update(scheduleRows[0].id, {
      meta: { ...scheduleRows[0].meta, last_synced_at: new Date().toISOString() },
    });
  }

  return { ...stats, conflicts };
}

/**
 * One-time catch-up for customers whose link to Xero didn't get a proper
 * first-time field pull — two separate causes have landed here so far,
 * hence checking all three of name/email/phone/address rather than just
 * whichever one prompted the most recent report:
 *
 *   1. Linked before xero.js's listContacts() was fixed to request full
 *      contact detail (`summaryOnly=false` — see that file's header).
 *      Every contact fetched from Xero looked like it simply had no
 *      address or phone on file, so runXeroSync() correctly "pulled" a
 *      blank into MC2 for each one.
 *   2. Linked (via the backfill or duplicate-merge review screens, or
 *      matched directly by runXeroSync()) before that function's own
 *      first-time-link handling was fixed to always pull instead of
 *      racing timestamps — see runXeroSync()'s `isNewLink` branch for the
 *      full explanation. That bug favored MC2's side almost every time, so
 *      it mostly showed up as a missing *email* specifically (email was
 *      usually the field that didn't match exactly in the first place,
 *      which is why these customers needed backfill/merge to link at
 *      all), but nothing stops it from having affected phone or address
 *      too on some pair.
 *
 * In both cases the regular sync's own change-detection can't undo the
 * damage on its own: it compares xero_synced_at against Xero's
 * UpdatedDateUTC, and once a customer has been stamped as synced, a
 * field that's still blank looks "already reconciled" forever unless the
 * Xero contact changes again for unrelated reasons.
 *
 * This bypasses that change-detection entirely and only fills gaps: for
 * every already-linked customer, whichever of name/email/phone/address
 * is still blank in MC2 gets Xero's value, if Xero has one. Anything
 * that already has a value in MC2 (even one that's stale or wrong) is
 * left alone — reconciling an actually-differing value is still the
 * regular sync's job, once a real future change makes it look "changed"
 * the normal way. xero_synced_at is never touched, so this can't make
 * the regular sync think anything's been reconciled that hasn't. Safe to
 * run more than once — it's a no-op once nothing's missing.
 */
async function fillMissingFieldsFromXero() {
  const [xeroContacts, mcResult] = await Promise.all([
    xero.listContacts(),
    query('SELECT id, xero_contact_id, name, email, phone, address FROM customers WHERE xero_contact_id IS NOT NULL'),
  ]);
  const byContactId = new Map(xeroContacts.map((xc) => [xc.ContactID, xc]));

  let nameFilled = 0;
  let emailFilled = 0;
  let phoneFilled = 0;
  let addressFilled = 0;
  for (const mc of mcResult.rows) {
    const xc = byContactId.get(mc.xero_contact_id);
    if (!xc) continue; // eslint-disable-line no-continue -- linked contact no longer in Xero's list (archived, deleted)

    // mc.name is NOT NULL in the schema, but a Xero-created row can still
    // carry the mcFieldsFromXero() placeholder ('(unnamed Xero contact)')
    // from before that contact had a real name on file — treat that the
    // same as blank.
    const name = (!mc.name || mc.name === '(unnamed Xero contact)') && xc.Name ? xc.Name : null;
    const email = mc.email ? null : (xc.EmailAddress || null);
    const phone = mc.phone ? null : phoneFromXero(xc);
    const address = mc.address ? null : addressFromXero(xc);
    if (!name && !email && !phone && !address) continue; // eslint-disable-line no-continue -- nothing missing, or Xero has nothing to fill it with

    await query( // eslint-disable-line no-await-in-loop
      `UPDATE customers SET
         name = COALESCE($1, name), email = COALESCE(email, $2),
         phone = COALESCE(phone, $3), address = COALESCE(address, $4)
       WHERE id = $5`,
      [name, email, phone, address, mc.id],
    );
    if (name) nameFilled += 1;
    if (email) emailFilled += 1;
    if (phone) phoneFilled += 1;
    if (address) addressFilled += 1;
  }

  return {
    checked: mcResult.rows.length,
    name_filled: nameFilled,
    email_filled: emailFilled,
    phone_filled: phoneFilled,
    address_filled: addressFilled,
  };
}

/**
 * Push one customer's current MC2 field values to its linked Xero
 * contact right away, outside the regular sync's own schedule — used by
 * the customer edit form (routes/customers.js's PATCH) so an edit made
 * here reaches Xero immediately rather than waiting for "Sync now" or
 * the nightly run. xero_synced_at is stamped afterwards in a separate
 * statement, same as runXeroSync()'s own push branch (stampLink) — it
 * doesn't need to land in the exact same instant as the edit's own
 * UPDATE, just at or after it, so the next regular sync's mcChanged
 * check (a strict `>` compare) reads this edit as already reconciled
 * rather than pushing it again.
 */
async function pushCustomerToXero(customer) {
  if (!customer.xero_contact_id) throw new Error('Customer is not linked to Xero');
  await xero.updateContact(customer.xero_contact_id, xeroPayloadFromMc(customer));
  await query('UPDATE customers SET xero_synced_at = now() WHERE id = $1', [customer.id]);
}

module.exports = {
  runXeroSync, phoneFromXero, addressFromXero, fillMissingFieldsFromXero, pushCustomerToXero,
};
