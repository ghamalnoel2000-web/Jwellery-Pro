'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allocate, priceLine, priceExchange, priceBill } = require('../src/billing');
const { toPaisa, toMg } = require('../src/units');

const product = (overrides = {}) => ({
  gross_mg: 10500, stone_mg: 500, other_less_mg: 0, stone_paisa: 300000, other_paisa: 0,
  making_override: null, wastage_override: null, fixed_price_paisa: null, ...overrides
});

const profile = (overrides = {}) => ({
  basis: 'net_wastage', wastage_mode: 'percent', wastage_value: 5,
  making_mode: 'per_gram', making_value: 800, making_weight: 'net', min_making_paisa: 0, ...overrides
});

test('units convert without floating point errors', () => {
  assert.equal(toPaisa('1.005'), 101);
  assert.equal(toPaisa(0.1 + 0.2), 30);
  assert.equal(toPaisa('157500'), 15750000);
  assert.equal(toMg('10.5'), 10500);
  assert.equal(toMg('0.001'), 1);
  assert.throws(() => toPaisa('abc'), /must be a number/);
  assert.throws(() => toPaisa(-1), /cannot be less than 0/);
});

test('allocate always adds up exactly', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  assert.deepEqual(allocate(7, [0, 10]), [0, 7]);
  const parts = allocate(99999, [123, 4567, 89, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 99999);
});

test('worked example from the design document', () => {
  // 22K ring, gross 10.500 g, stones 0.500 g, wastage 5% of net, basis net + wastage, rate Rs 15,000/g, making Rs 800/g
  const line = priceLine(product(), profile(), 1500000);
  assert.equal(line.net_mg, 10000);
  assert.equal(line.wastage_mg, 500);
  assert.equal(line.chargeable_mg, 10500);
  assert.equal(line.metal, 15750000);   // Rs 157,500.00
  assert.equal(line.making, 800000);    // Rs 8,000.00
  assert.equal(line.stones, 300000);    // Rs 3,000.00
});

test('metal value basis options', () => {
  const rate = 1000000; // Rs 10,000 per gram
  assert.equal(priceLine(product(), profile({ basis: 'net' }), rate).metal, 10000000);
  assert.equal(priceLine(product(), profile({ basis: 'net_wastage' }), rate).metal, 10500000);
  assert.equal(priceLine(product(), profile({ basis: 'gross' }), rate).metal, 10500000);
});

test('wastage options', () => {
  const rate = 1000000;
  const grams = priceLine(product(), profile({ wastage_mode: 'grams', wastage_value: 0.25 }), rate);
  assert.equal(grams.wastage_mg, 250);
  assert.equal(grams.chargeable_mg, 10250);
  const none = priceLine(product(), profile({ wastage_mode: 'none' }), rate);
  assert.equal(none.wastage_mg, 0);
  const override = priceLine(product({ wastage_override: 10 }), profile(), rate);
  assert.equal(override.wastage_mg, 1000);
});

test('making charge options', () => {
  const rate = 1000000; // metal on net+wastage = Rs 105,000
  assert.equal(priceLine(product(), profile({ making_mode: 'percent', making_value: 10 }), rate).making, 1050000);
  assert.equal(priceLine(product(), profile({ making_mode: 'fixed', making_value: 2500 }), rate).making, 250000);
  assert.equal(priceLine(product(), profile({ making_mode: 'none' }), rate).making, 0);
  assert.equal(priceLine(product(), profile({ making_weight: 'gross' }), rate).making, 840000);
  assert.equal(priceLine(product(), profile({ making_value: 10, min_making_paisa: 50000 }), rate).making, 50000);
  assert.equal(priceLine(product({ making_override: 1000 }), profile(), rate).making, 1000000);
});

test('fixed price items ignore rate and charges', () => {
  const line = priceLine(product({ fixed_price_paisa: 4500000 }), profile(), 0);
  assert.equal(line.metal, 4500000);
  assert.equal(line.making + line.stones + line.other, 0);
});

test('rate entered per tola gives the exact tola price', () => {
  const perGram = 15000000 / 11.664; // Rs 150,000 per tola
  const line = priceLine(product({ gross_mg: 11664, stone_mg: 0, stone_paisa: 0 }),
    profile({ basis: 'net', wastage_mode: 'none', making_mode: 'none' }), perGram);
  assert.equal(line.metal, 15000000);
});

test('old gold exchange valuation', () => {
  const x = priceExchange({ gross_mg: 10000, less_mg: 0, purity: 0.916, refining_percent: 5, rate_per_gram: 1400000 });
  assert.equal(x.net_mg, 10000);
  assert.equal(x.fine_mg, 9160);
  assert.equal(x.amount, 13300000); // 9.5 g x Rs 14,000
});

test('bill totals with discount, tax, exchange and rounding', () => {
  const lines = [
    { metal: 1000000, making: 100000, stones: 0, other: 0 },
    { metal: 500000, making: 50000, stones: 20000, other: 5000 }
  ];
  const taxRules = [{ name: 'Tax A', rate_percent: 10, applies_to: 'making' }];
  const bill = priceBill({ lines, discountPaisa: 16750, exchangeAmounts: [100050], taxRules, roundToPaisa: 100 });
  assert.equal(bill.subtotal, 1675000);
  assert.equal(bill.discount, 16750);
  assert.equal(bill.lines[0].discount + bill.lines[1].discount, 16750);
  assert.equal(bill.taxable, 1658250);
  assert.equal(bill.tax, bill.lines.reduce((a, l) => a + l.tax, 0));
  assert.equal(bill.grandTotal, bill.taxable + bill.tax);
  assert.equal(bill.netPayable % 100, 0);
  assert.equal(bill.netPayable, bill.grandTotal - bill.exchange + bill.roundOff);
  assert.ok(Math.abs(bill.roundOff) <= 50);
});

test('tax on total, and no tax when no rules are set', () => {
  const lines = [{ metal: 1000000, making: 0, stones: 0, other: 0 }];
  assert.equal(priceBill({ lines, discountPaisa: 0, exchangeAmounts: [], taxRules: [], roundToPaisa: 0 }).tax, 0);
  const taxed = priceBill({ lines, discountPaisa: 0, exchangeAmounts: [], taxRules: [{ name: 'T', rate_percent: 2, applies_to: 'total' }], roundToPaisa: 0 });
  assert.equal(taxed.tax, 20000);
});

test('bill rules are enforced', () => {
  const lines = [{ metal: 100000, making: 0, stones: 0, other: 0 }];
  assert.throws(() => priceBill({ lines, discountPaisa: 200000, exchangeAmounts: [], taxRules: [], roundToPaisa: 0 }), /Discount cannot be more/);
  assert.throws(() => priceBill({ lines, discountPaisa: 0, exchangeAmounts: [200000], taxRules: [], roundToPaisa: 0 }), /old gold value is more/);
});
