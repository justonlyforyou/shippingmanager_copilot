/**
 * @fileoverview SQLite Database Core Module
 *
 * Centralized database management with automatic JSON migration.
 * Uses better-sqlite3 for synchronous, high-performance SQLite operations.
 *
 * Features:
 * - Per-user databases for data isolation
 * - Automatic schema creation and upgrades
 * - One-time JSON to SQLite migration
 * - Transaction support
 * - WAL mode for better concurrency
 *
 * @module server/database
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getAppBaseDir, isPackaged } = require('../config');

// Get native binding path for better-sqlite3
// In packaged mode, the .node file is in node_modules relative to app base dir
function getNativeBindingPath() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  }
  return undefined; // Use default resolution in development
}

const nativeBinding = getNativeBindingPath();
const Database = require('better-sqlite3');

// Database version for schema migrations
const DB_VERSION = 7;

// Accounts database version
const ACCOUNTS_DB_VERSION = 1;

// Cache of open database connections per user
const dbConnections = new Map();

// Accounts database connection (singleton)
let accountsDbConnection = null;

/**
 * Get the database directory path
 * @returns {string} Database directory path
 */
function getDbDir() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'userdata', 'database');
  }
  return path.join(__dirname, '..', '..', 'userdata', 'database');
}

/**
 * Get database file path for a user
 * @param {string} userId - User ID
 * @returns {string} Database file path
 */
function getDbPath(userId) {
  return path.join(getDbDir(), `${userId}.db`);
}

/**
 * Ensure database directory exists
 */
function ensureDbDir() {
  const dbDir = getDbDir();
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

/**
 * Create database schema
 * @param {Database} db - SQLite database instance
 */
function createSchema(db) {
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Metadata table for version tracking and migration state
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Transactions table (POD1) - Game API transactions
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      time INTEGER NOT NULL,
      context TEXT NOT NULL,
      cash INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(time)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_context ON transactions(context)`);

  // Autopilot log entries (POD2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      autopilot TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      details TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_autopilot_log_timestamp ON autopilot_log(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_autopilot_log_autopilot ON autopilot_log(autopilot)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_autopilot_log_status ON autopilot_log(status)`);

  // Vessel history departures (POD3)
  db.exec(`
    CREATE TABLE IF NOT EXISTS departures (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      autopilot TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT,
      vessel_id INTEGER,
      vessel_name TEXT,
      origin TEXT,
      destination TEXT,
      route_name TEXT,
      distance INTEGER,
      fuel_used INTEGER,
      income INTEGER,
      wear REAL,
      duration INTEGER,
      cargo TEXT,
      harbor_fee INTEGER DEFAULT 0,
      contribution_gained INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Add contribution_gained column if not exists (migration for existing DBs)
  try {
    db.exec('ALTER TABLE departures ADD COLUMN contribution_gained INTEGER DEFAULT 0');
  } catch {
    // Column already exists, ignore
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_departures_timestamp ON departures(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_departures_vessel_id ON departures(vessel_id)`);

  // Vessels metadata (synced from vessel history)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vessels (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type_name TEXT,
      last_synced_at INTEGER,
      newest_entry_at INTEGER DEFAULT 0,
      entry_count INTEGER DEFAULT 0
    )
  `);

  // Route hijacking risks
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_hijack_risks (
      route_key TEXT PRIMARY KEY,
      risk REAL NOT NULL
    )
  `);

  // Lookup table (POD4) - combines POD1, POD2, POD3
  db.exec(`
    CREATE TABLE IF NOT EXISTS lookup (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      pod1_id TEXT,
      pod2_id TEXT,
      pod3_id TEXT,
      pod1_timestamp INTEGER,
      pod2_timestamp INTEGER,
      pod3_timestamp INTEGER,
      pod2_vessel TEXT,
      pod3_vessel TEXT,
      cash INTEGER,
      cash_confirmed INTEGER DEFAULT 1,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      context TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lookup_timestamp ON lookup(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lookup_type ON lookup(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lookup_context ON lookup(context)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lookup_pod1_id ON lookup(pod1_id)`);

  // Sync progress for vessel history
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_progress (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // API stats (time series)
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      minute_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      total_duration INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      UNIQUE(minute_key, endpoint)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_stats_minute ON api_stats(minute_key)`);

  // Processed DM messages (chatbot deduplication)
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_dm_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_dm_message_id ON processed_dm_messages(message_id)`);

  // Trip data - unified store for harbor fees, contributions, departure data
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vessel_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      harbor_fee INTEGER,
      contribution_gained INTEGER,
      speed REAL,
      guards INTEGER,
      co2_used REAL,
      fuel_used REAL,
      capacity INTEGER,
      utilization REAL,
      dry_rate REAL,
      ref_rate REAL,
      fuel_rate REAL,
      crude_rate REAL,
      is_drydock_operation INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(vessel_id, timestamp)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trip_data_vessel_id ON trip_data(vessel_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trip_data_timestamp ON trip_data(timestamp)`);

  // Hijack cases - main case data
  db.exec(`
    CREATE TABLE IF NOT EXISTS hijack_cases (
      case_id INTEGER PRIMARY KEY,
      user_vessel_id INTEGER,
      vessel_name TEXT,
      danger_zone_slug TEXT,
      requested_amount INTEGER,
      paid_amount INTEGER,
      user_proposal INTEGER,
      has_negotiation INTEGER DEFAULT 0,
      round_end_time INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      registered_at INTEGER,
      resolved INTEGER DEFAULT 0,
      autopilot_resolved INTEGER DEFAULT 0,
      resolved_at REAL,
      cash_before INTEGER,
      cash_after INTEGER,
      payment_verified INTEGER DEFAULT 0,
      case_details_json TEXT,
      cached_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hijack_cases_status ON hijack_cases(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hijack_cases_resolved ON hijack_cases(resolved)`);

  // Hijack negotiation history - stores history events
  db.exec(`
    CREATE TABLE IF NOT EXISTS hijack_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL,
      timestamp REAL NOT NULL,
      autopilot_resolved INTEGER DEFAULT 0,
      resolved_at REAL,
      payment_verification_json TEXT,
      UNIQUE(case_id, type, timestamp)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hijack_history_case_id ON hijack_history(case_id)`);

  // Messenger chats - chat metadata
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_chats (
      chat_id INTEGER PRIMARY KEY,
      subject TEXT,
      is_new INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      last_message_at INTEGER,
      metadata_json TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messenger_chats_last_message ON messenger_chats(last_message_at DESC)`);

  // Messenger messages - individual messages per chat
  db.exec(`
    CREATE TABLE IF NOT EXISTS messenger_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_mine INTEGER DEFAULT 0,
      sender_user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES messenger_chats(chat_id),
      UNIQUE(chat_id, sender_user_id, created_at)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messenger_messages_chat_id ON messenger_messages(chat_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messenger_messages_created_at ON messenger_messages(created_at)`);

  // Vessel appearances - visual customization data
  db.exec(`
    CREATE TABLE IF NOT EXISTS vessel_appearances (
      vessel_id INTEGER PRIMARY KEY,
      name TEXT,
      vessel_model TEXT,
      capacity INTEGER,
      engine_type TEXT,
      engine_kw INTEGER,
      range INTEGER,
      speed INTEGER,
      fuel_consumption INTEGER,
      antifouling_model TEXT,
      bulbous INTEGER DEFAULT 0,
      enhanced_thrusters INTEGER DEFAULT 0,
      propeller_types TEXT,
      hull_color TEXT,
      deck_color TEXT,
      bridge_color TEXT,
      container_color_1 TEXT,
      container_color_2 TEXT,
      container_color_3 TEXT,
      container_color_4 TEXT,
      name_color TEXT,
      own_image TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vessel_appearances_model ON vessel_appearances(vessel_model)`);

  // Stock blacklist - prevents autopilot from re-buying sold stocks
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_blacklist (
      stock_user_id INTEGER PRIMARY KEY,
      company_name TEXT NOT NULL,
      sold_at INTEGER NOT NULL,
      reason TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_blacklist_sold_at ON stock_blacklist(sold_at)`);

  // Vessel route settings - stores preferred route settings to restore after drydock
  db.exec(`
    CREATE TABLE IF NOT EXISTS vessel_route_settings (
      vessel_id INTEGER PRIMARY KEY,
      route_id INTEGER,
      origin TEXT,
      destination TEXT,
      speed INTEGER NOT NULL,
      guards INTEGER DEFAULT 0,
      capacity_type TEXT,
      prices_dry INTEGER,
      prices_refrigerated INTEGER,
      prices_fuel INTEGER,
      prices_crude INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);

  // Port demand history - tracks demand changes over time for analytics
  db.exec(`
    CREATE TABLE IF NOT EXISTS port_demand_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      port_code TEXT NOT NULL,
      port_name TEXT,
      country TEXT,
      dry_demand INTEGER DEFAULT 0,
      dry_consumed INTEGER DEFAULT 0,
      refrigerated_demand INTEGER DEFAULT 0,
      refrigerated_consumed INTEGER DEFAULT 0,
      fuel_demand INTEGER DEFAULT 0,
      fuel_consumed INTEGER DEFAULT 0,
      crude_demand INTEGER DEFAULT 0,
      crude_consumed INTEGER DEFAULT 0,
      UNIQUE(timestamp, port_code)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_port_demand_history_timestamp ON port_demand_history(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_port_demand_history_port_code ON port_demand_history(port_code)`);

  // Add country column if not exists (migration for existing DBs)
  try {
    db.exec('ALTER TABLE port_demand_history ADD COLUMN country TEXT');
  } catch {
    // Column already exists, ignore
  }

  // Migration v6: Add UNIQUE constraint to hijack_history (case_id, type, timestamp)
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hijack_history'").get();
    if (tableExists) {
      // Check if we need to migrate (look for any unique index)
      const hasCorrectUnique = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='hijack_history' AND sql LIKE '%UNIQUE(case_id, type, timestamp)%'").get();
      if (!hasCorrectUnique) {
        logger.debug('[Database] Migrating hijack_history to add UNIQUE(case_id, type, timestamp)...');
        db.exec(`
          CREATE TABLE IF NOT EXISTS hijack_history_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            case_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            amount REAL,
            timestamp REAL NOT NULL,
            autopilot_resolved INTEGER DEFAULT 0,
            resolved_at REAL,
            payment_verification_json TEXT,
            UNIQUE(case_id, type, timestamp)
          )
        `);
        db.exec('INSERT OR IGNORE INTO hijack_history_new (case_id, type, amount, timestamp, autopilot_resolved, resolved_at, payment_verification_json) SELECT case_id, type, amount, timestamp, autopilot_resolved, resolved_at, payment_verification_json FROM hijack_history');
        db.exec('DROP TABLE hijack_history');
        db.exec('ALTER TABLE hijack_history_new RENAME TO hijack_history');
        db.exec('CREATE INDEX IF NOT EXISTS idx_hijack_history_case_id ON hijack_history(case_id)');
        logger.debug('[Database] hijack_history migration complete');
      }
    }
  } catch (err) {
    logger.error('[Database] Failed to migrate hijack_history:', err.message);
  }

  // Set database version
  const setVersion = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
  setVersion.run('db_version', String(DB_VERSION));
}

/**
 * Get or create database connection for a user
 * @param {string} userId - User ID
 * @returns {Database} SQLite database instance
 */
function getDb(userId) {
  if (dbConnections.has(userId)) {
    return dbConnections.get(userId);
  }

  ensureDbDir();
  const dbPath = getDbPath(userId);
  const isNew = !fs.existsSync(dbPath);

  // Pass nativeBinding option for packaged mode
  const dbOptions = nativeBinding ? { nativeBinding } : {};
  const db = new Database(dbPath, dbOptions);
  createSchema(db);

  if (isNew) {
    logger.info(`[Database] Created new database for user ${userId}`);
  }

  dbConnections.set(userId, db);
  return db;
}

/**
 * Close database connection for a user
 * @param {string} userId - User ID
 */
function closeDb(userId) {
  if (dbConnections.has(userId)) {
    const db = dbConnections.get(userId);
    db.close();
    dbConnections.delete(userId);
    logger.debug(`[Database] Closed database for user ${userId}`);
  }
}

/**
 * Close all database connections
 */
function closeAll() {
  for (const [userId, db] of dbConnections) {
    try {
      db.close();
    } catch (err) {
      logger.error(`[Database] Error closing database for user ${userId}:`, err);
    }
  }
  dbConnections.clear();
  logger.info('[Database] All connections closed');
}

/**
 * Check if migration from JSON has been completed
 * @param {string} userId - User ID
 * @returns {boolean} True if migration is complete
 */
function isMigrationComplete(userId) {
  const db = getDb(userId);
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('json_migration_complete');
  return row && row.value === 'true';
}

/**
 * Mark migration as complete
 * @param {string} userId - User ID
 */
function markMigrationComplete(userId) {
  const db = getDb(userId);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('json_migration_complete', 'true');
  logger.info(`[Database] Migration marked complete for user ${userId}`);
}

/**
 * Get metadata value
 * @param {string} userId - User ID
 * @param {string} key - Metadata key
 * @returns {string|null} Value or null
 */
function getMetadata(userId, key) {
  const db = getDb(userId);
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Set metadata value
 * @param {string} userId - User ID
 * @param {string} key - Metadata key
 * @param {string} value - Value to set
 */
function setMetadata(userId, key, value) {
  const db = getDb(userId);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Run a function within a transaction
 * @param {string} userId - User ID
 * @param {Function} fn - Function to run
 * @returns {*} Return value of fn
 */
function transaction(userId, fn) {
  const db = getDb(userId);
  return db.transaction(fn)();
}

/**
 * Get the hijack history directory path
 * @returns {string} Hijack history directory path
 */
function getHijackHistoryDir() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'userdata', 'hijack_history');
  }
  return path.join(__dirname, '..', '..', 'userdata', 'hijack_history');
}

/**
 * Migrate hijack history from JSON files to SQLite
 * - Reads all JSON files from userdata/hijack_history/
 * - Migrates history entries to hijack_history table
 * - Migrates case metadata to hijack_cases table
 * - Deletes JSON files after successful migration
 *
 * @param {string} userId - User ID to migrate for
 * @returns {{migrated: number, deleted: number, errors: string[]}} Migration results
 */
function migrateHijackHistoryFromJson(userId) {
  const results = { migrated: 0, deleted: 0, errors: [] };
  const hijackDir = getHijackHistoryDir();

  // Check if directory exists
  if (!fs.existsSync(hijackDir)) {
    logger.debug('[Database] No hijack_history directory found - nothing to migrate');
    return results;
  }

  // Find all JSON files for this user
  const files = fs.readdirSync(hijackDir).filter(f => f.startsWith(`${userId}-`) && f.endsWith('.json'));

  if (files.length === 0) {
    logger.debug(`[Database] No hijack history JSON files found for user ${userId}`);
    return results;
  }

  logger.info(`[Database] Found ${files.length} hijack history JSON files to migrate for user ${userId}`);
  const db = getDb(userId);

  for (const filename of files) {
    const filePath = path.join(hijackDir, filename);

    try {
      // Parse filename to get case ID: {userId}-{caseId}.json
      const match = filename.match(/^\d+-(\d+)\.json$/);
      if (!match) {
        results.errors.push(`Invalid filename format: ${filename}`);
        continue;
      }
      const caseId = parseInt(match[1], 10);

      // Read JSON file
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);

      // Check if already migrated in database
      const existing = db.prepare('SELECT case_id FROM hijack_cases WHERE case_id = ?').get(caseId);
      const existingHistoryCount = db.prepare('SELECT COUNT(*) as count FROM hijack_history WHERE case_id = ?').get(caseId);

      // Only migrate if we have more history in JSON than in DB
      if (existing && existingHistoryCount.count >= (data.history?.length || 0)) {
        logger.debug(`[Database] Case ${caseId} already fully migrated (${existingHistoryCount.count} entries) - deleting JSON`);
        fs.unlinkSync(filePath);
        results.deleted++;
        continue;
      }

      // Start transaction for this case
      db.transaction(() => {
        // Insert/update hijack_cases
        db.prepare(`
          INSERT INTO hijack_cases (
            case_id, user_vessel_id, vessel_name, status, resolved, autopilot_resolved,
            resolved_at, paid_amount, cash_before, cash_after, payment_verified, cached_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(case_id) DO UPDATE SET
            user_vessel_id = COALESCE(excluded.user_vessel_id, hijack_cases.user_vessel_id),
            vessel_name = COALESCE(excluded.vessel_name, hijack_cases.vessel_name),
            status = excluded.status,
            resolved = MAX(excluded.resolved, hijack_cases.resolved),
            autopilot_resolved = MAX(excluded.autopilot_resolved, hijack_cases.autopilot_resolved),
            resolved_at = COALESCE(excluded.resolved_at, hijack_cases.resolved_at),
            paid_amount = COALESCE(excluded.paid_amount, hijack_cases.paid_amount),
            cash_before = COALESCE(excluded.cash_before, hijack_cases.cash_before),
            cash_after = COALESCE(excluded.cash_after, hijack_cases.cash_after),
            payment_verified = COALESCE(excluded.payment_verified, hijack_cases.payment_verified)
        `).run(
          caseId,
          data.user_vessel_id,
          data.vessel_name,
          data.final_status || (data.resolved ? 'paid' : 'open'),
          data.resolved ? 1 : 0,
          data.autopilot_resolved ? 1 : 0,
          data.resolved_at,
          data.payment_verification?.actual_paid,
          data.payment_verification?.cash_before,
          data.payment_verification?.cash_after,
          data.payment_verification?.verified ? 1 : 0,
          Date.now()
        );

        // Insert history entries
        if (data.history && Array.isArray(data.history)) {
          const insertHistory = db.prepare(`
            INSERT OR IGNORE INTO hijack_history (case_id, type, amount, timestamp)
            VALUES (?, ?, ?, ?)
          `);

          for (const entry of data.history) {
            insertHistory.run(caseId, entry.type, entry.amount, entry.timestamp);
          }
        }
      })();

      logger.info(`[Database] Migrated case ${caseId} from JSON (${data.history?.length || 0} history entries)`);
      results.migrated++;

      // Delete JSON file after successful migration
      fs.unlinkSync(filePath);
      results.deleted++;
      logger.debug(`[Database] Deleted JSON file: ${filename}`);

    } catch (error) {
      results.errors.push(`Error migrating ${filename}: ${error.message}`);
      logger.error(`[Database] Failed to migrate ${filename}:`, error.message);
    }
  }

  logger.info(`[Database] Hijack history migration complete: ${results.migrated} migrated, ${results.deleted} deleted, ${results.errors.length} errors`);
  return results;
}

/**
 * Migrate all users' hijack history from JSON to SQLite
 * Scans hijack_history directory and migrates all files
 * @returns {{users: Object<string, {migrated: number, deleted: number, errors: string[]}>}} Results per user
 */
function migrateAllHijackHistoryFromJson() {
  const results = {};
  const hijackDir = getHijackHistoryDir();

  if (!fs.existsSync(hijackDir)) {
    logger.debug('[Database] No hijack_history directory found - nothing to migrate');
    return results;
  }

  // Find all JSON files and group by user
  const files = fs.readdirSync(hijackDir).filter(f => f.endsWith('.json'));
  const userIds = new Set();

  for (const filename of files) {
    const match = filename.match(/^(\d+)-\d+\.json$/);
    if (match) {
      userIds.add(match[1]);
    }
  }

  logger.info(`[Database] Found ${userIds.size} users with hijack history to migrate`);

  for (const userId of userIds) {
    results[userId] = migrateHijackHistoryFromJson(userId);
  }

  return results;
}

// Graceful shutdown
process.on('SIGINT', closeAll);
process.on('SIGTERM', closeAll);


// ============================================================================
// ACCOUNTS DATABASE - Central storage for all user accounts
// ============================================================================

/**
 * Get path to accounts database
 * @returns {string} Path to accounts.db
 */
function getAccountsDbPath() {
  return path.join(getDbDir(), 'accounts.db');
}

/**
 * Create accounts database schema
 * @param {Database} db - SQLite database instance
 */
function createAccountsSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      user_id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      cookie TEXT NOT NULL,
      login_method TEXT NOT NULL,
      port INTEGER NOT NULL,
      autostart INTEGER DEFAULT 1,
      timestamp INTEGER NOT NULL,
      last_updated TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Set version
  db.prepare('INSERT OR REPLACE INTO accounts_metadata (key, value) VALUES (?, ?)').run('db_version', String(ACCOUNTS_DB_VERSION));
}

/**
 * Get accounts database connection (singleton)
 * @returns {Database} SQLite database instance
 */
function getAccountsDb() {
  if (accountsDbConnection) {
    return accountsDbConnection;
  }

  ensureDbDir();
  const dbPath = getAccountsDbPath();
  const isNew = !fs.existsSync(dbPath);

  const options = { fileMustExist: false };
  if (nativeBinding) options.nativeBinding = nativeBinding;

  accountsDbConnection = new Database(dbPath, options);

  if (isNew) {
    logger.info('[Database] Creating new accounts database');
    createAccountsSchema(accountsDbConnection);
  }

  return accountsDbConnection;
}

/**
 * Get all accounts from database
 * @returns {Array} Array of account objects
 */
function getAllAccounts() {
  const db = getAccountsDb();
  const rows = db.prepare('SELECT * FROM accounts ORDER BY timestamp DESC').all();
  return rows.map(row => ({
    userId: row.user_id,
    companyName: row.company_name,
    cookie: row.cookie,
    loginMethod: row.login_method,
    port: row.port,
    autostart: row.autostart === 1,
    timestamp: row.timestamp,
    lastUpdated: row.last_updated
  }));
}

/**
 * Get a single account by user ID
 * @param {string} userId - User ID
 * @returns {object|null} Account object or null
 */
function getAccount(userId) {
  const db = getAccountsDb();
  const row = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  return {
    userId: row.user_id,
    companyName: row.company_name,
    cookie: row.cookie,
    loginMethod: row.login_method,
    port: row.port,
    autostart: row.autostart === 1,
    timestamp: row.timestamp,
    lastUpdated: row.last_updated
  };
}

/**
 * Save or update an account
 * @param {string} userId - User ID
 * @param {object} data - Account data
 */
function saveAccount(userId, data) {
  const db = getAccountsDb();
  db.prepare(`
    INSERT INTO accounts (user_id, company_name, cookie, login_method, port, autostart, timestamp, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      company_name = excluded.company_name,
      cookie = excluded.cookie,
      login_method = excluded.login_method,
      port = excluded.port,
      autostart = excluded.autostart,
      timestamp = excluded.timestamp,
      last_updated = excluded.last_updated
  `).run(
    String(userId),
    data.companyName,
    data.cookie,
    data.loginMethod,
    data.port,
    data.autostart !== false ? 1 : 0,
    data.timestamp || Math.floor(Date.now() / 1000),
    data.lastUpdated || new Date().toISOString()
  );
  logger.info(`[Database] Saved account ${userId} (${data.companyName}) on port ${data.port}`);
}

/**
 * Update account port
 * @param {string} userId - User ID
 * @param {number} port - New port
 */
function setAccountPort(userId, port) {
  const db = getAccountsDb();
  const result = db.prepare('UPDATE accounts SET port = ?, last_updated = ? WHERE user_id = ?')
    .run(port, new Date().toISOString(), String(userId));
  if (result.changes > 0) {
    logger.info(`[Database] Updated port for ${userId} to ${port}`);
  }
  return result.changes > 0;
}

/**
 * Update account autostart setting
 * @param {string} userId - User ID
 * @param {boolean} autostart - Autostart enabled
 */
function setAccountAutostart(userId, autostart) {
  const db = getAccountsDb();
  const result = db.prepare('UPDATE accounts SET autostart = ?, last_updated = ? WHERE user_id = ?')
    .run(autostart ? 1 : 0, new Date().toISOString(), String(userId));
  return result.changes > 0;
}

/**
 * Delete an account
 * @param {string} userId - User ID
 */
function deleteAccount(userId) {
  const db = getAccountsDb();
  const result = db.prepare('DELETE FROM accounts WHERE user_id = ?').run(String(userId));
  if (result.changes > 0) {
    logger.info(`[Database] Deleted account ${userId}`);
  }
  return result.changes > 0;
}

/**
 * Find next available port starting from basePort
 * @param {number} basePort - Starting port
 * @returns {number} Next available port
 */
function findNextAvailablePort(basePort) {
  const db = getAccountsDb();
  const usedPorts = db.prepare('SELECT port FROM accounts ORDER BY port').all().map(r => r.port);
  
  let port = basePort;
  while (usedPorts.includes(port)) {
    port++;
  }
  return port;
}

/**
 * Close accounts database connection
 */
function closeAccountsDb() {
  if (accountsDbConnection) {
    accountsDbConnection.close();
    accountsDbConnection = null;
    logger.debug('[Database] Closed accounts database');
  }
}

// ============================================================================
// GLOBAL SETTINGS - Stored in accounts_metadata table
// ============================================================================

/**
 * Get a global setting from accounts_metadata
 * @param {string} key - Setting key (e.g., 'host', 'logLevel')
 * @returns {string|null} Setting value or null
 */
function getGlobalSetting(key) {
  const db = getAccountsDb();
  const row = db.prepare('SELECT value FROM accounts_metadata WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Set a global setting in accounts_metadata
 * @param {string} key - Setting key
 * @param {string} value - Setting value
 */
function setGlobalSetting(key, value) {
  const db = getAccountsDb();
  db.prepare('INSERT OR REPLACE INTO accounts_metadata (key, value) VALUES (?, ?)').run(key, String(value));
  logger.debug(`[Database] Set global setting ${key}=${value}`);
}

/**
 * Get all global settings
 * @returns {Object} Object with all global settings
 */
function getAllGlobalSettings() {
  const db = getAccountsDb();
  const rows = db.prepare('SELECT key, value FROM accounts_metadata WHERE key NOT LIKE "db_%"').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ============================================================================
// USER SETTINGS - Stored in per-user database metadata table
// ============================================================================

/**
 * Get user settings from per-user database
 * @param {string} userId - User ID
 * @returns {Object|null} Settings object or null
 */
function getUserSettings(userId) {
  const db = getDb(userId);
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('user_settings');
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    logger.error(`[Database] Failed to parse user settings for ${userId}`);
    return null;
  }
}

/**
 * Save user settings to per-user database
 * @param {string} userId - User ID
 * @param {Object} settings - Settings object
 */
function saveUserSettings(userId, settings) {
  const db = getDb(userId);
  const json = JSON.stringify(settings);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('user_settings', json);
  logger.debug(`[Database] Saved user settings for ${userId}`);
}


// ============================================================================
// STOCK BLACKLIST - Prevents autopilot from re-buying sold stocks
// ============================================================================

/**
 * Add a stock to the blacklist (prevent auto-buy)
 * @param {string} userId - User ID
 * @param {number} stockUserId - Stock issuer's user ID
 * @param {string} companyName - Company name
 * @param {string} reason - Reason for blacklisting (e.g., 'manual_sell', 'auto_sell')
 */
function addToStockBlacklist(userId, stockUserId, companyName, reason = 'sold') {
  const db = getDb(userId);
  db.prepare(`
    INSERT OR REPLACE INTO stock_blacklist (stock_user_id, company_name, sold_at, reason)
    VALUES (?, ?, ?, ?)
  `).run(stockUserId, companyName, Date.now(), reason);
  logger.info(`[Database] Added ${companyName} (${stockUserId}) to stock blacklist: ${reason}`);
}

/**
 * Check if a stock is blacklisted
 * @param {string} userId - User ID
 * @param {number} stockUserId - Stock issuer's user ID
 * @returns {boolean} True if blacklisted
 */
function isStockBlacklisted(userId, stockUserId) {
  const db = getDb(userId);
  const row = db.prepare('SELECT 1 FROM stock_blacklist WHERE stock_user_id = ?').get(stockUserId);
  return !!row;
}

/**
 * Get all blacklisted stocks
 * @param {string} userId - User ID
 * @returns {Array} Array of blacklisted stocks
 */
function getStockBlacklist(userId) {
  const db = getDb(userId);
  return db.prepare('SELECT * FROM stock_blacklist ORDER BY sold_at DESC').all();
}

/**
 * Remove a stock from the blacklist
 * @param {string} userId - User ID
 * @param {number} stockUserId - Stock issuer's user ID
 * @returns {boolean} True if removed
 */
function removeFromStockBlacklist(userId, stockUserId) {
  const db = getDb(userId);
  const result = db.prepare('DELETE FROM stock_blacklist WHERE stock_user_id = ?').run(stockUserId);
  if (result.changes > 0) {
    logger.info(`[Database] Removed stock ${stockUserId} from blacklist`);
  }
  return result.changes > 0;
}

// ============================================
// VESSEL ROUTE SETTINGS
// ============================================

/**
 * Save or update vessel route settings
 * @param {string} userId - User ID
 * @param {Object} settings - Route settings object
 * @param {number} settings.vesselId - Vessel ID
 * @param {number} settings.routeId - Route ID
 * @param {string} settings.origin - Origin port code
 * @param {string} settings.destination - Destination port code
 * @param {number} settings.speed - Route speed
 * @param {number} settings.guards - Number of guards
 * @param {string} settings.capacityType - 'container' or 'tanker'
 * @param {Object} settings.prices - Prices object
 */
function saveRouteSettings(userId, settings) {
  const db = getDb(userId);
  const {
    vesselId, routeId, origin, destination, speed, guards,
    capacityType, prices
  } = settings;

  logger.debug(`[Database] saveRouteSettings input: vesselId=${vesselId}, routeId=${routeId}, prices=${JSON.stringify(prices)}`);

  db.prepare(`
    INSERT OR REPLACE INTO vessel_route_settings
    (vessel_id, route_id, origin, destination, speed, guards, capacity_type,
     prices_dry, prices_refrigerated, prices_fuel, prices_crude, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vesselId,
    routeId,
    origin,
    destination,
    speed,
    guards,
    capacityType,
    prices?.dry,
    prices?.refrigerated,
    prices?.fuel,
    prices?.crude_oil,
    Date.now()
  );

  logger.info(`[Database] Saved route settings for vessel ${vesselId}: speed=${speed}, guards=${guards}, prices_dry=${prices?.dry}, prices_ref=${prices?.refrigerated}`);
}

/**
 * Get route settings for a vessel
 * @param {string} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @returns {Object|null} Route settings or null if not found
 */
function getRouteSettings(userId, vesselId) {
  const db = getDb(userId);
  const row = db.prepare('SELECT * FROM vessel_route_settings WHERE vessel_id = ?').get(vesselId);

  if (!row) return null;

  return {
    vesselId: row.vessel_id,
    routeId: row.route_id,
    origin: row.origin,
    destination: row.destination,
    speed: row.speed,
    guards: row.guards,
    capacityType: row.capacity_type,
    prices: {
      dry: row.prices_dry,
      refrigerated: row.prices_refrigerated,
      fuel: row.prices_fuel,
      crude_oil: row.prices_crude
    },
    updatedAt: row.updated_at
  };
}

/**
 * Delete route settings for a vessel (e.g., when route is removed)
 * @param {string} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @returns {boolean} True if deleted
 */
function deleteRouteSettings(userId, vesselId) {
  const db = getDb(userId);
  const result = db.prepare('DELETE FROM vessel_route_settings WHERE vessel_id = ?').run(vesselId);
  if (result.changes > 0) {
    logger.info(`[Database] Deleted route settings for vessel ${vesselId}`);
  }
  return result.changes > 0;
}

/**
 * Get all route settings for a user
 * @param {string} userId - User ID
 * @returns {Array} Array of route settings
 */
function getAllRouteSettings(userId) {
  const db = getDb(userId);
  const rows = db.prepare('SELECT * FROM vessel_route_settings ORDER BY updated_at DESC').all();

  return rows.map(row => ({
    vesselId: row.vessel_id,
    routeId: row.route_id,
    origin: row.origin,
    destination: row.destination,
    speed: row.speed,
    guards: row.guards,
    capacityType: row.capacity_type,
    prices: {
      dry: row.prices_dry,
      refrigerated: row.prices_refrigerated,
      fuel: row.prices_fuel,
      crude_oil: row.prices_crude
    },
    updatedAt: row.updated_at
  }));
}

module.exports = {
  getDb,
  closeDb,
  closeAll,
  isMigrationComplete,
  markMigrationComplete,
  getMetadata,
  setMetadata,
  transaction,
  getDbPath,
  getDbDir,
  DB_VERSION,
  migrateHijackHistoryFromJson,
  migrateAllHijackHistoryFromJson,
  // Accounts database
  getAccountsDb,
  getAllAccounts,
  getAccount,
  saveAccount,
  setAccountPort,
  setAccountAutostart,
  deleteAccount,
  findNextAvailablePort,
  closeAccountsDb,
  // Global settings (accounts_metadata)
  getGlobalSetting,
  setGlobalSetting,
  getAllGlobalSettings,
  // User settings (per-user database)
  getUserSettings,
  saveUserSettings,
  // Stock blacklist
  addToStockBlacklist,
  isStockBlacklisted,
  getStockBlacklist,
  removeFromStockBlacklist,
  // Vessel route settings
  saveRouteSettings,
  getRouteSettings,
  deleteRouteSettings,
  getAllRouteSettings
};
