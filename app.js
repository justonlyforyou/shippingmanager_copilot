// Check for --gui flag - if present, launch GUI mode instead of server
if (process.argv.includes('--gui')) {
  require('./helper/launcher/nodejs/index');
} else {
// Server mode - rest of app.js runs in this block

// Emergency crash handler - catches uncaught exceptions BEFORE Winston logger is initialized
// In debug mode, this writes to stderr which is redirected to debug.log by start.py
// In normal mode, it tries to use Winston logger if available, otherwise writes to stderr
process.on('uncaughtException', (err) => {
  const timestamp = new Date().toISOString();
  const errorMsg = `[${timestamp}] UNCAUGHT EXCEPTION:\n${err.stack}\n`;

  // Try to write to Winston logger if it's already loaded
  try {
    if (global.logger) {
      global.logger.error('UNCAUGHT EXCEPTION:', err);
    }
  } catch {
    // Logger not available yet
  }

  // Fallback: console.error writes to stderr
  // In debug mode: stderr -> debug.log (via start.py)
  // In normal mode: stderr -> DEVNULL (but Winston logger should have caught it above)
  console.error(errorMsg);

  process.exit(1);
});

/**
 * @fileoverview Main application entry point for Shipping Manager CoPilot.
 * This is a standalone HTTPS web server that provides a workaround for the in-game chat bug
 * where certain characters cause page reloads. The application proxies API calls to
 * shippingmanager.cc with session-based authentication, providing real-time WebSocket updates,
 * alliance chat, private messaging, and game management features (fuel/CO2 purchasing, vessel
 * departures, bulk repairs, marketing campaigns).
 *
 * The server architecture:
 * - Express-based HTTPS server with self-signed certificates
 * - WebSocket server for real-time chat updates (25-second refresh interval)
 * - Modular route handlers for alliance, messenger, and game management
 * - Rate limiting and security middleware
 * - Network-accessible on all interfaces (listens on 0.0.0.0)
 *
 * @module app
 * @requires express
 * @requires os
 * @requires dotenv
 * @requires ./server/config
 * @requires ./server/middleware
 * @requires ./server/utils/api
 * @requires ./server/certificate
 * @requires ./server/websocket
 * @requires ./server/routes/alliance
 * @requires ./server/routes/messenger
 * @requires ./server/routes/game
 * @requires ./server/routes/settings
 * @requires ./server/routes/logbook
 */

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Server modules
const logger = require('./server/utils/logger');
global.logger = logger;  // Make logger available to uncaught exception handler
const config = require('./server/config');
const { setupMiddleware } = require('./server/middleware');
const { initializeAlliance } = require('./server/utils/api');
const { createHttpsServer } = require('./server/certificate');
const { initWebSocket, broadcastToUser, startChatAutoRefresh, startMessengerAutoRefresh, startHijackingAutoRefresh, startIpoAutoRefresh, startStaffAutoRefresh } = require('./server/websocket');
const { initScheduler } = require('./server/scheduler');
const autopilot = require('./server/autopilot');
const sessionManager = require('./server/utils/session-manager');
const { transactionStore, vesselHistoryStore } = require('./server/database/store-adapter');

// Parent process monitoring - auto-shutdown if parent (C# Launcher) dies
if (process.ppid) {
  const checkParentInterval = setInterval(() => {
    try {
      // Check if parent process still exists
      process.kill(process.ppid, 0); // Signal 0 just checks existence
    } catch {
      // Parent process is dead, shut down immediately
      console.error('[SM-CoPilot] Parent process died, shutting down...');
      clearInterval(checkParentInterval);
      process.exit(0);
    }
  }, 1000); // Check every second
}

// Graceful shutdown handlers (Ctrl+C, kill, etc.)
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[SM-CoPilot] Received ${signal}, shutting down gracefully...`);
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// Windows: handle Ctrl+C in console
if (process.platform === 'win32') {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => process.emit('SIGINT'));
}

// Setup file logging - create new log file on each startup
// Use APPDATA for logs when running as packaged executable (pkg or SEA)
const LOG_DIR = config.isPackaged()
  ? path.join(config.getAppBaseDir(), 'userdata', 'logs')
  : path.join(__dirname, 'userdata', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOG_DIR, 'server.log');

// Winston handles file logging automatically with timestamps
logger.info(`[Logging] Server logs will be written to: ${LOG_FILE}`);

// Route modules
const allianceRoutes = require('./server/routes/alliance');
const alliancesRoutes = require('./server/routes/alliances');
const messengerRoutes = require('./server/routes/messenger');
const gameRoutes = require('./server/routes/game');
const settingsRoutes = require('./server/routes/settings');
const coopRoutes = require('./server/routes/coop');
const forecastRoutes = require('./server/routes/forecast');
const anchorRoutes = require('./server/routes/anchor');
const healthRoutes = require('./server/routes/health');
const logbookRoutes = require('./server/routes/logbook');
const harborMapRoutes = require('./server/routes/harbor-map');
const poiRoutes = require('./server/routes/poi');
const vesselImageRoutes = require('./server/routes/vessel-image');
const vesselSvgRoutes = require('./server/routes/vessel-svg');
const allianceLogoRoutes = require('./server/routes/alliance-logo');
const staffRoutes = require('./server/routes/staff');
const routePlannerRoutes = require('./server/routes/route-planner');
const stockRoutes = require('./server/routes/stock');
const broadcastRoutes = require('./server/routes/broadcast');
const analyticsRoutes = require('./server/routes/analytics');
const transactionsRoutes = require('./server/routes/transactions');
const serverConfigRoutes = require('./server/routes/server-config');

// Initialize Express app
const app = express();

// Setup middleware
setupMiddleware(app);

/**
 * Serves the Certificate Authority (CA) certificate for download.
 * Users can install this CA certificate to trust all server certificates
 * generated by this application across their network.
 *
 * @name GET /ca-cert.pem
 * @function
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {void} Downloads the CA certificate file or sends 404 error
 */
app.get('/ca-cert.pem', (req, res) => {
  const { getAppBaseDir, isPackaged } = require('./server/config');
  let CERTS_DIR;
  if (isPackaged()) {
    CERTS_DIR = path.join(getAppBaseDir(), 'userdata', 'certs');
  } else {
    CERTS_DIR = path.join(__dirname, 'userdata', 'certs');
  }
  const caCertPath = path.join(CERTS_DIR, 'ca-cert.pem');

  res.download(caCertPath, 'ShippingManager-CA.pem', (err) => {
    if (err) {
      logger.error('Error downloading CA certificate:', err);
      res.status(404).send('CA certificate not found');
    }
  });
});

// Setup routes
app.use('/api', allianceRoutes);
app.use('/api/alliances', alliancesRoutes);
app.use('/api', messengerRoutes);
app.use('/api', gameRoutes);
app.use('/api', settingsRoutes);
app.use('/api', coopRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api', anchorRoutes);
app.use('/health', healthRoutes);
app.use('/api/logbook', logbookRoutes);
app.use('/api/harbor-map', harborMapRoutes);
app.use('/api/poi', poiRoutes);
app.use('/api/vessel-image', vesselImageRoutes);
app.use('/api/vessel-svg', vesselSvgRoutes);
app.use('/api/alliance-logo', allianceLogoRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/route', routePlannerRoutes);
app.use('/api', stockRoutes);
app.use('/api/broadcast', broadcastRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api', serverConfigRoutes);

// Autopilot pause/resume endpoint
app.post('/api/autopilot/toggle', async (req, res) => {
  const isPaused = autopilot.isAutopilotPaused();

  if (isPaused) {
    await autopilot.resumeAutopilot();
    res.json({ success: true, paused: false });
  } else {
    await autopilot.pauseAutopilot();
    res.json({ success: true, paused: true });
  }
});

// Get autopilot status endpoint
app.get('/api/autopilot/status', (req, res) => {
  res.json({ paused: autopilot.isAutopilotPaused() });
});

// Global error handler for API routes - returns JSON instead of HTML
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, req, res, next) => {
  logger.error(`[API Error] ${req.method} ${req.path}: ${err.message}`);
  logger.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    path: req.path
  });
});

// Create HTTPS server
const server = createHttpsServer(app);

// Initialize WebSocket
const wss = initWebSocket();

// HTTP Upgrade for WebSocket
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Settings initialization (will be done after user is loaded)
const { initializeSettings } = require('./server/settings-schema');
const chatBot = require('./server/chatbot');
const settingsMigrator = require('./server/utils/settings-migrator');

(async () => {
  // Start server
  server.listen(config.PORT, config.HOST, async () => {
    // Run settings migration (JSON -> Database)
    logger.info('[Migration] Running settings migration check...');
    try {
      const migrationResults = settingsMigrator.migrateAllSettings();
      if (migrationResults.global.migrated || Object.keys(migrationResults.users).length > 0) {
        logger.info('[Migration] Settings migration complete');
      }
    } catch (error) {
      logger.error('[Migration] Settings migration failed:', error.message);
    }

    // Load session cookie from encrypted storage FIRST
    logger.info('[Session] Loading sessions from encrypted storage...');

    try {
      let selectedSession;

      // User selection via ENV (from launcher) - takes priority
      const selectedUserId = process.env.SELECTED_USER_ID;

      if (selectedUserId) {
        // Launcher selected a specific user - find that session
        const availableSessions = await sessionManager.getAvailableSessions();
        selectedSession = availableSessions.find(s => String(s.userId) === String(selectedUserId));

        if (!selectedSession) {
          logger.error(`[FATAL] Selected user ${selectedUserId} not found in available sessions.`);
          process.exit(1);
        }

        logger.info(`[Session] Using selected session: ${selectedSession.companyName} (${selectedSession.userId})`);
      } else {
        // No explicit selection - use centralized validation to find first valid session
        selectedSession = await sessionManager.getFirstValidSession((level, msg) => {
          logger[level](`[Session] ${msg}`);
        });

        if (!selectedSession) {
          logger.error('[FATAL] No valid sessions found.');
          logger.error('[FATAL] Please log in first using one of these methods:');
          logger.error('[FATAL]   1. Run "npm start" to use the launcher GUI');
          logger.error('[FATAL]   2. Run "node launcher/cli.js" for command-line login');
          process.exit(1);
        }
      }

      // Set the session cookies in config (shipping_manager_session, app_platform, app_version)
      config.setSessionCookie(
        selectedSession.cookie,
        selectedSession.appPlatform,
        selectedSession.appVersion
      );
      logger.info('[Session] Session cookie loaded and decrypted');
      if (selectedSession.appPlatform) {
        logger.debug('[Session] app_platform cookie loaded');
      }
      if (selectedSession.appVersion) {
        logger.debug('[Session] app_version cookie loaded');
      }

    } catch (error) {
      logger.error('[FATAL] Failed to load session:', error.message);
      process.exit(1);
    }

    // Initialize alliance and user data
    await initializeAlliance();

    // Start alliance indexer (non-blocking)
    const allianceIndexer = require('./server/services/alliance-indexer');
    allianceIndexer.start();

    // Migrate any plaintext sessions to encrypted storage
    try {
      logger.debug('[Security] Checking for plaintext sessions to encrypt...');
      const migratedCount = await sessionManager.migrateToEncrypted();
      if (migratedCount > 0) {
        logger.info(`[Security] OK Successfully encrypted ${migratedCount} session(s)`);
      }
    } catch (error) {
      logger.error('[Security] Session migration failed:', error.message);
      logger.error('[Security] Sessions will remain in current format');
    }

    // Migrate any URL-encoded cookies to normalized (decoded) format
    try {
      const normalizedCount = await sessionManager.migrateToNormalizedCookies();
      if (normalizedCount > 0) {
        logger.info(`[Security] Normalized ${normalizedCount} URL-encoded cookie(s)`);
      }
    } catch (error) {
      logger.error('[Security] Cookie normalization failed:', error.message);
    }

    const state = require('./server/state');
    const { getUserId } = require('./server/utils/api');
    const userId = getUserId();

    if (!userId) {
      logger.error('[FATAL] Cannot load user ID. Please check session cookie.');
      process.exit(1);
    }

    logger.debug(`[Settings] Detected User ID: ${userId}`);
    logger.info(`[Settings] Loading user settings...`);

    // NOW load user-specific settings
    const settings = await initializeSettings(userId);

    // Load validated settings into state BEFORE initializing scheduler
    state.updateSettings(userId, settings);
    logger.info('[Autopilot] Settings loaded and validated:');
    if (settings.autoRebuyFuel) logger.debug(`[Autopilot] Barrel Boss enabled`);
    if (settings.autoRebuyCO2) logger.debug(`[Autopilot] Atmosphere Broker enabled`);
    if (settings.autoDepartAll) logger.debug(`[Autopilot] Cargo Marshal enabled`);
    if (settings.autoAnchorPointEnabled) logger.debug(`[Autopilot] Harbormaster enabled`);
    if (settings.autoBulkRepair) logger.debug(`[Autopilot] Yard Foreman enabled`);
    if (settings.autoCampaignRenewal) logger.debug(`[Autopilot] Reputation Chief enabled`);
    if (settings.autoCoopEnabled) logger.debug(`[Autopilot] Fair Hand enabled`);
    if (settings.autoNegotiateHijacking) logger.debug(`[Autopilot] Cap'n Blackbeard enabled`);

  // Initialize autopilot system (AFTER settings are loaded)
  autopilot.setBroadcastFunction(broadcastToUser);
  initScheduler();
  logger.info('[Autopilot] Backend autopilot system initialized');

  // Initialize Chat Bot with current settings
  const chatBotSettings = {
    enabled: settings.chatbotEnabled,
    commandPrefix: settings.chatbotPrefix,
    allianceCommands: {
      enabled: settings.chatbotAllianceCommandsEnabled,
      cooldownSeconds: settings.chatbotCooldownSeconds || 30
    },
    commands: {
      forecast: {
        enabled: settings.chatbotForecastCommandEnabled,
        responseType: 'dm',
        adminOnly: false
      },
      help: {
        enabled: settings.chatbotHelpCommandEnabled,
        responseType: 'dm',
        adminOnly: false
      }
    },
    scheduledMessages: {
      dailyForecast: {
        enabled: settings.chatbotDailyForecastEnabled,
        timeUTC: settings.chatbotDailyForecastTime,
        dayOffset: 1
      }
    },
    dmCommands: {
      enabled: settings.chatbotDMCommandsEnabled,
      deleteAfterReply: settings.chatbotDeleteDMAfterReply
    },
    customCommands: settings.chatbotCustomCommands || []
  };

  await chatBot.initialize(chatBotSettings);
  logger.info('[ChatBot] Chat Bot initialized with settings:');
  logger.debug(`[ChatBot] Enabled: ${settings.chatbotEnabled ? 'true' : 'false'}`);
  logger.debug(`[ChatBot] Command Prefix "${settings.chatbotPrefix}"`);
  if (settings.chatbotDailyForecastEnabled) {
    logger.debug(`[ChatBot] Daily Forecast enabled at ${settings.chatbotDailyForecastTime} UTC`);
  }
  if (settings.chatbotAllianceCommandsEnabled) {
    logger.debug(`[ChatBot] Alliance Commands enabled`);
  }
  if (settings.chatbotDMCommandsEnabled) {
    logger.debug(`[ChatBot] DM Commands enabled`);
  }

  // Start chat, messenger, hijacking, IPO, and staff polling
  startChatAutoRefresh();
  startMessengerAutoRefresh();
  startHijackingAutoRefresh();
  startIpoAutoRefresh();
  startStaffAutoRefresh();
  logger.debug('[Alliance Chat] Started 20-second chat polling');
  logger.debug('[Messenger] Started 20-second messenger polling');
  logger.debug('[Hijacking] Started 60-second hijacking polling');
  logger.debug('[IPO Alert] Started 5-minute IPO polling');
  logger.debug('[Staff] Started 5-minute staff morale polling');

  // Start transaction history auto-sync (every 5 minutes)
  transactionStore.startAutoSync(userId);
  logger.debug('[Transactions] Started 5-minute transaction sync');

  // Start vessel history auto-sync (every 5 minutes)
  vesselHistoryStore.startAutoSync(userId);
  logger.debug('[VesselHistory] Started 5-minute vessel history sync');

  // NOTE: buildLookup is now triggered in scheduler.js AFTER serverReady=true
  // This prevents SQLite blocking from interfering with initial data load

  // Initialize POI cache and start automatic refresh
  await poiRoutes.initializePOICache();
  poiRoutes.startAutomaticCacheRefresh();

  // All automation runs via scheduler.js and autopilot.js

  // Display network addresses
  const networkInterfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }

  // Only show network addresses if server is listening on all interfaces (0.0.0.0)
  const isNetworkAccessible = config.HOST === '0.0.0.0';

  if (isNetworkAccessible) {
    // Show all URLs in single line
    const urls = [`https://localhost:${config.PORT}`, ...addresses.map(addr => `https://${addr}:${config.PORT}`)];
    logger.info(`[Frontend] ShippingManager CoPilot Frontend running on: ${urls.join(', ')}`);
  } else {
    // Show only the configured specific IP
    logger.info(`[Frontend] ShippingManager CoPilot Frontend running on: https://${config.HOST}:${config.PORT}`);
  }
  logger.warn(`[Frontend] Self-signed certificate - accept security warning in browser`);
  });
})();

} // End of else block (server mode)
