'use strict';
const { rule } = require('./errors');

/*
 * The billing engine. Pure functions only: no database, no dates.
 * Units: money in paisa (integers), weight in milligrams (integers),
 * rates in paisa per gram (may have decimals), percentages as plain numbers (5 = 5%).
 */

/** Split an integer total across items in proportion to their weights; parts always add up exactly. */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length) {
    parts[order[k]] += 1;
    remainder -= 1;
  }
  return parts;
}

/**
 * Price one tagged piece.
 * product: gross_mg, stone_mg, other_less_mg, stone_paisa, other_paisa,
 *          making_override, wastage_override, fixed_price_paisa
 * profile: basis, wastage_mode, wastage_value, making_mode, making_value, making_weight, min_making_paisa
 */
function priceLine(product, profile, ratePerGram) {
  const grossMg = product.gross_mg;
  const netMg = product.gross_mg - product.stone_mg - product.other_less_mg;

  if (product.fixed_price_paisa !== null && product.fixed_price_paisa !== undefined) {
    return {
      gross_mg: grossMg, stone_mg: product.stone_mg, other_less_mg: product.other_less_mg,
      net_mg: netMg, wastage_mg: 0, chargeable_mg: netMg, rate_per_gram: 0,
      metal: product.fixed_price_paisa, making: 0, stones: 0, other: 0,
      method: 'Fixed price'
    };
  }

  const wastageValue = product.wastage_override ?? profile.wastage_value;
  let wastageMg = 0;
  if (profile.wastage_mode === 'percent') wastageMg = Math.round((netMg * wastageValue) / 100);
  else if (profile.wastage_mode === 'grams') wastageMg = Math.round(wastageValue * 1000);

  let chargeableMg = netMg;
  if (profile.basis === 'net_wastage') chargeableMg = netMg + wastageMg;
  else if (profile.basis === 'gross') chargeableMg = grossMg;

  const metal = Math.round((chargeableMg * ratePerGram) / 1000);

  const makingValue = product.making_override ?? profile.making_value;
  const makingWeightMg = profile.making_weight === 'gross' ? grossMg : netMg;
  let making = 0;
  if (profile.making_mode === 'per_gram') making = Math.round((makingWeightMg * Math.round(makingValue * 100)) / 1000);
  else if (profile.making_mode === 'percent') making = Math.round((metal * makingValue) / 100);
  else if (profile.making_mode === 'fixed') making = Math.round(makingValue * 100);
  if (profile.making_mode !== 'none') making = Math.max(making, profile.min_making_paisa || 0);

  return {
    gross_mg: grossMg, stone_mg: product.stone_mg, other_less_mg: product.other_less_mg,
    net_mg: netMg, wastage_mg: wastageMg, chargeable_mg: chargeableMg, rate_per_gram: ratePerGram,
    metal, making, stones: product.stone_paisa, other: product.other_paisa,
    method: describeProfile(profile, product)
  };
}

function describeProfile(profile, product) {
  const basis = { net: 'net weight', net_wastage: 'net + wastage', gross: 'gross weight' }[profile.basis];
  const wastage = product.wastage_override ?? profile.wastage_value;
  const making = product.making_override ?? profile.making_value;
  const parts = [`Metal on ${basis}`];
  if (profile.wastage_mode === 'percent') parts.push(`wastage ${wastage}%`);
  if (profile.wastage_mode === 'grams') parts.push(`wastage ${wastage} g`);
  if (profile.making_mode === 'per_gram') parts.push(`making Rs ${making}/g`);
  if (profile.making_mode === 'percent') parts.push(`making ${making}%`);
  if (profile.making_mode === 'fixed') parts.push(`making Rs ${making} fixed`);
  return parts.join(', ');
}

/** Value old gold brought in by the customer. */
function priceExchange({ gross_mg, less_mg, purity, refining_percent, rate_per_gram }) {
  const netMg = gross_mg - less_mg;
  const effectiveMg = Math.round(netMg * (1 - refining_percent / 100));
  return {
    net_mg: netMg,
    fine_mg: Math.round(netMg * purity),
    amount: Math.round((effectiveMg * rate_per_gram) / 1000)
  };
}

/**
 * Total a bill.
 * lines: results of priceLine; exchangeAmounts: array of paisa;
 * taxRules: [{ name, rate_percent, applies_to: 'metal'|'making'|'stones'|'total' }]
 */
function priceBill({ lines, discountPaisa, exchangeAmounts, taxRules, roundToPaisa }) {
  const lineAmounts = lines.map((l) => l.metal + l.making + l.stones + l.other);
  const subtotal = lineAmounts.reduce((a, b) => a + b, 0);

  if (discountPaisa < 0) throw rule('Discount cannot be negative.');
  if (discountPaisa > subtotal) throw rule('Discount cannot be more than the bill amount.');

  const lineDiscounts = allocate(discountPaisa, lineAmounts);
  const taxTotals = new Map();

  const pricedLines = lines.map((line, i) => {
    const componentDiscounts = allocate(lineDiscounts[i], [line.metal, line.making, line.stones, line.other]);
    const after = {
      metal: line.metal - componentDiscounts[0],
      making: line.making - componentDiscounts[1],
      stones: line.stones - componentDiscounts[2],
      other: line.other - componentDiscounts[3]
    };
    const taxable = lineAmounts[i] - lineDiscounts[i];
    let tax = 0;
    for (const t of taxRules) {
      const base = t.applies_to === 'total' ? taxable : after[t.applies_to];
      const amount = Math.round((base * t.rate_percent) / 100);
      tax += amount;
      const key = `${t.name} (${t.rate_percent}%)`;
      taxTotals.set(key, (taxTotals.get(key) || 0) + amount);
    }
    return { ...line, amount: lineAmounts[i], discount: lineDiscounts[i], taxable, tax, total: taxable + tax };
  });

  const taxable = subtotal - discountPaisa;
  const tax = pricedLines.reduce((a, l) => a + l.tax, 0);
  const grandTotal = taxable + tax;
  const exchange = exchangeAmounts.reduce((a, b) => a + b, 0);
  const beforeRound = grandTotal - exchange;

  if (beforeRound < 0) {
    throw rule('The old gold value is more than the bill. Reduce the old gold or add more items.');
  }

  const netPayable = roundToPaisa > 0 ? Math.round(beforeRound / roundToPaisa) * roundToPaisa : beforeRound;

  return {
    lines: pricedLines,
    subtotal,
    discount: discountPaisa,
    taxable,
    tax,
    taxSummary: [...taxTotals].map(([name, amount]) => ({ name, amount })),
    grandTotal,
    exchange,
    roundOff: netPayable - beforeRound,
    netPayable
  };
}

module.exports = { allocate, priceLine, priceExchange, priceBill };
