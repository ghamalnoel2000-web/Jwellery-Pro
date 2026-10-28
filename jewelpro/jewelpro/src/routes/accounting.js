'use strict';
const { toPaisa, text, oneOf, id } = require('../units');
const { badRequest, notFound, rule } = require('../errors');
const { requirePermission: perm } = require('../auth');
const ledger = require('../ledger');
const { nowIso, dateRange, localDayStart, readPayment } = require('./common');

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
/** Assets and expenses grow with debits; the rest grow with credits. */
const naturalSign = (type) => (type === 'asset' || type === 'expense' ? 1 : -1);

function registerAccountingRoutes(r, store) {
  const accountTotals = (untilIso, fromIso = null) => store.all(
    `SELECT a.*, COALESCE(SUM(l.debit_paisa), 0) AS debit_paisa, COALESCE(SUM(l.credit_paisa), 0) AS credit_paisa
     FROM accounts a
     LEFT JOIN journal_lines l ON l.account_id = a.id
       AND l.entry_id IN (SELECT id FROM journal_entries WHERE entry_date < ? AND (? IS NULL OR entry_date >= ?))
     GROUP BY a.id ORDER BY a.code`, untilIso, fromIso, fromIso);

  const endOf = (dateText) => {
    const d = localDayStart(dateText || ledger.localDateText(nowIso()));
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
  };

  r.get('/accounts', perm('accounts.view'), (req, res) => {
    res.json(accountTotals(endOf()).map((a) => ({ ...a, balance_paisa: naturalSign(a.type) * (a.debit_paisa - a.credit_paisa) })));
  });

  r.post('/accounts', perm('accounts.manage'), (req, res) => {
    const code = text(req.body.code, 'Code', { max: 10, required: true });
    if (!/^\d{4}$/.test(code)) throw badRequest('Account code must be 4 digits, e.g. 6040.');
    const name = text(req.body.name, 'Account name', { max: 80, required: true });
    const type = oneOf(req.body.type, 'Type', TYPES);
    const newId = store.tx(() => {
      const rowId = store.run('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)', code, name, type).lastInsertRowid;
      store.audit(req.user, 'create', 'account', rowId, { code, name, type });
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM accounts WHERE id = ?', newId));
  });

  r.put('/accounts/:id', perm('accounts.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const name = text(req.body.name, 'Account name', { max: 80, required: true });
    const isActive = req.body.is_active === false || req.body.is_active === 'false' ? 0 : 1;
    store.tx(() => {
      const old = store.get('SELECT * FROM accounts WHERE id = ?', rowId);
      if (!old) throw notFound('Account not found.');
      if (old.is_system && !isActive) throw rule('This account is used by JewelPro and cannot be switched off.');
      store.run('UPDATE accounts SET name = ?, is_active = ? WHERE id = ?', name, isActive, rowId);
      store.audit(req.user, 'update', 'account', rowId, { before: old, after: { name, is_active: isActive } });
    });
    res.json(store.get('SELECT * FROM accounts WHERE id = ?', rowId));
  });

  const linesFor = (entryIds) => {
    if (!entryIds.length) return [];
    return store.all(
      `SELECT l.*, a.code, a.name AS account_name FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id IN (${entryIds.map(() => '?').join(',')}) ORDER BY l.id`, ...entryIds);
  };

  r.get('/accounting/daybook', perm('accounts.view'), (req, res) => {
    const { fromIso, toIso } = dateRange(req.query);
    const entries = store.all(
      `SELECT e.*, u.full_name AS created_by_name,
         (SELECT r.entry_no FROM journal_entries r WHERE r.reverses_id = e.id) AS reversed_by,
         (SELECT o.entry_no FROM journal_entries o WHERE o.id = e.reverses_id) AS reverses_no
       FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by
       WHERE e.entry_date >= ? AND e.entry_date < ? ORDER BY e.entry_date, e.id LIMIT 2000`, fromIso, toIso);
    const lines = linesFor(entries.map((e) => e.id));
    res.json(entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entry_id === e.id) })));
  });

  r.get('/accounting/ledger', perm('accounts.view'), (req, res) => {
    const account = store.get('SELECT * FROM accounts WHERE id = ?', id(req.query.account_id, 'Account'));
    if (!account) throw notFound('Account not found.');
    const { fromIso, toIso } = dateRange(req.query);
    const sign = naturalSign(account.type);
    const opening = sign * store.get(
      `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa), 0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.entry_date < ?`, account.id, fromIso).b;
    let running = opening;
    const rows = store.all(
      `SELECT e.id AS entry_id, e.entry_no, e.entry_date, e.narration, e.ref_type, e.ref_id, l.debit_paisa, l.credit_paisa, l.party_type, l.party_id, l.memo
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.entry_date >= ? AND e.entry_date < ? ORDER BY e.entry_date, e.id, l.id`,
      account.id, fromIso, toIso).map((row) => {
      running += sign * (row.debit_paisa - row.credit_paisa);
      return { ...row, balance_paisa: running };
    });
    res.json({ account, opening_paisa: opening, closing_paisa: running, lines: rows });
  });

  r.get('/accounting/trial-balance', perm('accounts.view'), (req, res) => {
    const rows = accountTotals(endOf(req.query.to))
      .map((a) => {
        const net = a.debit_paisa - a.credit_paisa;
        return { id: a.id, code: a.code, name: a.name, type: a.type, debit_paisa: net > 0 ? net : 0, credit_paisa: net < 0 ? -net : 0 };
      })
      .filter((a) => a.debit_paisa || a.credit_paisa);
    const totals = rows.reduce((t, a) => ({ debit: t.debit + a.debit_paisa, credit: t.credit + a.credit_paisa }), { debit: 0, credit: 0 });
    res.json({ rows, total_debit_paisa: totals.debit, total_credit_paisa: totals.credit, balanced: totals.debit === totals.credit });
  });

  r.get('/accounting/profit-loss', perm('accounts.view'), (req, res) => {
    const { fromIso, toIso } = dateRange(req.query);
    const rows = accountTotals(toIso, fromIso).filter((a) => a.type === 'income' || a.type === 'expense')
      .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, amount_paisa: a.type === 'income' ? a.credit_paisa - a.debit_paisa : a.debit_paisa - a.credit_paisa }))
      .filter((a) => a.amount_paisa !== 0);
    const income = rows.filter((a) => a.type === 'income').reduce((t, a) => t + a.amount_paisa, 0);
    const cogs = rows.filter((a) => a.code === ledger.A.COGS).reduce((t, a) => t + a.amount_paisa, 0);
    const expenses = rows.filter((a) => a.type === 'expense').reduce((t, a) => t + a.amount_paisa, 0);
    const soldWithoutCost = store.get(
      `SELECT COUNT(*) AS n FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
       WHERE s.status = 'posted' AND s.invoice_date >= ? AND s.invoice_date < ? AND p.cost_paisa = 0`, fromIso, toIso).n;
    res.json({
      rows, income_paisa: income, cogs_paisa: cogs, gross_profit_paisa: income - cogs,
      expenses_paisa: expenses, net_profit_paisa: income - expenses, sold_without_cost: soldWithoutCost
    });
  });

  r.get('/accounting/balance-sheet', perm('accounts.view'), (req, res) => {
    const all = accountTotals(endOf(req.query.to));
    const section = (type) => all.filter((a) => a.type === type)
      .map((a) => ({ id: a.id, code: a.code, name: a.name, amount_paisa: naturalSign(type) * (a.debit_paisa - a.credit_paisa) }))
      .filter((a) => a.amount_paisa !== 0);
    const sum = (rows) => rows.reduce((t, a) => t + a.amount_paisa, 0);
    const assets = section('asset');
    const liabilities = section('liability');
    const equity = section('equity');
    const profit = sum(section('income')) - sum(section('expense'));
    res.json({
      assets, liabilities, equity, profit_paisa: profit,
      total_assets_paisa: sum(assets),
      total_liabilities_equity_paisa: sum(liabilities) + sum(equity) + profit
    });
  });

  // ------------------------------------------------ Expenses and journal vouchers

  r.post('/expenses', perm('expenses.create'), (req, res) => {
    const account = store.get("SELECT * FROM accounts WHERE id = ? AND type = 'expense' AND is_active = 1", id(req.body.account_id, 'Expense type'));
    if (!account || account.is_system) throw badRequest('Choose an expense type.');
    const payment = readPayment(req.body, 'Expense', { required: true });
    const note = text(req.body.note, 'Details', { max: 200, required: true });
    const date = ledger.documentDate(req.body.date);
    const entryId = store.tx(() => {
      const rowId = ledger.post(store, req.user, {
        date, narration: `${account.name}: ${note}${payment.reference ? ` (${payment.reference})` : ''}`, refType: 'expense',
        lines: [{ accountId: account.id, debit: payment.amount }, { account: ledger.methodAccount(payment.method), credit: payment.amount, memo: payment.method }]
      });
      store.audit(req.user, 'create', 'expense', rowId, { account: account.name, amount: payment.amount, note });
      return rowId;
    });
    res.status(201).json({ id: entryId });
  });

  /** A manual journal voucher: opening balances, capital, drawings, corrections. Owner only. */
  r.post('/journal', perm('accounts.manage'), (req, res) => {
    const narration = text(req.body.narration, 'Narration', { max: 200, required: true });
    const date = ledger.documentDate(req.body.date);
    const lines = (Array.isArray(req.body.lines) ? req.body.lines : [])
      .filter((l) => l && (Number(l.debit) || Number(l.credit)))
      .map((l, i) => {
        const account = store.get('SELECT * FROM accounts WHERE id = ? AND is_active = 1', id(l.account_id, `Line ${i + 1}: account`));
        if (!account) throw badRequest(`Line ${i + 1}: choose an account.`);
        const debit = toPaisa(l.debit, `Line ${i + 1}: debit`);
        const credit = toPaisa(l.credit, `Line ${i + 1}: credit`);
        if (debit && credit) throw badRequest(`Line ${i + 1}: enter a debit or a credit, not both.`);
        return { accountId: account.id, debit, credit, memo: text(l.memo, `Line ${i + 1}: note`, { max: 100 }) };
      });
    if (lines.length < 2) throw badRequest('A journal needs at least two lines.');
    const debit = lines.reduce((a, l) => a + l.debit, 0);
    const credit = lines.reduce((a, l) => a + l.credit, 0);
    if (debit !== credit) throw rule(`Debits (${(debit / 100).toFixed(2)}) and credits (${(credit / 100).toFixed(2)}) must be equal.`);
    const entryId = store.tx(() => {
      const rowId = ledger.post(store, req.user, { date, narration, refType: 'journal', lines });
      store.audit(req.user, 'create', 'journal', rowId, { narration, lines });
      return rowId;
    });
    res.status(201).json({ id: entryId });
  });

  /** Only expenses and manual journals are reversed directly; documents are cancelled from their own page. */
  r.post('/journal/:id/reverse', perm('accounts.manage'), (req, res) => {
    const entryId = id(req.params.id);
    const reason = text(req.body.reason, 'Reason', { max: 200, required: true });
    store.tx(() => {
      const entry = store.get('SELECT * FROM journal_entries WHERE id = ?', entryId);
      if (!entry) throw notFound('Entry not found.');
      if (!['expense', 'journal'].includes(entry.ref_type)) throw rule('Cancel this from its own page (invoice, purchase, voucher).');
      ledger.assertOpen(store, entry.entry_date, 'This entry');
      ledger.reverseEntry(store, req.user, entryId, `Reversal of ${entry.entry_no}: ${reason}`);
      store.audit(req.user, 'reverse', 'journal', entryId, { entry_no: entry.entry_no, reason });
    });
    res.json({ ok: true });
  });
}

module.exports = { registerAccountingRoutes };
