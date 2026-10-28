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
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

test('purchases, karigars, orders, repairs and accounting', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jewelpro-biz-'));
  const { app, store } = createApp({ dataDir, logger: { error: () => {} } });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const owner = client(baseUrl);
  let r;

  const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data; };
  const booksBalance = async () => {
    const tb = ok(await owner('GET', '/api/accounting/trial-balance'));
    assert.equal(tb.balanced, true, 'trial balance must balance');
    const bs = ok(await owner('GET', '/api/accounting/balance-sheet'));
    assert.equal(bs.total_assets_paisa, bs.total_liabilities_equity_paisa, 'balance sheet must balance');
    return { tb, bs };
  };
  const accountBalance = async (code) => ok(await owner('GET', '/api/accounts')).find((a) => a.code === code).balance_paisa;
  const metalGold = async () => ok(await owner('GET', '/api/metal')).metals.find((m) => m.code === 'AU');

  ok(await owner('POST', '/api/auth/setup', { username: 'ram', full_name: 'Ram', password: 'GoldShop2083' }), 201);
  const purities = Object.fromEntries(ok(await owner('GET', '/api/purities')).map((p) => [p.name, p]));
  const cats = Object.fromEntries(ok(await owner('GET', '/api/categories')).map((c) => [c.name, c]));
  ok(await owner('PUT', '/api/rates', { unit: 'gram', rates: [
    { purity_id: purities['22K'].id, sell: 15000, buy: 14000 }, { purity_id: purities['24K'].id, sell: 16000, buy: 15500 }] }));
  const profile = ok(await owner('GET', '/api/charge-profiles'))[0];
  ok(await owner('PUT', `/api/charge-profiles/${profile.id}`, { ...profile, making_value: 800, min_making: 0 }));

  let supplier;
  let purchase;
  await t.test('purchase of bullion and a ready piece', async () => {
    supplier = ok(await owner('POST', '/api/suppliers', { name: 'Kathmandu Bullion' }), 201);
    purchase = ok(await owner('POST', '/api/purchases', {
      supplier_id: supplier.id, supplier_bill_no: 'KB-77',
      lines: [
        { kind: 'metal', purity_id: purities['24K'].id, gross_g: 20, amount: 300000 },
        { kind: 'piece', name: 'Bought ring', category_id: cats.Ring.id, purity_id: purities['22K'].id, gross_g: 5, amount: 70000 }
      ],
      payment: { method: 'bank', amount: 100000, reference: 'TXN1' }
    }), 201);
    assert.equal(purchase.total_paisa, 37000000);
    assert.equal(purchase.lines.find((l) => l.kind === 'piece').item_code, 'RG00001');
    const gold = await metalGold();
    assert.equal(gold.fine_mg, 19980);
    assert.equal(gold.value_paisa, 30000000);
    const suppliers = ok(await owner('GET', '/api/suppliers'));
    assert.equal(suppliers[0].balance_paisa, 27000000);
    assert.equal(await accountBalance('1200'), 7000000);
    await booksBalance();
  });

  let karigar;
  let job;
  await t.test('karigar: issue gold, receive a piece, pay labour', async () => {
    karigar = ok(await owner('POST', '/api/karigars', { name: 'Hari Sunar', phone: '9841000000' }), 201);
    r = await owner('POST', '/api/karigar-jobs', {
      karigar_id: karigar.id, description: 'Necklace', due_date: '2026-10-05', issues: [{ purity_id: purities['24K'].id, gross_g: 50 }] });
    assert.equal(r.status, 422, 'cannot issue more than metal stock');
    job = ok(await owner('POST', '/api/karigar-jobs', {
      karigar_id: karigar.id, description: 'Necklace', due_date: '2026-10-05', issues: [{ purity_id: purities['24K'].id, gross_g: 10 }] }), 201);
    assert.equal(job.issued_fine_mg, 9990);
    assert.equal(job.issued_value_paisa, 15000000);
    assert.equal((await metalGold()).fine_mg, 9990);

    r = await owner('POST', `/api/karigar-jobs/${job.id}/receive`, {
      pieces: [{ name: 'Necklace', category_id: cats.Necklace.id, purity_id: purities['22K'].id, gross_g: 20 }] });
    assert.equal(r.status, 422, 'pieces cannot contain more gold than was issued');

    job = ok(await owner('POST', `/api/karigar-jobs/${job.id}/receive`, {
      pieces: [{ name: 'Necklace', category_id: cats.Necklace.id, purity_id: purities['22K'].id, gross_g: 10.5 }],
      returned: [{ purity_id: purities['24K'].id, gross_g: 0.1 }],
      wastage_g: 0.2, labour: 5000, close: false
    }));
    assert.equal(job.consumed_fine_mg, 9618 + 100 + 200);
    assert.equal(job.pieces.length, 1);
    assert.ok(job.pieces[0].cost_paisa > 14000000, 'piece cost includes gold, wastage and labour');
    const karigars = ok(await owner('GET', '/api/karigars'));
    assert.equal(karigars[0].gold_balance_mg, 9990 - 9918);
    assert.equal(karigars[0].payable_paisa, 500000);
    ok(await owner('POST', `/api/karigars/${karigar.id}/payments`, { method: 'cash', amount: 2000 }), 201);
    assert.equal(ok(await owner('GET', '/api/karigars'))[0].payable_paisa, 300000);
    await booksBalance();
  });

  let customer;
  await t.test('buying old gold from a customer', async () => {
    customer = ok(await owner('POST', '/api/customers', { name: 'Sita Gurung', phone: '9845000000' }), 201);
    const walkIn = ok(await owner('GET', '/api/customers')).find((c) => c.is_walkin);
    r = await owner('POST', '/api/old-gold-purchases', { customer_id: walkIn.id, lines: [{ purity_id: purities['22K'].id, gross_g: 5 }], payment: { method: 'cash' } });
    assert.equal(r.status, 422, 'must record who sold it');
    const v = ok(await owner('POST', '/api/old-gold-purchases', {
      customer_id: customer.id, lines: [{ description: 'Old chain', purity_id: purities['22K'].id, gross_g: 5, refining_percent: 5 }],
      payment: { method: 'cash' } }), 201);
    assert.equal(v.total_paisa, 6650000);
    assert.equal((await metalGold()).fine_mg, 9990 + 100 + 4580);
    await booksBalance();
  });

  let order;
  let sale;
  await t.test('order advance used on the bill', async () => {
    order = ok(await owner('POST', '/api/orders', {
      customer_id: customer.id, description: 'Necklace as per design', due_date: '2026-10-10',
      advance: { method: 'cash', amount: 20000 } }), 201);
    assert.equal(order.available_paisa, 2000000);
    const necklace = job.pieces[0];
    const preview = ok(await owner('POST', '/api/sales/preview', {
      customer_id: customer.id, items: [{ product_id: necklace.id }], order_id: order.id }));
    assert.equal(preview.totals.advance, 2000000);
    sale = ok(await owner('POST', '/api/sales', {
      customer_id: customer.id, items: [{ product_id: necklace.id }], order_id: order.id, use_advance: 20000,
      payments: [{ method: 'cash', amount: 100000 }] }), 201);
    assert.equal(sale.advance_paisa, 2000000);
    assert.equal(sale.paid_paisa, 12000000);
    assert.equal(ok(await owner('GET', `/api/orders/${order.id}`)).status, 'delivered');
    assert.equal(await accountBalance('2100'), 0, 'advance used up');
    assert.equal(await accountBalance('1100'), sale.due_paisa, 'customer dues match');
    assert.equal(await accountBalance('5000'), necklace.cost_paisa, 'cost of goods sold = piece cost');
    await booksBalance();
  });

  await t.test('repair job card', async () => {
    const rep = ok(await owner('POST', '/api/repairs', {
      customer_id: customer.id, item_description: 'Bangle, fix clasp', weight_in_g: 12.345, promised_date: '2026-10-01', estimate: 500 }), 201);
    ok(await owner('POST', `/api/repairs/${rep.id}/status`, { status: 'ready' }));
    const done = ok(await owner('POST', `/api/repairs/${rep.id}/deliver`, { weight_out_g: 12.35, charge: 500, method: 'cash' }));
    assert.equal(done.status, 'delivered');
    assert.equal(await accountBalance('4100'), 50000);
  });

  await t.test('expenses, manual journal and cash balance', async () => {
    const rent = ok(await owner('GET', '/api/accounts')).find((a) => a.code === '6000');
    ok(await owner('POST', '/api/expenses', { account_id: rent.id, method: 'cash', amount: 10000, note: 'Asoj rent' }), 201);
    const cash = ok(await owner('GET', '/api/accounts')).find((a) => a.code === '1000');
    const capital = ok(await owner('GET', '/api/accounts')).find((a) => a.code === '3000');
    r = await owner('POST', '/api/journal', { narration: 'Bad', lines: [{ account_id: cash.id, debit: 100 }, { account_id: capital.id, credit: 90 }] });
    assert.equal(r.status, 422);
    ok(await owner('POST', '/api/journal', { narration: 'Capital introduced',
      lines: [{ account_id: cash.id, debit: 500000 }, { account_id: capital.id, credit: 500000 }] }), 201);
    // cash: -2,000 karigar -66,500 old gold +20,000 advance +100,000 sale +500 repair -10,000 rent +500,000 capital
    assert.equal(await accountBalance('1000'), (-2000 - 66500 + 20000 + 100000 + 500 - 10000 + 500000) * 100);
    const pl = ok(await owner('GET', '/api/accounting/profit-loss'));
    assert.equal(pl.net_profit_paisa, pl.income_paisa - pl.expenses_paisa);
    assert.ok(pl.gross_profit_paisa > 0);
    const daybook = ok(await owner('GET', '/api/accounting/daybook'));
    for (const e of daybook) {
      assert.equal(e.lines.reduce((a, l) => a + l.debit_paisa, 0), e.lines.reduce((a, l) => a + l.credit_paisa, 0), `${e.entry_no} balances`);
    }
    await booksBalance();
  });

  await t.test('cancellations reverse cleanly', async () => {
    ok(await owner('POST', `/api/sales/${sale.id}/cancel`, { reason: 'Customer changed mind' }));
    const o = ok(await owner('GET', `/api/orders/${order.id}`));
    assert.equal(o.status, 'ready');
    assert.equal(o.available_paisa, 2000000);
    assert.equal(await accountBalance('2100'), 2000000, 'advance is owed to the customer again');
    assert.equal(await accountBalance('5000'), 0);
    r = await owner('POST', `/api/purchases/${purchase.id}/cancel`, { reason: 'Test' });
    assert.equal(r.status, 422, 'bullion already sent to the karigar');
    await booksBalance();
  });

  await t.test('audit lock and fiscal-year invoice numbers', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const lockText = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    ok(await owner('PUT', '/api/settings', { books_locked_until: lockText, invoice_numbering: 'fiscal_year' }));
    const rent = ok(await owner('GET', '/api/accounts')).find((a) => a.code === '6000');
    r = await owner('POST', '/api/expenses', { account_id: rent.id, method: 'cash', amount: 100, note: 'Late entry', date: lockText });
    assert.equal(r.status, 422);
    assert.match(r.data.error, /locked/);
    r = await owner('PUT', '/api/settings', { books_locked_until: '2099-01-01' });
    assert.equal(r.status, 400, 'cannot lock today or the future');
    const bought = ok(await owner('GET', '/api/products')).find((p) => p.item_code === 'RG00001');
    const fySale = ok(await owner('POST', '/api/sales', { items: [{ product_id: bought.id }], payments: [] }), 422);
    assert.match(fySale.error, /walk-in/);
    const s2 = ok(await owner('POST', '/api/sales/preview', { items: [{ product_id: bought.id }] }));
    const full = ok(await owner('POST', '/api/sales', { items: [{ product_id: bought.id }], payments: [{ method: 'cash', amount: s2.totals.net_payable / 100 }] }), 201);
    assert.match(full.invoice_no, /^INV-\d{4}\/\d{2}-00001$/);
    await booksBalance();
  });

  await t.test('staff: shop work only, never owner-only stock, costs or accounts', async () => {
    ok(await owner('POST', '/api/users', { username: 'gita', full_name: 'Gita', role: 'staff', password: 'Counter2083' }), 201);
    const staff = client(baseUrl);
    ok(await staff('POST', '/api/auth/login', { username: 'gita', password: 'Counter2083' }));
    ok(await staff('POST', '/api/auth/change-password', { current_password: 'Counter2083', new_password: 'Billing2083' }));

    // The owner keeps one piece outside the shop.
    const hidden = ok(await owner('POST', '/api/products', {
      name: 'Locker necklace', category_id: cats.Necklace.id, purity_id: purities['22K'].id, gross_g: 30, cost: 400000,
      is_private: true, location: 'Bank locker' }), 201)[0];
    assert.equal(hidden.is_private, 1);
    assert.equal(hidden.location, 'Bank locker');
    const ownerCount = ok(await owner('GET', '/api/reports/dashboard')).stock.pieces;

    // Staff cannot find it anywhere.
    assert.ok(!ok(await staff('GET', '/api/products')).some((p) => p.id === hidden.id), 'not in stock list');
    assert.ok(!ok(await staff('GET', '/api/products?status=all&q=Locker')).length, 'not in search');
    assert.equal((await staff('GET', `/api/products/${hidden.id}`)).status, 404);
    assert.equal((await staff('GET', `/api/products/by-code/${hidden.item_code}`)).status, 404);
    assert.equal((await staff('POST', '/api/sales/preview', { items: [{ product_id: hidden.id }] })).status, 422, 'cannot bill it by number');
    assert.equal((await staff('PUT', `/api/products/${hidden.id}`, { name: 'x', category_id: cats.Necklace.id, purity_id: purities['22K'].id, gross_g: 1 })).status, 404);
    assert.equal(ok(await staff('GET', '/api/reports/dashboard')).stock.pieces, ownerCount - 1, 'dashboard counts shop stock only');
    const necklaceCat = ok(await staff('GET', '/api/categories')).find((c) => c.id === cats.Necklace.id);
    const ownerCat = ok(await owner('GET', '/api/categories')).find((c) => c.id === cats.Necklace.id);
    assert.equal(necklaceCat.in_stock, ownerCat.in_stock - 1);

    // No cost prices, supplier balances or accounts.
    const shopItems = ok(await staff('GET', '/api/products'));
    assert.ok(shopItems.length && shopItems.every((p) => !('cost_paisa' in p)), 'no cost price in the stock list');
    const preview = ok(await staff('POST', '/api/sales/preview', { items: [{ product_id: shopItems[0].id }] }));
    assert.ok(!('cost' in preview.totals), 'no cost in the bill preview');
    assert.ok(ok(await staff('GET', '/api/suppliers')).every((x) => x.balance_paisa === undefined));
    for (const url of [`/api/suppliers/${supplier.id}/statement`, '/api/accounting/trial-balance', '/api/accounts', '/api/reports/sales',
      '/api/reports/stock', '/api/users', '/api/audit', '/api/metal', '/api/karigars', '/api/orders', '/api/repairs', '/api/backups']) {
      assert.equal((await staff('GET', url)).status, 403, url);
    }
    assert.equal((await staff('POST', `/api/purchases/${purchase.id}/cancel`, { reason: 'x' })).status, 403);
    assert.equal((await staff('POST', `/api/sales/${sale.id}/cancel`, { reason: 'x' })).status, 403);
    assert.equal((await staff('POST', `/api/products/${shopItems[0].id}/remove`, { reason: 'x' })).status, 403);
    assert.equal((await staff('PUT', '/api/settings', { shop_name: 'x' })).status, 403);

    // What staff can do: rates, stock, categories, purchases, customers, bills.
    ok(await staff('PUT', '/api/rates', { unit: 'gram', rates: [{ purity_id: purities['22K'].id, sell: 15100, buy: 14100 }] }));
    const added = ok(await staff('POST', '/api/products', {
      name: 'Staff ring', category_id: cats.Ring.id, purity_id: purities['22K'].id, gross_g: 4, cost: 99999, is_private: true }), 201)[0];
    assert.equal(added.is_private, 0, 'staff cannot hide stock');
    assert.equal(ok(await owner('GET', `/api/products/${added.id}`)).cost_paisa, 0, 'staff cannot set cost');
    const renamed = ok(await staff('PUT', `/api/categories/${cats.Ring.id}`, { name: 'Rings and bands', prefix: 'ZZ' }));
    assert.equal(renamed.name, 'Rings and bands');
    assert.equal(renamed.prefix, cats.Ring.prefix, 'staff cannot change the code prefix');
    const newCat = ok(await staff('POST', '/api/categories', { name: 'Mangalsutra' }), 201);
    assert.ok(newCat.prefix.length >= 2);
    ok(await staff('POST', '/api/customers', { name: 'Walk Customer', phone: '9800000000' }), 201);
    const p2 = ok(await staff('POST', '/api/purchases', { supplier_id: supplier.id,
      lines: [{ kind: 'piece', name: 'Bought chain', category_id: newCat.id, purity_id: purities['22K'].id, gross_g: 8, amount: 110000 }] }), 201);
    assert.ok(p2.lines[0].item_code.startsWith(newCat.prefix));

    // A purchased piece the owner later moves to owner-only stock disappears from the staff view of that purchase.
    const piece = ok(await owner('GET', `/api/products/${p2.lines[0].product_id}`));
    ok(await owner('PUT', `/api/products/${piece.id}`, { ...piece, gross_g: 8, cost: 1100, is_private: true, location: 'Home safe' }));
    const seen = ok(await staff('GET', `/api/purchases/${p2.id}`));
    assert.equal(seen.lines[0].item_code, null);
    assert.equal(seen.lines[0].product_id, null);
    await booksBalance();
  });
});
