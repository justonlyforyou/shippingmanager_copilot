/**
 * @fileoverview Launcher Logger
 * @module launcher/logger
 *
 * Writes logs to both console and server.log for consistency with server logging.
 */

const fs = require('fs');
const path = require('path');

let logFile = null;
let logStream = null;

/**
 * Detect if running as packaged SEA executable
 * @returns {boolean}
 */
function isPackaged() {
  try {
    const sea = require('node:sea');
    return sea.isSea();
  } catch {
    return false;
  }
}

/**
 * Initialize log file - writes to server.log in userdata/logs
 */
function initLogFile() {
  if (logStream) return;

  try {
    // Determine log directory
    let logsDir;

    if (isPackaged()) {
      const appDataDir = process.env.LOCALAPPDATA || process.env.HOME;
      logsDir = path.join(appDataDir, 'ShippingManagerCoPilot', 'userdata', 'logs');
    } else {
      // 3 levels up from helper/launcher/nodejs to project root
      logsDir = path.join(__dirname, '..', '..', '..', 'userdata', 'logs');
    }

    // Ensure directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    logFile = path.join(logsDir, 'server.log');
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (err) {
    // Silently fail - logging shouldn't crash the app
    console.error('Failed to init log file:', err.message);
  }
}

/**
 * Log message with timestamp
 * @param {string} level - Log level (info, warn, error, debug)
 * @param {string} message - Message
 */
function log(level, message) {
  const now = new Date();
  const timestamp = now.toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(' ', 'T');
  const line = `[${timestamp}] [${level.toUpperCase()}] [Startup] ${message}`;

  // Always try console
  console.log(line);

  // Write to file
  if (!logStream) {
    initLogFile();
  }

  if (logStream) {
    logStream.write(line + '\n');
  }
}

function info(message) {
  log('info', message);
}

function warn(message) {
  log('warn', message);
}

function error(message) {
  log('error', message);
}

function debug(message) {
  log('debug', message);
}

module.exports = {
  log,
  info,
  warn,
  error,
  debug
};
