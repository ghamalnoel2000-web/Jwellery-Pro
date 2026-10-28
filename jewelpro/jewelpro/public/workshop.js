'use strict';

/* ======================================================================
   Karigars and their jobs, customer orders, repairs.
   ====================================================================== */

// ---------------------------------------------------------------- Karigars

async function pageKarigars(main) {
  const karigars = await api('GET', '/api/karigars');
  const anyOwed = karigars.some((k) => k.payable_paisa);
  main.innerHTML = `
    <h1>Karigars</h1>
    <p class="muted">Gold balance is fine gold given to a karigar that has not yet come back as pieces, returned metal or allowed wastage.</p>
    <div class="toolbar"><a class="button secondary" href="#/jobs">All jobs</a><span class="spacer"></span>
      <a class="button secondary" href="#/jobs/new">Give gold for a job</a><button id="add">Add karigar</button></div>
    ${partyForm('karigar')}
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Phone</th><th class="num">Gold balance (fine)</th>${anyOwed ? '<th class="num">Labour owed</th>' : ''}<th class="num">Open jobs</th><th></th></tr></thead>
      <tbody>${karigars.map((k) => `<tr class="clickable" data-href="#/karigars/${k.id}"><td>${esc(k.name)} ${k.is_active ? '' : '<span class="badge">Inactive</span>'}</td>
        <td>${esc(k.phone || '')}</td><td class="num">${k.gold_balance_mg ? grams(k.gold_balance_mg) : ''}</td>
        ${anyOwed ? `<td class="num">${k.payable_paisa ? money(k.payable_paisa) : ''}</td>` : ''}
        <td class="num">${k.open_jobs || ''}${k.overdue_jobs ? ` <span class="badge danger">${k.overdue_jobs} overdue</span>` : ''}</td>
        <td><button class="link small" data-edit="${k.id}">Edit</button></td></tr>`).join('') || empty('No karigars yet.', 6)}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${grams(karigars.reduce((a, k) => a + k.gold_balance_mg, 0))}</td>
        ${anyOwed ? `<td class="num">${money(karigars.reduce((a, k) => a + k.payable_paisa, 0))}</td>` : ''}<td colspan="2"></td></tr></tfoot>
    </table></div>`;
  wirePartyForm('karigar', '/api/karigars', karigars);
  bindRowLinks(main);
}

function jobsTable(jobs) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Job</th><th>Karigar</th><th>Work</th><th>Due</th><th class="num">Gold given</th><th class="num">Accounted for</th><th class="num">With karigar</th><th>Status</th></tr></thead>
    <tbody>${jobs.map((j) => `<tr class="clickable" data-href="#/jobs/${j.id}"><td>${esc(j.job_no)}${j.order_no ? `<br><small class="muted">${esc(j.order_no)}</small>` : ''}</td>
      <td>${esc(j.karigar_name)}</td><td>${esc(j.description)}</td><td>${j.status === 'open' ? dueBadge(j.due_date) : esc(fmtDay(j.closed_at))}</td>
      <td class="num">${grams(j.issued_fine_mg)}</td><td class="num">${grams(j.consumed_fine_mg)}</td>
      <td class="num"><strong>${grams(j.issued_fine_mg - j.consumed_fine_mg)}</strong></td>
      <td>${j.status === 'open' ? '<span class="badge warn">Open</span>' : '<span class="badge">Closed</span>'}</td></tr>`).join('') || empty('No jobs.', 8)}</tbody>
  </table></div>`;
}

function jobReminder(job) {
  const left = ((job.issued_fine_mg - job.consumed_fine_mg) / 1000).toFixed(3);
  return `Namaste ${job.karigar_name}ji. Reminder from ${shopName()}: job ${job.job_no} (${job.description})`
    + `${job.due_date ? ` was due on ${fmtDay(adDate(job.due_date).toISOString())}` : ''}. Gold with you on this job: ${left} g fine. Please update us. Thank you.`;
}

async function pageKarigar(main, karigarId, params = new URLSearchParams()) {
  const from = params.get('from') || periodStart('month');
  const to = params.get('to') || localDate();
  const [work, jobs, statement] = await Promise.all([
    api('GET', `/api/karigars/${karigarId}/work?from=${from}&to=${to}`),
    api('GET', `/api/karigar-jobs?status=all&karigar_id=${karigarId}`),
    can('payments.make') ? api('GET', `/api/karigars/${karigarId}/statement`) : Promise.resolve({ lines: [] })]);
  const { karigar, gold } = work;
  const pt = work.piece_totals;
  const withKarigar = jobs.reduce((a, j) => a + j.issued_fine_mg - j.consumed_fine_mg, 0);
  const owed = statement.lines.length ? statement.lines[statement.lines.length - 1].balance_paisa : 0;
  const base = `#/karigars/${karigarId}`;
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/karigars">Back to karigars</a><button id="print">Print</button>
      <a class="button secondary" href="#/jobs/new?karigar=${karigar.id}">Give gold for a job</a></div>
    <h1>${esc(karigar.name)}</h1>
    <p class="muted">${[karigar.phone, karigar.address].filter(Boolean).map(esc).join(' · ')}</p>
    <div class="grid cols-4">
      <div class="panel stat"><div class="label">Gold with karigar now (fine)</div><div class="value">${grams(withKarigar)}</div></div>
      <div class="panel stat"><div class="label">Pieces made in this period</div><div class="value">${pt.pieces}</div>
        <div class="sub">${grams(pt.gross_mg)} gross · ${grams(pt.net_mg)} net · ${grams(pt.fine_mg)} fine</div></div>
    </div>
    <form class="toolbar no-print" id="period">${dateField('From', 'from', from)}${dateField('To', 'to', to)}<button type="submit">Show</button>
      <a class="button secondary" href="${base}?from=${periodStart('month')}&to=${localDate()}">This month</a>
      <a class="button secondary" href="${base}?from=${periodStart('fiscal')}&to=${localDate()}">This fiscal year</a>
      <a class="button secondary" href="${base}?from=2000-01-01&to=${localDate()}">All time</a></form>

    <div class="panel"><h2>Items made for the shop</h2>
      ${work.by_category.length ? `<div class="table-wrap"><table style="margin-bottom:1rem"><thead><tr><th>Category</th><th class="num">Pieces</th><th class="num">Gross</th><th class="num">Net</th><th class="num">Fine</th></tr></thead>
        <tbody>${work.by_category.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.pieces}</td><td class="num">${grams(c.gross_mg)}</td>
          <td class="num">${grams(c.net_mg)}</td><td class="num">${grams(c.fine_mg)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${pt.pieces}</td><td class="num">${grams(pt.gross_mg)}</td><td class="num">${grams(pt.net_mg)}</td><td class="num">${grams(pt.fine_mg)}</td></tr></tfoot></table></div>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Received</th><th>Job</th><th>Code</th><th>Item</th><th>Purity</th><th class="num">Gross</th><th class="num">Net</th><th class="num">Fine</th><th>Now</th></tr></thead>
        <tbody>${work.pieces.map((p) => `<tr class="clickable" data-href="#/products/${p.id}"><td>${esc(fmtDay(p.received_at))}</td>
          <td><a href="#/jobs/${p.job_id}">${esc(p.job_no)}</a></td><td><strong>${esc(p.item_code)}</strong></td><td>${esc(p.name)}<br><small class="muted">${esc(p.category_name)}</small></td>
          <td>${esc(p.metal_name)} ${esc(p.purity_name)}</td><td class="num">${grams(p.gross_mg)}</td><td class="num">${grams(p.net_mg)}</td>
          <td class="num">${grams(p.fine_mg)}</td><td>${statusBadge(p.status)}</td></tr>`).join('') || empty('No pieces received in this period.', 9)}</tbody>
      </table></div></div>

    <div class="panel"><h2>Gold account (fine weight)</h2>
      <p class="muted">Gold given to the karigar, and what came back as pieces, as metal, or as wastage allowed. The balance is gold still with the karigar.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Job</th><th>Details</th><th class="num">Given</th><th class="num">In pieces</th><th class="num">Metal back</th><th class="num">Wastage</th><th class="num">Balance</th></tr></thead>
        <tbody><tr><td colspan="7"><em>Balance at start of period</em></td><td class="num">${grams(gold.opening_mg)}</td></tr>
          ${gold.entries.map((e) => `<tr><td>${esc(fmtDay(e.at))}</td><td>${esc(e.job_no)}</td>
            <td>${e.given_mg ? `Gold given: ${esc(e.purity_name)} ${grams(e.gross_mg)}` : `Received ${e.pieces} piece${e.pieces === 1 ? '' : 's'}`}</td>
            <td class="num">${e.given_mg ? grams(e.given_mg) : ''}</td><td class="num">${e.pieces_fine_mg ? grams(e.pieces_fine_mg) : ''}</td>
            <td class="num">${e.returned_fine_mg ? grams(e.returned_fine_mg) : ''}</td><td class="num">${e.wastage_fine_mg ? grams(e.wastage_fine_mg) : ''}</td>
            <td class="num">${grams(e.balance_mg)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="3">Period total / balance at end</td><td class="num">${grams(gold.totals.given_mg)}</td><td class="num">${grams(gold.totals.pieces_fine_mg)}</td>
          <td class="num">${grams(gold.totals.returned_fine_mg)}</td><td class="num">${grams(gold.totals.wastage_fine_mg)}</td><td class="num">${grams(gold.closing_mg)}</td></tr></tfoot>
      </table></div></div>

    <div class="panel"><h2>Jobs</h2>${jobsTable(jobs)}</div>
    ${can('payments.make') ? `<details class="panel no-print"><summary><strong>Labour and payments</strong> <span class="muted">(optional${owed ? `, owed ${money(owed)}` : ''})</span></summary>
      <div style="margin-top:.75rem">${payForm(`Pay ${karigar.name}`)}${statementTable(statement.lines, 'Owed')}</div></details>` : ''}`;
  wireDateFields(main);
  $('#period').addEventListener('submit', (e) => { e.preventDefault(); const v = formValues(e.target); go(`/karigars/${karigarId}?from=${v.from}&to=${v.to}`); });
  $('#print').addEventListener('click', () => window.print());
  const pay = $('#pay-form');
  if (pay) pay.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => { const r = await api('POST', `/api/karigars/${karigarId}/payments`, formValues(e.target)); toast(`Payment ${r.voucher_no} recorded.`); render(); }, e.submitter);
  });
  bindRowLinks(main);
}

// ---------------------------------------------------------------- Karigar jobs

async function pageJobs(main, _id, params) {
  const status = params.get('status') || 'open';
  const jobs = await api('GET', `/api/karigar-jobs?status=${status}`);
  const overdue = jobs.filter((j) => j.status === 'open' && isOverdue(j.due_date));
  main.innerHTML = `
    <h1>Karigar jobs</h1>
    <form class="toolbar" id="filter">${field('Show', select('status', [['open', 'Open jobs'], ['closed', 'Closed jobs'], ['all', 'All jobs']], status))}
      <button type="submit">Show</button><span class="spacer"></span><a class="button secondary" href="#/karigars">Karigars</a>
      <a class="button" href="#/jobs/new">Give gold for a job</a></form>
    ${overdue.length ? `<div class="panel"><h2>Overdue</h2>${overdue.map((j) => `<p>${esc(j.job_no)} · ${esc(j.karigar_name)} · ${esc(j.description)} · due ${esc(fmtDay(adDate(j.due_date).toISOString()))}
      ${waButton(j.karigar_phone, jobReminder(j), 'Remind on WhatsApp')}</p>`).join('')}</div>` : ''}
    ${jobsTable(jobs)}`;
  $('#filter').addEventListener('submit', (e) => { e.preventDefault(); go(`/jobs?status=${formValues(e.target).status}`); });
  bindRowLinks(main);
}

async function pageJobNew(main, _id, params) {
  const [karigars, purities, metalData, orders] = await Promise.all([
    api('GET', '/api/karigars'), cached('purities', '/api/purities'), api('GET', '/api/metal'),
    can('orders.manage') ? api('GET', '/api/orders?status=active') : Promise.resolve([])]);
  const active = karigars.filter((k) => k.is_active);
  const options = purities.filter((p) => p.is_active).map((p) => [p.id, `${p.metal_name} ${p.name}`]);
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/jobs">Back to jobs</a></div>
    <h1>Give gold for a job</h1>
    <p class="muted">In metal stock now: ${metalData.metals.map((m) => `${esc(m.name)} ${grams(m.fine_mg)} fine`).join(', ')}.
      Gold must be in metal stock (bought, old gold, or opening stock) before it can be given.</p>
    ${active.length ? '' : '<div class="banner">Add the karigar first on the <a href="#/karigars">Karigars</a> page.</div>'}
    <form id="job-form">
      <div class="panel"><div class="form-grid">
        ${field('Karigar', select('karigar_id', [['', 'Choose…'], ...active.map((k) => [k.id, k.name])], params.get('karigar') || '', 'required'))}
        ${field('Work to be made', '<input name="description" required maxlength="200" placeholder="e.g. 2 pairs of earrings, design 14">')}
        ${dateField('Due', 'due_date', inDays(7))}
        ${field('For customer order', select('order_id', [['', 'Not for an order'], ...orders.map((o) => [o.id, `${o.order_no} — ${o.customer_name}`])], params.get('order') || ''))}
      </div></div>
      <div class="toolbar"><h2 style="margin:0">Gold given</h2><span class="spacer"></span><button type="button" class="secondary" id="add-line">Add another</button></div>
      <div id="lines"></div>
      <div class="actions"><button type="submit">Save and give gold</button></div>
    </form>`;
  wireDateFields(main);
  const lines = repeater($('#lines'), () => `
    ${field('Purity', select('purity_id', options, options[0] && options[0][0]))}
    ${field('Weight (g)', numberInput('gross_g', '', 'required'))}
    ${field('Note', '<input name="note" maxlength="200">')}`);
  lines.add();
  $('#add-line').addEventListener('click', () => lines.add());
  $('#job-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    attempt(async () => {
      const job = await api('POST', '/api/karigar-jobs', {
        karigar_id: v.karigar_id, description: v.description, due_date: v.due_date, order_id: v.order_id, issues: lines.rows().map(rowValues) });
      toast(`${job.job_no} saved.`);
      go(`/jobs/${job.id}`);
    }, e.submitter);
  });
}

async function pageJob(main, jobId) {
  const [job, refs] = await Promise.all([api('GET', `/api/karigar-jobs/${jobId}`), refsForPieces()]);
  const left = job.issued_fine_mg - job.consumed_fine_mg;
  const options = refs.purities.filter((p) => p.is_active && p.metal_name === job.metal_name).map((p) => [p.id, `${p.metal_name} ${p.name}`]);
  const open = job.status === 'open';
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/jobs">Back to jobs</a><button id="print">Print</button>
      ${job.pieces.length ? `<a class="button secondary" href="#/labels?ids=${job.pieces.map((p) => p.id).join(',')}">Print tags</a>` : ''}
      ${open ? waButton(job.karigar_phone, jobReminder(job), 'Remind on WhatsApp') : ''}</div>
    <h1>${esc(job.job_no)} · ${esc(job.karigar_name)} ${open ? '<span class="badge warn">Open</span>' : '<span class="badge">Closed</span>'}</h1>
    <p>${esc(job.description)}${job.order_no ? ` · for <a href="#/orders/${job.order_id}">${esc(job.order_no)}</a>` : ''} · due ${dueBadge(job.due_date)}</p>
    <div class="grid cols-4">
      <div class="panel stat"><div class="label">Gold given (fine)</div><div class="value">${grams(job.issued_fine_mg)}</div></div>
      <div class="panel stat"><div class="label">Accounted for</div><div class="value">${grams(job.consumed_fine_mg)}</div><div class="sub">Pieces, returned metal, wastage</div></div>
      <div class="panel stat"><div class="label">Still with karigar</div><div class="value">${grams(left)}</div></div>
    </div>
    <div class="grid cols-2">
      <div class="panel"><h2>Gold given</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Purity</th><th class="num">Weight</th><th class="num">Fine</th></tr></thead>
        <tbody>${job.issues.map((i) => `<tr><td>${esc(fmtDate(i.issued_at))}</td><td>${esc(i.purity_name)}</td><td class="num">${grams(i.gross_mg)}</td><td class="num">${grams(i.fine_mg)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="panel"><h2>Received back</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">In pieces</th><th class="num">Metal back</th><th class="num">Wastage</th><th class="num">Labour</th></tr></thead>
        <tbody>${job.receipts.map((r) => `<tr><td>${esc(fmtDate(r.received_at))}</td><td class="num">${grams(r.pieces_fine_mg)}</td><td class="num">${grams(r.returned_fine_mg)}</td>
          <td class="num">${grams(r.wastage_fine_mg)}</td><td class="num">${money(r.labour_paisa)}</td></tr>`).join('') || empty('Nothing yet.', 5)}</tbody></table></div></div>
    </div>
    ${job.pieces.length ? `<div class="panel"><h2>Pieces made</h2><div class="table-wrap"><table><thead><tr><th>Code</th><th>Item</th><th class="num">Gross</th><th class="num">Cost</th><th>Status</th></tr></thead>
      <tbody>${job.pieces.map((p) => `<tr class="clickable" data-href="#/products/${p.id}"><td>${esc(p.item_code)}</td><td>${esc(p.name)}</td><td class="num">${grams(p.gross_mg)}</td>
        <td class="num">${money(p.cost_paisa)}</td><td>${statusBadge(p.status)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${open ? `
    <form class="panel no-print" id="receive-form"><h2>Receive work</h2>
      <p class="muted">Each piece gets an item code and goes into stock, costed at the gold it used plus labour. Wastage allowed is fine gold the karigar keeps.</p>
      <div class="toolbar"><h3 style="margin:0">Pieces</h3><span class="spacer"></span><button type="button" class="secondary small" id="add-piece">Add piece</button></div>
      <div id="pieces"></div>
      <div class="toolbar"><h3 style="margin:0">Metal returned unused</h3><span class="spacer"></span><button type="button" class="secondary small" id="add-return">Add returned metal</button></div>
      <div id="returns"></div>
      <div class="form-grid">
        ${field('Wastage allowed (g fine)', numberInput('wastage_g', ''))}
        ${field('Labour charge (Rs, optional)', numberInput('labour', ''), { hint: 'Leave empty if you do not track labour here.' })}
        ${field('Note', '<input name="note" maxlength="200">')}
        <label class="check"><input type="checkbox" name="close"> Job finished (close it)</label>
      </div>
      <div class="actions"><button type="submit">Save receipt</button></div>
    </form>
    <div class="grid cols-2 no-print">
      <form class="panel" id="issue-form"><h2>Give more gold</h2><div class="form-grid">
        ${field('Purity', select('purity_id', options, options[0] && options[0][0]))}${field('Weight (g)', numberInput('gross_g', '', 'required'))}
      </div><div class="actions"><button type="submit">Give gold</button></div></form>
      <div class="panel"><h2>Close job</h2><p class="muted">${left ? `${grams(left)} fine stays as the karigar's gold balance.` : 'All gold is accounted for.'}</p>
        <button class="secondary" id="close-job">Close job</button></div>
    </div>` : ''}`;

  $('#print').addEventListener('click', () => window.print());
  bindRowLinks(main);
  if (!open) return;
  const pieces = repeater($('#pieces'), () => pieceFields(refs, '', { required: false }));
  const returns = repeater($('#returns'), () => `${field('Purity', select('purity_id', options, options[0] && options[0][0]))}${field('Weight (g)', numberInput('gross_g', ''))}`);
  $('#add-piece').addEventListener('click', () => pieces.add());
  $('#add-return').addEventListener('click', () => returns.add());
  pieces.add();
  $('#receive-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    attempt(async () => {
      const updated = await api('POST', `/api/karigar-jobs/${jobId}/receive`, {
        pieces: pieces.rows().map(rowValues).filter((x) => x.name || Number(x.gross_g) > 0),
        returned: returns.rows().map(rowValues),
        wastage_g: v.wastage_g, labour: v.labour, note: v.note, close: v.close });
      clearCache('categories');
      toast(`Received. ${updated.pieces.length} piece(s) in stock.`);
      render();
    }, e.submitter);
  });
  $('#issue-form').addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => { await api('POST', `/api/karigar-jobs/${jobId}/issue`, formValues(e.target)); toast('Gold given.'); render(); }, e.submitter);
  });
  $('#close-job').addEventListener('click', (e) => {
    if (!confirm(`Close ${job.job_no}?`)) return;
    attempt(async () => { await api('POST', `/api/karigar-jobs/${jobId}/close`); toast('Job closed.'); render(); }, e.target);
  });
}

// ---------------------------------------------------------------- Customer orders

const ORDER_STATUS = { open: ['Being made', 'warn'], ready: ['Ready', 'ok'], delivered: ['Delivered', ''], cancelled: ['Cancelled', 'danger'] };
const orderBadge = (s) => `<span class="badge ${ORDER_STATUS[s][1]}">${ORDER_STATUS[s][0]}</span>`;

async function pageOrders(main, _id, params) {
  const status = params.get('status') || 'active';
  const orders = await api('GET', `/api/orders?status=${status}`);
  main.innerHTML = `
    <h1>Customer orders</h1>
    <form class="toolbar" id="filter">${field('Show', select('status', [['active', 'Open and ready'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['all', 'All']], status))}
      <button type="submit">Show</button><span class="spacer"></span><a class="button" href="#/orders/new">New order</a></form>
    <div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Customer</th><th>What</th><th>Due</th><th class="num">Advance left</th><th>Status</th></tr></thead>
      <tbody>${orders.map((o) => `<tr class="clickable" data-href="#/orders/${o.id}"><td>${esc(o.order_no)}</td>
        <td>${esc(o.customer_name)}${o.customer_phone ? `<br><small class="muted">${esc(o.customer_phone)}</small>` : ''}</td><td>${esc(o.description)}</td>
        <td>${['open', 'ready'].includes(o.status) ? dueBadge(o.due_date) : ''}</td><td class="num">${o.available_paisa ? money(o.available_paisa) : ''}</td>
        <td>${orderBadge(o.status)}</td></tr>`).join('') || empty('No orders.', 6)}</tbody></table></div>`;
  $('#filter').addEventListener('submit', (e) => { e.preventDefault(); go(`/orders?status=${formValues(e.target).status}`); });
  bindRowLinks(main);
}

async function pageOrderNew(main) {
  const purities = await cached('purities', '/api/purities');
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/orders">Back to orders</a></div>
    <h1>New order</h1>
    <div class="panel" id="customer"></div>
    <form class="panel" id="order-form"><div class="form-grid">
      ${field('What is ordered', '<textarea name="description" required maxlength="300" placeholder="Design, size, stones, engraving…"></textarea>', { wide: true })}
      ${field('Purity', select('purity_id', [['', 'Not decided'], ...purities.filter((p) => p.is_active).map((p) => [p.id, `${p.metal_name} ${p.name}`])], ''))}
      ${field('Expected weight (g)', numberInput('expected_weight_g', ''))}
      ${dateField('Promised for', 'due_date', inDays(14))}
      ${field('Notes', '<input name="notes" maxlength="300">')}
    </div>
    <h2 style="margin-top:1rem">Advance received</h2>
    <div class="form-grid">
      ${field('Amount (Rs)', numberInput('advance_amount', ''))}
      ${field('Paid by', select('advance_method', Object.entries(METHOD_LABELS), 'cash'))}
      ${field('Reference', '<input name="advance_reference" maxlength="100">')}
    </div>
    <div class="actions"><button type="submit">Save order</button></div></form>`;
  wireDateFields(main);
  const picker = await customerPicker($('#customer'));
  $('#order-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!picker.value) return toast('Choose or add the customer.', 'error');
    const v = formValues(e.target);
    attempt(async () => {
      const o = await api('POST', '/api/orders', {
        customer_id: picker.value, description: v.description, purity_id: v.purity_id, expected_weight_g: v.expected_weight_g,
        due_date: v.due_date, notes: v.notes, advance: { method: v.advance_method, amount: v.advance_amount, reference: v.advance_reference } });
      toast(`Order ${o.order_no} saved.`);
      go(`/orders/${o.id}?print=1`);
    }, e.submitter);
  });
}

async function pageOrder(main, orderId, params) {
  const o = await api('GET', `/api/orders/${orderId}`);
  const s = state.settings;
  const active = ['open', 'ready'].includes(o.status);
  const readyMsg = `Namaste ${o.customer_name}ji. Your order ${o.order_no} (${o.description}) is ready at ${shopName()}.`
    + `${o.available_paisa ? ` Advance paid: ${rupees(o.available_paisa)}.` : ''} Please visit us. Thank you.`;
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/orders">Back to orders</a><button id="print">Print receipt</button>
      ${o.status === 'ready' ? waButton(o.customer_phone, readyMsg, 'Tell customer on WhatsApp') : ''}
      ${active && can('sales.create') ? `<a class="button gold" href="#/billing?customer=${o.customer_id}&order=${o.id}">Bill this order</a>` : ''}</div>
    <article class="invoice">
      <header><div><div class="shop-name">${esc(s.shop_name)}</div>${s.shop_address ? `<div>${esc(s.shop_address)}</div>` : ''}${s.shop_phone ? `<div>Phone: ${esc(s.shop_phone)}</div>` : ''}</div>
        <div><div class="doc-title">Order receipt</div><div class="num">No: <strong>${esc(o.order_no)}</strong></div><div class="num">Date: ${esc(fmtDate(o.created_at))}</div></div></header>
      <p><strong>Customer:</strong> ${esc(o.customer_name)}${o.customer_phone ? `, ${esc(o.customer_phone)}` : ''} <span class="no-print">${orderBadge(o.status)}</span></p>
      <p><strong>Order:</strong> ${esc(o.description)}</p>
      <p>${o.metal_name ? `Purity: ${esc(o.metal_name)} ${esc(o.purity_name)} · ` : ''}${o.expected_weight_mg ? `Approx. weight: ${grams(o.expected_weight_mg)} · ` : ''}Promised for: ${o.due_date ? esc(fmtDay(adDate(o.due_date).toISOString())) : '—'}</p>
      ${o.notes ? `<p>${esc(o.notes)}</p>` : ''}
      <div class="totals">
        ${o.payments.map((p) => `<div class="row"><span>${p.kind === 'advance' ? 'Advance' : 'Refund'} ${esc(fmtDay(p.paid_at))}, ${esc(METHOD_LABELS[p.method])}</span><span>${p.kind === 'refund' ? '− ' : ''}${money(p.amount_paisa)}</span></div>`).join('')}
        ${o.used_paisa ? `<div class="row"><span>Used on bills</span><span>− ${money(o.used_paisa)}</span></div>` : ''}
        <div class="row grand"><span>Advance held</span><span>${money(o.available_paisa)}</span></div>
      </div>
      <p class="muted" style="margin-top:1rem">The final price is calculated on the day of delivery at that day's rate. The advance is deducted from the bill.</p>
      <footer><div></div><div class="sign">For ${esc(s.shop_name)}</div></footer>
    </article>
    ${o.jobs.length || o.sales.length ? `<div class="panel no-print" style="margin-top:1rem">
      ${o.jobs.map((j) => `<p>Karigar job <a href="#/jobs/${j.id}">${esc(j.job_no)}</a> (${esc(j.status)})</p>`).join('')}
      ${o.sales.map((x) => `<p>Bill <a href="#/sales/${x.id}">${esc(x.invoice_no)}</a> used ${money(x.advance_paisa)}${x.status === 'cancelled' ? ' (cancelled)' : ''}</p>`).join('')}</div>` : ''}
    ${active ? `<div class="grid cols-2 no-print" style="margin-top:1rem">
      <form class="panel" id="advance-form"><h2>Receive more advance</h2><div class="form-grid">
        ${field('Amount (Rs)', numberInput('amount', '', 'required'))}${field('Paid by', select('method', Object.entries(METHOD_LABELS), 'cash'))}${field('Reference', '<input name="reference" maxlength="100">')}
      </div><div class="actions"><button type="submit">Record advance</button></div></form>
      <div class="panel"><h2>Progress</h2><div class="actions" style="margin-top:0">
        ${o.status === 'open' ? '<button id="mark-ready">Mark as ready</button>' : '<button class="secondary" id="mark-open">Back to being made</button>'}
        ${can('karigars.manage') ? `<a class="button secondary" href="#/jobs/new?order=${o.id}">Give gold to karigar for this</a>` : ''}</div>
        <form id="cancel-form" style="margin-top:1rem"><h3>Cancel order</h3>
          ${o.available_paisa ? `<p class="muted">${money(o.available_paisa)} advance will be refunded.</p>${field('Refund by', select('refund_method', Object.entries(METHOD_LABELS), 'cash'))}` : ''}
          ${field('Reason', '<input name="reason" required maxlength="200">')}<div class="actions"><button class="danger" type="submit">Cancel order</button></div></form>
      </div></div>` : ''}`;
  $('#print').addEventListener('click', () => window.print());
  const setStatus = (status, extra = {}) => attempt(async () => { await api('POST', `/api/orders/${orderId}/status`, { status, ...extra }); toast('Order updated.'); render(); });
  const ready = $('#mark-ready');
  if (ready) ready.addEventListener('click', () => setStatus('ready'));
  const reopen = $('#mark-open');
  if (reopen) reopen.addEventListener('click', () => setStatus('open'));
  const adv = $('#advance-form');
  if (adv) adv.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => { await api('POST', `/api/orders/${orderId}/advance`, formValues(e.target)); toast('Advance recorded.'); render(); }, e.submitter);
  });
  const cancel = $('#cancel-form');
  if (cancel) cancel.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!confirm(`Cancel ${o.order_no}?`)) return;
    setStatus('cancelled', formValues(e.target));
  });
  bindRowLinks(main);
  if (params.get('print') === '1') { history.replaceState(null, '', `#/orders/${orderId}`); setTimeout(() => window.print(), 300); }
}

// ---------------------------------------------------------------- Repairs

const REPAIR_STATUS = { received: ['Received', 'warn'], ready: ['Ready', 'ok'], delivered: ['Delivered', ''], cancelled: ['Cancelled', 'danger'] };
const repairBadge = (s) => `<span class="badge ${REPAIR_STATUS[s][1]}">${REPAIR_STATUS[s][0]}</span>`;

async function pageRepairs(main, _id, params) {
  const status = params.get('status') || 'active';
  const repairs = await api('GET', `/api/repairs?status=${status}`);
  main.innerHTML = `
    <h1>Repairs</h1>
    <form class="toolbar" id="filter">${field('Show', select('status', [['active', 'Not yet delivered'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['all', 'All']], status))}
      <button type="submit">Show</button><span class="spacer"></span><a class="button" href="#/repairs/new">New repair</a></form>
    <div class="table-wrap"><table>
      <thead><tr><th>Job card</th><th>Customer</th><th>Item and work</th><th class="num">Weight in</th><th>Promised</th><th>Status</th></tr></thead>
      <tbody>${repairs.map((x) => `<tr class="clickable" data-href="#/repairs/${x.id}"><td>${esc(x.repair_no)}</td>
        <td>${esc(x.customer_name)}${x.customer_phone ? `<br><small class="muted">${esc(x.customer_phone)}</small>` : ''}</td><td>${esc(x.item_description)}</td>
        <td class="num">${grams(x.weight_in_mg)}</td><td>${['received', 'ready'].includes(x.status) ? dueBadge(x.promised_date) : ''}</td><td>${repairBadge(x.status)}</td></tr>`).join('')
        || empty('No repairs.', 6)}</tbody></table></div>`;
  $('#filter').addEventListener('submit', (e) => { e.preventDefault(); go(`/repairs?status=${formValues(e.target).status}`); });
  bindRowLinks(main);
}

async function pageRepairNew(main) {
  const karigars = can('karigars.manage') ? await api('GET', '/api/karigars') : [];
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/repairs">Back to repairs</a></div>
    <h1>New repair</h1>
    <div class="panel" id="customer"></div>
    <form class="panel" id="repair-form"><div class="form-grid">
      ${field('Item and work needed', '<textarea name="item_description" required maxlength="300" placeholder="e.g. Gold bangle, broken clasp, polish"></textarea>', { wide: true })}
      ${field('Weight received (g)', numberInput('weight_in_g', '', 'required'), { hint: 'Weigh it in front of the customer.' })}
      ${dateField('Promised for', 'promised_date', inDays(3))}
      ${field('Estimated charge (Rs)', numberInput('estimate', ''))}
      ${karigars.length ? field('Karigar', select('karigar_id', [['', 'Done in the shop'], ...karigars.filter((k) => k.is_active).map((k) => [k.id, k.name])], '')) : ''}
      ${field('Notes', '<input name="notes" maxlength="300">')}
    </div><div class="actions"><button type="submit">Save and print job card</button></div></form>`;
  wireDateFields(main);
  const picker = await customerPicker($('#customer'));
  $('#repair-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!picker.value) return toast('Choose or add the customer.', 'error');
    attempt(async () => {
      const x = await api('POST', '/api/repairs', { ...formValues(e.target), customer_id: picker.value });
      toast(`${x.repair_no} saved.`);
      go(`/repairs/${x.id}?print=1`);
    }, e.submitter);
  });
}

async function pageRepair(main, repairId, params) {
  const x = await api('GET', `/api/repairs/${repairId}`);
  const s = state.settings;
  const active = ['received', 'ready'].includes(x.status);
  const readyMsg = `Namaste ${x.customer_name}ji. Your repair ${x.repair_no} (${x.item_description}) is ready at ${shopName()}.`
    + `${x.estimate_paisa ? ` Charge: about ${rupees(x.estimate_paisa)}.` : ''} Please bring this job card. Thank you.`;
  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/repairs">Back to repairs</a><button id="print">Print job card</button>
      ${x.status === 'ready' ? waButton(x.customer_phone, readyMsg, 'Tell customer on WhatsApp') : ''}</div>
    <article class="invoice">
      <header><div><div class="shop-name">${esc(s.shop_name)}</div>${s.shop_address ? `<div>${esc(s.shop_address)}</div>` : ''}${s.shop_phone ? `<div>Phone: ${esc(s.shop_phone)}</div>` : ''}</div>
        <div><div class="doc-title">Repair job card</div><div class="num">No: <strong>${esc(x.repair_no)}</strong></div><div class="num">Date: ${esc(fmtDate(x.created_at))}</div></div></header>
      <p><strong>Customer:</strong> ${esc(x.customer_name)}${x.customer_phone ? `, ${esc(x.customer_phone)}` : ''} <span class="no-print">${repairBadge(x.status)}</span></p>
      <p><strong>Item and work:</strong> ${esc(x.item_description)}</p>
      <div class="totals">
        <div class="row"><span>Weight received</span><span>${grams(x.weight_in_mg)}</span></div>
        ${x.weight_out_mg ? `<div class="row"><span>Weight returned</span><span>${grams(x.weight_out_mg)}</span></div>` : ''}
        <div class="row"><span>Promised for</span><span>${x.promised_date ? esc(fmtDay(adDate(x.promised_date).toISOString())) : '—'}</span></div>
        ${x.estimate_paisa ? `<div class="row"><span>Estimated charge</span><span>${money(x.estimate_paisa)}</span></div>` : ''}
        ${x.status === 'delivered' ? `<div class="row grand"><span>Charged (${esc(METHOD_LABELS[x.method] || '—')})</span><span>${money(x.charge_paisa || 0)}</span></div>` : ''}
      </div>
      ${x.notes ? `<p>${esc(x.notes)}</p>` : ''}
      <footer><div><small class="muted">Please bring this card to collect your item.${x.karigar_name ? ` <span class="no-print">Karigar: ${esc(x.karigar_name)}</span>` : ''}</small></div>
        <div style="display:flex;gap:2rem"><div class="sign">Customer</div><div class="sign">For ${esc(s.shop_name)}</div></div></footer>
    </article>
    ${active ? `<div class="grid cols-2 no-print" style="margin-top:1rem">
      <div class="panel"><h2>Progress</h2>
        ${x.status === 'received' ? '<button id="mark-ready">Mark as ready</button>' : '<button class="secondary" id="mark-received">Back to in progress</button>'}
        <button class="secondary" id="cancel-repair">Cancel repair</button></div>
      <form class="panel" id="deliver-form"><h2>Hand back to customer</h2><div class="form-grid">
        ${field('Weight returned (g)', numberInput('weight_out_g', '', 'required'))}
        ${field('Charge (Rs)', numberInput('charge', rupeesInput(x.estimate_paisa)))}
        ${field('Paid by', select('method', Object.entries(METHOD_LABELS), 'cash'))}
        ${field('Reference', '<input name="reference" maxlength="100">')}
      </div><div class="actions"><button type="submit">Deliver</button></div></form></div>` : ''}`;
  $('#print').addEventListener('click', () => window.print());
  const setStatus = (status) => attempt(async () => { await api('POST', `/api/repairs/${repairId}/status`, { status }); toast('Repair updated.'); render(); });
  const ready = $('#mark-ready');
  if (ready) ready.addEventListener('click', () => setStatus('ready'));
  const back = $('#mark-received');
  if (back) back.addEventListener('click', () => setStatus('received'));
  const cancel = $('#cancel-repair');
  if (cancel) cancel.addEventListener('click', () => { if (confirm(`Cancel ${x.repair_no}? Only do this once the item is back with the customer.`)) setStatus('cancelled'); });
  const deliver = $('#deliver-form');
  if (deliver) deliver.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    const diff = Math.round(Number(v.weight_out_g) * 1000) - x.weight_in_mg;
    if (diff !== 0 && !confirm(`The weight is ${diff > 0 ? 'up' : 'down'} by ${Math.abs(diff / 1000).toFixed(3)} g. Deliver anyway?`)) return;
    attempt(async () => { await api('POST', `/api/repairs/${repairId}/deliver`, v); toast('Delivered.'); render(); }, e.submitter);
  });
  if (params.get('print') === '1') { history.replaceState(null, '', `#/repairs/${repairId}`); setTimeout(() => window.print(), 300); }
}
