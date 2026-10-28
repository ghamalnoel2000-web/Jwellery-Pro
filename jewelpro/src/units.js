'use strict';
const { badRequest } = require('./errors');

// Money is stored as whole paisa (Rs 1 = 100 paisa) and weight as whole milligrams,
// so totals never suffer from floating-point rounding.

function shift(value, places) {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) return Math.round(value * 10 ** places);
  return Math.round(Number(`${text}e${places}`));
}

function toNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, allowEmpty = true } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (allowEmpty) return 0;
    throw badRequest(`${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`);
  if (n < min) throw badRequest(`${field} cannot be less than ${min}.`);
  if (n > max) throw badRequest(`${field} cannot be more than ${max}.`);
  return n;
}

/** Rupees (number or text) to paisa. */
function toPaisa(value, field = 'Amount', options) {
  return shift(toNumber(value, field, options), 2);
}

/** Grams (number or text) to milligrams. */
function toMg(value, field = 'Weight', options) {
  return shift(toNumber(value, field, options), 3);
}

/** Optional text field, trimmed; returns null when empty. */
function text(value, field, { max = 200, required = false } = {}) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (!s) {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters.`);
  return s;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function id(value, field = 'Id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${field} is not valid.`);
  return n;
}

module.exports = { toNumber, toPaisa, toMg, text, oneOf, id };
