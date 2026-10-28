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

async function pageStockRegister(main, _id, params) {
  const date = params.get('date') || localDate();
  const [reg, days] = await Promise.all([api('GET', `/api/stock-register?date=${date}`), api('GET', '/api/stock-register/days?days=90')]);
  const shift = (n) => localDate(new Date(adDate(date).getTime() + n * 86400000 + 3600000));
  const today = localDate();
  const IN_OTHER = ['manual', 'sale_cancelled', 'restored', 'category_in'];
  const OUT_OTHER = ['removed', 'purchase_cancelled', 'category_out'];
  const t = reg.totals;
  const partyText = (m) => [m.party_name, m.ref_no].filter(Boolean).join(' · ');

  main.innerHTML = `
    <h1>Daily stock register</h1>
    <p class="muted">Shop stock only (owner-only stock kept outside the shop is not included). Opening stock + items in − items out = closing stock.
      Each day's closing stock is the next day's opening stock.</p>
    <form class="toolbar no-print" id="day-form">
      ${dateField('Day', 'date', date)}<button type="submit">Show</button>
      <a class="button secondary" href="#/stock-register?date=${shift(-1)}">Previous day</a>
      ${date < today ? `<a class="button secondary" href="#/stock-register?date=${shift(1)}">Next day</a>` : ''}
      ${date !== today ? '<a class="button secondary" href="#/stock-register">Today</a>' : ''}
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
      <tbody>${days.filter((d) => d.opening_qty || d.in_qty || d.closing_qty || d.counted_qty !== null).map((d) => `<tr class="clickable${d.date === date ? ' current' : ''}" data-href="#/stock-register?date=${d.date}">
        <td>${esc(fmtDay(adDate(d.date).toISOString()))}</td><td class="num">${d.opening_qty}</td><td class="num">${d.in_qty ? `+${d.in_qty}` : ''}</td>
        <td class="num">${d.sold_qty ? `−${d.sold_qty}` : ''}</td><td class="num">${d.other_out_qty ? `−${d.other_out_qty}` : ''}</td>
        <td class="num"><strong>${d.closing_qty}</strong> <small class="muted">${grams(d.closing_gross_mg)}</small></td>
        <td>${d.counted_qty === null ? '<span class="muted">—</span>' : d.counted_qty === d.closing_qty ? '<span class="badge ok">Matches</span>'
          : `<span class="badge danger">Counted ${d.counted_qty}</span>`}</td></tr>`).join('') || empty('No stock yet.', 7)}</tbody>
    </table></div></div>`;

  wireDateFields(main);
  $('#day-form').addEventListener('submit', (e) => { e.preventDefault(); go(`/stock-register?date=${formValues(e.target).date}`); });
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
