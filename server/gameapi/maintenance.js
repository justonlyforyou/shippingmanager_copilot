/**
 * @fileoverview Vessel Maintenance API Client Module
 *
 * This module handles all maintenance-related API calls including:
 * - Getting maintenance cost calculations
 * - Performing bulk vessel repairs
 * - Counting vessels needing repair
 *
 * API Quirks:
 * - vessel_ids must be sent as JSON string, not array
 * - getMaintenanceCost doesn't return total_cost (must calculate)
 * - bulkRepairVessels does return total_cost field
 *
 * @requires ../utils/api - API helper functions
 * @requires ../utils/logger - Logging utility
 * @module server/gameapi/maintenance
 */

const { apiCall } = require('../utils/api');
const logger = require('../utils/logger');
const cache = require('../cache');

/**
 * Gets maintenance cost for specified vessels.
 * Used by auto-repair feature to calculate costs before repair.
 *
 * API Quirks:
 * - vessel_ids must be sent as JSON string: "[123,456]"
 * - API doesn't return total_cost field (must calculate from vessels array)
 *
 * @param {Array<number>} vesselIds - Array of vessel IDs to check
 * @returns {Promise<Object>} Object with totalCost and vessels array
 */
async function getMaintenanceCost(vesselIds) {
  logger.debug(`[GameAPI] Requesting maintenance cost for vessel IDs: [${vesselIds.join(', ')}]`);

  // Frontend sends: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
  // Which results in: { vessel_ids: "[17696320,17696321]" }
  // So we need to send the array as a JSON string
  const vesselIdsString = JSON.stringify(vesselIds);
  logger.debug(`[GameAPI] Sending vessel_ids as JSON string: ${vesselIdsString}`);

  try {
    const data = await apiCall('/maintenance/get', 'POST', { vessel_ids: vesselIdsString });

    if (data.error) {
      logger.error(`[GameAPI] API Error: ${data.error}`);
      return { totalCost: 0, vessels: [] };
    }

    const vessels = data.data?.vessels;

    // Calculate total cost from individual vessel maintenance_data (API doesn't provide total_cost)
    let totalCost = 0;
    vessels.forEach(vessel => {
      const wearMaintenance = vessel.maintenance_data?.find(m => m.type === 'wear');
      if (wearMaintenance) {
        totalCost += wearMaintenance.price;
      }
    });

    logger.debug(`[GameAPI] Calculated total maintenance cost: $${totalCost} for ${vesselIds.length} vessels`);
    return {
      totalCost: totalCost,
      vessels: vessels
    };
  } catch (error) {
    logger.error(`[GameAPI] getMaintenanceCost failed:`, error.message);
    throw error;
  }
}

/**
 * Performs bulk wear maintenance on multiple vessels.
 * Used by auto-repair feature to repair all vessels at once.
 *
 * API Quirks:
 * - Same JSON string requirement as getMaintenanceCost (see above)
 * - Must send: vessel_ids: JSON.stringify([123,456,789])
 * - API DOES return total_cost field (unlike getMaintenanceCost)
 * - Repairs execute instantly (no animation/delay in game)
 * - All repairs succeed or all fail (atomic operation)
 *
 * @async
 * @param {Array<number>} vesselIds - Array of vessel IDs to repair
 * @returns {Promise<Object>} {success, count, totalCost} - Repair result
 * @throws {Error} If API call fails
 */
async function bulkRepairVessels(vesselIds) {
  logger.debug(`[GameAPI] Executing bulk repair for vessel IDs: [${vesselIds.join(', ')}]`);

  // Frontend sends vessel_ids as JSON string: "[17696320,17696321]"
  const vesselIdsString = JSON.stringify(vesselIds);
  logger.debug(`[GameAPI] Sending vessel_ids as JSON string: ${vesselIdsString}`);

  const data = await apiCall('/maintenance/do-wear-maintenance-bulk', 'POST', {
    vessel_ids: vesselIdsString
  });

  if (data.error) {
    logger.error(`[GameAPI] Bulk repair API Error: ${data.error}`);
    return { success: false, count: 0, totalCost: 0 };
  }

  const totalCost = data.data?.total_cost || 0;
  logger.debug(`[GameAPI] Repaired ${vesselIds.length} vessels - API returned cost: $${totalCost}`);

  return {
    success: true,
    count: vesselIds.length,
    totalCost: totalCost
  };
}

/**
 * Fetches count of vessels needing repair.
 * Uses global cache (10s TTL) to reduce duplicate API calls.
 * Used by scheduler to update repair badge.
 *
 * @returns {Promise<number>} Count of vessels with wear > 0
 */
async function fetchRepairCount() {
  // Use cache to avoid duplicate /game/index calls
  let data = cache.getGameIndexCache();
  if (!data) {
    data = await apiCall('/game/index', 'POST', {});
    cache.setGameIndexCache(data);
  }
  const vessels = data.data.user_vessels;
  return vessels.filter(v => v.wear > 0).length;
}

module.exports = {
  getMaintenanceCost,
  bulkRepairVessels,
  fetchRepairCount
};