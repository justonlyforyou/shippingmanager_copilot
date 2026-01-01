/**
 * @fileoverview Centralized configuration for Shipping Manager application.
 * Contains all server settings, API endpoints, rate limiting rules, and timing intervals.
 * Session data is stored in SQLite database (userdata/database/accounts.db).
 *
 * Important configuration notes:
 * - All settings loaded from userdata/settings/settings.json (NO env vars)
 * - Rate limits are set conservatively to avoid API detection
 * - Chat refresh interval is 25 seconds (within the 29-minute price window)
 * - Session cookie provides full account access - never log or expose it
 *
 * @module server/config
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Cached result of isPackaged check
 * @private
 */
let _isPackagedCache = null;

/**
 * Check if running as packaged executable (pkg or SEA)
 * @returns {boolean} True if running as packaged executable
 */
function isPackaged() {
  // Return cached result if available
  if (_isPackagedCache !== null) {
    return _isPackagedCache;
  }

  // Check for pkg
  if (process.pkg) {
    _isPackagedCache = true;
    return true;
  }

  // Check for Node.js SEA (Single Executable Application)
  try {
    const sea = require('node:sea');
    if (sea && sea.isSea && sea.isSea()) {
      _isPackagedCache = true;
      return true;
    }
  } catch {
    // node:sea not available, not running as SEA
  }

  // Fallback: Check if running from our compiled .exe
  // This works when node:sea detection fails after esbuild bundling
  const execName = path.basename(process.execPath).toLowerCase();
  if (execName.includes('shippingmanagercopilot')) {
    _isPackagedCache = true;
    return true;
  }

  _isPackagedCache = false;
  return false;
}

/**
 * Get platform-specific AppData directory without using environment variables.
 * Used for user settings, sessions, certificates (local data)
 * @returns {string} AppData directory path
 */
function getAppDataDir() {
  if (process.platform === 'win32') {
    // Windows: C:\Users\Username\AppData\Local
    return path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    // macOS: ~/Library/Application Support
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  // Linux: ~/.ShippingManagerCoPilot (returns homedir, add .ShippingManagerCoPilot later)
  return os.homedir();
}

/**
 * Get the full app base directory path (platform-specific).
 * This is the recommended function for getting paths to app data.
 *   - Windows: AppData/Local/ShippingManagerCoPilot
 *   - macOS: ~/Library/Application Support/ShippingManagerCoPilot
 *   - Linux: ~/.ShippingManagerCoPilot
 * @returns {string} Full app base directory path
 */
function getAppBaseDir() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'ShippingManagerCoPilot');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ShippingManagerCoPilot');
  }
  // Linux: hidden directory in home
  return path.join(os.homedir(), '.ShippingManagerCoPilot');
}

/**
 * Get platform-specific Local AppData directory (for machine-specific cache/data).
 * Used for forecast data, cache files, logs (non-roaming data)
 * @returns {string} AppData directory path
 */
function getLocalAppDataDir() {
  if (process.platform === 'win32') {
    // Windows: C:\Users\Username\AppData\Local
    return path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    // macOS: ~/Library/Application Support
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  // Linux: ~/.ShippingManagerCoPilot (returns homedir, add .ShippingManagerCoPilot later)
  return os.homedir();
}

/**
 * Get log directory path.
 * When packaged: Platform-specific app data directory
 *   - Windows: AppData/Local/ShippingManagerCoPilot/userdata/logs/
 *   - macOS: ~/Library/Application Support/ShippingManagerCoPilot/userdata/logs/
 *   - Linux: ~/.ShippingManagerCoPilot/userdata/logs/
 * When running from source: ./userdata/logs/
 * @returns {string} Log directory path
 */
function getLogDir() {
  const isPkg = isPackaged();

  if (isPkg) {
    if (process.platform === 'win32') {
      const appDataPath = path.join(os.homedir(), 'AppData', 'Local', 'ShippingManagerCoPilot', 'userdata', 'logs');
      return appDataPath;
    }
    if (process.platform === 'darwin') {
      // macOS: ~/Library/Application Support/ShippingManagerCoPilot/userdata/logs
      return path.join(os.homedir(), 'Library', 'Application Support', 'ShippingManagerCoPilot', 'userdata', 'logs');
    }
    // Linux: ~/.ShippingManagerCoPilot/userdata/logs
    return path.join(os.homedir(), '.ShippingManagerCoPilot', 'userdata', 'logs');
  }
  // Running from source - use project directory
  const localPath = path.join(__dirname, '..', 'userdata', 'logs');
  return localPath;
}

/**
 * Global session cookie storage (set during initialization)
 * @private
 */
let sessionCookie = null;
let appPlatformCookie = null;
let appVersionCookie = null;

/**
 * Set the session cookie for API authentication
 * @param {string} cookie - Session cookie value
 * @param {string} appPlatform - app_platform cookie value
 * @param {string} appVersion - app_version cookie value
 */
function setSessionCookie(cookie, appPlatform = null, appVersion = null) {
  sessionCookie = cookie;
  appPlatformCookie = appPlatform;
  appVersionCookie = appVersion;
}

/**
 * Get the current session cookie
 * @returns {string} Session cookie value
 */
function getSessionCookie() {
  return sessionCookie || 'COOKIE_NOT_INITIALIZED';
}

/**
 * Get app_platform cookie
 * @returns {string} app_platform cookie value
 */
function getAppPlatformCookie() {
  return appPlatformCookie;
}

/**
 * Get app_version cookie
 * @returns {string} app_version cookie value
 */
function getAppVersionCookie() {
  return appVersionCookie;
}

/**
 * Get settings directory path based on execution mode.
 * When packaged: Platform-specific app data directory
 *   - Windows: AppData/Local/ShippingManagerCoPilot/userdata/settings/
 *   - macOS: ~/Library/Application Support/ShippingManagerCoPilot/userdata/settings/
 *   - Linux: ~/.ShippingManagerCoPilot/userdata/settings/
 * When running from source: ./userdata/settings/
 * @returns {string} Settings directory path
 */
function getSettingsDir() {
  const isPkg = isPackaged();

  if (isPkg) {
    if (process.platform === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Local', 'ShippingManagerCoPilot', 'userdata', 'settings');
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'ShippingManagerCoPilot', 'userdata', 'settings');
    }
    return path.join(os.homedir(), '.ShippingManagerCoPilot', 'userdata', 'settings');
  }
  return path.join(__dirname, '..', 'userdata', 'settings');
}

/**
 * Load startup settings from systray configuration file.
 * Creates settings.json with localhost-only defaults on first run.
 * @returns {Object} Settings object with port, host, selectedUserId, logLevel, debugMode
 */
function loadStartupSettings() {
  const settingsDir = getSettingsDir();
  const settingsPath = path.join(settingsDir, 'settings.json');

  // First run: Create settings.json with localhost-only defaults
  if (!fs.existsSync(settingsPath)) {
    const defaultSettings = {
      port: 12345,
      host: '127.0.0.1',  // localhost-only by default (secure)
      logLevel: 'info',  // info, debug, warn, error
      debugMode: false   // Enable detailed debug logging
    };

    try {
      // Ensure directory exists
      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
      }

      fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
      return defaultSettings;
    } catch (error) {
      throw new Error(`Failed to create startup settings: ${error.message}`);
    }
  }

  // Read existing settings
  try {
    const data = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(data);

    // Return settings with defaults for missing values
    return {
      port: settings.port || 12345,
      host: settings.host || '127.0.0.1',
      logLevel: settings.logLevel || 'info',
      debugMode: settings.debugMode !== undefined ? settings.debugMode : false
    };
  } catch (error) {
    throw new Error(`Failed to read startup settings: ${error.message}`);
  }
}

// Load startup settings (REQUIRED - no fallbacks)
const startupSettings = loadStartupSettings();

/**
 * Get port from accounts database for the selected user.
 * Falls back to settings.json port if no user selected or not found.
 * @returns {number} Port number
 */
function getPortFromDatabase() {
  const selectedUserId = process.env.SELECTED_USER_ID;
  if (!selectedUserId) {
    return startupSettings.port;
  }

  try {
    // Get database path
    const isPkg = isPackaged();
    let dbPath;
    if (isPkg) {
      if (process.platform === 'win32') {
        dbPath = path.join(os.homedir(), 'AppData', 'Local', 'ShippingManagerCoPilot', 'userdata', 'database', 'accounts.db');
      } else if (process.platform === 'darwin') {
        dbPath = path.join(os.homedir(), 'Library', 'Application Support', 'ShippingManagerCoPilot', 'userdata', 'database', 'accounts.db');
      } else {
        dbPath = path.join(os.homedir(), '.ShippingManagerCoPilot', 'userdata', 'database', 'accounts.db');
      }
    } else {
      dbPath = path.join(__dirname, '..', 'userdata', 'database', 'accounts.db');
    }

    if (!fs.existsSync(dbPath)) {
      return startupSettings.port;
    }

    // Read port from database using better-sqlite3
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT port FROM accounts WHERE user_id = ?').get(selectedUserId);
    db.close();

    if (row && row.port) {
      return row.port;
    }
  } catch {
    // Silently fall back to settings port
  }

  return startupSettings.port;
}

const config = {
  /**
   * HTTPS server port.
   * Read from accounts.db for SELECTED_USER_ID, falls back to settings.json
   * @constant {number}
   */
  PORT: getPortFromDatabase(),

  /**
   * Server bind address.
   * Priority: process.env.HOST (from launcher) > settings.json
   * @constant {string}
   */
  HOST: process.env.HOST || startupSettings.host,

  /**
   * Base URL for Shipping Manager game API. All proxy requests are sent to this endpoint.
   * @constant {string}
   * @default 'https://shippingmanager.cc/api'
   */
  SHIPPING_MANAGER_API: 'https://shippingmanager.cc/api',

  /**
   * Session cookie for API authentication. Loaded from encrypted accounts database.
   * Provides full account access - must be kept secure and never logged.
   * Use getSessionCookie() to access dynamically.
   * @deprecated Use getSessionCookie() instead
   * @constant {string}
   */
  get SESSION_COOKIE() {
    return getSessionCookie();
  },

  /**
   * Global rate limiting configuration for all API endpoints.
   * Self-imposed limits to avoid spamming the game API.
   * The actual game API limit is unknown but well above 200 req/s (tested 2025-11-25).
   *
   * @typedef {Object} RateLimitConfig
   * @property {number} windowMs - Time window in milliseconds (15 minutes)
   * @property {number} max - Maximum requests allowed per window (1000 requests)
   * @property {string} message - Error message shown when limit exceeded
   */
  RATE_LIMIT: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10000,
    message: 'Too many requests, please try again later'
  },

  /**
   * Message-specific rate limiting configuration (stricter than global limit).
   * Self-imposed limit for alliance chat and private messaging endpoints.
   *
   * @typedef {Object} MessageRateLimitConfig
   * @property {number} windowMs - Time window in milliseconds (1 minute)
   * @property {number} max - Maximum messages allowed per window (30 messages)
   * @property {string} message - Error message shown when limit exceeded
   */
  MESSAGE_RATE_LIMIT: {
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,
    message: 'Too many messages, please wait before sending again'
  },

  /**
   * WebSocket chat auto-refresh interval in milliseconds.
   * Server broadcasts updated chat feed to all connected clients every 20 seconds.
   * Synchronized with messenger polling to reduce API load.
   *
   * @constant {number}
   * @default 20000
   */
  CHAT_REFRESH_INTERVAL: 20000,

  /**
   * Debug mode enables verbose logging for development and troubleshooting.
   * Loaded from userdata/settings/settings.json (no env vars).
   *
   * When enabled, logs include:
   * - Detailed API call information
   * - Autopilot operation details
   * - Data fetch/broadcast operations
   * - Scheduler execution logs
   *
   * @constant {boolean}
   * @default false
   */
  DEBUG_MODE: startupSettings.debugMode,

  /**
   * Developer mode - undocumented hidden feature.
   * Enables API stats tab in Business modal.
   * Active when userdata/settings/devel.json file exists.
   * @constant {boolean}
   * @default false
   */
  get DEVEL_MODE() {
    const develFile = path.join(getSettingsDir(), 'devel.json');
    return fs.existsSync(develFile);
  }
};

/**
 * Get the internal base URL for server-to-server API calls.
 * Uses localhost if HOST is 0.0.0.0 (all interfaces) or 127.0.0.1,
 * otherwise uses the configured HOST.
 * @returns {string} Base URL like https://localhost:12345 or https://192.168.1.100:12345
 */
function getInternalBaseUrl() {
  const host = config.HOST === '0.0.0.0' || config.HOST === '127.0.0.1' ? 'localhost' : config.HOST;
  return `https://${host}:${config.PORT}`;
}

module.exports = config;
module.exports.setSessionCookie = setSessionCookie;
module.exports.getSessionCookie = getSessionCookie;
module.exports.getAppPlatformCookie = getAppPlatformCookie;
module.exports.getAppVersionCookie = getAppVersionCookie;
module.exports.getAppDataDir = getAppDataDir;
module.exports.getAppBaseDir = getAppBaseDir;
module.exports.getLocalAppDataDir = getLocalAppDataDir;
module.exports.getLogDir = getLogDir;
module.exports.getSettingsDir = getSettingsDir;
module.exports.getInternalBaseUrl = getInternalBaseUrl;
module.exports.isPackaged = isPackaged;
