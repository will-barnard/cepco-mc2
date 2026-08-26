'use strict';

const { Pool, types } = require('pg');
const config = require('./config');

// node-pg's default DATE (oid 1082) parser builds a JS Date at local
// midnight, then JSON serializes it through .toISOString() — a UTC
// conversion. Depending on the server's TZ that can shift a date-only value
// (drop_off_date, due_date, and now instrument_rentals.start_date/end_date)
// onto the wrong calendar day for a viewer who isn't in that same zone. A
// DATE column has no time component to convert in the first place, so keep
// the raw 'YYYY-MM-DD' string from the wire instead of round-tripping it
// through a Date object at all.
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

const query = (text, params) => pool.query(text, params);

/** Run a set of statements in a transaction. `fn` receives a client. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Wait for Postgres to accept connections (compose start ordering). */
async function waitForDatabase({ attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`[db] not ready (attempt ${i}/${attempts}): ${err.code || err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, query, withTransaction, waitForDatabase };
