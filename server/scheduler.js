/**
 * @fileoverview Scheduler Service
 *
 * Manages timed tasks using cron.
 *
 * Event-Driven Autopilot Architecture:
 * - Main loop runs every 60 seconds, checks game state
 * - Triggers autopilot functions based on conditions (vessels ready, repair needed, etc.)
 * - Price updates: :01 and :31 every hour (when game updates prices)
 * - Auto-Anchor: Every 5 minutes (separate from main loop)
 *
 * @module server/scheduler
 */

// Using 'cron' package instead of 'node-cron' because it handles DST properly
const { CronJob } = require('cron');
const autopilot = require('./autopilot');
const state = require('./state');
const { getUserId } = require('./utils/api');
const logger = require('./utils/logger');
const { isMigrationCompleted } = require('./utils/trip-data-store');
const { migrateHarborFeesForUser } = require('./utils/migrate-harbor-fees');
const { initUserDatabase } = require('./database/init');
const portDemandSync = require('./services/port-demand-sync');
const { lookupStore, vesselHistoryStore } = require('./database/store-adapter');

/**
 * Server ready state flag
 * Set to true after initial data load completes
 */
let serverReady = false;

/**
 * Initialization error (if any)
 * Contains error message and code when startup fails
 */
let initError = null;

/**
 * Initializes all schedulers.
 * Called once during server startup.
 */
function initScheduler() {
  logger.info('[Scheduler] Initializing schedulers...');

  // 1. Price Updates: At :01 and :31 every hour (2 times per hour)
  // Game prices change at :00 and :30, we fetch 1 minute after to ensure fresh data
  new CronJob('0 1,31 * * * *', async () => {
    try {
      const userId = getUserId();
      if (!userId) return;

      logger.info('[Scheduler] Updating prices...');
      await autopilot.updatePrices();
    } catch (error) {
      logger.error('[Scheduler] Price update failed:', error.message);
    }
  }, null, true, 'Europe/Berlin');

  // 2. Auto-Anchor: Every 5 minutes
  new CronJob('0 */5 * * * *', async () => {
    try {
      logger.debug('[Scheduler] Auto-Anchor cron triggered');
      const userId = getUserId();
      if (!userId) {
        logger.debug('[Scheduler] Auto-Anchor skipped - no userId');
        return;
      }

      if (!serverReady) {
        logger.debug('[Scheduler] Auto-Anchor skipped - server not ready');
        return;
      }

      const settings = state.getSettings(userId);
      if (settings.autoAnchorPointEnabled) {
        const bunker = state.getBunkerState(userId);
        if (!bunker || bunker.points === undefined) {
          logger.warn('[Scheduler] Auto-Anchor skipped - bunker data not loaded');
          return;
        }

        logger.info('[Scheduler] Running Auto-Anchor (Harbormaster)');
        await autopilot.autoAnchorPointPurchase(userId);
      }
    } catch (error) {
      logger.error('[Scheduler] Auto-Anchor failed:', error);
    }
  }, null, true, 'Europe/Berlin');

  logger.info('[Scheduler] Schedulers initialized');
  logger.info('[Scheduler] - Auto-Anchor: every 5 minutes');
  logger.info('[Scheduler] - Price updates: every 60 seconds (in main event loop)');

  // Initial startup: Load essential data BEFORE starting event loop
  logger.info('[Scheduler] Loading initial UI data in 10 seconds...');
  setTimeout(async () => {
    logger.info('[Scheduler] INITIAL DATA LOAD FOR UI');

    try {
      const userId = getUserId();
      if (!userId) {
        throw new Error('[Scheduler] No user ID available');
      }

      const settings = state.getSettings(userId);
      if (!settings) {
        throw new Error('[Scheduler] No settings available');
      }

      // SQLite Database Migration: Automatically migrate JSON data on first run
      logger.info('[Scheduler] Checking SQLite database migration...');
      try {
        const dbResult = await initUserDatabase(userId);
        if (dbResult.migrated) {
          logger.info(`[Scheduler] SQLite migration completed: ${dbResult.totals?.vessels || 0} vessels, ${dbResult.totals?.departures || 0} departures, ${dbResult.totals?.transactions || 0} transactions, ${dbResult.totals?.lookupEntries || 0} lookup entries`);
          logger.info('[Scheduler] JSON files renamed to *_ready_to_delete.json');
        } else if (dbResult.alreadyInitialized) {
          logger.debug('[Scheduler] SQLite database already initialized');
        } else if (dbResult.noDataToMigrate) {
          logger.debug('[Scheduler] No JSON data to migrate');
        }
      } catch (dbError) {
        logger.error('[Scheduler] SQLite migration failed:', dbError.message);
        logger.error('[Scheduler] Will continue with existing data stores');
      }

      // Initialize autopilot pause state
      autopilot.initializeAutopilotState(userId);

      // Load all initial data
      logger.info('[Scheduler] Step 1/3: Loading all game data...');
      await autopilot.updateAllData();

      logger.info('[Scheduler] Step 2/3: Loading current prices...');
      await autopilot.updatePrices();

      logger.info('[Scheduler] Step 3/3: Checking price alerts...');
      const prices = state.getPrices(userId);
      await autopilot.checkPriceAlerts(userId, prices);

      logger.info('[Scheduler] INITIAL DATA LOADED - UI READY');

      // Mark server as ready
      serverReady = true;

      // Broadcast server startup to all clients - triggers cache clear + reload
      const { broadcast } = require('./websocket/broadcaster');
      broadcast('server_startup', { timestamp: Date.now() });
      logger.info('[Scheduler] Broadcasted server_startup to all clients');

      // All background tasks use setTimeout to truly not block the event loop
      // This allows HTTP requests to be served immediately after UI READY

      // Lookup store build is NOT run at startup - it's too heavy and blocks the UI
      // It will be triggered on-demand when user opens analytics page
      // Harbor fee migration also deferred - not critical for startup
      logger.debug('[Scheduler] Skipping lookup build at startup (will run on-demand)');

      // Run Auto-Anchor once on startup
      logger.info('[Scheduler] Running Auto-Anchor on startup...');
      try {
        if (!autopilot.isAutopilotPaused()) {
          // (using settings from outer scope - already loaded on line 97)
          if (settings.autoAnchorPointEnabled) {
            await autopilot.autoAnchorPointPurchase(userId);
          } else {
            logger.debug('[Scheduler] Auto-Anchor disabled in settings');
          }
        } else {
          logger.debug('[Scheduler] Auto-Anchor skipped - Autopilot is PAUSED');
        }
      } catch (error) {
        logger.error('[Scheduler] Auto-Anchor startup run failed:', error);
      }

      // Start event-driven autopilot loop (60s interval)
      logger.info('[Scheduler] Starting event-driven autopilot loop...');
      autopilot.startMainEventLoop();

      // Start port demand sync (continuous, 1 port every 5 seconds)
      logger.info('[Scheduler] Starting port demand sync...');
      portDemandSync.startSync();

    } catch (error) {
      logger.error('[Scheduler] Initial data load failed:', error);

      // Determine error type for launcher to handle
      const errorMessage = error.message || String(error);
      const is401 = errorMessage.includes('401') ||
                    errorMessage.includes('Unauthorized') ||
                    errorMessage.includes('Session validation failed') ||
                    errorMessage.includes('No session user found');

      initError = {
        message: errorMessage,
        code: is401 ? 'SESSION_INVALID' : 'INIT_FAILED',
        is401: is401,
        timestamp: Date.now()
      };

      logger.error(`[Scheduler] Init error set: ${initError.code} - ${initError.message}`);
    }
  }, 10000);
}

/**
 * Check if server has completed initial data load
 * @returns {boolean} True if server is ready
 */
function isServerReady() {
  return serverReady;
}

/**
 * Get initialization error if any
 * @returns {Object|null} Error object with message, code, is401, timestamp
 */
function getInitError() {
  return initError;
}

module.exports = {
  initScheduler,
  isServerReady,
  getInitError
};
