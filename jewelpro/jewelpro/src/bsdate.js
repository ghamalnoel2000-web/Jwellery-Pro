/*
 * Bikram Sambat (BS) <-> AD date conversion. Used by both the server and the browser.
 *
 * BS month lengths are set each year by Nepal's calendar committee and cannot be calculated.
 * Years 2000-2083 were cross-checked day by day against three independent open-source libraries
 * (nepali-date-converter, bikram-sambat, nepali-datetime) and all three agree.
 * Years after VERIFIED_UNTIL are provisional (the libraries disagree); the owner can confirm or
 * correct them from the official patro in Settings, and those corrections override this table.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BSDate = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const FIRST_YEAR = 2000;
  const BASE_AD_UTC = Date.UTC(1943, 3, 14); // 2000 Baisakh 1 BS = 14 April 1943 AD
  const VERIFIED_UNTIL = 2083;

  const MONTHS = ['Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Asoj',
    'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
  const MONTHS_NE = ['बैशाख', 'जेठ', 'असार', 'साउन', 'भदौ', 'असोज',
    'कात्तिक', 'मंसिर', 'पुस', 'माघ', 'फागुन', 'चैत'];

  const BUILT_IN = {
    2000: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2001: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2002: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2003: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2004: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2005: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2006: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2007: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2008: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 29, 31],
    2009: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2010: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2011: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2012: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30],
    2013: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2014: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2015: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2016: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30],
    2017: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2018: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2019: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2020: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
    2021: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2022: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
    2023: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2024: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
    2025: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2026: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2027: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2028: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2029: [31, 31, 32, 31, 32, 30, 30, 29, 30, 29, 30, 30],
    2030: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2031: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2032: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2033: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2034: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2035: [30, 32, 31, 32, 31, 31, 29, 30, 30, 29, 29, 31],
    2036: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2037: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2038: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2039: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30],
    2040: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2041: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2042: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2043: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30],
    2044: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2045: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2046: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2047: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
    2048: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2049: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
    2050: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2051: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
    2052: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2053: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
    2054: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2055: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2056: [31, 31, 32, 31, 32, 30, 30, 29, 30, 29, 30, 30],
    2057: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2058: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2059: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2060: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2061: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2062: [30, 32, 31, 32, 31, 31, 29, 30, 29, 30, 29, 31],
    2063: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2064: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2065: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2066: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 29, 31],
    2067: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2068: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2069: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2070: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30],
    2071: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2072: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30],
    2073: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2074: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
    2075: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2076: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
    2077: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2078: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
    2079: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
    2081: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2083: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2084: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2085: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2086: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2087: [31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30],
    2088: [30, 31, 32, 32, 30, 31, 30, 30, 29, 30, 30, 30],
    2089: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30],
    2090: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30]
  };

  /** Checks a list of 12 month lengths; returns an error message or null. */
  function monthDaysProblem(days) {
    if (!Array.isArray(days) || days.length !== 12) return 'Enter the number of days for all 12 months.';
    if (days.some((d) => !Number.isInteger(d) || d < 29 || d > 32)) return 'Each month must have 29, 30, 31 or 32 days.';
    const total = days.reduce((a, b) => a + b, 0);
    if (total < 364 || total > 367) return `The months add up to ${total} days; a BS year has 365 or 366.`;
    return null;
  }

  /**
   * Builds a calendar from the built-in table plus the owner's confirmed years.
   * overrides: { 2084: [31, 32, ...], ... }
   */
  function createCalendar(overrides) {
    const confirmed = {};
    for (const [year, days] of Object.entries(overrides || {})) {
      if (!monthDaysProblem(days)) confirmed[Number(year)] = days;
    }
    const table = [];
    for (let y = FIRST_YEAR; ; y += 1) {
      const days = confirmed[y] || BUILT_IN[y];
      if (!days) break;
      table.push(days);
    }
    const lastYear = FIRST_YEAR + table.length - 1;
    const yearStart = [0];
    for (const days of table) yearStart.push(yearStart[yearStart.length - 1] + days.reduce((a, b) => a + b, 0));

    function daysInMonth(year, month) {
      const row = table[year - FIRST_YEAR];
      return row ? row[month - 1] : 0;
    }

    function isValid(year, month, day) {
      return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
        && year >= FIRST_YEAR && year <= lastYear && month >= 1 && month <= 12
        && day >= 1 && day <= daysInMonth(year, month);
    }

    /** AD calendar date (month 1-12) to BS, or null when outside the known years. */
    function toBs(year, month, day) {
      let offset = Math.round((Date.UTC(year, month - 1, day) - BASE_AD_UTC) / DAY_MS);
      if (offset < 0 || offset >= yearStart[yearStart.length - 1]) return null;
      let index = 0;
      while (yearStart[index + 1] <= offset) index += 1;
      offset -= yearStart[index];
      const row = table[index];
      let m = 0;
      while (offset >= row[m]) { offset -= row[m]; m += 1; }
      return { year: FIRST_YEAR + index, month: m + 1, day: offset + 1 };
    }

    /** BS date to AD calendar date (month 1-12), or null when the BS date does not exist. */
    function toAd(year, month, day) {
      if (!isValid(year, month, day)) return null;
      let offset = yearStart[year - FIRST_YEAR] + day - 1;
      for (let m = 1; m < month; m += 1) offset += daysInMonth(year, m);
      const d = new Date(BASE_AD_UTC + offset * DAY_MS);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    }

    /** Local JavaScript Date to BS. */
    function fromDate(date) {
      return toBs(date.getFullYear(), date.getMonth() + 1, date.getDate());
    }

    function status(year) {
      if (confirmed[year]) return 'confirmed';
      if (year <= VERIFIED_UNTIL) return 'verified';
      return year <= lastYear ? 'provisional' : 'missing';
    }

    /** Nepal's fiscal year runs from 1 Shrawan to the end of Asar. */
    function fiscalYearOf(bs) {
      const start = bs.month >= 4 ? bs.year : bs.year - 1;
      return { start, label: `${start}/${String((start + 1) % 100).padStart(2, '0')}` };
    }

    return {
      firstYear: FIRST_YEAR, lastYear, daysInMonth, isValid, toBs, toAd, fromDate, status, fiscalYearOf,
      monthDays: (year) => (table[year - FIRST_YEAR] || []).slice()
    };
  }

  return { MONTHS, MONTHS_NE, FIRST_YEAR, VERIFIED_UNTIL, BUILT_IN, monthDaysProblem, createCalendar };
}));
