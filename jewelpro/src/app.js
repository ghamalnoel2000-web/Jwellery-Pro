'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Store } = require('./db');
const { authenticate } = require('./auth');
const { createApiRouter } = require('./api');
const { AppError } = require('./errors');

function createApp({ dataDir, logger = console } = {}) {
  const store = new Store(dataDir);
  require('./backfill').runAccountingBackfill(store, { log: () => {} });
  require('./backfill').runStockBackfill(store, { log: () => {} });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'"
    });
    next();
  });

  app.use(express.json({ limit: '200kb' }));
  app.use(authenticate(store));
  app.use('/api', createApiRouter(store));
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'Not found.')));

  const publicDir = path.join(__dirname, '..', 'public');
  app.get('/vendor/JsBarcode.all.min.js', (_req, res) => {
    res.sendFile(require.resolve('jsbarcode/dist/JsBarcode.all.min.js'));
  });
  app.get('/shared/bsdate.js', (_req, res) => res.sendFile(path.join(__dirname, 'bsdate.js')));
  // The page asks for each screen file with the version number, so after an update no browser can keep using old files.
  const version = require('../package.json').version;
  const indexHtml = () => fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace(/(src|href)="(\/[^"?]+\.(?:js|css))"/g, `$1="$2?v=${version}"`);
  const sendIndex = (_req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(indexHtml()); };
  app.get(['/', '/index.html'], sendIndex);
  app.use(express.static(publicDir, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.get('*', sendIndex);

  // Errors: known problems get their message; anything else is logged and hidden from the user.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
    if (String(err.message || '').includes('UNIQUE constraint failed')) {
      return res.status(422).json({ error: 'That value is already used. Choose a different one.' });
    }
    if (String(err.message || '').includes('CHECK constraint failed')) {
      return res.status(422).json({ error: 'A value is outside the allowed range. Check the numbers you entered.' });
    }
    logger.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: 'Something went wrong. The details were written to the server window.' });
  });

  return { app, store };
}

module.exports = { createApp };
