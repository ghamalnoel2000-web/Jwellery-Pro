'use strict';
const { toPaisa, toMg, text, oneOf, id } = require('../units');
const { badRequest, notFound, rule } = require('../errors');
const { requirePermission: perm } = require('../auth');
const ledger = require('../ledger');
const { nowIso, readPayment, dueDate } = require('./common');

const { A } = ledger;

function registerOrderRoutes(r, store) {
  // ------------------------------------------------ Orders

  const ORDER_SELECT = `
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, pu.name AS purity_name, m.name AS metal_name,
           o.advance_paisa - o.used_paisa - o.refunded_paisa AS available_paisa
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN purities pu ON pu.id = o.purity_id LEFT JOIN metals m ON m.id = pu.metal_id`;

  const getOrder = (orderId) => {
    const order = store.get(`${ORDER_SELECT} WHERE o.id = ?`, orderId);
    if (!order) throw notFound('Order not found.');
    order.payments = store.all(
      `SELECT p.*, u.full_name AS received_by_name FROM order_payments p LEFT JOIN users u ON u.id = p.received_by
       WHERE p.order_id = ? ORDER BY p.id`, orderId);
    order.jobs = store.all('SELECT id, job_no, status, due_date FROM karigar_jobs WHERE order_id = ? ORDER BY id', orderId);
    order.sales = store.all("SELECT id, invoice_no, advance_paisa, status FROM sales WHERE order_id = ? ORDER BY id", orderId);
    return order;
  };

  r.get('/orders', perm('orders.manage'), (req, res) => {
    const status = req.query.status || 'active';
    const customerId = req.query.customer_id ? id(req.query.customer_id) : null;
    res.json(store.all(
      `${ORDER_SELECT}
       WHERE (? = 'all' OR (? = 'active' AND o.status IN ('open', 'ready')) OR o.status = ?)
         AND (? IS NULL OR o.customer_id = ?)
       ORDER BY CASE WHEN o.due_date IS NULL THEN 1 ELSE 0 END, o.due_date, o.id DESC LIMIT 500`,
      status, status, status, customerId, customerId));
  });

  r.get('/orders/:id', perm('orders.manage'), (req, res) => res.json(getOrder(id(req.params.id))));

  function receiveAdvance(user, order, payment) {
    const now = nowIso();
    const paymentId = store.run(
      "INSERT INTO order_payments (order_id, kind, method, amount_paisa, reference, paid_at, received_by) VALUES (?, 'advance', ?, ?, ?, ?, ?)",
      order.id, payment.method, payment.amount, payment.reference, now, user.id).lastInsertRowid;
    store.run('UPDATE orders SET advance_paisa = advance_paisa + ?, updated_at = ? WHERE id = ?', payment.amount, now, order.id);
    ledger.post(store, user, {
      date: now, narration: `Advance on ${order.order_no} from ${order.customer_name}`, refType: 'order', refId: order.id,
      lines: [
        { account: ledger.methodAccount(payment.method), debit: payment.amount, memo: payment.method },
        { account: A.ADVANCES, credit: payment.amount, party_type: 'customer', party_id: order.customer_id }
      ]
    });
    return paymentId;
  }

  r.post('/orders', perm('orders.manage'), (req, res) => {
    const b = req.body || {};
    const advance = readPayment(b.advance, 'Advance');
    const orderId = store.tx(() => {
      const customer = store.get('SELECT * FROM customers WHERE id = ?', id(b.customer_id, 'Customer'));
      if (!customer) throw badRequest('Choose the customer.');
      if (customer.is_walkin) throw rule('Choose or add the customer by name so the order and advance are recorded against them.');
      const purityId = b.purity_id ? id(b.purity_id, 'Purity') : null;
      const orderNo = ledger.nextNumber(store, 'order', 'ORD-', 5);
      const rowId = store.run(
        `INSERT INTO orders (order_no, customer_id, description, purity_id, expected_weight_mg, due_date, notes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        orderNo, customer.id, text(b.description, 'What is ordered', { max: 300, required: true }), purityId,
        b.expected_weight_g ? toMg(b.expected_weight_g, 'Expected weight') : null, dueDate(b.due_date),
        text(b.notes, 'Notes', { max: 300 }), nowIso(), req.user.id
      ).lastInsertRowid;
      if (advance) receiveAdvance(req.user, { id: rowId, order_no: orderNo, customer_id: customer.id, customer_name: customer.name }, advance);
      store.audit(req.user, 'create', 'order', rowId, { order_no: orderNo, customer: customer.name, advance: advance ? advance.amount : 0 });
      return rowId;
    });
    res.status(201).json(getOrder(orderId));
  });

  r.post('/orders/:id/advance', perm('orders.manage'), (req, res) => {
    const orderId = id(req.params.id);
    const payment = readPayment(req.body, 'Advance', { required: true });
    store.tx(() => {
      const order = getOrder(orderId);
      if (!['open', 'ready'].includes(order.status)) throw rule('This order is already delivered or cancelled.');
      receiveAdvance(req.user, order, payment);
      store.audit(req.user, 'advance', 'order', orderId, { amount: payment.amount, method: payment.method });
    });
    res.json(getOrder(orderId));
  });

  r.post('/orders/:id/status', perm('orders.manage'), (req, res) => {
    const orderId = id(req.params.id);
    const status = oneOf(req.body.status, 'Status', ['open', 'ready', 'cancelled']);
    store.tx(() => {
      const order = getOrder(orderId);
      if (['delivered', 'cancelled'].includes(order.status)) throw rule('This order is already delivered or cancelled.');
      const now = nowIso();
      if (status === 'cancelled' && order.available_paisa > 0) {
        // Cancelling gives back the advance that has not been used.
        const refund = readPayment({ method: req.body.refund_method, amount: order.available_paisa / 100 }, 'Refund', { required: true });
        store.run(
          "INSERT INTO order_payments (order_id, kind, method, amount_paisa, reference, paid_at, received_by) VALUES (?, 'refund', ?, ?, ?, ?, ?)",
          orderId, refund.method, refund.amount, text(req.body.reason, 'Reason', { max: 200 }), now, req.user.id);
        store.run('UPDATE orders SET refunded_paisa = refunded_paisa + ? WHERE id = ?', refund.amount, orderId);
        ledger.post(store, req.user, {
          date: now, narration: `Advance refunded on ${order.order_no} (order cancelled)`, refType: 'order', refId: orderId,
          lines: [
            { account: A.ADVANCES, debit: refund.amount, party_type: 'customer', party_id: order.customer_id },
            { account: ledger.methodAccount(refund.method), credit: refund.amount, memo: refund.method }
          ]
        });
      }
      store.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now, orderId);
      store.audit(req.user, 'status', 'order', orderId, { order_no: order.order_no, from: order.status, to: status });
    });
    res.json(getOrder(orderId));
  });

  // ------------------------------------------------ Repairs

  const REPAIR_SELECT = `
    SELECT r.*, k.name AS karigar_name, u.full_name AS created_by_name
    FROM repairs r LEFT JOIN karigars k ON k.id = r.karigar_id LEFT JOIN users u ON u.id = r.created_by`;

  const getRepair = (repairId) => {
    const repair = store.get(`${REPAIR_SELECT} WHERE r.id = ?`, repairId);
    if (!repair) throw notFound('Repair not found.');
    return repair;
  };

  r.get('/repairs', perm('repairs.manage'), (req, res) => {
    const status = req.query.status || 'active';
    res.json(store.all(
      `${REPAIR_SELECT} WHERE (? = 'all' OR (? = 'active' AND r.status IN ('received', 'ready')) OR r.status = ?)
       ORDER BY r.id DESC LIMIT 500`, status, status, status));
  });

  r.get('/repairs/:id', perm('repairs.manage'), (req, res) => res.json(getRepair(id(req.params.id))));

  r.post('/repairs', perm('repairs.manage'), (req, res) => {
    const b = req.body || {};
    const repairId = store.tx(() => {
      const customer = store.get('SELECT * FROM customers WHERE id = ?', id(b.customer_id, 'Customer'));
      if (!customer) throw badRequest('Choose the customer.');
      if (customer.is_walkin) throw rule('Choose or add the customer by name, so the piece can be returned to the right person.');
      const weightIn = toMg(b.weight_in_g, 'Weight received', { allowEmpty: false });
      if (weightIn <= 0) throw badRequest('Weigh the piece and enter its weight.');
      const repairNo = ledger.nextNumber(store, 'repair', 'REP-', 5);
      const rowId = store.run(
        `INSERT INTO repairs (repair_no, customer_id, customer_name, customer_phone, item_description, weight_in_mg, promised_date,
           estimate_paisa, karigar_id, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        repairNo, customer.id, customer.name, customer.phone, text(b.item_description, 'Item and work needed', { max: 300, required: true }),
        weightIn, dueDate(b.promised_date, 'Promised date'), toPaisa(b.estimate, 'Estimate'),
        b.karigar_id ? id(b.karigar_id, 'Karigar') : null, text(b.notes, 'Notes', { max: 300 }), nowIso(), req.user.id
      ).lastInsertRowid;
      store.audit(req.user, 'create', 'repair', rowId, { repair_no: repairNo, customer: customer.name });
      return rowId;
    });
    res.status(201).json(getRepair(repairId));
  });

  r.post('/repairs/:id/status', perm('repairs.manage'), (req, res) => {
    const repairId = id(req.params.id);
    const status = oneOf(req.body.status, 'Status', ['received', 'ready', 'cancelled']);
    store.tx(() => {
      const repair = getRepair(repairId);
      if (['delivered', 'cancelled'].includes(repair.status)) throw rule('This repair is already delivered or cancelled.');
      store.run('UPDATE repairs SET status = ? WHERE id = ?', status, repairId);
      store.audit(req.user, 'status', 'repair', repairId, { repair_no: repair.repair_no, from: repair.status, to: status });
    });
    res.json(getRepair(repairId));
  });

  r.post('/repairs/:id/deliver', perm('repairs.manage'), (req, res) => {
    const repairId = id(req.params.id);
    const b = req.body || {};
    store.tx(() => {
      const repair = getRepair(repairId);
      if (['delivered', 'cancelled'].includes(repair.status)) throw rule('This repair is already delivered or cancelled.');
      const weightOut = toMg(b.weight_out_g, 'Weight returned', { allowEmpty: false });
      if (weightOut <= 0) throw badRequest('Weigh the piece before handing it back.');
      const charge = toPaisa(b.charge, 'Repair charge');
      const payment = charge > 0 ? readPayment({ method: b.method, amount: charge / 100, reference: b.reference }, 'Payment', { required: true }) : null;
      const now = nowIso();
      store.run(
        `UPDATE repairs SET status = 'delivered', weight_out_mg = ?, charge_paisa = ?, method = ?, reference = ?, delivered_at = ? WHERE id = ?`,
        weightOut, charge, payment ? payment.method : null, payment ? payment.reference : null, now, repairId);
      if (payment) {
        ledger.post(store, req.user, {
          date: now, narration: `Repair ${repair.repair_no} for ${repair.customer_name}`, refType: 'repair', refId: repairId,
          lines: [
            { account: ledger.methodAccount(payment.method), debit: charge, memo: payment.method },
            { account: A.REPAIR_INCOME, credit: charge }
          ]
        });
      }
      store.audit(req.user, 'deliver', 'repair', repairId, {
        repair_no: repair.repair_no, weight_in_mg: repair.weight_in_mg, weight_out_mg: weightOut, charge
      });
    });
    res.json(getRepair(repairId));
  });
}

module.exports = { registerOrderRoutes };
