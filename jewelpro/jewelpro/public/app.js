'use strict';

/* ======================================================================
   JewelPro browser app. Plain JavaScript, no build step.
   Money arrives from the server in paisa and weight in milligrams.
   ====================================================================== */

const state = { status: null, user: null, settings: {}, cache: {} };

// ---------------------------------------------------------------- Helpers

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const amt = (paisa) => {
  const value = paisa || 0;
  const text = (Math.abs(value) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `−${text}` : text;
};
const money = (paisa) => ((paisa || 0) < 0 ? `− Rs ${amt(-paisa)}` : `Rs ${amt(paisa)}`);
const rupeesInput = (paisa) => (paisa === null || paisa === undefined ? '' : String(paisa / 100));
const grams = (mg) => `${((mg || 0) / 1000).toFixed(3)} g`;
const gramsInput = (mg) => (mg === null || mg === undefined ? '' : String(mg / 1000));

const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ---- Dates: shown in Bikram Sambat (BS), AD, or both, as chosen in Settings.

const dateMode = () => (state.cal ? state.settings.date_display || 'both' : 'ad');
const adText = (date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const partsToIso = (p) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

function bsText(date) {
  const bs = state.cal && state.cal.fromDate(date);
  return bs ? `${bs.day} ${BSDate.MONTHS[bs.month - 1]} ${bs.year}` : null;
}

function dayText(date) {
  const mode = dateMode();
  const bs = mode === 'ad' ? null : bsText(date);
  if (!bs) return adText(date);
  return mode === 'bs' ? `${bs} BS` : `${bs} BS (${adText(date)})`;
}

const fmtDay = (iso) => (iso ? dayText(new Date(iso)) : '');
const fmtDate = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  return `${dayText(date)}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

/** Converts a YYYY-MM-DD (AD) text to a local Date. */
function adDate(text) {
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** A date input: BS year/month/day pickers in BS mode, the browser's date picker in AD mode. Always submits AD. */
function dateField(label, name, adValue) {
  if (dateMode() === 'ad') return field(label, `<input type="date" name="${name}" value="${esc(adValue)}">`);
  const date = adDate(adValue);
  const bs = state.cal.fromDate(date) || state.cal.fromDate(new Date());
  const firstYear = Math.max(state.cal.firstYear, bs.year - 15);
  const years = [];
  for (let y = firstYear; y <= state.cal.lastYear; y += 1) years.push(y);
  const option = (value, label2, selected) => `<option value="${value}"${value === selected ? ' selected' : ''}>${esc(label2)}</option>`;
  return `<div class="field" data-bs-date><span>${esc(label)} (BS)</span>
    <div class="bs-parts">
      <select aria-label="${esc(label)} year">${years.map((y) => option(y, y, bs.year)).join('')}</select>
      <select aria-label="${esc(label)} month">${BSDate.MONTHS.map((m, i) => option(i + 1, m, bs.month)).join('')}</select>
      <select aria-label="${esc(label)} day"></select>
    </div>
    <input type="hidden" name="${name}" value="${esc(adValue)}"><small class="ad-hint"></small></div>`;
}

function wireDateFields(root) {
  $$('[data-bs-date]', root).forEach((el) => {
    const [yearSel, monthSel, daySel] = $$('select', el);
    const hidden = $('input[type="hidden"]', el);
    let wanted = (state.cal.fromDate(adDate(hidden.value)) || { day: 1 }).day;
    const update = () => {
      const year = Number(yearSel.value);
      const month = Number(monthSel.value);
      const max = state.cal.daysInMonth(year, month);
      const day = Math.min(wanted, max);
      daySel.innerHTML = Array.from({ length: max }, (_, i) => `<option value="${i + 1}"${i + 1 === day ? ' selected' : ''}>${i + 1}</option>`).join('');
      const ad = state.cal.toAd(year, month, day);
      hidden.value = partsToIso(ad);
      $('.ad-hint', el).textContent = adText(adDate(hidden.value));
    };
    yearSel.addEventListener('change', update);
    monthSel.addEventListener('change', update);
    daySel.addEventListener('change', () => { wanted = Number(daySel.value); update(); });
    update();
  });
}

/** Start of the current month (BS month in BS mode) and of Nepal's fiscal year (1 Shrawan), as AD text. */
function periodStart(kind) {
  const today = new Date();
  const bs = state.cal && state.cal.fromDate(today);
  if (bs && (kind === 'fiscal' || dateMode() !== 'ad')) {
    const start = kind === 'fiscal' ? state.cal.toAd(state.cal.fiscalYearOf(bs).start, 4, 1) : state.cal.toAd(bs.year, bs.month, 1);
    return partsToIso(start);
  }
  return localDate(new Date(today.getFullYear(), today.getMonth(), 1));
}

async function loadCalendar() {
  state.calendarInfo = await api('GET', '/api/calendar');
  state.cal = window.BSDate ? window.BSDate.createCalendar(state.calendarInfo.overrides) : null;
}

const can = (permission) => !!state.user && state.user.permissions.includes(permission);

const METHOD_LABELS = { cash: 'Cash', bank: 'Bank transfer', card: 'Card', qr: 'QR / wallet', cheque: 'Cheque' };
const STATUS_LABELS = { in_stock: 'In stock', sold: 'Sold', removed: 'Removed', posted: 'Posted', cancelled: 'Cancelled' };
const ROLE_LABELS = { owner: 'Owner', staff: 'Staff' };

function statusBadge(status) {
  const kind = { in_stock: 'ok', posted: 'ok', sold: '', removed: 'warn', cancelled: 'danger' }[status] ?? '';
  return `<span class="badge ${kind}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-JewelPro': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  const isJson = (response.headers.get('content-type') || '').includes('json');
  const data = isJson ? await response.json() : null;
  if (response.status === 401 && !url.startsWith('/api/auth/')) {
    state.user = null;
    state.status = null;
    render();
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || `The request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `show ${kind === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 6000 : 3000);
}

/** Runs an async action from a button or form, showing any error as a message. */
async function attempt(action, button) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return values;
}

function field(label, control, { hint = '', wide = false } = {}) {
  return `<label class="field${wide ? ' wide' : ''}"><span>${esc(label)}</span>${control}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}

function input(name, value, attrs = '') {
  return `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
}

function numberInput(name, value, attrs = '') {
  return `<input type="number" name="${name}" value="${esc(value ?? '')}" step="any" min="0" inputmode="decimal" ${attrs}>`;
}

function select(name, options, selected, attrs = '') {
  return `<select name="${name}" ${attrs}>${options.map(([value, label]) =>
    `<option value="${esc(value)}"${String(value) === String(selected ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

async function cached(key, url) {
  if (!state.cache[key]) state.cache[key] = await api('GET', url);
  return state.cache[key];
}

function clearCache(...keys) {
  for (const key of keys) delete state.cache[key];
}

function empty(message, colspan) {
  return `<tr><td colspan="${colspan}" class="muted">${esc(message)}</td></tr>`;
}

// ---------------------------------------------------------------- Routing

const routes = [
  [/^\/$/, pageDashboard],
  [/^\/billing$/, pageBilling],
  [/^\/sales$/, pageSales],
  [/^\/sales\/(\d+)$/, pageInvoice],
  [/^\/products$/, pageProducts],
  [/^\/products\/new$/, pageProductForm],
  [/^\/products\/(\d+)$/, pageProductForm],
  [/^\/labels$/, pageLabels],
  [/^\/categories$/, pageCategories],
  [/^\/stock-register$/, pageStockRegister],
  [/^\/customers$/, pageCustomers],
  [/^\/rates$/, pageRates],
  [/^\/reports$/, pageReports],
  [/^\/settings$/, pageSettings],
  [/^\/users$/, pageUsers],
  [/^\/audit$/, pageAudit],
  [/^\/backup$/, pageBackup],
  [/^\/purchases$/, pagePurchases],
  [/^\/purchases\/new$/, pagePurchaseNew],
  [/^\/purchases\/(\d+)$/, pagePurchaseView],
  [/^\/suppliers$/, pageSuppliers],
  [/^\/suppliers\/(\d+)$/, pageSupplier],
  [/^\/metal$/, pageMetal],
  [/^\/old-gold$/, pageOldGoldList],
  [/^\/old-gold\/new$/, pageOldGoldNew],
  [/^\/old-gold\/(\d+)$/, pageOldGoldView],
  [/^\/karigars$/, pageKarigars],
  [/^\/karigars\/(\d+)$/, pageKarigar],
  [/^\/jobs$/, pageJobs],
  [/^\/jobs\/new$/, pageJobNew],
  [/^\/jobs\/(\d+)$/, pageJob],
  [/^\/orders$/, pageOrders],
  [/^\/orders\/new$/, pageOrderNew],
  [/^\/orders\/(\d+)$/, pageOrder],
  [/^\/repairs$/, pageRepairs],
  [/^\/repairs\/new$/, pageRepairNew],
  [/^\/repairs\/(\d+)$/, pageRepair],
  [/^\/accounts$/, pageAccounts]
];

function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  return { path, params: new URLSearchParams(query) };
}

function go(path) {
  location.hash = `#${path}`;
}

async function render() {
  try {
    if (!state.status) {
      state.status = await api('GET', '/api/auth/status');
      state.user = state.status.user;
      if (state.user && !state.user.must_change_password) {
        state.settings = await api('GET', '/api/settings');
        await loadCalendar();
      }
    }
  } catch (err) {
    $('#app').innerHTML = `<div class="login-wrap"><div class="login-card"><h2>JewelPro cannot be reached</h2>
      <p>${esc(err.message)}</p><p class="muted">Check that the JewelPro window is still open on the shop computer, then reload this page.</p></div></div>`;
    return;
  }

  if (!state.user) return state.status.needs_setup ? renderSetup() : renderLogin();
  if (state.user.must_change_password) return renderChangePassword();

  renderShell();
  const { path, params } = currentRoute();
  const main = $('#main');
  for (const [pattern, page] of routes) {
    const match = path.match(pattern);
    if (match) {
      main.innerHTML = '<p class="muted">Loading…</p>';
      try {
        await page(main, match[1], params);
      } catch (err) {
        main.innerHTML = `<div class="banner danger">${esc(err.message)}</div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  main.innerHTML = '<h1>Page not found</h1><p><a href="#/">Go to the dashboard</a></p>';
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);

// ---------------------------------------------------------------- Login, setup, password

function renderLogin() {
  $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="brand-mark">JewelPro</div>
      <p class="muted">${esc(state.status.shop_name)}</p>
      <form id="login-form">
        ${field('Username', '<input name="username" autocomplete="username" required autofocus>')}
        ${field('Password', '<input name="password" type="password" autocomplete="current-password" required>')}
        <button type="submit">Log in</button>
      </form>
    </div></div>`;
  $('#login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const button = event.submitter;
    attempt(async () => {
      const result = await api('POST', '/api/auth/login', formValues(event.target));
      state.status = null;
      state.user = result.user;
      await render();
    }, button);
  });
}

function renderSetup() {
  $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="brand-mark">Welcome to JewelPro</div>
      <p>Create the owner account. The owner can do everything, including adding staff accounts later.</p>
      <form id="setup-form">
        ${field('Your full name', '<input name="full_name" required autofocus>')}
        ${field('Username', '<input name="username" required autocomplete="username" pattern="[A-Za-z0-9._\\-]+">', { hint: 'Letters and numbers, no spaces.' })}
        ${field('Password', '<input name="password" type="password" required autocomplete="new-password">', { hint: 'At least 8 characters, with a letter and a number.' })}
        ${field('Repeat password', '<input name="password2" type="password" required autocomplete="new-password">')}
        <button type="submit">Create owner account</button>
      </form>
    </div></div>`;
  $('#setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);
    if (values.password !== values.password2) return toast('The two passwords are different.', 'error');
    attempt(async () => {
      await api('POST', '/api/auth/setup', values);
      state.status = null;
      toast('Owner account created. Next, set your shop details in Settings.');
      location.hash = '#/settings';
      await render();
    }, event.submitter);
  });
}

function renderChangePassword() {
  $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="brand-mark">Choose a new password</div>
      <p>Hello ${esc(state.user.full_name)}. Please replace the password you were given with one only you know.</p>
      <form id="pw-form">
        ${field('Current password', '<input name="current_password" type="password" required autocomplete="current-password">')}
        ${field('New password', '<input name="new_password" type="password" required autocomplete="new-password">', { hint: 'At least 8 characters, with a letter and a number.' })}
        ${field('Repeat new password', '<input name="new_password2" type="password" required autocomplete="new-password">')}
        <button type="submit">Save new password</button>
        <button type="button" class="secondary" id="pw-logout">Log out</button>
      </form>
    </div></div>`;
  $('#pw-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);
    if (values.new_password !== values.new_password2) return toast('The two new passwords are different.', 'error');
    attempt(async () => {
      await api('POST', '/api/auth/change-password', values);
      state.status = null;
      toast('Password changed.');
      await render();
    }, event.submitter);
  });
  $('#pw-logout').addEventListener('click', logout);
}

async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.status = null;
  state.user = null;
  state.cache = {};
  location.hash = '#/';
  render();
}

// ---------------------------------------------------------------- Shell

function renderShell() {
  // [href, label, visible, class, other paths that highlight this link]
  const links = [
    ['/billing', 'New bill', can('sales.create'), 'primary'],
    ['/', 'Dashboard', true],
    ['#', 'Sales', true, 'heading'],
    ['/sales', 'Invoices', can('sales.view')],
    ['/orders', 'Orders', can('orders.manage')],
    ['/repairs', 'Repairs', can('repairs.manage')],
    ['/customers', 'Customers', can('customers.view')],
    ['#', 'Stock', true, 'heading'],
    ['/products', 'Stock', can('products.view'), '', ['/labels', '/categories']],
    ['/stock-register', 'Daily stock register', can('stockreg.view')],
    ['/purchases', 'Purchases', can('purchases.manage'), '', ['/suppliers']],
    ['/metal', 'Metal and old gold', can('metal.manage'), '', ['/old-gold']],
    ['/karigars', 'Karigars', can('karigars.manage'), '', ['/jobs']],
    ['#', 'Money', true, 'heading'],
    ['/accounts', 'Accounts', can('accounts.view')],
    ['/reports', 'Reports', can('reports.view')],
    ['#', 'Shop', true, 'heading'],
    ['/rates', "Today's rates", can('rates.view')],
    ['/settings', 'Settings', can('settings.view')],
    ['/users', 'Staff accounts', can('users.manage')],
    ['/audit', 'Audit log', can('audit.view')],
    ['/backup', 'Backup', can('backup.run')]
  ].filter((l) => l[2])
    // drop headings with nothing under them
    .filter((l, i, all) => l[3] !== 'heading' || (all[i + 1] && all[i + 1][3] !== 'heading'));

  if (!$('#main')) {
    $('#app').innerHTML = `
      <div class="shell">
        <aside class="side" id="side">
          <div class="brand">JewelPro<small>${esc(state.settings.shop_name || '')}</small></div>
          <button class="secondary small menu-toggle" id="menu-toggle" aria-label="Menu">Menu</button>
          <nav id="nav"></nav>
          <div class="who">${esc(state.user.full_name)}<br><span style="color:#b8cdc3">${esc(ROLE_LABELS[state.user.role])}</span>
            <button class="secondary small" id="logout">Log out</button></div>
        </aside>
        <main class="main" id="main"></main>
      </div>`;
    $('#logout').addEventListener('click', logout);
    $('#menu-toggle').addEventListener('click', () => $('#side').classList.toggle('open'));
  }
  const { path } = currentRoute();
  $('#nav').innerHTML = links.map(([href, label, , cls, also = []]) => {
    if (cls === 'heading') return `<div class="nav-heading">${esc(label)}</div>`;
    const active = href === '/' ? path === '/' : [href, ...also].some((h) => path === h || path.startsWith(`${h}/`));
    return `<a href="#${href}" class="${cls || ''} ${active ? 'active' : ''}">${esc(label)}</a>`;
  }).join('');
  $('#side').classList.remove('open');
}

// ---------------------------------------------------------------- Dashboard

async function pageDashboard(main) {
  const d = await api('GET', '/api/reports/dashboard');
  const missing = d.rates.filter((r) => !r.updated_at);
  const stale = d.rates.filter((r) => r.updated_at && !isToday(r.updated_at));
  const unitLabel = { tola: 'per tola', '10g': 'per 10 g', gram: 'per gram' };

  const now = new Date();
  const todayBs = state.cal && state.cal.fromDate(now);
  let calendarWarning = '';
  if (state.cal && can('settings.manage')) {
    if (!todayBs) calendarWarning = 'Today is past the end of the Nepali calendar in JewelPro, so dates are shown in AD.';
    else {
      const soon = state.cal.fromDate(new Date(now.getTime() + 60 * 86400000));
      const check = [todayBs.year, soon ? soon.year : todayBs.year + 1].filter((y, i, a) => a.indexOf(y) === i)
        .filter((y) => ['provisional', 'missing'].includes(state.cal.status(y)));
      if (check.length) calendarWarning = `The Nepali calendar for ${check.join(' and ')} is not confirmed yet.`;
    }
  }

  main.innerHTML = `
    <h1>Dashboard</h1>
    <p class="muted" style="margin-top:-.6rem">${esc(now.toLocaleDateString('en-GB', { weekday: 'long' }))}, ${esc(dayText(now))}</p>
    ${calendarWarning ? `<div class="banner">${esc(calendarWarning)} <a href="#/settings?section=calendar">Check the month lengths against the official patro</a>.</div>` : ''}
    ${missing.length ? `<div class="banner danger">No rate has been entered yet for ${esc(missing.map((r) => `${r.metal_name} ${r.purity_name}`).join(', '))}.
      ${can('rates.update') ? '<a href="#/rates">Enter rates</a>' : 'Ask the owner or staff to enter rates.'}</div>` : ''}
    ${!missing.length && stale.length ? `<div class="banner">Rates were last updated on ${esc(fmtDay(stale[0].updated_at))}.
      ${can('rates.update') ? '<a href="#/rates">Update today\'s rates</a>' : ''}</div>` : ''}
    <div class="grid cols-4">
      <div class="panel stat"><div class="label">Sales today</div><div class="value">${money(d.today.sales_paisa)}</div>
        <div class="sub">${d.today.invoices} invoice${d.today.invoices === 1 ? '' : 's'}</div></div>
      <div class="panel stat"><div class="label">Received today</div>
        <div class="value">${money(d.received.reduce((a, r) => a + r.amount_paisa, 0))}</div>
        <div class="sub">${d.received.map((r) => `${esc(METHOD_LABELS[r.method])} ${money(r.amount_paisa)}`).join('<br>') || 'Nothing yet'}</div></div>
      <div class="panel stat"><div class="label">In stock</div><div class="value">${d.stock.pieces} pieces</div>
        <div class="sub">${grams(d.stock.gross_mg)} gross</div></div>
      ${d.dues ? `<div class="panel stat"><div class="label">Customer dues</div><div class="value">${money(d.dues.due_paisa)}</div>
        <div class="sub">${d.dues.invoices} unpaid invoice${d.dues.invoices === 1 ? '' : 's'}</div></div>` : ''}
    </div>
    ${workPanel(d.work)}
    <div class="grid cols-2">
      <div class="panel"><h2>Current rates</h2>
        <div class="table-wrap"><table><thead><tr><th>Metal</th><th class="num">Selling</th><th class="num">Buying</th><th>Updated</th></tr></thead><tbody>
        ${d.rates.map((r) => `<tr><td>${esc(r.metal_name)} ${esc(r.purity_name)}</td>
          <td class="num">${r.updated_at ? `${money(r.entered_sell_paisa)} <span class="muted">${unitLabel[r.entered_unit]}</span>` : '—'}</td>
          <td class="num">${r.updated_at ? money(r.entered_buy_paisa) : '—'}</td>
          <td>${r.updated_at ? esc(fmtDate(r.updated_at)) : '<span class="error-text">Not set</span>'}</td></tr>`).join('')}
        </tbody></table></div></div>
      ${can('sales.view') ? `<div class="panel"><h2>Latest invoices</h2>
        <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th class="num">Amount</th><th></th></tr></thead><tbody>
        ${d.recent.map((s) => `<tr class="clickable" data-href="#/sales/${s.id}"><td>${esc(s.invoice_no)}<br><small class="muted">${esc(fmtDate(s.invoice_date))}</small></td>
          <td>${esc(s.customer_name)}</td><td class="num">${money(s.net_payable_paisa)}</td><td>${s.status === 'cancelled' ? statusBadge(s.status) : ''}</td></tr>`).join('')
          || empty('No invoices yet.', 4)}
        </tbody></table></div></div>` : ''}
    </div>`;
  bindRowLinks(main);
}

/** Things waiting for attention: karigar jobs, orders, repairs, cash. */
function workPanel(w) {
  if (!w) return '';
  const items = [
    [w.overdue_jobs, (n) => `${n} karigar job${n === 1 ? ' is' : 's are'} overdue`, '#/jobs', 'danger'],
    [w.orders_due, (n) => `${n} order${n === 1 ? ' is' : 's are'} due today or late`, '#/orders', 'warn'],
    [w.orders_ready, (n) => `${n} order${n === 1 ? ' is' : 's are'} ready to hand over`, '#/orders', 'ok'],
    [w.repairs_due, (n) => `${n} repair${n === 1 ? ' is' : 's are'} due today or late`, '#/repairs', 'warn'],
    [w.repairs_ready, (n) => `${n} repair${n === 1 ? ' is' : 's are'} ready for collection`, '#/repairs', 'ok']
  ].filter(([n]) => n > 0);
  if (!items.length && w.cash_paisa === null) return '';
  return `<div class="panel"><div class="toolbar" style="margin:0;align-items:center">
    ${items.map(([n, text, href, kind]) => `<a class="badge ${kind}" style="padding:.35rem .6rem;text-decoration:none" href="${href}">${esc(text(n))}</a>`).join('')
      || '<span class="muted">No karigar jobs, orders or repairs waiting.</span>'}
    <span class="spacer"></span>${w.cash_paisa !== null ? `<a href="#/accounts?view=ledger" style="text-decoration:none"><span class="muted">Cash in hand (books)</span> <strong>${money(w.cash_paisa)}</strong></a>` : ''}
  </div></div>`;
}

function bindRowLinks(root) {
  $$('tr[data-href]', root).forEach((row) => row.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input, select')) return;
    location.hash = row.dataset.href;
  }));
}

// ---------------------------------------------------------------- Billing

async function pageBilling(main, _id, params = new URLSearchParams()) {
  const [purities, customers] = await Promise.all([
    cached('purities', '/api/purities'),
    api('GET', '/api/customers')
  ]);
  const settings = state.settings;
  const bill = {
    customer_id: customers.find((c) => c.is_walkin)?.id || '',
    items: [],
    exchange: [],
    discount: '',
    payments: [{ method: 'cash', amount: '', reference: '' }],
    remarks: '',
    order_id: params.get('order') || ''
  };
  if (params.get('customer') && customers.some((c) => String(c.id) === params.get('customer'))) bill.customer_id = params.get('customer');
  let customerOrders = [];
  let preview = null;
  let previewError = '';
  let previewTimer;
  let customerList = customers;
  const purityOptions = purities.filter((p) => p.is_active).map((p) => [p.id, `${p.metal_name} ${p.name}`]);

  main.innerHTML = `
    <h1>New bill</h1>
    <div class="billing">
      <div>
        <div class="panel">
          <div class="toolbar" style="margin-bottom:.5rem">
            <label class="field" style="flex:1;min-width:220px"><span>Customer</span>
              <select id="customer"></select></label>
            <label class="field" style="width:180px"><span>Find customer</span>
              <input id="customer-search" placeholder="Name or phone"></label>
            <button class="secondary" id="new-customer-btn">New customer</button>
          </div>
          <form id="new-customer" class="form-grid" hidden>
            ${field('Name', '<input name="name" required>')}
            ${field('Phone', '<input name="phone">')}
            ${field('Address', '<input name="address">')}
            ${field('PAN', '<input name="pan">')}
            <div class="actions"><button type="submit">Add customer</button></div>
          </form>
          <div id="order-box"></div>
        </div>

        <div class="panel">
          <h2>Items</h2>
          <form class="scan-row" id="scan-form">
            <input id="scan" placeholder="Scan the tag or type the item code, then press Enter" autocomplete="off" autofocus>
            <button type="submit">Add</button>
          </form>
          <div class="table-wrap" style="margin-top:.75rem"><table id="items"></table></div>
        </div>

        <div class="panel">
          <div class="toolbar" style="margin-bottom:.5rem"><h2 style="margin:0">Old gold exchange</h2><span class="spacer"></span>
            <button class="secondary small" id="add-exchange">Add old gold</button></div>
          <div id="exchange"></div>
          <p class="muted" style="margin:0">Value = (weight − less weight) × (100% − refining %) × today's buying rate for that purity.</p>
        </div>

        <div class="panel">
          <div class="form-grid">
            ${field('Discount (Rs)', numberInput('discount', '', 'id="discount"'),
              { hint: can('sales.discount_over_limit') ? '' : `Up to ${settings.cashier_max_discount_percent || 0}% without the owner.` })}
            ${field('Remarks', '<input id="remarks" maxlength="300">', { wide: false })}
          </div>
        </div>
      </div>

      <div class="panel bill-total" id="totals"></div>
    </div>`;

  // ---- customers
  function renderCustomerOptions() {
    $('#customer').innerHTML = customerList.map((c) =>
      `<option value="${c.id}"${String(c.id) === String(bill.customer_id) ? ' selected' : ''}>${esc(c.name)}${c.phone ? ` — ${esc(c.phone)}` : ''}${c.due_paisa > 0 ? ` (due ${money(c.due_paisa)})` : ''}</option>`).join('');
    if (!customerList.some((c) => String(c.id) === String(bill.customer_id)) && customerList[0]) {
      bill.customer_id = customerList[0].id;
    }
  }
  renderCustomerOptions();

  // ---- customer order advances
  async function loadOrders(keepOrder = false) {
    if (!keepOrder) bill.order_id = '';
    customerOrders = [];
    const customer = customerList.find((c) => String(c.id) === String(bill.customer_id));
    if (customer && !customer.is_walkin && can('orders.manage')) {
      customerOrders = (await api('GET', `/api/orders?status=active&customer_id=${customer.id}`)).filter((o) => o.available_paisa > 0);
    }
    if (bill.order_id && !customerOrders.some((o) => String(o.id) === String(bill.order_id))) bill.order_id = '';
    $('#order-box').innerHTML = customerOrders.length ? `<div class="form-grid" style="margin-top:.5rem">
      ${field('Use order advance', select('order', [['', 'Do not use an advance'], ...customerOrders.map((o) => [o.id, `${o.order_no}: ${o.description.slice(0, 40)} (advance ${money(o.available_paisa)})`])], bill.order_id))}</div>` : '';
    const sel = $('#order-box select');
    if (sel) sel.addEventListener('change', (e) => { bill.order_id = e.target.value; schedulePreview(0); });
    schedulePreview(0);
  }
  const customerChanged = () => loadOrders().catch((err) => toast(err.message, 'error'));

  $('#customer').addEventListener('change', (e) => { bill.customer_id = e.target.value; customerChanged(); });
  let searchTimer;
  $('#customer-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      customerList = await api('GET', `/api/customers?q=${encodeURIComponent(e.target.value)}`);
      if (customerList[0]) bill.customer_id = customerList[0].id;
      renderCustomerOptions();
      customerChanged();
    }, 250);
  });
  $('#new-customer-btn').addEventListener('click', () => {
    const form = $('#new-customer');
    form.hidden = !form.hidden;
    if (!form.hidden) $('input[name="name"]', form).focus();
  });
  $('#new-customer').addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(async () => {
      const created = await api('POST', '/api/customers', formValues(event.target));
      customerList = [created, ...customerList];
      bill.customer_id = created.id;
      renderCustomerOptions();
      customerChanged();
      event.target.reset();
      event.target.hidden = true;
      toast(`${created.name} added.`);
      $('#scan').focus();
    }, event.submitter);
  });

  // ---- items
  $('#scan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('#scan').value.trim();
    if (!code) return;
    attempt(async () => {
      const product = await api('GET', `/api/products/by-code/${encodeURIComponent(code)}`);
      $('#scan').value = '';
      if (product.status !== 'in_stock') throw new Error(`${product.item_code} is ${STATUS_LABELS[product.status].toLowerCase()}, it cannot be sold.`);
      if (bill.items.some((i) => i.product_id === product.id)) throw new Error(`${product.item_code} is already on this bill.`);
      bill.items.push({ product_id: product.id, product });
      renderItems();
      schedulePreview(0);
    }).finally(() => $('#scan').focus());
  });

  function renderItems() {
    const lines = preview && preview.items.length === bill.items.length ? preview.items : null;
    const showTax = !!(preview && preview.totals.tax_summary.length);
    const cols = showTax ? 7 : 6;
    $('#items').innerHTML = `
      <thead><tr><th>Item</th><th class="num">Net wt</th><th class="num">Metal (Rs)</th><th class="num">Making</th>
        <th class="num">Stones, other</th>${showTax ? '<th class="num">Tax</th>' : ''}<th class="num">${preview && preview.totals.discount ? 'After discount (Rs)' : 'Amount (Rs)'}</th></tr></thead>
      <tbody>${bill.items.map((item, i) => {
    const p = item.product;
    const l = lines ? lines[i] : null;
    return `<tr${l ? ` title="${esc(l.method)}"` : ''}>
          <td class="item-cell"><strong>${esc(p.item_code)}</strong> ${esc(p.name)}
            <br><small class="muted">${esc(p.metal_name)} ${esc(p.purity_name)}, gross ${grams(p.gross_mg)}${l && l.wastage_mg ? `, wastage ${grams(l.wastage_mg)}` : ''}</small>
            <br><button class="link small" data-remove="${i}">Remove</button></td>
          <td class="num">${grams(p.gross_mg - p.stone_mg - p.other_less_mg)}</td>
          <td class="num">${l ? amt(l.metal) : '…'}</td>
          <td class="num">${l ? amt(l.making) : '…'}</td>
          <td class="num">${l ? amt(l.stones + l.other) : '…'}</td>
          ${showTax ? `<td class="num">${l ? amt(l.tax) : '…'}</td>` : ''}
          <td class="num"><strong>${l ? amt(l.total) : '…'}</strong></td></tr>`;
  }).join('') || empty('Scan an item to start the bill.', cols)}</tbody>`;
    $$('[data-remove]', $('#items')).forEach((b) => b.addEventListener('click', () => {
      bill.items.splice(Number(b.dataset.remove), 1);
      renderItems();
      schedulePreview(0);
    }));
  }

  // ---- old gold
  $('#add-exchange').addEventListener('click', () => {
    bill.exchange.push({ description: 'Old gold', purity_id: purityOptions[1]?.[0] || purityOptions[0]?.[0], gross_g: '', less_g: '', refining_percent: '' });
    renderExchange();
  });

  function renderExchange() {
    $('#exchange').innerHTML = bill.exchange.map((x, i) => `
      <div class="form-grid" data-ex="${i}" style="margin-bottom:.6rem;align-items:end">
        ${field('Description', input('description', x.description, 'maxlength="100"'))}
        ${field('Purity', select('purity_id', purityOptions, x.purity_id))}
        ${field('Weight (g)', numberInput('gross_g', x.gross_g))}
        ${field('Less weight (g)', numberInput('less_g', x.less_g))}
        ${field('Refining %', numberInput('refining_percent', x.refining_percent, 'max="100"'))}
        <div><div class="muted" style="font-size:.9rem">Value</div><strong id="ex-amt-${i}">…</strong>
          <button class="link small" data-remove-ex="${i}" style="margin-left:.5rem">Remove</button></div>
      </div>`).join('');
    $$('[data-ex]', $('#exchange')).forEach((row) => {
      const i = Number(row.dataset.ex);
      $$('input, select', row).forEach((el) => el.addEventListener('input', () => {
        bill.exchange[i][el.name] = el.value;
        schedulePreview();
      }));
    });
    $$('[data-remove-ex]', $('#exchange')).forEach((b) => b.addEventListener('click', () => {
      bill.exchange.splice(Number(b.dataset.removeEx), 1);
      renderExchange();
      schedulePreview(0);
    }));
    updateExchangeAmounts();
  }

  function updateExchangeAmounts() {
    bill.exchange.forEach((_, i) => {
      const el = $(`#ex-amt-${i}`);
      const x = preview && preview.exchange[i];
      if (el) el.textContent = x ? `${money(x.amount)} (fine ${grams(x.fine_mg)})` : '…';
    });
  }

  $('#discount').addEventListener('input', (e) => { bill.discount = e.target.value; schedulePreview(); });
  $('#remarks').addEventListener('input', (e) => { bill.remarks = e.target.value; });

  // ---- totals and payments
  function renderTotals() {
    const t = preview && preview.totals;
    const advance = t ? t.advance : 0;
    const paid = advance + bill.payments.reduce((a, p) => a + (Number(p.amount) > 0 ? Math.round(Number(p.amount) * 100) : 0), 0);
    const due = t ? t.net_payable - paid : 0;
    const overpaid = t && due < 0;
    const walkIn = customerList.find((c) => String(c.id) === String(bill.customer_id))?.is_walkin;
    $('#totals').innerHTML = `
      <h2>Bill total</h2>
      ${t ? `
        <div class="row"><span>Items</span><span>${money(t.subtotal)}</span></div>
        ${t.discount ? `<div class="row minus"><span>Discount</span><span>${money(t.discount)}</span></div>` : ''}
        ${t.tax_summary.map((x) => `<div class="row"><span>${esc(x.name)}</span><span>${money(x.amount)}</span></div>`).join('')}
        <div class="row"><strong>Total</strong><strong>${money(t.grand_total)}</strong></div>
        ${t.exchange ? `<div class="row minus"><span>Old gold</span><span>${money(t.exchange)}</span></div>` : ''}
        ${t.round_off ? `<div class="row"><span>Rounding</span><span>${money(t.round_off)}</span></div>` : ''}
        <div class="payable"><div class="label">Customer pays</div><div class="amount">${money(t.net_payable)}</div></div>
        ${advance ? `<div class="row minus"><span>Order advance (${esc(preview.order.order_no)})</span><span>${money(advance)}</span></div>
          <div class="row"><strong>Still to pay</strong><strong>${money(t.net_payable - advance)}</strong></div>` : ''}`
      : '<p class="muted">Scan an item to see the total.</p>'}
      ${previewError ? `<div class="banner danger preview-error">${esc(previewError)}</div>` : ''}
      <h3>Payment received</h3>
      <div id="payments">${bill.payments.map((p, i) => `
        <div class="pay-row" data-pay="${i}">
          ${select('method', Object.entries(METHOD_LABELS), p.method)}
          ${numberInput('amount', p.amount, 'placeholder="Amount (Rs)"')}
          <button class="link small" data-remove-pay="${i}" title="Remove payment" aria-label="Remove payment">✕</button>
          ${p.method !== 'cash' ? input('reference', p.reference, 'class="ref" placeholder="Reference / transaction no."') : ''}
        </div>`).join('')}</div>
      <div class="actions" style="margin-top:.25rem">
        <button class="secondary small" id="add-payment">Split payment</button>
        ${t ? '<button class="secondary small" id="pay-full">Paid in full</button>' : ''}
      </div>
      ${t ? `<div class="row" style="margin-top:.75rem"><span>${due > 0 ? 'Balance due' : 'Balance'}</span>
        <strong class="${due < 0 ? 'error-text' : ''}">${money(due)}</strong></div>` : ''}
      ${overpaid ? '<div class="banner danger preview-error">The payment is more than the customer pays. Reduce the amount.</div>' : ''}
      ${t && due > 0 && walkIn ? '<p class="muted" style="margin:.5rem 0 0">A walk-in customer must pay in full. To keep a balance due, choose or add the customer.</p>' : ''}
      <div class="actions">
        <button class="gold" id="save-bill" ${!t || previewError || overpaid ? 'disabled' : ''}>Save and print</button>
        <button class="secondary" id="clear-bill">Clear</button>
      </div>`;

    $$('[data-pay]', $('#totals')).forEach((row) => {
      const i = Number(row.dataset.pay);
      $$('input, select', row).forEach((el) => el.addEventListener('input', () => {
        bill.payments[i][el.name] = el.value;
        if (el.name === 'method') renderTotals();
        else updateDue();
      }));
    });
    $$('[data-remove-pay]', $('#totals')).forEach((b) => b.addEventListener('click', () => {
      bill.payments.splice(Number(b.dataset.removePay), 1);
      if (!bill.payments.length) bill.payments.push({ method: 'cash', amount: '', reference: '' });
      renderTotals();
    }));
    $('#add-payment').addEventListener('click', () => {
      bill.payments.push({ method: 'qr', amount: '', reference: '' });
      renderTotals();
    });
    const payFull = $('#pay-full');
    if (payFull) payFull.addEventListener('click', () => {
      const others = bill.payments.slice(1).reduce((a, p) => a + (Number(p.amount) > 0 ? Math.round(Number(p.amount) * 100) : 0), 0);
      bill.payments[0].amount = String(Math.max(0, t.net_payable - t.advance - others) / 100);
      renderTotals();
    });
    $('#clear-bill').addEventListener('click', () => {
      if (bill.items.length && !confirm('Clear this bill?')) return;
      if (location.hash === '#/billing') pageBilling(main);
      else go('/billing');
    });
    $('#save-bill').addEventListener('click', (e) => attempt(async () => {
      const sale = await api('POST', '/api/sales', payload());
      toast(`Invoice ${sale.invoice_no} saved.`);
      go(`/sales/${sale.id}?print=1`);
    }, e.target));
  }

  function updateDue() {
    // Re-render keeps the payment inputs; focus is restored to the field being typed in.
    const active = document.activeElement;
    const row = active && active.closest('[data-pay]');
    const name = active && active.name;
    renderTotals();
    if (row) {
      const el = $(`[data-pay="${row.dataset.pay}"] [name="${name}"]`);
      if (el) { el.focus(); const v = el.value; if (el.type !== 'number') el.setSelectionRange?.(v.length, v.length); }
    }
  }

  function payload() {
    return {
      customer_id: bill.customer_id,
      items: bill.items.map((i) => ({ product_id: i.product_id })),
      exchange: bill.exchange,
      discount: bill.discount,
      payments: bill.payments,
      remarks: bill.remarks,
      order_id: bill.order_id || undefined,
      use_advance: bill.order_id && preview ? preview.totals.advance / 100 : undefined
    };
  }

  function schedulePreview(delay = 300) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, delay);
  }

  async function runPreview() {
    if (!bill.items.length) {
      preview = null;
      previewError = '';
      renderItems();
      renderTotals();
      updateExchangeAmounts();
      return;
    }
    try {
      const request = payload();
      request.payments = []; // payments are checked when saving
      delete request.use_advance; // the server offers as much advance as fits
      preview = await api('POST', '/api/sales/preview', request);
      previewError = '';
    } catch (err) {
      previewError = err.message;
      preview = null;
    }
    renderItems();
    renderTotals();
    updateExchangeAmounts();
  }

  renderItems();
  renderExchange();
  renderTotals();
  loadOrders(true).catch((err) => toast(err.message, 'error'));
}

// ---------------------------------------------------------------- Invoices

async function pageSales(main, _id, params) {
  const from = params.get('from') || localDate();
  const to = params.get('to') || localDate();
  const q = params.get('q') || '';
  const rows = await api('GET', `/api/sales?from=${from}&to=${to}&q=${encodeURIComponent(q)}`);
  const posted = rows.filter((r) => r.status === 'posted');
  main.innerHTML = `
    <h1>Invoices</h1>
    <form class="toolbar" id="filter">
      ${dateField('From', 'from', from)}
      ${dateField('To', 'to', to)}
      ${field('Search', input('q', q, 'placeholder="Invoice, name or phone"'))}
      <button type="submit">Show</button>
      <span class="spacer"></span>
      ${can('sales.create') ? '<a class="button gold" href="#/billing">New bill</a>' : ''}
    </form>
    <div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th class="num">Items</th><th class="num">Amount</th>
        <th class="num">Paid</th><th class="num">Due</th><th>Status</th></tr></thead>
      <tbody>${rows.map((s) => `<tr class="clickable" data-href="#/sales/${s.id}">
        <td>${esc(s.invoice_no)}</td><td>${esc(fmtDate(s.invoice_date))}</td>
        <td>${esc(s.customer_name)}${s.customer_phone ? `<br><small class="muted">${esc(s.customer_phone)}</small>` : ''}</td>
        <td class="num">${s.item_count}</td><td class="num">${money(s.net_payable_paisa)}</td>
        <td class="num">${money(s.paid_paisa)}</td><td class="num">${s.due_paisa ? money(s.due_paisa) : ''}</td>
        <td>${statusBadge(s.status)}</td></tr>`).join('') || empty('No invoices in this period.', 8)}</tbody>
      <tfoot><tr><td colspan="4">${posted.length} posted invoice${posted.length === 1 ? '' : 's'}</td>
        <td class="num">${money(posted.reduce((a, s) => a + s.net_payable_paisa, 0))}</td>
        <td class="num">${money(posted.reduce((a, s) => a + s.paid_paisa, 0))}</td>
        <td class="num">${money(posted.reduce((a, s) => a + s.due_paisa, 0))}</td><td></td></tr></tfoot>
    </table></div>`;
  $('#filter').addEventListener('submit', (event) => {
    event.preventDefault();
    const v = formValues(event.target);
    go(`/sales?from=${v.from}&to=${v.to}&q=${encodeURIComponent(v.q)}`);
  });
  wireDateFields(main);
  bindRowLinks(main);
}

async function pageInvoice(main, saleId, params) {
  const [sale, settings] = await Promise.all([api('GET', `/api/sales/${saleId}`), api('GET', '/api/settings')]);
  const vat = settings.vat_registered === 'true';
  main.innerHTML = `
    <div class="toolbar no-print">
      <a class="button secondary" href="#/sales">Back to invoices</a>
      <button id="print">Print</button>
      ${sale.status === 'posted' ? waButton(sale.customer_phone, `Namaste ${sale.customer_name}. Thank you for shopping at ${shopName()}. `
        + `Bill ${sale.invoice_no}: ${rupees(sale.net_payable_paisa)}, paid ${rupees(sale.paid_paisa)}`
        + `${sale.due_paisa > 0 ? `, balance ${rupees(sale.due_paisa)}` : ''}.`) : ''}
      <span class="spacer"></span>
      ${can('sales.create') ? '<a class="button gold" href="#/billing">New bill</a>' : ''}
    </div>
    ${sale.status === 'cancelled' ? `<div class="banner danger no-print">Cancelled on ${esc(fmtDate(sale.cancelled_at))} by ${esc(sale.cancelled_by_name)}: ${esc(sale.cancel_reason)}.
      ${sale.paid_paisa ? `Refund ${money(sale.paid_paisa)} to the customer if not already done.` : ''}</div>` : ''}

    <article class="invoice">
      ${sale.status === 'cancelled' ? '<div class="watermark">CANCELLED</div>' : ''}
      <header>
        <div>
          <div class="shop-name">${esc(settings.shop_name)}</div>
          ${settings.shop_address ? `<div>${esc(settings.shop_address)}</div>` : ''}
          ${settings.shop_phone ? `<div>Phone: ${esc(settings.shop_phone)}</div>` : ''}
          ${settings.shop_pan ? `<div>PAN: ${esc(settings.shop_pan)}</div>` : ''}
          ${vat && settings.vat_number ? `<div>VAT no: ${esc(settings.vat_number)}</div>` : ''}
        </div>
        <div>
          <div class="doc-title">${esc(settings.invoice_title || 'Invoice')}</div>
          <div class="num">No: <strong>${esc(sale.invoice_no)}</strong></div>
          <div class="num">Date: ${esc(fmtDate(sale.invoice_date))}</div>
        </div>
      </header>
      <p><strong>Customer:</strong> ${esc(sale.customer_name)}${sale.customer_phone ? `, ${esc(sale.customer_phone)}` : ''}
        ${sale.customer_address ? `<br>${esc(sale.customer_address)}` : ''}${sale.customer_pan ? `<br>PAN: ${esc(sale.customer_pan)}` : ''}</p>

      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Item</th><th class="num">Gross</th><th class="num">Net</th><th class="num">Charged</th>
          <th class="num">Rate/g (Rs)</th><th class="num">Metal (Rs)</th><th class="num">Making</th><th class="num">Stones, other</th><th class="num">Amount (Rs)</th></tr></thead>
        <tbody>${sale.items.map((i) => `<tr><td>${i.line_no}</td>
          <td>${esc(i.item_code)} ${esc(i.description)}<br><small class="muted">${esc(i.purity_name)}${i.huid ? ` · HUID ${esc(i.huid)}` : ''}</small></td>
          <td class="num">${grams(i.gross_mg)}</td><td class="num">${grams(i.net_mg)}</td><td class="num">${grams(i.chargeable_mg)}</td>
          <td class="num">${i.rate_per_gram ? amt(Math.round(i.rate_per_gram)) : 'Fixed'}</td>
          <td class="num">${amt(i.metal_paisa)}</td><td class="num">${amt(i.making_paisa)}</td>
          <td class="num">${amt(i.stone_paisa + i.other_paisa)}</td>
          <td class="num">${amt(i.metal_paisa + i.making_paisa + i.stone_paisa + i.other_paisa)}</td></tr>`).join('')}</tbody>
      </table></div>

      ${sale.exchange.length ? `<h3>Old gold received</h3><div class="table-wrap"><table>
        <thead><tr><th>Description</th><th>Purity</th><th class="num">Weight</th><th class="num">Less</th><th class="num">Net</th>
          <th class="num">Refining</th><th class="num">Rate/g (Rs)</th><th class="num">Value (Rs)</th></tr></thead>
        <tbody>${sale.exchange.map((x) => `<tr><td>${esc(x.description)}</td><td>${esc(x.purity_name)}</td>
          <td class="num">${grams(x.gross_mg)}</td><td class="num">${grams(x.less_mg)}</td><td class="num">${grams(x.net_mg)}</td>
          <td class="num">${x.refining_percent}%</td><td class="num">${amt(Math.round(x.rate_per_gram))}</td>
          <td class="num">${amt(x.amount_paisa)}</td></tr>`).join('')}</tbody></table></div>` : ''}

      <div class="totals">
        <div class="row"><span>Items total</span><span>${money(sale.subtotal_paisa)}</span></div>
        ${sale.discount_paisa ? `<div class="row"><span>Discount</span><span>− ${money(sale.discount_paisa)}</span></div>` : ''}
        ${sale.tax_summary.map((x) => `<div class="row"><span>${esc(x.name)}</span><span>${money(x.amount)}</span></div>`).join('')}
        <div class="row"><strong>Total</strong><strong>${money(sale.grand_total_paisa)}</strong></div>
        ${sale.exchange_paisa ? `<div class="row"><span>Less old gold</span><span>− ${money(sale.exchange_paisa)}</span></div>` : ''}
        ${sale.round_off_paisa ? `<div class="row"><span>Rounding</span><span>${money(sale.round_off_paisa)}</span></div>` : ''}
        <div class="row grand"><span>Payable</span><span>${money(sale.net_payable_paisa)}</span></div>
        ${sale.advance_paisa ? `<div class="row"><span>Order advance used</span><span>${money(sale.advance_paisa)}</span></div>` : ''}
        ${sale.payments.map((p) => `<div class="row"><span>Paid by ${esc(METHOD_LABELS[p.method])}${p.reference ? ` (${esc(p.reference)})` : ''}</span><span>${money(p.amount_paisa)}</span></div>`).join('')}
        <div class="row grand"><span>Balance due</span><span>${money(sale.due_paisa)}</span></div>
      </div>
      ${sale.remarks ? `<p><strong>Remarks:</strong> ${esc(sale.remarks)}</p>` : ''}
      <footer>
        <div>${esc(settings.invoice_footer || '')}${settings.invoice_terms ? `<br><small>${esc(settings.invoice_terms)}</small>` : ''}
          <br><small class="muted">Billed by ${esc(sale.created_by_name)}</small></div>
        <div class="sign">Authorised signature</div>
      </footer>
    </article>

    <div class="grid cols-2 no-print" style="margin-top:1rem">
      ${sale.status === 'posted' && sale.due_paisa > 0 && can('sales.create') ? `
        <form class="panel" id="payment-form"><h2>Receive payment</h2>
          <div class="form-grid">
            ${field('Method', select('method', Object.entries(METHOD_LABELS), 'cash'))}
            ${field('Amount (Rs)', numberInput('amount', rupeesInput(sale.due_paisa), 'required'))}
            ${field('Reference', input('reference', ''))}
          </div>
          <div class="actions"><button type="submit">Record payment</button></div>
        </form>` : ''}
      ${sale.status === 'posted' && can('sales.cancel') ? `
        <form class="panel" id="cancel-form"><h2>Cancel invoice</h2>
          <p class="muted">The items go back into stock. The invoice stays in the records, marked cancelled.</p>
          ${field('Reason', '<input name="reason" required maxlength="300">')}
          <div class="actions"><button type="submit" class="danger">Cancel this invoice</button></div>
        </form>` : ''}
    </div>`;

  $('#print').addEventListener('click', () => window.print());
  const paymentForm = $('#payment-form');
  if (paymentForm) paymentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(async () => {
      await api('POST', `/api/sales/${saleId}/payments`, formValues(event.target));
      toast('Payment recorded.');
      render();
    }, event.submitter);
  });
  const cancelForm = $('#cancel-form');
  if (cancelForm) cancelForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!confirm(`Cancel invoice ${sale.invoice_no}? This cannot be undone.`)) return;
    attempt(async () => {
      await api('POST', `/api/sales/${saleId}/cancel`, formValues(event.target));
      toast('Invoice cancelled. Items are back in stock.');
      render();
    }, event.submitter);
  });
  if (params.get('print') === '1') {
    history.replaceState(null, '', `#/sales/${saleId}`);
    setTimeout(() => window.print(), 300);
  }
}

// ---------------------------------------------------------------- Stock

async function pageProducts(main, _id, params) {
  const status = params.get('status') || 'in_stock';
  const q = params.get('q') || '';
  const categoryId = params.get('category_id') || '';
  const place = params.get('place') || 'all';
  const owner = can('stock.private');
  const [products, categories] = await Promise.all([
    api('GET', `/api/products?status=${status}&q=${encodeURIComponent(q)}&category_id=${categoryId}${owner ? `&place=${place}` : ''}`),
    cached('categories', '/api/categories')
  ]);
  main.innerHTML = `
    <h1>Stock</h1>
    <form class="toolbar" id="filter">
      ${field('Search', input('q', q, 'placeholder="Code, name or HUID"'))}
      ${field('Category', select('category_id', [['', 'All categories'], ...categories.map((c) => [c.id, c.name])], categoryId))}
      ${field('Status', select('status', [['in_stock', 'In stock'], ['sold', 'Sold'], ['removed', 'Removed'], ['all', 'All']], status))}
      ${owner ? field('Where', select('place', [['all', 'Shop and owner-only'], ['shop', 'In the shop'], ['private', 'Owner-only stock']], place)) : ''}
      <button type="submit">Show</button>
      <span class="spacer"></span>
      ${can('categories.manage') ? '<a class="button secondary" href="#/categories">Categories</a>' : ''}
      ${can('stockreg.view') ? '<a class="button secondary" href="#/stock-register">Daily register</a>' : ''}
      <button type="button" class="secondary" id="print-tags" disabled>Print tags</button>
      ${can('products.manage') ? '<a class="button" href="#/products/new">Add item</a>' : ''}
    </form>
    <div class="table-wrap"><table>
      <thead><tr><th><input type="checkbox" id="select-all" aria-label="Select all"></th><th>Code</th><th>Item</th><th>Purity</th>
        <th class="num">Gross</th><th class="num">Net</th><th>HUID</th><th>Status</th></tr></thead>
      <tbody>${products.map((p) => `<tr class="clickable" data-href="#/products/${p.id}">
        <td><input type="checkbox" class="pick" value="${p.id}" aria-label="Select ${esc(p.item_code)}"></td>
        <td><strong>${esc(p.item_code)}</strong></td><td>${esc(p.name)}${p.is_private ? ' <span class="badge warn">Owner only</span>' : ''}<br><small class="muted">${esc(p.category_name)}${p.location ? ` · ${esc(p.location)}` : ''}</small></td>
        <td>${esc(p.metal_name)} ${esc(p.purity_name)}</td><td class="num">${grams(p.gross_mg)}</td>
        <td class="num">${grams(p.gross_mg - p.stone_mg - p.other_less_mg)}</td><td>${esc(p.huid || '')}</td>
        <td>${statusBadge(p.status)}</td></tr>`).join('') || empty('No items found.', 8)}</tbody>
      <tfoot><tr><td colspan="4">${products.length} item${products.length === 1 ? '' : 's'}${products.length === 500 ? ' (first 500 shown)' : ''}</td>
        <td class="num">${grams(products.reduce((a, p) => a + p.gross_mg, 0))}</td>
        <td class="num">${grams(products.reduce((a, p) => a + p.gross_mg - p.stone_mg - p.other_less_mg, 0))}</td><td colspan="2"></td></tr></tfoot>
    </table></div>`;

  $('#filter').addEventListener('submit', (event) => {
    event.preventDefault();
    const v = formValues(event.target);
    go(`/products?status=${v.status}&q=${encodeURIComponent(v.q)}&category_id=${v.category_id}${v.place ? `&place=${v.place}` : ''}`);
  });
  const picks = () => $$('.pick:checked').map((c) => c.value);
  const refresh = () => { $('#print-tags').disabled = picks().length === 0; };
  $$('.pick').forEach((c) => c.addEventListener('change', refresh));
  $('#select-all').addEventListener('change', (e) => { $$('.pick').forEach((c) => { c.checked = e.target.checked; }); refresh(); });
  $('#print-tags').addEventListener('click', () => go(`/labels?ids=${picks().join(',')}`));
  bindRowLinks(main);
}

async function pageProductForm(main, productId) {
  const [categories, purities, profiles] = await Promise.all([
    cached('categories', '/api/categories'),
    cached('purities', '/api/purities'),
    cached('profiles', '/api/charge-profiles')
  ]);
  const p = productId ? await api('GET', `/api/products/${productId}`) : {};
  const editable = can('products.manage') && (!productId || p.status === 'in_stock');
  const dis = editable ? '' : 'disabled';
  const owner = can('stock.private');

  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/products">Back to stock</a></div>
    <h1>${productId ? `${esc(p.item_code)} ${esc(p.name)}` : 'Add item'}</h1>
    ${productId ? `<p>${statusBadge(p.status)}${p.is_private ? ' <span class="badge warn">Owner only</span>' : ''} <span class="muted">Added ${esc(fmtDate(p.created_at))}</span></p>` : ''}
    <form class="panel" id="product-form">
      <h2>Item</h2>
      <div class="form-grid">
        ${field('Name', input('name', p.name, `required maxlength="100" ${dis}`))}
        ${field('Category', `<div class="inline-add">${select('category_id', [['', 'Choose…'], ...categories.map((c) => [c.id, `${c.name} (${c.prefix})`])], p.category_id, `required ${dis}`)}
          ${editable && can('categories.manage') ? '<button type="button" class="secondary small" id="new-category">New</button>' : ''}</div>`)}
        ${field('Metal and purity', select('purity_id', [['', 'Choose…'], ...purities.filter((x) => x.is_active || x.id === p.purity_id).map((x) => [x.id, `${x.metal_name} ${x.name}`])], p.purity_id, `required ${dis}`))}
        ${productId ? '' : field('Item code', input('item_code', '', 'maxlength="30" placeholder="Automatic"'), { hint: 'Leave empty to number automatically.' })}
        ${productId ? '' : field('Number of identical pieces', numberInput('copies', 1, 'min="1" max="50" step="1"'), { hint: 'Each piece gets its own code and tag.' })}
        ${field('Size', input('size', p.size, `maxlength="20" ${dis}`))}
        ${field('HUID / hallmark no.', input('huid', p.huid, `maxlength="30" ${dis}`))}
      </div>
      <h2 style="margin-top:1rem">Weight</h2>
      <div class="form-grid">
        ${field('Gross weight (g)', numberInput('gross_g', gramsInput(p.gross_mg), `required ${dis}`))}
        ${field('Stone weight (g)', numberInput('stone_g', gramsInput(p.stone_mg), dis))}
        ${field('Other less weight (g)', numberInput('other_less_g', gramsInput(p.other_less_mg), dis), { hint: 'Anything else not charged as metal.' })}
      </div>
      <h2 style="margin-top:1rem">Charges</h2>
      <div class="form-grid">
        ${field('Charge profile', select('charge_profile_id', [['', 'Use the category default'], ...profiles.map((x) => [x.id, x.name])], p.charge_profile_id, dis))}
        ${field('Making charge override', numberInput('making_override', p.making_override, dis), { hint: 'Same unit as the profile. Empty = profile value.' })}
        ${field('Wastage override', numberInput('wastage_override', p.wastage_override, dis), { hint: 'Same unit as the profile. Empty = profile value.' })}
        ${field('Stone charge (Rs)', numberInput('stone_amount', rupeesInput(p.stone_paisa), dis))}
        ${field('Other charges (Rs)', numberInput('other_amount', rupeesInput(p.other_paisa), dis))}
        ${field('Fixed selling price (Rs)', numberInput('fixed_price', rupeesInput(p.fixed_price_paisa), dis), { hint: 'Only for items not priced by weight.' })}
        ${can('costs.view') ? field('Cost price (Rs)', numberInput('cost', rupeesInput(p.cost_paisa), dis), { hint: 'For your stock valuation. Not printed. Staff cannot see it.' }) : ''}
        ${field('Notes', input('notes', p.notes, `maxlength="300" ${dis}`), { wide: true })}
      </div>
      ${owner ? `<h2 style="margin-top:1rem">Owner only</h2>
      <div class="form-grid">
        <label class="check wide"><input type="checkbox" name="is_private" ${p.is_private ? 'checked' : ''} ${dis}>
          Keep this item outside the shop stock. Staff will not see it anywhere, cannot bill it, and it is not counted in their stock totals.</label>
        ${field('Kept at', input('location', p.location, `maxlength="100" placeholder="e.g. Bank locker, home safe" ${dis}`))}
      </div>` : ''}
      ${editable ? `<div class="actions"><button type="submit">${productId ? 'Save changes' : 'Add item'}</button>
        ${productId ? '' : '<button type="submit" name="and_print" value="1" class="secondary">Add and print tag</button>'}</div>` : ''}
    </form>
    ${productId ? `<div class="toolbar no-print">
      <a class="button secondary" href="#/labels?ids=${p.id}">Print tag</a>
      ${can('products.remove') && p.status === 'in_stock' ? '<button class="danger" id="remove">Remove from stock</button>' : ''}
      ${can('products.remove') && p.status === 'removed' ? '<button class="secondary" id="restore">Put back in stock</button>' : ''}
    </div>` : ''}`;

  $('#product-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const andPrint = event.submitter && event.submitter.name === 'and_print';
    attempt(async () => {
      const values = formValues(event.target);
      if (productId) {
        await api('PUT', `/api/products/${productId}`, values);
        toast('Item saved.');
        render();
      } else {
        const created = await api('POST', '/api/products', values);
        clearCache('categories');
        toast(`Added ${created.map((x) => x.item_code).join(', ')}.`);
        go(andPrint ? `/labels?ids=${created.map((x) => x.id).join(',')}` : `/products/${created[0].id}`);
      }
    }, event.submitter);
  });
  const newCategory = $('#new-category');
  if (newCategory) newCategory.addEventListener('click', () => {
    const name = prompt('Name of the new category (for example Mangalsutra, Tilahari):');
    if (!name || !name.trim()) return;
    attempt(async () => {
      const created = await api('POST', '/api/categories', { name: name.trim() });
      clearCache('categories');
      const sel = $('#product-form [name="category_id"]');
      sel.insertAdjacentHTML('beforeend', `<option value="${created.id}">${esc(created.name)} (${esc(created.prefix)})</option>`);
      sel.value = String(created.id);
      toast(`Category ${created.name} added. Its item codes start with ${created.prefix}.`);
    }, newCategory);
  });
  const remove = $('#remove');
  if (remove) remove.addEventListener('click', () => {
    const reason = prompt('Why is this item being removed from stock? (for example: melted, returned to supplier)');
    if (!reason) return;
    attempt(async () => {
      await api('POST', `/api/products/${productId}/remove`, { reason });
      toast('Item removed from stock.');
      render();
    }, remove);
  });
  const restore = $('#restore');
  if (restore) restore.addEventListener('click', () => attempt(async () => {
    await api('POST', `/api/products/${productId}/restore`);
    toast('Item is back in stock.');
    render();
  }, restore));
}

/** Inventory categories: add new ones and rename them. The owner also sets code prefixes and pricing in Settings. */
async function pageCategories(main) {
  clearCache('categories');
  const categories = await cached('categories', '/api/categories');
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/products">Back to stock</a></div>
    <h1>Categories</h1>
    <p class="muted">Rename a category any time; its items and printed tags stay as they are. Each category has a short code prefix
      that starts its item codes (Ring → RG00001).${can('settings.manage') ? ' You can change prefixes and pricing in Settings.' : ''}</p>
    <form class="panel" id="add-category"><h2>Add a category</h2><div class="form-grid" style="align-items:end">
      ${field('Name', '<input name="name" required maxlength="60" placeholder="e.g. Mangalsutra">')}
      ${can('settings.manage') ? field('Code prefix', '<input name="prefix" maxlength="4" placeholder="Automatic">', { hint: '1–4 letters. Leave empty to choose automatically.' }) : ''}
      <div><button type="submit">Add category</button></div></div></form>
    <div class="table-wrap"><table>
      <thead><tr><th>Category</th><th>Code prefix</th><th class="num">In stock</th><th></th></tr></thead>
      <tbody>${categories.map((c) => `<tr data-cat="${c.id}">
        <td>${input('name', c.name, 'maxlength="60" aria-label="Category name"')}</td>
        <td>${esc(c.prefix)}</td><td class="num">${c.in_stock}</td>
        <td><button class="secondary small" data-save="${c.id}">Rename</button></td></tr>`).join('') || empty('No categories yet.', 4)}</tbody>
    </table></div>`;
  $('#add-category').addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      const created = await api('POST', '/api/categories', formValues(e.target));
      toast(`${created.name} added. Item codes start with ${created.prefix}.`);
      render();
    }, e.submitter);
  });
  $$('[data-save]').forEach((b) => b.addEventListener('click', () => {
    const row = b.closest('tr');
    const name = $('[name="name"]', row).value.trim();
    const old = categories.find((c) => String(c.id) === b.dataset.save);
    if (!name || name === old.name) return;
    attempt(async () => {
      await api('PUT', `/api/categories/${old.id}`, { name });
      toast(`Renamed to ${name}.`);
      render();
    }, b);
  }));
  $$('[data-cat] [name="name"]').forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $(`[data-save="${el.closest('tr').dataset.cat}"]`).click(); }
  }));
}

async function pageLabels(main, _id, params) {
  const ids = (params.get('ids') || '').split(',').filter(Boolean);
  const products = await Promise.all(ids.map((pid) => api('GET', `/api/products/${pid}`)));
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/products">Back to stock</a>
      <button id="print">Print tags</button>
      <span class="muted">Each tag is 50 × 25 mm. Set your label printer to that size, or print on A4 and cut.</span></div>
    <div class="labels">${products.map((p) => `
      <div class="label-tag">
        <div class="top"><span>${esc(p.item_code)}</span><span>${esc(p.metal_name)} ${esc(p.purity_name)}</span></div>
        <svg class="barcode" data-code="${esc(p.item_code)}"></svg>
        <div>G ${grams(p.gross_mg)} · N ${grams(p.gross_mg - p.stone_mg - p.other_less_mg)}${p.huid ? ` · ${esc(p.huid)}` : ''}</div>
      </div>`).join('')}</div>`;
  $$('svg.barcode', main).forEach((svg) => {
    if (window.JsBarcode) window.JsBarcode(svg, svg.dataset.code, { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.4 });
  });
  $('#print').addEventListener('click', () => window.print());
}

// ---------------------------------------------------------------- Customers

async function pageCustomers(main, _id, params) {
  const q = params.get('q') || '';
  const customers = await api('GET', `/api/customers?q=${encodeURIComponent(q)}`);
  main.innerHTML = `
    <h1>Customers</h1>
    <form class="toolbar" id="filter">
      ${field('Search', input('q', q, 'placeholder="Name or phone"'))}
      <button type="submit">Search</button><span class="spacer"></span>
      ${can('customers.manage') ? '<button type="button" id="add">Add customer</button>' : ''}
    </form>
    <form class="panel" id="customer-form" hidden>
      <h2 id="form-title">Add customer</h2>
      <input type="hidden" name="id">
      <div class="form-grid">
        ${field('Name', '<input name="name" required maxlength="100">')}
        ${field('Phone', '<input name="phone" maxlength="20">')}
        ${field('Address', '<input name="address" maxlength="200">')}
        ${field('PAN', '<input name="pan" maxlength="20">')}
        ${field('Notes', '<input name="notes" maxlength="300">', { wide: true })}
      </div>
      <div class="actions"><button type="submit">Save customer</button><button type="button" class="secondary" id="cancel">Close</button></div>
    </form>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th>PAN</th><th class="num">Due</th><th></th></tr></thead>
      <tbody>${customers.map((c) => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.phone || '')}</td><td>${esc(c.address || '')}</td><td>${esc(c.pan || '')}</td>
        <td class="num">${c.due_paisa ? `<a href="#/reports">${money(c.due_paisa)}</a>` : ''}</td>
        <td>${can('customers.manage') && !c.is_walkin ? `<button class="link small" data-edit="${c.id}">Edit</button>` : ''}</td></tr>`).join('')
        || empty('No customers found.', 6)}</tbody>
    </table></div>`;

  const form = $('#customer-form');
  const open = (c) => {
    form.hidden = false;
    form.reset();
    $('#form-title').textContent = c ? `Edit ${c.name}` : 'Add customer';
    for (const key of ['id', 'name', 'phone', 'address', 'pan', 'notes']) form.elements[key].value = c ? (c[key] ?? '') : '';
    form.elements.name.focus();
  };
  $('#filter').addEventListener('submit', (event) => { event.preventDefault(); go(`/customers?q=${encodeURIComponent(formValues(event.target).q)}`); });
  const add = $('#add');
  if (add) add.addEventListener('click', () => open(null));
  $('#cancel').addEventListener('click', () => { form.hidden = true; });
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => open(customers.find((c) => String(c.id) === b.dataset.edit))));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(form);
    attempt(async () => {
      if (values.id) await api('PUT', `/api/customers/${values.id}`, values);
      else await api('POST', '/api/customers', values);
      toast('Customer saved.');
      render();
    }, event.submitter);
  });
}

// ---------------------------------------------------------------- Rates

async function pageRates(main) {
  const [data, history] = await Promise.all([api('GET', '/api/rates'), api('GET', '/api/rates/history')]);
  const editable = can('rates.update');
  const factor = { gram: 1, '10g': 10, tola: data.grams_per_tola };
  const unitNames = { tola: 'per tola', '10g': 'per 10 grams', gram: 'per gram' };

  const valueFor = (row, key, unit) => {
    if (!row.updated_at) return '';
    if (row.entered_unit === unit) return rupeesInput(key === 'sell' ? row.entered_sell_paisa : row.entered_buy_paisa);
    const perGram = key === 'sell' ? row.sell_per_gram : row.buy_per_gram;
    return String(Math.round(perGram * factor[unit]) / 100);
  };

  const draw = (unit) => {
    $('#rate-rows').innerHTML = data.rates.map((row) => `<tr>
      <td>${esc(row.metal_name)} ${esc(row.purity_name)} <small class="muted">(${(row.purity * 100).toFixed(1)}%)</small></td>
      <td>${numberInput(`sell_${row.purity_id}`, valueFor(row, 'sell', unit), editable ? '' : 'disabled')}</td>
      <td>${numberInput(`buy_${row.purity_id}`, valueFor(row, 'buy', unit), editable ? '' : 'disabled')}</td>
      <td>${row.updated_at ? `${esc(fmtDate(row.updated_at))}<br><small class="muted">${esc(row.updated_by_name || '')}</small>` : '<span class="error-text">Not set</span>'}</td>
    </tr>`).join('');
  };

  main.innerHTML = `
    <h1>Today's rates</h1>
    <p class="muted">Selling rate is used on bills. Buying rate is used for old gold taken from customers.
      Rates are entered ${esc(unitNames[data.unit])} by default; 1 tola = ${data.grams_per_tola} g (change this in Settings).</p>
    <form class="panel" id="rate-form">
      <div class="toolbar">${field('Rates are', select('unit', Object.entries(unitNames), data.unit, `id="unit" ${editable ? '' : 'disabled'}`))}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Metal</th><th>Selling rate (Rs)</th><th>Buying rate (Rs)</th><th>Last updated</th></tr></thead>
        <tbody id="rate-rows"></tbody>
      </table></div>
      ${editable ? '<div class="actions"><button type="submit">Save rates</button></div>' : ''}
    </form>
    <div class="panel"><h2>Rate history</h2><div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Metal</th><th class="num">Selling</th><th class="num">Buying</th><th>Entered</th><th>By</th></tr></thead>
      <tbody>${history.map((h) => `<tr><td>${esc(fmtDate(h.changed_at))}</td><td>${esc(h.metal_name)} ${esc(h.purity_name)}</td>
        <td class="num">${money(h.entered_sell_paisa)}</td><td class="num">${money(h.entered_buy_paisa)}</td>
        <td>${esc(unitNames[h.entered_unit])}</td><td>${esc(h.changed_by_name || '')}</td></tr>`).join('') || empty('No rates entered yet.', 6)}</tbody>
    </table></div></div>`;

  draw(data.unit);
  $('#unit').addEventListener('change', (e) => draw(e.target.value));
  $('#rate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);
    const unit = values.unit;
    const rates = data.rates
      .map((row) => ({ purity_id: row.purity_id, sell: values[`sell_${row.purity_id}`], buy: values[`buy_${row.purity_id}`] }))
      .filter((r) => r.sell !== '' || r.buy !== '');
    if (!rates.length) return toast('Enter at least one rate.', 'error');
    attempt(async () => {
      await api('PUT', '/api/rates', { unit, rates });
      toast('Rates saved.');
      render();
    }, event.submitter);
  });
}

// ---------------------------------------------------------------- Reports

async function pageReports(main, _id, params) {
  const from = params.get('from') || localDate();
  const to = params.get('to') || localDate();
  const [sales, stock, dues] = await Promise.all([
    api('GET', `/api/reports/sales?from=${from}&to=${to}`),
    api('GET', '/api/reports/stock'),
    api('GET', '/api/reports/dues')
  ]);
  const t = sales.totals;
  const monthStart = periodStart('month');
  const fiscal = state.cal && state.cal.fromDate(new Date()) ? state.cal.fiscalYearOf(state.cal.fromDate(new Date())) : null;

  main.innerHTML = `
    <h1>Reports</h1>
    <form class="toolbar" id="filter">
      ${dateField('From', 'from', from)}
      ${dateField('To', 'to', to)}
      <button type="submit">Show</button>
      <a class="button secondary" href="#/reports">Today</a>
      <a class="button secondary" href="#/reports?from=${monthStart}&to=${localDate()}">This month</a>
      ${fiscal ? `<a class="button secondary" href="#/reports?from=${periodStart('fiscal')}&to=${localDate()}">Fiscal year ${esc(fiscal.label)}</a>` : ''}
      <span class="spacer"></span><button type="button" class="secondary" id="print">Print</button>
    </form>
    <p class="muted">${from === to ? esc(fmtDay(adDate(from).toISOString())) : `${esc(fmtDay(adDate(from).toISOString()))} to ${esc(fmtDay(adDate(to).toISOString()))}`}</p>
    <div class="grid cols-4">
      <div class="panel stat"><div class="label">Sales (after old gold)</div><div class="value">${money(t.net_payable_paisa)}</div>
        <div class="sub">${t.invoices} invoice${t.invoices === 1 ? '' : 's'}${sales.cancelled ? `, ${sales.cancelled} cancelled` : ''}</div></div>
      <div class="panel stat"><div class="label">Items total</div><div class="value">${money(t.subtotal_paisa)}</div>
        <div class="sub">Discount ${money(t.discount_paisa)}</div></div>
      <div class="panel stat"><div class="label">Tax collected</div><div class="value">${money(t.tax_paisa)}</div></div>
      <div class="panel stat"><div class="label">Old gold taken</div><div class="value">${money(t.exchange_paisa)}</div></div>
    </div>
    <div class="grid cols-2">
      <div class="panel"><h2>Sales by metal</h2><div class="table-wrap"><table>
        <thead><tr><th>Metal</th><th class="num">Pieces</th><th class="num">Net weight</th><th class="num">Amount</th></tr></thead>
        <tbody>${sales.byPurity.map((r) => `<tr><td>${esc(r.purity_name)}</td><td class="num">${r.pieces}</td>
          <td class="num">${grams(r.net_mg)}</td><td class="num">${money(r.total_paisa)}</td></tr>`).join('') || empty('No sales.', 4)}</tbody></table></div></div>
      <div class="panel"><h2>Money received</h2><div class="table-wrap"><table>
        <thead><tr><th>Method</th><th class="num">Payments</th><th class="num">Amount</th></tr></thead>
        <tbody>${sales.payments.map((r) => `<tr><td>${esc(METHOD_LABELS[r.method])}</td><td class="num">${r.count}</td>
          <td class="num">${money(r.amount_paisa)}</td></tr>`).join('') || empty('No payments.', 3)}</tbody>
        <tfoot><tr><td>Total</td><td></td><td class="num">${money(sales.payments.reduce((a, r) => a + r.amount_paisa, 0))}</td></tr></tfoot></table></div></div>
      <div class="panel"><h2>Old gold received</h2><div class="table-wrap"><table>
        <thead><tr><th>Purity</th><th class="num">Net weight</th><th class="num">Fine weight</th><th class="num">Value</th></tr></thead>
        <tbody>${sales.oldGold.map((r) => `<tr><td>${esc(r.purity_name)}</td><td class="num">${grams(r.net_mg)}</td>
          <td class="num">${grams(r.fine_mg)}</td><td class="num">${money(r.amount_paisa)}</td></tr>`).join('') || empty('None.', 4)}</tbody></table></div></div>
      <div class="panel"><h2>Stock now</h2><div class="table-wrap"><table>
        <thead><tr><th>Metal</th><th class="num">Pieces</th><th class="num">Gross</th><th class="num">Net</th></tr></thead>
        <tbody>${stock.byPurity.map((r) => `<tr><td>${esc(r.metal_name)} ${esc(r.purity_name)}</td><td class="num">${r.pieces}</td>
          <td class="num">${grams(r.gross_mg)}</td><td class="num">${grams(r.net_mg)}</td></tr>`).join('') || empty('No stock.', 4)}</tbody></table>
        <h3>By category</h3><table><tbody>${stock.byCategory.map((r) => `<tr><td>${esc(r.category_name)}</td><td class="num">${r.pieces}</td>
          <td class="num">${grams(r.net_mg)}</td></tr>`).join('') || empty('No stock.', 3)}</tbody></table></div></div>
    </div>
    <div class="panel"><h2>Customer dues</h2><div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Due</th><th class="no-print"></th></tr></thead>
      <tbody>${dues.map((d) => `<tr class="clickable" data-href="#/sales/${d.id}"><td>${esc(d.invoice_no)}</td><td>${esc(fmtDay(d.invoice_date))}</td>
        <td>${esc(d.customer_name)}${d.customer_phone ? `<br><small class="muted">${esc(d.customer_phone)}</small>` : ''}</td>
        <td class="num">${money(d.net_payable_paisa)}</td><td class="num">${money(d.paid_paisa)}</td><td class="num"><strong>${money(d.due_paisa)}</strong></td>
        <td class="no-print">${waButton(d.customer_phone, `Namaste ${d.customer_name}. A friendly reminder from ${shopName()}: `
          + `${rupees(d.due_paisa)} is still due on bill ${d.invoice_no} dated ${fmtDay(d.invoice_date)}. Thank you.`, 'Remind')}</td></tr>`).join('')
        || empty('No money is owed. ', 7)}</tbody>
      <tfoot><tr><td colspan="5">Total owed</td><td class="num">${money(dues.reduce((a, d) => a + d.due_paisa, 0))}</td><td class="no-print"></td></tr></tfoot>
    </table></div></div>`;
  $('#filter').addEventListener('submit', (event) => {
    event.preventDefault();
    const v = formValues(event.target);
    go(`/reports?from=${v.from}&to=${v.to}`);
  });
  wireDateFields(main);
  $('#print').addEventListener('click', () => window.print());
  bindRowLinks(main);
}

// ---------------------------------------------------------------- Settings

async function pageSettings(main, _id, params) {
  if (!can('settings.view')) throw new Error('Only the owner can open Settings.');
  clearCache('purities', 'categories', 'profiles');
  const [settings, taxes, profiles, categories, purities, metals] = await Promise.all([
    api('GET', '/api/settings'), api('GET', '/api/tax-rules'), cached('profiles', '/api/charge-profiles'),
    cached('categories', '/api/categories'), cached('purities', '/api/purities'), api('GET', '/api/metals')
  ]);
  const editable = can('settings.manage');
  const dis = editable ? '' : 'disabled';
  const saveBtn = (label) => (editable ? `<div class="actions"><button type="submit">${label}</button></div>` : '');

  const basisLabels = { net: 'Net weight', net_wastage: 'Net weight + wastage', gross: 'Gross weight' };
  const wastageLabels = { none: 'No wastage', percent: 'Percent of net weight', grams: 'Fixed grams' };
  const makingLabels = { none: 'No making charge', per_gram: 'Rs per gram', percent: 'Percent of metal value', fixed: 'Fixed Rs per piece' };
  const appliesLabels = { metal: 'Metal value', making: 'Making charge', stones: 'Stone charges', total: 'Whole item amount' };

  main.innerHTML = `
    <h1>Settings</h1>
    ${!taxes.some((t) => t.is_active) ? '<div class="banner">No tax is set up, so bills are printed without tax. Add your taxes below after checking the rates and rules with your accountant.</div>' : ''}

    <form class="panel" id="shop-form"><h2>Shop and invoice</h2>
      <div class="form-grid">
        ${field('Shop name', input('shop_name', settings.shop_name, `required maxlength="100" ${dis}`))}
        ${field('Address', input('shop_address', settings.shop_address, dis))}
        ${field('Phone', input('shop_phone', settings.shop_phone, dis))}
        ${field('PAN', input('shop_pan', settings.shop_pan, dis))}
        ${field('VAT registered', select('vat_registered', [['false', 'No'], ['true', 'Yes']], settings.vat_registered, dis))}
        ${field('VAT number', input('vat_number', settings.vat_number, dis))}
        ${field('Invoice title', input('invoice_title', settings.invoice_title, dis), { hint: 'For example "Invoice" or "Tax invoice". Check with your accountant.' })}
        ${field('Invoice number prefix', input('invoice_prefix', settings.invoice_prefix, `maxlength="10" ${dis}`))}
        ${field('Invoice numbers', select('invoice_numbering', [['continuous', 'One running series (INV-000123)'], ['fiscal_year', 'Restart each fiscal year (INV-2083/84-00001)']], settings.invoice_numbering, dis),
          { hint: 'Ask your accountant which your tax office expects.' })}
        ${field('Footer message', input('invoice_footer', settings.invoice_footer, dis), { wide: true })}
        ${field('Terms printed on invoice', `<textarea name="invoice_terms" ${dis}>${esc(settings.invoice_terms)}</textarea>`, { wide: true })}
      </div>${saveBtn('Save shop details')}
    </form>

    <form class="panel" id="rules-form"><h2>Billing rules</h2>
      <div class="form-grid">
        ${field('Grams in one tola', numberInput('grams_per_tola', settings.grams_per_tola, dis), { hint: 'Confirm the figure your shop uses.' })}
        ${field('Enter rates', select('rate_entry_unit', [['tola', 'Per tola'], ['10g', 'Per 10 grams'], ['gram', 'Per gram']], settings.rate_entry_unit, dis))}
        ${field('Round bills to nearest (Rs)', numberInput('round_to_rupees', settings.round_to_rupees, dis), { hint: '0 = no rounding.' })}
        ${field('Staff discount limit (%)', numberInput('cashier_max_discount_percent', settings.cashier_max_discount_percent, dis))}
        ${field('Backups to keep', numberInput('backup_keep_count', settings.backup_keep_count, dis))}
        ${field('Show dates as', select('date_display', [['both', 'BS with AD'], ['bs', 'BS only'], ['ad', 'AD only']], settings.date_display, dis))}
        ${field('WhatsApp country code', input('whatsapp_country_code', settings.whatsapp_country_code, `maxlength="4" ${dis}`), { hint: '977 for Nepal. Added to 10-digit phone numbers.' })}
      </div>${saveBtn('Save billing rules')}
    </form>

    <div class="panel"><h2>Taxes</h2>
      <p class="muted">Taxes are added on top of the item price, on the part you choose. Nothing is assumed: enter only what your accountant confirms.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th class="num">Rate</th><th>Charged on</th><th>Checked by</th><th>Active</th><th></th></tr></thead>
      <tbody>${taxes.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.rate_percent}%</td><td>${esc(appliesLabels[t.applies_to])}</td>
        <td>${esc(t.verified_note || '')}</td><td>${t.is_active ? 'Yes' : 'No'}</td>
        <td>${editable ? `<button class="link small" data-edit-tax="${t.id}">Edit</button>` : ''}</td></tr>`).join('') || empty('No taxes set up.', 6)}</tbody></table></div>
      ${editable ? `<form id="tax-form" style="margin-top:1rem"><input type="hidden" name="id">
        <div class="form-grid">
          ${field('Tax name', '<input name="name" required maxlength="60">')}
          ${field('Rate (%)', numberInput('rate_percent', '', 'required max="100"'))}
          ${field('Charged on', select('applies_to', Object.entries(appliesLabels), 'total'))}
          ${field('Checked by / note', '<input name="verified_note" maxlength="200" placeholder="e.g. Confirmed by accountant, date">')}
          <label class="check"><input type="checkbox" name="is_active" checked> Active</label>
        </div><div class="actions"><button type="submit">Save tax</button><button type="reset" class="secondary">New</button></div></form>` : ''}
    </div>

    <div class="panel"><h2>Charge profiles</h2>
      <p class="muted">A profile says how an item is priced. Each category uses one by default; single items can override it.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Metal charged on</th><th>Wastage</th><th>Making charge</th><th>Active</th><th></th></tr></thead>
      <tbody>${profiles.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(basisLabels[p.basis])}</td>
        <td>${p.wastage_mode === 'none' ? 'None' : p.wastage_mode === 'percent' ? `${p.wastage_value}%` : `${p.wastage_value} g`}</td>
        <td>${p.making_mode === 'none' ? 'None' : p.making_mode === 'per_gram' ? `Rs ${p.making_value}/g on ${p.making_weight} wt` : p.making_mode === 'percent' ? `${p.making_value}% of metal` : `Rs ${p.making_value} per piece`}${p.min_making_paisa ? `, min ${money(p.min_making_paisa)}` : ''}</td>
        <td>${p.is_active ? 'Yes' : 'No'}</td><td>${editable ? `<button class="link small" data-edit-profile="${p.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${editable ? `<form id="profile-form" style="margin-top:1rem"><input type="hidden" name="id">
        <div class="form-grid">
          ${field('Profile name', '<input name="name" required maxlength="60">')}
          ${field('Charge metal on', select('basis', Object.entries(basisLabels), 'net'))}
          ${field('Wastage', select('wastage_mode', Object.entries(wastageLabels), 'none'))}
          ${field('Wastage value', numberInput('wastage_value', 0), { hint: 'Percent or grams, as chosen.' })}
          ${field('Making charge', select('making_mode', Object.entries(makingLabels), 'per_gram'))}
          ${field('Making value', numberInput('making_value', 0), { hint: 'Rs per gram, percent or Rs, as chosen.' })}
          ${field('Making charged on', select('making_weight', [['net', 'Net weight'], ['gross', 'Gross weight']], 'net'))}
          ${field('Minimum making (Rs)', numberInput('min_making', 0))}
          <label class="check"><input type="checkbox" name="is_active" checked> Active</label>
        </div><div class="actions"><button type="submit">Save profile</button><button type="reset" class="secondary">New</button></div></form>` : ''}
    </div>

    <div class="panel"><h2>Categories</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Code prefix</th><th>Charge profile</th><th class="num">In stock</th><th></th></tr></thead>
      <tbody>${categories.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.prefix)}</td><td>${esc(c.charge_profile_name || 'First active profile')}</td>
        <td class="num">${c.in_stock}</td><td>${editable ? `<button class="link small" data-edit-category="${c.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${editable ? `<form id="category-form" style="margin-top:1rem"><input type="hidden" name="id">
        <div class="form-grid">
          ${field('Category name', '<input name="name" required maxlength="60">')}
          ${field('Code prefix', '<input name="prefix" required maxlength="4" pattern="[A-Za-z0-9]{1,4}">', { hint: '1–4 letters, e.g. RG for rings.' })}
          ${field('Charge profile', select('charge_profile_id', [['', 'First active profile'], ...profiles.map((p) => [p.id, p.name])], ''))}
        </div><div class="actions"><button type="submit">Save category</button><button type="reset" class="secondary">New</button></div></form>` : ''}
    </div>

    <div class="panel"><h2>Metals and purities</h2>
      <div class="table-wrap"><table><thead><tr><th>Metal</th><th>Name</th><th class="num">Purity</th><th class="num">Order</th><th>Active</th><th></th></tr></thead>
      <tbody>${purities.map((p) => `<tr><td>${esc(p.metal_name)}</td><td>${esc(p.name)}</td><td class="num">${(p.purity * 100).toFixed(2)}%</td>
        <td class="num">${p.sort_order}</td><td>${p.is_active ? 'Yes' : 'No'}</td>
        <td>${editable ? `<button class="link small" data-edit-purity="${p.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${editable ? `<form id="purity-form" style="margin-top:1rem"><input type="hidden" name="id">
        <div class="form-grid">
          ${field('Metal', select('metal_id', metals.map((m) => [m.id, m.name]), metals[0]?.id))}
          ${field('Name', '<input name="name" required maxlength="30" placeholder="e.g. 22K">')}
          ${field('Purity (fraction)', numberInput('purity', '', 'required max="1"'), { hint: '22K ≈ 0.916, 18K = 0.75.' })}
          ${field('Display order', numberInput('sort_order', 10, 'step="1"'))}
          <label class="check"><input type="checkbox" name="is_active" checked> Active</label>
        </div><div class="actions"><button type="submit">Save purity</button><button type="reset" class="secondary">New</button></div></form>` : ''}
    </div>
    ${auditLockPanel(settings, editable)}
    ${calendarPanel(editable)}`;

  const saveSettings = (formId) => {
    const form = $(`#${formId}`);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      attempt(async () => {
        state.settings = await api('PUT', '/api/settings', formValues(form));
        toast('Settings saved.');
        renderShellBrand();
        if (formId === 'rules-form') render();
      }, event.submitter);
    });
  };
  wireCalendarPanel(editable);
  wireAuditLock(editable);
  if (params && params.get('section') === 'calendar') $('#calendar').scrollIntoView();
  if (editable) {
    saveSettings('shop-form');
    saveSettings('rules-form');
    wireCrud('tax', taxes, '/api/tax-rules', (t) => ({ ...t, is_active: !!t.is_active }));
    wireCrud('profile', profiles, '/api/charge-profiles', (p) => ({ ...p, is_active: !!p.is_active, min_making: p.min_making_paisa / 100 }), ['profiles']);
    wireCrud('category', categories, '/api/categories', (c) => ({ ...c, charge_profile_id: c.charge_profile_id ?? '' }), ['categories']);
    wireCrud('purity', purities, '/api/purities', (p) => ({ ...p, is_active: !!p.is_active }), ['purities']);
  }
}

/** Audit lock: nothing dated on or before the lock date can be added, changed or cancelled. */
function auditLockPanel(settings, editable) {
  const lock = settings.books_locked_until;
  const yesterday = localDate(new Date(Date.now() - 86400000));
  return `<div class="panel" id="audit-lock"><h2>Audit lock</h2>
    <p>${lock ? `The books are <strong>locked up to ${esc(fmtDay(adDate(lock).toISOString()))}</strong>. Bills, purchases, payments and entries on or before that day cannot be added, cancelled or reversed.`
      : 'The books are not locked.'}</p>
    <p class="muted">Lock a period once its accounts are final, for example after your accountant has filed the returns. Only the owner can change the lock, and every change is in the audit log.</p>
    ${editable ? `<form id="lock-form"><div class="form-grid">${dateField('Lock the books up to', 'books_locked_until', lock || yesterday)}</div>
      <div class="actions"><button type="submit">${lock ? 'Change lock date' : 'Lock the books'}</button>
      ${lock ? '<button type="button" class="secondary" id="unlock">Remove the lock</button>' : ''}</div></form>` : ''}</div>`;
}

function wireAuditLock(editable) {
  const form = $('#lock-form');
  if (!editable || !form) return;
  wireDateFields(form);
  const save = (value, button) => attempt(async () => {
    state.settings = await api('PUT', '/api/settings', { books_locked_until: value });
    toast(value ? 'Books locked.' : 'Lock removed.');
    render();
  }, button);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = formValues(form).books_locked_until;
    if (confirm(`Lock the books up to ${fmtDay(adDate(value).toISOString())}? Nothing on or before that day can then be added or cancelled.`)) save(value, e.submitter);
  });
  const unlock = $('#unlock');
  if (unlock) unlock.addEventListener('click', () => { if (confirm('Remove the audit lock?')) save('', unlock); });
}

function calendarPanel(editable) {
  const cal = state.cal;
  if (!cal) return '';
  const info = state.calendarInfo;
  const current = (cal.fromDate(new Date()) || { year: cal.lastYear }).year;
  const statusLabels = {
    verified: '<span class="badge ok">Verified</span>',
    confirmed: '<span class="badge ok">Confirmed by you</span>',
    provisional: '<span class="badge warn">Not confirmed</span>'
  };
  const years = [];
  for (let y = current - 1; y <= cal.lastYear; y += 1) years.push(y);
  const editableYears = [];
  for (let y = info.verified_until + 1; y <= cal.lastYear + 1; y += 1) editableYears.push(y);
  const note = (y) => info.notes.find((n) => n.year === y);
  return `<div class="panel" id="calendar"><h2>Nepali calendar</h2>
    <p class="muted">BS month lengths are fixed each year by the official calendar committee and cannot be calculated.
      Years up to ${info.verified_until} are built in and verified. Later years are best guesses until you confirm them from the printed patro.
      Invoices are stored with the exact date, so correcting a year only changes how dates are shown.</p>
    <div class="table-wrap"><table><thead><tr><th>Year (BS)</th>${BSDate.MONTHS.map((m) => `<th class="num">${m.slice(0, 3)}</th>`).join('')}<th class="num">Days</th><th>Status</th></tr></thead>
    <tbody>${years.map((y) => {
    const days = cal.monthDays(y);
    const n = note(y);
    return `<tr><td>${y}${y === current ? ' <small class="muted">(this year)</small>' : ''}</td>${days.map((d) => `<td class="num">${d}</td>`).join('')}
        <td class="num">${days.reduce((a, b) => a + b, 0)}</td><td>${statusLabels[cal.status(y)] || ''}${n && n.note ? `<br><small class="muted">${esc(n.note)}</small>` : ''}</td></tr>`;
  }).join('')}</tbody></table></div>
    ${editable ? `<form id="calendar-form" style="margin-top:1rem">
      <div class="form-grid">
        ${field('Year (BS)', select('year', editableYears.map((y) => [y, y]), state.calendarYear || editableYears.find((y) => cal.status(y) === 'provisional') || editableYears[0]))}
        ${BSDate.MONTHS.map((m, i) => field(m, `<input type="number" name="m${i + 1}" min="29" max="32" step="1" required>`)).join('')}
        ${field('Checked against', '<input name="note" maxlength="200" placeholder="e.g. Official patro 2084, page 1">', { wide: true })}
      </div>
      <div class="actions"><button type="submit">Save this year</button>
        <button type="button" class="secondary" id="calendar-reset">Use built-in values</button></div>
    </form>` : ''}
  </div>`;
}

function wireCalendarPanel(editable) {
  const form = $('#calendar-form');
  if (!form || !editable) return;
  const fill = () => {
    const year = Number(form.elements.year.value);
    const days = state.cal.monthDays(year);
    for (let i = 1; i <= 12; i += 1) form.elements[`m${i}`].value = days[i - 1] ?? '';
    const n = state.calendarInfo.notes.find((x) => x.year === year);
    form.elements.note.value = n && n.note ? n.note : '';
    $('#calendar-reset').disabled = !state.calendarInfo.overrides[year];
  };
  form.elements.year.addEventListener('change', fill);
  fill();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const v = formValues(form);
    const monthDays = Array.from({ length: 12 }, (_, i) => Number(v[`m${i + 1}`]));
    const problem = BSDate.monthDaysProblem(monthDays);
    if (problem) return toast(problem, 'error');
    attempt(async () => {
      await api('PUT', `/api/calendar/${v.year}`, { month_days: monthDays, note: v.note });
      state.calendarYear = Number(v.year);
      await loadCalendar();
      toast(`Calendar for ${v.year} saved.`);
      render();
    }, event.submitter);
  });
  $('#calendar-reset').addEventListener('click', (e) => {
    const year = form.elements.year.value;
    if (!confirm(`Go back to the built-in month lengths for ${year}?`)) return;
    attempt(async () => {
      await api('DELETE', `/api/calendar/${year}`);
      state.calendarYear = Number(year);
      await loadCalendar();
      toast(`Calendar for ${year} reset.`);
      render();
    }, e.target);
  });
}

function renderShellBrand() {
  const brand = $('.brand small');
  if (brand) brand.textContent = state.settings.shop_name || '';
}

/** Connects an "Edit" link list and a form for a simple settings table. */
function wireCrud(name, rows, url, toForm, cacheKeys = []) {
  const form = $(`#${name}-form`);
  const key = name.charAt(0).toUpperCase() + name.slice(1);
  $$(`[data-edit-${name}]`).forEach((button) => button.addEventListener('click', () => {
    const row = toForm(rows.find((r) => String(r.id) === button.dataset[`edit${key}`]));
    for (const el of form.elements) {
      if (!el.name || !(el.name in row)) continue;
      if (el.type === 'checkbox') el.checked = !!row[el.name];
      else el.value = row[el.name] ?? '';
    }
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.elements[1].focus();
  }));
  form.addEventListener('reset', () => setTimeout(() => { form.elements.id.value = ''; }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(form);
    attempt(async () => {
      if (values.id) await api('PUT', `${url}/${values.id}`, values);
      else await api('POST', url, values);
      clearCache(...cacheKeys);
      toast('Saved.');
      render();
    }, event.submitter);
  });
}

// ---------------------------------------------------------------- Users

async function pageUsers(main) {
  const users = await api('GET', '/api/users');
  const roleOptions = Object.entries(ROLE_LABELS);
  main.innerHTML = `
    <h1>Staff accounts</h1>
    <p class="muted"><strong>Owner:</strong> everything.<br><strong>Staff:</strong> dashboard, today's gold rates, stock and categories, bills and invoices
      (taking payments), purchases, and customers. Staff never see owner-only stock, cost prices, profit, what you owe suppliers, accounts, reports,
      settings, these staff accounts or the audit log, and cannot cancel bills or purchases or remove stock.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr data-user="${u.id}">
        <td>${input('full_name', u.full_name, 'maxlength="100"')}</td><td>${esc(u.username)}</td>
        <td>${select('role', roleOptions, u.role)}</td>
        <td>${select('is_active', [['true', 'Active'], ['false', 'Disabled']], u.is_active ? 'true' : 'false')}
          ${u.locked_until && new Date(u.locked_until) > new Date() ? '<br><span class="badge danger">Locked</span>' : ''}</td>
        <td>${esc(fmtDate(u.last_login_at)) || '<span class="muted">Never</span>'}</td>
        <td><button class="small" data-save>Save</button> <button class="small secondary" data-reset>New password</button></td></tr>`).join('')}</tbody>
    </table></div>
    <form class="panel" id="user-form" style="margin-top:1rem"><h2>Add staff account</h2>
      <div class="form-grid">
        ${field('Full name', '<input name="full_name" required maxlength="100">')}
        ${field('Username', '<input name="username" required maxlength="50" pattern="[A-Za-z0-9._\\-]+">')}
        ${field('Role', select('role', roleOptions, 'staff'))}
        ${field('Starting password', '<input name="password" required>', { hint: 'They must change it when they first log in.' })}
      </div><div class="actions"><button type="submit">Add account</button></div>
    </form>`;

  $$('[data-user]').forEach((row) => {
    const userId = row.dataset.user;
    $('[data-save]', row).addEventListener('click', (e) => attempt(async () => {
      await api('PUT', `/api/users/${userId}`, {
        full_name: $('[name="full_name"]', row).value,
        role: $('[name="role"]', row).value,
        is_active: $('[name="is_active"]', row).value === 'true'
      });
      toast('Account saved.');
    }, e.target));
    $('[data-reset]', row).addEventListener('click', (e) => {
      const password = prompt('Enter a new starting password. They must change it when they next log in.');
      if (!password) return;
      attempt(async () => {
        await api('POST', `/api/users/${userId}/reset-password`, { password });
        toast('Password reset. The account is also unlocked.');
        render();
      }, e.target);
    });
  });
  $('#user-form').addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(async () => {
      await api('POST', '/api/users', formValues(event.target));
      toast('Account added.');
      render();
    }, event.submitter);
  });
}

// ---------------------------------------------------------------- Audit

async function pageAudit(main, _id, params) {
  const view = params.get('view') || 'changes';
  const rows = await api('GET', view === 'logins' ? '/api/login-history' : '/api/audit');
  main.innerHTML = `
    <h1>Audit log</h1>
    <p class="muted">Every change is recorded here permanently. Entries cannot be edited or deleted.</p>
    <div class="toolbar"><a class="button ${view === 'changes' ? '' : 'secondary'}" href="#/audit">Changes</a>
      <a class="button ${view === 'logins' ? '' : 'secondary'}" href="#/audit?view=logins">Logins</a></div>
    <div class="table-wrap"><table>
    ${view === 'logins'
    ? `<thead><tr><th>When</th><th>Username</th><th>Result</th><th>Computer</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(fmtDate(r.at))}</td><td>${esc(r.username)}</td>
          <td>${r.success ? '<span class="badge ok">Logged in</span>' : `<span class="badge danger">${esc(r.reason)}</span>`}</td><td>${esc(r.ip || '')}</td></tr>`).join('') || empty('No logins yet.', 4)}</tbody>`
    : `<thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th><th>Details</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(fmtDate(r.at))}</td><td>${esc(r.username || '')}</td><td>${esc(r.action)}</td>
          <td>${esc(r.entity)} ${esc(r.entity_id || '')}</td>
          <td>${r.details ? `<details><summary>View</summary><pre style="white-space:pre-wrap;font-size:.8rem">${esc(JSON.stringify(JSON.parse(r.details), null, 2))}</pre></details>` : ''}</td></tr>`).join('') || empty('Nothing recorded yet.', 5)}</tbody>`}
    </table></div>`;
}

// ---------------------------------------------------------------- Backup

async function pageBackup(main) {
  const backups = await api('GET', '/api/backups');
  main.innerHTML = `
    <h1>Backup</h1>
    <div class="panel">
      <p>JewelPro makes an automatic backup every day while it is running, and keeps the latest ${esc(state.settings.backup_keep_count || 30)}.
        Backups are stored on this computer in the <strong>data\\backups</strong> folder.</p>
      <p><strong>Keep a copy away from this computer.</strong> A backup on the same computer does not help if the computer is lost or broken.</p>
      <button id="run">Back up now</button>
    </div>
    <form class="panel" id="copy-form"><h2>Daily cloud copy</h2>
      <p>JewelPro can put a second copy of every backup into another folder. Choose a folder that
        <strong>Google Drive for desktop</strong> or <strong>OneDrive</strong> keeps in sync, and each day's backup goes to the cloud automatically.
        A USB drive folder also works while the drive is plugged in.</p>
      ${state.settings.backup_copy_dir !== undefined && can('settings.manage') ? `<div class="form-grid">
        ${field('Second copy folder', input('backup_copy_dir', state.settings.backup_copy_dir, 'maxlength="300" placeholder="e.g. C:\\Users\\Shop\\Google Drive\\JewelPro backups"'), { wide: true, hint: 'The full path on the shop computer. Leave empty to turn this off.' })}
      </div><div class="actions"><button type="submit">Save folder</button></div>`
      : `<p class="muted">${state.settings.backup_copy_dir ? `Copies go to: ${esc(state.settings.backup_copy_dir)}` : 'Not set up. The owner can set this.'}</p>`}
      <p class="muted">The backup file holds all your shop's data. Keep the cloud account protected with a strong password and two-step login.</p>
    </form>
    <div class="table-wrap"><table>
      <thead><tr><th>Backup</th><th>Made</th><th class="num">Size</th><th></th></tr></thead>
      <tbody>${backups.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(fmtDate(b.created_at))}</td>
        <td class="num">${(b.size / 1024 / 1024).toFixed(2)} MB</td><td><a href="/api/backups/${encodeURIComponent(b.name)}">Download</a></td></tr>`).join('')
        || empty('No backups yet.', 4)}</tbody>
    </table></div>
    <div class="panel" style="margin-top:1rem"><h2>Restoring a backup</h2>
      <ol><li>Close the JewelPro window on the shop computer.</li>
        <li>In the JewelPro folder, open <strong>data</strong> and rename <strong>jewelpro.db</strong> to <strong>jewelpro-old.db</strong>. Delete <strong>jewelpro.db-wal</strong> and <strong>jewelpro.db-shm</strong> if present.</li>
        <li>Copy the backup file into the <strong>data</strong> folder and rename it to <strong>jewelpro.db</strong>.</li>
        <li>Start JewelPro again.</li></ol>
    </div>`;
  const copyForm = $('#copy-form');
  if (copyForm.elements.backup_copy_dir) copyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      state.settings = await api('PUT', '/api/settings', { backup_copy_dir: copyForm.elements.backup_copy_dir.value.trim() });
      toast('Saved. The next backup will also be copied there.');
      render();
    }, e.submitter);
  });
  $('#run').addEventListener('click', (e) => attempt(async () => {
    const file = await api('POST', '/api/backups');
    if (file.copy_error) toast(file.copy_error, 'error');
    else toast(`Backup saved: ${file.name}${file.copied ? ' (second copy made)' : ''}`);
    render();
  }, e.target));
}
