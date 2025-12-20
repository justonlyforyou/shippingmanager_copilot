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
const DB_VERSION = 5;

// Cache of open database connections per user
const dbConnections = new Map();

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

  // Hijack negotiation history - stores history events + metadata per case
  db.exec(`
    CREATE TABLE IF NOT EXISTS hijack_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL,
      timestamp REAL NOT NULL,
      autopilot_resolved INTEGER DEFAULT 0,
      resolved_at REAL,
      payment_verification_json TEXT
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

// Graceful shutdown
process.on('SIGINT', closeAll);
process.on('SIGTERM', closeAll);

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
  DB_VERSION
};
