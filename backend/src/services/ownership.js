'use strict';

/**
 * Ownership history (migration 087) — who an instrument belonged to, and
 * how it changed hands.
 *
 * instrument_ownership holds one row per period. The database keeps it in
 * step (trigger instrument_ownership_track) and refuses a commit where it
 * disagrees with the instrument row (deferred instrument_ownership_check),
 * so routes never insert periods themselves. What they do:
 *
 *   - say *why* an owner change happens, before making it, with
 *     setContext(client, { reason, employeeId }) in the same transaction
 *     ('purchase', 'consignment', 'consignment_returned', 'correction', ...);
 *   - record a sale / undo one through the SQL functions, which write the
 *     ledger themselves (recordSale / undoSale below);
 *   - annotate the period afterwards when there's more to say (which
 *     purchase started it).
 */

const { badRequest } = require('../middleware/errors');

async function setContext(client, { reason, employeeId } = {}) {
  await client.query(
    "SELECT set_config('mc2.ownership_reason', $1, true), set_config('mc2.employee_id', $2, true)",
    [reason || '', employeeId ? String(employeeId) : ''],
  );
}

const currentPeriod = async (client, instrumentId) => (await client.query(
  'SELECT * FROM instrument_ownership WHERE instrument_id = $1 AND end_reason IS NULL', [instrumentId],
)).rows[0] || null;

/** Turn the SQL functions' RAISE EXCEPTION into a 400 the page can show. */
async function callLedgerFunction(client, sql, params) {
  try {
    return (await client.query(sql, params)).rows[0];
  } catch (err) {
    if (err.code === 'P0001') throw badRequest(err.message.replace(/^instrument \d+: /, ''));
    throw err;
  }
}

/**
 * Sell a shop / consignment piece: closes its period with the sale on it,
 * opens the buyer's, and the piece becomes the buyer's instrument. Returns
 * the sale period's id.
 */
async function recordSale(client, instrumentId, { soldOn, price, buyerId, buyerName, employeeId }) {
  const row = await callLedgerFunction(
    client,
    'SELECT instrument_record_sale($1, $2, $3, $4, $5, $6) AS id',
    [instrumentId, soldOn, price, buyerId || null, buyerName || null, employeeId || null],
  );
  return row.id;
}

async function undoSale(client, instrumentId) {
  await callLedgerFunction(client, 'SELECT instrument_undo_sale($1)', [instrumentId]);
}

/**
 * Every period, newest first, with the names to show. The purchase price
 * is what the shop paid — cost information, admins only (same rule as
 * instruments.cost_paid).
 */
async function historyFor(db, instrumentId, user) {
  const { rows } = await db.query(
    `SELECT o.*, c.name AS customer_name, b.name AS sold_to_customer_name,
            p.seller_name, p.seller_customer_id, sc.name AS seller_customer_name,
            p.purchase_date, p.price AS purchase_price, p.receipt_sent_at, p.ticket_id AS purchase_ticket_id,
            e.name AS created_by_name
       FROM instrument_ownership o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN customers b ON b.id = o.sold_to_customer_id
       LEFT JOIN instrument_purchases p ON p.id = o.purchase_id
       LEFT JOIN customers sc ON sc.id = p.seller_customer_id
       LEFT JOIN employees e ON e.id = o.created_by
      WHERE o.instrument_id = $1
      ORDER BY o.id DESC`,
    [instrumentId],
  );
  const isAdmin = user?.role === 'admin';
  // The most recent sale can be undone while its buyer is still the owner.
  const canUndo = rows.length >= 2 && rows[0].start_reason === 'sale' && rows[1].end_reason === 'sale';
  return rows.map((r, idx) => {
    const out = { ...r, can_undo: canUndo && idx === 1 };
    if (!isAdmin) delete out.purchase_price;
    return out;
  });
}

module.exports = { setContext, currentPeriod, recordSale, undoSale, historyFor };
