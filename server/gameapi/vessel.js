/**
 * @fileoverview Vessel API Client Module
 *
 * This module handles all vessel-related API calls including:
 * - Fetching vessel data
 * - Departing vessels on routes
 * - Getting vessel history
 * - Harbor fee bug detection and logging
 *
 * @requires ../utils/api - API helper functions
 * @requires ../utils/logger - Logging utility
 * @requires path - Path utilities
 * @requires fs - File system operations
 * @module server/gameapi/vessel
 */

const { apiCall } = require('../utils/api');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');

// Helper function to get app data directory
function getAppDataDir() {
  const os = require('os');
  switch (process.platform) {
    case 'win32':
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    default:
      return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}


/**
 * Fetches all user vessels from game index.
 * Returns complete vessel list with status, cargo, and route info.
 *
 * @returns {Promise<Array>} Array of vessel objects
 */
async function fetchVessels() {
  const data = await apiCall('/game/index', 'POST', {});
  return data.data.user_vessels;
}

/**
 * Departs a single vessel on its assigned route.
 * Used by intelligent auto-depart feature.
 *
 * CRITICAL API BEHAVIORS:
 * - Vessel must have assigned route (route_id) and valid price-per-TEU (> 0)
 * - API returns depart_income as NET income (after harbor fees already deducted)
 * - Harbor fee calculation bug exists at some ports (fee > income, resulting in negative profit)
 * - API error "Vessel not found or status invalid" = vessel already departed (race condition)
 *
 * Error Handling Strategy:
 * - Always pass through ACTUAL error message from API (don't mask it)
 * - "Vessel not found" is OK during auto-depart (vessel departed between checks)
 * - Negative netIncome triggers debug logging + saves raw API response to file
 *
 * Parameters:
 * - speed: Vessel's cruising speed in knots (from vessel specs)
 * - guards: 0 or 10 (game mechanic for piracy protection)
 * - history: Always 0 (don't add to history - undocumented API parameter)
 *
 * @async
 * @param {number} vesselId - User vessel ID
 * @param {number} speed - Travel speed in knots
 * @param {number} [guards=0] - Number of guards (0 or 10)
 * @returns {Promise<Object>} Departure result: {success, vesselId, income, netIncome, fuelUsed, ...}
 * @throws {Error} Only on network/critical failures (not on game logic errors)
 */
async function departVessel(vesselId, speed, guards = 0) {
  const data = await apiCall('/route/depart', 'POST', {
    user_vessel_id: vesselId,
    speed: speed,
    guards: guards,
    history: 0
  });

  // Check if API returned an error
  if (!data.data || !data.data.depart_info) {
    // IMPORTANT: Always pass through the ACTUAL error message from the API
    const actualError = data.error || 'Unknown error';

    logger.debug(`[GameAPI] Depart failed for vessel ${vesselId} - Error: "${actualError}"`);

    // Special case: Vessel already departed (race condition)
    if (actualError === 'Vessel not found or status invalid') {
      logger.debug(`[GameAPI] Vessel ${vesselId} was already departed (race condition - ignoring)`);
    }

    return {
      success: false,
      vesselId: vesselId,
      error: actualError,
      errorMessage: actualError,  // Pass through the ACTUAL error
      apiResponse: data
    };
  }

  const departInfo = data.data.depart_info;
  const vesselData = data.data.user_vessels?.[0];

  // depart_income is already NET income (after harbor fees)
  // Do NOT subtract harbor_fee again - that would be double-deduction
  const income = departInfo.depart_income;

  // Track high harbor fee issues (for profitability warnings)
  const profitCheck = departInfo.depart_income - departInfo.harbor_fee;
  if (profitCheck < 0) {
    const destination = vesselData?.route_destination || 'UNKNOWN';
    logger.warn(`[gameapi.departVessel] High harbor fee detected - Vessel: ${vesselData?.name} (${vesselId}), Destination: ${destination}, Income: $${departInfo.depart_income}, Fee: $${departInfo.harbor_fee}, Profit: $${profitCheck}`);
  }

  // Calculate actual cargo loaded from depart_info
  const teuDry = departInfo.teu_dry || 0;
  const teuRefer = departInfo.teu_refrigerated || 0;
  const fuelCargo = departInfo.fuel || 0;
  const crudeCargo = departInfo.crude_oil || 0;

  // Total cargo depends on vessel type
  const totalCargo = teuDry + teuRefer + fuelCargo + crudeCargo;

  // LOG DEPART_INFO FOR EVERY VESSEL
  logger.debug(`[Depart API Response] Vessel: ${vesselData?.name} (ID: ${vesselId})`);
  logger.debug(`[Depart API Response] depart_info: ${JSON.stringify(departInfo, null, 2)}`);

  return {
    success: true,
    vesselId: vesselId,
    vesselName: vesselData?.name,
    destination: vesselData?.route_destination,
    income: income,
    harborFee: departInfo.harbor_fee,
    netIncome: income, // depart_income is already NET (after fees)
    fuelUsed: departInfo.fuel_usage / 1000, // kg to tons
    co2Used: departInfo.co2_emission / 1000, // kg to tons,
    speed: speed,
    guards: guards,
    // Actual cargo loaded (from API response)
    cargoLoaded: totalCargo,
    teuDry: teuDry,
    teuRefrigerated: teuRefer,
    fuelCargo: fuelCargo,
    crudeCargo: crudeCargo
  };
}

/**
 * Fetches trip history for a specific vessel.
 *
 * @param {number} vesselId - Vessel ID to get history for
 * @returns {Promise<Object>} Response with history array
 */
async function getVesselHistory(vesselId) {
  return await apiCall('/vessel/get-vessel-history', 'POST', {
    vessel_id: vesselId
  });
}

/**
 * Fetches all user vessels with complete data.
 *
 * @returns {Promise<Object>} Response with vessels array
 */
async function getAllUserVessels() {
  return await apiCall('/vessel/get-all-user-vessels', 'POST', {});
}

module.exports = {
  fetchVessels,
  departVessel,
  getVesselHistory,
  getAllUserVessels
};