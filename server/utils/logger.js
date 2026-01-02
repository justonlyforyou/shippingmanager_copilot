/**
 * @fileoverview Centralized logging utility with winston
 *
 * Provides consistent timestamp formatting and log levels across all server logs.
 * Format: [2025-11-02T12:34:56.789Z] [LEVEL] message
 *
 * @module server/utils/logger
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getLogDir } = require('../config');

/**
 * Load log level from database (accounts_metadata table).
 * Uses direct SQLite access to avoid circular dependency with db module.
 *
 * Priority:
 * 1. If DEBUG_MODE env var is set (from systray toggle), use 'debug'
 * 2. Otherwise use logLevel from accounts_metadata table
 *
 * @returns {string} Log level (info, debug, warn, error)
 */
function loadLogLevel() {
  // Check if Debug Mode is enabled via environment variable (set by start.py)
  if (process.env.DEBUG_MODE === 'true') {
    return 'debug';
  }

  try {
    // Note: Cannot use isPackaged() here due to circular dependency with config.js
    // Check both pkg and SEA directly
    let isPkg = !!process.pkg;
    if (!isPkg) {
      try {
        const sea = require('node:sea');
        isPkg = sea && sea.isSea && sea.isSea();
      } catch { /* not SEA */ }
    }

    // Fallback: check executable name
    if (!isPkg) {
      const execName = path.basename(process.execPath).toLowerCase();
      if (execName.includes('shippingmanagercopilot')) {
        isPkg = true;
      }
    }

    let dbPath;
    if (isPkg) {
      // Running as packaged binary - use platform-specific paths
      if (process.platform === 'win32') {
        dbPath = path.join(os.homedir(), 'AppData', 'Local', 'ShippingManagerCoPilot', 'userdata', 'database', 'accounts.db');
      } else if (process.platform === 'darwin') {
        dbPath = path.join(os.homedir(), 'Library', 'Application Support', 'ShippingManagerCoPilot', 'userdata', 'database', 'accounts.db');
      } else {
        // Linux
        dbPath = path.join(os.homedir(), '.ShippingManagerCoPilot', 'userdata', 'database', 'accounts.db');
      }
    } else {
      // Running from source - use userdata
      dbPath = path.join(__dirname, '..', '..', 'userdata', 'database', 'accounts.db');
    }

    if (fs.existsSync(dbPath)) {
      // Direct SQLite access to avoid circular dependency
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });

      // Check if accounts_metadata table exists
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_metadata'").get();
      if (tableExists) {
        const row = db.prepare('SELECT value FROM accounts_metadata WHERE key = ?').get('logLevel');
        db.close();
        if (row) {
          return row.value;
        }
      } else {
        db.close();
      }
    }
  } catch {
    // Silent fallback (ignore errors during settings read)
  }
  return 'info';
}

/**
 * Check if debug mode is enabled from environment variable.
 * Set by start.py based on systray Debug Mode toggle.
 * @returns {boolean} True if debug mode is enabled
 */
function isDebugMode() {
  return process.env.DEBUG_MODE === 'true';
}

/**
 * Get user ID prefix for log messages
 * @returns {string} User ID prefix or empty string
 */
function getUserIdPrefix() {
  const userId = process.env.SELECTED_USER_ID;
  return userId ? `[${userId}] ` : '';
}

/**
 * Custom format for console output with timestamps and userId prefix
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DDTHH:mm:ssZ'
  }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const userPrefix = getUserIdPrefix();
    return `${userPrefix}[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);


/**
 * Get log file paths based on environment (dev vs packaged)
 */
const logDir = getLogDir();
// Ensure log directory exists
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const serverLogPath = path.join(logDir, 'server.log');

// Clear the log file on startup (truncate to empty)
try {
  fs.writeFileSync(serverLogPath, '');
} catch {
  // Ignore errors if file doesn't exist yet
}

/**
 * File format (without colors, for log files)
 */
const fileFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DDTHH:mm:ssZ'
  }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const userPrefix = getUserIdPrefix();
    return `${userPrefix}[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);

/**
 * Build transports array - everything goes to server.log
 */
const transports = [
  // Console output
  new winston.transports.Console({
    format: consoleFormat
  }),
  // server.log - all logs (level based on settings/debug mode), overwritten on start
  new winston.transports.File({
    filename: serverLogPath,
    level: loadLogLevel(),
    format: fileFormat,
    options: { flags: 'w' }
  })
];

/**
 * Winston logger instance with log level from startup settings
 */
const logger = winston.createLogger({
  level: loadLogLevel(),  // Load from settings.json (no env vars)
  format: consoleFormat,
  transports: transports
});

/**
 * Log error message with timestamp
 * @param {...any} args - Arguments to log
 */
function error(...args) {
  logger.error(args.join(' '));
}

/**
 * Log warning message with timestamp
 * @param {...any} args - Arguments to log
 */
function warn(...args) {
  logger.warn(args.join(' '));
}

/**
 * Log debug message with timestamp
 * @param {...any} args - Arguments to log
 */
function debug(...args) {
  logger.debug(args.join(' '));
}

/**
 * Log info message with timestamp
 * @param {...any} args - Arguments to log
 */
function info(...args) {
  logger.info(args.join(' '));
}

module.exports = {
  info,
  error,
  warn,
  debug,
  serverLogPath,
  logger, // Export raw winston logger for advanced use
  isDebugMode // Export debug mode checker
};
