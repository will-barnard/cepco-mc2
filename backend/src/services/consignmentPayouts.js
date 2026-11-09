'use strict';

/**
 * Consignment payout tickets (migration 090, NOTES.md §2.109).
 *
 * Selling a consignment opens a ticket to pay its consignor, in the
 * 'consignment_payout' category. Who it goes to is that category's
 * "Default assignee" (Settings -> Ticket categories), resolved by
 * resolveNewTicketFields like every other ticket; retiring the category
 * turns this off. The ticket is tied to the sale period it pays out
 * (instrument_ownership.payout_ticket_id) and the two stay in step:
 *
 *   sale of a consignment         -> ticket opened (payout_due)
 *   ticket finished               -> payout Paid out
 *     (terminal status, e.g. Done, or archived)
 *   ticket reopened               -> payout back to Payout due
 *   payout set Paid out by hand   -> ticket moved to Done
 *   payout set back to Payout due -> a Done (not archived) ticket reopens
 *   sale undone                   -> ticket unlinked and archived
 *
 * Each side only moves the other from the state it expects (Payout due <->
 * Paid out), so a value someone set deliberately -- "Contracted", "Not
 * recorded" -- is never overwritten by a ticket edit.
 *
 * Everything here runs on the caller's transaction. Opening the ticket is
 * best effort inside a savepoint: a sale must never fail because the payout
 * ticket couldn't be made (no statuses left for the category, say).
 */

const settings = require('./settings');
const { insertNote } = require('./ticketNotes');

// routes/tickets.js requires this file (its PATCH hook), so it's pulled in
// at call time rather than at load -- same lazy pattern routes/instruments.js
// uses for instrumentDetail.
const tickets = () => require('../routes/tickets');

const CATEGORY_KEY = 'consignment_payout';
const PREFERRED_PRIORITY_KEY = 'standard_priority';

const money = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** The category, or null when it's missing or retired (feature off). */
async function payoutCategory() {
  try {
    const row = await settings.resolve('ticket_category', CATEGORY_KEY);
    return row.retired ? null : row;
  } catch {
    return null;
  }
}

const statusRow = async (key) => {
  try { return await settings.resolve('ticket_status', key); } catch { return null; }
};

/** "Finished" = archived (the shop's normal done) or a terminal status. */
async function isFinished(ticket) {
  if (ticket.archived) return true;
  const s = await statusRow(ticket.status_key);
  return !!(s && s.meta && s.meta.terminal);
}

function payoutNote(per, consignorName) {
  const lines = [];
  const buyer = per.buyer_customer_name || per.sold_to_name;
  lines.push([
    'Sold',
    per.ended_on ? ` ${per.ended_on}` : '',
    per.sale_price !== null ? ` for ${money(per.sale_price)}` : '',
    buyer ? ` to ${buyer}` : '',
    '.',
  ].join(''));
  lines.push(`Consignor: ${consignorName || 'not recorded'}${per.customer_id ? ''
    : ' (no customer record yet -- link one from the instrument page)'}.`);
  if (per.consignment_terms) lines.push(`Deal: ${per.consignment_terms}`);
  if (per.consignment_rate !== null && per.sale_price !== null) {
    const rate = Number(per.consignment_rate);
    const price = Number(per.sale_price);
    const shop = Math.round(price * rate) / 100;
    lines.push(`At ${rate}% commission: consignor ${money(price - shop)}, CEPCo ${money(shop)}. `
      + 'Check the deal for services or labor owed on top.');
  } else if (per.sale_price === null) {
    lines.push('No sale price recorded -- add it from the instrument\'s ownership history.');
  }
  lines.push('Finishing this ticket (Done, or archiving it) marks the payout Paid out on the instrument.');
  return lines.join('\n');
}

/**
 * Open the payout ticket for a just-closed sale period. Returns the ticket,
 * or null when there's nothing to open (not a consignment, already paid
 * out, already has one, feature off) or it couldn't be made.
 */
async function openForSale(client, salePeriodId, userId) {
  const { rows: [per] } = await client.query(
    `SELECT o.*, c.name AS consignor_customer_name, b.name AS buyer_customer_name
       FROM instrument_ownership o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN customers b ON b.id = o.sold_to_customer_id
      WHERE o.id = $1`,
    [salePeriodId],
  );
  if (!per || per.kind !== 'consignment' || per.end_reason !== 'sale') return null;
  if (per.payout_status !== 'payout_due' || per.payout_ticket_id) return null;
  const category = await payoutCategory();
  if (!category) return null;

  await client.query('SAVEPOINT consignment_payout_ticket');
  try {
    const { resolveNewTicketFields, insertTicketRow, namingFor, composeTicketTitle } = tickets();
    const consignorName = per.consignor_customer_name || per.owner_name || '';
    const resolved = await resolveNewTicketFields({
      category_key: category.key,
      priority_key: await settings.defaultKeyPreferring('priority_tier', PREFERRED_PRIORITY_KEY),
    });
    const title = (await composeTicketTitle(
      per.customer_id, per.instrument_id, namingFor(category, null).template,
      { categoryLabel: category.label, ticketName: consignorName },
    )) || 'Consignment payout';
    const ticket = await insertTicketRow(client, {
      title,
      ticket_name: consignorName || null,
      instrument_id: per.instrument_id,
      // The consignor is the customer here -- it's their money.
      customer_id: per.customer_id || null,
      qc_required: false,
    }, resolved, userId);
    // Authorless on purpose: an automated note isn't pushed to the
    // consignor's Xero history (services/ticketNotes.js), and this one names
    // the buyer, who is none of the consignor's business.
    await insertNote(client, { ticketId: ticket.id, body: payoutNote(per, consignorName), createdBy: null });
    await client.query('UPDATE instrument_ownership SET payout_ticket_id = $2 WHERE id = $1', [per.id, ticket.id]);
    await client.query('RELEASE SAVEPOINT consignment_payout_ticket');
    return ticket;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT consignment_payout_ticket');
    console.error(`[consignment-payout] no ticket for sale period ${per.id}: ${err.message}`);
    return null;
  }
}

async function setPayoutStatus(client, per, from, to, userId) {
  if (per.payout_status !== from) return false;
  await client.query('UPDATE instrument_ownership SET payout_status = $2 WHERE id = $1', [per.id, to]);
  await client.query(
    `INSERT INTO instrument_events (instrument_id, employee_id, field, old_value, new_value)
     VALUES ($1, $2, 'consignment_status', $3, $4)`,
    [per.instrument_id, userId || null, from, to],
  );
  return true;
}

/** PATCH /tickets/:id hook: a payout ticket finished or reopened. */
async function syncFromTicket(client, before, after, userId) {
  if (before.status_key === after.status_key && before.archived === after.archived) return;
  const { rows: [per] } = await client.query(
    'SELECT * FROM instrument_ownership WHERE payout_ticket_id = $1 FOR UPDATE', [after.id],
  );
  if (!per) return;
  const [was, now] = await Promise.all([isFinished(before), isFinished(after)]);
  if (was === now) return;
  if (now) await setPayoutStatus(client, per, 'payout_due', 'paid_out', userId);
  else await setPayoutStatus(client, per, 'paid_out', 'payout_due', userId);
}

async function moveTicketStatus(client, ticket, status, userId, note) {
  await client.query(
    'UPDATE tickets SET status_key = $2, status_label_snapshot = $3 WHERE id = $1',
    [ticket.id, status.key, status.label],
  );
  await client.query(
    `INSERT INTO status_change_log (ticket_id, old_status, new_status, old_label, new_label, changed_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ticket.id, ticket.status_key, status.key, ticket.status_label_snapshot, status.label, userId || null, note],
  );
}

/**
 * PATCH /instruments/ownership/:id hook: the payout status was changed by
 * hand. `per` is the period as it was; `next` the new payout_status.
 */
async function syncFromPayout(client, per, next, userId) {
  if (!per.payout_ticket_id || per.payout_status === next) return;
  const { rows: [t] } = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [per.payout_ticket_id]);
  if (!t) return;
  const finished = await isFinished(t);
  if (next === 'paid_out' && !finished) {
    const statuses = await settings.listCategory('ticket_status');
    const done = statuses.find((s) => !s.retired && s.meta && s.meta.terminal
      && settings.statusAppliesToCategory(s, t.category_key, t.is_shipping));
    if (done) await moveTicketStatus(client, t, done, userId, 'Payout marked Paid out on the instrument');
  } else if (next === 'payout_due' && finished && !t.archived) {
    const open = await settings.defaultStatusForCategory(t.category_key, t.is_shipping);
    await moveTicketStatus(client, t, open, userId, 'Payout set back to Payout due on the instrument');
  }
}

/**
 * After instrument_undo_sale(): the reopened period is the current one. Its
 * payout ticket no longer pays for anything -- unlink it, and archive it
 * unless it already is (an archived one may record money that really went
 * out, so it's left as it is, just noted).
 */
async function onSaleUndone(client, instrumentId) {
  const { rows: [per] } = await client.query(
    'SELECT id, payout_ticket_id FROM instrument_ownership WHERE instrument_id = $1 AND end_reason IS NULL',
    [instrumentId],
  );
  if (!per || !per.payout_ticket_id) return;
  await client.query('UPDATE instrument_ownership SET payout_ticket_id = NULL WHERE id = $1', [per.id]);
  const { rows: [t] } = await client.query('SELECT archived FROM tickets WHERE id = $1', [per.payout_ticket_id]);
  if (!t) return;
  if (!t.archived) await client.query('UPDATE tickets SET archived = TRUE WHERE id = $1', [per.payout_ticket_id]);
  await insertNote(client, {
    ticketId: per.payout_ticket_id,
    body: t.archived
      ? 'The sale was undone on the instrument. This payout was already finished -- if the consignor was '
        + 'paid, that needs sorting out by hand. A new sale opens a new payout ticket.'
      : 'The sale was undone on the instrument, so no payout is owed for it. Archived automatically; '
        + 'a new sale opens a new payout ticket.',
    createdBy: null,
  });
}

module.exports = {
  CATEGORY_KEY, openForSale, syncFromTicket, syncFromPayout, onSaleUndone, isFinished,
};
