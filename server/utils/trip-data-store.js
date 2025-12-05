/**
 * @fileoverview Unified Trip Data Storage
 *
 * Stores all additional trip data for vessel history enrichment:
 * - Harbor fees
 * - Contribution gains
 * - Speed, guards, CO2 used
 * - Cargo rates and utilization
 *
 * Consolidates harbor-fee-store, contribution-store, and departure-data-store
 * into a single unified store.
 *
 * @module server/utils/trip-data-store
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { getAppBaseDir } = require('../config');

// Use AppData when packaged as exe
const isPkg = !!process.pkg;
const TRIP_DATA_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'trip-data')
  : path.join(__dirname, '../../userdata/trip-data');

// Fuzzy timestamp matching tolerance (60 seconds)
const TOLERANCE_MS = 60 * 1000;

/**
 * Ensures trip data directory exists
 */
async function ensureDirectory() {
  try {
    await fs.mkdir(TRIP_DATA_DIR, { recursive: true });
  } catch (error) {
    logger.error('[Trip Data Store] Failed to create directory:', error.message);
  }
}

/**
 * Gets file path for user's trip data
 * @param {number} userId - User ID
 * @returns {string} File path
 */
function getFilePath(userId) {
  return path.join(TRIP_DATA_DIR, `trip-data-${userId}.json`);
}

/**
 * Loads trip data from disk
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Trip data map { "vesselId_timestamp": { ...tripData } }
 */
async function loadTripData(userId) {
  try {
    const filePath = getFilePath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {}; // File doesn't exist yet
    }
    logger.error(`[Trip Data Store] Failed to load data for user ${userId}:`, error.message);
    return {};
  }
}

/**
 * Saves trip data to disk
 * @param {number} userId - User ID
 * @param {Object} data - Full trip data map
 */
async function saveTripDataToDisk(userId, data) {
  try {
    const filePath = getFilePath(userId);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logger.error(`[Trip Data Store] Failed to save data:`, error.message);
  }
}

/**
 * Saves all trip data for a vessel departure
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp (from created_at or current time)
 * @param {Object} tripData - All trip data
 * @param {number} [tripData.harborFee] - Harbor fee amount
 * @param {number} [tripData.contributionGained] - Contribution points gained
 * @param {number} [tripData.speed] - Vessel speed in knots
 * @param {number} [tripData.guards] - Number of guards (0 or 10)
 * @param {number} [tripData.co2Used] - CO2 used in tons
 * @param {number} [tripData.fuelUsed] - Fuel used in tons
 * @param {number} [tripData.capacity] - Total vessel capacity (TEU or bbl)
 * @param {number} [tripData.utilization] - Cargo utilization (0-1)
 * @param {number} [tripData.dryRate] - Price per TEU for dry containers
 * @param {number} [tripData.refRate] - Price per TEU for refrigerated containers
 * @param {number} [tripData.fuelRate] - Price per bbl for fuel cargo
 * @param {number} [tripData.crudeRate] - Price per bbl for crude oil
 * @param {boolean} [tripData.isDrydockOperation] - Whether this was a drydock operation (no income)
 * @returns {Promise<void>}
 */
async function saveTripData(userId, vesselId, timestamp, tripData) {
  try {
    await ensureDirectory();

    const allData = await loadTripData(userId);
    const key = `${vesselId}_${timestamp}`;

    // Merge with existing data (in case of partial updates)
    allData[key] = {
      ...(allData[key] || {}),
      ...tripData
    };

    await saveTripDataToDisk(userId, allData);

    logger.debug(`[Trip Data Store] Saved data for ${key}: fee=$${tripData.harborFee || 0}, contribution=${tripData.contributionGained || 0}, speed=${tripData.speed || 0}kn`);
  } catch (error) {
    logger.error(`[Trip Data Store] Failed to save trip data:`, error.message);
  }
}

/**
 * Gets trip data for a specific trip
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp
 * @returns {Promise<Object|null>} Trip data or null if not found
 */
async function getTripData(userId, vesselId, timestamp) {
  const allData = await loadTripData(userId);
  const key = `${vesselId}_${timestamp}`;
  return allData[key] || null;
}

/**
 * Finds trip data with fuzzy timestamp matching
 * @param {Object} allData - All trip data
 * @param {number} vesselId - Vessel ID to match
 * @param {number} entryTimestamp - Timestamp in milliseconds
 * @returns {Object|null} Matching trip data or null
 */
function findTripDataFuzzy(allData, vesselId, entryTimestamp) {
  for (const [key, data] of Object.entries(allData)) {
    const [storedVesselId, timestamp] = key.split('_');

    // Check if vessel ID matches
    if (parseInt(storedVesselId) !== vesselId) continue;

    // Check if timestamp is within tolerance
    const dataTimestamp = new Date(timestamp).getTime();
    const diff = Math.abs(entryTimestamp - dataTimestamp);

    if (diff <= TOLERANCE_MS) {
      return data;
    }
  }
  return null;
}

/**
 * Find matching lookup entry from POD4 by vessel ID and timestamp
 * @param {Array} lookupEntries - All lookup entries
 * @param {number} vesselId - Vessel ID to match
 * @param {number} entryTimestamp - Timestamp in milliseconds
 * @returns {Object|null} pod2_vessel data or null
 */
function findLookupDataFuzzy(lookupEntries, vesselId, entryTimestamp) {
  // 10 minute tolerance for lookup matching (same as lookup-store uses)
  const LOOKUP_TOLERANCE_MS = 10 * 60 * 1000;

  for (const entry of lookupEntries) {
    // Only check departure entries with pod2_vessel data
    if (entry.context !== 'vessels_departed') continue;
    if (!entry.pod2_vessel) continue;
    if (entry.pod2_vessel.vesselId !== vesselId) continue;

    // Check if timestamp is within tolerance
    const diff = Math.abs(entryTimestamp - entry.timestamp);
    if (diff <= LOOKUP_TOLERANCE_MS) {
      return entry.pod2_vessel;
    }
  }
  return null;
}

/**
 * Enriches vessel history entries with all stored trip data
 *
 * Uses fuzzy timestamp matching (up to 60 seconds tolerance) because
 * timestamps can differ between our store and the game API.
 *
 * Falls back to lookup-store (POD4) for historical data when trip-data-store
 * doesn't have the entry (e.g., older trips before tracking was implemented).
 *
 * @param {number} userId - User ID
 * @param {Array<Object>} historyEntries - Vessel history entries from game API
 * @returns {Promise<Array<Object>>} History entries with all trip data added
 */
async function enrichHistoryWithTripData(userId, historyEntries) {
  const allData = await loadTripData(userId);

  // Load lookup-store (POD4) as fallback for older trips
  let lookupEntries = [];
  try {
    const lookupStore = require('../analytics/lookup-store');
    lookupEntries = await lookupStore.getEntries(userId);
  } catch (error) {
    logger.debug('[Trip Data Store] Could not load lookup-store for fallback:', error.message);
  }

  return historyEntries.map(entry => {
    // Try exact match first from trip-data-store
    const exactKey = `${entry.vessel_id}_${entry.created_at}`;
    let tripData = allData[exactKey];

    // If no exact match, try fuzzy matching in trip-data-store
    if (!tripData) {
      const entryTimestamp = new Date(entry.created_at).getTime();
      tripData = findTripDataFuzzy(allData, entry.vessel_id, entryTimestamp);
    }

    // Return entry with trip data merged from trip-data-store
    // API provides: fuel_used (kg), route_income, cargo, distance, duration, wear
    // Our store provides: harbor_fee, contribution, speed, guards, co2_used, rates, utilization
    if (tripData) {
      return {
        ...entry,
        // fuel_used comes from API (in kg) - never overwrite it
        harbor_fee: tripData.harborFee ?? entry.harbor_fee,
        contribution_gained: tripData.contributionGained,
        speed: tripData.speed,
        guards: tripData.guards,
        co2_used: tripData.co2Used,
        capacity: tripData.capacity,
        utilization: tripData.utilization,
        dry_rate: tripData.dryRate,
        ref_rate: tripData.refRate,
        fuel_rate: tripData.fuelRate,
        crude_rate: tripData.crudeRate,
        is_drydock_operation: tripData.isDrydockOperation
      };
    }

    // Fallback: Try lookup-store (POD4) for historical data
    const entryTimestamp = new Date(entry.created_at).getTime();
    const lookupData = findLookupDataFuzzy(lookupEntries, entry.vessel_id, entryTimestamp);

    if (lookupData) {
      return {
        ...entry,
        // pod2_vessel has: harborFee (negative), contributionGained, speed, guards, co2Used, etc.
        harbor_fee: lookupData.harborFee ? Math.abs(lookupData.harborFee) : null,
        contribution_gained: lookupData.contributionGained,
        speed: lookupData.speed,
        guards: lookupData.guards,
        co2_used: lookupData.co2Used,
        capacity: lookupData.capacity,
        utilization: lookupData.utilization,
        dry_rate: lookupData.dryRate,
        ref_rate: lookupData.refRate,
        fuel_rate: lookupData.fuelRate,
        crude_rate: lookupData.crudeRate,
        is_drydock_operation: lookupData.isDrydockOperation
      };
    }

    // No match found in either store - keep API values, only add nulls for fields API doesn't provide
    return {
      ...entry,
      // fuel_used comes from API (in kg) - already in entry, don't touch it
      harbor_fee: entry.harbor_fee ?? null,
      contribution_gained: null,
      speed: null,
      guards: null,
      co2_used: null,
      capacity: null,
      utilization: null,
      dry_rate: null,
      ref_rate: null,
      fuel_rate: null,
      crude_rate: null,
      is_drydock_operation: null
    };
  });
}

/**
 * Migrates data from old separate stores to unified store
 * @param {number} userId - User ID
 * @returns {Promise<boolean>} True if migration was performed
 */
async function migrateFromOldStores(userId) {
  await ensureDirectory();

  const unifiedData = await loadTripData(userId);
  let migrated = false;

  // Migration paths for old stores
  const oldStores = [
    {
      dir: isPkg
        ? path.join(getAppBaseDir(), 'userdata', 'harbor-fees')
        : path.join(__dirname, '../../userdata/harbor-fees'),
      file: `harbor-fees-${userId}.json`,
      field: 'harborFee'
    },
    {
      dir: isPkg
        ? path.join(getAppBaseDir(), 'userdata', 'contributions')
        : path.join(__dirname, '../../userdata/contributions'),
      file: `contributions-${userId}.json`,
      field: 'contributionGained'
    },
    {
      dir: isPkg
        ? path.join(getAppBaseDir(), 'userdata', 'departure-data')
        : path.join(__dirname, '../../userdata/departure-data'),
      file: `departure-data-${userId}.json`,
      isObject: true // This store has object values, not single values
    }
  ];

  for (const store of oldStores) {
    try {
      const oldFilePath = path.join(store.dir, store.file);
      const oldData = JSON.parse(await fs.readFile(oldFilePath, 'utf8'));

      for (const [key, value] of Object.entries(oldData)) {
        if (!unifiedData[key]) {
          unifiedData[key] = {};
        }

        if (store.isObject) {
          // departure-data-store has object values
          unifiedData[key] = { ...unifiedData[key], ...value };
        } else {
          // harbor-fee and contribution stores have single values
          unifiedData[key][store.field] = value;
        }
      }

      migrated = true;
      logger.info(`[Trip Data Store] Migrated data from ${store.file}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`[Trip Data Store] Could not migrate ${store.file}: ${error.message}`);
      }
    }
  }

  if (migrated) {
    await saveTripDataToDisk(userId, unifiedData);
    logger.info(`[Trip Data Store] Migration complete for user ${userId}`);
  }

  return migrated;
}

// Migration marker file path
const MIGRATION_MARKER_FILE = path.join(TRIP_DATA_DIR, '.migration-completed');

/**
 * Checks if migration has already been completed
 * @returns {Promise<boolean>} True if migration was already done
 */
async function isMigrationCompleted() {
  try {
    await fs.access(MIGRATION_MARKER_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks migration as completed
 * @returns {Promise<void>}
 */
async function markMigrationCompleted() {
  try {
    await ensureDirectory();
    await fs.writeFile(MIGRATION_MARKER_FILE, new Date().toISOString(), 'utf8');
    logger.info('[Trip Data Store] Migration marked as completed');
  } catch (error) {
    logger.error('[Trip Data Store] Failed to mark migration as completed:', error.message);
  }
}

/**
 * Saves harbor fee only (compatibility wrapper for migrate-harbor-fees.js)
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp
 * @param {number} harborFee - Harbor fee amount
 * @returns {Promise<void>}
 */
async function saveHarborFee(userId, vesselId, timestamp, harborFee) {
  await saveTripData(userId, vesselId, timestamp, { harborFee });
}

module.exports = {
  saveTripData,
  getTripData,
  enrichHistoryWithTripData,
  migrateFromOldStores,
  // Compatibility exports for migration
  isMigrationCompleted,
  markMigrationCompleted,
  saveHarborFee
};
