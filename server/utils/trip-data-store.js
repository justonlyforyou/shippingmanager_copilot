/**
 * @fileoverview Unified Trip Data Storage (SQLite)
 *
 * Stores all additional trip data for vessel history enrichment:
 * - Harbor fees
 * - Contribution gains
 * - Speed, guards, CO2 used
 * - Cargo rates and utilization
 *
 * Uses SQLite for reliable ACID-compliant storage.
 *
 * @module server/utils/trip-data-store
 */

const logger = require('./logger');
const { getDb } = require('../database');

// Fuzzy timestamp matching tolerance (60 seconds)
const TOLERANCE_MS = 60 * 1000;

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
 * @returns {void}
 */
function saveTripData(userId, vesselId, timestamp, tripData) {
  try {
    const db = getDb(userId);

    // Use UPSERT to merge with existing data
    db.prepare(`
      INSERT INTO trip_data (vessel_id, timestamp, harbor_fee, contribution_gained, speed, guards, co2_used, fuel_used, capacity, utilization, dry_rate, ref_rate, fuel_rate, crude_rate, is_drydock_operation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vessel_id, timestamp) DO UPDATE SET
        harbor_fee = COALESCE(excluded.harbor_fee, trip_data.harbor_fee),
        contribution_gained = COALESCE(excluded.contribution_gained, trip_data.contribution_gained),
        speed = COALESCE(excluded.speed, trip_data.speed),
        guards = COALESCE(excluded.guards, trip_data.guards),
        co2_used = COALESCE(excluded.co2_used, trip_data.co2_used),
        fuel_used = COALESCE(excluded.fuel_used, trip_data.fuel_used),
        capacity = COALESCE(excluded.capacity, trip_data.capacity),
        utilization = COALESCE(excluded.utilization, trip_data.utilization),
        dry_rate = COALESCE(excluded.dry_rate, trip_data.dry_rate),
        ref_rate = COALESCE(excluded.ref_rate, trip_data.ref_rate),
        fuel_rate = COALESCE(excluded.fuel_rate, trip_data.fuel_rate),
        crude_rate = COALESCE(excluded.crude_rate, trip_data.crude_rate),
        is_drydock_operation = COALESCE(excluded.is_drydock_operation, trip_data.is_drydock_operation)
    `).run(
      vesselId,
      timestamp,
      tripData.harborFee,
      tripData.contributionGained,
      tripData.speed,
      tripData.guards,
      tripData.co2Used,
      tripData.fuelUsed,
      tripData.capacity,
      tripData.utilization,
      tripData.dryRate,
      tripData.refRate,
      tripData.fuelRate,
      tripData.crudeRate,
      tripData.isDrydockOperation ? 1 : 0
    );

    logger.debug(`[Trip Data Store] Saved data for vessel ${vesselId} at ${timestamp}: fee=$${tripData.harborFee}, contribution=${tripData.contributionGained}, speed=${tripData.speed}kn`);
  } catch (error) {
    logger.error(`[Trip Data Store] Failed to save trip data:`, error.message);
  }
}

/**
 * Gets trip data for a specific trip
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp
 * @returns {Object|null} Trip data or null if not found
 */
function getTripData(userId, vesselId, timestamp) {
  try {
    const db = getDb(userId);
    const row = db.prepare('SELECT * FROM trip_data WHERE vessel_id = ? AND timestamp = ?').get(vesselId, timestamp);

    if (!row) return null;

    return {
      harborFee: row.harbor_fee,
      contributionGained: row.contribution_gained,
      speed: row.speed,
      guards: row.guards,
      co2Used: row.co2_used,
      fuelUsed: row.fuel_used,
      capacity: row.capacity,
      utilization: row.utilization,
      dryRate: row.dry_rate,
      refRate: row.ref_rate,
      fuelRate: row.fuel_rate,
      crudeRate: row.crude_rate,
      isDrydockOperation: row.is_drydock_operation === 1
    };
  } catch (error) {
    logger.error(`[Trip Data Store] Failed to get trip data:`, error.message);
    return null;
  }
}

/**
 * Finds trip data with fuzzy timestamp matching
 * @param {Object} db - SQLite database instance
 * @param {number} vesselId - Vessel ID to match
 * @param {number} entryTimestamp - Timestamp in milliseconds
 * @returns {Object|null} Matching trip data or null
 */
function findTripDataFuzzy(db, vesselId, entryTimestamp) {
  try {
    // Get all trips for this vessel
    const rows = db.prepare('SELECT * FROM trip_data WHERE vessel_id = ?').all(vesselId);

    for (const row of rows) {
      // IMPORTANT: Append 'Z' to tell JavaScript the timestamp is UTC (from toISOString)
      // Without 'Z', new Date() interprets as local time which causes timezone offset
      const dataTimestamp = new Date(row.timestamp + 'Z').getTime();
      const diff = Math.abs(entryTimestamp - dataTimestamp);

      if (diff <= TOLERANCE_MS) {
        return {
          harborFee: row.harbor_fee,
          contributionGained: row.contribution_gained,
          speed: row.speed,
          guards: row.guards,
          co2Used: row.co2_used,
          fuelUsed: row.fuel_used,
          capacity: row.capacity,
          utilization: row.utilization,
          dryRate: row.dry_rate,
          refRate: row.ref_rate,
          fuelRate: row.fuel_rate,
          crudeRate: row.crude_rate,
          isDrydockOperation: row.is_drydock_operation === 1
        };
      }
    }
    return null;
  } catch (error) {
    logger.debug(`[Trip Data Store] Fuzzy search error: ${error.message}`);
    return null;
  }
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
  const db = getDb(userId);

  // Load lookup-store (POD4) as fallback for older trips
  let lookupEntries = [];
  try {
    const { lookupStore } = require('../database/store-adapter');
    lookupEntries = await lookupStore.getEntries(userId);
  } catch (error) {
    logger.debug('[Trip Data Store] Could not load lookup-store for fallback:', error.message);
  }

  return historyEntries.map(entry => {
    // Try exact match first from trip_data table
    let tripData = getTripData(userId, entry.vessel_id, entry.created_at);

    // If no exact match, try fuzzy matching
    if (!tripData) {
      const entryTimestamp = new Date(entry.created_at).getTime();
      tripData = findTripDataFuzzy(db, entry.vessel_id, entryTimestamp);
    }

    // Return entry with trip data merged from trip_data table
    // API provides: fuel_used (kg), route_income, cargo, distance, duration, wear
    // Our store provides: harbor_fee, contribution, speed, guards, co2_used, rates, utilization
    // Use ?? to preserve existing entry values if tripData field is null/undefined
    if (tripData) {
      return {
        ...entry,
        // fuel_used comes from API (in kg) - never overwrite it
        harbor_fee: tripData.harborFee ?? entry.harbor_fee,
        contribution_gained: tripData.contributionGained ?? entry.contribution_gained,
        speed: tripData.speed ?? entry.speed,
        guards: tripData.guards ?? entry.guards,
        co2_used: tripData.co2Used ?? entry.co2_used,
        capacity: tripData.capacity ?? entry.capacity,
        utilization: tripData.utilization ?? entry.utilization,
        dry_rate: tripData.dryRate ?? entry.dry_rate,
        ref_rate: tripData.refRate ?? entry.ref_rate,
        fuel_rate: tripData.fuelRate ?? entry.fuel_rate,
        crude_rate: tripData.crudeRate ?? entry.crude_rate,
        is_drydock_operation: tripData.isDrydockOperation ?? entry.is_drydock_operation
      };
    }

    // Fallback: Try lookup-store (POD4) for historical data
    const entryTimestamp = new Date(entry.created_at).getTime();
    const lookupData = findLookupDataFuzzy(lookupEntries, entry.vessel_id, entryTimestamp);

    if (lookupData) {
      return {
        ...entry,
        // pod2_vessel has: harborFee (negative), contributionGained, speed, guards, co2Used, etc.
        // Use ?? to preserve existing entry values if lookupData field is null/undefined
        harbor_fee: lookupData.harborFee ? Math.abs(lookupData.harborFee) : entry.harbor_fee,
        contribution_gained: lookupData.contributionGained ?? entry.contribution_gained,
        speed: lookupData.speed ?? entry.speed,
        guards: lookupData.guards ?? entry.guards,
        co2_used: lookupData.co2Used ?? entry.co2_used,
        capacity: lookupData.capacity ?? entry.capacity,
        utilization: lookupData.utilization ?? entry.utilization,
        dry_rate: lookupData.dryRate ?? entry.dry_rate,
        ref_rate: lookupData.refRate ?? entry.ref_rate,
        fuel_rate: lookupData.fuelRate ?? entry.fuel_rate,
        crude_rate: lookupData.crudeRate ?? entry.crude_rate,
        is_drydock_operation: lookupData.isDrydockOperation ?? entry.is_drydock_operation
      };
    }

    // No match found in either store - preserve existing values from entry (e.g., from getVesselTrips JOIN)
    // Only set to null if entry doesn't have a value
    return {
      ...entry,
      // fuel_used comes from API (in kg) - already in entry, don't touch it
      harbor_fee: entry.harbor_fee ?? null,
      contribution_gained: entry.contribution_gained ?? null,
      speed: entry.speed ?? null,
      guards: entry.guards ?? null,
      co2_used: entry.co2_used ?? null,
      capacity: entry.capacity ?? null,
      utilization: entry.utilization ?? null,
      dry_rate: entry.dry_rate ?? null,
      ref_rate: entry.ref_rate ?? null,
      fuel_rate: entry.fuel_rate ?? null,
      crude_rate: entry.crude_rate ?? null,
      is_drydock_operation: entry.is_drydock_operation ?? null
    };
  });
}

/**
 * Saves harbor fee only (compatibility wrapper)
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp
 * @param {number} harborFee - Harbor fee amount
 * @returns {void}
 */
function saveHarborFee(userId, vesselId, timestamp, harborFee) {
  saveTripData(userId, vesselId, timestamp, { harborFee });
}

/**
 * Migration is handled by database/migration.js - these are kept for compatibility
 * @returns {Promise<boolean>} Always returns false (migration handled elsewhere)
 */
async function migrateFromOldStores() {
  // Migration is now handled by database/migration.js
  return false;
}

async function isMigrationCompleted() {
  // Migration is now handled by database/migration.js
  return true;
}

async function markMigrationCompleted() {
  // Migration is now handled by database/migration.js
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
