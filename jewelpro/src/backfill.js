'use strict';
const ledger = require('./ledger');
const metal = require('./metal');
const { postSale, postSalePayment } = require('./sales');

const { A } = ledger;

/**
 * Runs once after upgrading to version 3: posts the stock, bills and payments that were entered
 * before accounting existed, with their original dates, so the books start complete.
 */
function runAccountingBackfill(store, logger = console) {
  if (store.setting('accounting_backfill') !== 'pending') return;
  store.tx(() => {
    const system = null;
    for (const p of store.all('SELECT * FROM products ORDER BY id')) {
      ledger.post(store, system, {
        date: p.created_at, narration: `Opening stock: ${p.item_code} ${p.name}`, refType: 'product', refId: p.id, skipLock: true,
        lines: [{ account: A.STOCK, debit: p.cost_paisa }, { account: A.OPENING, credit: p.cost_paisa }]
      });
      if (p.status === 'removed') {
        ledger.post(store, system, {
          date: p.updated_at || p.created_at, narration: `Removed from stock: ${p.item_code}`, refType: 'product', refId: p.id, skipLock: true,
          lines: [{ account: A.STOCK_WRITE_OFF, debit: p.cost_paisa }, { account: A.STOCK, credit: p.cost_paisa }]
        });
      }
    }

    for (const sale of store.all('SELECT * FROM sales ORDER BY id')) {
      const cost = store.get(
        'SELECT COALESCE(SUM(p.cost_paisa), 0) AS c FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = ?', sale.id).c;
      const payments = store.all('SELECT * FROM payments WHERE sale_id = ? ORDER BY id', sale.id);
      const atSale = payments.filter((p) => p.paid_at === sale.invoice_date);
      const later = payments.filter((p) => p.paid_at !== sale.invoice_date);
      const user = { id: sale.created_by };

      for (const x of store.all('SELECT e.*, p.metal_id FROM sale_exchange_items e JOIN purities p ON p.id = e.purity_id WHERE e.sale_id = ?', sale.id)) {
        metal.add(store, user, {
          date: sale.invoice_date, metalId: x.metal_id, fineMg: x.fine_mg, grossMg: x.net_mg, purity: x.purity,
          valuePaisa: x.amount_paisa, source: 'exchange', refType: 'sale', refId: sale.id, note: `${sale.invoice_no}: ${x.description}`
        });
      }
      postSale(store, user, {
        date: sale.invoice_date, saleId: sale.id, invoiceNo: sale.invoice_no, customerId: sale.customer_id, skipLock: true,
        totals: {
          net_payable: sale.net_payable_paisa, exchange: sale.exchange_paisa, round_off: sale.round_off_paisa,
          taxable: sale.taxable_paisa, tax: sale.tax_paisa, cost
        },
        payments: atSale.map((p) => ({ method: p.method, amount: p.amount_paisa })), advance: 0
      });
      for (const p of later) {
        postSalePayment(store, user, {
          date: p.paid_at, saleId: sale.id, invoiceNo: sale.invoice_no, customerId: sale.customer_id,
          method: p.method, amount: p.amount_paisa, skipLock: true
        });
      }
      if (sale.status === 'cancelled') {
        for (const e of store.all("SELECT id FROM journal_entries WHERE ref_type = 'sale' AND ref_id = ? ORDER BY id", sale.id)) {
          const lines = store.all('SELECT * FROM journal_lines WHERE entry_id = ?', e.id);
          ledger.post(store, { id: sale.cancelled_by }, {
            date: sale.cancelled_at, narration: `Cancelled ${sale.invoice_no}`, refType: 'sale', refId: sale.id, reversesId: e.id, skipLock: true,
            lines: lines.map((l) => ({ accountId: l.account_id, debit: l.credit_paisa, credit: l.debit_paisa, party_type: l.party_type, party_id: l.party_id }))
          });
        }
        for (const x of store.all('SELECT e.*, p.metal_id FROM sale_exchange_items e JOIN purities p ON p.id = e.purity_id WHERE e.sale_id = ?', sale.id)) {
          metal.add(store, { id: sale.cancelled_by }, {
            date: sale.cancelled_at, metalId: x.metal_id, fineMg: -x.fine_mg, grossMg: -x.net_mg, purity: x.purity,
            valuePaisa: -x.amount_paisa, source: 'cancel', refType: 'sale', refId: sale.id, note: `${sale.invoice_no} cancelled`
          });
        }
      }
    }
    store.run("UPDATE settings SET value = 'done' WHERE key = 'accounting_backfill'");
    store.audit(null, 'backfill', 'accounting', null, { note: 'Existing stock and bills posted to the accounts' });
  });
  logger.log('Existing stock and bills were posted to the accounts.');
}

/**
 * Runs once after upgrading to version 5: rebuilds the stock register from the history already recorded
 * (items added, sold, bills cancelled, items removed), so opening and closing stock are right from the start.
 */
function runStockBackfill(store, logger = console) {
  if (store.setting('stock_backfill') !== 'pending') return;
  const stock = require('./stock');
  store.tx(() => {
    for (const p of store.all('SELECT * FROM products ORDER BY id')) {
      const shop = { ...p, is_private: 0 };
      const events = [{ at: p.created_at, reason: ['purchase', 'karigar'].includes(p.source) ? p.source : 'manual' }];
      for (const s of store.all(
        `SELECT s.id, s.invoice_date, s.status, s.cancelled_at FROM sale_items i JOIN sales s ON s.id = i.sale_id
         WHERE i.product_id = ? ORDER BY s.id`, p.id)) {
        events.push({ at: s.invoice_date, reason: 'sold', refType: 'sale', refId: s.id });
        if (s.status === 'cancelled') events.push({ at: s.cancelled_at, reason: 'sale_cancelled', refType: 'sale', refId: s.id });
      }
      if (p.status === 'removed') {
        const fromCancelledPurchase = p.source === 'purchase' && store.get("SELECT id FROM purchases WHERE id = ? AND status = 'cancelled'", p.source_id);
        events.push({ at: p.updated_at || p.created_at, reason: fromCancelledPurchase ? 'purchase_cancelled' : 'removed' });
      }
      if (p.is_private && p.status === 'in_stock') events.push({ at: p.updated_at || p.created_at, reason: 'to_locker' });
      events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      for (const e of events) {
        stock.record(store, null, shop, e.reason, {
          at: e.at, refType: e.refType || null, refId: e.refId || null, note: 'From records before the daily register', force: true
        });
      }
    }
    store.run("UPDATE settings SET value = 'done' WHERE key = 'stock_backfill'");
    store.audit(null, 'backfill', 'stock_register', null, { note: 'Stock register built from existing records' });
  });
  logger.log('The daily stock register was built from existing records.');
}

module.exports = { runAccountingBackfill, runStockBackfill };
