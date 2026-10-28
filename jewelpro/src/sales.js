'use strict';
const { priceLine, priceExchange, priceBill } = require('./billing');
const { toPaisa, toMg, toNumber, text, oneOf, id } = require('./units');
const { rule, forbidden, notFound } = require('./errors');
const { can } = require('./auth');
const ledger = require('./ledger');
const metal = require('./metal');
const stock = require('./stock');

const { A } = ledger;
const rs = (paisa) => `Rs ${(paisa / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const PAYMENT_METHODS = ['cash', 'bank', 'card', 'qr', 'cheque'];

function loadProduct(store, productId) {
  return store.get(
    `SELECT p.*, c.name AS category_name, c.charge_profile_id AS category_profile_id,
            pu.name AS purity_name, pu.purity AS purity_value, m.name AS metal_name
     FROM products p
     JOIN categories c ON c.id = p.category_id
     JOIN purities pu ON pu.id = p.purity_id
     JOIN metals m ON m.id = pu.metal_id
     WHERE p.id = ?`,
    productId
  );
}

function parsePayments(input) {
  return (Array.isArray(input) ? input : [])
    .filter((p) => p && p.amount !== '' && p.amount !== null && p.amount !== undefined && Number(p.amount) !== 0)
    .map((p) => ({
      method: oneOf(p.method, 'Payment method', PAYMENT_METHODS),
      amount: toPaisa(p.amount, 'Payment amount', { min: 0.01 }),
      reference: text(p.reference, 'Payment reference', { max: 100 })
    }));
}

/**
 * Prices a bill from the request. Used both for the live preview and for saving,
 * so what the cashier sees is exactly what is saved.
 */
function readOldGold(store, list, labelPrefix) {
  return (Array.isArray(list) ? list : []).map((x, index) => {
    const label = `${labelPrefix} ${index + 1}`;
    const purity = store.get(
      `SELECT pu.id, pu.name, pu.purity, pu.metal_id, m.name AS metal_name, r.buy_per_gram
       FROM purities pu JOIN metals m ON m.id = pu.metal_id LEFT JOIN rates r ON r.purity_id = pu.id
       WHERE pu.id = ?`,
      id(x.purity_id, `${label}: purity`)
    );
    if (!purity) throw rule(`${label}: choose a purity.`);
    if (!purity.buy_per_gram || purity.buy_per_gram <= 0) {
      throw rule(`Enter today's buying rate for ${purity.metal_name} ${purity.name} first.`);
    }
    const grossMg = toMg(x.gross_g, `${label}: weight`, { allowEmpty: false });
    const lessMg = toMg(x.less_g, `${label}: less weight`);
    if (grossMg <= 0) throw rule(`${label}: weight must be more than zero.`);
    if (lessMg >= grossMg) throw rule(`${label}: less weight must be smaller than the weight.`);
    const refiningPercent = toNumber(x.refining_percent, `${label}: refining %`, { max: 100 });
    const valued = priceExchange({
      gross_mg: grossMg, less_mg: lessMg, purity: purity.purity,
      refining_percent: refiningPercent, rate_per_gram: purity.buy_per_gram
    });
    return {
      description: text(x.description, `${label}: description`, { max: 100 }) || 'Old gold',
      purity_id: purity.id, metal_id: purity.metal_id, purity_name: `${purity.metal_name} ${purity.name}`, purity: purity.purity,
      gross_mg: grossMg, less_mg: lessMg, net_mg: valued.net_mg, refining_percent: refiningPercent,
      fine_mg: valued.fine_mg, rate_per_gram: purity.buy_per_gram, amount: valued.amount
    };
  });
}

function buildBill(store, input, user) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw rule('Add at least one item to the bill.');
  const productIds = items.map((i) => id(i.product_id, 'Item'));
  if (new Set(productIds).size !== productIds.length) throw rule('The same item is on the bill twice.');

  const taxRules = store.all('SELECT name, rate_percent, applies_to FROM tax_rules WHERE is_active = 1 ORDER BY id');
  const defaultProfile = store.get('SELECT id FROM charge_profiles WHERE is_active = 1 ORDER BY id LIMIT 1');

  const lines = productIds.map((productId) => {
    const product = loadProduct(store, productId);
    // Owner-only stock does not exist for staff, even if they know its number.
    if (!product || (product.is_private && !can(user, 'stock.private'))) {
      throw rule('An item on the bill no longer exists. Remove it and scan again.');
    }
    if (product.status !== 'in_stock') {
      throw rule(`${product.item_code} is not in stock (it is ${product.status.replace('_', ' ')}).`);
    }
    const profileId = product.charge_profile_id ?? product.category_profile_id ?? (defaultProfile && defaultProfile.id);
    const profile = profileId ? store.get('SELECT * FROM charge_profiles WHERE id = ?', profileId) : null;
    if (!profile) throw rule('No charge profile is set up. Add one in Settings first.');
    const rate = store.get('SELECT sell_per_gram FROM rates WHERE purity_id = ?', product.purity_id);
    const isFixed = product.fixed_price_paisa !== null;
    if (!isFixed && (!rate || rate.sell_per_gram <= 0)) {
      throw rule(`Enter today's selling rate for ${product.metal_name} ${product.purity_name} first.`);
    }
    return { product, priced: priceLine(product, profile, rate ? rate.sell_per_gram : 0) };
  });

  const exchange = readOldGold(store, input.exchange, 'Old gold line');

  const discount = toPaisa(input.discount, 'Discount');
  const roundTo = toPaisa(store.setting('round_to_rupees') || 0);

  const bill = priceBill({
    lines: lines.map((l) => l.priced),
    discountPaisa: discount,
    exchangeAmounts: exchange.map((x) => x.amount),
    taxRules,
    roundToPaisa: roundTo
  });

  if (!can(user, 'sales.discount_over_limit') && discount > 0) {
    const maxPercent = Number(store.setting('cashier_max_discount_percent')) || 0;
    if (discount > Math.floor((bill.subtotal * maxPercent) / 100)) {
      throw forbidden(`Discounts above ${maxPercent}% need the owner.`);
    }
  }

  const payments = parsePayments(input.payments);
  const paidMoney = payments.reduce((a, p) => a + p.amount, 0);

  // A customer order's advance can pay part of the bill.
  let order = null;
  let advance = 0;
  if (input.order_id) {
    order = store.get('SELECT * FROM orders WHERE id = ?', id(input.order_id, 'Order'));
    if (!order || ['delivered', 'cancelled'].includes(order.status)) throw rule('That order is already delivered or cancelled.');
    if (input.customer_id && Number(input.customer_id) !== order.customer_id) throw rule(`${order.order_no} belongs to another customer.`);
    const available = order.advance_paisa - order.used_paisa - order.refunded_paisa;
    advance = input.use_advance === undefined || input.use_advance === null || input.use_advance === ''
      ? Math.max(0, Math.min(available, bill.netPayable - paidMoney))
      : toPaisa(input.use_advance, 'Advance used');
    if (advance > available) throw rule(`Only ${rs(available)} of advance is left on ${order.order_no}.`);
  }
  const paid = paidMoney + advance;
  if (paid > bill.netPayable) throw rule('Payments are more than the amount payable.');

  return {
    items: lines.map((l, i) => ({
      product_id: l.product.id,
      item_code: l.product.item_code,
      description: `${l.product.name}`,
      metal_name: l.product.metal_name,
      purity_name: `${l.product.metal_name} ${l.product.purity_name}`,
      purity: l.product.purity_value,
      huid: l.product.huid,
      ...bill.lines[i]
    })),
    exchange,
    totals: {
      subtotal: bill.subtotal, discount: bill.discount, taxable: bill.taxable, tax: bill.tax,
      tax_summary: bill.taxSummary, grand_total: bill.grandTotal, exchange: bill.exchange,
      round_off: bill.roundOff, net_payable: bill.netPayable, advance, paid, due: bill.netPayable - paid,
      cost: lines.reduce((a, l) => a + l.product.cost_paisa, 0)
    },
    order: order ? { id: order.id, order_no: order.order_no, available: order.advance_paisa - order.used_paisa - order.refunded_paisa } : null,
    payments
  };
}

function createSale(store, input, user) {
  return store.tx(() => {
    const built = buildBill(store, input, user);
    const walkIn = store.get('SELECT id FROM customers WHERE is_walkin = 1 ORDER BY id LIMIT 1');
    const customerId = input.customer_id ? id(input.customer_id, 'Customer') : walkIn.id;
    const customer = store.get('SELECT * FROM customers WHERE id = ?', customerId);
    if (!customer) throw rule('Choose a customer.');
    if (built.totals.due > 0 && customer.is_walkin) {
      throw rule('A walk-in customer must pay in full. Choose or add the customer to record a due amount.');
    }

    const invoiceNo = ledger.invoiceNumber(store);
    const now = new Date().toISOString();
    const t = built.totals;

    const saleId = store.run(
      `INSERT INTO sales (invoice_no, invoice_date, customer_id, customer_name, customer_phone, customer_address, customer_pan,
         subtotal_paisa, discount_paisa, taxable_paisa, tax_paisa, grand_total_paisa, exchange_paisa, round_off_paisa,
         net_payable_paisa, paid_paisa, due_paisa, tax_summary, remarks, created_by, order_id, advance_paisa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoiceNo, now, customer.id, customer.name, customer.phone, customer.address, customer.pan,
      t.subtotal, t.discount, t.taxable, t.tax, t.grand_total, t.exchange, t.round_off,
      t.net_payable, t.paid, t.due, JSON.stringify(t.tax_summary), text(input.remarks, 'Remarks', { max: 300 }), user.id,
      built.order ? built.order.id : null, t.advance
    ).lastInsertRowid;

    built.items.forEach((item, index) => {
      store.run(
        `INSERT INTO sale_items (sale_id, line_no, product_id, item_code, description, purity_name, purity,
           gross_mg, stone_mg, other_less_mg, net_mg, wastage_mg, chargeable_mg, rate_per_gram,
           metal_paisa, making_paisa, stone_paisa, other_paisa, discount_paisa, taxable_paisa, tax_paisa, total_paisa,
           huid, pricing_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        saleId, index + 1, item.product_id, item.item_code, item.description, item.purity_name, item.purity,
        item.gross_mg, item.stone_mg, item.other_less_mg, item.net_mg, item.wastage_mg, item.chargeable_mg, item.rate_per_gram,
        item.metal, item.making, item.stones, item.other, item.discount, item.taxable, item.tax, item.total,
        item.huid, item.method
      );
      const updated = store.run(
        "UPDATE products SET status = 'sold', updated_at = ? WHERE id = ? AND status = 'in_stock'",
        now, item.product_id
      );
      if (updated.changes !== 1) throw rule(`${item.item_code} was just sold on another counter.`);
      stock.record(store, user, store.get('SELECT * FROM products WHERE id = ?', item.product_id), 'sold',
        { at: now, refType: 'sale', refId: saleId });
    });

    for (const x of built.exchange) {
      store.run(
        `INSERT INTO sale_exchange_items (sale_id, description, purity_id, purity_name, purity, gross_mg, less_mg, net_mg,
           refining_percent, fine_mg, rate_per_gram, amount_paisa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        saleId, x.description, x.purity_id, x.purity_name, x.purity, x.gross_mg, x.less_mg, x.net_mg,
        x.refining_percent, x.fine_mg, x.rate_per_gram, x.amount
      );
    }

    for (const p of built.payments) {
      store.run(
        'INSERT INTO payments (sale_id, method, amount_paisa, reference, paid_at, received_by) VALUES (?, ?, ?, ?, ?, ?)',
        saleId, p.method, p.amount, p.reference, now, user.id
      );
    }

    for (const x of built.exchange) {
      metal.add(store, user, {
        date: now, metalId: x.metal_id, fineMg: x.fine_mg, grossMg: x.net_mg, purity: x.purity, valuePaisa: x.amount,
        source: 'exchange', refType: 'sale', refId: saleId, note: `${invoiceNo}: ${x.description}`
      });
    }

    if (built.order) {
      const deliver = input.deliver_order !== false;
      store.run(`UPDATE orders SET used_paisa = used_paisa + ?, status = CASE WHEN ? THEN 'delivered' ELSE status END, updated_at = ? WHERE id = ?`,
        t.advance, deliver ? 1 : 0, now, built.order.id);
    }

    postSale(store, user, {
      date: now, saleId, invoiceNo, customerId: customer.id, totals: t,
      payments: built.payments, advance: t.advance
    });

    store.audit(user, 'create', 'sale', saleId, {
      invoice_no: invoiceNo, customer: customer.name, net_payable: t.net_payable, paid: t.paid,
      items: built.items.map((i) => i.item_code)
    });

    return saleId;
  });
}

/** The accounting entry for a new bill. */
function postSale(store, user, { date, saleId, invoiceNo, customerId, totals: t, payments, advance, skipLock = false }) {
  const party = { party_type: 'customer', party_id: customerId };
  const lines = [
    { account: A.RECEIVABLE, debit: t.net_payable, ...party },
    { account: A.METAL, debit: t.exchange, memo: 'Old gold taken in exchange' },
    { account: A.ROUNDING, credit: t.round_off },
    { account: A.SALES, credit: t.taxable },
    { account: A.TAX, credit: t.tax },
    { account: A.COGS, debit: t.cost },
    { account: A.STOCK, credit: t.cost }
  ];
  for (const p of payments) {
    lines.push({ account: ledger.methodAccount(p.method), debit: p.amount, memo: p.method });
    lines.push({ account: A.RECEIVABLE, credit: p.amount, ...party });
  }
  if (advance) {
    lines.push({ account: A.ADVANCES, debit: advance, ...party, memo: 'Order advance used' });
    lines.push({ account: A.RECEIVABLE, credit: advance, ...party });
  }
  ledger.post(store, user, { date, narration: `Sale ${invoiceNo}`, refType: 'sale', refId: saleId, lines, skipLock });
}

function postSalePayment(store, user, { date, saleId, invoiceNo, customerId, method, amount, skipLock = false }) {
  ledger.post(store, user, {
    date, narration: `Payment received on ${invoiceNo}`, refType: 'sale', refId: saleId, skipLock,
    lines: [
      { account: ledger.methodAccount(method), debit: amount, memo: method },
      { account: A.RECEIVABLE, credit: amount, party_type: 'customer', party_id: customerId }
    ]
  });
}

function getSale(store, saleId) {
  const sale = store.get(
    `SELECT s.*, u.full_name AS created_by_name, cu.full_name AS cancelled_by_name
     FROM sales s JOIN users u ON u.id = s.created_by LEFT JOIN users cu ON cu.id = s.cancelled_by
     WHERE s.id = ?`,
    saleId
  );
  if (!sale) throw notFound('Invoice not found.');
  sale.tax_summary = JSON.parse(sale.tax_summary || '[]');
  sale.items = store.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY line_no', saleId);
  sale.exchange = store.all('SELECT * FROM sale_exchange_items WHERE sale_id = ? ORDER BY id', saleId);
  sale.payments = store.all(
    `SELECT p.*, u.full_name AS received_by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by
     WHERE p.sale_id = ? ORDER BY p.id`,
    saleId
  );
  return sale;
}

function addPayment(store, saleId, input, user) {
  return store.tx(() => {
    const sale = store.get('SELECT * FROM sales WHERE id = ?', saleId);
    if (!sale) throw notFound('Invoice not found.');
    if (sale.status !== 'posted') throw rule('This invoice is cancelled.');
    const [payment] = parsePayments([input]);
    if (!payment) throw rule('Enter the amount received.');
    if (payment.amount > sale.due_paisa) throw rule('The amount is more than the balance due.');
    store.run(
      'INSERT INTO payments (sale_id, method, amount_paisa, reference, paid_at, received_by) VALUES (?, ?, ?, ?, ?, ?)',
      saleId, payment.method, payment.amount, payment.reference, new Date().toISOString(), user.id
    );
    store.run(
      'UPDATE sales SET paid_paisa = paid_paisa + ?, due_paisa = due_paisa - ? WHERE id = ?',
      payment.amount, payment.amount, saleId
    );
    postSalePayment(store, user, {
      saleId, invoiceNo: sale.invoice_no, customerId: sale.customer_id, method: payment.method, amount: payment.amount
    });
    store.audit(user, 'payment', 'sale', saleId, { invoice_no: sale.invoice_no, amount: payment.amount, method: payment.method });
  });
}

function cancelSale(store, saleId, reason, user) {
  const cleanReason = text(reason, 'Reason', { max: 300, required: true });
  return store.tx(() => {
    const sale = store.get('SELECT * FROM sales WHERE id = ?', saleId);
    if (!sale) throw notFound('Invoice not found.');
    if (sale.status === 'cancelled') throw rule('This invoice is already cancelled.');
    ledger.assertOpen(store, sale.invoice_date, 'This invoice');
    const now = new Date().toISOString();
    store.run(
      "UPDATE sales SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?, cancelled_by = ? WHERE id = ?",
      cleanReason, now, user.id, saleId
    );
    const items = store.all('SELECT product_id, item_code FROM sale_items WHERE sale_id = ?', saleId);
    for (const item of items) {
      const back = store.run("UPDATE products SET status = 'in_stock', updated_at = ? WHERE id = ? AND status = 'sold'", now, item.product_id);
      if (back.changes === 1) {
        stock.record(store, user, store.get('SELECT * FROM products WHERE id = ?', item.product_id), 'sale_cancelled',
          { at: now, refType: 'sale', refId: saleId });
      }
    }
    for (const x of store.all('SELECT e.*, p.metal_id FROM sale_exchange_items e JOIN purities p ON p.id = e.purity_id WHERE e.sale_id = ?', saleId)) {
      metal.add(store, user, {
        date: now, metalId: x.metal_id, fineMg: -x.fine_mg, grossMg: -x.net_mg, purity: x.purity, valuePaisa: -x.amount_paisa,
        source: 'cancel', refType: 'sale', refId: saleId, note: `${sale.invoice_no} cancelled`
      });
    }
    if (sale.order_id && sale.advance_paisa) {
      store.run(`UPDATE orders SET used_paisa = used_paisa - ?, status = CASE WHEN status = 'delivered' THEN 'ready' ELSE status END,
                 updated_at = ? WHERE id = ?`, sale.advance_paisa, now, sale.order_id);
    }
    ledger.reverseDocument(store, user, 'sale', saleId, `Cancelled ${sale.invoice_no}: ${cleanReason}`);
    store.audit(user, 'cancel', 'sale', saleId, {
      invoice_no: sale.invoice_no, reason: cleanReason, refund_due: sale.paid_paisa,
      returned_to_stock: items.map((i) => i.item_code)
    });
  });
}

module.exports = { PAYMENT_METHODS, readOldGold, buildBill, createSale, getSale, addPayment, cancelSale, postSale, postSalePayment };
