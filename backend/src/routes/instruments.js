'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, conflict } = require('../middleware/errors');

const catalog = require('../services/instrumentCatalog');
const ownership = require('../services/ownership');
const payouts = require('../services/consignmentPayouts');
const storage = require('../storage');

// Required lazily: both reach back into this file for FAMILIES (through
// services/inventory.js / routes/purchases.js), which isn't exported yet
// while this file is still loading.
const instrumentDetail = () => require('../services/instrumentDetail');
const purchases = () => require('./purchases');

const router = express.Router();
router.use(requireAuth);

// Instrument taxonomy (PLAN §5), extended per SHOWROOM QC. 'amp' and
// 'rarity' were consolidated into a single 'other' family (see migration
// 037 and NOTES.md) — the shop didn't have enough of either to justify
// separate buckets, and "amp" vs. "rarity" was a fairly arbitrary split to
// begin with (see importCsv.js's old classifier, which just fell through
// to whichever wasn't clearly an amp). Existing rows carrying the old keys
// are reassigned to 'other' by that migration in every table that stores
// a family (instruments, qc_templates, standard_procedures,
// instrument_default_technicians, instrument_models) — there's nothing
// left anywhere in the schema still writing 'amp' or 'rarity'.
//
// Nov 2026: 'organ' (Combo Organ) and 'other' went the same way, into one
// 'kombo' family labelled "Kombo+" -- migration 083 moves every table that
// stores a family. Nothing writes 'organ' or 'other' any more.
const FAMILIES = ['rhodes', 'wurlitzer', 'hohner', 'strings', 'kombo'];

router.get('/families', (req, res) => res.json(FAMILIES));

// N7 (boss-list scope, scaffold): a few of these family keys read fine as
// raw strings in a <select> ("rhodes", "wurlitzer") but the rest don't
// ("strings" and "kombo" are internal shorthand, not what a customer or
// even a tech would call the category out loud). Additive only — the
// existing /families endpoint above keeps its plain-string-array shape so
// none of its ~11 existing frontend consumers (`v-for="f in
// refData.families"` etc.) need to change; this is a second, optional
// lookup for screens that want a nicer label instead.
const FAMILY_LABELS = {
  rhodes: 'Rhodes',
  wurlitzer: 'Wurlitzer',
  hohner: 'Hohner',
  strings: 'Electric String Pianos',
  // Combo organs plus everything that isn't a keyboard piano: amps,
  // Leslies, synths, Mellotrons (migration 083).
  kombo: 'Kombo+',
};

router.get('/family-labels', (req, res) => res.json(FAMILY_LABELS));

// Instrument attributes -- Mark, suitcase amp, ... (migration 089). The
// refData store loads this alongside families; every form that shows them
// renders this list.
router.get('/attributes', (req, res) => res.json(catalog.ATTRIBUTES));

// ---------------------------------------------------------------------------
// Default technicians per instrument family (migration 014). Registered
// ahead of GET/PATCH '/:id' below, same reasoning as '/families' above —
// these are literal sub-paths, not an instrument id, and Express matches
// route registration order.
// ---------------------------------------------------------------------------

// Every family gets a (possibly empty) entry, not just the ones an admin
// has actually configured — callers (this route's own consumers: the
// Default instrument assignments page, and NewTicketForm.vue's auto-fill)
// shouldn't have to know FAMILIES themselves just to render "no defaults
// set yet" for the rest.
router.get('/default-technicians', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT family, employee_id FROM instrument_default_technicians ORDER BY family',
  );
  const byFamily = Object.fromEntries(FAMILIES.map((f) => [f, []]));
  for (const row of rows) {
    if (!byFamily[row.family]) byFamily[row.family] = [];
    byFamily[row.family].push(row.employee_id);
  }
  res.json(byFamily);
}));

// Replaces the full default set for one family — same "here's the whole
// list now" contract as PATCH /tickets/:id's technician_ids, just without
// needing a diff (there's no per-row state like queue_position to preserve
// here, so a delete-then-insert is simplest and correct). PATCH rather than
// PUT to match the rest of this API — nothing here uses PUT.
router.patch('/default-technicians/:family', requireAdmin, asyncHandler(async (req, res) => {
  const { family } = req.params;
  if (!FAMILIES.includes(family)) throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  const ids = [...new Set(
    (Array.isArray(req.body?.technician_ids) ? req.body.technician_ids : [])
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  )];

  await withTransaction(async (client) => {
    await client.query('DELETE FROM instrument_default_technicians WHERE family = $1', [family]);
    for (const employeeId of ids) {
      await client.query(
        'INSERT INTO instrument_default_technicians (family, employee_id) VALUES ($1, $2)',
        [family, employeeId],
      );
    }
  });
  res.json({ family, technician_ids: ids });
}));

// One-time (or occasional) catch-up: assign each instrument-bearing,
// non-archived ticket that currently has nobody on it to its instrument
// family's configured defaults. Tickets with no instrument are skipped
// outright (there's no family to look defaults up by), archived tickets
// are skipped (they're done — nothing to route to a queue), and a family
// with no defaults configured is left alone rather than guessed at.
router.post('/default-technicians/backfill', requireAdmin, asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: candidates } = await client.query(`
      SELECT t.id, i.family
        FROM tickets t
        JOIN instruments i ON i.id = t.instrument_id
       WHERE t.instrument_id IS NOT NULL
         AND t.archived = FALSE
         AND NOT EXISTS (SELECT 1 FROM ticket_technicians tt WHERE tt.ticket_id = t.id)
       ORDER BY t.id
    `);

    const { rows: defaultRows } = await client.query(
      'SELECT family, employee_id FROM instrument_default_technicians',
    );
    const defaultsByFamily = {};
    for (const row of defaultRows) {
      if (!defaultsByFamily[row.family]) defaultsByFamily[row.family] = [];
      defaultsByFamily[row.family].push(row.employee_id);
    }

    let ticketsAssigned = 0;
    let ticketsSkipped = 0;
    const perFamily = {};

    for (const candidate of candidates) {
      const employeeIds = defaultsByFamily[candidate.family] || [];
      if (!employeeIds.length) { ticketsSkipped += 1; continue; }

      // Same "back of the line" queue-position rule as a brand-new ticket
      // (insertTicketRow in routes/tickets.js) — computed one at a time per
      // employee so a tech picked up by several backfilled tickets in this
      // same run still gets sequential, non-colliding positions.
      for (const employeeId of employeeIds) {
        const { rows: techRows } = await client.query(
          `SELECT COALESCE(MAX(tt.queue_position), 0) + 10 AS next
             FROM ticket_technicians tt
             JOIN tickets t2 ON t2.id = tt.ticket_id
            WHERE tt.employee_id = $1 AND t2.archived = FALSE`,
          [employeeId],
        );
        await client.query(
          `INSERT INTO ticket_technicians (ticket_id, employee_id, queue_position, assigned_by)
           VALUES ($1, $2, $3, $4)`,
          [candidate.id, employeeId, techRows[0].next, req.user.id],
        );
      }
      ticketsAssigned += 1;
      perFamily[candidate.family] = (perFamily[candidate.family] || 0) + 1;
    }

    return {
      tickets_considered: candidates.length,
      tickets_assigned: ticketsAssigned,
      tickets_skipped_no_defaults: ticketsSkipped,
      per_family: perFamily,
    };
  });

  res.json(result);
}));

router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.family) { params.push(req.query.family); clauses.push(`i.family = $${params.length}`); }
  if (req.query.customer_id) { params.push(req.query.customer_id); clauses.push(`i.customer_id = $${params.length}`); }
  // inventory=true: everything the shop holds (owned stock + consignment),
  // excluding what's already sold — the instrument pickers for a ticket with
  // no customer and the rental calendar both want "what's in the building".
  // The full inventory list with its own filters is routes/inventory.js.
  if (req.query.inventory === 'true') {
    clauses.push("i.ownership <> 'customer' AND i.sale_status <> 'sold'");
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    clauses.push(`(i.model ILIKE $${params.length} OR i.identifying_notes ILIKE $${params.length}
                   OR i.nickname ILIKE $${params.length} OR i.serial_no ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT i.*, c.name AS customer_name,
            (SELECT count(*)::int FROM tickets t WHERE t.instrument_id = i.id AND t.archived = FALSE)
              AS open_tickets,
            ${catalog.FACTS_COLUMNS}
       FROM instruments i LEFT JOIN customers c ON c.id = i.customer_id
       ${catalog.FACTS_JOIN}
       ${where} ORDER BY i.family, i.model LIMIT 1000`,
    params,
  );
  res.json(rows);
}));

// Everything about one instrument, for the instrument page -- customer
// instruments and shop stock alike (services/instrumentDetail.js).
router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await instrumentDetail().loadDetail(req.params.id, req.user));
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.family || !FAMILIES.includes(b.family)) {
    throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  }
  const created = await withTransaction(async (client) => {
    // Catalog link + Mark (migration 086): the pickers send model_id with
    // the chain text; free text gets linked if it names one model outright.
    const m = await catalog.resolveModel(client, {
      family: b.family, model: b.model || null, model_id: b.model_id, attrs: b.attrs, mark: b.mark,
    }, {});
    const { rows } = await client.query(
      // Customer instruments only — shop stock and consignments are created
      // through POST /api/inventory, which owns ownership/sale_status.
      `INSERT INTO instruments (family, model, year, serial_no, identifying_notes,
                                customer_id, nickname, model_id, attr_overrides)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.family, m.model || null, b.year || null, b.serial_no || null,
        b.identifying_notes || null, b.customer_id || null,
        // N1: only the New Ticket page's "add a new instrument instead" form
        // sends this today — see composeTicketTitle in routes/tickets.js.
        b.nickname || null, m.model_id ?? null, m.attr_overrides || {}],
    );
    return catalog.selectWithFacts(client, rows[0].id);
  });
  res.status(201).json(created);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.family && !FAMILIES.includes(b.family)) {
    throw badRequest(`family must be one of: ${FAMILIES.join(', ')}`);
  }
  // A3: qc_interval_months is the one field here with an actual constraint
  // (the DB CHECK only allows NULL/3/6/12) — validated up front so a typo
  // surfaces as a clear 400 instead of a raw constraint-violation 500.
  if (b.qc_interval_months !== undefined && b.qc_interval_months !== null
    && ![3, 6, 12].includes(Number(b.qc_interval_months))) {
    throw badRequest('qc_interval_months must be 3, 6, 12, or null');
  }
  // Same field semantics as before migration 086 (family / model /
  // identifying_notes only change when a value is sent; year / serial /
  // nickname / customer / QC can be blanked), now built as one SET list so
  // the catalog link and Mark can join it.
  const f = {};
  if (b.family) f.family = b.family;
  if (b.model) f.model = String(b.model).trim();
  if (b.identifying_notes !== undefined && b.identifying_notes !== null) f.identifying_notes = b.identifying_notes;
  if (b.year !== undefined) f.year = b.year || null;
  if (b.serial_no !== undefined) f.serial_no = b.serial_no ? String(b.serial_no).trim() : null;
  if (b.nickname !== undefined) f.nickname = b.nickname ? String(b.nickname).trim() : null;
  if (b.customer_id !== undefined) f.customer_id = b.customer_id || null;
  if (b.last_qc_at !== undefined) f.last_qc_at = b.last_qc_at || null;
  if (b.qc_interval_months !== undefined) f.qc_interval_months = b.qc_interval_months || null;
  if (b.model_id !== undefined) f.model_id = b.model_id;
  if (b.attrs !== undefined) f.attrs = b.attrs;
  if (b.mark !== undefined) f.mark = b.mark;
  if (b.cover_photo_id !== undefined) f.cover_photo_id = b.cover_photo_id || null;

  const updated = await withTransaction(async (client) => {
    const { rows: before } = await client.query('SELECT * FROM instruments WHERE id = $1 FOR UPDATE', [req.params.id]);
    const old = before[0];
    if (!old) throw notFound('Instrument not found');
    await catalog.resolveModel(client, f, old);
    if (f.cover_photo_id) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM instrument_photos WHERE id = $1 AND instrument_id = $2', [f.cover_photo_id, old.id],
      );
      if (!rowCount) throw badRequest("That photo isn't one of this instrument's");
    }
    // Moving an instrument to a different customer from its edit form is
    // fixing who it was entered under, not a sale between them -- the
    // ownership history (migration 087) corrects the current owner.
    if (f.customer_id !== undefined && (f.customer_id ?? null) !== (old.customer_id ?? null)) {
      await ownership.setContext(client, { reason: 'correction', employeeId: req.user.id });
    }
    const cols = Object.keys(f);
    if (cols.length) {
      await client.query(
        `UPDATE instruments SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [old.id, ...cols.map((c) => f[c])],
      );
    }
    return catalog.selectWithFacts(client, old.id);
  });
  res.json(updated);
}));

// Customers page -> Instruments -> Edit -> Delete. Admin only (same bar as
// deleting a ticket). Tickets, estimate lines and shipment items that point
// at the instrument just lose the link (their FKs are ON DELETE SET NULL, and
// the ticket keeps its title); family_queue_position is cleared with it since
// that queue is keyed on the instrument's family. Rentals and purchase
// records, though, are CASCADE -- deleting would silently destroy them -- so
// an instrument that has any is refused with a 409 saying what to remove first.
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id FROM instruments WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) throw notFound('Instrument not found');

    const { rows: counts } = await client.query(
      `SELECT (SELECT count(*)::int FROM instrument_rentals WHERE instrument_id = $1) AS rentals,
              (SELECT count(*)::int FROM instrument_purchases WHERE instrument_id = $1) AS purchases`,
      [req.params.id],
    );
    const { rentals, purchases } = counts[0];
    if (rentals || purchases) {
      const bits = [];
      if (rentals) bits.push(`${rentals} rental record${rentals === 1 ? '' : 's'}`);
      if (purchases) bits.push(`${purchases} purchase record${purchases === 1 ? '' : 's'}`);
      throw conflict(`Can't delete: this instrument has ${bits.join(' and ')}. Remove those first.`);
    }

    const detached = await client.query(
      'UPDATE tickets SET instrument_id = NULL, family_queue_position = NULL WHERE instrument_id = $1',
      [req.params.id],
    );
    // Photo rows cascade with the instrument; their stored files don't.
    const { rows: photos } = await client.query(
      'SELECT storage_key FROM instrument_photos WHERE instrument_id = $1', [req.params.id],
    );
    await client.query('DELETE FROM instruments WHERE id = $1', [req.params.id]);
    return { deleted: true, tickets_detached: detached.rowCount, photoKeys: photos.map((p) => p.storage_key) };
  });
  // After the commit, best effort: a file that fails to delete is an
  // orphan in storage, not a reason to undo the delete.
  const { photoKeys, ...out } = result;
  await Promise.all(photoKeys.map((key) => storage.deleteObject(key).catch((err) => {
    console.warn(`[instruments] couldn't delete photo file ${key}: ${err.message}`);
  })));
  res.json({ ...out, photos_deleted: photoKeys.length });
}));

// ---------------------------------------------------------------------------
// Ownership changes (migration 087). The database writes the history; these
// routes make the change and say why. Selling lives with inventory
// (POST /inventory/:id/sell), since only shop stock or a consignment sells.
// ---------------------------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const dateOrToday = (v, field) => {
  if (v === undefined || v === null || v === '') return today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw badRequest(`${field} must be YYYY-MM-DD`);
  return String(v);
};
const moneyOrNull = (v, field) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a non-negative amount`);
  return n;
};

/**
 * The shop takes a customer's instrument: buys it (purchase record, cost,
 * optional restoration ticket -- the same steps as Record a purchase) or
 * takes it on consignment (the owner becomes the consignor). Same
 * instrument row either way, so its tickets, photos and model carry over.
 */
router.post('/:id/acquire', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!['buy', 'consign'].includes(b.mode)) throw badRequest('mode must be buy or consign');
  const openTicket = b.mode === 'buy' && b.open_ticket !== false;
  const resolved = openTicket ? await purchases().restorationTicketFields(b.priority_key) : null;

  const out = await withTransaction(async (client) => {
    const { rows: [old] } = await client.query(
      `SELECT i.*, c.name AS owner_name, c.email AS owner_email, c.phone AS owner_phone,
              NULLIF(concat_ws(', ', c.address_line1, c.address_line2, c.city,
                               concat_ws(' ', c.region, c.postal_code), c.country), '') AS owner_address
         FROM instruments i LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [req.params.id],
    );
    if (!old) throw notFound('Instrument not found');
    if (old.ownership !== 'customer') throw badRequest("It's already shop stock or a consignment");

    if (b.mode === 'buy') {
      const price = moneyOrNull(b.price, 'price');
      if (price === null) throw badRequest('What did the shop pay?');
      const purchaseDate = dateOrToday(b.purchase_date, 'purchase_date');
      const seller = {
        name: old.owner_name || (b.seller_name ? String(b.seller_name).trim() : ''),
        email: b.seller_email ?? old.owner_email,
        phone: old.owner_phone,
        address: old.owner_address,
      };
      if (!seller.name) throw badRequest('Who did the shop buy it from? This instrument has no owner on file');
      await ownership.setContext(client, { reason: 'purchase', employeeId: req.user.id });
      const { rows: [row] } = await client.query(
        `UPDATE instruments
            SET ownership = 'shop', customer_id = NULL, sale_status = 'available', cost_paid = $2
          WHERE id = $1 RETURNING *`,
        [old.id, price],
      );
      const { ticket, purchase } = await purchases().insertPurchase(client, {
        instrumentRow: row, seller, sellerCustomerId: old.customer_id, price, purchaseDate,
        notes: b.notes, resolved, openTicket, userId: req.user.id,
      });
      await client.query(
        `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
         VALUES ($1, $2, 'ownership', 'customer', 'shop')`,
        [old.id, req.user.id],
      );
      return { id: old.id, purchase_id: purchase.id, ticket_id: ticket ? ticket.id : null };
    }

    // consign
    if (!old.customer_id) throw badRequest("Link the owner's customer record first -- they'll be the consignor");
    const rate = b.consignment_rate === undefined || b.consignment_rate === null || b.consignment_rate === ''
      ? null : Number(String(b.consignment_rate).replace('%', ''));
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      throw badRequest('consignment_rate must be 0-100');
    }
    await ownership.setContext(client, { reason: 'consignment', employeeId: req.user.id });
    await client.query(
      `UPDATE instruments
          SET ownership = 'consignment', sale_status = 'available', consignment_status = 'for_sale',
              consignment_rate = $2, consignment_terms = $3, consignor_name = $4,
              asking_price = COALESCE($5, asking_price)
        WHERE id = $1`,
      [old.id, rate, b.consignment_terms ? String(b.consignment_terms).trim().slice(0, 500) : null,
        old.owner_name, moneyOrNull(b.asking_price, 'asking_price')],
    );
    await client.query(
      `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
       VALUES ($1, $2, 'ownership', 'customer', 'consignment')`,
      [old.id, req.user.id],
    );
    return { id: old.id };
  });

  const { id, ...extra } = out;
  res.status(201).json({ ...(await instrumentDetail().loadDetail(id, req.user)), ...extra });
}));

// Undo the most recent sale while its buyer is still the owner: the piece
// goes back to available stock / an active consignment. Seniors and admins.
router.post('/:id/undo-sale', requireRole('senior'), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    await ownership.undoSale(client, req.params.id);
    // No sale, no payout: its ticket is unlinked and archived (migration 090).
    await payouts.onSaleUndone(client, req.params.id);
    await client.query(
      `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
       VALUES ($1, $2, 'sold', 'sold', 'undone')`,
      [req.params.id, req.user.id],
    );
  });
  res.json(await instrumentDetail().loadDetail(req.params.id, req.user));
}));

/**
 * Fix or fill in one entry of the history: a sale's date, price and buyer
 * (linking the buyer's customer record also makes the piece theirs, if
 * they still own it), or a sold consignment's payout status.
 */
router.patch('/ownership/:periodId', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const instrumentId = await withTransaction(async (client) => {
    const { rows: [per] } = await client.query(
      'SELECT * FROM instrument_ownership WHERE id = $1 FOR UPDATE', [req.params.periodId],
    );
    if (!per) throw notFound('History entry not found');
    const isSale = per.end_reason === 'sale';
    const sets = {};
    const saleOnly = (field) => {
      if (!isSale) throw badRequest(`${field} is only for a sale`);
    };
    if (b.payout_status !== undefined) {
      if (!isSale || per.kind !== 'consignment') throw badRequest('Payout status is only for a sold consignment');
      const v = b.payout_status || null;
      if (v && !['contracted', 'for_sale', 'payout_due', 'paid_out'].includes(v)) throw badRequest('Unknown payout status');
      sets.payout_status = v;
    }
    if (b.sale_price !== undefined) { saleOnly('sale_price'); sets.sale_price = moneyOrNull(b.sale_price, 'sale_price'); }
    if (b.sold_to_name !== undefined) {
      saleOnly('sold_to_name');
      sets.sold_to_name = b.sold_to_name ? String(b.sold_to_name).trim().slice(0, 200) : null;
    }
    // The buyer's period is the one this sale opened (the next one).
    const { rows: [next] } = await client.query(
      'SELECT * FROM instrument_ownership WHERE instrument_id = $1 AND id > $2 ORDER BY id LIMIT 1',
      [per.instrument_id, per.id],
    );
    const buyerPeriod = isSale && next && next.start_reason === 'sale' ? next : null;
    if (b.sold_on !== undefined) {
      saleOnly('sold_on');
      sets.ended_on = dateOrToday(b.sold_on, 'sold_on');
      if (buyerPeriod) {
        await client.query('UPDATE instrument_ownership SET started_on = $2 WHERE id = $1', [buyerPeriod.id, sets.ended_on]);
      }
    }
    if (b.sold_to_customer_id !== undefined) {
      saleOnly('sold_to_customer_id');
      const buyerId = b.sold_to_customer_id ? Number(b.sold_to_customer_id) : null;
      if (buyerId) {
        const { rows } = await client.query('SELECT name FROM customers WHERE id = $1', [buyerId]);
        if (!rows[0]) throw badRequest("That buyer isn't a customer record");
      }
      sets.sold_to_customer_id = buyerId;
      if (buyerPeriod && buyerPeriod.end_reason === null) {
        // Still theirs: the instrument moves to (or off) that customer, and
        // the trigger corrects the current period to match.
        await ownership.setContext(client, { reason: 'correction', employeeId: req.user.id });
        await client.query('UPDATE instruments SET customer_id = $2 WHERE id = $1', [per.instrument_id, buyerId]);
        await client.query(
          'UPDATE instrument_ownership SET owner_name = CASE WHEN $2::int IS NULL THEN owner_name END WHERE id = $1',
          [buyerPeriod.id, buyerId],
        );
      } else if (buyerPeriod) {
        await client.query('UPDATE instrument_ownership SET customer_id = $2 WHERE id = $1', [buyerPeriod.id, buyerId]);
      }
    }
    const cols = Object.keys(sets);
    if (cols.length) {
      await client.query(
        `UPDATE instrument_ownership SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [per.id, ...cols.map((c) => sets[c])],
      );
    }
    // Paid out by hand -> its payout ticket moves to Done; back to Payout
    // due -> a Done one reopens (migration 090).
    if ('payout_status' in sets) await payouts.syncFromPayout(client, per, sets.payout_status, req.user.id);
    return per.instrument_id;
  });
  res.json(await instrumentDetail().loadDetail(instrumentId, req.user));
}));

module.exports = router;
module.exports.FAMILIES = FAMILIES;
// N10: composeTicketTitle (routes/tickets.js) and its client-side mirror
// (NewTicketForm.vue's autoTitlePreview) both need a human family label,
// not the raw key, in a standardized ticket title — same labels this
// route's own /family-labels endpoint already serves the frontend.
module.exports.FAMILY_LABELS = FAMILY_LABELS;
