'use strict';
const fs = require('node:fs');
const path = require('node:path');

const NAME_PATTERN = /^jewelpro-\d{8}-\d{6}-(auto|manual)\.db$/;

function backupDir(store) {
  const dir = path.join(store.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function list(store) {
  const dir = backupDir(store);
  return fs.readdirSync(dir)
    .filter((name) => NAME_PATTERN.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Writes a complete, consistent copy of the database while the app keeps running. */
function run(store, kind = 'manual') {
  const dir = backupDir(store);
  let name = `jewelpro-${stamp()}-${kind}.db`;
  let n = 1;
  while (fs.existsSync(path.join(dir, name))) {
    name = `jewelpro-${stamp(new Date(Date.now() + n * 1000))}-${kind}.db`;
    n += 1;
  }
  const target = path.join(dir, name);
  store.db.prepare('VACUUM INTO ?').run(target);
  prune(store);
  const stat = fs.statSync(target);
  // Optional second copy, e.g. to a Google Drive / OneDrive folder or a USB drive.
  let copied = null;
  let copyError = null;
  const copyDir = store.setting('backup_copy_dir');
  if (copyDir) {
    try {
      fs.copyFileSync(target, path.join(copyDir, name));
      copied = path.join(copyDir, name);
    } catch (err) {
      copyError = `The second copy to ${copyDir} failed: ${err.message}`;
    }
  }
  return { name, size: stat.size, created_at: stat.mtime.toISOString(), copied, copy_error: copyError };
}

function prune(store) {
  const keep = Math.max(1, Number(store.setting('backup_keep_count')) || 30);
  const dir = backupDir(store);
  for (const file of list(store).slice(keep)) fs.unlinkSync(path.join(dir, file.name));
}

function find(store, name) {
  if (!NAME_PATTERN.test(String(name))) return null;
  const file = path.join(backupDir(store), name);
  return fs.existsSync(file) ? { name, path: file } : null;
}

/** Makes an automatic backup if the newest one is older than the given number of hours. */
function autoBackupIfDue(store, hours = 20) {
  const newest = list(store)[0];
  if (newest && Date.now() - new Date(newest.created_at).getTime() < hours * 3600 * 1000) return null;
  return run(store, 'auto');
}

module.exports = { list, run, find, autoBackupIfDue };
