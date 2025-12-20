/**
 * @fileoverview SQLite-based Vessel History Store
 *
 * Drop-in replacement for the JSON-based vessel history store.
 * Stores vessel trip history in SQLite for better performance.
 *
 * @module server/database/stores/vessel-history-store
 */

const logger = require('../../utils/logger');
const { apiCallWithRetry } = require('../../utils/api');
const { getDb, setMetadata, getMetadata } = require('../index');

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

// Slow background sync settings
const SLOW_SYNC_SPREAD_MINUTES = 60;
let slowSyncInterval = null;
let slowSyncVesselIndex = 0;
let slowSyncVesselList = [];

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
    logger.error(`[VesselHistoryStore/SQLite] Failed to fetch history for vessel ${vesselId}:`, err.message);
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
    logger.error('[VesselHistoryStore/SQLite] Failed to fetch vessels:', err.message);
    return [];
  }
}

/**
 * Get sync progress from database
 * @param {string} userId - User ID
 * @returns {Object} Sync progress
 */
function loadSyncProgress(userId) {
  const db = getDb(userId);

  const getProgress = db.prepare('SELECT key, value FROM sync_progress');
  const rows = getProgress.all();

  const progress = {
    status: 'idle',
    lastVesselIndex: -1,
    vesselIds: []
  };

  for (const row of rows) {
    if (row.key === 'status') progress.status = row.value;
    else if (row.key === 'lastVesselIndex') progress.lastVesselIndex = parseInt(row.value, 10);
    else if (row.key === 'vesselIds') progress.vesselIds = JSON.parse(row.value);
  }

  return progress;
}

/**
 * Save sync progress to database
 * @param {string} userId - User ID
 * @param {Object} progress - Sync progress object
 */
function saveSyncProgress(userId, progress) {
  const db = getDb(userId);
  const upsert = db.prepare('INSERT OR REPLACE INTO sync_progress (key, value) VALUES (?, ?)');

  upsert.run('status', progress.status);
  upsert.run('lastVesselIndex', String(progress.lastVesselIndex));
  upsert.run('vesselIds', JSON.stringify(progress.vesselIds));
}

/**
 * Get current sync progress/status
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Sync progress info
 */
async function getSyncProgress(userId) {
  const db = getDb(userId);
  const storedProgress = loadSyncProgress(userId);

  const syncedVessels = db.prepare('SELECT COUNT(*) as count FROM vessels WHERE last_synced_at > 0').get();
  const totalVessels = db.prepare('SELECT COUNT(*) as count FROM vessels').get();
  const totalDepartures = db.prepare('SELECT COUNT(*) as count FROM departures').get();
  const lastFullSync = getMetadata(userId, 'vessel_history_last_sync');

  return {
    isRunning: syncState.isRunning,
    status: syncState.isRunning ? 'running' : storedProgress.status,
    currentVesselIndex: syncState.isRunning ? syncState.currentVesselIndex : storedProgress.lastVesselIndex + 1,
    totalVessels: syncState.isRunning ? syncState.totalVessels : storedProgress.vesselIds.length,
    currentVesselName: syncState.currentVesselName,
    syncedVessels: syncedVessels.count,
    totalVesselsInStore: totalVessels.count,
    syncedThisRun: syncState.syncedThisRun,
    newEntriesThisRun: syncState.newEntriesThisRun,
    totalDepartures: totalDepartures.count,
    lastFullSync: lastFullSync ? parseInt(lastFullSync, 10) : 0
  };
}

/**
 * Stop the current sync process
 */
function stopSync() {
  if (syncState.isRunning) {
    syncState.shouldStop = true;
    logger.info('[VesselHistoryStore/SQLite] Stop requested');
  }
}

/**
 * Sync vessel history incrementally
 * @param {string} userId - User ID
 * @param {Object} options - Sync options
 * @returns {Promise<Object>} Sync result
 */
async function syncVesselHistory(userId, options = {}) {
  const { forceResync = false, batchSize = 0 } = options;

  if (syncState.isRunning) {
    logger.warn('[VesselHistoryStore/SQLite] Sync already in progress');
    return { error: 'Sync already in progress', ...await getSyncProgress(userId) };
  }

  syncState.isRunning = true;
  syncState.shouldStop = false;
  syncState.syncedThisRun = 0;
  syncState.newEntriesThisRun = 0;

  try {
    const db = getDb(userId);
    const storedProgress = loadSyncProgress(userId);

    // Get current vessel list from API
    const vessels = await fetchAllVessels();

    if (vessels.length === 0) {
      logger.warn('[VesselHistoryStore/SQLite] No vessels found');
      syncState.isRunning = false;
      const countRow = db.prepare('SELECT COUNT(*) as count FROM departures').get();
      return { synced: 0, newEntries: 0, total: countRow.count };
    }

    logger.info(`[VesselHistoryStore/SQLite] Syncing ${vessels.length} vessels`);

    const vesselIds = vessels.map(v => v.id);
    syncState.totalVessels = vessels.length;

    // Determine starting point
    let startIndex = 0;
    if (!forceResync && storedProgress.status === 'paused' &&
        JSON.stringify(storedProgress.vesselIds) === JSON.stringify(vesselIds)) {
      startIndex = storedProgress.lastVesselIndex + 1;
      logger.info(`[VesselHistoryStore/SQLite] Resuming from vessel ${startIndex + 1}/${vessels.length}`);
    }

    saveSyncProgress(userId, {
      status: 'running',
      lastVesselIndex: storedProgress.lastVesselIndex,
      vesselIds
    });

    let processedInBatch = 0;

    for (let i = startIndex; i < vessels.length; i++) {
      if (syncState.shouldStop) {
        saveSyncProgress(userId, { status: 'paused', lastVesselIndex: i - 1, vesselIds });
        logger.info(`[VesselHistoryStore/SQLite] Sync paused at vessel ${i}/${vessels.length}`);
        break;
      }

      if (batchSize > 0 && processedInBatch >= batchSize) {
        saveSyncProgress(userId, { status: 'paused', lastVesselIndex: i - 1, vesselIds });
        logger.info(`[VesselHistoryStore/SQLite] Batch complete, paused at vessel ${i}/${vessels.length}`);
        break;
      }

      const vessel = vessels[i];
      const vesselId = vessel.id;

      syncState.currentVesselIndex = i;
      syncState.currentVesselName = vessel.name;

      // Get current newest entry for this vessel
      const newestRow = db.prepare('SELECT MAX(timestamp) as newest FROM departures WHERE vessel_id = ?').get(vesselId);
      const newestEntryTimestamp = newestRow?.newest || 0;

      // Fetch vessel history
      const historyData = await fetchVesselHistory(vesselId);
      if (!historyData) continue;

      // Update vessel info
      const upsertVessel = db.prepare(`
        INSERT OR REPLACE INTO vessels (id, name, type_name, last_synced_at, newest_entry_at, entry_count)
        VALUES (?, ?, ?, ?, COALESCE((SELECT newest_entry_at FROM vessels WHERE id = ?), 0),
                COALESCE((SELECT entry_count FROM vessels WHERE id = ?), 0))
      `);
      upsertVessel.run(vesselId, historyData.vessel.name, historyData.vessel.type_name, Date.now(), vesselId, vesselId);

      // Extract hijacking risk from vessel's routes
      const routes = historyData.vessel.routes;
      if (routes && Array.isArray(routes)) {
        const upsertRisk = db.prepare(`
          INSERT OR REPLACE INTO route_hijack_risks (route_key, risk)
          VALUES (?, MAX(?, COALESCE((SELECT risk FROM route_hijack_risks WHERE route_key = ?), 0)))
        `);
        for (const route of routes) {
          if (route.origin && route.destination && route.hijacking_risk !== undefined) {
            const routeKey = `${route.origin}<>${route.destination}`;
            upsertRisk.run(routeKey, route.hijacking_risk, routeKey);
          }
        }
      }

      // Process history entries
      let newForThisVessel = 0;
      let latestTimestamp = newestEntryTimestamp;

      const insertDeparture = db.prepare(`
        INSERT OR IGNORE INTO departures
        (id, timestamp, autopilot, status, source, vessel_id, vessel_name, origin, destination, route_name, distance, fuel_used, income, wear, duration, cargo, harbor_fee)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const entry of historyData.history) {
        const entryTimestamp = parseGameDate(entry.created_at);

        if (!forceResync && entryTimestamp <= newestEntryTimestamp) continue;

        const id = generateDepartureId(entry.vessel_id, entryTimestamp);
        const result = insertDeparture.run(
          id,
          entryTimestamp,
          'Game Import',
          'SUCCESS',
          'game-api',
          entry.vessel_id,
          historyData.vessel.name,
          entry.route_origin,
          entry.route_destination,
          entry.route_name,
          entry.total_distance,
          entry.fuel_used,
          entry.route_income,
          entry.wear,
          entry.duration,
          JSON.stringify(entry.cargo || {}),
          0
        );

        if (result.changes > 0) {
          newForThisVessel++;
          syncState.newEntriesThisRun++;
          if (entryTimestamp > latestTimestamp) {
            latestTimestamp = entryTimestamp;
          }
        }
      }

      // Update vessel metadata
      if (newForThisVessel > 0) {
        db.prepare('UPDATE vessels SET newest_entry_at = ?, entry_count = entry_count + ? WHERE id = ?')
          .run(latestTimestamp, newForThisVessel, vesselId);
        logger.debug(`[VesselHistoryStore/SQLite] ${vessel.name}: +${newForThisVessel} entries`);
      }

      saveSyncProgress(userId, { status: 'running', lastVesselIndex: i, vesselIds });
      syncState.syncedThisRun++;
      processedInBatch++;

      if (i < vessels.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    const progress = loadSyncProgress(userId);
    if (progress.lastVesselIndex >= vessels.length - 1) {
      saveSyncProgress(userId, { status: 'complete', lastVesselIndex: progress.lastVesselIndex, vesselIds });
      setMetadata(userId, 'vessel_history_last_sync', String(Date.now()));
      logger.info(`[VesselHistoryStore/SQLite] Sync complete: ${syncState.newEntriesThisRun} new entries`);
    }

    const countRow = db.prepare('SELECT COUNT(*) as count FROM departures').get();
    return {
      synced: syncState.syncedThisRun,
      newEntries: syncState.newEntriesThisRun,
      total: countRow.count,
      status: progress.status,
      progress: `${progress.lastVesselIndex + 1}/${vessels.length}`
    };

  } finally {
    syncState.isRunning = false;
    syncState.currentVesselName = null;
  }
}

/**
 * Get all stored departures
 * Joins with trip_data to get contribution if available
 * @param {string} userId - User ID
 * @returns {Promise<Array>} All departures in audit log format
 */
async function getDepartures(userId) {
  const db = getDb(userId);

  // LEFT JOIN with trip_data to get contribution_gained
  // Use time window matching (+/- 5 minutes) to handle timezone/precision differences
  // trip_data.timestamp is TEXT in UTC like "2025-12-11 21:54:03" (from toISOString)
  // departures.timestamp is INTEGER (milliseconds UTC)
  // IMPORTANT: Append '+00:00' to tell SQLite the timestamp is UTC, not local time
  const rows = db.prepare(`
    SELECT d.id, d.timestamp, d.autopilot, d.status, d.source, d.vessel_id, d.vessel_name,
           d.origin, d.destination, d.route_name, d.distance, d.fuel_used, d.income, d.wear,
           d.duration, d.cargo, d.harbor_fee, d.contribution_gained,
           t.contribution_gained as trip_contribution, t.harbor_fee as trip_harbor_fee
    FROM departures d
    LEFT JOIN trip_data t ON d.vessel_id = t.vessel_id
      AND ABS(strftime('%s', t.timestamp || '+00:00') - (d.timestamp / 1000)) <= 300
    ORDER BY d.timestamp ASC
  `).all();

  return rows.map(row => {
    // Use contribution from trip_data if available, otherwise from departures column
    const contribution = row.trip_contribution || row.contribution_gained || 0;
    const harborFee = row.trip_harbor_fee || row.harbor_fee || 0;

    return {
      id: row.id,
      autopilot: row.autopilot,
      status: row.status,
      timestamp: row.timestamp,
      source: row.source,
      details: {
        vesselCount: 1,
        totalRevenue: row.income,
        totalFuelUsed: row.fuel_used,
        totalHarborFees: harborFee,
        contributionGainedTotal: contribution,
        departedVessels: [{
          vesselId: row.vessel_id,
          name: row.vessel_name,
          origin: row.origin,
          destination: row.destination,
          routeName: row.route_name,
          distance: row.distance,
          fuelUsed: row.fuel_used,
          income: row.income,
          wear: row.wear,
          duration: row.duration,
          cargo: row.cargo ? JSON.parse(row.cargo) : {},
          harborFee: harborFee,
          contributionGained: contribution
        }]
      }
    };
  });
}

/**
 * Get departures within a time range
 * Joins with trip_data to get contribution if available
 * @param {string} userId - User ID
 * @param {number} days - Number of days to look back (0 = all)
 * @returns {Promise<Array>} Filtered departures
 */
async function getDeparturesByDays(userId, days) {
  if (days === 0) return getDepartures(userId);

  const db = getDb(userId);
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  // LEFT JOIN with trip_data to get contribution_gained
  // Use time window matching (+/- 5 minutes) to handle timezone/precision differences
  // IMPORTANT: Append '+00:00' to tell SQLite the trip_data.timestamp is UTC
  const rows = db.prepare(`
    SELECT d.id, d.timestamp, d.autopilot, d.status, d.source, d.vessel_id, d.vessel_name,
           d.origin, d.destination, d.route_name, d.distance, d.fuel_used, d.income, d.wear,
           d.duration, d.cargo, d.harbor_fee, d.contribution_gained,
           t.contribution_gained as trip_contribution, t.harbor_fee as trip_harbor_fee
    FROM departures d
    LEFT JOIN trip_data t ON d.vessel_id = t.vessel_id
      AND ABS(strftime('%s', t.timestamp || '+00:00') - (d.timestamp / 1000)) <= 300
    WHERE d.timestamp >= ?
    ORDER BY d.timestamp ASC
  `).all(cutoff);

  return rows.map(row => {
    const contribution = row.trip_contribution || row.contribution_gained || 0;
    const harborFee = row.trip_harbor_fee || row.harbor_fee || 0;

    return {
      id: row.id,
      autopilot: row.autopilot,
      status: row.status,
      timestamp: row.timestamp,
      source: row.source,
      details: {
        vesselCount: 1,
        totalRevenue: row.income,
        totalFuelUsed: row.fuel_used,
        totalHarborFees: harborFee,
        contributionGainedTotal: contribution,
        departedVessels: [{
          vesselId: row.vessel_id,
          name: row.vessel_name,
          origin: row.origin,
          destination: row.destination,
          routeName: row.route_name,
          distance: row.distance,
          fuelUsed: row.fuel_used,
          income: row.income,
          wear: row.wear,
          duration: row.duration,
          cargo: row.cargo ? JSON.parse(row.cargo) : {},
          harborFee: harborFee,
          contributionGained: contribution
        }]
      }
    };
  });
}

/**
 * Get departures before a specific timestamp
 * @param {string} userId - User ID
 * @param {number} beforeTimestamp - Get entries before this timestamp
 * @returns {Promise<Array>} Filtered departures
 */
async function getDeparturesBefore(userId, beforeTimestamp) {
  const departures = await getDepartures(userId);
  return departures.filter(d => d.timestamp < beforeTimestamp);
}

/**
 * Get store metadata
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Store info
 */
async function getStoreInfo(userId) {
  const db = getDb(userId);
  const progress = await getSyncProgress(userId);

  const countRow = db.prepare('SELECT COUNT(*) as count FROM departures').get();
  if (countRow.count === 0) {
    return {
      totalDepartures: 0,
      totalVessels: progress.totalVesselsInStore,
      syncedVessels: progress.syncedVessels,
      oldestDeparture: null,
      newestDeparture: null,
      lastFullSync: progress.lastFullSync,
      dataSpanDays: 0,
      syncStatus: progress.status,
      syncProgress: `${progress.currentVesselIndex}/${progress.totalVessels}`
    };
  }

  const oldest = db.prepare('SELECT MIN(timestamp) as ts FROM departures').get();
  const newest = db.prepare('SELECT MAX(timestamp) as ts FROM departures').get();
  const spanMs = newest.ts - oldest.ts;
  const spanDays = Math.ceil(spanMs / (24 * 60 * 60 * 1000));

  return {
    totalDepartures: countRow.count,
    totalVessels: progress.totalVesselsInStore,
    syncedVessels: progress.syncedVessels,
    oldestDeparture: new Date(oldest.ts).toISOString(),
    newestDeparture: new Date(newest.ts).toISOString(),
    lastFullSync: progress.lastFullSync ? new Date(progress.lastFullSync).toISOString() : null,
    dataSpanDays: spanDays,
    syncStatus: progress.status,
    syncProgress: progress.status === 'running'
      ? `${progress.currentVesselIndex + 1}/${progress.totalVessels} (${progress.currentVesselName})`
      : `${progress.currentVesselIndex}/${progress.totalVessels}`
  };
}

/**
 * Get stored route hijacking risks
 * @param {string} userId - User ID
 * @returns {Promise<Map<string, number>>} Route hijacking risks
 */
async function getRouteHijackingRisks(userId) {
  const db = getDb(userId);
  const rows = db.prepare('SELECT route_key, risk FROM route_hijack_risks').all();

  const riskMap = new Map();
  for (const row of rows) {
    riskMap.set(row.route_key, row.risk);
  }
  return riskMap;
}

/**
 * Clear stored vessel history
 * @param {string} userId - User ID
 */
async function clearStore(userId) {
  const db = getDb(userId);
  db.exec('DELETE FROM departures');
  db.exec('DELETE FROM vessels');
  db.exec('DELETE FROM route_hijack_risks');
  db.exec('DELETE FROM sync_progress');
  logger.info('[VesselHistoryStore/SQLite] Store cleared');
}

/**
 * Start automatic background sync
 * @param {string} userId - User ID to sync for
 */
async function startAutoSync(userId) {
  if (slowSyncInterval) {
    clearInterval(slowSyncInterval);
  }

  const db = getDb(userId);

  // Get current vessels from API
  const vessels = await fetchAllVessels();

  slowSyncVesselList = vessels.map(v => v.id);
  slowSyncVesselIndex = 0;

  if (slowSyncVesselList.length === 0) {
    logger.warn('[VesselHistoryStore/SQLite] No vessels found, skipping auto-sync');
    return;
  }

  const intervalMs = Math.floor((SLOW_SYNC_SPREAD_MINUTES * 60 * 1000) / slowSyncVesselList.length);
  const intervalSec = Math.round(intervalMs / 1000);

  logger.info(`[VesselHistoryStore/SQLite] Starting slow auto-sync: ${slowSyncVesselList.length} vessels, 1 every ${intervalSec}s`);

  // Check if this is first run (no departures yet) - if so, force full resync to get complete history
  const depCount = db.prepare('SELECT COUNT(*) as c FROM departures').get();
  const needsFullHistory = depCount.c === 0;

  // Initial full sync - use forceResync on first run to get COMPLETE vessel history
  if (needsFullHistory) {
    logger.info('[VesselHistoryStore/SQLite] First run detected - fetching COMPLETE vessel history from Game API...');
  } else {
    logger.info('[VesselHistoryStore/SQLite] Running initial sync for new entries...');
  }

  syncVesselHistory(userId, { forceResync: needsFullHistory }).then(result => {
    logger.info(`[VesselHistoryStore/SQLite] Initial sync complete: ${result.newEntries} new departures`);
  }).catch(err => {
    logger.error('[VesselHistoryStore/SQLite] Initial sync failed:', err.message);
  });

  // Set up slow rotation sync
  slowSyncInterval = setInterval(() => {
    syncNextVesselInRotation(userId).catch(err => {
      logger.error('[VesselHistoryStore/SQLite] Slow sync error:', err.message);
    });
  }, intervalMs);
}

/**
 * Sync a single vessel in the slow background rotation
 * @param {string} userId - User ID
 */
async function syncNextVesselInRotation(userId) {
  if (slowSyncVesselList.length === 0 || slowSyncVesselIndex >= slowSyncVesselList.length) {
    const vessels = await fetchAllVessels();
    slowSyncVesselList = vessels.map(v => v.id);
    slowSyncVesselIndex = 0;
    if (slowSyncVesselList.length === 0) return;
  }

  const vesselId = slowSyncVesselList[slowSyncVesselIndex];
  slowSyncVesselIndex++;

  const result = await syncSpecificVessels(userId, [vesselId]);
  if (result.newEntries > 0) {
    logger.info(`[VesselHistoryStore/SQLite] Slow sync: vessel ${vesselId} +${result.newEntries} entries`);
  }
}

/**
 * Sync history for specific vessel IDs
 * @param {string} userId - User ID
 * @param {Array<number>} vesselIds - Array of vessel IDs to sync
 * @returns {Promise<Object>} Sync result
 */
async function syncSpecificVessels(userId, vesselIds) {
  if (!vesselIds || vesselIds.length === 0) {
    return { synced: 0, newEntries: 0 };
  }

  logger.debug(`[VesselHistoryStore] syncSpecificVessels called for ${vesselIds.length} vessels: ${vesselIds.join(', ')}`);

  const db = getDb(userId);
  let newEntriesTotal = 0;

  const insertDeparture = db.prepare(`
    INSERT OR IGNORE INTO departures
    (id, timestamp, autopilot, status, source, vessel_id, vessel_name, origin, destination, route_name, distance, fuel_used, income, wear, duration, cargo, harbor_fee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const vesselId of vesselIds) {
    const historyData = await fetchVesselHistory(vesselId);
    if (!historyData) {
      logger.debug(`[VesselHistoryStore] Vessel ${vesselId}: No history data returned from API`);
      continue;
    }

    logger.debug(`[VesselHistoryStore] Vessel ${vesselId} (${historyData.vessel.name}): API returned ${historyData.history.length} history entries`);

    const newestRow = db.prepare('SELECT MAX(timestamp) as newest FROM departures WHERE vessel_id = ?').get(vesselId);
    const newestEntryTimestamp = newestRow?.newest || 0;

    logger.debug(`[VesselHistoryStore] Vessel ${vesselId}: Newest DB entry timestamp=${newestEntryTimestamp} (${newestEntryTimestamp ? new Date(newestEntryTimestamp).toISOString() : 'none'})`);

    let newForThisVessel = 0;
    let latestTimestamp = newestEntryTimestamp;

    for (const entry of historyData.history) {
      const entryTimestamp = parseGameDate(entry.created_at);
      if (entryTimestamp <= newestEntryTimestamp) {
        continue;
      }

      const id = generateDepartureId(entry.vessel_id, entryTimestamp);
      const result = insertDeparture.run(
        id, entryTimestamp, 'Game Import', 'SUCCESS', 'game-api',
        entry.vessel_id, historyData.vessel.name, entry.route_origin, entry.route_destination,
        entry.route_name, entry.total_distance, entry.fuel_used, entry.route_income,
        entry.wear, entry.duration, JSON.stringify(entry.cargo || {}), 0
      );

      if (result.changes > 0) {
        newForThisVessel++;
        logger.debug(`[VesselHistoryStore] Vessel ${vesselId}: Inserted new entry ${entry.route_origin} -> ${entry.route_destination} at ${entry.created_at}`);
        if (entryTimestamp > latestTimestamp) latestTimestamp = entryTimestamp;
      }
    }

    if (newForThisVessel > 0) {
      db.prepare('UPDATE vessels SET newest_entry_at = ?, entry_count = entry_count + ?, last_synced_at = ? WHERE id = ?')
        .run(latestTimestamp, newForThisVessel, Date.now(), vesselId);
      logger.info(`[VesselHistoryStore] Vessel ${vesselId} (${historyData.vessel.name}): Synced ${newForThisVessel} new entries`);
    } else {
      logger.debug(`[VesselHistoryStore] Vessel ${vesselId}: No new entries (all ${historyData.history.length} entries already in DB or older)`);
    }

    newEntriesTotal += newForThisVessel;
  }

  logger.debug(`[VesselHistoryStore] syncSpecificVessels completed: ${newEntriesTotal} new entries total`);
  return { synced: vesselIds.length, newEntries: newEntriesTotal };
}

/**
 * Stop automatic background sync
 */
function stopAutoSync() {
  if (slowSyncInterval) {
    clearInterval(slowSyncInterval);
    slowSyncInterval = null;
    logger.info('[VesselHistoryStore/SQLite] Stopped auto-sync');
  }
}

/**
 * Get trip history for a specific vessel
 * Returns vessel metadata and departure history in Game API compatible format
 * @param {string} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @returns {Promise<{vessel: Object|null, history: Array}>} Vessel info and trip history
 */
async function getVesselTrips(userId, vesselId) {
  const db = getDb(userId);

  // Get vessel metadata
  const vesselMeta = db.prepare('SELECT * FROM vessels WHERE id = ?').get(vesselId);

  // Get departures for this vessel with contribution from trip_data
  // Use time window matching (+/- 5 minutes) to handle timezone/precision differences
  // IMPORTANT: Append '+00:00' to tell SQLite the trip_data.timestamp is UTC
  const rows = db.prepare(`
    SELECT d.id, d.timestamp, d.vessel_id, d.vessel_name, d.origin, d.destination, d.route_name,
           d.distance, d.fuel_used, d.income, d.wear, d.duration, d.cargo, d.harbor_fee,
           d.contribution_gained,
           t.contribution_gained as trip_contribution, t.harbor_fee as trip_harbor_fee
    FROM departures d
    LEFT JOIN trip_data t ON d.vessel_id = t.vessel_id
      AND ABS(strftime('%s', t.timestamp || '+00:00') - (d.timestamp / 1000)) <= 300
    WHERE d.vessel_id = ?
    ORDER BY d.timestamp DESC
  `).all(vesselId);

  // Transform to Game API format for compatibility
  // IMPORTANT: Do NOT use || 0 for contribution/harborFee - keep null so enrichHistoryWithTripData can fill them from lookup-store
  const history = rows.map(row => {
    const date = new Date(row.timestamp);
    const created_at = date.toISOString().replace('T', ' ').substring(0, 19);
    // Use ?? to prefer trip_data values but allow null to pass through for enrichment
    const contribution = row.trip_contribution ?? row.contribution_gained;
    const harborFee = row.trip_harbor_fee ?? row.harbor_fee;

    return {
      vessel_id: row.vessel_id,
      route_origin: row.origin,
      route_destination: row.destination,
      route_name: row.route_name,
      total_distance: row.distance,
      fuel_used: row.fuel_used,
      route_income: row.income,
      wear: row.wear,
      cargo: row.cargo ? JSON.parse(row.cargo) : {},
      duration: row.duration,
      created_at,
      harbor_fee: harborFee,
      contribution_gained: contribution
    };
  });

  return {
    vessel: vesselMeta ? {
      id: vesselMeta.id,
      name: vesselMeta.name,
      typeName: vesselMeta.type_name,
      lastSyncedAt: vesselMeta.last_synced_at,
      newestEntryAt: vesselMeta.newest_entry_at,
      entryCount: vesselMeta.entry_count
    } : null,
    history
  };
}

/**
 * Migrate tanker cargo (legacy - no-op for SQLite)
 * The SQLite migration handles this automatically during JSON import
 * @returns {Promise<Object>} Migration result
 */
async function migrateTankerCargo() {
  return { migrated: 0, message: 'SQLite stores do not require separate tanker cargo migration' };
}

module.exports = {
  syncVesselHistory,
  syncSpecificVessels,
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
  getVesselTrips,
  migrateTankerCargo,
  // Legacy alias
  syncAllVesselHistory: syncVesselHistory
};
