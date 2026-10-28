'use strict';
const { toPaisa, text, oneOf } = require('../units');
const { badRequest } = require('../errors');
const ledger = require('../ledger');

const nowIso = () => new Date().toISOString();

/** Converts a local calendar date (YYYY-MM-DD) to the start of that day. */
function localDayStart(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) throw badRequest('Dates must look like 2026-09-28.');
  const [y, m, d] = dateText.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** ?from=&to= (local dates, inclusive) as UTC bounds; defaults to today. */
function dateRange(query) {
  const todayText = ledger.localDateText(nowIso());
  const from = localDayStart(query.from || todayText);
  const to = localDayStart(query.to || todayText);
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  if (end <= from) throw badRequest('The "to" date must be on or after the "from" date.');
  return { fromIso: from.toISOString(), toIso: end.toISOString() };
}

/** A money payment from a form: { method, amount, reference }. Returns null when the amount is empty or zero. */
function readPayment(body, label = 'Payment', { required = false } = {}) {
  if (!body || body.amount === '' || body.amount === undefined || body.amount === null || Number(body.amount) === 0) {
    if (required) throw badRequest(`${label}: enter the amount.`);
    return null;
  }
  return {
    method: oneOf(body.method, `${label} method`, ledger.MONEY_METHODS),
    amount: toPaisa(body.amount, `${label} amount`, { min: 0.01 }),
    reference: text(body.reference, `${label} reference`, { max: 100 })
  };
}

function dueDate(value, field = 'Due date') {
  if (value === '' || value === undefined || value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw badRequest(`${field} must look like 2026-09-28.`);
  return String(value);
}

module.exports = { nowIso, localDayStart, dateRange, readPayment, dueDate };
