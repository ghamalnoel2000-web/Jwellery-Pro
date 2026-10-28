'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_V1 = `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name            TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  password_hash        TEXT NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_count         INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE login_history (
  id       INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  user_id  INTEGER,
  success  INTEGER NOT NULL,
  reason   TEXT,
  ip       TEXT,
  at       TEXT NOT NULL
);

CREATE TABLE metals (
  id   INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE purities (
  id         INTEGER PRIMARY KEY,
  metal_id   INTEGER NOT NULL REFERENCES metals(id),
  name       TEXT NOT NULL,
  purity     REAL NOT NULL CHECK (purity > 0 AND purity <= 1),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (metal_id, name)
);

-- Current rate per purity. Rates per gram are in paisa and may carry decimals for accuracy.
CREATE TABLE rates (
  purity_id          INTEGER PRIMARY KEY REFERENCES purities(id),
  sell_per_gram      REAL NOT NULL CHECK (sell_per_gram >= 0),
  buy_per_gram       REAL NOT NULL CHECK (buy_per_gram >= 0),
  entered_unit       TEXT NOT NULL,
  entered_sell_paisa INTEGER NOT NULL,
  entered_buy_paisa  INTEGER NOT NULL,
  updated_at         TEXT NOT NULL,
  updated_by         INTEGER REFERENCES users(id)
);

CREATE TABLE rate_history (
  id                 INTEGER PRIMARY KEY,
  purity_id          INTEGER NOT NULL REFERENCES purities(id),
  sell_per_gram      REAL NOT NULL,
  buy_per_gram       REAL NOT NULL,
  entered_unit       TEXT NOT NULL,
  entered_sell_paisa INTEGER NOT NULL,
  entered_buy_paisa  INTEGER NOT NULL,
  changed_at         TEXT NOT NULL,
  changed_by         INTEGER REFERENCES users(id)
);
CREATE INDEX ix_rate_history ON rate_history (purity_id, changed_at);

CREATE TABLE tax_rules (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  rate_percent  REAL NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  applies_to    TEXT NOT NULL CHECK (applies_to IN ('metal', 'making', 'stones', 'total')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  verified_note TEXT
);

CREATE TABLE charge_profiles (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  basis            TEXT NOT NULL CHECK (basis IN ('net', 'net_wastage', 'gross')),
  wastage_mode     TEXT NOT NULL CHECK (wastage_mode IN ('none', 'percent', 'grams')),
  wastage_value    REAL NOT NULL DEFAULT 0 CHECK (wastage_value >= 0),
  making_mode      TEXT NOT NULL CHECK (making_mode IN ('none', 'per_gram', 'percent', 'fixed')),
  making_value     REAL NOT NULL DEFAULT 0 CHECK (making_value >= 0),
  making_weight    TEXT NOT NULL DEFAULT 'net' CHECK (making_weight IN ('net', 'gross')),
  min_making_paisa INTEGER NOT NULL DEFAULT 0 CHECK (min_making_paisa >= 0),
  is_active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE categories (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  prefix            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  charge_profile_id INTEGER REFERENCES charge_profiles(id),
  next_number       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE products (
  id                INTEGER PRIMARY KEY,
  item_code         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name              TEXT NOT NULL,
  category_id       INTEGER NOT NULL REFERENCES categories(id),
  purity_id         INTEGER NOT NULL REFERENCES purities(id),
  gross_mg          INTEGER NOT NULL CHECK (gross_mg > 0),
  stone_mg          INTEGER NOT NULL DEFAULT 0 CHECK (stone_mg >= 0),
  other_less_mg     INTEGER NOT NULL DEFAULT 0 CHECK (other_less_mg >= 0),
  stone_paisa       INTEGER NOT NULL DEFAULT 0 CHECK (stone_paisa >= 0),
  other_paisa       INTEGER NOT NULL DEFAULT 0 CHECK (other_paisa >= 0),
  charge_profile_id INTEGER REFERENCES charge_profiles(id),
  making_override   REAL,
  wastage_override  REAL,
  fixed_price_paisa INTEGER,
  huid              TEXT,
  size              TEXT,
  notes             TEXT,
  cost_paisa        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'sold', 'removed')),
  created_at        TEXT NOT NULL,
  created_by        INTEGER REFERENCES users(id),
  updated_at        TEXT,
  CHECK (stone_mg + other_less_mg < gross_mg)
);
CREATE INDEX ix_products_status ON products (status);
CREATE INDEX ix_products_category ON products (category_id);

CREATE TABLE customers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  address    TEXT,
  pan        TEXT,
  notes      TEXT,
  is_walkin  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_customers_phone ON customers (phone);

CREATE TABLE sequences (
  name       TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL
);

CREATE TABLE sales (
  id                INTEGER PRIMARY KEY,
  invoice_no        TEXT NOT NULL UNIQUE,
  invoice_date      TEXT NOT NULL,
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT,
  customer_address  TEXT,
  customer_pan      TEXT,
  subtotal_paisa    INTEGER NOT NULL,
  discount_paisa    INTEGER NOT NULL,
  taxable_paisa     INTEGER NOT NULL,
  tax_paisa         INTEGER NOT NULL,
  grand_total_paisa INTEGER NOT NULL,
  exchange_paisa    INTEGER NOT NULL,
  round_off_paisa   INTEGER NOT NULL,
  net_payable_paisa INTEGER NOT NULL,
  paid_paisa        INTEGER NOT NULL,
  due_paisa         INTEGER NOT NULL,
  tax_summary       TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  cancel_reason     TEXT,
  cancelled_at      TEXT,
  cancelled_by      INTEGER REFERENCES users(id),
  remarks           TEXT,
  created_by        INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX ix_sales_date ON sales (invoice_date);
CREATE INDEX ix_sales_customer ON sales (customer_id);

CREATE TABLE sale_items (
  id              INTEGER PRIMARY KEY,
  sale_id         INTEGER NOT NULL REFERENCES sales(id),
  line_no         INTEGER NOT NULL,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  item_code       TEXT NOT NULL,
  description     TEXT NOT NULL,
  purity_name     TEXT NOT NULL,
  purity          REAL NOT NULL,
  gross_mg        INTEGER NOT NULL,
  stone_mg        INTEGER NOT NULL,
  other_less_mg   INTEGER NOT NULL,
  net_mg          INTEGER NOT NULL,
  wastage_mg      INTEGER NOT NULL,
  chargeable_mg   INTEGER NOT NULL,
  rate_per_gram   REAL NOT NULL,
  metal_paisa     INTEGER NOT NULL,
  making_paisa    INTEGER NOT NULL,
  stone_paisa     INTEGER NOT NULL,
  other_paisa     INTEGER NOT NULL,
  discount_paisa  INTEGER NOT NULL,
  taxable_paisa   INTEGER NOT NULL,
  tax_paisa       INTEGER NOT NULL,
  total_paisa     INTEGER NOT NULL,
  huid            TEXT,
  pricing_method  TEXT,
  UNIQUE (sale_id, line_no)
);

CREATE TABLE sale_exchange_items (
  id               INTEGER PRIMARY KEY,
  sale_id          INTEGER NOT NULL REFERENCES sales(id),
  description      TEXT NOT NULL,
  purity_id        INTEGER NOT NULL REFERENCES purities(id),
  purity_name      TEXT NOT NULL,
  purity           REAL NOT NULL,
  gross_mg         INTEGER NOT NULL,
  less_mg          INTEGER NOT NULL,
  net_mg           INTEGER NOT NULL,
  refining_percent REAL NOT NULL,
  fine_mg          INTEGER NOT NULL,
  rate_per_gram    REAL NOT NULL,
  amount_paisa     INTEGER NOT NULL
);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  sale_id      INTEGER NOT NULL REFERENCES sales(id),
  method       TEXT NOT NULL CHECK (method IN ('cash', 'bank', 'card', 'qr', 'cheque')),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  reference    TEXT,
  paid_at      TEXT NOT NULL,
  received_by  INTEGER REFERENCES users(id)
);
CREATE INDEX ix_payments_sale ON payments (sale_id);
CREATE INDEX ix_payments_date ON payments (paid_at);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  user_id   INTEGER,
  username  TEXT,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT,
  details   TEXT
);
CREATE INDEX ix_audit_at ON audit_log (at);

-- The audit log can only grow: nobody can edit or delete its rows.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'The audit log cannot be changed.'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'The audit log cannot be changed.'); END;
`;

// Version 2: Nepali (BS) calendar corrections entered by the owner from the official patro.
const SCHEMA_V2 = `
CREATE TABLE bs_calendar_overrides (
  year       INTEGER PRIMARY KEY CHECK (year BETWEEN 2000 AND 2200),
  month_days TEXT NOT NULL,
  note       TEXT,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
`;

// Version 3: accounting, metal stock, suppliers and purchases, karigars, orders, repairs.
const SCHEMA_V3 = `
CREATE TABLE accounts (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type      TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  is_system INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE journal_entries (
  id          INTEGER PRIMARY KEY,
  entry_no    TEXT NOT NULL UNIQUE,
  entry_date  TEXT NOT NULL,
  narration   TEXT NOT NULL,
  ref_type    TEXT,
  ref_id      INTEGER,
  reverses_id INTEGER REFERENCES journal_entries(id),
  created_at  TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id)
);
CREATE INDEX ix_journal_date ON journal_entries (entry_date);
CREATE INDEX ix_journal_ref ON journal_entries (ref_type, ref_id);

CREATE TABLE journal_lines (
  id           INTEGER PRIMARY KEY,
  entry_id     INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  debit_paisa  INTEGER NOT NULL DEFAULT 0 CHECK (debit_paisa >= 0),
  credit_paisa INTEGER NOT NULL DEFAULT 0 CHECK (credit_paisa >= 0),
  party_type   TEXT,
  party_id     INTEGER,
  memo         TEXT,
  CHECK (debit_paisa = 0 OR credit_paisa = 0)
);
CREATE INDEX ix_journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX ix_journal_lines_account ON journal_lines (account_id);
CREATE INDEX ix_journal_lines_party ON journal_lines (party_type, party_id);

-- Posted accounting is permanent: mistakes are corrected with reversing entries.
CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'Posted accounting entries cannot be changed.'); END;
CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'Posted accounting entries cannot be changed.'); END;
CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'Posted accounting entries cannot be changed.'); END;
CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'Posted accounting entries cannot be changed.'); END;

-- Fine metal held by the shop (old gold, bullion), by weight and by value.
CREATE TABLE metal_ledger (
  id          INTEGER PRIMARY KEY,
  entry_date  TEXT NOT NULL,
  metal_id    INTEGER NOT NULL REFERENCES metals(id),
  fine_mg     INTEGER NOT NULL,
  gross_mg    INTEGER,
  purity      REAL,
  value_paisa INTEGER NOT NULL,
  source      TEXT NOT NULL,
  ref_type    TEXT,
  ref_id      INTEGER,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id)
);
CREATE INDEX ix_metal_ledger ON metal_ledger (metal_id, entry_date);

CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  address    TEXT,
  pan        TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE purchases (
  id               INTEGER PRIMARY KEY,
  purchase_no      TEXT NOT NULL UNIQUE,
  supplier_id      INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_bill_no TEXT,
  purchase_date    TEXT NOT NULL,
  total_paisa      INTEGER NOT NULL,
  paid_paisa       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  cancel_reason    TEXT,
  remarks          TEXT,
  created_at       TEXT NOT NULL,
  created_by       INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE purchase_lines (
  id           INTEGER PRIMARY KEY,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id),
  kind         TEXT NOT NULL CHECK (kind IN ('piece', 'metal')),
  description  TEXT NOT NULL,
  purity_id    INTEGER NOT NULL REFERENCES purities(id),
  gross_mg     INTEGER NOT NULL,
  fine_mg      INTEGER NOT NULL,
  product_id   INTEGER REFERENCES products(id),
  amount_paisa INTEGER NOT NULL
);

-- Money paid to suppliers and karigars.
CREATE TABLE party_payments (
  id           INTEGER PRIMARY KEY,
  voucher_no   TEXT NOT NULL UNIQUE,
  party_type   TEXT NOT NULL CHECK (party_type IN ('supplier', 'karigar')),
  party_id     INTEGER NOT NULL,
  method       TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  reference    TEXT,
  note         TEXT,
  paid_at      TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id)
);

CREATE TABLE old_gold_purchases (
  id              INTEGER PRIMARY KEY,
  voucher_no      TEXT NOT NULL UNIQUE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  purchase_date   TEXT NOT NULL,
  total_paisa     INTEGER NOT NULL,
  method          TEXT NOT NULL,
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  cancel_reason   TEXT,
  remarks         TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE old_gold_purchase_lines (
  id               INTEGER PRIMARY KEY,
  purchase_id      INTEGER NOT NULL REFERENCES old_gold_purchases(id),
  description      TEXT NOT NULL,
  purity_id        INTEGER NOT NULL REFERENCES purities(id),
  purity_name      TEXT NOT NULL,
  purity           REAL NOT NULL,
  gross_mg         INTEGER NOT NULL,
  less_mg          INTEGER NOT NULL,
  net_mg           INTEGER NOT NULL,
  refining_percent REAL NOT NULL,
  fine_mg          INTEGER NOT NULL,
  rate_per_gram    REAL NOT NULL,
  amount_paisa     INTEGER NOT NULL
);

CREATE TABLE karigars (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  address    TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE orders (
  id                 INTEGER PRIMARY KEY,
  order_no           TEXT NOT NULL UNIQUE,
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  description        TEXT NOT NULL,
  purity_id          INTEGER REFERENCES purities(id),
  expected_weight_mg INTEGER,
  due_date           TEXT,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ready', 'delivered', 'cancelled')),
  advance_paisa      INTEGER NOT NULL DEFAULT 0,
  used_paisa         INTEGER NOT NULL DEFAULT 0,
  refunded_paisa     INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  created_at         TEXT NOT NULL,
  created_by         INTEGER REFERENCES users(id),
  updated_at         TEXT
);

CREATE TABLE order_payments (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  kind         TEXT NOT NULL CHECK (kind IN ('advance', 'refund')),
  method       TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  reference    TEXT,
  paid_at      TEXT NOT NULL,
  received_by  INTEGER REFERENCES users(id)
);

CREATE TABLE karigar_jobs (
  id                   INTEGER PRIMARY KEY,
  job_no               TEXT NOT NULL UNIQUE,
  karigar_id           INTEGER NOT NULL REFERENCES karigars(id),
  metal_id             INTEGER NOT NULL REFERENCES metals(id),
  description          TEXT NOT NULL,
  order_id             INTEGER REFERENCES orders(id),
  due_date             TEXT,
  issued_fine_mg       INTEGER NOT NULL DEFAULT 0,
  issued_value_paisa   INTEGER NOT NULL DEFAULT 0,
  consumed_fine_mg     INTEGER NOT NULL DEFAULT 0,
  consumed_value_paisa INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at           TEXT NOT NULL,
  created_by           INTEGER REFERENCES users(id),
  closed_at            TEXT
);

CREATE TABLE karigar_issues (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES karigar_jobs(id),
  issued_at   TEXT NOT NULL,
  purity_id   INTEGER NOT NULL REFERENCES purities(id),
  gross_mg    INTEGER NOT NULL,
  fine_mg     INTEGER NOT NULL,
  value_paisa INTEGER NOT NULL,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id)
);

CREATE TABLE karigar_receipts (
  id                   INTEGER PRIMARY KEY,
  job_id               INTEGER NOT NULL REFERENCES karigar_jobs(id),
  received_at          TEXT NOT NULL,
  pieces_fine_mg       INTEGER NOT NULL,
  returned_fine_mg     INTEGER NOT NULL,
  wastage_fine_mg      INTEGER NOT NULL,
  labour_paisa         INTEGER NOT NULL,
  consumed_value_paisa INTEGER NOT NULL,
  note                 TEXT,
  created_by           INTEGER REFERENCES users(id)
);

CREATE TABLE repairs (
  id               INTEGER PRIMARY KEY,
  repair_no        TEXT NOT NULL UNIQUE,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT,
  item_description TEXT NOT NULL,
  weight_in_mg     INTEGER NOT NULL,
  promised_date    TEXT,
  estimate_paisa   INTEGER NOT NULL DEFAULT 0,
  karigar_id       INTEGER REFERENCES karigars(id),
  status           TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'ready', 'delivered', 'cancelled')),
  weight_out_mg    INTEGER,
  charge_paisa     INTEGER,
  method           TEXT,
  reference        TEXT,
  delivered_at     TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  created_by       INTEGER REFERENCES users(id)
);

ALTER TABLE products ADD COLUMN source TEXT;
ALTER TABLE products ADD COLUMN source_id INTEGER;
ALTER TABLE sales ADD COLUMN order_id INTEGER REFERENCES orders(id);
ALTER TABLE sales ADD COLUMN advance_paisa INTEGER NOT NULL DEFAULT 0;
`;

const SEED_ACCOUNTS = [
  ['1000', 'Cash', 'asset', 1],
  ['1010', 'Bank and digital payments', 'asset', 1],
  ['1100', 'Customer dues', 'asset', 1],
  ['1200', 'Jewellery stock', 'asset', 1],
  ['1210', 'Metal stock', 'asset', 1],
  ['1220', 'Gold with karigars', 'asset', 1],
  ['2000', 'Supplier payables', 'liability', 1],
  ['2010', 'Karigar payables', 'liability', 1],
  ['2100', 'Customer advances', 'liability', 1],
  ['2200', 'Tax payable', 'liability', 1],
  ['3000', "Owner's capital", 'equity', 1],
  ['3100', "Owner's drawings", 'equity', 1],
  ['3200', 'Opening balances', 'equity', 1],
  ['4000', 'Sales', 'income', 1],
  ['4100', 'Repair income', 'income', 1],
  ['4900', 'Rounding off', 'income', 1],
  ['5000', 'Cost of goods sold', 'expense', 1],
  ['5100', 'Stock written off', 'expense', 1],
  ['5110', 'Metal loss', 'expense', 1],
  ['6000', 'Rent', 'expense', 0],
  ['6010', 'Salaries and wages', 'expense', 0],
  ['6020', 'Electricity and utilities', 'expense', 0],
  ['6030', 'Shop expenses', 'expense', 0],
  ['6090', 'Other expenses', 'expense', 0]
];

/** The database version this program creates. Raise it with each new "if (version < N)" block below. */
const LATEST_VERSION = 5;

const DEFAULT_SETTINGS = {
  shop_name: 'My Jewellery Shop',
  shop_address: '',
  shop_phone: '',
  shop_pan: '',
  vat_registered: 'false',
  vat_number: '',
  invoice_prefix: 'INV-',
  invoice_title: 'Invoice',
  invoice_footer: 'Thank you for your purchase.',
  invoice_terms: '',
  grams_per_tola: '11.664',
  rate_entry_unit: 'tola',
  round_to_rupees: '1',
  cashier_max_discount_percent: '2',
  backup_keep_count: '30',
  date_display: 'both',
  invoice_numbering: 'continuous',
  books_locked_until: '',
  backup_copy_dir: '',
  whatsapp_country_code: '977'
};

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'jewelpro.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.cache = new Map();
    this.migrate();
    this.seed();
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get(sql, ...params) { return this.stmt(sql).get(...params); }
  all(sql, ...params) { return this.stmt(sql).all(...params); }
  run(sql, ...params) { return this.stmt(sql).run(...params); }

  /** Run fn inside one database transaction; everything is saved or nothing is. */
  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    // Before upgrading an existing database, keep a copy of it exactly as it was. These copies are never deleted automatically.
    if (version > 0 && version < LATEST_VERSION) {
      const dir = path.join(this.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      this.db.prepare('VACUUM INTO ?').run(path.join(dir, `before-upgrade-v${version}-${stamp}.db`));
    }
    if (version < 1) {
      this.db.exec('BEGIN');
      this.db.exec(SCHEMA_V1);
      this.db.exec('PRAGMA user_version = 1');
      this.db.exec('COMMIT');
    }
    if (version < 2) {
      this.db.exec('BEGIN');
      this.db.exec(SCHEMA_V2);
      this.db.exec('PRAGMA user_version = 2');
      this.db.exec('COMMIT');
    }
    if (version < 3) {
      this.db.exec('BEGIN');
      this.db.exec(SCHEMA_V3);
      for (const [code, name, type, system] of SEED_ACCOUNTS) {
        this.db.prepare('INSERT INTO accounts (code, name, type, is_system) VALUES (?, ?, ?, ?)').run(code, name, type, system);
      }
      // Existing bills and stock are posted to the accounts once, when the app next starts.
      this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('accounting_backfill', 'pending')").run();
      this.db.exec('PRAGMA user_version = 3');
      this.db.exec('COMMIT');
    }
    if (version < 4) {
      // Two roles only: owner and staff (managers and cashiers become staff).
      // SQLite cannot change a CHECK rule in place, so the users table is rebuilt.
      this.db.exec('PRAGMA foreign_keys = OFF');
      this.db.exec('BEGIN');
      this.db.exec(`
        CREATE TABLE users_new (
          id                   INTEGER PRIMARY KEY,
          username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
          full_name            TEXT NOT NULL,
          role                 TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
          password_hash        TEXT NOT NULL,
          is_active            INTEGER NOT NULL DEFAULT 1,
          must_change_password INTEGER NOT NULL DEFAULT 0,
          failed_count         INTEGER NOT NULL DEFAULT 0,
          locked_until         TEXT,
          last_login_at        TEXT,
          created_at           TEXT NOT NULL
        );
        INSERT INTO users_new (id, username, full_name, role, password_hash, is_active, must_change_password, failed_count,
                               locked_until, last_login_at, created_at)
          SELECT id, username, full_name, CASE WHEN role = 'owner' THEN 'owner' ELSE 'staff' END, password_hash, is_active,
                 must_change_password, failed_count, locked_until, last_login_at, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        -- Stock kept outside the shop, visible to the owner only.
        ALTER TABLE products ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN location TEXT;
      `);
      const problems = this.db.prepare('PRAGMA foreign_key_check').all();
      if (problems.length) { this.db.exec('ROLLBACK'); throw new Error('Upgrade to version 4 failed a foreign key check.'); }
      this.db.exec('PRAGMA user_version = 4');
      this.db.exec('COMMIT');
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    if (version < 5) {
      // Daily stock register: every piece entering or leaving shop stock, and the owner's daily counts.
      this.db.exec('BEGIN');
      this.db.exec(`
        CREATE TABLE stock_movements (
          id          INTEGER PRIMARY KEY,
          moved_at    TEXT NOT NULL,
          product_id  INTEGER NOT NULL REFERENCES products(id),
          category_id INTEGER NOT NULL REFERENCES categories(id),
          qty         INTEGER NOT NULL,
          gross_mg    INTEGER NOT NULL,
          net_mg      INTEGER NOT NULL,
          reason      TEXT NOT NULL,
          party_type  TEXT,
          party_id    INTEGER,
          ref_type    TEXT,
          ref_id      INTEGER,
          note        TEXT,
          created_by  INTEGER REFERENCES users(id)
        );
        CREATE INDEX ix_stock_movements_date ON stock_movements (moved_at);
        CREATE INDEX ix_stock_movements_product ON stock_movements (product_id);
        CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
        BEGIN SELECT RAISE(ABORT, 'The stock register cannot be changed.'); END;
        CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
        BEGIN SELECT RAISE(ABORT, 'The stock register cannot be changed.'); END;

        CREATE TABLE stock_counts (
          count_date       TEXT NOT NULL,
          category_id      INTEGER NOT NULL REFERENCES categories(id),
          counted_qty      INTEGER NOT NULL,
          counted_gross_mg INTEGER,
          note             TEXT,
          counted_by       INTEGER REFERENCES users(id),
          counted_at       TEXT NOT NULL,
          PRIMARY KEY (count_date, category_id)
        );
      `);
      this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stock_backfill', 'pending')").run();
      this.db.exec('PRAGMA user_version = 5');
      this.db.exec('COMMIT');
    }
    if (version < 6) {
      // Each piece can name the karigar who made it (also for stock entered by hand), and when it came into stock.
      this.db.exec('BEGIN');
      this.db.exec(`
        ALTER TABLE products ADD COLUMN karigar_id INTEGER REFERENCES karigars(id);
        ALTER TABLE products ADD COLUMN received_at TEXT;
        UPDATE products SET received_at = created_at;
        UPDATE products SET karigar_id = (
          SELECT j.karigar_id FROM karigar_receipts r JOIN karigar_jobs j ON j.id = r.job_id WHERE r.id = products.source_id)
        WHERE source = 'karigar';
        CREATE INDEX ix_products_karigar ON products (karigar_id);
      `);
      this.db.exec('PRAGMA user_version = 6');
      this.db.exec('COMMIT');
    }
    if (version < 7) {
      // Counts typed into the register book can be for the morning or the evening, like the M and E columns.
      this.db.exec('BEGIN');
      this.db.exec(`
        CREATE TABLE stock_counts_new (
          count_date       TEXT NOT NULL,
          session          TEXT NOT NULL DEFAULT 'evening' CHECK (session IN ('morning', 'evening')),
          category_id      INTEGER NOT NULL REFERENCES categories(id),
          counted_qty      INTEGER NOT NULL,
          counted_gross_mg INTEGER,
          note             TEXT,
          counted_by       INTEGER REFERENCES users(id),
          counted_at       TEXT NOT NULL,
          PRIMARY KEY (count_date, session, category_id)
        );
        INSERT INTO stock_counts_new (count_date, session, category_id, counted_qty, counted_gross_mg, note, counted_by, counted_at)
          SELECT count_date, 'evening', category_id, counted_qty, counted_gross_mg, note, counted_by, counted_at FROM stock_counts;
        DROP TABLE stock_counts;
        ALTER TABLE stock_counts_new RENAME TO stock_counts;
      `);
      this.db.exec('PRAGMA user_version = 7');
      this.db.exec('COMMIT');
    }
    // Future schema changes go here as "if (version < 8) { ... }".
  }

  seed() {
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, value);
    }
    this.run("INSERT OR IGNORE INTO sequences (name, next_value) VALUES ('invoice', 1)");

    if (this.get('SELECT COUNT(*) AS n FROM metals').n === 0) {
      this.tx(() => {
        const gold = this.run("INSERT INTO metals (code, name) VALUES ('AU', 'Gold')").lastInsertRowid;
        const silver = this.run("INSERT INTO metals (code, name) VALUES ('AG', 'Silver')").lastInsertRowid;
        const purities = [
          [gold, '24K', 0.999, 1], [gold, '22K', 0.916, 2], [gold, '18K', 0.75, 3], [silver, '999', 0.999, 4]
        ];
        for (const p of purities) {
          this.run('INSERT INTO purities (metal_id, name, purity, sort_order) VALUES (?, ?, ?, ?)', ...p);
        }
        const profile = this.run(
          `INSERT INTO charge_profiles (name, basis, wastage_mode, wastage_value, making_mode, making_value, making_weight)
           VALUES ('Standard', 'net', 'none', 0, 'per_gram', 0, 'net')`
        ).lastInsertRowid;
        const categories = [
          ['Ring', 'RG'], ['Chain', 'CH'], ['Necklace', 'NK'], ['Earring', 'ER'],
          ['Bangle', 'BG'], ['Pendant', 'PD'], ['Other', 'OT']
        ];
        for (const [name, prefix] of categories) {
          this.run('INSERT INTO categories (name, prefix, charge_profile_id) VALUES (?, ?, ?)', name, prefix, profile);
        }
        this.run("INSERT INTO customers (name, is_walkin, created_at) VALUES ('Walk-in customer', 1, ?)", now);
      });
    }
  }

  getSettings() {
    return Object.fromEntries(this.all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  }

  setting(key) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? row.value : DEFAULT_SETTINGS[key];
  }

  audit(user, action, entity, entityId, details) {
    this.run(
      'INSERT INTO audit_log (at, user_id, username, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      user ? user.id : null,
      user ? user.username : null,
      action,
      entity,
      entityId === undefined || entityId === null ? null : String(entityId),
      details === undefined ? null : JSON.stringify(details)
    );
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store, DEFAULT_SETTINGS, SEED_ACCOUNTS, SCHEMA_V1 };
