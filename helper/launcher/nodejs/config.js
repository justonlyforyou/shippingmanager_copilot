/**
 * @fileoverview Launcher Configuration
 * @module launcher/config
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('./logger');

/**
 * Detect if running as packaged SEA executable
 * @returns {boolean}
 */
function isPackaged() {
  // Only use Node.js 21+ SEA detection - no fallback heuristics
  try {
    const sea = require('node:sea');
    return sea.isSea();
  } catch {
    // node:sea not available (older Node or not SEA)
    return false;
  }
}

/**
 * Get the application base directory
 * @returns {string}
 */
function getAppBaseDir() {
  if (isPackaged()) {
    // Running as packaged exe - use executable directory
    return path.dirname(process.execPath);
  }
  // Running as script - use project root (3 levels up from helper/launcher/nodejs)
  return path.join(__dirname, '..', '..', '..');
}

/**
 * Get the user data directory (settings, logs, etc.)
 * @returns {string}
 */
function getUserDataDir() {
  if (isPackaged() && process.platform === 'win32') {
    // Windows packaged: use LocalAppData
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'ShippingManagerCoPilot', 'userdata');
  }
  // Development or non-Windows: use userdata in project
  return path.join(getAppBaseDir(), 'userdata');
}

/**
 * Get settings directory
 * @returns {string}
 */
function getSettingsDir() {
  return path.join(getUserDataDir(), 'settings');
}

/**
 * Get logs directory
 * @returns {string}
 */
function getLogsDir() {
  return path.join(getUserDataDir(), 'logs');
}

/**
 * Default application settings
 */
const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  logLevel: 'info'
};

/**
 * Get database directory path
 * @returns {string}
 */
function getDatabaseDir() {
  if (isPackaged() && process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'ShippingManagerCoPilot', 'userdata', 'database');
  }
  return path.join(getAppBaseDir(), 'userdata', 'database');
}

/**
 * Check if database exists (first run detection)
 * @returns {boolean}
 */
function settingsExist() {
  const dbPath = path.join(getDatabaseDir(), 'accounts.db');
  return fs.existsSync(dbPath);
}

/**
 * Load settings from database (accounts_metadata table)
 * debugMode is determined by existence of devel.json file
 * @returns {object}
 */
function loadSettings() {
  const dbPath = path.join(getDatabaseDir(), 'accounts.db');

  // Check devel.json for debug mode
  const develFile = path.join(getSettingsDir(), 'devel.json');
  const debugMode = fs.existsSync(develFile);

  // If database doesn't exist, return defaults (will be created by migrator)
  if (!fs.existsSync(dbPath)) {
    logger.info('[Launcher] No database found, using defaults');
    return { ...DEFAULT_SETTINGS, debugMode };
  }

  try {
    // Direct SQLite access
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    // Check if accounts_metadata table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_metadata'").get();

    if (!tableExists) {
      db.close();
      return { ...DEFAULT_SETTINGS, debugMode };
    }

    // Read host and logLevel from accounts_metadata
    const hostRow = db.prepare('SELECT value FROM accounts_metadata WHERE key = ?').get('host');
    const logLevelRow = db.prepare('SELECT value FROM accounts_metadata WHERE key = ?').get('logLevel');

    db.close();

    // If host not in database yet (pre-migration), return defaults
    if (!hostRow) {
      return { ...DEFAULT_SETTINGS, debugMode };
    }

    return {
      host: hostRow.value,
      logLevel: logLevelRow ? logLevelRow.value : 'info',
      debugMode: debugMode
    };
  } catch (err) {
    logger.error('[Launcher] Error loading settings from database: ' + err.message);
    return { ...DEFAULT_SETTINGS, debugMode };
  }
}

/**
 * Save settings to database
 * @param {object} settings
 * @returns {boolean}
 */
function saveSettings(settings) {
  const dbDir = getDatabaseDir();
  const dbPath = path.join(dbDir, 'accounts.db');

  try {
    // Ensure directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // Ensure accounts_metadata table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Save settings
    const upsert = db.prepare('INSERT OR REPLACE INTO accounts_metadata (key, value) VALUES (?, ?)');
    if (settings.host) upsert.run('host', settings.host);
    if (settings.logLevel) upsert.run('logLevel', settings.logLevel);

    db.close();
    return true;
  } catch (err) {
    logger.error('[Launcher] Error saving settings to database: ' + err.message);
    return false;
  }
}

/**
 * Get path to the server executable or app.js
 * @returns {string}
 */
function getServerPath() {
  const baseDir = getAppBaseDir();
  if (isPackaged()) {
    // Look for server executable in same directory
    const serverExe = process.platform === 'win32'
      ? 'ShippingManagerCoPilot-Server.exe'
      : 'ShippingManagerCoPilot-Server';
    return path.join(baseDir, serverExe);
  }
  // Development: run app.js directly
  return path.join(baseDir, 'app.js');
}

/**
 * Get path to favicon.ico for tray icon
 * @returns {string}
 */
function getIconPath() {
  return path.join(getAppBaseDir(), 'public', 'favicon.ico');
}

/**
 * Get path to PID file
 * @returns {string}
 */
function getPidFile() {
  return path.join(getUserDataDir(), 'server.pid');
}

module.exports = {
  isPackaged,
  getAppBaseDir,
  getUserDataDir,
  getSettingsDir,
  getLogsDir,
  getDatabaseDir,
  DEFAULT_SETTINGS,
  settingsExist,
  loadSettings,
  saveSettings,
  getServerPath,
  getIconPath,
  getPidFile
};
