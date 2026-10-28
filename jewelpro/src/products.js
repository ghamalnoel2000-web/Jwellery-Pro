'use strict';
const { toPaisa, toMg, toNumber, text, id } = require('./units');
const { badRequest, rule } = require('./errors');
const stock = require('./stock');

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * Reads and checks the fields of a tagged piece from a form.
 * Net weight is the one weight that must be entered. Gross weight is only needed for pieces with stones
 * (it defaults to the net weight). The name is optional: the category name is used when it is empty.
 */
function readProduct(body, label = 'Item') {
  const p = {
    name: text(body.name, `${label}: name`, { max: 100 }) || '',
    category_id: id(body.category_id, `${label}: category`),
    purity_id: id(body.purity_id, `${label}: purity`),
    gross_mg: has(body.net_g) ? 0 : toMg(body.gross_g, `${label}: gross weight`),
    stone_mg: toMg(body.stone_g, `${label}: stone weight`),
    other_less_mg: toMg(body.other_less_g, `${label}: other less weight`),
    stone_paisa: toPaisa(body.stone_amount, `${label}: stone charge`),
    other_paisa: toPaisa(body.other_amount, `${label}: other charges`),
    charge_profile_id: body.charge_profile_id ? id(body.charge_profile_id, `${label}: charge profile`) : null,
    making_override: body.making_override === '' || body.making_override == null ? null : toNumber(body.making_override, `${label}: making charge`),
    wastage_override: body.wastage_override === '' || body.wastage_override == null ? null : toNumber(body.wastage_override, `${label}: wastage`),
    fixed_price_paisa: body.fixed_price === '' || body.fixed_price == null ? null : toPaisa(body.fixed_price, `${label}: fixed price`),
    huid: text(body.huid, `${label}: HUID / hallmark`, { max: 30 }),
    size: text(body.size, `${label}: size`, { max: 20 }),
    notes: text(body.notes, `${label}: notes`, { max: 300 }),
    cost_paisa: toPaisa(body.cost, `${label}: cost price`),
    karigar_id: has(body.karigar_id) ? id(body.karigar_id, `${label}: karigar`) : null,
    received_date: has(body.received_date) ? String(body.received_date) : null
  };
  if (has(body.net_g)) {
    // Net weight first: gross only if the piece has stones.
    const net = toMg(body.net_g, `${label}: net weight`, { allowEmpty: false });
    if (net <= 0) throw badRequest(`${label}: net weight must be more than zero.`);
    const gross = has(body.gross_g) ? toMg(body.gross_g, `${label}: gross weight`) : net;
    if (gross < net) throw badRequest(`${label}: gross weight cannot be less than the net weight.`);
    p.gross_mg = gross;
    p.stone_mg = gross - net;
    p.other_less_mg = 0;
    return p;
  }
  if (p.gross_mg <= 0) throw badRequest(`${label}: enter the net weight.`);
  if (p.stone_mg + p.other_less_mg >= p.gross_mg) throw badRequest(`${label}: stone and other less weight must be less than the gross weight.`);
  return p;
}

/** Creates one tagged piece with its own item code. Call inside a transaction. */
function insertProduct(store, user, p, { itemCode = null, source = 'manual', sourceId = null } = {}) {
  const category = store.get('SELECT * FROM categories WHERE id = ?', p.category_id);
  if (!category) throw badRequest('Choose a category.');
  if (!store.get('SELECT id FROM purities WHERE id = ?', p.purity_id)) throw badRequest('Choose a purity.');
  const name = p.name || category.name;
  if (p.karigar_id && !store.get('SELECT id FROM karigars WHERE id = ?', p.karigar_id)) throw badRequest('Choose a karigar from the list.');
  const receivedAt = receivedAtFrom(p.received_date);
  let code = itemCode;
  if (!code) {
    const n = store.get('UPDATE categories SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS n', category.id).n;
    code = `${category.prefix}${String(n).padStart(5, '0')}`;
  }
  if (!/^[A-Za-z0-9-]+$/.test(code)) throw badRequest('Item code may only contain letters, numbers and dashes.');
  if (store.get('SELECT id FROM products WHERE item_code = ?', code)) throw rule(`Item code ${code} is already used.`);
  const rowId = store.run(
    `INSERT INTO products (item_code, name, category_id, purity_id, gross_mg, stone_mg, other_less_mg, stone_paisa, other_paisa,
       charge_profile_id, making_override, wastage_override, fixed_price_paisa, huid, size, notes, cost_paisa, created_at, created_by,
       source, source_id, is_private, location, karigar_id, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code, name, p.category_id, p.purity_id, p.gross_mg, p.stone_mg, p.other_less_mg, p.stone_paisa, p.other_paisa,
    p.charge_profile_id, p.making_override, p.wastage_override, p.fixed_price_paisa, p.huid, p.size, p.notes,
    p.cost_paisa, new Date().toISOString(), user.id, source, sourceId, p.is_private ? 1 : 0, p.location || null,
    p.karigar_id || null, receivedAt
  ).lastInsertRowid;
  // Daily stock register: a new piece in the shop (pieces kept in owner-only stock are not shop stock).
  const row = store.get('SELECT * FROM products WHERE id = ?', rowId);
  let ref = { refType: null, refId: null };
  if (source === 'purchase') ref = { refType: 'purchase', refId: sourceId };
  if (source === 'karigar') {
    const job = store.get('SELECT job_id FROM karigar_receipts WHERE id = ?', sourceId);
    ref = { refType: 'karigar_job', refId: job ? job.job_id : null };
  }
  const party = source === 'manual' && p.karigar_id ? { party_type: 'karigar', party_id: p.karigar_id } : null;
  stock.record(store, user, row, ['purchase', 'karigar'].includes(source) ? source : 'manual', { ...ref, at: receivedAt, party });
  store.audit(user, 'create', 'product', rowId, { item_code: code, source, ...p, name });
  return { id: rowId, item_code: code, received_at: receivedAt };
}

/** The moment a piece came into stock: now, or midday on an earlier day the user chose (never in the future). */
function receivedAtFrom(dateText) {
  if (!dateText) return new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw badRequest('The date must look like 2026-09-28.');
  const [y, m, d] = dateText.split('-').map(Number);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (dateText > today) throw badRequest('The date it came into stock cannot be in the future.');
  if (dateText === today) return now.toISOString();
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

/** Fine metal in a piece, in milligrams. */
function fineOf(p, purity) {
  return Math.round((p.gross_mg - p.stone_mg - p.other_less_mg) * purity);
}

module.exports = { readProduct, insertProduct, fineOf, receivedAtFrom };
