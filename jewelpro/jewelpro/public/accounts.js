'use strict';

/* ======================================================================
   Accounts: every transaction posts here automatically.
   ====================================================================== */

const ACCOUNT_VIEWS = [
  ['daybook', 'Day book'], ['ledger', 'Ledger'], ['tb', 'Trial balance'], ['pl', 'Profit and loss'],
  ['bs', 'Balance sheet'], ['expense', 'Record expense'], ['journal', 'Journal voucher'], ['chart', 'Chart of accounts']
];
const TYPE_LABELS = { asset: 'Asset', liability: 'Liability', equity: 'Capital', income: 'Income', expense: 'Expense' };

async function pageAccounts(main, _id, params) {
  const view = params.get('view') || 'daybook';
  const views = ACCOUNT_VIEWS.filter(([key]) => (key === 'journal' ? can('accounts.manage') : key === 'expense' ? can('expenses.create') : true));
  main.innerHTML = `<h1>Accounts</h1>
    <div class="toolbar no-print">${views.map(([key, label]) => `<a class="button ${key === view ? '' : 'secondary'}" href="#/accounts?view=${key}">${label}</a>`).join('')}</div>
    <div id="acc"></div>`;
  const root = $('#acc');
  const handlers = { daybook: accDaybook, ledger: accLedger, tb: accTrialBalance, pl: accProfitLoss, bs: accBalanceSheet, expense: accExpense, journal: accJournal, chart: accChart };
  await (handlers[view] || accDaybook)(root, params);
}

function periodForm(params, extra = '', { single = false } = {}) {
  const from = params.get('from') || localDate();
  const to = params.get('to') || localDate();
  const fy = state.cal && state.cal.fromDate(new Date()) ? state.cal.fiscalYearOf(state.cal.fromDate(new Date())) : null;
  const base = `#/accounts?view=${params.get('view') || 'daybook'}${extra}`;
  return `<form class="toolbar no-print" id="period">
    ${single ? dateField('As at', 'to', to) : `${dateField('From', 'from', from)}${dateField('To', 'to', to)}`}
    <button type="submit">Show</button>
    ${single ? '' : `<a class="button secondary" href="${base}&from=${periodStart('month')}&to=${localDate()}">This month</a>
      ${fy ? `<a class="button secondary" href="${base}&from=${periodStart('fiscal')}&to=${localDate()}">Fiscal year ${esc(fy.label)}</a>` : ''}`}
    <span class="spacer"></span><button type="button" class="secondary" id="acc-print">Print</button></form>`;
}

function wirePeriod(root, params, extraFn = () => '') {
  wireDateFields(root);
  $('#period', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    go(`/accounts?view=${params.get('view') || 'daybook'}${extraFn(v)}${v.from ? `&from=${v.from}` : ''}&to=${v.to}`);
  });
  $('#acc-print', root).addEventListener('click', () => window.print());
}

async function accDaybook(root, params) {
  const from = params.get('from') || localDate();
  const to = params.get('to') || localDate();
  const entries = await api('GET', `/api/accounting/daybook?from=${from}&to=${to}`);
  root.innerHTML = `${periodForm(params)}
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Entry</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${entries.map((e) => `
        <tr class="entry-head"><td>${esc(fmtDate(e.entry_date))}</td><td colspan="4"><strong>${esc(e.entry_no)}</strong> ${esc(e.narration)}
          ${e.reversed_by ? ` <span class="badge danger">Reversed by ${esc(e.reversed_by)}</span>` : ''}${e.reverses_no ? ` <span class="badge">Reverses ${esc(e.reverses_no)}</span>` : ''}
          ${can('accounts.manage') && ['expense', 'journal'].includes(e.ref_type) && !e.reversed_by && !e.reverses_id ? ` <button class="link small no-print" data-reverse="${e.id}">Reverse</button>` : ''}</td></tr>
        ${e.lines.map((l) => `<tr><td></td><td class="muted">${esc(l.memo || '')}</td><td>${esc(l.code)} ${esc(l.account_name)}</td>
          <td class="num">${l.debit_paisa ? amt(l.debit_paisa) : ''}</td><td class="num">${l.credit_paisa ? amt(l.credit_paisa) : ''}</td></tr>`).join('')}`).join('')
        || empty('No entries in this period.', 5)}</tbody>
      <tfoot><tr><td colspan="3">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</td>
        <td class="num">${amt(entries.reduce((a, e) => a + e.lines.reduce((b, l) => b + l.debit_paisa, 0), 0))}</td>
        <td class="num">${amt(entries.reduce((a, e) => a + e.lines.reduce((b, l) => b + l.credit_paisa, 0), 0))}</td></tr></tfoot>
    </table></div>`;
  wirePeriod(root, params);
  $$('[data-reverse]', root).forEach((b) => b.addEventListener('click', () => {
    const reason = prompt('Why is this entry being reversed?');
    if (!reason) return;
    attempt(async () => { await api('POST', `/api/journal/${b.dataset.reverse}/reverse`, { reason }); toast('Entry reversed.'); render(); }, b);
  }));
}

async function accLedger(root, params) {
  const accounts = await api('GET', '/api/accounts');
  const accountId = params.get('account') || (accounts.find((a) => a.code === '1000') || accounts[0]).id;
  const from = params.get('from') || periodStart('month');
  const to = params.get('to') || localDate();
  const data = await api('GET', `/api/accounting/ledger?account_id=${accountId}&from=${from}&to=${to}`);
  root.innerHTML = `
    <form class="toolbar no-print" id="period">
      ${field('Account', select('account', accounts.map((a) => [a.id, `${a.code} ${a.name}`]), accountId))}
      ${dateField('From', 'from', from)}${dateField('To', 'to', to)}<button type="submit">Show</button>
      <span class="spacer"></span><button type="button" class="secondary" id="acc-print">Print</button></form>
    <h2>${esc(data.account.code)} ${esc(data.account.name)}</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Entry</th><th>Details</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
      <tbody><tr><td colspan="5"><em>Opening balance</em></td><td class="num">${amt(data.opening_paisa)}</td></tr>
        ${data.lines.map((l) => `<tr><td>${esc(fmtDay(l.entry_date))}</td><td>${esc(l.entry_no)}</td><td>${esc(l.narration)}${l.memo ? ` <span class="muted">(${esc(l.memo)})</span>` : ''}</td>
          <td class="num">${l.debit_paisa ? amt(l.debit_paisa) : ''}</td><td class="num">${l.credit_paisa ? amt(l.credit_paisa) : ''}</td><td class="num">${amt(l.balance_paisa)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Closing balance</td><td class="num">${amt(data.lines.reduce((a, l) => a + l.debit_paisa, 0))}</td>
        <td class="num">${amt(data.lines.reduce((a, l) => a + l.credit_paisa, 0))}</td><td class="num">${amt(data.closing_paisa)}</td></tr></tfoot>
    </table></div>`;
  wireDateFields(root);
  $('#period', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    go(`/accounts?view=ledger&account=${v.account}&from=${v.from}&to=${v.to}`);
  });
  $('#acc-print', root).addEventListener('click', () => window.print());
}

async function accTrialBalance(root, params) {
  const to = params.get('to') || localDate();
  const tb = await api('GET', `/api/accounting/trial-balance?to=${to}`);
  root.innerHTML = `${periodForm(params, '', { single: true })}
    ${tb.balanced ? '' : '<div class="banner danger">The trial balance does not balance. Please report this.</div>'}
    <div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${tb.rows.map((a) => `<tr class="clickable" data-href="#/accounts?view=ledger&account=${a.id}&from=2000-01-01&to=${to}"><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(TYPE_LABELS[a.type])}</td>
        <td class="num">${a.debit_paisa ? amt(a.debit_paisa) : ''}</td><td class="num">${a.credit_paisa ? amt(a.credit_paisa) : ''}</td></tr>`).join('') || empty('Nothing posted yet.', 5)}</tbody>
      <tfoot><tr><td colspan="3">Total</td><td class="num">${amt(tb.total_debit_paisa)}</td><td class="num">${amt(tb.total_credit_paisa)}</td></tr></tfoot>
    </table></div>`;
  wirePeriod(root, params);
  bindRowLinks(root);
}

async function accProfitLoss(root, params) {
  const from = params.get('from') || periodStart('month');
  const to = params.get('to') || localDate();
  const pl = await api('GET', `/api/accounting/profit-loss?from=${from}&to=${to}`);
  const row = (a) => `<tr><td>${esc(a.name)}</td><td class="num">${amt(a.amount_paisa)}</td></tr>`;
  const income = pl.rows.filter((a) => a.type === 'income');
  const cogs = pl.rows.filter((a) => a.code === '5000');
  const expenses = pl.rows.filter((a) => a.type === 'expense' && a.code !== '5000');
  root.innerHTML = `${periodForm(params)}
    ${pl.sold_without_cost ? `<div class="banner">${pl.sold_without_cost} item(s) sold in this period had no cost price, so the profit shown is too high. Enter cost prices on stock, or buy through Purchases or Karigars so costs are recorded.</div>` : ''}
    <div class="panel" style="max-width:640px"><table>
      <tbody><tr><th colspan="2">Income</th></tr>${income.map(row).join('') || empty('None', 2)}
        <tr><td><strong>Total income</strong></td><td class="num"><strong>${amt(pl.income_paisa)}</strong></td></tr>
        <tr><th colspan="2">Cost of goods sold</th></tr>${cogs.map(row).join('') || empty('None', 2)}
        <tr><td><strong>Gross profit</strong></td><td class="num"><strong>${amt(pl.gross_profit_paisa)}</strong></td></tr>
        <tr><th colspan="2">Expenses</th></tr>${expenses.map(row).join('') || empty('None', 2)}
      </tbody>
      <tfoot><tr><td>${pl.net_profit_paisa >= 0 ? 'Net profit' : 'Net loss'}</td><td class="num">${money(pl.net_profit_paisa)}</td></tr></tfoot>
    </table></div>`;
  wirePeriod(root, params);
}

async function accBalanceSheet(root, params) {
  const to = params.get('to') || localDate();
  const bs = await api('GET', `/api/accounting/balance-sheet?to=${to}`);
  const rows = (list) => list.map((a) => `<tr><td>${esc(a.name)}</td><td class="num">${amt(a.amount_paisa)}</td></tr>`).join('') || empty('None', 2);
  root.innerHTML = `${periodForm(params, '', { single: true })}
    <div class="grid cols-2">
      <div class="panel"><h2>What the shop has</h2><table><tbody>${rows(bs.assets)}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${money(bs.total_assets_paisa)}</td></tr></tfoot></table></div>
      <div class="panel"><h2>What the shop owes, and capital</h2><table><tbody>
        <tr><th colspan="2">Owed to others</th></tr>${rows(bs.liabilities)}
        <tr><th colspan="2">Owner</th></tr>${rows(bs.equity)}
        <tr><td>Profit to date</td><td class="num">${amt(bs.profit_paisa)}</td></tr></tbody>
        <tfoot><tr><td>Total</td><td class="num">${money(bs.total_liabilities_equity_paisa)}</td></tr></tfoot></table></div>
    </div>
    ${bs.total_assets_paisa === bs.total_liabilities_equity_paisa ? '' : '<div class="banner danger">The two sides are different. Please report this.</div>'}`;
  wirePeriod(root, params);
}

async function accExpense(root) {
  const accounts = (await api('GET', '/api/accounts')).filter((a) => a.type === 'expense' && !a.is_system && a.is_active);
  root.innerHTML = `
    <form class="panel" id="expense-form" style="max-width:760px"><h2>Record an expense</h2><div class="form-grid">
      ${field('Expense type', select('account_id', accounts.map((a) => [a.id, a.name]), accounts[0] && accounts[0].id))}
      ${field('Amount (Rs)', numberInput('amount', '', 'required'))}
      ${field('Paid by', select('method', Object.entries(METHOD_LABELS), 'cash'))}
      ${dateField('Date', 'date', localDate())}
      ${field('Details', '<input name="note" required maxlength="200" placeholder="e.g. Asoj rent">', { wide: true })}
      ${field('Reference / bill no.', '<input name="reference" maxlength="100">')}
    </div><div class="actions"><button type="submit">Save expense</button></div>
    ${can('accounts.manage') ? '<p class="muted">Need another expense type? Add it under Chart of accounts.</p>' : ''}</form>`;
  wireDateFields(root);
  $('#expense-form').addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => { await api('POST', '/api/expenses', formValues(e.target)); toast('Expense saved.'); go(`/accounts?view=daybook`); }, e.submitter);
  });
}

async function accJournal(root) {
  const accounts = (await api('GET', '/api/accounts')).filter((a) => a.is_active);
  const options = [['', 'Choose…'], ...accounts.map((a) => [a.id, `${a.code} ${a.name}`])];
  root.innerHTML = `
    <form class="panel" id="journal-form"><h2>Journal voucher</h2>
      <p class="muted">For opening balances (cash, bank, dues when you start), capital put in, owner's drawings, and corrections. Debits must equal credits.
        Opening balances are usually entered against <strong>3200 Opening balances</strong>.</p>
      <div class="form-grid">${dateField('Date', 'date', localDate())}${field('Narration', '<input name="narration" required maxlength="200">', { wide: true })}</div>
      <div id="jlines" style="margin-top:1rem"></div>
      <div class="toolbar"><button type="button" class="secondary small" id="add-jline">Add line</button><span class="spacer"></span>
        <strong id="jtotals"></strong></div>
      <div class="actions"><button type="submit">Post voucher</button></div></form>`;
  wireDateFields(root);
  const totals = () => {
    const rows = lines.rows().map(rowValues);
    const d = rows.reduce((a, l) => a + Math.round((Number(l.debit) || 0) * 100), 0);
    const c = rows.reduce((a, l) => a + Math.round((Number(l.credit) || 0) * 100), 0);
    $('#jtotals').innerHTML = `Debit ${amt(d)} · Credit ${amt(c)} ${d === c && d > 0 ? '<span class="badge ok">Balanced</span>' : '<span class="badge danger">Not balanced</span>'}`;
  };
  const lines = repeater($('#jlines'), () => `${field('Account', select('account_id', options, ''))}${field('Debit (Rs)', numberInput('debit', ''))}
    ${field('Credit (Rs)', numberInput('credit', ''))}${field('Note', '<input name="memo" maxlength="100">')}`, { onChange: totals });
  lines.add();
  lines.add();
  $('#add-jline').addEventListener('click', () => lines.add());
  $('#journal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    attempt(async () => {
      await api('POST', '/api/journal', { date: v.date, narration: v.narration, lines: lines.rows().map(rowValues) });
      toast('Voucher posted.');
      go('/accounts?view=daybook');
    }, e.submitter);
  });
}

async function accChart(root) {
  const accounts = await api('GET', '/api/accounts');
  root.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Balance</th><th></th></tr></thead>
      <tbody>${accounts.map((a) => `<tr><td>${esc(a.code)}</td><td>${esc(a.name)} ${a.is_active ? '' : '<span class="badge">Off</span>'}</td><td>${esc(TYPE_LABELS[a.type])}</td>
        <td class="num"><a href="#/accounts?view=ledger&account=${a.id}&from=2000-01-01">${amt(a.balance_paisa)}</a></td>
        <td>${can('accounts.manage') && !a.is_system ? `<button class="link small" data-toggle="${a.id}">${a.is_active ? 'Switch off' : 'Switch on'}</button>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    ${can('accounts.manage') ? `<form class="panel" id="account-form" style="margin-top:1rem"><h2>Add an account</h2><div class="form-grid">
      ${field('Code', '<input name="code" required maxlength="4" pattern="\\d{4}" placeholder="6040">', { hint: 'Expenses 6000–6999, income 4000–4999.' })}
      ${field('Name', '<input name="name" required maxlength="80">')}
      ${field('Type', select('type', Object.entries(TYPE_LABELS), 'expense'))}
    </div><div class="actions"><button type="submit">Add account</button></div></form>` : ''}`;
  $$('[data-toggle]', root).forEach((b) => b.addEventListener('click', () => {
    const a = accounts.find((x) => String(x.id) === b.dataset.toggle);
    attempt(async () => { await api('PUT', `/api/accounts/${a.id}`, { name: a.name, is_active: !a.is_active }); render(); }, b);
  }));
  const form = $('#account-form');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => { await api('POST', '/api/accounts', formValues(e.target)); toast('Account added.'); render(); }, e.submitter);
  });
}
