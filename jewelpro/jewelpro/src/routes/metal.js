'use strict';
const { toPaisa, toMg, text, oneOf, id } = require('../units');
const { badRequest, notFound, rule, forbidden } = require('../errors');
const { requirePermission: perm, can } = require('../auth');
const ledger = require('../ledger');
const metal = require('../metal');
const { readOldGold } = require('../sales');
const { nowIso, dateRange, readPayment } = require('./common');

const { A } = ledger;

function registerMetalRoutes(r, store) {
  r.get('/metal', perm('metal.manage'), (req, res) => {
    const metals = store.all('SELECT * FROM metals ORDER BY id').map((m) => {
      const b = metal.balance(store, m.id);
      const withKarigars = store.get(
        "SELECT COALESCE(SUM(issued_fine_mg - consumed_fine_mg), 0) AS fine_mg FROM karigar_jobs WHERE metal_id = ?", m.id).fine_mg;
      return {
        ...m, fine_mg: b.fine_mg, value_paisa: b.value_paisa, with_karigars_mg: withKarigars,
        average_per_gram: b.fine_mg > 0 ? Math.round((b.value_paisa * 1000) / b.fine_mg) : 0
      };
    });
    const entries = store.all(
      `SELECT l.*, m.name AS metal_name, u.full_name AS created_by_name
       FROM metal_ledger l JOIN metals m ON m.id = l.metal_id LEFT JOIN users u ON u.id = l.created_by
       ORDER BY l.id DESC LIMIT 300`);
    res.json({ metals, entries });
  });

  // Opening metal stock (owner) or a loss such as refining or melting loss.
  r.post('/metal/adjust', perm('metal.manage'), (req, res) => {
    const kind = oneOf(req.body.kind, 'Adjustment type', ['opening', 'loss']);
    if (kind === 'opening' && !can(req.user, 'accounts.manage')) throw forbidden('Only the owner can enter opening metal stock.');
    const metalRow = store.get('SELECT * FROM metals WHERE id = ?', id(req.body.metal_id, 'Metal'));
    if (!metalRow) throw badRequest('Choose a metal.');
    const fineMg = toMg(req.body.fine_g, 'Fine weight', { allowEmpty: false });
    if (fineMg <= 0) throw badRequest('Fine weight must be more than zero.');
    const note = text(req.body.note, 'Note', { max: 200, required: true });
    store.tx(() => {
      const now = nowIso();
      if (kind === 'opening') {
        const value = toPaisa(req.body.value, 'Value', { allowEmpty: false });
        metal.add(store, req.user, { date: now, metalId: metalRow.id, fineMg, valuePaisa: value, source: 'opening', note });
        ledger.post(store, req.user, {
          date: now, narration: `Opening ${metalRow.name.toLowerCase()} stock: ${(fineMg / 1000).toFixed(3)} g fine (${note})`,
          refType: 'metal', refId: metalRow.id,
          lines: [{ account: A.METAL, debit: value }, { account: A.OPENING, credit: value }]
        });
      } else {
        const value = metal.valueOut(store, metalRow.id, fineMg);
        metal.add(store, req.user, { date: now, metalId: metalRow.id, fineMg: -fineMg, valuePaisa: -value, source: 'adjustment', note });
        ledger.post(store, req.user, {
          date: now, narration: `${metalRow.name} loss: ${(fineMg / 1000).toFixed(3)} g fine (${note})`, refType: 'metal', refId: metalRow.id,
          lines: [{ account: A.METAL_LOSS, debit: value }, { account: A.METAL, credit: value }]
        });
      }
      store.audit(req.user, kind === 'opening' ? 'opening' : 'loss', 'metal', metalRow.id, { fine_mg: fineMg, note });
    });
    res.json({ ok: true });
  });

  // ------------------------------------------------ Buying old gold from customers (no sale)

  const getOldGoldPurchase = (voucherId) => {
    const v = store.get(
      `SELECT o.*, u.full_name AS created_by_name FROM old_gold_purchases o JOIN users u ON u.id = o.created_by WHERE o.id = ?`, voucherId);
    if (!v) throw notFound('Voucher not found.');
    v.lines = store.all('SELECT * FROM old_gold_purchase_lines WHERE purchase_id = ? ORDER BY id', voucherId);
    return v;
  };

  r.get('/old-gold-purchases', perm('metal.manage'), (req, res) => {
    const { fromIso, toIso } = dateRange(req.query);
    res.json(store.all(
      `SELECT o.*, (SELECT SUM(fine_mg) FROM old_gold_purchase_lines l WHERE l.purchase_id = o.id) AS fine_mg
       FROM old_gold_purchases o WHERE o.purchase_date >= ? AND o.purchase_date < ? ORDER BY o.id DESC`, fromIso, toIso));
  });

  r.get('/old-gold-purchases/:id', perm('metal.manage'), (req, res) => res.json(getOldGoldPurchase(id(req.params.id))));

  r.post('/old-gold-purchases', perm('metal.manage'), (req, res) => {
    const body = req.body || {};
    const payment = readPayment({ ...(body.payment || {}), amount: 1 }, 'Payment', { required: true });
    const voucherId = store.tx(() => {
      const customer = store.get('SELECT * FROM customers WHERE id = ?', id(body.customer_id, 'Customer'));
      if (!customer) throw badRequest('Choose the customer.');
      if (customer.is_walkin) throw rule('Record the name and phone of anyone you buy old gold from. Choose or add the customer.');
      const lines = readOldGold(store, body.lines, 'Line');
      if (!lines.length) throw badRequest('Add the old gold being bought.');
      const total = lines.reduce((a, l) => a + l.amount, 0);
      if (total <= 0) throw rule('The total must be more than zero.');
      const now = nowIso();
      const voucherNo = ledger.nextNumber(store, 'old_gold_purchase', 'OGP-', 5);
      const rowId = store.run(
        `INSERT INTO old_gold_purchases (voucher_no, customer_id, customer_name, customer_phone, purchase_date, total_paisa, method, reference, remarks, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        voucherNo, customer.id, customer.name, customer.phone, now, total, payment.method, payment.reference,
        text(body.remarks, 'Remarks', { max: 300 }), req.user.id
      ).lastInsertRowid;
      for (const l of lines) {
        store.run(
          `INSERT INTO old_gold_purchase_lines (purchase_id, description, purity_id, purity_name, purity, gross_mg, less_mg, net_mg,
             refining_percent, fine_mg, rate_per_gram, amount_paisa) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          rowId, l.description, l.purity_id, l.purity_name, l.purity, l.gross_mg, l.less_mg, l.net_mg,
          l.refining_percent, l.fine_mg, l.rate_per_gram, l.amount);
        metal.add(store, req.user, {
          date: now, metalId: l.metal_id, fineMg: l.fine_mg, grossMg: l.net_mg, purity: l.purity, valuePaisa: l.amount,
          source: 'old_gold_purchase', refType: 'old_gold_purchase', refId: rowId, note: `${voucherNo}: ${customer.name}`
        });
      }
      ledger.post(store, req.user, {
        date: now, narration: `${voucherNo}: old gold bought from ${customer.name}`, refType: 'old_gold_purchase', refId: rowId,
        lines: [{ account: A.METAL, debit: total }, { account: ledger.methodAccount(payment.method), credit: total, memo: payment.method }]
      });
      store.audit(req.user, 'create', 'old_gold_purchase', rowId, { voucher_no: voucherNo, customer: customer.name, total });
      return rowId;
    });
    res.status(201).json(getOldGoldPurchase(voucherId));
  });

  r.post('/old-gold-purchases/preview', perm('metal.manage'), (req, res) => {
    const lines = readOldGold(store, req.body.lines, 'Line');
    res.json({ lines, total: lines.reduce((a, l) => a + l.amount, 0) });
  });

  r.post('/old-gold-purchases/:id/cancel', perm('metal.manage'), (req, res) => {
    const voucherId = id(req.params.id);
    const reason = text(req.body.reason, 'Reason', { max: 300, required: true });
    store.tx(() => {
      const v = getOldGoldPurchase(voucherId);
      if (v.status === 'cancelled') throw rule('This voucher is already cancelled.');
      ledger.assertOpen(store, v.purchase_date, 'This voucher');
      const now = nowIso();
      for (const l of v.lines) {
        const metalId = store.get('SELECT metal_id FROM purities WHERE id = ?', l.purity_id).metal_id;
        metal.add(store, req.user, {
          date: now, metalId, fineMg: -l.fine_mg, grossMg: -l.net_mg, purity: l.purity, valuePaisa: -l.amount_paisa,
          source: 'cancel', refType: 'old_gold_purchase', refId: voucherId, note: `${v.voucher_no} cancelled`
        });
      }
      store.run("UPDATE old_gold_purchases SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, voucherId);
      ledger.reverseDocument(store, req.user, 'old_gold_purchase', voucherId, `Cancelled ${v.voucher_no}: ${reason}`);
      store.audit(req.user, 'cancel', 'old_gold_purchase', voucherId, { voucher_no: v.voucher_no, reason });
    });
    res.json(getOldGoldPurchase(voucherId));
  });
}

module.exports = { registerMetalRoutes };
