'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BS = require('../src/bsdate');
const { Store } = require('../src/db');

const cal = BS.createCalendar();

test('known new year dates', () => {
  // Baisakh 1 of each year, as published
  assert.deepEqual(cal.toBs(1943, 4, 14), { year: 2000, month: 1, day: 1 });
  assert.deepEqual(cal.toBs(2023, 4, 14), { year: 2080, month: 1, day: 1 });
  assert.deepEqual(cal.toBs(2024, 4, 13), { year: 2081, month: 1, day: 1 });
  assert.deepEqual(cal.toBs(2025, 4, 14), { year: 2082, month: 1, day: 1 });
  assert.deepEqual(cal.toBs(2026, 4, 14), { year: 2083, month: 1, day: 1 });
  assert.deepEqual(cal.toAd(2083, 6, 12), { year: 2026, month: 9, day: 28 });
  assert.deepEqual(cal.toAd(2083, 4, 1), { year: 2026, month: 7, day: 17 });
});

test('every day converts both ways', () => {
  for (let d = new Date(Date.UTC(1943, 3, 14)); d.getUTCFullYear() < 2034; d = new Date(d.getTime() + 86400000)) {
    const ad = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const bs = cal.toBs(ad.year, ad.month, ad.day);
    assert.ok(bs, `no BS date for ${JSON.stringify(ad)}`);
    assert.deepEqual(cal.toAd(bs.year, bs.month, bs.day), ad);
  }
});

test('invalid and out-of-range dates', () => {
  assert.equal(cal.toAd(2083, 8, 30), null, 'Mangsir 2083 has 29 days');
  assert.equal(cal.toAd(2083, 13, 1), null);
  assert.equal(cal.toBs(1943, 4, 13), null);
  assert.equal(cal.toBs(2100, 1, 1), null);
});

test('verified and provisional years', () => {
  assert.equal(cal.status(2083), 'verified');
  assert.equal(cal.status(2084), 'provisional');
  assert.equal(cal.status(cal.lastYear + 1), 'missing');
});

test('owner corrections override the built-in table', () => {
  const days = [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30];
  const custom = BS.createCalendar({ 2084: days });
  assert.equal(custom.status(2084), 'confirmed');
  assert.deepEqual(custom.monthDays(2084), days);
  assert.deepEqual(custom.toBs(2027, 4, 14), cal.toBs(2027, 4, 14), 'years before the correction are unchanged');
  const extended = BS.createCalendar({ [cal.lastYear + 1]: days });
  assert.equal(extended.lastYear, cal.lastYear + 1);
  const invalid = BS.createCalendar({ 2084: [30, 30] });
  assert.equal(invalid.status(2084), 'provisional', 'bad corrections are ignored');
});

test('month length checks', () => {
  assert.equal(BS.monthDaysProblem([31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]), null);
  assert.match(BS.monthDaysProblem([31, 31, 32]), /all 12/);
  assert.match(BS.monthDaysProblem([33, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]), /29, 30, 31 or 32/);
  assert.match(BS.monthDaysProblem([29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29]), /365 or 366/);
});

test('fiscal year starts on 1 Shrawan', () => {
  assert.deepEqual(cal.fiscalYearOf({ year: 2083, month: 6, day: 12 }), { start: 2083, label: '2083/84' });
  assert.deepEqual(cal.fiscalYearOf({ year: 2083, month: 3, day: 32 }), { start: 2082, label: '2082/83' });
  assert.deepEqual(cal.fiscalYearOf({ year: 2099, month: 4, day: 1 }), { start: 2099, label: '2099/00' });
});

test('a version 1 database is upgraded', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { SCHEMA_V1 } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jewelpro-upgrade-'));
  const raw = new DatabaseSync(path.join(dir, 'jewelpro.db'));
  raw.exec(SCHEMA_V1);
  raw.exec('PRAGMA user_version = 1');
  raw.prepare("INSERT INTO customers (name, created_at) VALUES ('Kept', '2026-01-01')").run();
  raw.close();
  const upgraded = new Store(dir);
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(upgraded.get('SELECT COUNT(*) AS n FROM bs_calendar_overrides').n, 0);
  assert.equal(upgraded.get("SELECT name FROM customers WHERE name = 'Kept'").name, 'Kept');
  assert.equal(upgraded.setting('date_display'), 'both');
  assert.ok(upgraded.get('SELECT COUNT(*) AS n FROM accounts').n > 20);
  assert.equal(upgraded.setting('accounting_backfill'), 'pending');
  upgraded.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
