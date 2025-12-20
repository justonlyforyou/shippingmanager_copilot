/**
 * @fileoverview Port Demand Sync Service
 *
 * Continuously syncs port demand data for all ports.
 * Distributes API calls evenly over 30 minutes to avoid rate limiting.
 *
 * Strategy:
 * - 360 ports / 30 minutes = 12 ports per minute = 1 port every 5 seconds
 * - Fetches demand via /port/get-ports for each port
 * - Stores in SQLite for historical analysis
 *
 * @module server/services/port-demand-sync
 */

const { apiCall, getUserId } = require('../utils/api');
const { portDemandStore } = require('../database/stores');
const cache = require('../cache');
const logger = require('../utils/logger');

// Sync configuration
const SYNC_INTERVAL_MS = 5000; // 5 seconds between port fetches

// State
let syncTimer = null;
let allPortCodes = [];
let currentIndex = 0;
let syncRunning = false;
let lastFullCycleAt = null;
let portsFetchedThisCycle = 0;

/**
 * Initialize port codes from game/index cache or API
 * @returns {Promise<boolean>} True if initialized successfully
 */
async function initPortCodes() {
  try {
    // Try cache first
    let gameIndex = cache.getGameIndexCache();

    if (!gameIndex) {
      logger.debug('[PortDemandSync] No game/index cache, fetching...');
      gameIndex = await apiCall('/game/index', 'POST', {});
      cache.setGameIndexCache(gameIndex);
    }

    if (!gameIndex?.data?.ports) {
      logger.error('[PortDemandSync] No ports in game/index response');
      return false;
    }

    allPortCodes = gameIndex.data.ports.map(p => p.code);
    logger.info(`[PortDemandSync] Initialized with ${allPortCodes.length} ports`);
    return true;
  } catch (err) {
    logger.error(`[PortDemandSync] Failed to init port codes: ${err.message}`);
    return false;
  }
}

/**
 * Fetch demand for a single port and save to history
 * @param {string} portCode - Port code to fetch
 * @returns {Promise<boolean>} True if successful
 */
async function fetchAndSavePort(portCode) {
  const userId = getUserId();
  if (!userId) {
    logger.debug('[PortDemandSync] No user ID, skipping');
    return false;
  }

  try {
    const data = await apiCall('/port/get-ports', 'POST', {
      port_code: [portCode]
    });

    const port = data.data?.port?.[0];
    if (!port) {
      logger.warn(`[PortDemandSync] No data for port ${portCode}`);
      return false;
    }

    // Save to history
    const result = portDemandStore.saveDemandSnapshot(userId, [port]);

    if (result.saved > 0) {
      logger.debug(`[PortDemandSync] Saved ${portCode} demand`);
    }

    return true;
  } catch (err) {
    logger.error(`[PortDemandSync] Failed to fetch ${portCode}: ${err.message}`);
    return false;
  }
}

/**
 * Process next port(s) in the sync queue
 */
async function processNextBatch() {
  if (!syncRunning) return;

  const userId = getUserId();
  if (!userId) {
    logger.debug('[PortDemandSync] No user ID, waiting...');
    return;
  }

  if (allPortCodes.length === 0) {
    const initialized = await initPortCodes();
    if (!initialized) {
      logger.warn('[PortDemandSync] Could not initialize, will retry...');
      return;
    }
  }

  // Fetch next port
  const portCode = allPortCodes[currentIndex];
  await fetchAndSavePort(portCode);

  portsFetchedThisCycle++;
  currentIndex++;

  // Check if cycle complete
  if (currentIndex >= allPortCodes.length) {
    currentIndex = 0;
    lastFullCycleAt = Date.now();
    logger.info(`[PortDemandSync] Completed full cycle (${portsFetchedThisCycle} ports)`);
    portsFetchedThisCycle = 0;
  }
}

/**
 * Start continuous port demand sync
 */
function startSync() {
  if (syncRunning) {
    logger.warn('[PortDemandSync] Already running');
    return;
  }

  syncRunning = true;
  currentIndex = 0;
  portsFetchedThisCycle = 0;

  logger.info(`[PortDemandSync] Starting continuous sync (1 port every ${SYNC_INTERVAL_MS / 1000}s)`);

  // Initial fetch
  processNextBatch();

  // Schedule continuous fetching
  syncTimer = setInterval(() => {
    processNextBatch().catch(err => {
      logger.error(`[PortDemandSync] Batch error: ${err.message}`);
    });
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop port demand sync
 */
function stopSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  syncRunning = false;
  logger.info('[PortDemandSync] Stopped');
}

/**
 * Get sync status
 * @returns {Object} Current sync status
 */
function getStatus() {
  const cycleProgress = allPortCodes.length > 0
    ? Math.round((currentIndex / allPortCodes.length) * 100)
    : 0;

  const estimatedCycleTimeMinutes = allPortCodes.length > 0
    ? Math.round((allPortCodes.length * SYNC_INTERVAL_MS) / 60000)
    : 0;

  return {
    running: syncRunning,
    totalPorts: allPortCodes.length,
    currentIndex,
    cycleProgress: `${cycleProgress}%`,
    portsFetchedThisCycle,
    lastFullCycleAt: lastFullCycleAt ? new Date(lastFullCycleAt).toISOString() : null,
    estimatedCycleTimeMinutes,
    intervalSeconds: SYNC_INTERVAL_MS / 1000
  };
}

module.exports = {
  startSync,
  stopSync,
  getStatus,
  initPortCodes
};
