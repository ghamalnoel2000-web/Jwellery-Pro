'use strict';

/*
 * Daily stock register for shop stock (tagged pieces in the shop; owner-only stock kept outside is not shop stock).
 * Every piece entering or leaving shop stock writes one movement. Opening stock for a day is the sum of all
 * movements before it, so opening + in − out = closing always holds, and each day's closing is the next day's opening.
 */

const REASONS = {
  // coming in
  manual: { dir: 1, label: 'Added by hand' },
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
  const counts = new Map(store.all('SELECT * FROM stock_counts WHERE count_date = ?', dateText).map((c) => [c.category_id, c]));

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
    `SELECT count_date, SUM(counted_qty) AS qty, COUNT(*) AS categories FROM stock_counts WHERE count_date >= ? GROUP BY count_date`,
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

module.exports = { REASONS, record, recordEdit, dayRegister, daySummaries, sourceParty, localDateText };
