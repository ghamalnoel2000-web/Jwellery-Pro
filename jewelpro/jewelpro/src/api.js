'use strict';
const express = require('express');
const auth = require('./auth');
const sales = require('./sales');
const backup = require('./backup');
const BS = require('./bsdate');
const ledger = require('./ledger');
const { A } = ledger;
const { readProduct, insertProduct } = require('./products');
const stock = require('./stock');
const { registerPurchaseRoutes } = require('./routes/purchases');
const { registerMetalRoutes } = require('./routes/metal');
const { registerKarigarRoutes } = require('./routes/karigars');
const { registerOrderRoutes } = require('./routes/orders');
const { registerAccountingRoutes } = require('./routes/accounting');
const fs = require('node:fs');
const { toPaisa, toMg, toNumber, text, oneOf, id } = require('./units');
const { badRequest, unauthorized, forbidden, notFound, rule } = require('./errors');

const nowIso = () => new Date().toISOString();

/** Converts a local calendar date (YYYY-MM-DD) to the UTC instant of its start. */
function localDayStart(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) throw badRequest('Dates must look like 2026-09-26.');
  const [y, m, d] = dateText.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function dateRange(query) {
  const today = new Date();
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const from = localDayStart(query.from || todayText);
  const to = localDayStart(query.to || todayText);
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  if (end <= from) throw badRequest('The "to" date must be on or after the "from" date.');
  return { fromIso: from.toISOString(), toIso: end.toISOString() };
}

function perGramFromEntered(paisa, unit, gramsPerTola) {
  if (unit === 'gram') return paisa;
  if (unit === '10g') return paisa / 10;
  if (unit === 'tola') return paisa / gramsPerTola;
  throw badRequest('Rate unit must be gram, 10g or tola.');
}

function createApiRouter(store) {
  const r = express.Router();
  const { requireLogin, requirePermission: perm } = auth;
  const limiter = auth.loginRateLimiter();

  // Changes must come from the JewelPro page itself (blocks cross-site form posts).
  r.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-JewelPro') !== '1') {
      return next(forbidden('Request blocked.'));
    }
    next();
  });

  // ---------------------------------------------------------------- Auth

  const publicUser = (u) => ({
    id: u.id, username: u.username, full_name: u.full_name, role: u.role,
    must_change_password: !!u.must_change_password, permissions: auth.permissionsFor(u.role)
  });

  r.get('/auth/status', (req, res) => {
    const needsSetup = store.get('SELECT COUNT(*) AS n FROM users').n === 0;
    res.json({
      needs_setup: needsSetup,
      user: req.user ? publicUser(req.user) : null,
      shop_name: store.setting('shop_name')
    });
  });

  r.post('/auth/setup', limiter, (req, res) => {
    const userId = store.tx(() => {
      if (store.get('SELECT COUNT(*) AS n FROM users').n > 0) throw forbidden('Setup is already complete.');
      const username = text(req.body.username, 'Username', { max: 50, required: true });
      const fullName = text(req.body.full_name, 'Full name', { max: 100, required: true });
      const problem = auth.passwordProblem(req.body.password, username);
      if (problem) throw badRequest(problem);
      const newId = store.run(
        "INSERT INTO users (username, full_name, role, password_hash, created_at) VALUES (?, ?, 'owner', ?, ?)",
        username, fullName, auth.hashPassword(req.body.password), nowIso()
      ).lastInsertRowid;
      store.audit({ id: newId, username }, 'create', 'user', newId, { username, role: 'owner', note: 'First owner account' });
      return newId;
    });
    const session = auth.createSession(store, userId);
    auth.setSessionCookie(res, session.token, session.expires);
    res.status(201).json({ user: publicUser(store.get('SELECT * FROM users WHERE id = ?', userId)) });
  });

  r.post('/auth/login', limiter, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const now = new Date();
    const record = (userId, success, reason) => store.run(
      'INSERT INTO login_history (username, user_id, success, reason, ip, at) VALUES (?, ?, ?, ?, ?, ?)',
      username.slice(0, 50), userId, success ? 1 : 0, reason, req.ip, now.toISOString()
    );
    const invalid = 'Wrong username or password.';

    const user = username ? store.get('SELECT * FROM users WHERE username = ?', username) : null;
    if (!user) { record(null, false, 'Unknown username'); throw unauthorized(invalid); }
    if (!user.is_active) { record(user.id, false, 'Account inactive'); throw unauthorized(invalid); }
    if (user.locked_until && new Date(user.locked_until) > now) {
      record(user.id, false, 'Account locked');
      const minutes = Math.ceil((new Date(user.locked_until) - now) / 60000);
      throw unauthorized(`This account is locked after too many wrong passwords. Try again in ${minutes} minute(s).`);
    }
    if (!auth.verifyPassword(password, user.password_hash)) {
      const failed = user.failed_count + 1;
      if (failed >= auth.MAX_FAILED_LOGINS) {
        const until = new Date(now.getTime() + auth.LOCKOUT_MINUTES * 60000).toISOString();
        store.run('UPDATE users SET failed_count = 0, locked_until = ? WHERE id = ?', until, user.id);
      } else {
        store.run('UPDATE users SET failed_count = ? WHERE id = ?', failed, user.id);
      }
      record(user.id, false, 'Wrong password');
      throw unauthorized(invalid);
    }
    store.run('UPDATE users SET failed_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now.toISOString(), user.id);
    record(user.id, true, null);
    const session = auth.createSession(store, user.id);
    auth.setSessionCookie(res, session.token, session.expires);
    res.json({ user: publicUser(user) });
  });

  r.post('/auth/logout', (req, res) => {
    if (req.sessionToken) store.run('DELETE FROM sessions WHERE token_hash = ?', auth.hashToken(req.sessionToken));
    auth.clearSessionCookie(res);
    res.status(204).end();
  });

  r.post('/auth/change-password', (req, res) => {
    if (!req.user) throw unauthorized('Please log in.');
    const user = store.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!auth.verifyPassword(req.body.current_password, user.password_hash)) throw rule('The current password is wrong.');
    const problem = auth.passwordProblem(req.body.new_password, user.username);
    if (problem) throw rule(problem);
    if (auth.verifyPassword(req.body.new_password, user.password_hash)) throw rule('Choose a password different from the current one.');
    store.tx(() => {
      store.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', auth.hashPassword(req.body.new_password), user.id);
      store.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      store.audit(req.user, 'change_password', 'user', user.id);
    });
    const session = auth.createSession(store, user.id);
    auth.setSessionCookie(res, session.token, session.expires);
    res.json({ user: publicUser(store.get('SELECT * FROM users WHERE id = ?', user.id)) });
  });

  // Everything below needs a logged-in user.
  r.use(requireLogin);

  // ---------------------------------------------------------------- Settings

  const SETTING_KEYS = Object.keys(require('./db').DEFAULT_SETTINGS);

  r.get('/settings', (req, res) => {
    const all = store.getSettings();
    if (auth.can(req.user, 'settings.view')) return res.json(all);
    // Everyone needs the shop details to print invoices.
    const pick = ['shop_name', 'shop_address', 'shop_phone', 'shop_pan', 'vat_registered', 'vat_number',
      'invoice_title', 'invoice_footer', 'invoice_terms', 'grams_per_tola', 'rate_entry_unit', 'cashier_max_discount_percent',
      'date_display', 'whatsapp_country_code', 'books_locked_until', 'invoice_numbering'];
    res.json(Object.fromEntries(pick.map((k) => [k, all[k]])));
  });

  r.put('/settings', perm('settings.manage'), (req, res) => {
    const changes = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!SETTING_KEYS.includes(key)) continue;
      let clean = value === null || value === undefined ? '' : String(value).trim();
      if (clean.length > 500) throw badRequest(`${key} is too long.`);
      if (key === 'grams_per_tola') clean = String(toNumber(clean, 'Grams per tola', { min: 1, max: 100, allowEmpty: false }));
      if (key === 'round_to_rupees') clean = String(toNumber(clean, 'Round to', { max: 1000 }));
      if (key === 'cashier_max_discount_percent') clean = String(toNumber(clean, 'Cashier discount limit', { max: 100 }));
      if (key === 'backup_keep_count') clean = String(toNumber(clean, 'Backups to keep', { min: 1, max: 365 }));
      if (key === 'rate_entry_unit') oneOf(clean, 'Rate unit', ['tola', '10g', 'gram']);
      if (key === 'date_display') oneOf(clean, 'Date display', ['both', 'bs', 'ad']);
      if (key === 'invoice_numbering') oneOf(clean, 'Invoice numbering', ['continuous', 'fiscal_year']);
      if (key === 'whatsapp_country_code' && !/^\d{1,4}$/.test(clean)) throw badRequest('WhatsApp country code must be digits, e.g. 977.');
      if (key === 'books_locked_until' && clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw badRequest('Lock date must look like 2026-09-28.');
      if (key === 'books_locked_until' && clean && clean >= ledger.localDateText(nowIso())) throw badRequest('Books can only be locked up to yesterday.');
      if (key === 'backup_copy_dir' && clean) {
        try {
          fs.accessSync(clean, fs.constants.W_OK);
          if (!fs.statSync(clean).isDirectory()) throw new Error('not a folder');
        } catch {
          throw badRequest(`JewelPro cannot write to the folder "${clean}". Check that it exists on the shop computer.`);
        }
      }
      if (key === 'vat_registered') clean = clean === 'true' ? 'true' : 'false';
      if (store.setting(key) !== clean) changes[key] = clean;
    }
    store.tx(() => {
      for (const [key, value] of Object.entries(changes)) {
        store.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
      }
      if (Object.keys(changes).length) store.audit(req.user, 'update', 'settings', null, changes);
    });
    res.json(store.getSettings());
  });

  // Nepali calendar: built-in month lengths plus the owner's confirmed years
  const calendarOverrides = () => Object.fromEntries(
    store.all('SELECT year, month_days FROM bs_calendar_overrides ORDER BY year').map((row) => [row.year, JSON.parse(row.month_days)]));

  r.get('/calendar', (req, res) => {
    res.json({
      verified_until: BS.VERIFIED_UNTIL,
      overrides: calendarOverrides(),
      notes: store.all(
        `SELECT o.year, o.note, o.updated_at, u.full_name AS updated_by_name
         FROM bs_calendar_overrides o LEFT JOIN users u ON u.id = o.updated_by ORDER BY o.year`)
    });
  });

  r.put('/calendar/:year', perm('settings.manage'), (req, res) => {
    const year = id(req.params.year, 'Year');
    const days = (Array.isArray(req.body.month_days) ? req.body.month_days : []).map(Number);
    const problem = BS.monthDaysProblem(days);
    if (problem) throw badRequest(problem);
    const note = text(req.body.note, 'Note', { max: 200 });
    store.tx(() => {
      const calendar = BS.createCalendar(calendarOverrides());
      if (year <= BS.VERIFIED_UNTIL) throw rule(`${year} is already verified and cannot be changed.`);
      if (year > calendar.lastYear + 1) throw rule(`Enter ${calendar.lastYear + 1} first; years must follow each other.`);
      const before = calendar.monthDays(year);
      store.run(
        `INSERT INTO bs_calendar_overrides (year, month_days, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(year) DO UPDATE SET month_days = excluded.month_days, note = excluded.note,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        year, JSON.stringify(days), note, nowIso(), req.user.id
      );
      store.audit(req.user, 'update', 'bs_calendar', year, { before, after: days, note });
    });
    res.json({ ok: true });
  });

  r.delete('/calendar/:year', perm('settings.manage'), (req, res) => {
    const year = id(req.params.year, 'Year');
    store.tx(() => {
      const row = store.get('SELECT * FROM bs_calendar_overrides WHERE year = ?', year);
      if (!row) throw notFound('That year has no correction.');
      if (!BS.BUILT_IN[year] && store.get('SELECT year FROM bs_calendar_overrides WHERE year > ?', year)) {
        throw rule('Remove the later years first.');
      }
      store.run('DELETE FROM bs_calendar_overrides WHERE year = ?', year);
      store.audit(req.user, 'delete', 'bs_calendar', year, { removed: JSON.parse(row.month_days) });
    });
    res.json({ ok: true });
  });

  // Tax rules
  r.get('/tax-rules', (req, res) => res.json(store.all('SELECT * FROM tax_rules ORDER BY id')));

  const readTax = (body) => ({
    name: text(body.name, 'Tax name', { max: 60, required: true }),
    rate_percent: toNumber(body.rate_percent, 'Tax rate', { max: 100, allowEmpty: false }),
    applies_to: oneOf(body.applies_to, 'Applies to', ['metal', 'making', 'stones', 'total']),
    is_active: body.is_active === false || body.is_active === 0 || body.is_active === 'false' ? 0 : 1,
    verified_note: text(body.verified_note, 'Verified note', { max: 200 })
  });

  r.post('/tax-rules', perm('settings.manage'), (req, res) => {
    const t = readTax(req.body);
    const newId = store.tx(() => {
      const rowId = store.run(
        'INSERT INTO tax_rules (name, rate_percent, applies_to, is_active, verified_note) VALUES (?, ?, ?, ?, ?)',
        t.name, t.rate_percent, t.applies_to, t.is_active, t.verified_note
      ).lastInsertRowid;
      store.audit(req.user, 'create', 'tax_rule', rowId, t);
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM tax_rules WHERE id = ?', newId));
  });

  r.put('/tax-rules/:id', perm('settings.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const t = readTax(req.body);
    store.tx(() => {
      const old = store.get('SELECT * FROM tax_rules WHERE id = ?', rowId);
      if (!old) throw notFound('Tax rule not found.');
      store.run(
        'UPDATE tax_rules SET name = ?, rate_percent = ?, applies_to = ?, is_active = ?, verified_note = ? WHERE id = ?',
        t.name, t.rate_percent, t.applies_to, t.is_active, t.verified_note, rowId
      );
      store.audit(req.user, 'update', 'tax_rule', rowId, { before: old, after: t });
    });
    res.json(store.get('SELECT * FROM tax_rules WHERE id = ?', rowId));
  });

  // Charge profiles
  r.get('/charge-profiles', (req, res) => res.json(store.all('SELECT * FROM charge_profiles ORDER BY name')));

  const readProfile = (body) => ({
    name: text(body.name, 'Profile name', { max: 60, required: true }),
    basis: oneOf(body.basis, 'Metal value basis', ['net', 'net_wastage', 'gross']),
    wastage_mode: oneOf(body.wastage_mode, 'Wastage type', ['none', 'percent', 'grams']),
    wastage_value: toNumber(body.wastage_value, 'Wastage', { max: 1000 }),
    making_mode: oneOf(body.making_mode, 'Making charge type', ['none', 'per_gram', 'percent', 'fixed']),
    making_value: toNumber(body.making_value, 'Making charge', { max: 10_000_000 }),
    making_weight: oneOf(body.making_weight || 'net', 'Making charge weight', ['net', 'gross']),
    min_making_paisa: toPaisa(body.min_making, 'Minimum making charge'),
    is_active: body.is_active === false || body.is_active === 'false' ? 0 : 1
  });

  r.post('/charge-profiles', perm('settings.manage'), (req, res) => {
    const p = readProfile(req.body);
    const newId = store.tx(() => {
      const rowId = store.run(
        `INSERT INTO charge_profiles (name, basis, wastage_mode, wastage_value, making_mode, making_value, making_weight, min_making_paisa, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.name, p.basis, p.wastage_mode, p.wastage_value, p.making_mode, p.making_value, p.making_weight, p.min_making_paisa, p.is_active
      ).lastInsertRowid;
      store.audit(req.user, 'create', 'charge_profile', rowId, p);
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM charge_profiles WHERE id = ?', newId));
  });

  r.put('/charge-profiles/:id', perm('settings.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const p = readProfile(req.body);
    store.tx(() => {
      const old = store.get('SELECT * FROM charge_profiles WHERE id = ?', rowId);
      if (!old) throw notFound('Charge profile not found.');
      store.run(
        `UPDATE charge_profiles SET name = ?, basis = ?, wastage_mode = ?, wastage_value = ?, making_mode = ?, making_value = ?,
           making_weight = ?, min_making_paisa = ?, is_active = ? WHERE id = ?`,
        p.name, p.basis, p.wastage_mode, p.wastage_value, p.making_mode, p.making_value, p.making_weight, p.min_making_paisa, p.is_active, rowId
      );
      store.audit(req.user, 'update', 'charge_profile', rowId, { before: old, after: p });
    });
    res.json(store.get('SELECT * FROM charge_profiles WHERE id = ?', rowId));
  });

  // Categories
  r.get('/categories', (req, res) => res.json(store.all(
    `SELECT c.*, cp.name AS charge_profile_name,
            (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'in_stock' AND (? OR p.is_private = 0)) AS in_stock
     FROM categories c LEFT JOIN charge_profiles cp ON cp.id = c.charge_profile_id ORDER BY c.name`, seesPrivate(req.user) ? 1 : 0
  )));

  /** A free code prefix made from the name, e.g. "Mangalsutra" -> "MA", "MAN", "MA1". */
  const suggestPrefix = (name) => {
    const letters = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'IT';
    const tries = [letters.slice(0, 2), letters.slice(0, 3), letters.slice(0, 4)];
    for (let n = 1; n < 100; n += 1) tries.push(`${letters.slice(0, 2)}${n}`);
    return tries.find((p) => p.length >= 2 && !store.get('SELECT id FROM categories WHERE prefix = ?', p)) || `C${Date.now() % 1000}`;
  };

  const readCategory = (body) => {
    const name = text(body.name, 'Category name', { max: 60, required: true });
    const prefix = (text(body.prefix, 'Code prefix', { max: 4 }) || suggestPrefix(name)).toUpperCase();
    if (!/^[A-Z0-9]{1,4}$/.test(prefix)) throw badRequest('Code prefix must be 1 to 4 letters or numbers.');
    return { name, prefix, charge_profile_id: body.charge_profile_id ? id(body.charge_profile_id, 'Charge profile') : null };
  };

  const checkCategoryUnique = (c, exceptId = 0) => {
    const byName = store.get('SELECT name FROM categories WHERE name = ? AND id <> ?', c.name, exceptId);
    if (byName) throw rule(`There is already a category called ${byName.name}.`);
    const byPrefix = store.get('SELECT name FROM categories WHERE prefix = ? AND id <> ?', c.prefix, exceptId);
    if (byPrefix) throw rule(`Code prefix ${c.prefix} is already used by ${byPrefix.name}.`);
  };

  // Staff can add and rename categories. Only the owner chooses how a category is priced.
  r.post('/categories', perm('categories.manage'), (req, res) => {
    const owner = auth.can(req.user, 'settings.manage');
    const c = readCategory(owner ? req.body : { name: req.body.name });
    if (!owner) c.charge_profile_id = null;
    const newId = store.tx(() => {
      checkCategoryUnique(c);
      const rowId = store.run('INSERT INTO categories (name, prefix, charge_profile_id) VALUES (?, ?, ?)', c.name, c.prefix, c.charge_profile_id).lastInsertRowid;
      store.audit(req.user, 'create', 'category', rowId, c);
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM categories WHERE id = ?', newId));
  });

  r.put('/categories/:id', perm('categories.manage'), (req, res) => {
    const rowId = id(req.params.id);
    store.tx(() => {
      const old = store.get('SELECT * FROM categories WHERE id = ?', rowId);
      if (!old) throw notFound('Category not found.');
      const owner = auth.can(req.user, 'settings.manage');
      // Staff can only rename. Item codes already printed on tags never change.
      const c = readCategory(owner ? { prefix: old.prefix, ...req.body } : { name: (req.body || {}).name, prefix: old.prefix });
      if (!owner) c.charge_profile_id = old.charge_profile_id;
      else if (!('charge_profile_id' in (req.body || {}))) c.charge_profile_id = old.charge_profile_id;
      checkCategoryUnique(c, rowId);
      // Item codes already printed on tags keep their old prefix; only new items use a changed prefix.
      store.run('UPDATE categories SET name = ?, prefix = ?, charge_profile_id = ? WHERE id = ?', c.name, c.prefix, c.charge_profile_id, rowId);
      store.audit(req.user, 'update', 'category', rowId, { before: old, after: c });
    });
    res.json(store.get('SELECT * FROM categories WHERE id = ?', rowId));
  });

  // Metals and purities
  r.get('/purities', (req, res) => res.json(store.all(
    `SELECT pu.*, m.name AS metal_name, m.code AS metal_code
     FROM purities pu JOIN metals m ON m.id = pu.metal_id ORDER BY pu.sort_order, pu.id`
  )));

  r.get('/metals', (req, res) => res.json(store.all('SELECT * FROM metals ORDER BY id')));

  const readPurity = (body) => ({
    metal_id: id(body.metal_id, 'Metal'),
    name: text(body.name, 'Purity name', { max: 30, required: true }),
    purity: toNumber(body.purity, 'Purity', { min: 0.001, max: 1, allowEmpty: false }),
    sort_order: Math.round(toNumber(body.sort_order, 'Order', { max: 1000 })),
    is_active: body.is_active === false || body.is_active === 'false' ? 0 : 1
  });

  r.post('/purities', perm('settings.manage'), (req, res) => {
    const p = readPurity(req.body);
    const newId = store.tx(() => {
      const rowId = store.run('INSERT INTO purities (metal_id, name, purity, sort_order, is_active) VALUES (?, ?, ?, ?, ?)',
        p.metal_id, p.name, p.purity, p.sort_order, p.is_active).lastInsertRowid;
      store.audit(req.user, 'create', 'purity', rowId, p);
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM purities WHERE id = ?', newId));
  });

  r.put('/purities/:id', perm('settings.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const p = readPurity(req.body);
    store.tx(() => {
      const old = store.get('SELECT * FROM purities WHERE id = ?', rowId);
      if (!old) throw notFound('Purity not found.');
      store.run('UPDATE purities SET metal_id = ?, name = ?, purity = ?, sort_order = ?, is_active = ? WHERE id = ?',
        p.metal_id, p.name, p.purity, p.sort_order, p.is_active, rowId);
      store.audit(req.user, 'update', 'purity', rowId, { before: old, after: p });
    });
    res.json(store.get('SELECT * FROM purities WHERE id = ?', rowId));
  });

  // ---------------------------------------------------------------- Rates

  r.get('/rates', perm('rates.view'), (req, res) => {
    res.json({
      grams_per_tola: Number(store.setting('grams_per_tola')),
      unit: store.setting('rate_entry_unit'),
      rates: store.all(
        `SELECT pu.id AS purity_id, pu.name AS purity_name, pu.purity, m.name AS metal_name,
                r.sell_per_gram, r.buy_per_gram, r.entered_unit, r.entered_sell_paisa, r.entered_buy_paisa,
                r.updated_at, u.full_name AS updated_by_name
         FROM purities pu JOIN metals m ON m.id = pu.metal_id
         LEFT JOIN rates r ON r.purity_id = pu.id LEFT JOIN users u ON u.id = r.updated_by
         WHERE pu.is_active = 1 ORDER BY pu.sort_order, pu.id`
      )
    });
  });

  r.put('/rates', perm('rates.update'), (req, res) => {
    const unit = oneOf(req.body.unit, 'Rate unit', ['tola', '10g', 'gram']);
    const gramsPerTola = Number(store.setting('grams_per_tola'));
    const rows = Array.isArray(req.body.rates) ? req.body.rates : [];
    if (rows.length === 0) throw badRequest('Enter at least one rate.');
    const now = nowIso();
    store.tx(() => {
      for (const row of rows) {
        const purityId = id(row.purity_id, 'Purity');
        const purity = store.get('SELECT pu.name, m.name AS metal_name FROM purities pu JOIN metals m ON m.id = pu.metal_id WHERE pu.id = ?', purityId);
        if (!purity) throw badRequest('Unknown purity.');
        const label = `${purity.metal_name} ${purity.name}`;
        const sell = toPaisa(row.sell, `${label} selling rate`);
        const buy = toPaisa(row.buy, `${label} buying rate`);
        const sellPerGram = perGramFromEntered(sell, unit, gramsPerTola);
        const buyPerGram = perGramFromEntered(buy, unit, gramsPerTola);
        const old = store.get('SELECT * FROM rates WHERE purity_id = ?', purityId);
        if (old && old.entered_unit === unit && old.entered_sell_paisa === sell && old.entered_buy_paisa === buy) continue;
        store.run(
          `INSERT INTO rates (purity_id, sell_per_gram, buy_per_gram, entered_unit, entered_sell_paisa, entered_buy_paisa, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(purity_id) DO UPDATE SET sell_per_gram = excluded.sell_per_gram, buy_per_gram = excluded.buy_per_gram,
             entered_unit = excluded.entered_unit, entered_sell_paisa = excluded.entered_sell_paisa,
             entered_buy_paisa = excluded.entered_buy_paisa, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          purityId, sellPerGram, buyPerGram, unit, sell, buy, now, req.user.id
        );
        store.run(
          `INSERT INTO rate_history (purity_id, sell_per_gram, buy_per_gram, entered_unit, entered_sell_paisa, entered_buy_paisa, changed_at, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          purityId, sellPerGram, buyPerGram, unit, sell, buy, now, req.user.id
        );
        store.audit(req.user, 'update', 'rate', purityId, { purity: label, unit, sell, buy, before: old || null });
      }
    });
    res.json({ ok: true });
  });

  r.get('/rates/history', perm('rates.view'), (req, res) => {
    res.json(store.all(
      `SELECT h.*, pu.name AS purity_name, m.name AS metal_name, u.full_name AS changed_by_name
       FROM rate_history h JOIN purities pu ON pu.id = h.purity_id JOIN metals m ON m.id = pu.metal_id
       LEFT JOIN users u ON u.id = h.changed_by ORDER BY h.id DESC LIMIT 200`
    ));
  });

  // ---------------------------------------------------------------- Products

  const PRODUCT_SELECT = `
    SELECT p.*, c.name AS category_name, pu.name AS purity_name, pu.purity AS purity_value, m.name AS metal_name,
           cp.name AS charge_profile_name
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN purities pu ON pu.id = p.purity_id
    JOIN metals m ON m.id = pu.metal_id
    LEFT JOIN charge_profiles cp ON cp.id = p.charge_profile_id`;

  const seesPrivate = (user) => auth.can(user, 'stock.private');
  /** Removes what staff must not see: cost prices. */
  const shapeProduct = (user, p) => {
    if (p && !auth.can(user, 'costs.view')) delete p.cost_paisa;
    return p;
  };
  /** Owner-only stock does not exist for staff. */
  const findProduct = (user, where, ...params) => {
    const p = store.get(`${PRODUCT_SELECT} WHERE ${where}${seesPrivate(user) ? '' : ' AND p.is_private = 0'}`, ...params);
    return shapeProduct(user, p);
  };

  r.get('/products', perm('products.view'), (req, res) => {
    const where = [];
    const params = [];
    if (!seesPrivate(req.user)) where.push('p.is_private = 0');
    else if (req.query.place === 'shop') where.push('p.is_private = 0');
    else if (req.query.place === 'private') where.push('p.is_private = 1');
    const status = req.query.status || 'in_stock';
    if (status !== 'all') { where.push('p.status = ?'); params.push(oneOf(status, 'Status', ['in_stock', 'sold', 'removed'])); }
    if (req.query.category_id) { where.push('p.category_id = ?'); params.push(id(req.query.category_id)); }
    if (req.query.q) {
      where.push('(p.item_code LIKE ? OR p.name LIKE ? OR p.huid LIKE ?)');
      const like = `%${String(req.query.q).trim()}%`;
      params.push(like, like, like);
    }
    const sql = `${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT 500`;
    res.json(store.all(sql, ...params).map((p) => shapeProduct(req.user, p)));
  });

  r.get('/products/by-code/:code', perm('products.view'), (req, res) => {
    const product = findProduct(req.user, 'p.item_code = ?', String(req.params.code).trim());
    if (!product) throw notFound(`No item with code ${req.params.code}.`);
    res.json(product);
  });

  r.get('/products/:id', perm('products.view'), (req, res) => {
    const product = findProduct(req.user, 'p.id = ?', id(req.params.id));
    if (!product) throw notFound('Item not found.');
    res.json(product);
  });

  /** Owner-only fields: cost price, owner-only stock and where it is kept. */
  const readOwnerFields = (user, body, p, old = null) => {
    if (!auth.can(user, 'costs.view')) p.cost_paisa = old ? old.cost_paisa : 0;
    if (seesPrivate(user)) {
      p.is_private = body.is_private === true || body.is_private === 'true' || body.is_private === 'on' ? 1 : 0;
      p.location = text(body.location, 'Kept at', { max: 100 });
    } else {
      p.is_private = old ? old.is_private : 0;
      p.location = old ? old.location : null;
    }
    return p;
  };

  r.post('/products', perm('products.manage'), (req, res) => {
    const p = readOwnerFields(req.user, req.body, readProduct(req.body));
    const count = Math.round(toNumber(req.body.copies || 1, 'Number of pieces', { min: 1, max: 50 }));
    const ids = store.tx(() => {
      const created = [];
      for (let i = 0; i < count; i += 1) {
        const itemCode = count > 1 ? null : text(req.body.item_code, 'Item code', { max: 30 });
        const piece = insertProduct(store, req.user, { ...p, huid: count > 1 ? null : p.huid }, { itemCode });
        // Stock added directly (not through a purchase or karigar) enters the books at its cost price.
        ledger.post(store, req.user, {
          narration: `Stock added: ${piece.item_code} ${p.name}`, refType: 'product', refId: piece.id,
          lines: [{ account: A.STOCK, debit: p.cost_paisa }, { account: A.OPENING, credit: p.cost_paisa }]
        });
        created.push(piece.id);
      }
      return created;
    });
    res.status(201).json(ids.map((rowId) => findProduct(req.user, 'p.id = ?', rowId)));
  });

  r.put('/products/:id', perm('products.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const p = readProduct(req.body);
    store.tx(() => {
      const old = store.get('SELECT * FROM products WHERE id = ?', rowId);
      if (!old || (old.is_private && !seesPrivate(req.user))) throw notFound('Item not found.');
      if (old.status !== 'in_stock') throw rule('Only items in stock can be edited.');
      readOwnerFields(req.user, req.body, p, old);
      stock.recordEdit(store, req.user, old, { ...old, ...p });
      store.run(
        `UPDATE products SET name = ?, category_id = ?, purity_id = ?, gross_mg = ?, stone_mg = ?, other_less_mg = ?, stone_paisa = ?,
           other_paisa = ?, charge_profile_id = ?, making_override = ?, wastage_override = ?, fixed_price_paisa = ?, huid = ?, size = ?,
           notes = ?, cost_paisa = ?, is_private = ?, location = ?, updated_at = ? WHERE id = ?`,
        p.name, p.category_id, p.purity_id, p.gross_mg, p.stone_mg, p.other_less_mg, p.stone_paisa, p.other_paisa,
        p.charge_profile_id, p.making_override, p.wastage_override, p.fixed_price_paisa, p.huid, p.size, p.notes, p.cost_paisa,
        p.is_private, p.location, nowIso(), rowId
      );
      const change = p.cost_paisa - old.cost_paisa;
      ledger.post(store, req.user, {
        narration: `Cost price changed: ${old.item_code}`, refType: 'product', refId: rowId,
        lines: [{ account: A.STOCK, debit: change }, { account: A.OPENING, credit: change }]
      });
      store.audit(req.user, 'update', 'product', rowId, { before: old, after: p });
    });
    res.json(findProduct(req.user, 'p.id = ?', rowId));
  });

  r.post('/products/:id/remove', perm('products.remove'), (req, res) => {
    const rowId = id(req.params.id);
    const reason = text(req.body.reason, 'Reason', { max: 200, required: true });
    store.tx(() => {
      const old = store.get('SELECT * FROM products WHERE id = ?', rowId);
      if (!old) throw notFound('Item not found.');
      if (old.status !== 'in_stock') throw rule('Only items in stock can be removed.');
      store.run("UPDATE products SET status = 'removed', updated_at = ? WHERE id = ?", nowIso(), rowId);
      stock.record(store, req.user, old, 'removed', { note: reason });
      ledger.post(store, req.user, {
        narration: `Removed from stock: ${old.item_code} (${reason})`, refType: 'product', refId: rowId,
        lines: [{ account: A.STOCK_WRITE_OFF, debit: old.cost_paisa }, { account: A.STOCK, credit: old.cost_paisa }]
      });
      store.audit(req.user, 'remove', 'product', rowId, { item_code: old.item_code, reason });
    });
    res.json({ ok: true });
  });

  r.post('/products/:id/restore', perm('products.remove'), (req, res) => {
    const rowId = id(req.params.id);
    store.tx(() => {
      const old = store.get('SELECT * FROM products WHERE id = ?', rowId);
      if (!old) throw notFound('Item not found.');
      if (old.status !== 'removed') throw rule('Only removed items can be put back in stock.');
      if (old.source === 'purchase' && store.get(
        "SELECT pu.id FROM purchase_lines pl JOIN purchases pu ON pu.id = pl.purchase_id WHERE pl.product_id = ? AND pu.status = 'cancelled'", rowId)) {
        throw rule('This item came from a cancelled purchase, so it cannot be put back in stock.');
      }
      store.run("UPDATE products SET status = 'in_stock', updated_at = ? WHERE id = ?", nowIso(), rowId);
      stock.record(store, req.user, old, 'restored');
      ledger.post(store, req.user, {
        narration: `Put back in stock: ${old.item_code}`, refType: 'product', refId: rowId,
        lines: [{ account: A.STOCK, debit: old.cost_paisa }, { account: A.STOCK_WRITE_OFF, credit: old.cost_paisa }]
      });
      store.audit(req.user, 'restore', 'product', rowId, { item_code: old.item_code });
    });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- Daily stock register (owner)

  const registerDate = (value) => {
    const today = stock.localDateText(new Date());
    const dateText = value || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw badRequest('Dates must look like 2026-09-28.');
    if (dateText > today) throw badRequest('That date is in the future.');
    return dateText;
  };

  r.get('/stock-register', perm('stockreg.view'), (req, res) => {
    res.json(stock.dayRegister(store, registerDate(req.query.date)));
  });

  r.get('/stock-register/days', perm('stockreg.view'), (req, res) => {
    const days = Math.round(toNumber(req.query.days || 90, 'Days', { min: 1, max: 366 }));
    res.json(stock.daySummaries(store, days));
  });

  /** The owner's physical count at the end of a day, per category. */
  r.post('/stock-register/count', perm('stockreg.view'), (req, res) => {
    const dateText = registerDate(req.body.date);
    const counts = Array.isArray(req.body.counts) ? req.body.counts : [];
    if (!counts.length) throw badRequest('Enter the counted pieces.');
    const note = text(req.body.note, 'Note', { max: 300 });
    store.tx(() => {
      for (const c of counts) {
        const category = store.get('SELECT id, name FROM categories WHERE id = ?', id(c.category_id, 'Category'));
        if (!category) throw badRequest('Unknown category.');
        const qty = toNumber(c.qty, `${category.name}: pieces counted`, { allowEmpty: false });
        if (!Number.isInteger(qty)) throw badRequest(`${category.name}: pieces must be a whole number.`);
        const gross = c.gross_g === '' || c.gross_g === undefined || c.gross_g === null ? null : toMg(c.gross_g, `${category.name}: weight`);
        store.run(
          `INSERT INTO stock_counts (count_date, category_id, counted_qty, counted_gross_mg, note, counted_by, counted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(count_date, category_id) DO UPDATE SET counted_qty = excluded.counted_qty,
             counted_gross_mg = excluded.counted_gross_mg, note = excluded.note, counted_by = excluded.counted_by, counted_at = excluded.counted_at`,
          dateText, category.id, qty, gross, note, req.user.id, nowIso());
      }
      store.audit(req.user, 'count', 'stock_register', null, { date: dateText, counts, note });
    });
    res.json(stock.dayRegister(store, dateText));
  });

  // ---------------------------------------------------------------- Customers

  r.get('/customers', perm('customers.view'), (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    res.json(store.all(
      `SELECT c.*, COALESCE((SELECT SUM(due_paisa) FROM sales s WHERE s.customer_id = c.id AND s.status = 'posted'), 0) AS due_paisa
       FROM customers c
       WHERE (? = '' OR c.name LIKE ? OR c.phone LIKE ?)
       ORDER BY c.is_walkin DESC, c.name LIMIT 300`,
      q, like, like
    ));
  });

  const readCustomer = (body) => ({
    name: text(body.name, 'Customer name', { max: 100, required: true }),
    phone: text(body.phone, 'Phone', { max: 20 }),
    address: text(body.address, 'Address', { max: 200 }),
    pan: text(body.pan, 'PAN', { max: 20 }),
    notes: text(body.notes, 'Notes', { max: 300 })
  });

  r.post('/customers', perm('customers.manage'), (req, res) => {
    const c = readCustomer(req.body);
    const newId = store.tx(() => {
      const rowId = store.run('INSERT INTO customers (name, phone, address, pan, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        c.name, c.phone, c.address, c.pan, c.notes, nowIso()).lastInsertRowid;
      store.audit(req.user, 'create', 'customer', rowId, c);
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM customers WHERE id = ?', newId));
  });

  r.put('/customers/:id', perm('customers.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const c = readCustomer(req.body);
    store.tx(() => {
      const old = store.get('SELECT * FROM customers WHERE id = ?', rowId);
      if (!old) throw notFound('Customer not found.');
      if (old.is_walkin) throw rule('The walk-in customer cannot be edited.');
      store.run('UPDATE customers SET name = ?, phone = ?, address = ?, pan = ?, notes = ? WHERE id = ?',
        c.name, c.phone, c.address, c.pan, c.notes, rowId);
      store.audit(req.user, 'update', 'customer', rowId, { before: old, after: c });
    });
    res.json(store.get('SELECT * FROM customers WHERE id = ?', rowId));
  });

  // ---------------------------------------------------------------- Sales

  r.post('/sales/preview', perm('sales.create'), (req, res) => {
    const bill = sales.buildBill(store, req.body, req.user);
    // Cost prices are for the owner only.
    if (!auth.can(req.user, 'costs.view')) delete bill.totals.cost;
    res.json(bill);
  });

  r.post('/sales', perm('sales.create'), (req, res) => {
    const saleId = sales.createSale(store, req.body, req.user);
    res.status(201).json(sales.getSale(store, saleId));
  });

  r.get('/sales', perm('sales.view'), (req, res) => {
    const { fromIso, toIso } = dateRange(req.query);
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    res.json(store.all(
      `SELECT s.id, s.invoice_no, s.invoice_date, s.customer_name, s.customer_phone, s.net_payable_paisa, s.paid_paisa,
              s.due_paisa, s.exchange_paisa, s.status, u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS item_count
       FROM sales s JOIN users u ON u.id = s.created_by
       WHERE s.invoice_date >= ? AND s.invoice_date < ?
         AND (? = '' OR s.invoice_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)
       ORDER BY s.id DESC LIMIT 1000`,
      fromIso, toIso, q, like, like, like
    ));
  });

  r.get('/sales/:id', perm('sales.view'), (req, res) => res.json(sales.getSale(store, id(req.params.id))));

  r.post('/sales/:id/payments', perm('sales.create'), (req, res) => {
    const saleId = id(req.params.id);
    sales.addPayment(store, saleId, req.body, req.user);
    res.json(sales.getSale(store, saleId));
  });

  r.post('/sales/:id/cancel', perm('sales.cancel'), (req, res) => {
    const saleId = id(req.params.id);
    sales.cancelSale(store, saleId, req.body.reason, req.user);
    res.json(sales.getSale(store, saleId));
  });

  // ---------------------------------------------------------------- Reports

  r.get('/reports/dashboard', (req, res) => {
    const { fromIso, toIso } = dateRange({});
    const today = store.get(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(net_payable_paisa), 0) AS sales_paisa, COALESCE(SUM(exchange_paisa), 0) AS exchange_paisa
       FROM sales WHERE status = 'posted' AND invoice_date >= ? AND invoice_date < ?`, fromIso, toIso);
    const received = store.all(
      `SELECT p.method, SUM(p.amount_paisa) AS amount_paisa FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.status = 'posted' AND p.paid_at >= ? AND p.paid_at < ? GROUP BY p.method ORDER BY p.method`, fromIso, toIso);
    const stock = store.get(
      "SELECT COUNT(*) AS pieces, COALESCE(SUM(gross_mg), 0) AS gross_mg FROM products WHERE status = 'in_stock' AND (? OR is_private = 0)",
      seesPrivate(req.user) ? 1 : 0);
    const dues = store.get("SELECT COUNT(*) AS invoices, COALESCE(SUM(due_paisa), 0) AS due_paisa FROM sales WHERE status = 'posted' AND due_paisa > 0");
    const rates = store.all(
      `SELECT pu.name AS purity_name, m.name AS metal_name, r.entered_unit, r.entered_sell_paisa, r.entered_buy_paisa, r.updated_at
       FROM purities pu JOIN metals m ON m.id = pu.metal_id LEFT JOIN rates r ON r.purity_id = pu.id
       WHERE pu.is_active = 1 ORDER BY pu.sort_order, pu.id`);
    const recent = auth.can(req.user, 'sales.view') ? store.all(
      "SELECT id, invoice_no, invoice_date, customer_name, net_payable_paisa, status FROM sales ORDER BY id DESC LIMIT 8") : [];
    const todayText = ledger.localDateText(nowIso());
    const work = {
      overdue_jobs: auth.can(req.user, 'karigars.manage') ? store.get(
        "SELECT COUNT(*) AS n FROM karigar_jobs WHERE status = 'open' AND due_date < ?", todayText).n : null,
      orders_due: auth.can(req.user, 'orders.manage') ? store.get(
        "SELECT COUNT(*) AS n FROM orders WHERE status IN ('open', 'ready') AND due_date <= ?", todayText).n : null,
      orders_ready: auth.can(req.user, 'orders.manage') ? store.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'ready'").n : null,
      repairs_ready: auth.can(req.user, 'repairs.manage') ? store.get("SELECT COUNT(*) AS n FROM repairs WHERE status = 'ready'").n : null,
      repairs_due: auth.can(req.user, 'repairs.manage') ? store.get(
        "SELECT COUNT(*) AS n FROM repairs WHERE status = 'received' AND promised_date <= ?", todayText).n : null,
      cash_paisa: auth.can(req.user, 'accounts.view') ? ledger.balance(store, ledger.A.CASH) : null
    };
    res.json({ today, received, stock, dues: auth.can(req.user, 'reports.view') ? dues : null, rates, recent, work });
  });

  r.get('/reports/sales', perm('reports.view'), (req, res) => {
    const { fromIso, toIso } = dateRange(req.query);
    const totals = store.get(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(subtotal_paisa), 0) AS subtotal_paisa, COALESCE(SUM(discount_paisa), 0) AS discount_paisa,
              COALESCE(SUM(tax_paisa), 0) AS tax_paisa, COALESCE(SUM(grand_total_paisa), 0) AS grand_total_paisa,
              COALESCE(SUM(exchange_paisa), 0) AS exchange_paisa, COALESCE(SUM(net_payable_paisa), 0) AS net_payable_paisa,
              COALESCE(SUM(due_paisa), 0) AS due_paisa
       FROM sales WHERE status = 'posted' AND invoice_date >= ? AND invoice_date < ?`, fromIso, toIso);
    const cancelled = store.get(
      "SELECT COUNT(*) AS invoices FROM sales WHERE status = 'cancelled' AND invoice_date >= ? AND invoice_date < ?", fromIso, toIso);
    const byPurity = store.all(
      `SELECT i.purity_name, COUNT(*) AS pieces, SUM(i.net_mg) AS net_mg, SUM(i.total_paisa) AS total_paisa
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.status = 'posted' AND s.invoice_date >= ? AND s.invoice_date < ?
       GROUP BY i.purity_name ORDER BY i.purity_name`, fromIso, toIso);
    const payments = store.all(
      `SELECT p.method, COUNT(*) AS count, SUM(p.amount_paisa) AS amount_paisa FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.status = 'posted' AND p.paid_at >= ? AND p.paid_at < ? GROUP BY p.method ORDER BY p.method`, fromIso, toIso);
    const oldGold = store.all(
      `SELECT x.purity_name, SUM(x.net_mg) AS net_mg, SUM(x.fine_mg) AS fine_mg, SUM(x.amount_paisa) AS amount_paisa
       FROM sale_exchange_items x JOIN sales s ON s.id = x.sale_id
       WHERE s.status = 'posted' AND s.invoice_date >= ? AND s.invoice_date < ?
       GROUP BY x.purity_name ORDER BY x.purity_name`, fromIso, toIso);
    res.json({ totals, cancelled: cancelled.invoices, byPurity, payments, oldGold });
  });

  r.get('/reports/stock', perm('reports.view'), (req, res) => {
    res.json({
      byPurity: store.all(
        `SELECT m.name AS metal_name, pu.name AS purity_name, COUNT(*) AS pieces, SUM(p.gross_mg) AS gross_mg,
                SUM(p.gross_mg - p.stone_mg - p.other_less_mg) AS net_mg, SUM(p.cost_paisa) AS cost_paisa
         FROM products p JOIN purities pu ON pu.id = p.purity_id JOIN metals m ON m.id = pu.metal_id
         WHERE p.status = 'in_stock' GROUP BY pu.id ORDER BY pu.sort_order`),
      byCategory: store.all(
        `SELECT c.name AS category_name, COUNT(*) AS pieces, SUM(p.gross_mg) AS gross_mg,
                SUM(p.gross_mg - p.stone_mg - p.other_less_mg) AS net_mg
         FROM products p JOIN categories c ON c.id = p.category_id
         WHERE p.status = 'in_stock' GROUP BY c.id ORDER BY c.name`)
    });
  });

  r.get('/reports/dues', perm('reports.view'), (req, res) => {
    res.json(store.all(
      `SELECT s.id, s.invoice_no, s.invoice_date, s.customer_id, s.customer_name, s.customer_phone, s.net_payable_paisa, s.paid_paisa, s.due_paisa
       FROM sales s WHERE s.status = 'posted' AND s.due_paisa > 0 ORDER BY s.invoice_date`));
  });

  registerPurchaseRoutes(r, store);
  registerMetalRoutes(r, store);
  registerKarigarRoutes(r, store);
  registerOrderRoutes(r, store);
  registerAccountingRoutes(r, store);

  // ---------------------------------------------------------------- Users

  const USER_FIELDS = 'id, username, full_name, role, is_active, must_change_password, locked_until, last_login_at, created_at';

  r.get('/users', perm('users.manage'), (req, res) => res.json(store.all(`SELECT ${USER_FIELDS} FROM users ORDER BY username`)));

  const activeOwners = (excludeId) => store.get(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND id <> ?", excludeId).n;

  r.post('/users', perm('users.manage'), (req, res) => {
    const username = text(req.body.username, 'Username', { max: 50, required: true });
    if (!/^[A-Za-z0-9._-]+$/.test(username)) throw badRequest('Username may only contain letters, numbers, dots, dashes and underscores.');
    const fullName = text(req.body.full_name, 'Full name', { max: 100, required: true });
    const role = oneOf(req.body.role, 'Role', auth.ROLES);
    const problem = auth.passwordProblem(req.body.password, username);
    if (problem) throw badRequest(problem);
    const newId = store.tx(() => {
      if (store.get('SELECT id FROM users WHERE username = ?', username)) throw rule('That username is already taken.');
      const rowId = store.run(
        'INSERT INTO users (username, full_name, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)',
        username, fullName, role, auth.hashPassword(req.body.password), nowIso()
      ).lastInsertRowid;
      store.audit(req.user, 'create', 'user', rowId, { username, full_name: fullName, role });
      return rowId;
    });
    res.status(201).json(store.get(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, newId));
  });

  r.put('/users/:id', perm('users.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const fullName = text(req.body.full_name, 'Full name', { max: 100, required: true });
    const role = oneOf(req.body.role, 'Role', auth.ROLES);
    const isActive = req.body.is_active === false || req.body.is_active === 'false' ? 0 : 1;
    store.tx(() => {
      const old = store.get('SELECT * FROM users WHERE id = ?', rowId);
      if (!old) throw notFound('User not found.');
      if (old.role === 'owner' && (role !== 'owner' || !isActive) && activeOwners(rowId) === 0) {
        throw rule('There must always be at least one active owner.');
      }
      store.run('UPDATE users SET full_name = ?, role = ?, is_active = ? WHERE id = ?', fullName, role, isActive, rowId);
      if (!isActive) store.run('DELETE FROM sessions WHERE user_id = ?', rowId);
      store.audit(req.user, 'update', 'user', rowId, {
        before: { full_name: old.full_name, role: old.role, is_active: old.is_active },
        after: { full_name: fullName, role, is_active: isActive }
      });
    });
    res.json(store.get(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, rowId));
  });

  r.post('/users/:id/reset-password', perm('users.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const user = store.get('SELECT * FROM users WHERE id = ?', rowId);
    if (!user) throw notFound('User not found.');
    const problem = auth.passwordProblem(req.body.password, user.username);
    if (problem) throw badRequest(problem);
    store.tx(() => {
      store.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_count = 0, locked_until = NULL WHERE id = ?',
        auth.hashPassword(req.body.password), rowId);
      store.run('DELETE FROM sessions WHERE user_id = ?', rowId);
      store.audit(req.user, 'reset_password', 'user', rowId, { username: user.username });
    });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- Audit and login history

  r.get('/audit', perm('audit.view'), (req, res) => {
    const entity = String(req.query.entity || '');
    res.json(store.all(
      "SELECT * FROM audit_log WHERE (? = '' OR entity = ?) ORDER BY id DESC LIMIT 500", entity, entity));
  });

  r.get('/login-history', perm('audit.view'), (req, res) => {
    res.json(store.all('SELECT * FROM login_history ORDER BY id DESC LIMIT 300'));
  });

  // ---------------------------------------------------------------- Backup

  r.get('/backups', perm('backup.run'), (req, res) => res.json(backup.list(store)));

  r.post('/backups', perm('backup.run'), (req, res) => {
    const file = backup.run(store, 'manual');
    store.audit(req.user, 'backup', 'database', null, { file: file.name });
    res.status(201).json(file);
  });

  r.get('/backups/:name', perm('backup.run'), (req, res) => {
    const file = backup.find(store, req.params.name);
    if (!file) throw notFound('Backup not found.');
    store.audit(req.user, 'download', 'backup', null, { file: file.name });
    res.download(file.path, file.name);
  });

  return r;
}

module.exports = { createApiRouter };
