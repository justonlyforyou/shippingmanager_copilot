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
  port: 12345,
  host: '127.0.0.1',
  debugMode: false,
  logLevel: 'info'
};

/**
 * Check if settings file exists (first run detection)
 * @returns {boolean}
 */
function settingsExist() {
  const settingsFile = path.join(getSettingsDir(), 'settings.json');
  return fs.existsSync(settingsFile);
}

/**
 * Load settings from JSON file
 * IMPORTANT: Settings.json is the ONLY source of truth for port/host.
 * If settings.json doesn't exist, it MUST be created first (first-run flow).
 * NO fallbacks allowed - the app should fail if settings.json is missing or corrupt.
 * @returns {object}
 * @throws {Error} If settings.json doesn't exist or is invalid
 */
function loadSettings() {
  const settingsFile = path.join(getSettingsDir(), 'settings.json');

  if (!fs.existsSync(settingsFile)) {
    // First run - create settings.json with defaults
    logger.info('[Launcher] First run - creating settings.json');
    const settingsDir = getSettingsDir();
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    fs.writeFileSync(settingsFile, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const data = fs.readFileSync(settingsFile, 'utf8');
    const settings = JSON.parse(data);

    // Validate required fields exist - NO fallbacks
    if (settings.port === undefined || settings.host === undefined) {
      throw new Error('settings.json is missing required fields (port, host)');
    }

    return {
      port: settings.port,
      host: settings.host,
      debugMode: settings.debugMode === true,
      logLevel: settings.logLevel || 'info'
    };
  } catch (err) {
    logger.error('[Launcher] FATAL: Error loading settings: ' + err.message);
    throw new Error('Failed to load settings.json: ' + err.message);
  }
}

/**
 * Save settings to JSON file
 * @param {object} settings
 * @returns {boolean}
 */
function saveSettings(settings) {
  const settingsDir = getSettingsDir();
  const settingsFile = path.join(settingsDir, 'settings.json');

  try {
    // Ensure directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    const settingsToSave = {
      port: settings.port ?? DEFAULT_SETTINGS.port,
      host: settings.host ?? DEFAULT_SETTINGS.host,
      debugMode: settings.debugMode ?? DEFAULT_SETTINGS.debugMode,
      logLevel: settings.logLevel ?? DEFAULT_SETTINGS.logLevel
    };

    fs.writeFileSync(settingsFile, JSON.stringify(settingsToSave, null, 2));
    return true;
  } catch (err) {
    logger.error('[Launcher] Error saving settings: ' + err.message);
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
  DEFAULT_SETTINGS,
  settingsExist,
  loadSettings,
  saveSettings,
  getServerPath,
  getIconPath,
  getPidFile
};
