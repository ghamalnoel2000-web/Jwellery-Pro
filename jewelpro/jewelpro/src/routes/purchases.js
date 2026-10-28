'use strict';
const { toPaisa, toMg, text, oneOf, id } = require('../units');
const { badRequest, notFound, rule } = require('../errors');
const { requirePermission: perm, can } = require('../auth');
const ledger = require('../ledger');
const metal = require('../metal');
const { readProduct, insertProduct } = require('../products');
const stock = require('../stock');
const { nowIso, dateRange, readPayment } = require('./common');

const { A } = ledger;

/** Pays a supplier or karigar and posts it against what the shop owes them. */
function payParty(store, user, { partyType, partyId, partyName, payableAccount, payment, note }) {
  const voucherNo = ledger.nextNumber(store, 'party_payment', 'PAY-', 5);
  const now = nowIso();
  const paymentId = store.run(
    `INSERT INTO party_payments (voucher_no, party_type, party_id, method, amount_paisa, reference, note, paid_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    voucherNo, partyType, partyId, payment.method, payment.amount, payment.reference, note, now, user.id
  ).lastInsertRowid;
  ledger.post(store, user, {
    date: now, narration: `${voucherNo}: paid ${partyName}${note ? ` (${note})` : ''}`, refType: 'party_payment', refId: paymentId,
    lines: [
      { account: payableAccount, debit: payment.amount, party_type: partyType, party_id: partyId },
      { account: ledger.methodAccount(payment.method), credit: payment.amount, memo: payment.method }
    ]
  });
  store.audit(user, 'payment', partyType, partyId, { voucher_no: voucherNo, amount: payment.amount, method: payment.method, note });
  return { id: paymentId, voucher_no: voucherNo };
}

/** Lines posted to one account for one party, with a running balance (credit minus debit for what the shop owes). */
function partyStatement(store, accountCode, partyType, partyId, sign = 1) {
  const rows = store.all(
    `SELECT e.entry_no, e.entry_date, e.narration, l.debit_paisa, l.credit_paisa
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND l.party_type = ? AND l.party_id = ? ORDER BY e.entry_date, e.id`,
    ledger.accountId(store, accountCode), partyType, partyId);
  let running = 0;
  return rows.map((r) => {
    running += sign * (r.credit_paisa - r.debit_paisa);
    return { ...r, balance_paisa: running };
  });
}

function registerPurchaseRoutes(r, store) {
  const payablesId = () => ledger.accountId(store, A.PAYABLE);

  // ------------------------------------------------ Suppliers

  r.get('/suppliers', perm('purchases.manage'), (req, res) => {
    // What the shop owes suppliers is for the owner only.
    const showBalance = can(req.user, 'payments.make');
    res.json(store.all(
      `SELECT s.*, COALESCE((SELECT SUM(credit_paisa - debit_paisa) FROM journal_lines l
                              WHERE l.account_id = ? AND l.party_type = 'supplier' AND l.party_id = s.id), 0) AS balance_paisa
       FROM suppliers s ORDER BY s.is_active DESC, s.name`, payablesId())
      .map((s) => (showBalance ? s : { ...s, balance_paisa: undefined })));
  });

  const readSupplier = (b) => ({
    name: text(b.name, 'Supplier name', { max: 100, required: true }),
    phone: text(b.phone, 'Phone', { max: 20 }),
    address: text(b.address, 'Address', { max: 200 }),
    pan: text(b.pan, 'PAN', { max: 20 }),
    notes: text(b.notes, 'Notes', { max: 300 }),
    is_active: b.is_active === false || b.is_active === 'false' ? 0 : 1
  });

  r.post('/suppliers', perm('purchases.manage'), (req, res) => {
    const s = readSupplier(req.body);
    const newId = store.tx(() => {
      const rowId = store.run('INSERT INTO suppliers (name, phone, address, pan, notes, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        s.name, s.phone, s.address, s.pan, s.notes, s.is_active, nowIso()).lastInsertRowid;
      store.audit(req.user, 'create', 'supplier', rowId, s);
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM suppliers WHERE id = ?', newId));
  });

  r.put('/suppliers/:id', perm('purchases.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const s = readSupplier(req.body);
    store.tx(() => {
      const old = store.get('SELECT * FROM suppliers WHERE id = ?', rowId);
      if (!old) throw notFound('Supplier not found.');
      store.run('UPDATE suppliers SET name = ?, phone = ?, address = ?, pan = ?, notes = ?, is_active = ? WHERE id = ?',
        s.name, s.phone, s.address, s.pan, s.notes, s.is_active, rowId);
      store.audit(req.user, 'update', 'supplier', rowId, { before: old, after: s });
    });
    res.json(store.get('SELECT * FROM suppliers WHERE id = ?', rowId));
  });

  r.get('/suppliers/:id/statement', perm('payments.make'), (req, res) => {
    const supplier = store.get('SELECT * FROM suppliers WHERE id = ?', id(req.params.id));
    if (!supplier) throw notFound('Supplier not found.');
    res.json({ supplier, lines: partyStatement(store, A.PAYABLE, 'supplier', supplier.id) });
  });

  r.post('/suppliers/:id/payments', perm('payments.make'), (req, res) => {
    const supplierId = id(req.params.id);
    const payment = readPayment(req.body, 'Payment', { required: true });
    const note = text(req.body.note, 'Note', { max: 200 });
    const result = store.tx(() => {
      const supplier = store.get('SELECT * FROM suppliers WHERE id = ?', supplierId);
      if (!supplier) throw notFound('Supplier not found.');
      return payParty(store, req.user, {
        partyType: 'supplier', partyId: supplierId, partyName: supplier.name, payableAccount: A.PAYABLE, payment, note
      });
    });
    res.status(201).json(result);
  });

  // ------------------------------------------------ Purchases

  r.get('/purchases', perm('purchases.manage'), (req, res) => {
    const { fromIso, toIso } = dateRange(req.query);
    res.json(store.all(
      `SELECT p.*, s.name AS supplier_name, (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.purchase_date >= ? AND p.purchase_date < ? ORDER BY p.purchase_date DESC, p.id DESC`, fromIso, toIso));
  });

  const getPurchase = (purchaseId, user = null) => {
    const p = store.get(
      `SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, u.full_name AS created_by_name
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id JOIN users u ON u.id = p.created_by WHERE p.id = ?`, purchaseId);
    if (!p) throw notFound('Purchase not found.');
    p.lines = store.all(
      `SELECT l.*, pu.name AS purity_name, m.name AS metal_name, pr.item_code, pr.status AS product_status
       FROM purchase_lines l JOIN purities pu ON pu.id = l.purity_id JOIN metals m ON m.id = pu.metal_id
       LEFT JOIN products pr ON pr.id = l.product_id WHERE l.purchase_id = ? ORDER BY l.id`, purchaseId);
    if (user && !can(user, 'stock.private')) {
      // Pieces the owner has moved to owner-only stock: staff see the purchase line, not the item.
      const hidden = new Set(store.all('SELECT id FROM products WHERE is_private = 1').map((x) => x.id));
      p.lines = p.lines.map((l) => (hidden.has(l.product_id) ? { ...l, product_id: null, item_code: null, product_status: null } : l));
    }
    return p;
  };

  r.get('/purchases/:id', perm('purchases.manage'), (req, res) => res.json(getPurchase(id(req.params.id), req.user)));

  r.post('/purchases', perm('purchases.manage'), (req, res) => {
    const body = req.body || {};
    const supplierId = id(body.supplier_id, 'Supplier');
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length) throw badRequest('Add at least one line to the purchase.');
    const date = ledger.documentDate(body.date);
    const payment = readPayment(body.payment, 'Payment');

    const purchaseId = store.tx(() => {
      const supplier = store.get('SELECT * FROM suppliers WHERE id = ?', supplierId);
      if (!supplier) throw badRequest('Choose a supplier.');
      const parsed = lines.map((line, i) => {
        const label = `Line ${i + 1}`;
        const kind = oneOf(line.kind, `${label} type`, ['piece', 'metal']);
        const amount = toPaisa(line.amount, `${label}: amount`, { allowEmpty: false });
        if (kind === 'piece') {
          const p = readProduct({ ...line, cost: line.amount }, label);
          return { kind, amount, product: p };
        }
        const purity = store.get('SELECT pu.*, m.name AS metal_name FROM purities pu JOIN metals m ON m.id = pu.metal_id WHERE pu.id = ?',
          id(line.purity_id, `${label}: purity`));
        if (!purity) throw badRequest(`${label}: choose a purity.`);
        const grossMg = toMg(line.gross_g, `${label}: weight`, { allowEmpty: false });
        if (grossMg <= 0) throw badRequest(`${label}: weight must be more than zero.`);
        return {
          kind, amount, purity, grossMg, fineMg: Math.round(grossMg * purity.purity),
          description: text(line.description, `${label}: description`, { max: 100 }) || `${purity.metal_name} ${purity.name}`
        };
      });
      const total = parsed.reduce((a, l) => a + l.amount, 0);
      if (total <= 0) throw rule('The purchase total must be more than zero.');
      if (payment && payment.amount > total) throw rule('The payment is more than the purchase total.');

      const purchaseNo = ledger.nextNumber(store, 'purchase', 'PUR-', 5);
      const rowId = store.run(
        `INSERT INTO purchases (purchase_no, supplier_id, supplier_bill_no, purchase_date, total_paisa, paid_paisa, remarks, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        purchaseNo, supplierId, text(body.supplier_bill_no, 'Supplier bill no.', { max: 50 }), date, total,
        payment ? payment.amount : 0, text(body.remarks, 'Remarks', { max: 300 }), nowIso(), req.user.id
      ).lastInsertRowid;

      let piecesTotal = 0;
      let metalTotal = 0;
      for (const l of parsed) {
        if (l.kind === 'piece') {
          const piece = insertProduct(store, req.user, l.product, { source: 'purchase', sourceId: rowId });
          const purity = store.get('SELECT purity FROM purities WHERE id = ?', l.product.purity_id).purity;
          store.run(
            `INSERT INTO purchase_lines (purchase_id, kind, description, purity_id, gross_mg, fine_mg, product_id, amount_paisa)
             VALUES (?, 'piece', ?, ?, ?, ?, ?, ?)`,
            rowId, l.product.name, l.product.purity_id, l.product.gross_mg,
            Math.round((l.product.gross_mg - l.product.stone_mg - l.product.other_less_mg) * purity), piece.id, l.amount);
          piecesTotal += l.amount;
        } else {
          store.run(
            `INSERT INTO purchase_lines (purchase_id, kind, description, purity_id, gross_mg, fine_mg, amount_paisa)
             VALUES (?, 'metal', ?, ?, ?, ?, ?)`,
            rowId, l.description, l.purity.id, l.grossMg, l.fineMg, l.amount);
          metal.add(store, req.user, {
            date, metalId: l.purity.metal_id, fineMg: l.fineMg, grossMg: l.grossMg, purity: l.purity.purity, valuePaisa: l.amount,
            source: 'purchase', refType: 'purchase', refId: rowId, note: `${purchaseNo}: ${l.description}`
          });
          metalTotal += l.amount;
        }
      }
      const party = { party_type: 'supplier', party_id: supplierId };
      const entryLines = [
        { account: A.STOCK, debit: piecesTotal, memo: 'Pieces bought' },
        { account: A.METAL, debit: metalTotal, memo: 'Metal bought' },
        { account: A.PAYABLE, credit: total, ...party }
      ];
      if (payment) {
        entryLines.push({ account: A.PAYABLE, debit: payment.amount, ...party });
        entryLines.push({ account: ledger.methodAccount(payment.method), credit: payment.amount, memo: payment.method });
      }
      ledger.post(store, req.user, {
        date, narration: `Purchase ${purchaseNo} from ${supplier.name}${body.supplier_bill_no ? ` (bill ${body.supplier_bill_no})` : ''}`,
        refType: 'purchase', refId: rowId, lines: entryLines
      });
      store.audit(req.user, 'create', 'purchase', rowId, { purchase_no: purchaseNo, supplier: supplier.name, total });
      return rowId;
    });
    res.status(201).json(getPurchase(purchaseId, req.user));
  });

  r.post('/purchases/:id/cancel', perm('purchases.cancel'), (req, res) => {
    const purchaseId = id(req.params.id);
    const reason = text(req.body.reason, 'Reason', { max: 300, required: true });
    store.tx(() => {
      const p = getPurchase(purchaseId);
      if (p.status === 'cancelled') throw rule('This purchase is already cancelled.');
      ledger.assertOpen(store, p.purchase_date, 'This purchase');
      const now = nowIso();
      for (const l of p.lines) {
        if (l.kind === 'piece') {
          if (l.product_status !== 'in_stock') throw rule(`${l.item_code} is no longer in stock, so this purchase cannot be cancelled.`);
          store.run("UPDATE products SET status = 'removed', updated_at = ? WHERE id = ?", now, l.product_id);
          stock.record(store, req.user, store.get('SELECT * FROM products WHERE id = ?', l.product_id), 'purchase_cancelled',
            { at: now, refType: 'purchase', refId: purchaseId });
        } else {
          const metalId = store.get('SELECT metal_id FROM purities WHERE id = ?', l.purity_id).metal_id;
          metal.add(store, req.user, {
            date: now, metalId, fineMg: -l.fine_mg, grossMg: -l.gross_mg, valuePaisa: -l.amount_paisa,
            source: 'cancel', refType: 'purchase', refId: purchaseId, note: `${p.purchase_no} cancelled`
          });
        }
      }
      store.run("UPDATE purchases SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, purchaseId);
      ledger.reverseDocument(store, req.user, 'purchase', purchaseId, `Cancelled ${p.purchase_no}: ${reason}`);
      store.audit(req.user, 'cancel', 'purchase', purchaseId, { purchase_no: p.purchase_no, reason });
    });
    res.json(getPurchase(purchaseId));
  });
}

module.exports = { registerPurchaseRoutes, payParty, partyStatement };
