/**
 * @fileoverview Store Adapter
 *
 * Provides SQLite-based stores for analytics data.
 * Handles automatic migration on first access.
 *
 * Usage:
 *   const { transactionStore, vesselHistoryStore, lookupStore, portDemandStore } = require('./database/store-adapter');
 *
 * @module server/database/store-adapter
 */

const logger = require('../utils/logger');
const { initUserDatabase } = require('./init');
const { isMigrationComplete } = require('./index');

// Track which users have been initialized this session
const initializedUsers = new Set();

/**
 * Ensure user's database is initialized before store access
 * @param {string} userId - User ID
 */
async function ensureUserInitialized(userId) {
  if (initializedUsers.has(userId)) {
    return;
  }

  if (!isMigrationComplete(userId)) {
    logger.info(`[StoreAdapter] Initializing database for user ${userId}`);
    await initUserDatabase(userId);
  }

  initializedUsers.add(userId);
}

// Import SQLite stores
const sqliteTransactionStore = require('./stores/transaction-store');
const sqliteVesselHistoryStore = require('./stores/vessel-history-store');
const sqliteLookupStore = require('./stores/lookup-store');
const sqlitePortDemandStore = require('./stores/port-demand-store');

/**
 * Wrap store functions to ensure database is initialized
 * @param {Object} store - Store module
 * @returns {Object} Wrapped store
 */
function wrapStore(store) {
  const wrapped = {};

  for (const [key, value] of Object.entries(store)) {
    if (typeof value === 'function') {
      // Check if first param is userId (heuristic: functions that need user context)
      const funcStr = value.toString();
      const needsInit = funcStr.includes('userId') || funcStr.includes('getDb(');

      if (needsInit) {
        wrapped[key] = async function(userId, ...args) {
          await ensureUserInitialized(String(userId));
          return value(String(userId), ...args);
        };
      } else {
        wrapped[key] = value;
      }
    } else {
      wrapped[key] = value;
    }
  }

  return wrapped;
}

// Export wrapped stores
const transactionStore = wrapStore(sqliteTransactionStore);
const vesselHistoryStore = wrapStore(sqliteVesselHistoryStore);
const lookupStore = wrapStore(sqliteLookupStore);
const portDemandStore = wrapStore(sqlitePortDemandStore);

module.exports = {
  transactionStore,
  vesselHistoryStore,
  lookupStore,
  portDemandStore,
  ensureUserInitialized
};
