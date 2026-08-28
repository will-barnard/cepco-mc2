'use strict';

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { pool, waitForDatabase } = require('./db');
const { errorHandler } = require('./middleware/errors');
const { migrate } = require('./scripts/migrate');
const { seed } = require('./scripts/seed');
const ceppyScheduler = require('./services/ceppyScheduler');

const app = express();

app.set('trust proxy', 1); // behind Beachhead's nginx-proxy
// Shopify webhook HMAC verification needs the exact raw bytes Shopify
// signed — capture them alongside the normal parse rather than adding a
// second body-parsing path just for that one route.
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

// Health check — Beachhead polls /healthz through the frontend proxy.
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'cepco-mc2-backend', db: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});
app.get('/api/healthz', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/instruments', require('./routes/instruments'));
app.use('/api/rentals', require('./routes/rentals'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/shopify', require('./routes/shopifyWebhooks'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/estimates', require('./routes/estimates'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/public/quotes', require('./routes/publicQuotes'));
app.use('/api/procedures', require('./routes/procedures'));
app.use('/api/hours', require('./routes/hours'));
app.use('/api/qc', require('./routes/qc'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/parts', require('./routes/parts'));
app.use('/api/shipments', require('./routes/shipments'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/ceppys', require('./routes/ceppys'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use(errorHandler);

async function start() {
  await waitForDatabase();
  await migrate();
  await seed();

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[cepco-mc2] backend listening on :${config.port} (${config.env})`);
  });

  ceppyScheduler.start();
}

const shutdown = async (signal) => {
  console.log(`[cepco-mc2] ${signal} received, shutting down`);
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch((err) => {
    console.error('[cepco-mc2] failed to start', err);
    process.exit(1);
  });
}

module.exports = app;
