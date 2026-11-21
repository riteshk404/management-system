const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let sqliteEngine = null;
let db = null;
let dbPath = null;
let isSqlJs = false;
let SQLInstance = null;
let inTransaction = false;
let currentTenant = null;

// Initialize database (Scoped per tenant)
async function initDatabase(appDataDir, tenantSlug = 'default') {
  const cleanTenant = (tenantSlug || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '_');

  // If already connected to this tenant, skip redundant reconnect and DDL re-runs
  if (db && currentTenant === cleanTenant) {
    return true;
  }

  const tenantDir = path.join(appDataDir, 'tenants', cleanTenant);
  if (!fs.existsSync(tenantDir)) {
    fs.mkdirSync(tenantDir, { recursive: true });
  }

  // If previous connection is open to a different tenant, close it cleanly
  if (db) {
    try {
      if (typeof db.close === 'function') db.close();
    } catch (_) {}
    db = null;
    currentTenant = null;
  }

  dbPath = path.join(tenantDir, 'garage_manager.sqlite');

  // Slug migration: if this tenant folder is empty but an old slug variant exists, copy data over.
  // Handles cases like "the-puma-2wheeler-service" vs "the-puma-2-wheeler-service"
  if (!fs.existsSync(dbPath)) {
    const slugVariants = [
      cleanTenant.replace(/-/g, '_'),                          // dashes to underscores
      cleanTenant.replace(/_/g, '-'),                          // underscores to dashes
      cleanTenant.replace(/(\d)([a-z])/g, '$1-$2'),           // add dash after digit (2wheeler -> 2-wheeler)
      cleanTenant.replace(/(\d)-([a-z])/g, '$1$2'),           // remove dash after digit (2-wheeler -> 2wheeler)
    ];
    for (const variant of slugVariants) {
      if (variant === cleanTenant) continue;
      const variantDb = path.join(appDataDir, 'tenants', variant, 'garage_manager.sqlite');
      if (fs.existsSync(variantDb) && isSqliteFile(variantDb)) {
        try {
          fs.copyFileSync(variantDb, dbPath);
          // Copy the write-ahead log too, otherwise recent transactions that
          // were not checkpointed yet would be missing from the copy. The SHM
          // file is intentionally not copied: SQLite rebuilds it from the WAL.
          if (fs.existsSync(`${variantDb}-wal`)) {
            try { fs.copyFileSync(`${variantDb}-wal`, `${dbPath}-wal`); } catch (_) {}
          }
          console.log(`[DB] Migrated data from slug variant [${variant}] -> [${cleanTenant}]`);
        } catch (_) {}
        break;
      }
    }
  }

  // One-time legacy migration check.
  // IMPORTANT: this is COPY-ONLY. The original legacy database (and its WAL/SHM files)
  // is deliberately left untouched so an older installation's local data is never
  // removed, renamed, or otherwise lost during an upgrade.
  const legacyDbPath = path.join(appDataDir, 'garage_manager.sqlite');

  const isLegacyTenant = (cleanTenant === 'the_puma_2_wheeler_service' || 
                          cleanTenant === 'the-puma-2-wheeler-service' || 
                          cleanTenant === 'the-puma-2wheeler-service' ||
                          cleanTenant === 'the_puma_garage1');

  if (fs.existsSync(legacyDbPath)) {
    // Only copy a file that is actually a SQLite database. The original is
    // always left in place.
    if (isLegacyTenant && !fs.existsSync(dbPath) && isSqliteFile(legacyDbPath)) {
      try {
        fs.copyFileSync(legacyDbPath, dbPath);
        // Preserve uncheckpointed WAL content from the legacy database too.
        if (fs.existsSync(`${legacyDbPath}-wal`)) {
          try { fs.copyFileSync(`${legacyDbPath}-wal`, `${dbPath}-wal`); } catch (_) {}
        }
        console.log(`[DB] Successfully copied legacy database to tenant [${cleanTenant}] path:`, dbPath);
      } catch (migErr) {
        console.warn('[DB] Could not migrate legacy database file:', migErr.message);
      }
    }
  }

  // If an existing file is not a valid SQLite database, preserve it under a
  // clear .invalid-<timestamp> name and start a fresh database instead of
  // crashing. Nothing is deleted.
  if (fs.existsSync(dbPath) && !isSqliteFile(dbPath)) {
    const invalidPath = `${dbPath}.invalid-${Date.now()}`;
    try {
      fs.renameSync(dbPath, invalidPath);
      try { if (fs.existsSync(`${dbPath}-wal`)) fs.renameSync(`${dbPath}-wal`, `${invalidPath}-wal`); } catch (_) {}
      try { if (fs.existsSync(`${dbPath}-shm`)) fs.renameSync(`${dbPath}-shm`, `${invalidPath}-shm`); } catch (_) {}
      console.warn(`[DB] Existing database was not a valid SQLite file. Preserved as: ${invalidPath}`);
    } catch (quarantineErr) {
      throw new Error(`Database file is unreadable and could not be preserved: ${quarantineErr.message}`);
    }
  }

  // Try better-sqlite3 first (native fast C++ SQLite)
  let loaded = false;
  try {
    const Database = require('better-sqlite3');
    const bdb = new Database(dbPath);
    bdb.pragma('journal_mode = WAL');
    bdb.pragma('foreign_keys = ON');
    db = bdb;
    isSqlJs = false;
    loaded = true;
    console.log(`[DB] Connected tenant [${cleanTenant}] using better-sqlite3 at:`, dbPath);
  } catch (err) {
    console.warn('[DB] better-sqlite3 native load failed, falling back to sql.js (pure WebAssembly SQLite):', err.message);
  }

  // Fallback to sql.js (official SQLite compiled to WebAssembly, 100% portable)
  if (!loaded) {
    const initSqlJs = require('sql.js');
    SQLInstance = await initSqlJs();
    let filebuffer = null;
    if (fs.existsSync(dbPath)) {
      filebuffer = fs.readFileSync(dbPath);
    }
    const sdb = filebuffer ? new SQLInstance.Database(filebuffer) : new SQLInstance.Database();
    sdb.run("PRAGMA foreign_keys = ON;");
    db = sdb;
    isSqlJs = true;
    console.log(`[DB] Connected tenant [${cleanTenant}] using sql.js (WASM) at:`, dbPath);
  }

  // Create tables & run migrations
  createSchema();

  // Legacy sample-data cleanup is now opt-in. Older builds deleted records that
  // matched hard-coded names/codes on every startup, which could remove genuine
  // customer or inventory data. Set GARAGE_PURGE_LEGACY_MOCK=1 to run it manually.
  if (process.env.GARAGE_PURGE_LEGACY_MOCK === '1') {
    cleanupLegacyMockData();
  }

  currentTenant = cleanTenant;
  return true;
}

function persistSqlJs() {
  if (inTransaction) return; // defer persistence until transaction commit
  if (isSqlJs && db && dbPath) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(dbPath, buffer);
    } catch (e) {
      console.error('[DB] Failed to persist sql.js database:', e);
    }
  }
}

function runInTransaction(fn) {
  if (!isSqlJs) {
    const tx = db.transaction(fn);
    return tx();
  } else {
    inTransaction = true;
    db.run("BEGIN TRANSACTION;");
    try {
      const res = fn();
      db.run("COMMIT;");
      inTransaction = false;
      persistSqlJs();
      return res;
    } catch (err) {
      try { db.run("ROLLBACK;"); } catch (_) {}
      inTransaction = false;
      throw err;
    }
  }
}

function createSchema() {
  const schema = `
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      vehicle_no TEXT DEFAULT '',
      vehicle_model TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      quantity INTEGER NOT NULL DEFAULT 0,
      min_quantity INTEGER NOT NULL DEFAULT 5,
      purchase_price REAL NOT NULL DEFAULT 0.0,
      selling_price REAL NOT NULL DEFAULT 0.0,
      location TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT DEFAULT '',
      vehicle_no TEXT DEFAULT '',
      vehicle_model TEXT DEFAULT '',
      subtotal REAL NOT NULL DEFAULT 0.0,
      labour_charges REAL NOT NULL DEFAULT 0.0,
      discount REAL NOT NULL DEFAULT 0.0,
      tax REAL NOT NULL DEFAULT 0.0,
      total_amount REAL NOT NULL DEFAULT 0.0,
      paid_amount REAL NOT NULL DEFAULT 0.0,
      balance_amount REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'Unpaid', -- 'Paid', 'Partial', 'Unpaid'
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      inventory_id INTEGER, -- nullable for custom items/labour
      item_code TEXT DEFAULT '',
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0.0,
      total_price REAL NOT NULL DEFAULT 0.0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'Cash', -- 'Cash', 'Online'
      reference_no TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Owner',
      recovery_key_hash TEXT,
      recovery_key_salt TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Production Indexes for fast search and relations
    CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments(payment_date);
    CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(code);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
  `;

  if (!isSqlJs) {
    db.exec(schema);
  } else {
    db.run(schema);
    persistSqlJs();
  }

  // Gracefully migrate existing tables if columns were added later
  try {
    runQuery("ALTER TABLE inventory ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
  } catch (_) {
    // Column already exists
  }
}

// ----------------------------------------------------
// Security & Cryptographic Password Utilities (PBKDF2)
// ----------------------------------------------------
function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  // 100,000 rounds of PBKDF2 with SHA-512 (OWASP recommended standard)
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  try {
    const calculatedHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    const bufA = Buffer.from(calculatedHash, 'hex');
    const bufB = Buffer.from(hash, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateRecoveryKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return key;
}

// ----------------------------------------------------
// Mock Data Cleanup (Purge legacy dummy records)
// ----------------------------------------------------
function cleanupLegacyMockData() {
  try {
    // 1. Purge legacy seeded sample customers and their test invoices
    const mockCustomers = queryAll(`
      SELECT id FROM customers 
      WHERE name IN ('Rajesh Sharma', 'Pooja Verma', 'Anand Patel', 'Sunil Mehta', 'Vikram Joshi')
        AND phone IN ('+91 98201 23456', '+91 97110 88231', '+91 99250 14522', '+91 98400 90123', '+91 94120 77651')
    `);

    if (mockCustomers && mockCustomers.length > 0) {
      for (const mc of mockCustomers) {
        const invs = queryAll("SELECT id FROM invoices WHERE customer_id = ?", [mc.id]);
        for (const inv of invs) {
          runQuery("DELETE FROM invoice_items WHERE invoice_id = ?", [inv.id]);
          runQuery("DELETE FROM payments WHERE invoice_id = ?", [inv.id]);
          runQuery("DELETE FROM invoices WHERE id = ?", [inv.id]);
        }
        runQuery("DELETE FROM customers WHERE id = ?", [mc.id]);
      }
      console.log(`[DB] Cleaned up ${mockCustomers.length} legacy sample customer records.`);
    }

    // 2. Purge legacy seeded sample inventory items
    const mockCodes = [
      'PART-OIL-5W30', 'PART-OIL-FLTR', 'PART-AIR-FLTR', 'PART-BRK-FRNT',
      'PART-BRK-REAR', 'PART-SPK-PLUG', 'PART-COOL-GRN', 'PART-WIPER-24'
    ];
    for (const code of mockCodes) {
      const item = queryOne("SELECT id FROM inventory WHERE code = ?", [code]);
      if (item) {
        // Disassociate from historical invoice items so mock part can be safely purged
        runQuery("UPDATE invoice_items SET inventory_id = NULL WHERE inventory_id = ?", [item.id]);
        runQuery("DELETE FROM inventory WHERE id = ?", [item.id]);
      }
    }

    persistSqlJs();
  } catch (err) {
    console.warn('[DB] Legacy mock data cleanup notice:', err.message);
  }
}

// ----------------------------------------------------
// Secure User & Authentication Operations
// ----------------------------------------------------
function hasAnyUser() {
  const row = queryOne("SELECT COUNT(*) as count FROM users");
  return !!(row && row.count > 0);
}

function createInitialUser({ name, email, password }) {
  if (hasAnyUser()) {
    throw new Error('An administrator account already exists. Please sign in.');
  }
  if (!email || !email.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = (name || '').trim() || 'Administrator';
  const { hash, salt } = hashPassword(password);
  const recoveryKey = generateRecoveryKey();
  const { hash: recHash, salt: recSalt } = hashPassword(recoveryKey.replace(/-/g, '').toUpperCase());

  const res = runInsert(`
    INSERT INTO users (username, email, password_hash, salt, name, role, recovery_key_hash, recovery_key_salt)
    VALUES (?, ?, ?, ?, ?, 'Owner', ?, ?)
  `, [cleanEmail, cleanEmail, hash, salt, cleanName, recHash, recSalt]);

  const userId = res.lastInsertRowid;
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  runQuery(`INSERT INTO user_sessions (user_id, token, expires_at) VALUES (?, ?, ?)`, [userId, token, expiresAt]);
  persistSqlJs();

  return {
    success: true,
    recoveryKey,
    user: {
      id: userId,
      name: cleanName,
      email: cleanEmail,
      role: 'Owner',
      token
    }
  };
}

function authenticateUser(email, password) {
  if (!email || !password) {
    return { success: false, message: 'Please enter both your email and password.' };
  }
  const cleanEmail = email.trim().toLowerCase();
  const user = queryOne("SELECT * FROM users WHERE email = ? COLLATE NOCASE", [cleanEmail]);
  if (!user) {
    return { success: false, message: 'Invalid email or password.' };
  }

  const valid = verifyPassword(password, user.password_hash, user.salt);
  if (!valid) {
    return { success: false, message: 'Invalid email or password.' };
  }

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  runQuery(`INSERT INTO user_sessions (user_id, token, expires_at) VALUES (?, ?, ?)`, [user.id, token, expiresAt]);
  persistSqlJs();

  return {
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      token
    }
  };
}

function validateSession(token) {
  if (!token) return null;
  const session = queryOne(`
    SELECT s.token, s.expires_at, u.id, u.name, u.email, u.role
    FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
  `, [token]);

  if (!session) return null;
  return {
    id: session.id,
    name: session.name,
    email: session.email,
    role: session.role,
    token: session.token
  };
}

function logoutSession(token) {
  if (token) {
    runQuery("DELETE FROM user_sessions WHERE token = ?", [token]);
    persistSqlJs();
  }
  return { success: true };
}

function changePassword({ userId, currentPassword, newPassword }) {
  if (!userId || !currentPassword || !newPassword) {
    throw new Error('All fields are required.');
  }
  if (newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters long.');
  }
  const user = queryOne("SELECT * FROM users WHERE id = ?", [userId]);
  if (!user) throw new Error('User not found.');

  const valid = verifyPassword(currentPassword, user.password_hash, user.salt);
  if (!valid) throw new Error('Current password is incorrect.');

  const { hash, salt } = hashPassword(newPassword);
  runQuery("UPDATE users SET password_hash = ?, salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [hash, salt, userId]);
  
  // Invalidate past sessions
  runQuery("DELETE FROM user_sessions WHERE user_id = ?", [userId]);
  const newToken = generateSecureToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  runQuery("INSERT INTO user_sessions (user_id, token, expires_at) VALUES (?, ?, ?)", [userId, newToken, expiresAt]);
  persistSqlJs();

  return { success: true, token: newToken };
}

function resetPasswordWithRecoveryKey({ email, recoveryKey, newPassword }) {
  if (!email || !recoveryKey || !newPassword) {
    throw new Error('Email, recovery key, and new password are required.');
  }
  if (newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters long.');
  }
  const cleanEmail = email.trim().toLowerCase();
  const user = queryOne("SELECT * FROM users WHERE email = ? COLLATE NOCASE", [cleanEmail]);
  if (!user) throw new Error('No account found associated with this email.');

  const cleanKey = recoveryKey.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const valid = verifyPassword(cleanKey, user.recovery_key_hash, user.recovery_key_salt);
  if (!valid) throw new Error('Invalid recovery key for this account.');

  const { hash, salt } = hashPassword(newPassword);
  const newRecoveryKey = generateRecoveryKey();
  const { hash: recHash, salt: recSalt } = hashPassword(newRecoveryKey.replace(/-/g, '').toUpperCase());

  runQuery("UPDATE users SET password_hash = ?, salt = ?, recovery_key_hash = ?, recovery_key_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [hash, salt, recHash, recSalt, user.id]);
  runQuery("DELETE FROM user_sessions WHERE user_id = ?", [user.id]);
  
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  runQuery("INSERT INTO user_sessions (user_id, token, expires_at) VALUES (?, ?, ?) ", [user.id, token, expiresAt]);
  persistSqlJs();

  return {
    success: true,
    newRecoveryKey,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      token
    }
  };
}

function updateUserProfile({ userId, name, email }) {
  if (!userId) return { success: false };
  const cleanName = (name || '').trim();
  if (email) {
    const cleanEmail = email.trim().toLowerCase();
    runQuery("UPDATE users SET name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [cleanName, cleanEmail, userId]);
  } else {
    runQuery("UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [cleanName, userId]);
  }
  persistSqlJs();
  return { success: true, user: { id: userId, name: cleanName } };
}

// Low-level DB helpers
function queryAll(sql, params = []) {
  if (!isSqlJs) {
    const stmt = db.prepare(sql);
    return stmt.all(...params);
  } else {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function runQuery(sql, params = []) {
  if (!isSqlJs) {
    const stmt = db.prepare(sql);
    const res = stmt.run(...params);
    return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
  } else {
    db.run(sql, params);
    persistSqlJs();
    const row = queryOne("SELECT last_insert_rowid() AS id, changes() AS ch");
    return { changes: row ? row.ch : 1, lastInsertRowid: row ? row.id : 0 };
  }
}

function runInsert(sql, params = []) {
  return runQuery(sql, params);
}

// ----------------------------------------------------
// Public API Methods for IPC
// ----------------------------------------------------

// 1. Dashboard
function getDashboardStats() {
  // Today's revenue: sum of payments made today.
  // Timestamps are stored as UTC ("YYYY-MM-DD HH:MM:SS"), so convert them to
  // local time before comparing dates; otherwise early-morning payments in
  // positive-offset timezones are counted on the previous day.
  const revenueTodayRow = queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS revenue 
    FROM payments 
    WHERE date(replace(substr(payment_date, 1, 19), 'T', ' '), 'localtime') = date('now', 'localtime')
  `) || { revenue: 0 };

  // Total outstanding balance across all invoices
  const outstandingRow = queryOne(`
    SELECT COALESCE(SUM(balance_amount), 0) AS outstanding 
    FROM invoices 
    WHERE status != 'Paid'
  `) || { outstanding: 0 };

  // All-time revenue: every payment ever recorded, not just today's.
  const revenueTotalRow = queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS revenue FROM payments
  `) || { revenue: 0 };

  // Total number of invoices ever generated.
  const invoicesRow = queryOne(`SELECT COUNT(*) AS total FROM invoices`) || { total: 0 };

  // Total stock value and units held. Uses the purchase price when it is set,
  // otherwise falls back to the selling price (same rule as the Inventory tab).
  const inventoryRow = queryOne(`
    SELECT
      COUNT(*) AS items,
      COALESCE(SUM(quantity), 0) AS units,
      COALESCE(SUM(quantity * (
        CASE WHEN purchase_price > 0 THEN purchase_price ELSE COALESCE(selling_price, 0) END
      )), 0) AS value
    FROM inventory
  `) || { items: 0, units: 0, value: 0 };

  // Total active customers
  const customersRow = queryOne(`SELECT COUNT(*) AS total FROM customers`) || { total: 0 };

  // Low stock count (quantity <= min_quantity)
  const lowStockRow = queryOne(`
    SELECT COUNT(*) AS count 
    FROM inventory 
    WHERE quantity <= min_quantity
  `) || { count: 0 };

  // Recent transactions (last 6 payments or invoices)
  const recentPayments = queryAll(`
    SELECT p.id, p.invoice_id, p.amount, p.payment_method, p.payment_date,
           i.invoice_no, c.name as customer_name
    FROM payments p
    JOIN invoices i ON p.invoice_id = i.id
    JOIN customers c ON p.customer_id = c.id
    ORDER BY p.payment_date DESC
    LIMIT 6
  `);

  return {
    todayRevenue: revenueTodayRow.revenue,
    totalRevenue: revenueTotalRow.revenue,
    outstandingPayments: outstandingRow.outstanding,
    totalCustomers: customersRow.total,
    totalInvoices: invoicesRow.total,
    totalInventoryItems: inventoryRow.items,
    totalStockUnits: inventoryRow.units,
    inventoryValue: inventoryRow.value,
    lowStockCount: lowStockRow.count,
    recentPayments
  };
}

// Revenue detail view: every figure is derived from existing payments and
// invoices, so opening the page never writes or migrates anything.
function getRevenueBreakdown() {
  const collectedRow = queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS collected, COUNT(*) AS payments
    FROM payments
  `) || { collected: 0, payments: 0 };

  const invoicedRow = queryOne(`
    SELECT COALESCE(SUM(total_amount), 0) AS invoiced,
           COALESCE(SUM(balance_amount), 0) AS outstanding,
           COALESCE(AVG(total_amount), 0) AS avgInvoice,
           COUNT(*) AS invoices
    FROM invoices
  `) || { invoiced: 0, outstanding: 0, avgInvoice: 0, invoices: 0 };

  // Payment-method split (Cash / Online / anything custom entered by the user)
  const methodRows = queryAll(`
    SELECT COALESCE(NULLIF(TRIM(payment_method), ''), 'Unspecified') AS method,
           COALESCE(SUM(amount), 0) AS amount,
           COUNT(*) AS count
    FROM payments
    GROUP BY method
    ORDER BY amount DESC
  `);

  // Monthly collected totals. Timestamps are stored in UTC, so convert them to
  // local time before grouping, exactly like the dashboard does.
  const monthlyRows = queryAll(`
    SELECT strftime('%Y-%m', replace(substr(payment_date, 1, 19), 'T', ' '), 'localtime') AS month,
           COALESCE(SUM(amount), 0) AS amount,
           COUNT(*) AS count
    FROM payments
    WHERE payment_date IS NOT NULL AND payment_date != ''
    GROUP BY month
    ORDER BY month
  `);
  const monthlyMap = new Map();
  (monthlyRows || []).forEach(row => {
    if (row && row.month) monthlyMap.set(row.month, row);
  });

  // Always return a full 12-month window so the chart has a stable shape.
  const monthly = [];
  const now = new Date();
  for (let offset = 11; offset >= 0; offset--) {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const hit = monthlyMap.get(key);
    monthly.push({
      month: key,
      label: d.toLocaleString('en-US', { month: 'short' }),
      year: d.getFullYear(),
      amount: hit ? hit.amount : 0,
      count: hit ? hit.count : 0
    });
  }

  // Revenue mix by invoice value: spare parts, labour charges and custom lines.
  const partsRow = queryOne(`
    SELECT COALESCE(SUM(CASE WHEN inventory_id IS NOT NULL THEN total_price ELSE 0 END), 0) AS parts,
           COALESCE(SUM(CASE WHEN inventory_id IS NULL THEN total_price ELSE 0 END), 0) AS custom
    FROM invoice_items
  `) || { parts: 0, custom: 0 };
  const labourRow = queryOne(`
    SELECT COALESCE(SUM(labour_charges), 0) AS labour FROM invoices
  `) || { labour: 0 };

  const statusRows = queryAll(`
    SELECT status,
           COUNT(*) AS count,
           COALESCE(SUM(total_amount), 0) AS amount,
           COALESCE(SUM(balance_amount), 0) AS balance
    FROM invoices
    GROUP BY status
  `);

  const topCustomerRows = queryAll(`
    SELECT p.customer_id,
           COALESCE(c.name, i.customer_name, 'Walk-in Customer') AS customer_name,
           COALESCE(c.vehicle_no, i.vehicle_no, '') AS vehicle_no,
           COALESCE(SUM(p.amount), 0) AS amount,
           COUNT(DISTINCT p.invoice_id) AS invoices
    FROM payments p
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    GROUP BY p.customer_id
    ORDER BY amount DESC
    LIMIT 5
  `);

  const recentPayments = queryAll(`
    SELECT p.id, p.invoice_id, p.amount, p.payment_method, p.reference_no, p.payment_date,
           i.invoice_no, i.customer_name
    FROM payments p
    LEFT JOIN invoices i ON i.id = p.invoice_id
    ORDER BY p.payment_date DESC, p.id DESC
    LIMIT 8
  `);

  const collected = collectedRow.collected || 0;
  const invoiced = invoicedRow.invoiced || 0;

  // Allocate the money actually collected across parts / labour / custom lines
  // using each invoice's own composition. This keeps the split honest even when
  // an invoice was only partially paid.
  const compositionRows = queryAll(`
    SELECT i.id,
           COALESCE(i.labour_charges, 0) AS labour,
           COALESCE(SUM(CASE WHEN it.inventory_id IS NOT NULL THEN it.total_price ELSE 0 END), 0) AS parts,
           COALESCE(SUM(CASE WHEN it.inventory_id IS NULL THEN it.total_price ELSE 0 END), 0) AS custom
    FROM invoices i
    LEFT JOIN invoice_items it ON it.invoice_id = i.id
    GROUP BY i.id
  `);
  const paidRows = queryAll(`
    SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid
    FROM payments
    GROUP BY invoice_id
  `);
  const paidMap = new Map((paidRows || []).map(row => [row.invoice_id, row.paid]));

  const collectedSplit = { parts: 0, labour: 0, custom: 0 };
  (compositionRows || []).forEach(row => {
    const paid = paidMap.get(row.id) || 0;
    if (!paid) return;
    const base = (row.parts || 0) + (row.labour || 0) + (row.custom || 0);
    if (base <= 0) return;
    collectedSplit.parts += paid * ((row.parts || 0) / base);
    collectedSplit.labour += paid * ((row.labour || 0) / base);
    collectedSplit.custom += paid * ((row.custom || 0) / base);
  });
  const allocated = collectedSplit.parts + collectedSplit.labour + collectedSplit.custom;
  // Anything paid against an invoice with no priced lines (rare) stays visible
  // instead of silently disappearing from the split.
  collectedSplit.unallocated = Math.max(0, collected - allocated);

  return {
    collected,
    invoiced,
    outstanding: invoicedRow.outstanding || 0,
    avgInvoice: invoicedRow.avgInvoice || 0,
    invoiceCount: invoicedRow.invoices || 0,
    paymentCount: collectedRow.payments || 0,
    collectionRate: invoiced > 0 ? Math.min(100, (collected / invoiced) * 100) : 0,
    methods: methodRows || [],
    monthly,
    mix: {
      parts: partsRow.parts || 0,
      labour: labourRow.labour || 0,
      custom: partsRow.custom || 0
    },
    collectedSplit,
    statuses: statusRows || [],
    topCustomers: topCustomerRows || [],
    recentPayments: recentPayments || []
  };
}

// 2. Customers
function getCustomers(search = '') {
  let sql = `
    SELECT c.*,
      COALESCE(SUM(i.total_amount), 0) AS total_purchases,
      COALESCE(SUM(i.balance_amount), 0) AS outstanding_balance,
      COUNT(i.id) AS total_invoices
    FROM customers c
    LEFT JOIN invoices i ON c.id = i.customer_id
  `;
  const params = [];
  if (search && search.trim()) {
    sql += ` WHERE c.name LIKE ? OR c.phone LIKE ? OR c.vehicle_no LIKE ? `;
    const q = `%${search.trim()}%`;
    params.push(q, q, q);
  }
  sql += ` GROUP BY c.id ORDER BY c.id DESC`;
  return queryAll(sql, params);
}

function getCustomerById(id) {
  const customer = queryOne(`SELECT * FROM customers WHERE id = ?`, [id]);
  if (!customer) return null;

  const invoices = queryAll(`
    SELECT * FROM invoices 
    WHERE customer_id = ? 
    ORDER BY created_at DESC
  `, [id]);

  const payments = queryAll(`
    SELECT p.*, i.invoice_no 
    FROM payments p
    JOIN invoices i ON p.invoice_id = i.id
    WHERE p.customer_id = ? 
    ORDER BY p.payment_date DESC
  `, [id]);

  const stats = queryOne(`
    SELECT 
      COALESCE(SUM(total_amount), 0) AS total_spent,
      COALESCE(SUM(balance_amount), 0) AS current_balance
    FROM invoices WHERE customer_id = ?
  `, [id]);

  return {
    ...customer,
    totalSpent: stats.total_spent,
    outstandingBalance: stats.current_balance,
    invoices,
    payments
  };
}

function saveCustomer(data) {
  if (data.id) {
    runQuery(`
      UPDATE customers 
      SET name = ?, phone = ?, email = ?, vehicle_no = ?, vehicle_model = ?, notes = ?
      WHERE id = ?
    `, [data.name, data.phone, data.email || '', data.vehicle_no || '', data.vehicle_model || '', data.notes || '', data.id]);
    return { success: true, id: data.id };
  } else {
    const res = runInsert(`
      INSERT INTO customers (name, phone, email, vehicle_no, vehicle_model, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [data.name, data.phone, data.email || '', data.vehicle_no || '', data.vehicle_model || '', data.notes || '']);
    return { success: true, id: res.lastInsertRowid };
  }
}

function deleteCustomer(id) {
  // Check if invoices exist
  const inv = queryOne(`SELECT COUNT(*) as count FROM invoices WHERE customer_id = ?`, [id]);
  if (inv && inv.count > 0) {
    throw new Error('Cannot delete customer with existing invoices or billing history.');
  }
  runQuery(`DELETE FROM customers WHERE id = ?`, [id]);
  return { success: true };
}

// 3. Inventory
function getInventory(search = '') {
  let sql = `SELECT * FROM inventory`;
  const params = [];
  if (search && search.trim()) {
    sql += ` WHERE name LIKE ? OR code LIKE ? OR category LIKE ?`;
    const q = `%${search.trim()}%`;
    params.push(q, q, q);
  }
  sql += ` ORDER BY name ASC`;
  return queryAll(sql, params);
}

function getInventoryById(id) {
  return queryOne(`SELECT * FROM inventory WHERE id = ?`, [id]);
}

function saveInventoryItem(data) {
  if (data.id) {
    // Check code uniqueness
    const existing = queryOne(`SELECT id FROM inventory WHERE code = ? AND id != ?`, [data.code, data.id]);
    if (existing) throw new Error(`Item code "${data.code}" is already in use.`);

    runQuery(`
      UPDATE inventory 
      SET code = ?, name = ?, category = ?, quantity = ?, min_quantity = ?, purchase_price = ?, selling_price = ?, location = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [data.code, data.name, data.category || 'General', parseInt(data.quantity) || 0, parseInt(data.min_quantity) || 5, parseFloat(data.purchase_price) || 0, parseFloat(data.selling_price) || 0, data.location || '', data.id]);
    return { success: true, id: data.id };
  } else {
    const existing = queryOne(`SELECT id FROM inventory WHERE code = ?`, [data.code]);
    if (existing) throw new Error(`Item code "${data.code}" already exists.`);

    const res = runInsert(`
      INSERT INTO inventory (code, name, category, quantity, min_quantity, purchase_price, selling_price, location, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [data.code, data.name, data.category || 'General', parseInt(data.quantity) || 0, parseInt(data.min_quantity) || 5, parseFloat(data.purchase_price) || 0, parseFloat(data.selling_price) || 0, data.location || '']);
    return { success: true, id: res.lastInsertRowid };
  }
}

function adjustStock(id, deltaQuantity, reason = '') {
  const item = queryOne(`SELECT * FROM inventory WHERE id = ?`, [id]);
  if (!item) throw new Error('Item not found.');
  const newQty = item.quantity + deltaQuantity;
  if (newQty < 0) throw new Error(`Stock cannot be reduced below 0. Current stock: ${item.quantity}`);

  runQuery(`UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newQty, id]);
  return { success: true, newQuantity: newQty };
}

function deleteInventoryItem(id) {
  // Check if item is used in any invoice
  const used = queryOne(`SELECT COUNT(*) as count FROM invoice_items WHERE inventory_id = ?`, [id]);
  if (used && used.count > 0) {
    throw new Error('Cannot delete inventory item associated with past invoices.');
  }
  runQuery(`DELETE FROM inventory WHERE id = ?`, [id]);
  return { success: true };
}

// 4. Billing & Invoices
function generateNextInvoiceNumber() {
  const latest = queryOne(`
    SELECT invoice_no FROM invoices 
    WHERE invoice_no LIKE 'TPS-%' OR invoice_no LIKE 'tps [%' 
    ORDER BY id DESC LIMIT 1
  `);

  if (!latest) {
    return 'TPS-1';
  }
  // Support both TPS-1 and legacy tps [1] pattern match
  const match = latest.invoice_no.match(/(?:TPS-|tps\s*\[)(\d+)\]?/i);
  const seq = match ? parseInt(match[1], 10) : 0;
  return `TPS-${seq + 1}`;
}

function createInvoice(billData) {
  return runInTransaction(() => {
    const customer = queryOne(`SELECT * FROM customers WHERE id = ?`, [billData.customerId]);
    if (!customer) throw new Error('Customer not found');

    const invoiceNo = billData.invoiceNo || generateNextInvoiceNumber();
    const rawItems = Array.isArray(billData.items) ? billData.items : [];

    // Normalize items first. Totals are recalculated on the server instead of
    // trusting whatever the renderer sent, so an invoice can never be saved
    // with a total that does not match its own line items.
    const items = rawItems.map(item => {
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const unitPrice = parseFloat(item.unitPrice) || 0;
      return {
        inventoryId: item.inventoryId ? parseInt(item.inventoryId, 10) : null,
        itemCode: item.itemCode || '',
        description: item.description || '',
        quantity: qty,
        unitPrice,
        totalPrice: qty * unitPrice
      };
    });

    // Validate stock with aggregate quantities. Two separate lines for the
    // same part must not each pass the check while their sum exceeds stock.
    const requestedByInventory = new Map();
    for (const item of items) {
      if (!item.inventoryId) continue;
      requestedByInventory.set(
        item.inventoryId,
        (requestedByInventory.get(item.inventoryId) || 0) + item.quantity
      );
    }
    for (const [inventoryId, requestedQty] of requestedByInventory.entries()) {
      const invItem = queryOne(`SELECT * FROM inventory WHERE id = ?`, [inventoryId]);
      if (!invItem) {
        throw new Error(`Inventory item with ID ${inventoryId} not found.`);
      }
      if (invItem.quantity < requestedQty) {
        throw new Error(`Insufficient stock for "${invItem.name}". Available: ${invItem.quantity}, Requested: ${requestedQty}`);
      }
    }

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
    const labour = parseFloat(billData.labourCharges) || 0;
    const discount = parseFloat(billData.discount) || 0;
    const tax = parseFloat(billData.tax) || 0;
    const totalAmount = Math.max(0, subtotal + labour + tax - discount);
    const initialPayment = parseFloat(billData.initialPayment) || 0;

    if (initialPayment > totalAmount + 0.001) {
      throw new Error('Initial payment cannot be greater than the invoice total.');
    }

    const balance = Math.max(0, totalAmount - initialPayment);
    let status = 'Unpaid';
    if (balance <= 0.001) {
      status = 'Paid';
    } else if (initialPayment > 0) {
      status = 'Partial';
    }

    // Insert Invoice
    const res = runInsert(`
      INSERT INTO invoices (
        invoice_no, customer_id, customer_name, customer_phone,
        vehicle_no, vehicle_model, subtotal, labour_charges, discount,
        tax, total_amount, paid_amount, balance_amount, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      invoiceNo,
      customer.id,
      customer.name,
      customer.phone,
      billData.vehicleNo || customer.vehicle_no || '',
      billData.vehicleModel || customer.vehicle_model || '',
      subtotal,
      labour,
      discount,
      tax,
      totalAmount,
      initialPayment,
      balance,
      status,
      billData.notes || ''
    ]);

    const invoiceId = res.lastInsertRowid;

    // Insert items and deduct stock
    for (const item of items) {
      runQuery(`
        INSERT INTO invoice_items (invoice_id, inventory_id, item_code, description, quantity, unit_price, total_price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        invoiceId,
        item.inventoryId || null,
        item.itemCode,
        item.description,
        item.quantity,
        item.unitPrice,
        item.totalPrice
      ]);

      // Automatically deduct inventory stock if linked
      if (item.inventoryId) {
        runQuery(`
          UPDATE inventory 
          SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [item.quantity, item.inventoryId]);
      }
    }

    // Record initial payment if provided
    if (initialPayment > 0) {
      runQuery(`
        INSERT INTO payments (invoice_id, customer_id, amount, payment_method, reference_no, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        invoiceId,
        customer.id,
        initialPayment,
        billData.paymentMethod || 'Cash',
        billData.paymentReference || '',
        'Initial payment upon billing'
      ]);
    }

    return { success: true, invoiceId, invoiceNo };
  });
}

function getInvoices(filter = {}) {
  let sql = `
    SELECT i.*, 
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
    FROM invoices i
  `;
  const conditions = [];
  const params = [];

  if (filter.status && filter.status !== 'All') {
    conditions.push(`i.status = ?`);
    params.push(filter.status);
  }

  if (filter.search && filter.search.trim()) {
    conditions.push(`(i.invoice_no LIKE ? OR i.customer_name LIKE ? OR i.customer_phone LIKE ? OR i.vehicle_no LIKE ?)`);
    const q = `%${filter.search.trim()}%`;
    params.push(q, q, q, q);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(' AND ');
  }

  sql += ` ORDER BY i.created_at DESC`;
  return queryAll(sql, params);
}

function getInvoiceDetails(invoiceId) {
  const invoice = queryOne(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
  if (!invoice) return null;

  const items = queryAll(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [invoiceId]);
  const payments = queryAll(`SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date DESC`, [invoiceId]);
  const customer = queryOne(`SELECT * FROM customers WHERE id = ?`, [invoice.customer_id]);

  return {
    ...invoice,
    items,
    payments,
    customer
  };
}

// 5. Payments
function recordPayment(data) {
  return runInTransaction(() => {
    const invoice = queryOne(`SELECT * FROM invoices WHERE id = ?`, [data.invoiceId]);
    if (!invoice) throw new Error('Invoice not found.');

    const paymentAmount = parseFloat(data.amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      throw new Error('Payment amount must be greater than 0.');
    }

    if (paymentAmount > (invoice.balance_amount + 0.001)) {
      throw new Error(`Payment cannot exceed outstanding balance of Rs. ${invoice.balance_amount.toFixed(2)}.`);
    }

    // Insert payment record
    runInsert(`
      INSERT INTO payments (invoice_id, customer_id, amount, payment_method, reference_no, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      invoice.id,
      invoice.customer_id,
      paymentAmount,
      data.paymentMethod || 'Cash',
      data.referenceNo || '',
      data.notes || ''
    ]);

    // Update invoice balance and status
    const newPaid = invoice.paid_amount + paymentAmount;
    const newBalance = Math.max(0, invoice.total_amount - newPaid);
    const newStatus = newBalance <= 0.001 ? 'Paid' : 'Partial';

    runQuery(`
      UPDATE invoices 
      SET paid_amount = ?, balance_amount = ?, status = ?
      WHERE id = ?
    `, [newPaid, newBalance, newStatus, invoice.id]);

    return {
      success: true,
      newBalance,
      newStatus,
      newPaid
    };
  });
}

function getAllPayments(search = '') {
  let sql = `
    SELECT p.*, i.invoice_no, i.total_amount as invoice_total, c.name as customer_name, c.phone as customer_phone
    FROM payments p
    JOIN invoices i ON p.invoice_id = i.id
    JOIN customers c ON p.customer_id = c.id
  `;
  const params = [];
  if (search && search.trim()) {
    sql += ` WHERE i.invoice_no LIKE ? OR c.name LIKE ? OR p.reference_no LIKE ?`;
    const q = `%${search.trim()}%`;
    params.push(q, q, q);
  }
  sql += ` ORDER BY p.payment_date DESC`;
  return queryAll(sql, params);
}

// Backup & Restore
async function backupDatabase(destPath) {
  if (!db || !dbPath) throw new Error('Database is not open.');

  // Never allow a backup to be written on top of the live database.
  if (path.resolve(destPath) === path.resolve(dbPath)) {
    throw new Error('Please choose a different filename for the backup.');
  }

  if (isSqlJs) {
    persistSqlJs();
    if (!fs.existsSync(dbPath)) throw new Error('Database file not found.');
    fs.copyFileSync(dbPath, destPath);
    return { success: true, path: destPath };
  }

  if (!fs.existsSync(dbPath)) throw new Error('Database file not found.');

  // WAL mode means recent commits may only exist in the -wal file. Use
  // better-sqlite3's online backup API (or checkpoint first) so the exported
  // file contains every committed transaction.
  if (typeof db.backup === 'function') {
    await db.backup(destPath);
  } else {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    fs.copyFileSync(dbPath, destPath);
  }
  return { success: true, path: destPath };
}

function exportToExcel(destPath) {
  const customers = queryAll(`SELECT * FROM customers ORDER BY id DESC`);
  const inventory = queryAll(`SELECT * FROM inventory ORDER BY name ASC`);
  const invoices = queryAll(`SELECT * FROM invoices ORDER BY id DESC`);
  const payments = queryAll(`SELECT * FROM payments ORDER BY id DESC`);
  const items = queryAll(`SELECT * FROM invoice_items ORDER BY id DESC`);

  const escapeXml = (str) => {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  const createSheet = (sheetName, headers, rows) => {
    let xml = `<Worksheet ss:Name="${escapeXml(sheetName)}"><Table>`;
    // Header row
    xml += '<Row ss:StyleID="HeaderStyle">';
    headers.forEach(h => {
      xml += `<Cell><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`;
    });
    xml += '</Row>';
    // Data rows
    rows.forEach(r => {
      xml += '<Row>';
      r.forEach(val => {
        if (typeof val === 'number') {
          xml += `<Cell><Data ss:Type="Number">${val}</Data></Cell>`;
        } else {
          xml += `<Cell><Data ss:Type="String">${escapeXml(val == null ? '' : val)}</Data></Cell>`;
        }
      });
      xml += '</Row>';
    });
    xml += '</Table></Worksheet>';
    return xml;
  };

  // 1. Customers sheet
  const custHeaders = ['ID', 'Name', 'Phone', 'Email', 'Vehicle No', 'Vehicle Model', 'Notes', 'Created At'];
  const custRows = customers.map(c => [c.id, c.name, c.phone, c.email || '', c.vehicle_no || '', c.vehicle_model || '', c.notes || '', c.created_at || '']);

  // 2. Inventory sheet
  const invHeaders = ['ID', 'Item Code', 'Item Name', 'Category', 'Stock Qty', 'Min Qty Alert', 'Purchase Cost (Rs.)', 'Selling Price (Rs.)', 'Storage Location', 'Updated At'];
  const invRows = inventory.map(i => [i.id, i.code, i.name, i.category || '', i.quantity, i.min_quantity, i.purchase_price, i.selling_price, i.location || '', i.updated_at || '']);

  // 3. Invoices sheet
  const invoiceHeaders = ['ID', 'Invoice No', 'Customer Name', 'Phone', 'Date', 'Subtotal (Rs.)', 'Labour (Rs.)', 'Discount (Rs.)', 'Total Amount (Rs.)', 'Paid Amount (Rs.)', 'Balance Due (Rs.)', 'Status', 'Notes'];
  const invoiceRows = invoices.map(i => [i.id, i.invoice_no, i.customer_name, i.customer_phone || '', i.created_at, i.subtotal, i.labour_charges, i.discount, i.total_amount, i.paid_amount, i.balance_amount, i.status, i.notes || '']);

  // 4. Payments sheet
  const payHeaders = ['Payment ID', 'Invoice ID', 'Customer ID', 'Amount (Rs.)', 'Payment Method', 'Reference No', 'Payment Date', 'Notes'];
  const payRows = payments.map(p => [p.id, p.invoice_id, p.customer_id, p.amount, p.payment_method, p.reference_no || '', p.payment_date, p.notes || '']);

  // 5. Invoice Items sheet
  const itemHeaders = ['Item ID', 'Invoice ID', 'Part Code', 'Description', 'Quantity', 'Unit Price (Rs.)', 'Total Price (Rs.)'];
  const itemRows = items.map(it => [it.id, it.invoice_id, it.item_code || '', it.description, it.quantity, it.unit_price, it.total_price]);

  const excelXml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#000000"/>
  </Style>
  <Style ss:ID="HeaderStyle">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#FFFFFF" ss:Bold="1"/>
   <Interior ss:Color="#2563EB" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
 </Styles>
 ${createSheet('Invoices', invoiceHeaders, invoiceRows)}
 ${createSheet('Customers', custHeaders, custRows)}
 ${createSheet('Inventory Stock', invHeaders, invRows)}
 ${createSheet('Payments', payHeaders, payRows)}
 ${createSheet('Invoice Items', itemHeaders, itemRows)}
</Workbook>`;

  fs.writeFileSync(destPath, excelXml, 'utf-8');
  return { success: true, path: destPath };
}

function reopenDatabase() {
  if (isSqlJs) {
    if (!SQLInstance) throw new Error('SQL engine is not ready.');
    const filebuffer = fs.readFileSync(dbPath);
    db = new SQLInstance.Database(filebuffer);
    db.run("PRAGMA foreign_keys = ON;");
  } else {
    const Database = require('better-sqlite3');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
}

function isSqliteFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    const read = fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    return read === 16 && header.toString('utf8') === 'SQLite format 3\u0000';
  } catch (_) {
    return false;
  }
}

function databaseIntegrityOk() {
  try {
    if (!isSqlJs) {
      const rows = db.pragma('integrity_check');
      return !!(rows && rows[0] && rows[0].integrity_check === 'ok');
    }
    const rows = queryAll('PRAGMA integrity_check');
    if (!rows || rows.length === 0) return false;
    const first = Object.values(rows[0])[0];
    return String(first).toLowerCase() === 'ok';
  } catch (_) {
    return false;
  }
}

function restoreDatabase(srcPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error('Source backup file does not exist.');
  }
  if (!dbPath) {
    throw new Error('Database is not open.');
  }
  if (path.resolve(srcPath) === path.resolve(dbPath)) {
    throw new Error('That is already the active database file.');
  }
  if (!isSqliteFile(srcPath)) {
    throw new Error('The selected file is not a valid SQLite backup.');
  }

  // Close first: this checkpoints any WAL content into the main file, so the
  // safety copy below is a consistent snapshot of the current database.
  try {
    if (db && typeof db.close === 'function') db.close();
  } catch (_) {}
  db = null;

  // Keep a safety copy of the current database before touching it. This is a
  // COPY, so the previous database is never deleted even if the restore fails.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyPath = `${dbPath}.pre-restore-${stamp}`;
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  try {
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, safetyPath);
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, `${safetyPath}-wal`);
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, `${safetyPath}-shm`);
  } catch (err) {
    // The live database was only closed, never modified, so simply reopen it.
    try { reopenDatabase(); } catch (_) {}
    throw new Error(`Could not create a safety backup before restoring: ${err.message}`);
  }

  try {
    // Stale WAL/SHM pages from the old database must not be replayed on top
    // of the restored file. Safety copies were made above.
    try { fs.unlinkSync(walPath); } catch (_) {}
    try { fs.unlinkSync(shmPath); } catch (_) {}

    fs.copyFileSync(srcPath, dbPath);
    reopenDatabase();

    if (!databaseIntegrityOk()) {
      throw new Error('The selected database failed SQLite integrity checks.');
    }

    // Add any tables/columns introduced in newer app versions without touching
    // existing rows.
    createSchema();

    return { success: true, safetyBackup: safetyPath };
  } catch (err) {
    // Roll back to the database that was active before this restore.
    try { if (db && typeof db.close === 'function') db.close(); } catch (_) {}
    db = null;
    try {
      if (fs.existsSync(safetyPath)) {
        fs.copyFileSync(safetyPath, dbPath);
        if (fs.existsSync(`${safetyPath}-wal`)) fs.copyFileSync(`${safetyPath}-wal`, walPath);
        if (fs.existsSync(`${safetyPath}-shm`)) fs.copyFileSync(`${safetyPath}-shm`, shmPath);
      }
      reopenDatabase();
    } catch (_) {}
    throw new Error(`Restore failed; your previous database was kept. ${err.message}`);
  }
}

function getTenantDataSnapshot() {
  if (!db) return null;
  try {
    const customers = queryAll("SELECT * FROM customers ORDER BY id ASC");
    const inventory = queryAll("SELECT * FROM inventory ORDER BY id ASC");
    const invoices = queryAll("SELECT * FROM invoices ORDER BY id ASC");
    const invoice_items = queryAll("SELECT * FROM invoice_items ORDER BY id ASC");
    const payments = queryAll("SELECT * FROM payments ORDER BY id ASC");

    const recordCount = customers.length + inventory.length + invoices.length + payments.length;

    return {
      version: Date.now(),
      recordCount,
      customers,
      inventory,
      invoices,
      invoice_items,
      payments
    };
  } catch (err) {
    console.error('[DB] Failed to generate tenant snapshot:', err.message);
    return null;
  }
}

function restoreTenantDataSnapshot(snapshot) {
  if (!db || !snapshot) return false;

  try {
    runInTransaction(() => {
      // Clear current operational tables
      runQuery("DELETE FROM payments");
      runQuery("DELETE FROM invoice_items");
      runQuery("DELETE FROM invoices");
      runQuery("DELETE FROM inventory");
      runQuery("DELETE FROM customers");

      // 1. Customers
      if (Array.isArray(snapshot.customers)) {
        for (const c of snapshot.customers) {
          runQuery(
            "INSERT INTO customers (id, name, phone, email, vehicle_no, vehicle_model, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [c.id, c.name, c.phone, c.email || '', c.vehicle_no || '', c.vehicle_model || '', c.notes || '', c.created_at || new Date().toISOString()]
          );
        }
      }

      // 2. Inventory
      if (Array.isArray(snapshot.inventory)) {
        for (const i of snapshot.inventory) {
          runQuery(
            "INSERT INTO inventory (id, code, name, category, quantity, min_quantity, purchase_price, selling_price, location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [i.id, i.code, i.name, i.category || 'General', i.quantity || 0, i.min_quantity || 5, i.purchase_price || 0, i.selling_price || 0, i.location || '', i.created_at || new Date().toISOString(), i.updated_at || new Date().toISOString()]
          );
        }
      }

      // 3. Invoices
      if (Array.isArray(snapshot.invoices)) {
        for (const inv of snapshot.invoices) {
          runQuery(
            "INSERT INTO invoices (id, invoice_no, customer_id, customer_name, customer_phone, vehicle_no, vehicle_model, subtotal, labour_charges, discount, tax, total_amount, paid_amount, balance_amount, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [inv.id, inv.invoice_no, inv.customer_id, inv.customer_name, inv.customer_phone || '', inv.vehicle_no || '', inv.vehicle_model || '', inv.subtotal || 0, inv.labour_charges || 0, inv.discount || 0, inv.tax || 0, inv.total_amount || 0, inv.paid_amount || 0, inv.balance_amount || 0, inv.status || 'Unpaid', inv.notes || '', inv.created_at || new Date().toISOString()]
          );
        }
      }

      // 4. Invoice Items
      if (Array.isArray(snapshot.invoice_items)) {
        for (const it of snapshot.invoice_items) {
          runQuery(
            "INSERT INTO invoice_items (id, invoice_id, inventory_id, item_code, description, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [it.id, it.invoice_id, it.inventory_id, it.item_code || '', it.description, it.quantity || 1, it.unit_price || 0, it.total_price || 0]
          );
        }
      }

      // 5. Payments
      if (Array.isArray(snapshot.payments)) {
        for (const p of snapshot.payments) {
          runQuery(
            "INSERT INTO payments (id, invoice_id, customer_id, amount, payment_method, reference_no, notes, payment_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [p.id, p.invoice_id, p.customer_id, p.amount || 0, p.payment_method || 'Cash', p.reference_no || '', p.notes || '', p.payment_date || new Date().toISOString()]
          );
        }
      }
    });

    console.log(`[DB] Restored snapshot successfully: ${snapshot.recordCount || 0} records.`);
    return true;
  } catch (err) {
    console.error('[DB] Failed to restore tenant snapshot:', err.message);
    throw err;
  }
}

function closeDatabase() {
  if (db) {
    try {
      if (typeof db.close === 'function') db.close();
    } catch (_) {}
    db = null;
    currentTenant = null;
    dbPath = null;
  }
}

module.exports = {
  initDatabase,
  closeDatabase,
  hasAnyUser,
  createInitialUser,
  authenticateUser,
  validateSession,
  logoutSession,
  changePassword,
  resetPasswordWithRecoveryKey,
  updateUserProfile,
  getDashboardStats,
  getRevenueBreakdown,
  getCustomers,
  getCustomerById,
  saveCustomer,
  deleteCustomer,
  getInventory,
  getInventoryById,
  saveInventoryItem,
  adjustStock,
  deleteInventoryItem,
  generateNextInvoiceNumber,
  createInvoice,
  getInvoices,
  getInvoiceDetails,
  recordPayment,
  getAllPayments,
  backupDatabase,
  exportToExcel,
  restoreDatabase,
  getTenantDataSnapshot,
  restoreTenantDataSnapshot
};
