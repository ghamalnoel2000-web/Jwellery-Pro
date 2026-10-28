'use strict';

/*
 * Daily stock register for shop stock (tagged pieces in the shop; owner-only stock kept outside is not shop stock).
 * Every piece entering or leaving shop stock writes one movement. Opening stock for a day is the sum of all
 * movements before it, so opening + in − out = closing always holds, and each day's closing is the next day's opening.
 */

const REASONS = {
  // coming in
  manual: { dir: 1, label: 'Entered into stock' },
  purchase: { dir: 1, label: 'Bought from supplier' },
  karigar: { dir: 1, label: 'Made by karigar' },
  from_locker: { dir: 1, label: 'From owner-only stock (locker)' },
  sale_cancelled: { dir: 1, label: 'Bill cancelled, back in stock' },
  restored: { dir: 1, label: 'Put back in stock' },
  category_in: { dir: 1, label: 'Moved from another category' },
  // going out
  sold: { dir: -1, label: 'Sold' },
  to_locker: { dir: -1, label: 'To owner-only stock (locker)' },
  removed: { dir: -1, label: 'Removed from stock' },
  purchase_cancelled: { dir: -1, label: 'Purchase cancelled' },
  category_out: { dir: -1, label: 'Moved to another category' },
  // weight only
  weight_corrected: { dir: 0, label: 'Weight corrected' }
};

const netOf = (p) => p.gross_mg - p.stone_mg - p.other_less_mg;

/** Supplier or karigar a piece came from. */
function sourceParty(store, product) {
  // Pieces entered by hand can name the karigar who made them.
  if (product.source !== 'purchase' && product.karigar_id) return { party_type: 'karigar', party_id: product.karigar_id };
  if (product.source === 'purchase' && product.source_id) {
    const row = store.get('SELECT supplier_id FROM purchases WHERE id = ?', product.source_id);
    if (row) return { party_type: 'supplier', party_id: row.supplier_id };
  }
  if (product.source === 'karigar' && product.source_id) {
    const row = store.get('SELECT j.karigar_id FROM karigar_receipts r JOIN karigar_jobs j ON j.id = r.job_id WHERE r.id = ?', product.source_id);
    if (row) return { party_type: 'karigar', party_id: row.karigar_id };
  }
  return { party_type: null, party_id: null };
}

/**
 * Records one movement for a piece. `product` is the piece as it is on the side of the movement that is in the shop
 * (after it arrives, or before it leaves). Pieces in owner-only stock are skipped unless `force` is set.
 */
function record(store, user, product, reason, { at = null, refType = null, refId = null, note = null, grossDelta = 0, netDelta = 0, force = false, party = null } = {}) {
  const r = REASONS[reason];
  if (!r) throw new Error(`Unknown stock movement ${reason}`);
  if (product.is_private && !force) return;
  const who = party || (r.dir > 0 && ['manual', 'purchase', 'karigar'].includes(reason) ? sourceParty(store, product) : { party_type: null, party_id: null });
  store.run(
    `INSERT INTO stock_movements (moved_at, product_id, category_id, qty, gross_mg, net_mg, reason, party_type, party_id, ref_type, ref_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    at || new Date().toISOString(), product.id, product.category_id, r.dir,
    r.dir === 0 ? grossDelta : r.dir * product.gross_mg, r.dir === 0 ? netDelta : r.dir * netOf(product),
    reason, who.party_type, who.party_id, refType, refId, note, user ? user.id : null);
}

/** Records what an edit changed: to or from the locker, a new category, or corrected weights. */
function recordEdit(store, user, before, after) {
  if (!before.is_private && after.is_private) return record(store, user, before, 'to_locker', { force: true });
  if (before.is_private && !after.is_private) return record(store, user, after, 'from_locker', { force: true });
  if (before.is_private) return;
  if (before.category_id !== after.category_id) {
    record(store, user, before, 'category_out');
    record(store, user, after, 'category_in');
    return;
  }
  const grossDelta = after.gross_mg - before.gross_mg;
  const netDelta = netOf(after) - netOf(before);
  if (grossDelta || netDelta) record(store, user, after, 'weight_corrected', { grossDelta, netDelta });
}

function localDayBounds(dateText) {
  const [y, m, d] = String(dateText).split('-').map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

function localDateText(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const blank = () => ({ qty: 0, gross_mg: 0, net_mg: 0 });
const add = (a, m) => { a.qty += m.qty; a.gross_mg += m.gross_mg; a.net_mg += m.net_mg; };

/** The register for one day: per category opening, what came in and went out (by reason), closing. */
function dayRegister(store, dateText) {
  const { from, to } = localDayBounds(dateText);
  const categories = store.all('SELECT id, name, prefix FROM categories ORDER BY name');
  const opening = new Map(store.all(
    `SELECT category_id, SUM(qty) AS qty, SUM(gross_mg) AS gross_mg, SUM(net_mg) AS net_mg
     FROM stock_movements WHERE moved_at < ? GROUP BY category_id`, from).map((r) => [r.category_id, r]));
  const moves = store.all(
    `SELECT m.*, p.item_code, p.name AS item_name, u.full_name AS by_name,
            CASE m.party_type WHEN 'supplier' THEN (SELECT name FROM suppliers WHERE id = m.party_id)
                              WHEN 'karigar' THEN (SELECT name FROM karigars WHERE id = m.party_id) END AS party_name,
            CASE m.ref_type WHEN 'sale' THEN (SELECT invoice_no FROM sales WHERE id = m.ref_id)
                            WHEN 'purchase' THEN (SELECT purchase_no FROM purchases WHERE id = m.ref_id)
                            WHEN 'karigar_job' THEN (SELECT job_no FROM karigar_jobs WHERE id = m.ref_id) END AS ref_no
     FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.created_by
     WHERE m.moved_at >= ? AND m.moved_at < ? ORDER BY m.moved_at, m.id`, from, to);
  const counts = new Map(store.all("SELECT * FROM stock_counts WHERE count_date = ? AND session = 'evening'", dateText).map((c) => [c.category_id, c]));

  const rows = categories.map((c) => {
    const o = opening.get(c.id) || blank();
    const row = {
      category_id: c.id, name: c.name, prefix: c.prefix,
      opening: { qty: o.qty || 0, gross_mg: o.gross_mg || 0, net_mg: o.net_mg || 0 },
      in: {}, out: {}, total_in: blank(), total_out: blank(), weight_corrected_mg: 0, closing: null, count: counts.get(c.id) || null
    };
    for (const m of moves.filter((x) => x.category_id === c.id)) {
      const r = REASONS[m.reason];
      if (r.dir === 0) { row.weight_corrected_mg += m.gross_mg; continue; }
      const bucket = r.dir > 0 ? row.in : row.out;
      bucket[m.reason] = bucket[m.reason] || blank();
      const positive = { qty: Math.abs(m.qty), gross_mg: Math.abs(m.gross_mg), net_mg: Math.abs(m.net_mg) };
      add(bucket[m.reason], positive);
      add(r.dir > 0 ? row.total_in : row.total_out, positive);
    }
    row.closing = {
      qty: row.opening.qty + row.total_in.qty - row.total_out.qty,
      gross_mg: row.opening.gross_mg + row.total_in.gross_mg - row.total_out.gross_mg + row.weight_corrected_mg,
      net_mg: row.opening.net_mg + row.total_in.net_mg - row.total_out.net_mg
        + moves.filter((x) => x.category_id === c.id && x.reason === 'weight_corrected').reduce((a, x) => a + x.net_mg, 0)
    };
    if (row.count) row.count.difference = row.count.counted_qty - row.closing.qty;
    return row;
  }).filter((r) => r.opening.qty || r.total_in.qty || r.total_out.qty || r.closing.qty || r.count || r.weight_corrected_mg);

  const today = localDateText(new Date());
  let systemCheck = null;
  if (dateText === today) {
    // The register must agree with what is actually marked in stock right now.
    const actual = new Map(store.all(
      `SELECT category_id, COUNT(*) AS qty, SUM(gross_mg) AS gross_mg FROM products
       WHERE status = 'in_stock' AND is_private = 0 GROUP BY category_id`).map((r) => [r.category_id, r]));
    const problems = [];
    for (const c of categories) {
      const a = actual.get(c.id) || { qty: 0, gross_mg: 0 };
      const row = rows.find((r) => r.category_id === c.id);
      const book = row ? row.closing : { qty: 0, gross_mg: 0 };
      if (a.qty !== book.qty || (a.gross_mg || 0) !== book.gross_mg) problems.push({ name: c.name, register: book.qty, actual: a.qty });
    }
    systemCheck = { ok: problems.length === 0, problems };
  }

  const sum = (key) => rows.reduce((t, r) => {
    const v = key.split('.').reduce((o, k) => o[k], r);
    return { qty: t.qty + v.qty, gross_mg: t.gross_mg + v.gross_mg, net_mg: t.net_mg + v.net_mg };
  }, blank());
  return {
    date: dateText, is_today: dateText === today, rows, movements: moves,
    totals: { opening: sum('opening'), in: sum('total_in'), out: sum('total_out'), closing: sum('closing') },
    counted: rows.length > 0 && rows.every((r) => r.count), system_check: systemCheck,
    reasons: Object.fromEntries(Object.entries(REASONS).map(([k, v]) => [k, v.label]))
  };
}

/** One line per day for the last `days` days: opening, in, sold, other out, closing, and whether it was counted. */
function daySummaries(store, days = 90) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  const openingRow = store.get('SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(gross_mg), 0) AS gross_mg FROM stock_movements WHERE moved_at < ?', start.toISOString());
  const moves = store.all('SELECT moved_at, qty, gross_mg, reason FROM stock_movements WHERE moved_at >= ? ORDER BY moved_at', start.toISOString());
  const counted = store.all(
    `SELECT count_date, SUM(counted_qty) AS qty, COUNT(*) AS categories FROM stock_counts WHERE count_date >= ? AND session = 'evening' GROUP BY count_date`,
    localDateText(start));
  const countedMap = new Map(counted.map((c) => [c.count_date, c]));
  const out = [];
  let qty = openingRow.qty;
  let gross = openingRow.gross_mg;
  let i = 0;
  for (let d = 0; d < days; d += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString();
    const row = { date: localDateText(day), opening_qty: qty, opening_gross_mg: gross, in_qty: 0, sold_qty: 0, other_out_qty: 0 };
    while (i < moves.length && moves[i].moved_at < end) {
      const m = moves[i];
      if (m.qty > 0) row.in_qty += m.qty;
      else if (m.reason === 'sold') row.sold_qty -= m.qty;
      else if (m.qty < 0) row.other_out_qty -= m.qty;
      qty += m.qty;
      gross += m.gross_mg;
      i += 1;
    }
    row.closing_qty = qty;
    row.closing_gross_mg = gross;
    const c = countedMap.get(row.date);
    row.counted_qty = c ? c.qty : null;
    out.push(row);
  }
  return out.reverse();
}

/** Owner's layout for the register grid: which category rows are shown and in what order. */
function readLayout(store) {
  try {
    const layout = JSON.parse(store.setting('stock_register_layout') || '{}');
    return { hidden: Array.isArray(layout.hidden) ? layout.hidden.map(Number) : [], order: Array.isArray(layout.order) ? layout.order.map(Number) : [] };
  } catch {
    return { hidden: [], order: [] };
  }
}

/**
 * The register as a grid, like the shop's register book: one row per category, and for each day a
 * morning (opening) and evening (closing) count. Evening of one day always equals morning of the next.
 */
function gridRegister(store, fromText, toText) {
  const layout = readLayout(store);
  const days = [];
  const [fy, fm, fd] = fromText.split('-').map(Number);
  for (let i = 0; ; i += 1) {
    const text = localDateText(new Date(fy, fm - 1, fd + i));
    if (text > toText) break;
    days.push(text);
  }
  const all = store.all('SELECT id, name, prefix FROM categories');
  const rank = (c) => { const i = layout.order.indexOf(c.id); return i === -1 ? 1e6 : i; };
  all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const start = localDayBounds(fromText).from;
  const end = localDayBounds(toText).to;
  const opening = new Map(store.all(
    'SELECT category_id, SUM(qty) AS qty FROM stock_movements WHERE moved_at < ? GROUP BY category_id', start).map((r) => [r.category_id, r.qty]));
  const moves = store.all('SELECT moved_at, category_id, qty FROM stock_movements WHERE moved_at >= ? AND moved_at < ? AND qty <> 0 ORDER BY moved_at', start, end);
  const counts = store.all(
    `SELECT c.count_date, c.session, c.category_id, c.counted_qty, u.full_name AS counted_by FROM stock_counts c LEFT JOIN users u ON u.id = c.counted_by
     WHERE c.count_date >= ? AND c.count_date <= ?`, fromText, toText);

  const running = new Map(all.map((c) => [c.id, opening.get(c.id) || 0]));
  const cells = new Map(all.map((c) => [c.id, []]));
  let i = 0;
  for (const day of days) {
    const dayEnd = localDayBounds(day).to;
    const inQ = new Map();
    const outQ = new Map();
    const morning = new Map(running);
    while (i < moves.length && moves[i].moved_at < dayEnd) {
      const m = moves[i];
      running.set(m.category_id, (running.get(m.category_id) || 0) + m.qty);
      (m.qty > 0 ? inQ : outQ).set(m.category_id, ((m.qty > 0 ? inQ : outQ).get(m.category_id) || 0) + Math.abs(m.qty));
      i += 1;
    }
    for (const c of all) {
      const count = counts.find((x) => x.count_date === day && x.session === 'evening' && x.category_id === c.id);
      const mCount = counts.find((x) => x.count_date === day && x.session === 'morning' && x.category_id === c.id);
      cells.get(c.id).push({
        date: day, open: morning.get(c.id) || 0, close: running.get(c.id) || 0,
        in: inQ.get(c.id) || 0, out: outQ.get(c.id) || 0,
        counted: count ? count.counted_qty : null, counted_morning: mCount ? mCount.counted_qty : null
      });
    }
  }
  const rows = all.map((c) => ({ ...c, hidden: layout.hidden.includes(c.id), cells: cells.get(c.id) }));
  const checkedBy = days.map((day) => [...new Set(counts.filter((x) => x.count_date === day).map((x) => x.counted_by).filter(Boolean))]);
  const totals = days.map((day, k) => {
    const shown = rows.filter((r) => !r.hidden);
    return { date: day, open: shown.reduce((a, r) => a + r.cells[k].open, 0), close: shown.reduce((a, r) => a + r.cells[k].close, 0) };
  });
  return { from: fromText, to: toText, today: localDateText(new Date()), days, rows, totals, checked_by: checkedBy, layout };
}

/**
 * The pieces of one category that were in shop stock at a moment (start or end of a day), with their code,
 * where they came from (karigar, supplier, locker, by hand) and when they came into stock.
 */
function categoryAt(store, categoryId, atIso) {
  const items = store.all(
    `SELECT p.id, p.item_code, p.name, p.gross_mg, p.stone_mg, p.other_less_mg, p.status, p.is_private, p.location, p.source, p.source_id, p.karigar_id,
            pu.name AS purity_name, m.name AS metal_name, x.since,
            (SELECT reason FROM stock_movements s WHERE s.product_id = p.id AND s.category_id = ? AND s.qty > 0 AND s.moved_at < ?
             ORDER BY s.moved_at DESC, s.id DESC LIMIT 1) AS came_in_as
     FROM (SELECT product_id, MAX(CASE WHEN qty > 0 THEN moved_at END) AS since FROM stock_movements
           WHERE category_id = ? AND moved_at < ? GROUP BY product_id HAVING SUM(qty) > 0) x
     JOIN products p ON p.id = x.product_id JOIN purities pu ON pu.id = p.purity_id JOIN metals m ON m.id = pu.metal_id
     ORDER BY x.since, p.item_code`, categoryId, atIso, categoryId, atIso);
  return items.map((p) => {
    const party = sourceParty(store, p);
    let from = null;
    if (party.party_type === 'karigar') from = store.get('SELECT name FROM karigars WHERE id = ?', party.party_id);
    if (party.party_type === 'supplier') from = store.get('SELECT name FROM suppliers WHERE id = ?', party.party_id);
    const extra = party.party_type === 'karigar'
      ? store.get('SELECT j.job_no FROM karigar_receipts r JOIN karigar_jobs j ON j.id = r.job_id WHERE r.id = ?', p.source_id)
      : party.party_type === 'supplier' ? store.get('SELECT purchase_no AS job_no FROM purchases WHERE id = ?', p.source_id) : null;
    return {
      id: p.id, item_code: p.item_code, name: p.name, purity: `${p.metal_name} ${p.purity_name}`, gross_mg: p.gross_mg,
      net_mg: netOf(p), since: p.since, came_in_as: p.came_in_as, source: p.source,
      from_type: party.party_type, from_name: from ? from.name : null, from_ref: extra ? extra.job_no : null,
      status_now: p.status, private_now: !!p.is_private
    };
  });
}

module.exports = { REASONS, record, recordEdit, dayRegister, daySummaries, gridRegister, categoryAt, readLayout, localDayBounds, sourceParty, localDateText };
