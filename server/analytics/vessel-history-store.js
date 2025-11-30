/**
 * @fileoverview Vessel History Store
 *
 * Fetches and caches vessel trip history from the Game API.
 * Transforms historical data into "Game Departure" entries compatible
 * with the audit log format for analytics merging.
 *
 * Features:
 * - Incremental sync: tracks per-vessel sync state
 * - Resumable: saves progress after each vessel
 * - Auto-start: can run in background on server startup
 * - Only fetches new entries since last sync per vessel
 *
 * @module server/analytics/vessel-history-store
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { apiCallWithRetry } = require('../utils/api');
const { getAppDataDir } = require('../config');

const isPkg = !!process.pkg;
const DATA_DIR = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'vessel-history')
  : path.join(__dirname, '../../userdata/vessel-history');

// In-memory sync state
let syncState = {
  isRunning: false,
  shouldStop: false,
  currentVesselIndex: 0,
  totalVessels: 0,
  currentVesselName: null,
  syncedThisRun: 0,
  newEntriesThisRun: 0
};

// Short-term cache for loadStore to avoid duplicate file reads
const FILE_CACHE_TTL = 2000; // 2 seconds
const storeCache = new Map(); // userId -> { data, timestamp }

/**
 * Get file path for user's vessel history store
 * @param {string} userId - User ID
 * @returns {string} File path
 */
function getStorePath(userId) {
  return path.join(DATA_DIR, `${userId}-vessel-history.json`);
}

/**
 * Ensure vessel history directory exists
 */
async function ensureDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logger.error('[VesselHistoryStore] Failed to create directory:', err);
    }
  }
}

/**
 * Load stored vessel history from disk (cached for 2 seconds)
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Vessel history data
 */
async function loadStore(userId) {
  const now = Date.now();
  const cached = storeCache.get(userId);

  if (cached && (now - cached.timestamp) < FILE_CACHE_TTL) {
    return cached.data;
  }

  try {
    const filePath = getStorePath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    const store = JSON.parse(data);
    // Ensure all required fields exist
    if (!store.vessels) store.vessels = {};
    if (!store.departures) store.departures = [];
    if (!store.routeHijackRisks) store.routeHijackRisks = {};
    if (!store.syncProgress) {
      store.syncProgress = {
        status: 'idle',
        lastVesselIndex: -1,
        vesselIds: []
      };
    }

    // Migration: Add IDs to departures that don't have them
    let migrated = 0;
    for (const d of store.departures) {
      if (!d.id) {
        const vesselId = d.details?.departedVessels?.[0]?.vesselId;
        if (vesselId && d.timestamp) {
          d.id = generateDepartureId(vesselId, d.timestamp);
          migrated++;
        }
      }
    }

    // Save if we migrated any entries
    if (migrated > 0) {
      logger.info(`[VesselHistoryStore] Migrated ${migrated} departures with new IDs`);
      await saveStore(userId, store);
    }

    storeCache.set(userId, { data: store, timestamp: now });
    return store;
  } catch (err) {
    if (err.code === 'ENOENT') {
      const emptyStore = {
        userId,
        lastFullSync: 0,
        vessels: {},
        departures: [],
        routeHijackRisks: {},
        syncProgress: {
          status: 'idle',
          lastVesselIndex: -1,
          vesselIds: []
        }
      };
      storeCache.set(userId, { data: emptyStore, timestamp: now });
      return emptyStore;
    }
    logger.error('[VesselHistoryStore] Failed to load store:', err);
    return {
      userId,
      lastFullSync: 0,
      vessels: {},
      departures: [],
      routeHijackRisks: {},
      syncProgress: {
        status: 'idle',
        lastVesselIndex: -1,
        vesselIds: []
      }
    };
  }
}

/**
 * Save vessel history to disk
 * @param {string} userId - User ID
 * @param {Object} store - Vessel history store data
 */
async function saveStore(userId, store) {
  await ensureDir();
  const filePath = getStorePath(userId);
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
  // Invalidate cache after write
  storeCache.delete(userId);
}

/**
 * Parse game API date string to timestamp
 * @param {string} dateStr - Date string like "2025-10-21 08:46:34"
 * @returns {number} Unix timestamp in milliseconds
 */
function parseGameDate(dateStr) {
  const date = new Date(dateStr.replace(' ', 'T') + 'Z');
  return date.getTime();
}

/**
 * Generate deterministic ID for a vessel history departure
 * @param {number} vesselId - Vessel ID
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string} Unique ID
 */
function generateDepartureId(vesselId, timestamp) {
  return `pod3_${vesselId}_${timestamp}`;
}

/**
 * Transform vessel history entry to audit log format
 * @param {Object} historyEntry - Raw vessel history entry from API
 * @param {Object} vesselInfo - Vessel info (id, name)
 * @returns {Object} Audit log compatible entry
 */
function transformToAuditEntry(historyEntry, vesselInfo) {
  const timestamp = parseGameDate(historyEntry.created_at);
  const totalCargo = (historyEntry.cargo?.dry || 0) + (historyEntry.cargo?.refrigerated || 0);
  const id = generateDepartureId(historyEntry.vessel_id, timestamp);

  return {
    id,
    autopilot: 'Game Import',
    status: 'SUCCESS',
    timestamp,
    source: 'game-api',
    details: {
      vesselCount: 1,
      totalRevenue: historyEntry.route_income,
      totalFuelUsed: historyEntry.fuel_used,
      totalHarborFees: 0,
      contributionGainedTotal: 0,
      departedVessels: [{
        vesselId: historyEntry.vessel_id,
        name: vesselInfo.name,
        origin: historyEntry.route_origin,
        destination: historyEntry.route_destination,
        routeName: historyEntry.route_name,
        distance: historyEntry.total_distance,
        fuelUsed: historyEntry.fuel_used,
        income: historyEntry.route_income,
        wear: historyEntry.wear,
        duration: historyEntry.duration,
        cargo: {
          dry: historyEntry.cargo?.dry || 0,
          refrigerated: historyEntry.cargo?.refrigerated || 0,
          total: totalCargo
        }
      }]
    }
  };
}

/**
 * Fetch vessel history for a single vessel
 * @param {number} vesselId - Vessel ID
 * @returns {Promise<Object|null>} Vessel data with history or null
 */
async function fetchVesselHistory(vesselId) {
  try {
    const response = await apiCallWithRetry('/vessel/get-vessel-history', 'POST', { vessel_id: vesselId });
    if (response.data?.user_vessel) {
      return {
        vessel: response.data.user_vessel,
        history: response.data.vessel_history || []
      };
    }
    return null;
  } catch (err) {
    logger.error(`[VesselHistoryStore] Failed to fetch history for vessel ${vesselId}:`, err.message);
    return null;
  }
}

/**
 * Fetch all user vessels
 * @returns {Promise<Array>} Array of vessel objects
 */
async function fetchAllVessels() {
  try {
    const response = await apiCallWithRetry('/vessel/get-all-user-vessels', 'POST', { include_routes: false });
    return response.data?.user_vessels || [];
  } catch (err) {
    logger.error('[VesselHistoryStore] Failed to fetch vessels:', err.message);
    return [];
  }
}

/**
 * Get current sync progress/status
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Sync progress info
 */
async function getSyncProgress(userId) {
  const store = await loadStore(userId);

  // Count vessels that have been synced
  const syncedVessels = Object.values(store.vessels).filter(v => v.lastSyncedAt > 0).length;
  const totalVesselsInStore = Object.keys(store.vessels).length;

  return {
    isRunning: syncState.isRunning,
    status: syncState.isRunning ? 'running' : store.syncProgress.status,
    currentVesselIndex: syncState.isRunning ? syncState.currentVesselIndex : store.syncProgress.lastVesselIndex + 1,
    totalVessels: syncState.isRunning ? syncState.totalVessels : store.syncProgress.vesselIds.length,
    currentVesselName: syncState.currentVesselName,
    syncedVessels,
    totalVesselsInStore,
    syncedThisRun: syncState.syncedThisRun,
    newEntriesThisRun: syncState.newEntriesThisRun,
    totalDepartures: store.departures.length,
    lastFullSync: store.lastFullSync
  };
}

/**
 * Stop the current sync process
 */
function stopSync() {
  if (syncState.isRunning) {
    syncState.shouldStop = true;
    logger.info('[VesselHistoryStore] Stop requested');
  }
}

/**
 * Sync vessel history incrementally - resumable and tracks per-vessel state
 * @param {string} userId - User ID
 * @param {Object} options - Sync options
 * @param {boolean} options.forceResync - Force resync all vessels even if already synced
 * @param {number} options.batchSize - Number of vessels to sync before pausing (0 = all)
 * @returns {Promise<Object>} Sync result
 */
async function syncVesselHistory(userId, options = {}) {
  const { forceResync = false, batchSize = 0 } = options;

  if (syncState.isRunning) {
    logger.warn('[VesselHistoryStore] Sync already in progress');
    return { error: 'Sync already in progress', ...await getSyncProgress(userId) };
  }

  syncState.isRunning = true;
  syncState.shouldStop = false;
  syncState.syncedThisRun = 0;
  syncState.newEntriesThisRun = 0;

  try {
    const store = await loadStore(userId);

    // Get current vessel list from API
    const vessels = await fetchAllVessels();
    if (vessels.length === 0) {
      logger.warn('[VesselHistoryStore] No vessels found');
      syncState.isRunning = false;
      return { synced: 0, newEntries: 0, total: store.departures.length };
    }

    const vesselIds = vessels.map(v => v.id);
    syncState.totalVessels = vessels.length;

    // Determine starting point
    let startIndex = 0;
    if (!forceResync && store.syncProgress.status === 'paused' &&
        JSON.stringify(store.syncProgress.vesselIds) === JSON.stringify(vesselIds)) {
      // Resume from where we left off
      startIndex = store.syncProgress.lastVesselIndex + 1;
      logger.info(`[VesselHistoryStore] Resuming from vessel ${startIndex + 1}/${vessels.length}`);
    } else {
      // Start fresh
      store.syncProgress.vesselIds = vesselIds;
      store.syncProgress.lastVesselIndex = -1;
    }

    store.syncProgress.status = 'running';
    await saveStore(userId, store);

    // Create departure key set for deduplication
    const existingKeys = new Set(
      store.departures.map(d => `${d.details?.departedVessels?.[0]?.vesselId}-${d.timestamp}`)
    );

    let processedInBatch = 0;

    for (let i = startIndex; i < vessels.length; i++) {
      // Check for stop request
      if (syncState.shouldStop) {
        store.syncProgress.status = 'paused';
        store.syncProgress.lastVesselIndex = i - 1;
        await saveStore(userId, store);
        logger.info(`[VesselHistoryStore] Sync paused at vessel ${i}/${vessels.length}`);
        break;
      }

      // Check batch size limit
      if (batchSize > 0 && processedInBatch >= batchSize) {
        store.syncProgress.status = 'paused';
        store.syncProgress.lastVesselIndex = i - 1;
        await saveStore(userId, store);
        logger.info(`[VesselHistoryStore] Batch complete, paused at vessel ${i}/${vessels.length}`);
        break;
      }

      const vessel = vessels[i];
      const vesselId = vessel.id;

      syncState.currentVesselIndex = i;
      syncState.currentVesselName = vessel.name;

      // Check if vessel needs sync
      const vesselState = store.vessels[vesselId];
      const newestEntryTimestamp = vesselState?.newestEntryAt || 0;

      // Fetch vessel history
      const historyData = await fetchVesselHistory(vesselId);
      if (!historyData) {
        // API error, continue to next vessel
        continue;
      }

      // Update vessel info
      store.vessels[vesselId] = {
        id: vesselId,
        name: historyData.vessel.name,
        typeName: historyData.vessel.type_name,
        lastSyncedAt: Date.now(),
        newestEntryAt: vesselState?.newestEntryAt || 0,
        entryCount: vesselState?.entryCount || 0
      };

      // Extract hijacking risk from vessel's routes
      const routes = historyData.vessel.routes;
      if (routes && Array.isArray(routes)) {
        for (const route of routes) {
          const origin = route.origin;
          const destination = route.destination;
          const hijackingRisk = route.hijacking_risk;
          if (origin && destination && hijackingRisk !== undefined && hijackingRisk !== null) {
            const routeKey = `${origin}<>${destination}`;
            // Store highest risk if route exists from multiple vessels
            const existing = store.routeHijackRisks[routeKey];
            if (existing === undefined || hijackingRisk > existing) {
              store.routeHijackRisks[routeKey] = hijackingRisk;
            }
          }
        }
      }

      // Process history entries - only add new ones
      let newForThisVessel = 0;
      let latestTimestamp = newestEntryTimestamp;

      for (const entry of historyData.history) {
        const entryTimestamp = parseGameDate(entry.created_at);
        const key = `${entry.vessel_id}-${entryTimestamp}`;

        // Skip if we already have this entry OR if it's older than our newest
        if (existingKeys.has(key)) continue;
        if (!forceResync && entryTimestamp <= newestEntryTimestamp) continue;

        const auditEntry = transformToAuditEntry(entry, { name: historyData.vessel.name });
        store.departures.push(auditEntry);
        existingKeys.add(key);
        newForThisVessel++;
        syncState.newEntriesThisRun++;

        if (entryTimestamp > latestTimestamp) {
          latestTimestamp = entryTimestamp;
        }
      }

      // Update vessel's newest entry timestamp
      store.vessels[vesselId].newestEntryAt = latestTimestamp;
      store.vessels[vesselId].entryCount = (vesselState?.entryCount || 0) + newForThisVessel;

      // Update progress and save after each vessel
      store.syncProgress.lastVesselIndex = i;
      syncState.syncedThisRun++;
      processedInBatch++;

      // Save progress every vessel (resumable)
      await saveStore(userId, store);

      if (newForThisVessel > 0) {
        logger.debug(`[VesselHistoryStore] ${vessel.name}: +${newForThisVessel} entries`);
      }

      // Small delay to be nice to the API (rate limiting handled by apiCallWithRetry)
      if (i < vessels.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Sort departures by timestamp
    store.departures.sort((a, b) => a.timestamp - b.timestamp);

    // Check if complete
    if (store.syncProgress.lastVesselIndex >= vessels.length - 1) {
      store.syncProgress.status = 'complete';
      store.lastFullSync = Date.now();
      logger.info(`[VesselHistoryStore] Sync complete: ${syncState.newEntriesThisRun} new entries, ${store.departures.length} total`);
    }

    await saveStore(userId, store);

    return {
      synced: syncState.syncedThisRun,
      newEntries: syncState.newEntriesThisRun,
      total: store.departures.length,
      status: store.syncProgress.status,
      progress: `${store.syncProgress.lastVesselIndex + 1}/${vessels.length}`
    };

  } finally {
    syncState.isRunning = false;
    syncState.currentVesselName = null;
  }
}

/**
 * Start background sync on server startup
 * Runs incrementally, pauses if server stops
 * @param {string} userId - User ID
 */
async function startBackgroundSync(userId) {
  if (!userId) {
    logger.warn('[VesselHistoryStore] Cannot start background sync: no userId');
    return;
  }

  const store = await loadStore(userId);
  const progress = await getSyncProgress(userId);

  // Only auto-start if not complete or if it's been more than 24h since last full sync
  const daysSinceSync = store.lastFullSync ? (Date.now() - store.lastFullSync) / (24 * 60 * 60 * 1000) : Infinity;

  if (store.syncProgress.status === 'complete' && daysSinceSync < 1) {
    logger.info(`[VesselHistoryStore] Sync complete and recent (${daysSinceSync.toFixed(1)}d ago), skipping auto-sync`);
    return;
  }

  logger.info(`[VesselHistoryStore] Starting background sync (status: ${store.syncProgress.status}, ${progress.syncedVessels} vessels synced)`);

  // Run in background, don't await
  syncVesselHistory(userId).catch(err => {
    logger.error('[VesselHistoryStore] Background sync error:', err.message);
  });
}

/**
 * Get all stored departures (Game Departure entries)
 * @param {string} userId - User ID
 * @returns {Promise<Array>} All departures
 */
async function getDepartures(userId) {
  const store = await loadStore(userId);
  return store.departures;
}

/**
 * Get departures within a time range
 * @param {string} userId - User ID
 * @param {number} days - Number of days to look back
 * @returns {Promise<Array>} Filtered departures
 */
async function getDeparturesByDays(userId, days) {
  const store = await loadStore(userId);
  // days === 0 means "all time" - no filtering
  if (days === 0) return store.departures;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return store.departures.filter(d => d.timestamp >= cutoff);
}

/**
 * Get departures before a specific timestamp
 * @param {string} userId - User ID
 * @param {number} beforeTimestamp - Get entries before this timestamp
 * @returns {Promise<Array>} Filtered departures
 */
async function getDeparturesBefore(userId, beforeTimestamp) {
  const store = await loadStore(userId);
  return store.departures.filter(d => d.timestamp < beforeTimestamp);
}

/**
 * Get store metadata
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Store info
 */
async function getStoreInfo(userId) {
  const store = await loadStore(userId);
  const progress = await getSyncProgress(userId);

  if (store.departures.length === 0) {
    return {
      totalDepartures: 0,
      totalVessels: Object.keys(store.vessels).length,
      syncedVessels: progress.syncedVessels,
      oldestDeparture: null,
      newestDeparture: null,
      lastFullSync: store.lastFullSync,
      dataSpanDays: 0,
      syncStatus: progress.status,
      syncProgress: progress.status === 'running'
        ? `${progress.currentVesselIndex + 1}/${progress.totalVessels} (${progress.currentVesselName})`
        : `${progress.currentVesselIndex}/${progress.totalVessels}`
    };
  }

  const sorted = [...store.departures].sort((a, b) => a.timestamp - b.timestamp);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const spanMs = newest.timestamp - oldest.timestamp;
  const spanDays = Math.ceil(spanMs / (24 * 60 * 60 * 1000));

  return {
    totalDepartures: store.departures.length,
    totalVessels: Object.keys(store.vessels).length,
    syncedVessels: progress.syncedVessels,
    oldestDeparture: new Date(oldest.timestamp).toISOString(),
    newestDeparture: new Date(newest.timestamp).toISOString(),
    lastFullSync: store.lastFullSync ? new Date(store.lastFullSync).toISOString() : null,
    dataSpanDays: spanDays,
    syncStatus: progress.status,
    syncProgress: progress.status === 'running'
      ? `${progress.currentVesselIndex + 1}/${progress.totalVessels} (${progress.currentVesselName})`
      : `${progress.currentVesselIndex}/${progress.totalVessels}`
  };
}

/**
 * Clear stored vessel history (for testing or reset)
 * @param {string} userId - User ID
 */
async function clearStore(userId) {
  const store = {
    userId,
    lastFullSync: 0,
    vessels: {},
    departures: [],
    syncProgress: {
      status: 'idle',
      lastVesselIndex: -1,
      vesselIds: []
    }
  };
  await saveStore(userId, store);
  logger.info('[VesselHistoryStore] Store cleared');
}

// Auto-sync interval (5 minutes)
const SYNC_INTERVAL = 5 * 60 * 1000;
let autoSyncInterval = null;

/**
 * Start automatic background sync for vessel history
 * @param {string} userId - User ID to sync for
 */
function startAutoSync(userId) {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
  }

  // Do initial sync
  logger.info('[VesselHistoryStore] Starting initial sync...');
  syncVesselHistory(userId).then(result => {
    logger.info(`[VesselHistoryStore] Initial sync complete: ${result.newEntries} new departures`);

    // Rebuild lookup after initial sync
    if (result.newEntries > 0) {
      const lookupStore = require('./lookup-store');
      lookupStore.buildLookup(userId, 0).then(lookupResult => {
        logger.info(`[VesselHistoryStore] Lookup rebuilt: ${lookupResult.newEntries} new, POD3=${lookupResult.matchedPod3}`);
      }).catch(err => {
        logger.error('[VesselHistoryStore] Failed to rebuild lookup:', err.message);
      });
    }
  }).catch(err => {
    logger.error('[VesselHistoryStore] Initial sync failed:', err.message);
  });

  // Set up recurring sync every 5 minutes
  autoSyncInterval = setInterval(async () => {
    try {
      const result = await syncVesselHistory(userId);
      if (result.newEntries > 0) {
        logger.info(`[VesselHistoryStore] Auto-sync: ${result.newEntries} new departures`);

        // Rebuild lookup after new departures
        const lookupStore = require('./lookup-store');
        const lookupResult = await lookupStore.buildLookup(userId, 0);
        logger.info(`[VesselHistoryStore] Lookup rebuilt: ${lookupResult.newEntries} new, POD3=${lookupResult.matchedPod3}`);
      }
    } catch (err) {
      logger.error('[VesselHistoryStore] Auto-sync failed:', err.message);
    }
  }, SYNC_INTERVAL);

  logger.info('[VesselHistoryStore] Started auto-sync (every 5 minutes)');
}

/**
 * Stop automatic background sync
 */
function stopAutoSync() {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
    logger.info('[VesselHistoryStore] Stopped auto-sync');
  }
}

/**
 * Get stored route hijacking risks
 * Returns a Map with route keys (origin<>destination) and their hijacking risk percentages
 * @param {string} userId - User ID
 * @returns {Promise<Map<string, number>>} Route hijacking risks
 */
async function getRouteHijackingRisks(userId) {
  const store = await loadStore(userId);
  const riskMap = new Map();

  if (store.routeHijackRisks) {
    for (const [routeKey, risk] of Object.entries(store.routeHijackRisks)) {
      riskMap.set(routeKey, risk);
    }
  }

  return riskMap;
}

module.exports = {
  syncVesselHistory,
  startBackgroundSync,
  stopSync,
  getSyncProgress,
  getDepartures,
  getDeparturesByDays,
  getDeparturesBefore,
  getStoreInfo,
  clearStore,
  generateDepartureId,
  startAutoSync,
  stopAutoSync,
  getRouteHijackingRisks,
  // Legacy alias
  syncAllVesselHistory: syncVesselHistory
};
