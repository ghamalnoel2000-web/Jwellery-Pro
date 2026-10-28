'use strict';

/* ======================================================================
   Purchases, suppliers, metal stock and old gold buying.
   Uses the helpers defined in app.js (api, esc, money, grams, field, ...).
   ====================================================================== */

// ---------------------------------------------------------------- Shared pieces

/** WhatsApp link that opens a chat with the message typed in. The user presses Send. */
function waLink(phone, message) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const cc = String(state.settings.whatsapp_country_code || '977');
  digits = digits.replace(/^0+/, '');
  if (digits.length <= 10 && !digits.startsWith(cc)) digits = cc + digits;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

function waButton(phone, message, label = 'Send on WhatsApp') {
  const href = waLink(phone, message);
  return href ? `<a class="button secondary small" target="_blank" rel="noopener" href="${esc(href)}">${esc(label)}</a>` : '';
}

const shopName = () => state.settings.shop_name || 'our shop';
const rupees = (paisa) => `Rs ${amt(paisa)}`;
const todayText = () => localDate();
const inDays = (n) => localDate(new Date(Date.now() + n * 86400000));
const isOverdue = (dateText) => !!dateText && dateText < todayText();
const dueBadge = (dateText) => (dateText
  ? `${esc(fmtDay(adDate(dateText).toISOString()))}${isOverdue(dateText) ? ' <span class="badge danger">Overdue</span>' : ''}`
  : '<span class="muted">No date</span>');

/** Customer chooser with search and quick add. Returns an object whose .value is the chosen customer id. */
async function customerPicker(root, { allowWalkIn = false, selected = '' } = {}) {
  let list = (await api('GET', '/api/customers')).filter((c) => allowWalkIn || !c.is_walkin);
  let current = String(selected || '');
  root.innerHTML = `
    <div class="toolbar" style="margin:0">
      <label class="field" style="flex:1;min-width:210px"><span>Customer</span><select class="cp-select"></select></label>
      <label class="field" style="width:170px"><span>Find</span><input class="cp-search" placeholder="Name or phone"></label>
      <button type="button" class="secondary cp-new">New customer</button>
    </div>
    <div class="form-grid cp-form" hidden style="margin-top:.5rem;align-items:end">
      ${field('Name', '<input class="cp-name" maxlength="100">')}
      ${field('Phone', '<input class="cp-phone" maxlength="20">')}
      ${field('Address', '<input class="cp-address" maxlength="200">')}
      <div><button type="button" class="cp-add">Add customer</button></div>
    </div>`;
  const sel = $('.cp-select', root);
  const draw = () => {
    sel.innerHTML = `<option value="">Choose…</option>${list.map((c) =>
      `<option value="${c.id}"${String(c.id) === current ? ' selected' : ''}>${esc(c.name)}${c.phone ? ` — ${esc(c.phone)}` : ''}</option>`).join('')}`;
  };
  draw();
  sel.addEventListener('change', () => { current = sel.value; root.dispatchEvent(new Event('customerchange')); });
  let timer;
  $('.cp-search', root).addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      list = (await api('GET', `/api/customers?q=${encodeURIComponent(e.target.value)}`)).filter((c) => allowWalkIn || !c.is_walkin);
      if (list.length === 1) current = String(list[0].id);
      draw();
      root.dispatchEvent(new Event('customerchange'));
    }, 250);
  });
  $('.cp-new', root).addEventListener('click', () => { const f = $('.cp-form', root); f.hidden = !f.hidden; if (!f.hidden) $('.cp-name', root).focus(); });
  $('.cp-add', root).addEventListener('click', (e) => attempt(async () => {
    const created = await api('POST', '/api/customers', {
      name: $('.cp-name', root).value, phone: $('.cp-phone', root).value, address: $('.cp-address', root).value });
    list = [created, ...list];
    current = String(created.id);
    draw();
    $('.cp-form', root).hidden = true;
    toast(`${created.name} added.`);
    root.dispatchEvent(new Event('customerchange'));
  }, e.target));
  return {
    get value() { return sel.value; },
    customer: () => list.find((c) => String(c.id) === sel.value)
  };
}

/** Reads the named inputs inside one repeated row. */
function rowValues(row) {
  const values = {};
  $$('input[name], select[name], textarea[name]', row).forEach((el) => {
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return values;
}

/** Fields for one tagged piece (used by purchases and karigar receipts). */
function pieceFields(refs, extra = '', { required = true } = {}) {
  const req = required ? 'required' : '';
  const cats = [['', 'Choose…'], ...refs.categories.map((c) => [c.id, c.name])];
  const purs = [['', 'Choose…'], ...refs.purities.filter((p) => p.is_active).map((p) => [p.id, `${p.metal_name} ${p.name}`])];
  return `
    ${field('Item name', `<input name="name" ${req} maxlength="100">`)}
    ${field('Category', select('category_id', cats, '', req))}
    ${field('Purity', select('purity_id', purs, '', req))}
    ${field('Gross wt (g)', numberInput('gross_g', '', req))}
    ${field('Stone wt (g)', numberInput('stone_g', ''))}
    ${field('Stone charge (Rs)', numberInput('stone_amount', ''))}
    ${field('HUID', '<input name="huid" maxlength="30">')}
    ${extra}`;
}

async function refsForPieces() {
  const [categories, purities] = await Promise.all([cached('categories', '/api/categories'), cached('purities', '/api/purities')]);
  return { categories, purities };
}

function repeater(container, template, { onChange = () => {}, removeLabel = 'Remove' } = {}) {
  const add = (html = template()) => {
    const row = document.createElement('div');
    row.className = 'panel repeat-row';
    row.innerHTML = `<div class="form-grid" style="align-items:end">${html}
      <div><button type="button" class="link small repeat-remove">${esc(removeLabel)}</button></div></div>`;
    $('.repeat-remove', row).addEventListener('click', () => { row.remove(); onChange(); });
    $$('input, select', row).forEach((el) => el.addEventListener('input', onChange));
    container.appendChild(row);
    onChange();
    return row;
  };
  return { add, rows: () => $$('.repeat-row', container) };
}

// ---------------------------------------------------------------- Purchases

async function pagePurchases(main, _id, params) {
  const from = params.get('from') || periodStart('month');
  const to = params.get('to') || localDate();
  const rows = await api('GET', `/api/purchases?from=${from}&to=${to}`);
  const posted = rows.filter((p) => p.status === 'posted');
  main.innerHTML = `
    <h1>Purchases</h1>
    <form class="toolbar" id="filter">${dateField('From', 'from', from)}${dateField('To', 'to', to)}
      <button type="submit">Show</button><span class="spacer"></span>
      <a class="button secondary" href="#/suppliers">Suppliers</a><a class="button" href="#/purchases/new">New purchase</a></form>
    <div class="table-wrap"><table>
      <thead><tr><th>Purchase</th><th>Date</th><th>Supplier</th><th>Their bill</th><th class="num">Lines</th><th class="num">Total</th><th class="num">Paid now</th><th>Status</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="clickable" data-href="#/purchases/${p.id}"><td>${esc(p.purchase_no)}</td><td>${esc(fmtDay(p.purchase_date))}</td>
        <td>${esc(p.supplier_name)}</td><td>${esc(p.supplier_bill_no || '')}</td><td class="num">${p.line_count}</td>
        <td class="num">${money(p.total_paisa)}</td><td class="num">${money(p.paid_paisa)}</td><td>${statusBadge(p.status)}</td></tr>`).join('')
        || empty('No purchases in this period.', 8)}</tbody>
      <tfoot><tr><td colspan="5">${posted.length} purchase${posted.length === 1 ? '' : 's'}</td>
        <td class="num">${money(posted.reduce((a, p) => a + p.total_paisa, 0))}</td><td class="num">${money(posted.reduce((a, p) => a + p.paid_paisa, 0))}</td><td></td></tr></tfoot>
    </table></div>`;
  $('#filter').addEventListener('submit', (e) => { e.preventDefault(); const v = formValues(e.target); go(`/purchases?from=${v.from}&to=${v.to}`); });
  wireDateFields(main);
  bindRowLinks(main);
}

async function pagePurchaseNew(main) {
  const [suppliers, refs] = await Promise.all([api('GET', '/api/suppliers'), refsForPieces()]);
  const active = suppliers.filter((s) => s.is_active);
  const purityOptions = refs.purities.filter((p) => p.is_active).map((p) => [p.id, `${p.metal_name} ${p.name}`]);
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/purchases">Back to purchases</a></div>
    <h1>New purchase</h1>
    ${active.length ? '' : '<div class="banner">Add the supplier first on the <a href="#/suppliers">Suppliers</a> page.</div>'}
    <form id="purchase-form">
      <div class="panel"><div class="form-grid">
        ${field('Supplier', select('supplier_id', [['', 'Choose…'], ...active.map((s) => [s.id, s.name])], '', 'required'))}
        ${field("Supplier's bill no.", '<input name="supplier_bill_no" maxlength="50">')}
        ${dateField('Bill date', 'date', localDate())}
        ${field('Remarks', '<input name="remarks" maxlength="300">')}
      </div></div>
      <div class="toolbar"><h2 style="margin:0">What was bought</h2><span class="spacer"></span>
        <button type="button" class="secondary" id="add-piece">Add ready piece</button>
        <button type="button" class="secondary" id="add-metal">Add metal / bullion</button></div>
      <p class="muted">Ready pieces get an item code and go into stock at the price paid. Metal goes into metal stock by fine weight.</p>
      <div id="lines"></div>
      <div class="panel"><div class="form-grid" style="align-items:end">
        <div class="stat"><div class="label">Purchase total</div><div class="value" id="total">Rs 0.00</div></div>
        ${field('Paid now (Rs)', numberInput('pay_amount', ''), { hint: 'Leave empty if nothing was paid now.' })}
        ${field('Paid by', select('pay_method', Object.entries(METHOD_LABELS), 'bank'))}
        ${field('Reference', '<input name="pay_reference" maxlength="100">')}
      </div>
      <div class="actions"><button type="submit">Save purchase</button></div></div>
    </form>`;
  wireDateFields(main);
  const updateTotal = () => {
    const total = $$('#lines [name="amount"]').reduce((a, el) => a + Math.round((Number(el.value) || 0) * 100), 0);
    $('#total').textContent = money(total);
  };
  const lines = repeater($('#lines'), () => '', { onChange: updateTotal });
  $('#add-piece').addEventListener('click', () => {
    const row = lines.add(`<input type="hidden" name="kind" value="piece"><strong class="field wide">Ready piece</strong>
      ${pieceFields(refs, field('Price paid (Rs)', numberInput('amount', '', 'required')))}`);
    $('[name="name"]', row).focus();
  });
  $('#add-metal').addEventListener('click', () => {
    const row = lines.add(`<input type="hidden" name="kind" value="metal"><strong class="field wide">Metal / bullion</strong>
      ${field('Description', '<input name="description" maxlength="100" placeholder="e.g. Fine gold bar">')}
      ${field('Purity', select('purity_id', purityOptions, purityOptions[0] && purityOptions[0][0]))}
      ${field('Weight (g)', numberInput('gross_g', '', 'required'))}
      ${field('Price paid (Rs)', numberInput('amount', '', 'required'))}`);
    $('[name="gross_g"]', row).focus();
  });
  $('#purchase-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    const body = {
      supplier_id: v.supplier_id, supplier_bill_no: v.supplier_bill_no, date: v.date, remarks: v.remarks,
      lines: lines.rows().map(rowValues),
      payment: { method: v.pay_method, amount: v.pay_amount, reference: v.pay_reference }
    };
    if (!body.lines.length) return toast('Add at least one piece or metal line.', 'error');
    attempt(async () => {
      const p = await api('POST', '/api/purchases', body);
      clearCache('categories');
      toast(`Purchase ${p.purchase_no} saved.`);
      go(`/purchases/${p.id}`);
    }, e.submitter);
  });
}

async function pagePurchaseView(main, purchaseId) {
  const p = await api('GET', `/api/purchases/${purchaseId}`);
  const pieceIds = p.lines.filter((l) => l.product_id).map((l) => l.product_id);
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/purchases">Back to purchases</a>
      <button id="print">Print</button>${pieceIds.length ? `<a class="button secondary" href="#/labels?ids=${pieceIds.join(',')}">Print tags</a>` : ''}</div>
    <h1>Purchase ${esc(p.purchase_no)} ${statusBadge(p.status)}</h1>
    ${p.status === 'cancelled' ? `<div class="banner danger">Cancelled: ${esc(p.cancel_reason)}</div>` : ''}
    <div class="panel"><p><strong>${esc(p.supplier_name)}</strong>${p.supplier_bill_no ? ` · their bill ${esc(p.supplier_bill_no)}` : ''}<br>
      ${esc(fmtDate(p.purchase_date))} · entered by ${esc(p.created_by_name)}${p.remarks ? `<br>${esc(p.remarks)}` : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>Description</th><th>Purity</th><th class="num">Weight</th><th class="num">Fine</th><th>Item code</th><th class="num">Amount</th></tr></thead>
      <tbody>${p.lines.map((l) => `<tr><td>${l.kind === 'piece' ? 'Piece' : 'Metal'}</td><td>${esc(l.description)}</td><td>${esc(l.metal_name)} ${esc(l.purity_name)}</td>
        <td class="num">${grams(l.gross_mg)}</td><td class="num">${grams(l.fine_mg)}</td>
        <td>${l.product_id ? `<a href="#/products/${l.product_id}">${esc(l.item_code)}</a> ${l.product_status !== 'in_stock' ? statusBadge(l.product_status) : ''}` : (l.kind === 'piece' ? '<span class="muted">—</span>' : '')}</td>
        <td class="num">${money(l.amount_paisa)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="6">Total</td><td class="num">${money(p.total_paisa)}</td></tr>
        <tr><td colspan="6">Paid when bought</td><td class="num">${money(p.paid_paisa)}</td></tr></tfoot></table></div>
      ${can('payments.make') ? `<p class="muted" style="margin-top:.5rem">Anything not paid is added to what you owe ${esc(p.supplier_name)}. <a href="#/suppliers/${p.supplier_id}">See supplier account</a>.</p>` : ''}
    </div>
    ${p.status === 'posted' && can('purchases.cancel') ? `<form class="panel no-print" id="cancel-form"><h2>Cancel purchase</h2>
      <p class="muted">Only possible while its pieces are still in stock and its metal is still in metal stock.</p>
      ${field('Reason', '<input name="reason" required maxlength="300">')}
      <div class="actions"><button class="danger" type="submit">Cancel this purchase</button></div></form>` : ''}`;
  $('#print').addEventListener('click', () => window.print());
  const cancel = $('#cancel-form');
  if (cancel) cancel.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!confirm(`Cancel ${p.purchase_no}?`)) return;
    attempt(async () => { await api('POST', `/api/purchases/${purchaseId}/cancel`, formValues(e.target)); toast('Purchase cancelled.'); render(); }, e.submitter);
  });
}

// ---------------------------------------------------------------- Suppliers

async function pageSuppliers(main) {
  const suppliers = await api('GET', '/api/suppliers');
  const owner = can('payments.make');
  main.innerHTML = `
    <h1>Suppliers</h1>
    <div class="toolbar"><span class="spacer"></span><a class="button secondary" href="#/purchases">Purchases</a>
      <button id="add">Add supplier</button></div>
    ${partyForm('supplier')}
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Phone</th><th>PAN</th>${owner ? '<th class="num">You owe</th>' : ''}<th></th></tr></thead>
      <tbody>${suppliers.map((s) => `<tr${owner ? ` class="clickable" data-href="#/suppliers/${s.id}"` : ''}><td>${esc(s.name)} ${s.is_active ? '' : '<span class="badge">Inactive</span>'}</td>
        <td>${esc(s.phone || '')}</td><td>${esc(s.pan || '')}</td>${owner ? `<td class="num">${s.balance_paisa ? money(s.balance_paisa) : ''}</td>` : ''}
        <td><button class="link small" data-edit="${s.id}">Edit</button></td></tr>`).join('') || empty('No suppliers yet.', owner ? 5 : 4)}</tbody>
      ${owner ? `<tfoot><tr><td colspan="3">Total owed</td><td class="num">${money(suppliers.reduce((a, s) => a + s.balance_paisa, 0))}</td><td></td></tr></tfoot>` : ''}
    </table></div>`;
  wirePartyForm('supplier', '/api/suppliers', suppliers);
  bindRowLinks(main);
}

function partyForm(kind) {
  return `<form class="panel" id="party-form" hidden><h2 id="party-title"></h2><input type="hidden" name="id">
    <div class="form-grid">
      ${field('Name', '<input name="name" required maxlength="100">')}
      ${field('Phone', '<input name="phone" maxlength="20">')}
      ${field('Address', '<input name="address" maxlength="200">')}
      ${kind === 'supplier' ? field('PAN', '<input name="pan" maxlength="20">') : ''}
      ${field('Notes', '<input name="notes" maxlength="300">')}
      <label class="check"><input type="checkbox" name="is_active" checked> Active</label>
    </div>
    <div class="actions"><button type="submit">Save</button><button type="button" class="secondary" id="party-close">Close</button></div></form>`;
}

function wirePartyForm(kind, url, rows) {
  const form = $('#party-form');
  const label = kind === 'supplier' ? 'supplier' : 'karigar';
  const open = (row) => {
    form.hidden = false;
    form.reset();
    $('#party-title').textContent = row ? `Edit ${row.name}` : `Add ${label}`;
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = row ? !!row[el.name] : true;
      else el.value = row ? (row[el.name] ?? '') : '';
    }
    form.elements.name.focus();
  };
  $('#add').addEventListener('click', () => open(null));
  $('#party-close').addEventListener('click', () => { form.hidden = true; });
  $$('[data-edit]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); open(rows.find((r) => String(r.id) === b.dataset.edit)); }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(form);
    attempt(async () => {
      if (v.id) await api('PUT', `${url}/${v.id}`, v); else await api('POST', url, v);
      toast('Saved.');
      render();
    }, e.submitter);
  });
}

/** Statement page shared by suppliers and karigars. */
function statementTable(lines, oweLabel) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Entry</th><th>Details</th><th class="num">Paid / returned</th><th class="num">Owed</th><th class="num">${esc(oweLabel)}</th></tr></thead>
    <tbody>${lines.map((l) => `<tr><td>${esc(fmtDay(l.entry_date))}</td><td>${esc(l.entry_no)}</td><td>${esc(l.narration)}</td>
      <td class="num">${l.debit_paisa ? amt(l.debit_paisa) : ''}</td><td class="num">${l.credit_paisa ? amt(l.credit_paisa) : ''}</td>
      <td class="num">${amt(l.balance_paisa)}</td></tr>`).join('') || empty('Nothing yet.', 6)}</tbody></table></div>`;
}

function payForm(title) {
  return `<form class="panel" id="pay-form"><h2>${esc(title)}</h2><div class="form-grid">
    ${field('Amount (Rs)', numberInput('amount', '', 'required'))}
    ${field('Paid by', select('method', Object.entries(METHOD_LABELS), 'cash'))}
    ${field('Reference', '<input name="reference" maxlength="100">')}
    ${field('Note', '<input name="note" maxlength="200">')}
  </div><div class="actions"><button type="submit">Record payment</button></div></form>`;
}

async function pageSupplier(main, supplierId) {
  const { supplier, lines } = await api('GET', `/api/suppliers/${supplierId}/statement`);
  const owed = lines.length ? lines[lines.length - 1].balance_paisa : 0;
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/suppliers">Back to suppliers</a><button id="print">Print</button></div>
    <h1>${esc(supplier.name)}</h1>
    <p class="muted">${[supplier.phone, supplier.address, supplier.pan ? `PAN ${supplier.pan}` : ''].filter(Boolean).map(esc).join(' · ')}</p>
    <div class="grid cols-4"><div class="panel stat"><div class="label">You owe</div><div class="value">${money(owed)}</div></div></div>
    ${can('payments.make') ? `<div class="no-print">${payForm(`Pay ${supplier.name}`)}</div>` : ''}
    <div class="panel"><h2>Account</h2>${statementTable(lines, 'You owe')}</div>`;
  $('#print').addEventListener('click', () => window.print());
  const pay = $('#pay-form');
  if (pay) pay.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => { const r = await api('POST', `/api/suppliers/${supplierId}/payments`, formValues(e.target)); toast(`Payment ${r.voucher_no} recorded.`); render(); }, e.submitter);
  });
}

// ---------------------------------------------------------------- Metal stock

const SOURCE_LABELS = {
  opening: 'Opening stock', purchase: 'Bought from supplier', exchange: 'Old gold in exchange', old_gold_purchase: 'Old gold bought',
  karigar_issue: 'Given to karigar', karigar_return: 'Returned by karigar', adjustment: 'Loss', cancel: 'Cancelled'
};

async function pageMetal(main) {
  const data = await api('GET', '/api/metal');
  main.innerHTML = `
    <h1>Metal stock and old gold</h1>
    <p class="muted">Gold and silver the shop holds that is not a tagged piece: old gold taken in, bullion bought, and metal returned by karigars. Weights are fine (pure) weight.</p>
    <div class="toolbar"><a class="button gold" href="#/old-gold/new">Buy old gold</a><a class="button secondary" href="#/old-gold">Old gold vouchers</a>
      ${can('karigars.manage') ? '<a class="button secondary" href="#/jobs/new">Give gold to karigar</a>' : ''}</div>
    <div class="grid cols-4">${data.metals.map((m) => `<div class="panel stat"><div class="label">${esc(m.name)} in stock (fine)</div>
      <div class="value">${grams(m.fine_mg)}</div><div class="sub">Value ${money(m.value_paisa)}${m.fine_mg > 0 ? `<br>Average ${money(m.average_per_gram)} per gram` : ''}
      ${m.with_karigars_mg ? `<br>With karigars: ${grams(m.with_karigars_mg)}` : ''}</div></div>`).join('')}</div>
    <form class="panel" id="adjust-form"><h2>Record a loss${can('accounts.manage') ? ' or opening stock' : ''}</h2>
      <div class="form-grid">
        ${field('Type', select('kind', [['loss', 'Loss (melting, refining, testing)'], ...(can('accounts.manage') ? [['opening', 'Opening stock (when you start using JewelPro)']] : [])], 'loss'))}
        ${field('Metal', select('metal_id', data.metals.map((m) => [m.id, m.name]), data.metals[0] && data.metals[0].id))}
        ${field('Fine weight (g)', numberInput('fine_g', '', 'required'))}
        ${field('Value (Rs)', numberInput('value', ''), { hint: 'Opening stock only. A loss is valued at the average cost.' })}
        ${field('Note', '<input name="note" required maxlength="200">', { wide: true })}
      </div><div class="actions"><button type="submit">Save</button></div></form>
    <div class="panel"><h2>Movements</h2><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Metal</th><th>What</th><th>Details</th><th class="num">Fine in / out</th><th class="num">Value</th><th>By</th></tr></thead>
      <tbody>${data.entries.map((e) => `<tr><td>${esc(fmtDate(e.entry_date))}</td><td>${esc(e.metal_name)}</td><td>${esc(SOURCE_LABELS[e.source] || e.source)}</td>
        <td>${esc(e.note || '')}</td><td class="num ${e.fine_mg < 0 ? 'error-text' : ''}">${e.fine_mg > 0 ? '+' : ''}${grams(e.fine_mg)}</td>
        <td class="num">${amt(e.value_paisa)}</td><td>${esc(e.created_by_name || '')}</td></tr>`).join('') || empty('No metal movements yet.', 7)}</tbody>
    </table></div></div>`;
  $('#adjust-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    if (v.kind === 'loss' && !confirm(`Record a loss of ${v.fine_g} g fine?`)) return;
    attempt(async () => { await api('POST', '/api/metal/adjust', v); toast('Saved.'); render(); }, e.submitter);
  });
}

// ---------------------------------------------------------------- Old gold bought from customers

async function pageOldGoldList(main, _id, params) {
  const from = params.get('from') || periodStart('month');
  const to = params.get('to') || localDate();
  const rows = await api('GET', `/api/old-gold-purchases?from=${from}&to=${to}`);
  const posted = rows.filter((r) => r.status === 'posted');
  main.innerHTML = `
    <h1>Old gold vouchers</h1>
    <form class="toolbar" id="filter">${dateField('From', 'from', from)}${dateField('To', 'to', to)}<button type="submit">Show</button>
      <span class="spacer"></span><a class="button gold" href="#/old-gold/new">Buy old gold</a></form>
    <div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Date</th><th>Customer</th><th class="num">Fine</th><th class="num">Paid</th><th>Status</th></tr></thead>
      <tbody>${rows.map((v) => `<tr class="clickable" data-href="#/old-gold/${v.id}"><td>${esc(v.voucher_no)}</td><td>${esc(fmtDate(v.purchase_date))}</td>
        <td>${esc(v.customer_name)}</td><td class="num">${grams(v.fine_mg)}</td><td class="num">${money(v.total_paisa)}</td><td>${statusBadge(v.status)}</td></tr>`).join('')
        || empty('None in this period.', 6)}</tbody>
      <tfoot><tr><td colspan="3">Total</td><td class="num">${grams(posted.reduce((a, v) => a + v.fine_mg, 0))}</td>
        <td class="num">${money(posted.reduce((a, v) => a + v.total_paisa, 0))}</td><td></td></tr></tfoot></table></div>`;
  $('#filter').addEventListener('submit', (e) => { e.preventDefault(); const v = formValues(e.target); go(`/old-gold?from=${v.from}&to=${v.to}`); });
  wireDateFields(main);
  bindRowLinks(main);
}

async function pageOldGoldNew(main) {
  const purities = await cached('purities', '/api/purities');
  const options = purities.filter((p) => p.is_active).map((p) => [p.id, `${p.metal_name} ${p.name}`]);
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/metal">Back to metal stock</a></div>
    <h1>Buy old gold</h1>
    <p class="muted">Valued at today's buying rate: (weight − less weight) × (100% − refining %) × rate. Keep a record of who sold it to you.</p>
    <div class="panel" id="customer"></div>
    <div class="toolbar"><h2 style="margin:0">Old gold</h2><span class="spacer"></span><button class="secondary" id="add-line">Add another piece</button></div>
    <div id="lines"></div>
    <form class="panel" id="og-form"><div class="form-grid" style="align-items:end">
      <div class="stat"><div class="label">Pay the customer</div><div class="value" id="og-total">—</div></div>
      ${field('Paid by', select('method', Object.entries(METHOD_LABELS), 'cash'))}
      ${field('Reference', '<input name="reference" maxlength="100">')}
      ${field('Remarks', '<input name="remarks" maxlength="300">')}
    </div><p class="error-text" id="og-error"></p><div class="actions"><button type="submit" id="og-save">Save and print voucher</button></div></form>`;
  const picker = await customerPicker($('#customer'));
  let timer;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const list = lines.rows().map(rowValues).filter((l) => Number(l.gross_g) > 0);
      if (!list.length) { $('#og-total').textContent = '—'; $('#og-error').textContent = ''; return; }
      try {
        const r = await api('POST', '/api/old-gold-purchases/preview', { lines: list });
        $('#og-total').textContent = money(r.total);
        $('#og-error').textContent = '';
        let k = 0;
        lines.rows().forEach((row) => {
          if (Number(rowValues(row).gross_g) > 0) { const x = r.lines[k]; k += 1; $('.og-value', row).textContent = `${money(x.amount)} (fine ${grams(x.fine_mg)})`; }
        });
      } catch (err) { $('#og-error').textContent = err.message; }
    }, 300);
  };
  const lines = repeater($('#lines'), () => `
    ${field('Description', '<input name="description" maxlength="100" value="Old gold">')}
    ${field('Purity', select('purity_id', options, options[1] ? options[1][0] : options[0] && options[0][0]))}
    ${field('Weight (g)', numberInput('gross_g', ''))}
    ${field('Less weight (g)', numberInput('less_g', ''))}
    ${field('Refining %', numberInput('refining_percent', '', 'max="100"'))}
    <div><div class="muted" style="font-size:.9rem">Value</div><strong class="og-value">—</strong></div>`, { onChange: preview });
  lines.add();
  $('#add-line').addEventListener('click', () => lines.add());
  $('#og-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    const body = { customer_id: picker.value, lines: lines.rows().map(rowValues).filter((l) => Number(l.gross_g) > 0),
      payment: { method: v.method, reference: v.reference }, remarks: v.remarks };
    if (!body.customer_id) return toast('Choose or add the customer.', 'error');
    attempt(async () => {
      const r = await api('POST', '/api/old-gold-purchases', body);
      toast(`${r.voucher_no} saved.`);
      go(`/old-gold/${r.id}?print=1`);
    }, e.submitter);
  });
}

async function pageOldGoldView(main, voucherId, params) {
  const v = await api('GET', `/api/old-gold-purchases/${voucherId}`);
  const s = state.settings;
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/old-gold">Back to vouchers</a><button id="print">Print</button></div>
    ${v.status === 'cancelled' ? `<div class="banner danger no-print">Cancelled: ${esc(v.cancel_reason)}</div>` : ''}
    <article class="invoice">
      ${v.status === 'cancelled' ? '<div class="watermark">CANCELLED</div>' : ''}
      <header><div><div class="shop-name">${esc(s.shop_name)}</div>${s.shop_address ? `<div>${esc(s.shop_address)}</div>` : ''}${s.shop_phone ? `<div>Phone: ${esc(s.shop_phone)}</div>` : ''}</div>
        <div><div class="doc-title">Old gold purchase</div><div class="num">No: <strong>${esc(v.voucher_no)}</strong></div><div class="num">Date: ${esc(fmtDate(v.purchase_date))}</div></div></header>
      <p><strong>Bought from:</strong> ${esc(v.customer_name)}${v.customer_phone ? `, ${esc(v.customer_phone)}` : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Description</th><th>Purity</th><th class="num">Weight</th><th class="num">Less</th><th class="num">Net</th>
        <th class="num">Refining</th><th class="num">Rate/g (Rs)</th><th class="num">Amount (Rs)</th></tr></thead>
        <tbody>${v.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.purity_name)}</td><td class="num">${grams(l.gross_mg)}</td><td class="num">${grams(l.less_mg)}</td>
          <td class="num">${grams(l.net_mg)}</td><td class="num">${l.refining_percent}%</td><td class="num">${amt(Math.round(l.rate_per_gram))}</td><td class="num">${amt(l.amount_paisa)}</td></tr>`).join('')}</tbody></table></div>
      <div class="totals"><div class="row grand"><span>Paid by ${esc(METHOD_LABELS[v.method])}${v.reference ? ` (${esc(v.reference)})` : ''}</span><span>${money(v.total_paisa)}</span></div></div>
      <footer><div><small class="muted">Entered by ${esc(v.created_by_name)}</small></div>
        <div style="display:flex;gap:2rem"><div class="sign">Seller's signature</div><div class="sign">For ${esc(s.shop_name)}</div></div></footer>
    </article>
    ${v.status === 'posted' ? `<form class="panel no-print" id="cancel-form" style="margin-top:1rem"><h2>Cancel voucher</h2>
      ${field('Reason', '<input name="reason" required maxlength="300">')}<div class="actions"><button class="danger" type="submit">Cancel voucher</button></div></form>` : ''}`;
  $('#print').addEventListener('click', () => window.print());
  const cancel = $('#cancel-form');
  if (cancel) cancel.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!confirm(`Cancel ${v.voucher_no}?`)) return;
    attempt(async () => { await api('POST', `/api/old-gold-purchases/${voucherId}/cancel`, formValues(e.target)); toast('Voucher cancelled.'); render(); }, e.submitter);
  });
  if (params.get('print') === '1') { history.replaceState(null, '', `#/old-gold/${voucherId}`); setTimeout(() => window.print(), 300); }
}
