'use strict';
const BS = require('./bsdate');
const { rule } = require('./errors');

/*
 * Double-entry accounting. Every money transaction posts a balanced journal entry automatically.
 * Posted entries are never edited or deleted; mistakes are undone with reversing entries.
 */

const A = {
  CASH: '1000', BANK: '1010', RECEIVABLE: '1100', STOCK: '1200', METAL: '1210', KARIGAR_WIP: '1220',
  PAYABLE: '2000', KARIGAR_PAYABLE: '2010', ADVANCES: '2100', TAX: '2200',
  CAPITAL: '3000', DRAWINGS: '3100', OPENING: '3200',
  SALES: '4000', REPAIR_INCOME: '4100', ROUNDING: '4900',
  COGS: '5000', STOCK_WRITE_OFF: '5100', METAL_LOSS: '5110'
};

const MONEY_METHODS = ['cash', 'bank', 'card', 'qr', 'cheque'];

/** Cash goes to the Cash account; bank transfer, card, QR and cheque go to Bank. */
const methodAccount = (method) => (method === 'cash' ? A.CASH : A.BANK);

function localDateText(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Converts an optional YYYY-MM-DD from a form to a timestamp: now for today or empty, midday for other days. */
function documentDate(dateText) {
  if (!dateText) return new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText))) throw rule('Dates must look like 2026-09-28.');
  const [y, m, d] = String(dateText).split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  if (localDateText(date.toISOString()) === localDateText(new Date().toISOString())) return new Date().toISOString();
  if (date > new Date()) throw rule('The date cannot be in the future.');
  return date.toISOString();
}

/** Blocks changes dated on or before the audit lock date. */
function assertOpen(store, iso, what = 'This') {
  const lock = store.setting('books_locked_until');
  if (lock && localDateText(iso) <= lock) {
    throw rule(`${what} is dated ${localDateText(iso)}, and the books are locked up to ${lock}.`);
  }
}

function nextNumber(store, name, prefix, width = 5) {
  store.run('INSERT OR IGNORE INTO sequences (name, next_value) VALUES (?, 1)', name);
  const value = store.get('UPDATE sequences SET next_value = next_value + 1 WHERE name = ? RETURNING next_value - 1 AS value', name).value;
  return `${prefix}${String(value).padStart(width, '0')}`;
}

function calendar(store) {
  const overrides = Object.fromEntries(
    store.all('SELECT year, month_days FROM bs_calendar_overrides').map((r) => [r.year, JSON.parse(r.month_days)]));
  return BS.createCalendar(overrides);
}

/** Invoice numbers run continuously, or restart each Nepali fiscal year (e.g. INV-2083/84-00001). */
function invoiceNumber(store) {
  const prefix = store.setting('invoice_prefix') || '';
  if (store.setting('invoice_numbering') === 'fiscal_year') {
    const cal = calendar(store);
    const bs = cal.fromDate(new Date());
    if (bs) {
      const fy = cal.fiscalYearOf(bs).label;
      return nextNumber(store, `invoice:${fy}`, `${prefix}${fy}-`, 5);
    }
  }
  return nextNumber(store, 'invoice', prefix, 6);
}

const accountCache = new WeakMap();
function accountId(store, code) {
  let map = accountCache.get(store);
  if (!map) { map = new Map(); accountCache.set(store, map); }
  if (!map.has(code)) {
    const row = store.get('SELECT id FROM accounts WHERE code = ?', code);
    if (!row) throw new Error(`Account ${code} is missing.`);
    map.set(code, row.id);
  }
  return map.get(code);
}

/**
 * Posts one balanced journal entry.
 * lines: [{ account: '1000' | accountId: 5, debit, credit, party_type, party_id, memo }]
 * A negative debit is posted as a credit (and the other way round), which keeps callers simple.
 */
function post(store, user, { date, narration, refType = null, refId = null, reversesId = null, lines, skipLock = false }) {
  const when = date || new Date().toISOString();
  const clean = [];
  for (const line of lines) {
    let debit = line.debit || 0;
    let credit = line.credit || 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) throw new Error(`Amounts must be whole paisa (${narration}).`);
    if (debit < 0) { credit -= debit; debit = 0; }
    if (credit < 0) { debit -= credit; credit = 0; }
    const net = debit - credit;
    if (net === 0) continue;
    clean.push({ ...line, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  const totalDebit = clean.reduce((a, l) => a + l.debit, 0);
  const totalCredit = clean.reduce((a, l) => a + l.credit, 0);
  if (totalDebit !== totalCredit) throw new Error(`Unbalanced entry "${narration}": ${totalDebit} / ${totalCredit}`);
  if (totalDebit === 0) return null;
  if (!skipLock) assertOpen(store, when, 'This entry');

  const entryId = store.run(
    `INSERT INTO journal_entries (entry_no, entry_date, narration, ref_type, ref_id, reverses_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    nextNumber(store, 'journal', 'JV-', 6), when, narration, refType, refId, reversesId, new Date().toISOString(), user ? user.id : null
  ).lastInsertRowid;
  for (const l of clean) {
    store.run(
      `INSERT INTO journal_lines (entry_id, account_id, debit_paisa, credit_paisa, party_type, party_id, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entryId, l.accountId || accountId(store, l.account), l.debit, l.credit, l.party_type || null, l.party_id || null, l.memo || null
    );
  }
  return entryId;
}

/** Posts the exact opposite of one entry. */
function reverseEntry(store, user, entryId, narration, date) {
  const entry = store.get('SELECT * FROM journal_entries WHERE id = ?', entryId);
  if (!entry) throw rule('Entry not found.');
  if (entry.reverses_id) throw rule('A reversing entry cannot itself be reversed.');
  if (store.get('SELECT id FROM journal_entries WHERE reverses_id = ?', entryId)) throw rule(`${entry.entry_no} is already reversed.`);
  const lines = store.all('SELECT * FROM journal_lines WHERE entry_id = ?', entryId);
  return post(store, user, {
    date,
    narration: narration || `Reversal of ${entry.entry_no}: ${entry.narration}`,
    refType: entry.ref_type,
    refId: entry.ref_id,
    reversesId: entry.id,
    lines: lines.map((l) => ({
      accountId: l.account_id, debit: l.credit_paisa, credit: l.debit_paisa,
      party_type: l.party_type, party_id: l.party_id, memo: l.memo
    }))
  });
}

/** Reverses every not-yet-reversed entry of a document (a cancelled sale, purchase, ...). */
function reverseDocument(store, user, refType, refId, narration, date) {
  const entries = store.all(
    `SELECT e.id FROM journal_entries e
     WHERE e.ref_type = ? AND e.ref_id = ? AND e.reverses_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id)
     ORDER BY e.id`,
    refType, refId);
  for (const e of entries) reverseEntry(store, user, e.id, narration, date);
}

/** Debit minus credit on an account, optionally for one party (customer, supplier, karigar). */
function balance(store, code, partyType, partyId) {
  const row = partyType
    ? store.get(
      `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS b FROM journal_lines
       WHERE account_id = ? AND party_type = ? AND party_id = ?`, accountId(store, code), partyType, partyId)
    : store.get('SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS b FROM journal_lines WHERE account_id = ?', accountId(store, code));
  return row.b;
}

module.exports = {
  A, MONEY_METHODS, methodAccount, localDateText, documentDate, assertOpen, nextNumber, invoiceNumber, calendar,
  accountId, post, reverseEntry, reverseDocument, balance
};
