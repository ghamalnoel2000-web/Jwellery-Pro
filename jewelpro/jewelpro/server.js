'use strict';
const os = require('node:os');
const path = require('node:path');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`JewelPro needs Node.js 22.13 or newer. You have ${process.versions.node}. Install the current Node.js 22 LTS from nodejs.org.`);
  process.exit(1);
}

const { createApp } = require('./src/app');
const backup = require('./src/backup');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.JEWELPRO_DATA_DIR || path.join(__dirname, 'data');

const { app, store } = createApp({ dataDir: DATA_DIR });

function safeBackup() {
  try {
    const file = backup.autoBackupIfDue(store);
    if (file) console.log(`Automatic backup saved: ${file.name}${file.copied ? ` (copy: ${file.copied})` : ''}`);
    if (file && file.copy_error) console.error(file.copy_error);
  } catch (err) {
    console.error('Automatic backup failed:', err);
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  JewelPro is running.');
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On the shop network: http://${a.address}:${PORT}`);
    }
  }
  console.log(`  Data folder:        ${DATA_DIR}`);
  console.log('  Keep this window open while the shop is using JewelPro. Press Ctrl+C to stop.');
  console.log('');
  safeBackup();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. JewelPro may already be running in another window.`);
  } else {
    console.error('JewelPro could not start:', err);
  }
  process.exit(1);
});

setInterval(safeBackup, 60 * 60 * 1000).unref();

function shutdown() {
  console.log('Stopping JewelPro...');
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
