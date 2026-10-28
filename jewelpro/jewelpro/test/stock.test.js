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

test('daily stock register and karigar work by weight', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jewelpro-stock-'));
  const { app, store } = createApp({ dataDir, logger: { error: () => {} } });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const owner = client(baseUrl);
  const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data; };

  ok(await owner('POST', '/api/auth/setup', { username: 'noel', full_name: 'Noel', password: 'GoldShop2083' }), 201);
  const pur = Object.fromEntries(ok(await owner('GET', '/api/purities')).map((p) => [p.name, p]));
  const cats = Object.fromEntries(ok(await owner('GET', '/api/categories')).map((c) => [c.name, c]));
  ok(await owner('PUT', '/api/rates', { unit: 'gram', rates: [
    { purity_id: pur['22K'].id, sell: 15000, buy: 14000 }, { purity_id: pur['24K'].id, sell: 16000, buy: 15500 }] }));
  const ring = (name, g) => ({ name, category_id: cats.Ring.id, purity_id: pur['22K'].id, gross_g: g, cost: 1000 });

  /** Every row must add up, and today's closing must equal what is actually in the shop. */
  const checkRegister = async () => {
    const reg = ok(await owner('GET', '/api/stock-register'));
    for (const r of reg.rows) {
      assert.equal(r.opening.qty + r.total_in.qty - r.total_out.qty, r.closing.qty, `${r.name} adds up`);
    }
    assert.equal(reg.system_check.ok, true, JSON.stringify(reg.system_check.problems));
    const actual = ok(await owner('GET', '/api/products?place=shop'));
    assert.equal(reg.totals.closing.qty, actual.length);
    assert.equal(reg.totals.closing.gross_mg, actual.reduce((a, p) => a + p.gross_mg, 0));
    return reg;
  };
  const row = (reg, name) => reg.rows.find((r) => r.name === name);

  const added = [];
  for (const [n, g] of [['R1', 4], ['R2', 5], ['R3', 6]]) added.push(ok(await owner('POST', '/api/products', ring(n, g)), 201)[0]);
  let reg = await checkRegister();
  assert.equal(row(reg, 'Ring').in.manual.qty, 3);
  assert.equal(row(reg, 'Ring').closing.qty, 3);
  assert.equal(row(reg, 'Ring').closing.gross_mg, 15000);

  const supplier = ok(await owner('POST', '/api/suppliers', { name: 'Kathmandu Bullion' }), 201);
  ok(await owner('POST', '/api/purchases', { supplier_id: supplier.id, lines: [
    { kind: 'piece', name: 'P1', category_id: cats.Ring.id, purity_id: pur['22K'].id, gross_g: 3, amount: 45000 },
    { kind: 'piece', name: 'P2', category_id: cats.Ring.id, purity_id: pur['22K'].id, gross_g: 3, amount: 45000 },
    { kind: 'metal', purity_id: pur['24K'].id, gross_g: 20, amount: 300000 }] }), 201);

  const karigar = ok(await owner('POST', '/api/karigars', { name: 'Hari Sunar' }), 201);
  const job = ok(await owner('POST', '/api/karigar-jobs', { karigar_id: karigar.id, description: 'Chains', due_date: '2026-10-05',
    issues: [{ purity_id: pur['24K'].id, gross_g: 10 }] }), 201);
  const received = ok(await owner('POST', `/api/karigar-jobs/${job.id}/receive`, {
    pieces: [
      { name: 'Chain A', category_id: cats.Chain.id, purity_id: pur['22K'].id, gross_g: 4 },
      { name: 'Chain B', category_id: cats.Chain.id, purity_id: pur['22K'].id, gross_g: 5.5 }],
    wastage_g: 0.2 }));

  reg = await checkRegister();
  assert.equal(row(reg, 'Ring').in.purchase.qty, 2);
  assert.equal(row(reg, 'Chain').in.karigar.qty, 2);
  const fromKarigar = reg.movements.filter((m) => m.reason === 'karigar');
  assert.ok(fromKarigar.every((m) => m.party_name === 'Hari Sunar' && m.ref_no === job.job_no), 'shows which karigar and job');
  assert.ok(reg.movements.filter((m) => m.reason === 'purchase').every((m) => m.party_name === 'Kathmandu Bullion'));

  // Locker: out and back in.
  const r1 = ok(await owner('GET', `/api/products/${added[0].id}`));
  const edit = (p, extra) => ({ ...p, gross_g: p.gross_mg / 1000, stone_g: p.stone_mg / 1000, other_less_g: p.other_less_mg / 1000, cost: 1000, ...extra });
  ok(await owner('PUT', `/api/products/${r1.id}`, edit(r1, { is_private: true, location: 'Bank locker' })));
  reg = await checkRegister();
  assert.equal(row(reg, 'Ring').out.to_locker.qty, 1);
  ok(await owner('PUT', `/api/products/${r1.id}`, edit(r1, { is_private: false })));
  reg = await checkRegister();
  assert.equal(row(reg, 'Ring').in.from_locker.qty, 1);

  // Sell, cancel, sell again, remove, change category, correct weight.
  const pre1 = ok(await owner('POST', '/api/sales/preview', { items: [{ product_id: added[1].id }] }));
  const sale1 = ok(await owner('POST', '/api/sales', { items: [{ product_id: added[1].id }], payments: [{ method: 'cash', amount: pre1.totals.net_payable / 100 }] }), 201);
  ok(await owner('POST', `/api/sales/${sale1.id}/cancel`, { reason: 'Changed mind' }));
  const pre = ok(await owner('POST', '/api/sales/preview', { items: [{ product_id: added[1].id }] }));
  ok(await owner('POST', '/api/sales', { items: [{ product_id: added[1].id }], payments: [{ method: 'cash', amount: pre.totals.net_payable / 100 }] }), 201);
  ok(await owner('POST', `/api/products/${added[2].id}/remove`, { reason: 'Melted' }));
  const r1b = ok(await owner('GET', `/api/products/${r1.id}`));
  ok(await owner('PUT', `/api/products/${r1.id}`, edit(r1b, { category_id: cats.Chain.id })));
  const chainA = ok(await owner('GET', `/api/products/${received.pieces[0].id}`));
  ok(await owner('PUT', `/api/products/${chainA.id}`, edit(chainA, { gross_g: 4.05 })));

  reg = await checkRegister();
  const rings = row(reg, 'Ring');
  assert.equal(rings.out.sold.qty, 2, 'sold twice (once cancelled)');
  assert.equal(rings.in.sale_cancelled.qty, 1);
  assert.equal(rings.out.removed.qty, 1);
  assert.equal(rings.out.category_out.qty, 1);
  assert.equal(row(reg, 'Chain').in.category_in.qty, 1);
  assert.equal(rings.closing.qty, 2, 'P1 and P2 left');
  assert.equal(row(reg, 'Chain').closing.qty, 3);
  assert.equal(row(reg, 'Chain').weight_corrected_mg, 50);

  // Physical count: a mismatch is shown.
  const counted = ok(await owner('POST', '/api/stock-register/count', { counts: [
    { category_id: cats.Ring.id, qty: 2 }, { category_id: cats.Chain.id, qty: 2, gross_g: 9.5 }], note: 'Evening count' }));
  assert.equal(row(counted, 'Ring').count.difference, 0);
  assert.equal(row(counted, 'Chain').count.difference, -1);
  assert.equal(counted.counted, true);

  // The last 90 days: today closes at the shop total.
  const days = ok(await owner('GET', '/api/stock-register/days'));
  assert.equal(days.length, 90);
  assert.equal(days[0].closing_qty, 5);
  assert.equal(days[0].in_qty - days[0].sold_qty - days[0].other_out_qty, 5);
  assert.equal(days[0].counted_qty, 4);

  // Karigar account by weight.
  const work = ok(await owner('GET', `/api/karigars/${karigar.id}/work`));
  assert.equal(work.piece_totals.pieces, 2);
  assert.equal(work.piece_totals.gross_mg, 9550, 'current weights');
  assert.equal(work.by_category[0].category, 'Chain');
  assert.equal(work.gold.totals.given_mg, 9990);
  assert.equal(work.gold.closing_mg, 9990 - received.consumed_fine_mg);
  assert.equal(work.gold.entries.length, 2);

  // Staff cannot open the register.
  ok(await owner('POST', '/api/users', { username: 'gita', full_name: 'Gita', role: 'staff', password: 'Counter2083' }), 201);
  const staff = client(baseUrl);
  ok(await staff('POST', '/api/auth/login', { username: 'gita', password: 'Counter2083' }));
  ok(await staff('POST', '/api/auth/change-password', { current_password: 'Counter2083', new_password: 'Billing2083' }));
  assert.equal((await staff('GET', '/api/stock-register')).status, 403);
  assert.equal((await staff('POST', '/api/stock-register/count', { counts: [] })).status, 403);

  // Rebuilding the register from records (as the upgrade does) gives the same closing stock.
  const before = ok(await owner('GET', '/api/stock-register'));
  store.db.exec(`DROP TRIGGER stock_movements_no_delete; DELETE FROM stock_movements;
    UPDATE settings SET value = 'pending' WHERE key = 'stock_backfill';`);
  require('../src/backfill').runStockBackfill(store, { log: () => {} });
  const after = ok(await owner('GET', '/api/stock-register'));
  assert.equal(after.system_check.ok, true, JSON.stringify(after.system_check.problems));
  assert.deepEqual(after.rows.map((r) => [r.name, r.closing.qty]), before.rows.map((r) => [r.name, r.closing.qty]));
});
