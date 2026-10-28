'use strict';

/* ======================================================================
   Stock sheet: every piece in rows and columns, one tab per category, like an Excel workbook.
   Double-click a row to see its whole story; double-click a cell (in Edit cells) to change it.
   ====================================================================== */

const netMg = (p) => p.gross_mg - p.stone_mg - p.other_less_mg;
const receivedOf = (p) => p.received_at || p.created_at;

/** Where a piece came from, in words. */
function sourceText(p, { links = true } = {}) {
  if (p.karigar_name) {
    const name = links && can('karigars.manage')
      ? `<button type="button" class="link karigar-link" data-karigar="${p.karigar_id}">${esc(p.karigar_name)}</button>` : `<strong>${esc(p.karigar_name)}</strong>`;
    return `Karigar ${name}${p.job_no ? ` <span class="muted">${esc(p.job_no)}</span>` : ''}`;
  }
  if (p.supplier_name) return `Supplier ${esc(p.supplier_name)}${p.purchase_no ? ` <span class="muted">${esc(p.purchase_no)}</span>` : ''}`;
  return '<span class="muted">By hand</span>';
}

function soldText(p) {
  if (p.status !== 'sold' || !p.sold_at) return '';
  return `${esc(fmtDay(p.sold_at))}<br><small>${can('sales.view') ? `<a href="#/sales/${p.sale_id}">${esc(p.invoice_no)}</a>` : esc(p.invoice_no)}${p.sold_to ? `, ${esc(p.sold_to)}` : ''}</small>`;
}

async function pageProducts(main, _id, params) {
  const status = params.get('status') || 'in_stock';
  const q = params.get('q') || '';
  const categoryId = params.get('category_id') || '';
  const place = params.get('place') || 'all';
  const editing = params.get('edit') === '1' && can('products.manage');
  const owner = can('stock.private');
  const [products, categories, purities, karigars] = await Promise.all([
    // All categories are fetched once; the tabs filter them here, so each tab counts what the sheet shows.
    api('GET', `/api/products?status=${status}&q=${encodeURIComponent(q)}${owner ? `&place=${place}` : ''}`),
    api('GET', '/api/categories'),
    cached('purities', '/api/purities'),
    can('products.manage') ? api('GET', '/api/karigar-names') : Promise.resolve([])
  ]);
  const link = (changes) => {
    const u = new URLSearchParams({ status, q, category_id: categoryId, ...(owner ? { place } : {}), ...(editing ? { edit: '1' } : {}), ...changes });
    for (const [k, v] of [...u.entries()]) if (v === '' || (k === 'status' && v === 'in_stock') || (k === 'place' && v === 'all')) u.delete(k);
    const text = u.toString();
    return `/products${text ? `?${text}` : ''}`;
  };

  // Columns of the sheet. "edit" names the field sent to the server when a cell is changed.
  const cols = [
    { key: 'date', label: 'Date in stock', sort: (p) => receivedOf(p), html: (p) => esc(fmtDay(receivedOf(p))), csv: (p) => fmtDay(receivedOf(p)) },
    { key: 'code', label: 'Code', sort: (p) => p.item_code, html: (p) => `<a href="#/products/${p.id}"><strong>${esc(p.item_code)}</strong></a>`, csv: (p) => p.item_code },
    { key: 'category', label: 'Category', sort: (p) => p.category_name, html: (p) => esc(p.category_name), csv: (p) => p.category_name,
      edit: { field: 'category_id', type: 'select', options: () => categories.map((c) => [c.id, c.name]), value: (p) => p.category_id } },
    { key: 'name', label: 'Item', sort: (p) => p.name, csv: (p) => p.name,
      html: (p) => `${esc(p.name)}${p.is_private ? ' <span class="badge warn">Owner only</span>' : ''}`,
      edit: { field: 'name', type: 'text', value: (p) => (p.name === p.category_name ? '' : p.name) } },
    { key: 'purity', label: 'Purity', sort: (p) => `${p.metal_name} ${p.purity_name}`, html: (p) => `${esc(p.metal_name)} ${esc(p.purity_name)}`,
      csv: (p) => `${p.metal_name} ${p.purity_name}`,
      edit: { field: 'purity_id', type: 'select', options: () => purities.filter((x) => x.is_active).map((x) => [x.id, `${x.metal_name} ${x.name}`]), value: (p) => p.purity_id } },
    { key: 'gross', label: 'Gross', num: true, sort: (p) => p.gross_mg, html: (p) => grams(p.gross_mg), csv: (p) => gramsInput(p.gross_mg),
      edit: { field: 'gross_g', type: 'number', value: (p) => gramsInput(p.gross_mg) } },
    { key: 'stone', label: 'Stone', num: true, sort: (p) => p.stone_mg + p.other_less_mg,
      html: (p) => (p.stone_mg + p.other_less_mg ? grams(p.stone_mg + p.other_less_mg) : '<span class="muted">—</span>'), csv: (p) => gramsInput(p.stone_mg + p.other_less_mg) },
    { key: 'net', label: 'Net', num: true, sort: (p) => netMg(p), html: (p) => `<strong>${grams(netMg(p))}</strong>`, csv: (p) => gramsInput(netMg(p)),
      edit: { field: 'net_g', type: 'number', value: (p) => gramsInput(netMg(p)) } },
    { key: 'from', label: 'Karigar / from', sort: (p) => p.karigar_name || p.supplier_name || '',
      // While editing cells the karigar name is plain text, so double-click edits it instead of opening the window.
      html: (p) => sourceText(p, { links: !editing }),
      csv: (p) => (p.karigar_name ? `Karigar ${p.karigar_name}${p.job_no ? ` ${p.job_no}` : ''}` : p.supplier_name ? `Supplier ${p.supplier_name}` : 'By hand'),
      edit: { field: 'karigar_id', type: 'select', when: (p) => p.source !== 'karigar', options: () => [['', 'None'], ...karigars.map((k) => [k.id, k.name])], value: (p) => p.karigar_id || '' } },
    { key: 'status', label: 'Status', sort: (p) => p.status, html: (p) => statusBadge(p.status), csv: (p) => p.status.replace('_', ' ') },
    { key: 'sold', label: 'Sold on', sort: (p) => p.sold_at || '', html: (p) => soldText(p), csv: (p) => (p.sold_at ? `${fmtDay(p.sold_at)} ${p.invoice_no}${p.sold_to ? ` ${p.sold_to}` : ''}` : '') },
    ...(owner ? [{ key: 'kept', label: 'Kept at', sort: (p) => p.location || '', html: (p) => esc(p.location || ''), csv: (p) => p.location || '',
      edit: { field: 'location', type: 'text', value: (p) => p.location || '' } }] : []),
    { key: 'huid', label: 'HUID', sort: (p) => p.huid || '', html: (p) => esc(p.huid || ''), csv: (p) => p.huid || '',
      edit: { field: 'huid', type: 'text', value: (p) => p.huid || '' } }
  ];
  let sortKey = 'date';
  let sortDir = -1;
  const rows = products.filter((p) => !categoryId || String(p.category_id) === categoryId);

  const unitNote = weightUnit() === 'tola' ? 'tola' : 'g';
  const perCategory = products.reduce((m, p) => m.set(p.category_id, (m.get(p.category_id) || 0) + 1), new Map());
  const tabs = [['', 'All', products.length],
    ...categories.filter((c) => perCategory.get(c.id) || String(c.id) === categoryId).map((c) => [String(c.id), c.name, perCategory.get(c.id) || 0])];
  main.innerHTML = `
    <h1>Stock</h1>
    <form class="toolbar" id="filter">
      ${field('Search', input('q', q, 'placeholder="Code, item, karigar or HUID"'))}
      ${field('Status', select('status', [['in_stock', 'In stock'], ['sold', 'Sold'], ['removed', 'Removed'], ['all', 'All']], status))}
      ${owner ? field('Where', select('place', [['all', 'Shop and owner-only'], ['shop', 'In the shop'], ['private', 'Owner-only stock']], place)) : ''}
      <button type="submit">Show</button>
      <span class="spacer"></span>
      <div class="field"><span>Weights</span>${weightSwitch()}</div>
    </form>
    <div class="toolbar">
      ${can('products.manage') ? '<a class="button" href="#/products/new">Add item</a>' : ''}
      ${can('products.manage') ? `<a class="button ${editing ? '' : 'secondary'}" href="#${link({ edit: editing ? '' : '1' })}">${editing ? 'Done editing' : 'Edit cells'}</a>` : ''}
      <button type="button" class="secondary" id="print-tags" disabled>Print tags</button>
      <button type="button" class="secondary" id="excel">Download for Excel</button>
      <span class="spacer"></span>
      ${can('categories.manage') ? '<a class="button secondary" href="#/categories">Categories</a>' : ''}
      ${can('stockreg.view') ? '<a class="button secondary" href="#/stock-register">Stock register</a>' : ''}
    </div>
    <nav class="sheet-tabs" aria-label="Categories">${tabs.map(([cid, name, n]) => `<a href="#${link({ category_id: cid })}" class="${cid === categoryId ? 'on' : ''}"${cid === categoryId ? ' aria-current="page"' : ''}>${esc(name)} <span>${n}</span></a>`).join('')}</nav>
    ${editing ? '<p class="banner no-print">Double-click a cell to change it, then press <kbd>Enter</kbd> to save or <kbd>Esc</kbd> to cancel. Only items in stock can be changed. Net weight is required; gross is only needed for pieces with stones.</p>' : ''}
    <div class="table-wrap sheet-wrap"><table class="sheet${editing ? ' editing' : ''}">
      <thead><tr><th class="c-pick"><input type="checkbox" id="select-all" aria-label="Select all"></th><th class="c-n">#</th>
        ${cols.map((c) => `<th class="${c.num ? 'num' : ''} sortable" data-sort="${c.key}" tabindex="0">${esc(c.label)}${c.num ? ` (${unitNote})` : ''}<span class="sort-mark"></span></th>`).join('')}</tr></thead>
      <tbody></tbody>
      <tfoot></tfoot>
    </table></div>
    <p class="muted no-print" style="margin-top:.5rem">Double-click a row to see where the piece came from, when, its weights, and when it was sold.${weightUnit() === 'tola' ? ` 1 tola = ${gramsPerTola()} g.` : ''}</p>`;

  const tbody = $('table.sheet tbody');
  const rowHtml = (p, i) => `<tr data-id="${p.id}">
    <td class="c-pick"><input type="checkbox" class="pick" value="${p.id}" aria-label="Select ${esc(p.item_code)}"></td><td class="c-n muted">${i + 1}</td>
    ${cols.map((c) => {
      const editable = editing && c.edit && p.status === 'in_stock' && (!c.edit.when || c.edit.when(p));
      return `<td class="${c.num ? 'num' : ''}${editable ? ' ed' : ''}" data-col="${c.key}" tabindex="${editable ? 0 : -1}">${c.html(p)}</td>`;
    }).join('')}</tr>`;
  const draw = () => {
    rows.sort((a, b) => {
      const col = cols.find((c) => c.key === sortKey);
      const x = col.sort(a);
      const y = col.sort(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sortDir || a.id - b.id;
    });
    tbody.innerHTML = rows.map(rowHtml).join('') || empty('No items found.', cols.length + 2);
    const tot = rows.reduce((t, p) => ({ gross: t.gross + p.gross_mg, stone: t.stone + p.stone_mg + p.other_less_mg, net: t.net + netMg(p) }), { gross: 0, stone: 0, net: 0 });
    $('table.sheet tfoot').innerHTML = `<tr><td></td><td colspan="${cols.findIndex((c) => c.key === 'gross') + 1}">${rows.length} item${rows.length === 1 ? '' : 's'}</td>
      <td class="num">${grams(tot.gross)}</td><td class="num">${grams(tot.stone)}</td><td class="num">${grams(tot.net)}</td><td colspan="${cols.length - cols.findIndex((c) => c.key === 'net') - 1}"></td></tr>`;
    $$('th[data-sort] .sort-mark').forEach((m) => { m.textContent = m.parentNode.dataset.sort === sortKey ? (sortDir > 0 ? ' ▲' : ' ▼') : ''; });
    wireRows();
  };

  const picks = () => $$('.pick:checked').map((c) => c.value);
  const refreshPicks = () => { $('#print-tags').disabled = picks().length === 0; };

  function wireRows() {
    $$('.pick', tbody).forEach((c) => c.addEventListener('change', refreshPicks));
    $$('.karigar-link', tbody).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openKarigarWindow(Number(b.dataset.karigar)); }));
    $$('tr[data-id]', tbody).forEach((tr) => tr.addEventListener('dblclick', (e) => {
      if (e.target.closest('td.ed, input, select, a, button')) return;
      openItemWindow(Number(tr.dataset.id));
    }));
    if (!editing) return;
    $$('td.ed', tbody).forEach((td) => {
      // Stop here: the row's double-click (which opens the item window) must not also run.
      td.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdit(td); });
      td.addEventListener('keydown', (e) => {
        if (e.target !== td) return;
        if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(td); }
      });
    });
  }

  function startEdit(td) {
    if (td.querySelector('input, select')) return;
    const p = rows.find((r) => String(r.id) === td.closest('tr').dataset.id);
    const col = cols.find((c) => c.key === td.dataset.col);
    const spec = col.edit;
    const current = spec.value(p);
    td.classList.add('editing-cell');
    td.innerHTML = spec.type === 'select'
      ? `<select aria-label="${esc(col.label)}">${spec.options().map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(current) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
      : `<input type="${spec.type === 'number' ? 'number' : 'text'}" ${spec.type === 'number' ? 'step="any" min="0" inputmode="decimal"' : 'maxlength="100"'}
          value="${esc(current)}" aria-label="${esc(col.label)}"${col.key === 'name' ? ` placeholder="${esc(p.category_name)}"` : ''}>`;
    const box = td.firstElementChild;
    box.focus();
    if (box.select) box.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = box.value;
      if (!save || String(value) === String(current)) { td.classList.remove('editing-cell'); td.innerHTML = col.html(p); td.focus(); return; }
      if (spec.type === 'number' && !(Number(value) > 0) && col.key === 'net') {
        toast('Net weight is required.', 'error');
        td.classList.remove('editing-cell'); td.innerHTML = col.html(p); td.focus(); return;
      }
      td.innerHTML = '<span class="muted">Saving…</span>';
      try {
        const updated = await api('PATCH', `/api/products/${p.id}`, { [spec.field]: value });
        Object.assign(p, updated);
        const i = rows.indexOf(p);
        const tr = td.closest('tr');
        tr.outerHTML = rowHtml(p, i);
        wireRows();
        const again = tbody.querySelector(`tr[data-id="${p.id}"] td[data-col="${col.key}"]`);
        if (again) again.focus();
        toast(`${p.item_code} saved.`);
      } catch (err) {
        toast(err.message, 'error');
        td.classList.remove('editing-cell');
        td.innerHTML = col.html(p);
        td.focus();
      }
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    box.addEventListener('blur', () => finish(true));
    if (spec.type === 'select') box.addEventListener('change', () => box.blur());
  }

  // Arrow keys move between cells, as in a spreadsheet.
  tbody.addEventListener('keydown', (e) => {
    const td = e.target.closest && e.target.closest('td');
    if (!td || e.target !== td || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const tr = td.parentNode;
    const idx = [...tr.children].indexOf(td);
    let target = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const cells = [...tr.children];
      for (let k = idx + (e.key === 'ArrowRight' ? 1 : -1); k >= 0 && k < cells.length; k += (e.key === 'ArrowRight' ? 1 : -1)) {
        if (cells[k].tabIndex >= 0) { target = cells[k]; break; }
      }
    } else {
      let row = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
      while (row && !target) { const c = row.children[idx]; if (c && c.tabIndex >= 0) target = c; else row = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling; }
    }
    if (target) { e.preventDefault(); target.focus(); }
  });

  $$('th[data-sort]').forEach((th) => {
    const sortBy = () => { if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = 1; } draw(); };
    th.addEventListener('click', sortBy);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter') sortBy(); });
  });
  $('#filter').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    go(link({ q: v.q, status: v.status, ...(owner ? { place: v.place } : {}) }));
  });
  $('#select-all').addEventListener('change', (e) => { $$('.pick').forEach((c) => { c.checked = e.target.checked; }); refreshPicks(); });
  $('#print-tags').addEventListener('click', () => go(`/labels?ids=${picks().join(',')}`));
  $('#excel').addEventListener('click', () => {
    const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['#', ...cols.map((c) => `${c.label}${c.num ? ` (${unitNote})` : ''}`)];
    const lines = [header.map(quote).join(','), ...rows.map((p, i) => [i + 1, ...cols.map((c) => c.csv(p))].map(quote).join(','))];
    const tab = tabs.find(([cid]) => cid === categoryId);
    const blob = new Blob([`\ufeff${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stock-${(tab ? tab[1] : 'all').replace(/[^A-Za-z0-9]+/g, '-')}-${localDate()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  draw();
}

/* ---------------- Windows ---------------- */

function windowDialog(id) {
  let dialog = document.getElementById(id);
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = id;
    dialog.className = 'window';
    document.body.appendChild(dialog);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }
  dialog.innerHTML = '<div class="window-body"><p class="muted">Loading…</p></div>';
  if (!dialog.open) dialog.showModal();
  return dialog;
}

function windowError(dialog, err) {
  dialog.innerHTML = `<div class="window-body"><div class="banner danger">${esc(err.message)}</div><button type="button" class="secondary" data-close>Close</button></div>`;
  $('[data-close]', dialog).addEventListener('click', () => dialog.close());
}

/** One piece: everything about it and everything that happened to it. */
async function openItemWindow(productId) {
  const dialog = windowDialog('item-window');
  let data;
  try { data = await api('GET', `/api/products/${productId}/history`); } catch (err) { windowError(dialog, err); return; }
  const p = data.product;
  const info = [
    ['Category', esc(p.category_name)], ['Item', esc(p.name)], ['Purity', `${esc(p.metal_name)} ${esc(p.purity_name)}`],
    ['Gross weight', grams(p.gross_mg)], ['Stone weight', grams(p.stone_mg + p.other_less_mg)], ['Net weight', `<strong>${grams(netMg(p))}</strong>`],
    ['Made by / from', sourceText(p, { links: false })], ['Came into stock', esc(fmtDay(receivedOf(p)))],
    ['HUID', esc(p.huid || '—')], ...(p.location ? [['Kept at', esc(p.location)]] : []),
    ['Status', statusBadge(p.status)], ...(p.sold_at ? [['Sold', soldText(p)]] : [])
  ];
  dialog.innerHTML = `<div class="window-body">
    <header class="window-head"><div><h2>${esc(p.item_code)}</h2><p class="muted">${p.name === p.category_name ? esc(p.category_name) : `${esc(p.name)}, ${esc(p.category_name)}`}</p></div>
      <div class="window-actions no-print"><a class="button secondary small" href="#/products/${p.id}" data-close>Open item</a>
        <a class="button secondary small" href="#/labels?ids=${p.id}" data-close>Print tag</a>
        <button type="button" class="secondary small" data-close>Close</button></div></header>
    <dl class="facts">${info.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <h3>History</h3>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>What happened</th><th>From / to</th><th class="num">Weight</th><th>By</th></tr></thead>
      <tbody>${data.events.map((e) => `<tr><td>${esc(fmtDate(e.at))}</td>
        <td>${e.qty > 0 ? '<span class="badge ok">In</span>' : e.qty < 0 ? '<span class="badge danger">Out</span>' : '<span class="badge">Change</span>'} ${esc(e.label)}${e.qty !== 0 && e.reason.startsWith('category') ? ` (${esc(e.category_name)})` : ''}</td>
        <td>${esc([e.party_name && `${e.party_type === 'karigar' ? 'Karigar' : 'Supplier'} ${e.party_name}`, e.ref_no, e.customer_name].filter(Boolean).join(', '))}${e.note && e.note !== 'From records before the daily register' ? ` <span class="muted">${esc(e.note)}</span>` : ''}</td>
        <td class="num">${e.qty === 0 ? `${e.gross_mg > 0 ? '+' : '−'}${grams(Math.abs(e.gross_mg))}` : grams(Math.abs(e.net_mg))}</td><td>${esc(e.by_name || '')}</td></tr>`).join('')
        || empty('No history recorded.', 5)}</tbody></table></div>
  </div>`;
  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));
}

/** One karigar: every piece they made, with code, weight, date, and when it was sold. */
async function openKarigarWindow(karigarId, period = 'all') {
  const dialog = windowDialog('karigar-window');
  const from = period === 'month' ? periodStart('month') : period === 'fiscal' ? periodStart('fiscal') : '2000-01-01';
  let data;
  try { data = await api('GET', `/api/karigars/${karigarId}/work?from=${from}&to=${localDate()}`); } catch (err) { windowError(dialog, err); return; }
  const inStock = data.pieces.filter((p) => p.status === 'in_stock').length;
  const sold = data.pieces.filter((p) => p.status === 'sold').length;
  const t = data.piece_totals;
  dialog.innerHTML = `<div class="window-body">
    <header class="window-head"><div><h2>${esc(data.karigar.name)}</h2><p class="muted">Everything made for the shop${data.karigar.phone ? `, phone ${esc(data.karigar.phone)}` : ''}</p></div>
      <div class="window-actions no-print">
        ${[['all', 'All time'], ['fiscal', 'This fiscal year'], ['month', 'This month']].map(([k, l]) => `<button type="button" class="${k === period ? '' : 'secondary'} small" data-period="${k}">${l}</button>`).join('')}
        <a class="button secondary small" href="#/karigars/${karigarId}" data-close>Open karigar page</a>
        <button type="button" class="secondary small" data-print>Print</button>
        <button type="button" class="secondary small" data-close>Close</button></div></header>
    <div class="window-stats">
      <div class="stat"><div class="label">Pieces made</div><div class="value">${t.pieces}</div></div>
      <div class="stat"><div class="label">Net weight</div><div class="value">${grams(t.net_mg)}</div></div>
      <div class="stat"><div class="label">Still in stock</div><div class="value">${inStock}</div></div>
      <div class="stat"><div class="label">Sold</div><div class="value">${sold}</div></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Made / received</th><th>Code</th><th>Category</th><th>Purity</th><th class="num">Gross</th><th class="num">Net</th><th>Now</th><th>Sold on</th></tr></thead>
      <tbody>${data.pieces.map((p) => `<tr class="clickable" data-item="${p.id}"><td>${esc(fmtDay(p.received_at))}${p.job_no ? `<br><small class="muted">${esc(p.job_no)}</small>` : ''}</td>
        <td><strong>${esc(p.item_code)}</strong></td><td>${esc(p.category_name)}${p.name !== p.category_name ? `<br><small class="muted">${esc(p.name)}</small>` : ''}</td>
        <td>${esc(p.metal_name)} ${esc(p.purity_name)}</td><td class="num">${grams(p.gross_mg)}</td><td class="num"><strong>${grams(p.net_mg)}</strong></td>
        <td>${statusBadge(p.status)}</td><td>${soldText(p)}</td></tr>`).join('') || empty('No pieces in this period.', 8)}</tbody>
      <tfoot><tr><td colspan="4">${t.pieces} piece${t.pieces === 1 ? '' : 's'}</td><td class="num">${grams(t.gross_mg)}</td><td class="num">${grams(t.net_mg)}</td><td colspan="2"></td></tr></tfoot>
    </table></div>
    ${data.by_category.length > 1 ? `<h3>By category</h3><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Pieces</th><th class="num">Net</th></tr></thead>
      <tbody>${data.by_category.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.pieces}</td><td class="num">${grams(c.net_mg)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));
  $$('[data-period]', dialog).forEach((b) => b.addEventListener('click', () => openKarigarWindow(karigarId, b.dataset.period)));
  $('[data-print]', dialog).addEventListener('click', () => { document.body.classList.add('printing-window'); window.print(); document.body.classList.remove('printing-window'); });
  $$('tr[data-item]', dialog).forEach((tr) => tr.addEventListener('click', () => openItemWindow(Number(tr.dataset.item))));
}
