'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

function client(baseUrl) {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(baseUrl + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-JewelPro': '1', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

test('full shop workflow', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jewelpro-test-'));
  const { app, store } = createApp({ dataDir, logger: { error: () => {} } });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const owner = client(baseUrl);
  let r;

  await t.test('first run asks for the owner account', async () => {
    r = await owner('GET', '/api/auth/status');
    assert.equal(r.data.needs_setup, true);
    r = await owner('GET', '/api/products');
    assert.equal(r.status, 401);
    r = await owner('POST', '/api/auth/setup', { username: 'ram', full_name: 'Ram Shrestha', password: 'short' });
    assert.equal(r.status, 400);
    r = await owner('POST', '/api/auth/setup', { username: 'ram', full_name: 'Ram Shrestha', password: 'GoldShop2083' });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.role, 'owner');
    r = await owner('POST', '/api/auth/setup', { username: 'x', full_name: 'X', password: 'Another2083' });
    assert.equal(r.status, 403, 'setup cannot run twice');
  });

  await t.test('requests without the JewelPro header are blocked', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  let purities;
  await t.test('owner sets up charges, tax and rates', async () => {
    r = await owner('GET', '/api/charge-profiles');
    const standard = r.data.find((p) => p.name === 'Standard');
    r = await owner('PUT', `/api/charge-profiles/${standard.id}`, {
      name: 'Standard', basis: 'net_wastage', wastage_mode: 'percent', wastage_value: 5,
      making_mode: 'per_gram', making_value: 800, making_weight: 'net', min_making: 0
    });
    assert.equal(r.status, 200);

    r = await owner('POST', '/api/tax-rules', { name: 'Test tax', rate_percent: 10, applies_to: 'making', verified_note: 'test only' });
    assert.equal(r.status, 201);

    r = await owner('GET', '/api/purities');
    purities = Object.fromEntries(r.data.map((p) => [p.name, p]));
    r = await owner('PUT', '/api/rates', {
      unit: 'gram',
      rates: [{ purity_id: purities['22K'].id, sell: 15000, buy: 14000 }, { purity_id: purities['24K'].id, sell: 16000, buy: 15500 }]
    });
    assert.equal(r.status, 200);
    r = await owner('GET', '/api/rates');
    assert.equal(r.data.rates.find((x) => x.purity_name === '22K').sell_per_gram, 1500000);

    r = await owner('PUT', '/api/rates', { unit: 'tola', rates: [{ purity_id: purities['18K'].id, sell: 116640, buy: 100000 }] });
    r = await owner('GET', '/api/rates');
    assert.equal(Math.round(r.data.rates.find((x) => x.purity_name === '18K').sell_per_gram), 1000000);
  });

  let ring;
  let chain;
  await t.test('products get item codes', async () => {
    r = await owner('GET', '/api/categories');
    const cats = Object.fromEntries(r.data.map((c) => [c.name, c]));
    r = await owner('POST', '/api/products', {
      name: 'Ladies ring', category_id: cats.Ring.id, purity_id: purities['22K'].id,
      gross_g: 10.5, stone_g: 0.5, stone_amount: 3000, huid: 'AB1234'
    });
    assert.equal(r.status, 201);
    ring = r.data[0];
    assert.equal(ring.item_code, 'RG00001');
    assert.equal(ring.gross_mg, 10500);

    r = await owner('POST', '/api/products', { name: 'Chain', category_id: cats.Chain.id, purity_id: purities['22K'].id, gross_g: 5, copies: 2 });
    assert.equal(r.data.length, 2);
    chain = r.data[0];
    assert.equal(r.data[1].item_code, 'CH00002');

    r = await owner('POST', '/api/products', { name: 'Bad', category_id: cats.Ring.id, purity_id: purities['22K'].id, gross_g: 1, stone_g: 1 });
    assert.equal(r.status, 400);

    r = await owner('GET', '/api/products/by-code/rg00001');
    assert.equal(r.data.id, ring.id, 'barcode lookup ignores case');
  });

  let customer;
  await t.test('customers', async () => {
    r = await owner('POST', '/api/customers', { name: 'Sita Gurung', phone: '9800000000' });
    assert.equal(r.status, 201);
    customer = r.data;
  });

  let sale;
  await t.test('preview matches the saved bill', async () => {
    const bill = {
      customer_id: customer.id,
      items: [{ product_id: ring.id }],
      discount: 500,
      exchange: [{ description: 'Old bangle', purity_id: purities['22K'].id, gross_g: 2, less_g: 0, refining_percent: 5 }],
      payments: [{ method: 'cash', amount: 100000 }]
    };
    const preview = await owner('POST', '/api/sales/preview', bill);
    assert.equal(preview.status, 200);
    const line = preview.data.items[0];
    assert.equal(line.metal, 15750000);
    assert.equal(line.making, 800000);
    assert.equal(line.stones, 300000);
    assert.equal(preview.data.totals.subtotal, 16850000);
    assert.equal(preview.data.totals.discount, 50000);
    assert.equal(preview.data.exchange[0].amount, 2660000); // 1.9 g x Rs 14,000
    assert.ok(preview.data.totals.tax > 0);

    r = await owner('POST', '/api/sales', bill);
    assert.equal(r.status, 201);
    sale = r.data;
    assert.equal(sale.invoice_no, 'INV-000001');
    assert.equal(sale.net_payable_paisa, preview.data.totals.net_payable);
    assert.equal(sale.paid_paisa, 10000000);
    assert.equal(sale.due_paisa, sale.net_payable_paisa - 10000000);
    assert.equal(sale.net_payable_paisa % 100, 0, 'rounded to the rupee');

    r = await owner('GET', `/api/products/${ring.id}`);
    assert.equal(r.data.status, 'sold');
  });

  await t.test('a sold item cannot be sold again', async () => {
    r = await owner('POST', '/api/sales', { items: [{ product_id: ring.id }], payments: [] });
    assert.equal(r.status, 422);
    assert.match(r.data.error, /not in stock/);
  });

  await t.test('walk-in customers must pay in full', async () => {
    r = await owner('POST', '/api/sales', { items: [{ product_id: chain.id }], payments: [{ method: 'cash', amount: 10 }] });
    assert.equal(r.status, 422);
    assert.match(r.data.error, /walk-in/);
  });

  await t.test('receiving the balance', async () => {
    r = await owner('POST', `/api/sales/${sale.id}/payments`, { method: 'qr', amount: (sale.due_paisa + 100) / 100 });
    assert.equal(r.status, 422, 'cannot overpay');
    r = await owner('POST', `/api/sales/${sale.id}/payments`, { method: 'qr', amount: sale.due_paisa / 100, reference: 'QR-1' });
    assert.equal(r.status, 200);
    assert.equal(r.data.due_paisa, 0);
  });

  const cashier = client(baseUrl);
  await t.test('staff permissions and forced password change', async () => {
    r = await owner('POST', '/api/users', { username: 'hari', full_name: 'Hari', role: 'staff', password: 'Counter2083' });
    assert.equal(r.status, 201);
    r = await cashier('POST', '/api/auth/login', { username: 'hari', password: 'Counter2083' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.must_change_password, true);
    r = await cashier('GET', '/api/products');
    assert.equal(r.status, 403, 'blocked until password changed');
    r = await cashier('POST', '/api/auth/change-password', { current_password: 'Counter2083', new_password: 'Billing2083' });
    assert.equal(r.status, 200);
    r = await cashier('GET', '/api/products');
    assert.equal(r.status, 200);
    r = await cashier('PUT', '/api/settings', { shop_name: 'Hacked' });
    assert.equal(r.status, 403);
    r = await cashier('POST', `/api/sales/${sale.id}/cancel`, { reason: 'test' });
    assert.equal(r.status, 403);
    r = await cashier('GET', '/api/audit');
    assert.equal(r.status, 403);
    r = await cashier('GET', '/api/users');
    assert.equal(r.status, 403);
    r = await cashier('POST', '/api/sales/preview', { items: [{ product_id: chain.id }], discount: 5000 });
    assert.equal(r.status, 403, 'discount above the staff limit');
  });

  await t.test('cancelling returns items to stock', async () => {
    r = await owner('POST', `/api/sales/${sale.id}/cancel`, { reason: '' });
    assert.equal(r.status, 400, 'reason required');
    r = await owner('POST', `/api/sales/${sale.id}/cancel`, { reason: 'Customer returned the ring' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'cancelled');
    r = await owner('GET', `/api/products/${ring.id}`);
    assert.equal(r.data.status, 'in_stock');
  });

  await t.test('lockout after five wrong passwords', async () => {
    const guest = client(baseUrl);
    for (let i = 0; i < 5; i += 1) await guest('POST', '/api/auth/login', { username: 'hari', password: `Wrong${i}pass` });
    r = await guest('POST', '/api/auth/login', { username: 'hari', password: 'Billing2083' });
    assert.equal(r.status, 401);
    assert.match(r.data.error, /locked/);
  });

  await t.test('reports, audit log and backup', async () => {
    r = await owner('GET', '/api/reports/dashboard');
    assert.equal(r.status, 200);
    r = await owner('GET', '/api/reports/sales');
    assert.equal(r.data.cancelled, 1);
    r = await owner('GET', '/api/reports/stock');
    assert.equal(r.data.byPurity[0].pieces, 3);
    r = await owner('GET', '/api/audit');
    assert.ok(r.data.some((a) => a.action === 'cancel' && a.entity === 'sale'));
    assert.throws(() => store.run('DELETE FROM audit_log'), /cannot be changed/);

    r = await owner('POST', '/api/backups');
    assert.equal(r.status, 201);
    r = await owner('GET', `/api/backups/${r.data.name}`);
    assert.equal(r.status, 200);
    r = await owner('GET', '/api/backups/..%2Fjewelpro.db');
    assert.equal(r.status, 404);
  });

  await t.test('Nepali calendar corrections', async () => {
    const days = [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30];
    r = await owner('GET', '/api/calendar');
    assert.equal(r.data.verified_until, 2083);
    r = await owner('PUT', '/api/calendar/2083', { month_days: days });
    assert.equal(r.status, 422, 'verified years are locked');
    r = await owner('PUT', '/api/calendar/2095', { month_days: days });
    assert.equal(r.status, 422, 'no gaps allowed');
    r = await owner('PUT', '/api/calendar/2084', { month_days: [30, 30] });
    assert.equal(r.status, 400);
    r = await cashier('PUT', '/api/calendar/2084', { month_days: days });
    assert.equal(r.status, 403);
    r = await owner('PUT', '/api/calendar/2084', { month_days: days, note: 'Official patro' });
    assert.equal(r.status, 200);
    r = await cashier('GET', '/api/calendar');
    assert.deepEqual(r.data.overrides['2084'], days);
    r = await owner('DELETE', '/api/calendar/2084');
    assert.equal(r.status, 200);
    r = await owner('PUT', '/api/settings', { date_display: 'sometimes' });
    assert.equal(r.status, 400);
    r = await owner('PUT', '/api/settings', { date_display: 'bs' });
    assert.equal(r.data.date_display, 'bs');
  });

  await t.test('posting existing data after an upgrade gives the same books', async () => {
    const before = (await owner('GET', '/api/accounting/trial-balance')).data;
    assert.equal(before.balanced, true);
    // Pretend accounting did not exist yet: remove all postings, then run the one-time upgrade step.
    store.db.exec(`DROP TRIGGER journal_entries_no_delete; DROP TRIGGER journal_lines_no_delete;
      DELETE FROM journal_lines; DELETE FROM journal_entries; DELETE FROM metal_ledger;
      UPDATE settings SET value = 'pending' WHERE key = 'accounting_backfill';`);
    require('../src/backfill').runAccountingBackfill(store, { log: () => {} });
    const after = (await owner('GET', '/api/accounting/trial-balance')).data;
    assert.deepEqual(after.rows, before.rows);
  });

  await t.test('last owner cannot be removed', async () => {
    r = await owner('GET', '/api/users');
    const ram = r.data.find((u) => u.username === 'ram');
    r = await owner('PUT', `/api/users/${ram.id}`, { full_name: 'Ram', role: 'staff', is_active: true });
    assert.equal(r.status, 422);
  });
});
