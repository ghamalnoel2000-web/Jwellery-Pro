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
      method, headers: { 'Content-Type': 'application/json', 'X-JewelPro': '1', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

test('stock sheet: net weight, karigar on stock entry, sale shown, item history', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jewelpro-sheet-'));
  const { app, store } = createApp({ dataDir, logger: { error: () => {} } });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const owner = client(baseUrl);
  const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data; };

  ok(await owner('POST', '/api/auth/setup', { username: 'noel', full_name: 'Noel', password: 'GoldShop2083' }), 201);
  const pur = Object.fromEntries(ok(await owner('GET', '/api/purities')).map((p) => [p.name, p]));
  const cats = Object.fromEntries(ok(await owner('GET', '/api/categories')).map((c) => [c.name, c]));
  ok(await owner('PUT', '/api/rates', { unit: 'gram', rates: [{ purity_id: pur['22K'].id, sell: 15000, buy: 14000 }] }));
  const hari = ok(await owner('POST', '/api/karigars', { name: 'Hari Sunar' }), 201);
  const ram = ok(await owner('POST', '/api/karigars', { name: 'Ram BK' }), 201);

  // Net weight only, no name: the category is the name and gross equals net.
  const d = new Date(Date.now() - 5 * 86400000);
  const fiveDaysAgo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [chain] = ok(await owner('POST', '/api/products', {
    category_id: cats.Chain.id, purity_id: pur['22K'].id, net_g: 11.664, karigar_id: hari.id, received_date: fiveDaysAgo }), 201);
  assert.equal(chain.name, 'Chain');
  assert.equal(chain.gross_mg, 11664);
  assert.equal(chain.stone_mg, 0);
  assert.equal(chain.karigar_name, 'Hari Sunar');
  assert.equal(chain.received_at.slice(0, 10) <= fiveDaysAgo, true);

  // A piece with stones: gross and net; the difference is the stone weight.
  const [ring] = ok(await owner('POST', '/api/products', {
    category_id: cats.Ring.id, purity_id: pur['22K'].id, net_g: 4.5, gross_g: 5.2, karigar_id: ram.id }), 201);
  assert.equal(ring.stone_mg, 700);
  assert.equal(ring.name, 'Ring');
  assert.equal((await owner('POST', '/api/products', { category_id: cats.Ring.id, purity_id: pur['22K'].id, net_g: 5, gross_g: 4 })).status, 400);
  assert.equal((await owner('POST', '/api/products', { category_id: cats.Ring.id, purity_id: pur['22K'].id })).status, 400, 'net weight is required');
  assert.equal((await owner('POST', '/api/products', { category_id: cats.Ring.id, purity_id: pur['22K'].id, net_g: 1, received_date: '2099-01-01' })).status, 400);

  // It went into the register on the day it came into stock, from Hari Sunar.
  const reg = ok(await owner('GET', `/api/stock-register?date=${fiveDaysAgo}`));
  const inMove = reg.movements.find((m) => m.item_code === chain.item_code);
  assert.equal(inMove.party_name, 'Hari Sunar');

  // Cell edits: net on a piece without stones moves gross too; gross on a piece with stones keeps net.
  let edited = ok(await owner('PATCH', `/api/products/${chain.id}`, { net_g: 12 }));
  assert.equal(edited.gross_mg, 12000);
  edited = ok(await owner('PATCH', `/api/products/${ring.id}`, { gross_g: 5.5 }));
  assert.equal(edited.gross_mg - edited.stone_mg, 4500);
  edited = ok(await owner('PATCH', `/api/products/${ring.id}`, { karigar_id: hari.id, name: '' }));
  assert.equal(edited.karigar_name, 'Hari Sunar');
  assert.equal(edited.name, 'Ring');

  // Sold: the karigar window and the sheet show when and to whom.
  const customer = ok(await owner('POST', '/api/customers', { name: 'Sita Gurung', phone: '9845000000' }), 201);
  const pre = ok(await owner('POST', '/api/sales/preview', { customer_id: customer.id, items: [{ product_id: chain.id }] }));
  const sale = ok(await owner('POST', '/api/sales', { customer_id: customer.id, items: [{ product_id: chain.id }],
    payments: [{ method: 'cash', amount: pre.totals.net_payable / 100 }] }), 201);
  const sold = ok(await owner('GET', `/api/products/${chain.id}`));
  assert.equal(sold.invoice_no, sale.invoice_no);
  assert.equal(sold.sold_to, 'Sita Gurung');
  assert.ok(sold.sold_at);
  const hariWork = ok(await owner('GET', `/api/karigars/${hari.id}/work?from=2000-01-01`));
  assert.deepEqual(hariWork.pieces.map((p) => p.item_code).sort(), [chain.item_code, ring.item_code].sort());
  const soldPiece = hariWork.pieces.find((p) => p.id === chain.id);
  assert.equal(soldPiece.invoice_no, sale.invoice_no);
  assert.equal(soldPiece.net_mg, 12000);
  assert.equal(ok(await owner('GET', `/api/karigars/${ram.id}/work?from=2000-01-01`)).pieces.length, 0, 'moved to Hari');

  // History of the chain: in from Hari Sunar, weight corrected, sold on the invoice.
  const history = ok(await owner('GET', `/api/products/${chain.id}/history`));
  assert.deepEqual(history.events.map((e) => e.reason), ['manual', 'weight_corrected', 'sold']);
  assert.equal(history.events[0].party_name, 'Hari Sunar');
  assert.equal(history.events[2].ref_no, sale.invoice_no);
  assert.equal(history.events[2].customer_name, 'Sita Gurung');

  // The register book's category window names the karigar of a piece entered by hand.
  const today = new Date();
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const chainWindow = ok(await owner('GET', `/api/stock-register/category/${cats.Chain.id}?date=${todayText}&when=morning`));
  const inWindow = chainWindow.items.find((x) => x.item_code === chain.item_code);
  assert.equal(inWindow.from_name, 'Hari Sunar');

  // Staff: can pick a karigar and edit weights, cannot change cost or reach owner-only pieces.
  ok(await owner('POST', '/api/users', { username: 'gita', full_name: 'Gita', role: 'staff', password: 'Counter2083' }), 201);
  const staff = client(baseUrl);
  ok(await staff('POST', '/api/auth/login', { username: 'gita', password: 'Counter2083' }));
  ok(await staff('POST', '/api/auth/change-password', { current_password: 'Counter2083', new_password: 'Billing2083' }));
  assert.equal(ok(await staff('GET', '/api/karigar-names')).length, 2);
  ok(await staff('PATCH', `/api/products/${ring.id}`, { net_g: 4.4, cost: 99999 }));
  assert.equal(ok(await owner('GET', `/api/products/${ring.id}`)).cost_paisa, 0);
  const [locker] = ok(await owner('POST', '/api/products', { category_id: cats.Ring.id, purity_id: pur['22K'].id, net_g: 3, is_private: true }), 201);
  assert.equal((await staff('PATCH', `/api/products/${locker.id}`, { net_g: 2 })).status, 404);
  assert.equal((await staff('GET', `/api/products/${locker.id}/history`)).status, 404);
  assert.equal((await staff('GET', `/api/karigars/${hari.id}/work`)).status, 403);
});
