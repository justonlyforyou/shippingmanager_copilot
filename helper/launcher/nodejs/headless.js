#!/usr/bin/env node
/**
 * @fileoverview Headless Server Launcher
 * @module launcher/headless
 *
 * Starts all servers without GUI.
 * Usage: node launcher/headless.js
 */

const config = require('./config');
const serverManager = require('./server-manager');
const sessionManager = require('../../../server/utils/session-manager');
const fs = require('fs');

/**
 * Log with timestamp
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] [Headless] ${message}`);
}

// Set log function for server manager
serverManager.setLogFunction(log);

/**
 * Setup signal handlers for graceful shutdown
 */
function setupSignalHandlers() {
  const cleanup = async () => {
    log('info', 'Signal received, shutting down...');
    await serverManager.stopAllServers();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

/**
 * Main function
 */
async function main() {
  log('info', 'ShippingManager CoPilot starting (headless mode)...');
  log('info', `Platform: ${process.platform}, Packaged: ${config.isPackaged()}`);
  log('info', `App base: ${config.getAppBaseDir()}`);
  log('info', `User data: ${config.getUserDataDir()}`);

  // Ensure directories exist
  const settingsDir = config.getSettingsDir();
  const logsDir = config.getLogsDir();
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Ensure settings exist
  if (!config.settingsExist()) {
    config.saveSettings(config.DEFAULT_SETTINGS);
  }

  // Check for sessions
  const sessions = await sessionManager.getAvailableSessions();
  if (sessions.length === 0) {
    log('error', 'No sessions found.');
    log('error', 'Please log in first using one of these methods:');
    log('error', '  1. Run "npm start" to use the launcher GUI');
    log('error', '  2. Run "node launcher/cli.js --add-session-interactive" for CLI login');
    process.exit(1);
  }

  // Setup cleanup handlers
  setupSignalHandlers();

  // Start all servers
  const startedCount = await serverManager.startAllServers();

  if (startedCount === 0) {
    log('error', 'No servers started. All sessions may have expired.');
    log('error', 'Please log in again using "npm start" or "node launcher/cli.js --add-session-interactive"');
    process.exit(1);
  }

  log('info', `${startedCount} server(s) running`);

  const urls = serverManager.getServerUrls();
  urls.forEach(url => log('info', `  ${url}`));

  log('info', 'Press Ctrl+C to stop');

  // Keep process alive
  setInterval(() => {
    // Check if any servers are still running
    if (!serverManager.hasRunningServers()) {
      log('warn', 'All servers have stopped, exiting...');
      process.exit(0);
    }
  }, 5000);
}

// Run
main().catch(err => {
  log('error', `Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
