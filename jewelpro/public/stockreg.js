'use strict';

/* ======================================================================
   Daily stock register (owner): opening, in, out and closing stock per category, every day.
   ====================================================================== */

const pcs = (x) => `${x.qty} pcs`;
const pcsG = (x) => `<strong>${x.qty}</strong> <small class="muted">${grams(x.gross_mg)}</small>`;
const cellIn = (bucket, keys) => {
  const t = keys.reduce((a, k) => ({ qty: a.qty + ((bucket[k] || {}).qty || 0), gross_mg: a.gross_mg + ((bucket[k] || {}).gross_mg || 0) }), { qty: 0, gross_mg: 0 });
  return t.qty ? pcsG(t) : '<span class="muted">—</span>';
};

async function stockDayView(main, params) {
  const date = params.get('date') || localDate();
  const [reg, days] = await Promise.all([api('GET', `/api/stock-register?date=${date}`), api('GET', '/api/stock-register/days?days=90')]);
  const shift = (n) => localDate(new Date(adDate(date).getTime() + n * 86400000 + 3600000));
  const today = localDate();
  const IN_OTHER = ['manual', 'sale_cancelled', 'restored', 'category_in'];
  const OUT_OTHER = ['removed', 'purchase_cancelled', 'category_out'];
  const t = reg.totals;
  const partyText = (m) => [m.party_name, m.ref_no].filter(Boolean).join(' · ');

  main.innerHTML = `
    <div class="toolbar no-print"><a class="button secondary" href="#/stock-register">Back to the register book</a></div>
    <h1>Stock register: one day</h1>
    <p class="muted">Shop stock only (owner-only stock kept outside the shop is not included). Opening stock + items in − items out = closing stock.
      Each day's closing stock is the next day's opening stock.</p>
    <form class="toolbar no-print" id="day-form">
      ${dateField('Day', 'date', date)}<button type="submit">Show</button>
      <a class="button secondary" href="#/stock-register?view=day&date=${shift(-1)}">Previous day</a>
      ${date < today ? `<a class="button secondary" href="#/stock-register?view=day&date=${shift(1)}">Next day</a>` : ''}
      ${date !== today ? '<a class="button secondary" href="#/stock-register?view=day">Today</a>' : ''}
      <span class="spacer"></span><button type="button" class="secondary" id="print">Print</button></form>
    <h2>${esc(fmtDay(adDate(date).toISOString()))}</h2>
    ${reg.system_check ? (reg.system_check.ok
      ? '<div class="banner ok">The register matches the items marked in stock in the shop right now.</div>'
      : `<div class="banner danger">The register does not match the items in stock: ${reg.system_check.problems.map((p) => `${esc(p.name)} register ${p.register}, in stock ${p.actual}`).join('; ')}. Please report this.</div>`) : ''}
    <div class="grid cols-4">
      <div class="panel stat"><div class="label">Opening stock</div><div class="value">${pcs(t.opening)}</div><div class="sub">${grams(t.opening.gross_mg)} gross</div></div>
      <div class="panel stat"><div class="label">Came in</div><div class="value">+ ${pcs(t.in)}</div><div class="sub">${grams(t.in.gross_mg)}</div></div>
      <div class="panel stat"><div class="label">Went out</div><div class="value">− ${pcs(t.out)}</div><div class="sub">${grams(t.out.gross_mg)}</div></div>
      <div class="panel stat"><div class="label">Closing stock</div><div class="value">${pcs(t.closing)}</div><div class="sub">${grams(t.closing.gross_mg)} gross</div></div>
    </div>

    <div class="panel"><h2>By category</h2><div class="table-wrap"><table class="register">
      <thead>
        <tr><th rowspan="2">Category</th><th rowspan="2" class="num">Opening</th><th colspan="4" class="group">Came in</th>
          <th colspan="3" class="group">Went out</th><th rowspan="2" class="num">Closing</th><th rowspan="2" class="num">Counted</th></tr>
        <tr><th class="num">Supplier</th><th class="num">Karigar</th><th class="num">From locker</th><th class="num">By hand / other</th>
          <th class="num">Sold</th><th class="num">To locker</th><th class="num">Other</th></tr>
      </thead>
      <tbody>${reg.rows.map((r) => `<tr>
        <td><strong>${esc(r.name)}</strong></td><td class="num">${pcsG(r.opening)}</td>
        <td class="num">${cellIn(r.in, ['purchase'])}</td><td class="num">${cellIn(r.in, ['karigar'])}</td>
        <td class="num">${cellIn(r.in, ['from_locker'])}</td><td class="num">${cellIn(r.in, IN_OTHER)}</td>
        <td class="num">${cellIn(r.out, ['sold'])}</td><td class="num">${cellIn(r.out, ['to_locker'])}</td><td class="num">${cellIn(r.out, OUT_OTHER)}</td>
        <td class="num">${pcsG(r.closing)}${r.weight_corrected_mg ? `<br><small class="muted">incl. weight corrected ${grams(r.weight_corrected_mg)}</small>` : ''}</td>
        <td class="num">${r.count ? `${r.count.counted_qty} ${r.count.difference === 0 ? '<span class="badge ok">Matches</span>'
          : `<span class="badge danger">${r.count.difference > 0 ? '+' : ''}${r.count.difference}</span>`}` : '<span class="muted">Not counted</span>'}</td></tr>`).join('')
        || empty('No stock on this day.', 11)}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${pcsG(t.opening)}</td><td colspan="4" class="num">+ ${pcsG(t.in)}</td>
        <td colspan="3" class="num">− ${pcsG(t.out)}</td><td class="num">${pcsG(t.closing)}</td><td></td></tr></tfoot>
    </table></div></div>

    <div class="panel"><h2>What came in and went out</h2><div class="table-wrap"><table>
      <thead><tr><th>Time</th><th>Item</th><th>Category</th><th>What happened</th><th>From / to</th><th class="num">Gross</th><th>By</th></tr></thead>
      <tbody>${reg.movements.map((m) => `<tr><td>${esc(new Date(m.moved_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</td>
        <td><a href="#/products/${m.product_id}">${esc(m.item_code)}</a> ${esc(m.item_name)}</td>
        <td>${esc((reg.rows.find((r) => r.category_id === m.category_id) || {}).name || '')}</td>
        <td>${m.qty > 0 ? '<span class="badge ok">In</span>' : m.qty < 0 ? '<span class="badge danger">Out</span>' : '<span class="badge">Weight</span>'} ${esc(reg.reasons[m.reason])}</td>
        <td>${m.ref_type === 'sale' && m.ref_id ? `<a href="#/sales/${m.ref_id}">${esc(partyText(m))}</a>` : esc(partyText(m))}${m.note && m.note !== 'From records before the daily register' ? ` <span class="muted">${esc(m.note)}</span>` : ''}</td>
        <td class="num">${grams(Math.abs(m.gross_mg))}</td><td>${esc(m.by_name || '')}</td></tr>`).join('') || empty('Nothing came in or went out on this day.', 7)}</tbody>
    </table></div></div>

    ${reg.rows.length ? `<form class="panel no-print" id="count-form"><h2>Count the stock</h2>
      <p class="muted">At closing time, count the pieces in each category and enter them here. Any difference from the register is shown above.</p>
      <div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Register says</th><th>Pieces counted</th><th>Weight counted (g, optional)</th></tr></thead>
      <tbody>${reg.rows.map((r) => `<tr data-count="${r.category_id}"><td>${esc(r.name)}</td><td class="num">${pcsG(r.closing)}</td>
        <td>${numberInput('qty', r.count ? r.count.counted_qty : '', 'step="1" required style="max-width:8rem"')}</td>
        <td>${numberInput('gross_g', r.count && r.count.counted_gross_mg !== null ? gramsInput(r.count.counted_gross_mg) : '', 'style="max-width:9rem"')}</td></tr>`).join('')}</tbody></table></div>
      <div class="form-grid" style="margin-top:.5rem">${field('Note', input('note', (reg.rows.find((r) => r.count) || { count: {} }).count.note || '', 'maxlength="300"'), { wide: true })}</div>
      <div class="actions"><button type="submit">Save count</button></div></form>` : ''}

    <div class="panel"><h2>Last 90 days</h2><div class="table-wrap"><table>
      <thead><tr><th>Day</th><th class="num">Opening</th><th class="num">In</th><th class="num">Sold</th><th class="num">Other out</th><th class="num">Closing</th><th>Count</th></tr></thead>
      <tbody>${days.filter((d) => d.opening_qty || d.in_qty || d.closing_qty || d.counted_qty !== null).map((d) => `<tr class="clickable${d.date === date ? ' current' : ''}" data-href="#/stock-register?view=day&date=${d.date}">
        <td>${esc(fmtDay(adDate(d.date).toISOString()))}</td><td class="num">${d.opening_qty}</td><td class="num">${d.in_qty ? `+${d.in_qty}` : ''}</td>
        <td class="num">${d.sold_qty ? `−${d.sold_qty}` : ''}</td><td class="num">${d.other_out_qty ? `−${d.other_out_qty}` : ''}</td>
        <td class="num"><strong>${d.closing_qty}</strong> <small class="muted">${grams(d.closing_gross_mg)}</small></td>
        <td>${d.counted_qty === null ? '<span class="muted">—</span>' : d.counted_qty === d.closing_qty ? '<span class="badge ok">Matches</span>'
          : `<span class="badge danger">Counted ${d.counted_qty}</span>`}</td></tr>`).join('') || empty('No stock yet.', 7)}</tbody>
    </table></div></div>`;

  wireDateFields(main);
  $('#day-form').addEventListener('submit', (e) => { e.preventDefault(); go(`/stock-register?view=day&date=${formValues(e.target).date}`); });
  $('#print').addEventListener('click', () => window.print());
  const countForm = $('#count-form');
  if (countForm) countForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const counts = $$('[data-count]', countForm).map((row) => ({ category_id: row.dataset.count, ...rowValues(row) }));
    attempt(async () => {
      await api('POST', '/api/stock-register/count', { date, counts, note: countForm.elements.note.value });
      toast('Count saved.');
      render();
    }, e.submitter);
  });
  bindRowLinks(main);
}

/* ---------------- The register book: categories down, days across (morning and evening) ---------------- */

const shortBs = (dateText) => {
  const d = adDate(dateText);
  const bs = state.cal && state.cal.fromDate(d);
  return bs ? `${bs.day} ${BSDate.MONTHS[bs.month - 1]}` : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const addDays = (dateText, n) => { const d = adDate(dateText); d.setDate(d.getDate() + n); return localDate(d); };

async function pageStockRegister(main, _id, params) {
  if (params.get('view') === 'day') return stockDayView(main, params);
  const span = [7, 15, 30].includes(Number(params.get('days'))) ? Number(params.get('days')) : 15;
  const today = localDate();
  const end = params.get('end') && params.get('end') < today ? params.get('end') : today;
  const start = addDays(end, -(span - 1));
  const arranging = params.get('edit') === '1';
  const showEmpty = params.get('empty') === '1';
  const grid = await api('GET', `/api/stock-register/grid?from=${start}&to=${end}`);
  const link = (changes) => {
    const q = new URLSearchParams({ days: String(span), end, ...(arranging ? { edit: '1' } : {}), ...(showEmpty ? { empty: '1' } : {}), ...changes });
    for (const [k, v] of [...q.entries()]) if (v === '' || (k === 'end' && v >= today) || (k === 'days' && v === '15')) q.delete(k);
    const text = q.toString();
    return `/stock-register${text ? `?${text}` : ''}`;
  };

  const isEmpty = (r) => r.cells.every((c) => !c.open && !c.close && !c.in && !c.out && c.counted === null && c.counted_morning === null);
  const emptyRows = grid.rows.filter((r) => !r.hidden && isEmpty(r) && !grid.layout.order.includes(r.id));
  const shown = grid.rows.filter((r) => !r.hidden && (showEmpty || arranging || !emptyRows.includes(r)));
  const hidden = grid.rows.filter((r) => r.hidden);

  /** One box of the book: type the counted pieces; the grey number is what the system says. */
  const box = (row, c, session, col) => {
    const system = session === 'morning' ? c.open : c.close;
    const counted = session === 'morning' ? c.counted_morning : c.counted;
    const state = counted === null ? '' : counted === system ? ' match' : ' differ';
    const change = session === 'evening' && c.close !== c.open
      ? `<sup class="${c.close > c.open ? 'up' : 'down'}">${c.close > c.open ? '+' : '−'}${Math.abs(c.close - c.open)}</sup>` : '';
    const tip = `${row.name}, ${shortBs(c.date)} ${session === 'morning' ? 'morning' : 'evening'}. System: ${system}`
      + `${c.in && session === 'evening' ? `, ${c.in} came in` : ''}${c.out && session === 'evening' ? `, ${c.out} went out` : ''}`
      + `${counted !== null && counted !== system ? `. You counted ${counted}.` : '.'}`;
    return `<td class="bk${session === 'evening' ? ' eve' : ''}${state}">${change}<input class="cnt" inputmode="numeric" autocomplete="off" size="4"
      value="${counted === null ? '' : counted}" placeholder="${system}" data-cat="${row.id}" data-date="${c.date}" data-session="${session}"
      data-col="${col}" data-system="${system}" title="${esc(tip)}" aria-label="${esc(tip)}"></td>`;
  };

  main.innerHTML = `
    <h1>Stock register</h1>
    <div class="book-bar no-print">
      <div class="seg" role="group" aria-label="Days to show">${[7, 15, 30].map((n) => `<a class="${n === span ? 'on' : ''}" href="#${link({ days: String(n) })}">${n} days</a>`).join('')}</div>
      <a class="button secondary small" href="#${link({ end: addDays(end, -span) })}">◀ Earlier</a>
      ${end < today ? `<a class="button secondary small" href="#${link({ end: addDays(end, span) })}">Later ▶</a>
        <a class="button secondary small" href="#${link({ end: '' })}">Today</a>` : ''}
      <span class="spacer"></span>
      <a class="button secondary small" href="#${link({ edit: arranging ? '' : '1' })}">${arranging ? 'Done' : 'Arrange rows'}</a>
      <button type="button" class="secondary small" id="print">Print</button>
    </div>
    <p class="book-help no-print">Count the pieces and <strong>type the number in the box</strong>. It saves by itself.
      <span class="key match"></span> matches the system &nbsp; <span class="key differ"></span> does not match &nbsp;
      Grey number = what the system says. <kbd>Enter</kbd> goes down, <kbd>Tab</kbd> goes right.
      Double-click a category to see its pieces.</p>
    ${emptyRows.length && !arranging ? `<p class="muted no-print book-note">${showEmpty
      ? `<a href="#${link({ empty: '' })}">Hide rows with no stock</a>`
      : `${emptyRows.length} empty row${emptyRows.length === 1 ? '' : 's'} not shown. <a href="#${link({ empty: '1' })}">Show</a>`}</p>` : ''}

    <div class="table-wrap register-book" id="book"><table class="book typing">
      <thead>
        <tr><th rowspan="2" class="item-col">Items</th>
          ${grid.days.map((d) => `<th colspan="2" class="day-head${d === grid.today ? ' today' : ''}">
            <a href="#/stock-register?view=day&date=${d}" title="See everything that happened on this day">${esc(shortBs(d))}</a></th>`).join('')}
          ${arranging ? '<th rowspan="2" class="no-print">Row</th>' : ''}</tr>
        <tr>${grid.days.map((d, k) => ['morning', 'evening'].map((sn) => `<th class="me${sn === 'evening' ? ' eve' : ''}">${sn === 'morning' ? 'M' : 'E'}
          <button type="button" class="fill no-print" data-fill="${k * 2 + (sn === 'evening' ? 1 : 0)}" title="Fill the empty boxes of this column with the system numbers">✓</button></th>`).join('')).join('')}</tr>
      </thead>
      <tbody>${shown.map((row, r) => `<tr>
        <th scope="row" class="item-col cat-name" tabindex="0" data-open="${row.id}" title="Double-click to see the ${esc(row.name)} pieces">${esc(row.name)}</th>
        ${row.cells.map((c, k) => `${box(row, c, 'morning', k * 2)}${box(row, c, 'evening', k * 2 + 1)}`).join('')}
        ${arranging ? `<td class="no-print row-tools">
          <button type="button" class="secondary small" data-move="${row.id}" data-dir="-1" ${r === 0 ? 'disabled' : ''} aria-label="Move ${esc(row.name)} up">↑</button>
          <button type="button" class="secondary small" data-move="${row.id}" data-dir="1" ${r === shown.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(row.name)} down">↓</button>
          <button type="button" class="secondary small" data-hide="${row.id}">Remove</button></td>` : ''}</tr>`).join('')
        || empty('No rows yet. Press Arrange rows to add one.', grid.days.length * 2 + 1)}</tbody>
      <tfoot>
        <tr><th class="item-col">Total</th>${grid.totals.map((t) => `<td class="num">${t.open}</td><td class="num eve">${t.close}</td>`).join('')}${arranging ? '<td class="no-print"></td>' : ''}</tr>
        <tr class="signs"><th class="item-col">Checked by</th>${grid.checked_by.map((names) => `<td colspan="2" class="sign-cell">${names.map(esc).join(', ') || '<span class="muted">—</span>'}</td>`).join('')}${arranging ? '<td class="no-print"></td>' : ''}</tr>
      </tfoot>
    </table></div>

    ${arranging ? `<div class="grid cols-2 no-print" style="margin-top:1rem">
      <form class="panel" id="add-row"><h2>Add a row</h2>
        <div class="form-grid" style="align-items:end">${field('Category name', '<input name="name" required maxlength="60" placeholder="e.g. Tilahari">')}
        <div><button type="submit">Add row</button></div></div></form>
      <div class="panel"><h2>Removed rows</h2>
        ${hidden.length ? `<table><tbody>${hidden.map((row) => `<tr><td>${esc(row.name)}</td><td class="num">
          <button type="button" class="secondary small" data-show="${row.id}">Show again</button>
          <button type="button" class="danger small" data-delete="${row.id}">Delete</button></td></tr>`).join('')}</tbody></table>
          <p class="muted" style="margin-top:.5rem">Delete only works for a category that never had any items.</p>`
          : '<p class="muted">None. Removed rows are kept here and can be shown again.</p>'}
      </div></div>` : ''}`;

  // Open at today (the right-hand end), like opening the book at the current page.
  const book = $('#book');
  book.scrollLeft = book.scrollWidth;
  $('#print').addEventListener('click', () => window.print());

  // ---- typing into the boxes
  const boxes = $$('input.cnt', book);
  const at = (rowIdx, col) => $$('tbody tr', book)[rowIdx] && $$('tbody tr', book)[rowIdx].querySelector(`input.cnt[data-col="${col}"]`);
  const rowOf = (input) => [...$$('tbody tr', book)].indexOf(input.closest('tr'));
  const paint = (input, counted) => {
    const td = input.closest('td');
    const system = Number(input.dataset.system);
    td.classList.remove('match', 'differ', 'saving', 'failed');
    if (counted !== null && counted !== undefined && counted !== '') td.classList.add(Number(counted) === system ? 'match' : 'differ');
  };
  const save = async (input) => {
    const value = input.value.trim();
    if (value === (input.dataset.saved ?? input.defaultValue)) return;
    if (value !== '' && !/^\d+$/.test(value)) {
      input.closest('td').classList.add('failed');
      toast('Type a whole number of pieces, or leave the box empty.', 'error');
      return;
    }
    const td = input.closest('td');
    td.classList.add('saving');
    try {
      const res = await api('PUT', '/api/stock-register/cell', {
        date: input.dataset.date, session: input.dataset.session, category_id: input.dataset.cat, qty: value });
      input.dataset.saved = value;
      paint(input, res.counted);
      const k = Math.floor(Number(input.dataset.col) / 2);
      const sign = $$('tfoot tr.signs td', book)[k];
      if (sign) sign.innerHTML = res.checked_by.map(esc).join(', ') || '<span class="muted">—</span>';
    } catch (err) {
      td.classList.remove('saving');
      td.classList.add('failed');
      toast(err.message, 'error');
    }
  };
  boxes.forEach((input) => {
    input.dataset.saved = input.value;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => { input.value = input.value.replace(/[^\d]/g, ''); paint(input, input.value); });
    input.addEventListener('change', () => save(input));
    input.addEventListener('keydown', (e) => {
      const col = Number(input.dataset.col);
      let next = null;
      if (e.key === 'Enter' || e.key === 'ArrowDown') next = at(rowOf(input) + (e.shiftKey && e.key === 'Enter' ? -1 : 1), col);
      else if (e.key === 'ArrowUp') next = at(rowOf(input) - 1, col);
      else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) next = at(rowOf(input), col + 1);
      else if (e.key === 'ArrowLeft' && input.selectionStart === 0) next = at(rowOf(input), col - 1);
      else if (e.key === 'Escape') { input.value = input.dataset.saved; paint(input, input.value); return; }
      else return;
      e.preventDefault();
      if (e.key === 'Enter') save(input);
      if (next) next.focus();
    });
  });
  $$('[data-fill]', book).forEach((b) => b.addEventListener('click', async () => {
    const col = b.dataset.fill;
    const emptyBoxes = boxes.filter((i) => i.dataset.col === col && i.value === '');
    if (!emptyBoxes.length) { toast('Every box in this column is already filled.'); return; }
    if (!confirm(`Fill ${emptyBoxes.length} empty box${emptyBoxes.length === 1 ? '' : 'es'} with the system numbers? Only do this if you counted and they match.`)) return;
    for (const input of emptyBoxes) { input.value = input.dataset.system; await save(input); }
    toast('Column filled.');
  }));

  // Double-click a category (or Enter on it, or a tap on phones) to see its pieces.
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  $$('[data-open]', book).forEach((th) => {
    const open = () => openCategoryWindow(Number(th.dataset.open), end, 'evening');
    th.addEventListener('dblclick', open);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    if (coarse) th.addEventListener('click', open);
  });

  // ---- arranging rows
  const saveLayout = (hiddenIds, orderIds, button) => attempt(async () => {
    await api('PUT', '/api/stock-register/layout', { hidden: hiddenIds, order: orderIds });
    render();
  }, button);
  const order = grid.rows.filter((r) => grid.layout.order.includes(r.id) || !isEmpty(r)).map((r) => r.id);
  const hiddenIds = hidden.map((r) => r.id);
  $$('[data-move]').forEach((b) => b.addEventListener('click', () => {
    const ids = shown.map((r) => r.id);
    const i = ids.indexOf(Number(b.dataset.move));
    const j = i + Number(b.dataset.dir);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const emptyIds = new Set(emptyRows.map((r) => r.id));
    const touched = new Set([ids[i], ids[j]]);
    const placed = ids.filter((x) => !emptyIds.has(x) || touched.has(x));
    saveLayout(hiddenIds, [...placed, ...order.filter((x) => !placed.includes(x))], b);
  }));
  $$('[data-hide]').forEach((b) => b.addEventListener('click', () => saveLayout([...hiddenIds, Number(b.dataset.hide)], order, b)));
  $$('[data-show]').forEach((b) => b.addEventListener('click', () => saveLayout(hiddenIds.filter((x) => x !== Number(b.dataset.show)), order, b)));
  $$('[data-delete]').forEach((b) => b.addEventListener('click', () => {
    const row = grid.rows.find((r) => r.id === Number(b.dataset.delete));
    if (!confirm(`Delete the category ${row.name}?`)) return;
    attempt(async () => { await api('DELETE', `/api/categories/${row.id}`); clearCache('categories'); toast(`${row.name} deleted.`); render(); }, b);
  }));
  const addRow = $('#add-row');
  if (addRow) addRow.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      const created = await api('POST', '/api/categories', formValues(e.target));
      clearCache('categories');
      await api('PUT', '/api/stock-register/layout', { hidden: hiddenIds, order: [...order, created.id] });
      toast(`${created.name} added.`);
      render();
    }, e.submitter);
  });
}

/** A separate window for one category: every piece in stock at that time, with code, karigar or supplier, and date in. */
async function openCategoryWindow(categoryId, date, when = 'evening') {
  let dialog = $('#category-window');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'category-window';
    dialog.className = 'window';
    dialog.setAttribute('aria-label', 'Category pieces');
    document.body.appendChild(dialog);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => document.body.classList.remove('printing-window'));
  }
  const load = async (w) => {
    dialog.innerHTML = '<div class="window-body"><p class="muted">Loading…</p></div>';
    if (!dialog.open) dialog.showModal();
    let data;
    try {
      data = await api('GET', `/api/stock-register/category/${categoryId}?date=${date}&when=${w}`);
    } catch (err) {
      dialog.innerHTML = `<div class="window-body"><div class="banner danger">${esc(err.message)}</div><button type="button" id="cw-close">Close</button></div>`;
      $('#cw-close', dialog).addEventListener('click', () => dialog.close());
      return;
    }
    const fromText = (x) => {
      if (x.from_type === 'karigar') return `Karigar <strong>${esc(x.from_name)}</strong>${x.from_ref ? ` <span class="muted">(${esc(x.from_ref)})</span>` : ''}`;
      if (x.from_type === 'supplier') return `Supplier ${esc(x.from_name)}${x.from_ref ? ` <span class="muted">(${esc(x.from_ref)})</span>` : ''}`;
      return esc(data.reasons[x.came_in_as] || 'Entered into stock');
    };
    const came = data.moves.filter((m) => m.qty > 0).length;
    const went = data.moves.filter((m) => m.qty < 0).length;
    const showNow = w === 'morning' || date !== localDate();
    dialog.innerHTML = `<div class="window-body">
      <header class="window-head">
        <div><h2>${esc(data.category.name)}</h2>
          <p class="muted">${esc(fmtDay(adDate(date).toISOString()))}, ${w === 'morning' ? 'morning (opening stock)' : 'evening (closing stock)'}</p></div>
        <div class="window-actions no-print">
          <button type="button" class="${w === 'morning' ? '' : 'secondary'} small" data-w="morning">Morning</button>
          <button type="button" class="${w === 'evening' ? '' : 'secondary'} small" data-w="evening">Evening</button>
          <button type="button" class="secondary small" id="cw-print">Print</button>
          <button type="button" class="secondary small" id="cw-close">Close</button></div>
      </header>
      <div class="window-stats">
        <div class="stat"><div class="label">Pieces remaining</div><div class="value">${data.totals.pieces}</div></div>
        <div class="stat"><div class="label">Gross weight</div><div class="value">${grams(data.totals.gross_mg)}</div></div>
        <div class="stat"><div class="label">Net weight</div><div class="value">${grams(data.totals.net_mg)}</div></div>
        <div class="stat"><div class="label">That day</div><div class="value">+${came} / −${went}</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Code</th><th>Item</th><th>Purity</th><th class="num">Gross</th><th class="num">Net</th><th>Came into stock</th><th>From</th>${showNow ? '<th>Now</th>' : ''}</tr></thead>
        <tbody>${data.items.map((x, n) => `<tr class="clickable" data-href="#/products/${x.id}"><td class="muted">${n + 1}</td><td><strong>${esc(x.item_code)}</strong></td>
          <td>${esc(x.name)}${x.private_now ? ' <span class="badge warn">Owner only</span>' : ''}</td><td>${esc(x.purity)}</td>
          <td class="num">${grams(x.gross_mg)}</td><td class="num">${grams(x.net_mg)}</td><td>${esc(fmtDay(x.since))}</td><td>${fromText(x)}</td>
          ${showNow ? `<td>${x.status_now === 'in_stock' && !x.private_now ? '<span class="badge ok">Still in stock</span>' : statusBadge(x.status_now)}</td>` : ''}</tr>`).join('')
          || empty('No pieces in stock at this time.', 9)}</tbody>
      </table></div>
      ${data.moves.length ? `<h3>Came in and went out on this day</h3><div class="table-wrap"><table><tbody>
        ${data.moves.map((m) => `<tr><td>${esc(new Date(m.moved_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</td>
          <td>${m.qty > 0 ? '<span class="badge ok">In</span>' : '<span class="badge danger">Out</span>'} ${esc(data.reasons[m.reason])}</td>
          <td><strong>${esc(m.item_code)}</strong> ${esc(m.name)}</td><td>${esc([m.party_name, m.invoice_no].filter(Boolean).join(', '))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    </div>`;
    $('#cw-close', dialog).addEventListener('click', () => dialog.close());
    $('#cw-print', dialog).addEventListener('click', () => {
      document.body.classList.add('printing-window');
      window.print();
      document.body.classList.remove('printing-window');
    });
    $$('[data-w]', dialog).forEach((b) => b.addEventListener('click', () => load(b.dataset.w)));
    $$('tr[data-href]', dialog).forEach((tr) => tr.addEventListener('click', () => { dialog.close(); location.hash = tr.dataset.href; }));
  };
  await load(when);
}
