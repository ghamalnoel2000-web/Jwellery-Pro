'use strict';
const { rule } = require('./errors');

/*
 * Metal stock: fine gold and silver the shop holds that is not a tagged piece
 * (old gold taken in, bullion bought, metal returned by karigars).
 * Tracked by fine weight and by value; value going out uses the average cost per fine gram.
 */

function balance(store, metalId) {
  return store.get(
    'SELECT COALESCE(SUM(fine_mg), 0) AS fine_mg, COALESCE(SUM(value_paisa), 0) AS value_paisa FROM metal_ledger WHERE metal_id = ?',
    metalId);
}

/** Value of fine metal leaving stock, at the current average cost. */
function valueOut(store, metalId, fineMg) {
  const b = balance(store, metalId);
  if (fineMg > b.fine_mg) {
    const metal = store.get('SELECT name FROM metals WHERE id = ?', metalId);
    throw rule(`Not enough ${metal.name.toLowerCase()} in metal stock: ${(b.fine_mg / 1000).toFixed(3)} g fine available, ${(fineMg / 1000).toFixed(3)} g needed.`);
  }
  if (fineMg === b.fine_mg) return b.value_paisa;
  return Math.round((b.value_paisa * fineMg) / b.fine_mg);
}

function add(store, user, { date, metalId, fineMg, grossMg = null, purity = null, valuePaisa, source, refType = null, refId = null, note = null }) {
  if (fineMg < 0) {
    const b = balance(store, metalId);
    if (b.fine_mg + fineMg < 0) {
      const metal = store.get('SELECT name FROM metals WHERE id = ?', metalId);
      throw rule(`Not enough ${metal.name.toLowerCase()} in metal stock for this (${(b.fine_mg / 1000).toFixed(3)} g fine available).`);
    }
  }
  store.run(
    `INSERT INTO metal_ledger (entry_date, metal_id, fine_mg, gross_mg, purity, value_paisa, source, ref_type, ref_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    date || new Date().toISOString(), metalId, fineMg, grossMg, purity, valuePaisa, source, refType, refId, note, user ? user.id : null);
}

module.exports = { balance, valueOut, add };
