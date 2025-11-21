/**
 * @fileoverview Fuel Calculator Utility - Calculates vessel fuel consumption
 *
 * Provides centralized fuel consumption calculations based on actual vessel data.
 * - Shop vessels: Uses vessel.type as key (e.g., "compressed/container/220-TEU.jpg")
 * - Custom vessels: Uses "{userId}_{vesselId}" as key (matches appearance file naming)
 *
 * @module server/utils/fuel-calculator
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/**
 * Shop vessel fuel consumption data (keyed by image type)
 * @type {Object|null}
 */
let SHOP_FUEL_DATA = null;

/**
 * Custom vessel fuel consumption data (keyed by "{userId}_{vesselId}")
 * @type {Object|null}
 */
let CUSTOM_FUEL_DATA = null;

/**
 * Load shop vessel fuel consumption data
 */
function loadShopFuelData() {
  if (SHOP_FUEL_DATA) return SHOP_FUEL_DATA;

  try {
    const fuelDataPath = path.join(__dirname, '../../sysdata/vessels/shop_vessels_fuel_consumption.json');
    SHOP_FUEL_DATA = JSON.parse(fs.readFileSync(fuelDataPath, 'utf8'));
    logger.info(`[Fuel Calculator] Loaded shop fuel data for ${SHOP_FUEL_DATA.metadata.total_models} vessel models`);
    return SHOP_FUEL_DATA;
  } catch (error) {
    logger.error(`[Fuel Calculator] Failed to load shop fuel data: ${error.message}`);
    return null;
  }
}

/**
 * Load custom vessel fuel consumption data
 */
function loadCustomFuelData() {
  if (CUSTOM_FUEL_DATA) return CUSTOM_FUEL_DATA;

  try {
    const fuelDataPath = path.join(__dirname, '../../userdata/vessel-appearances/custom_vessels_fuel_consumption.json');
    CUSTOM_FUEL_DATA = JSON.parse(fs.readFileSync(fuelDataPath, 'utf8'));
    logger.info(`[Fuel Calculator] Loaded custom fuel data for ${Object.keys(CUSTOM_FUEL_DATA.vessels || {}).length} custom vessels`);
    return CUSTOM_FUEL_DATA;
  } catch (error) {
    logger.error(`[Fuel Calculator] Failed to load custom fuel data: ${error.message}`);
    return null;
  }
}

/**
 * Reload custom fuel data (call after build/sell to refresh cache)
 */
function reloadCustomFuelData() {
  CUSTOM_FUEL_DATA = null;
  return loadCustomFuelData();
}

/**
 * Get fuel consumption data for a vessel
 *
 * @param {Object} vessel - Vessel object with type and id
 * @param {number} [userId] - User ID (required for custom vessels)
 * @returns {Object|null} Object with { kg_per_nm, speed_kn, capacity_type } or null if not found
 */
function getVesselFuelData(vessel, userId) {
  if (!vessel) return null;

  // Check if custom vessel (type starts with "custom/" or is null/undefined)
  if (!vessel.type || vessel.type.startsWith('custom')) {
    const customData = loadCustomFuelData();
    if (customData && customData.vessels && vessel.id && userId) {
      const key = `${userId}_${vessel.id}`;
      const vesselData = customData.vessels[key];
      if (vesselData) {
        return {
          kg_per_nm: vesselData.kg_per_nm,
          speed_kn: vesselData.speed_kn,
          capacity_type: vesselData.capacity_type
        };
      }
    }
    return null;
  }

  // Shop vessel - lookup by type
  const shopData = loadShopFuelData();
  if (!shopData || !shopData.by_type) {
    return null;
  }

  const vesselData = shopData.by_type[vessel.type];
  if (!vesselData) {
    logger.debug(`[Fuel Calculator] No shop fuel data for type: ${vessel.type}`);
    return null;
  }

  return {
    kg_per_nm: vesselData.kg_per_nm,
    speed_kn: vesselData.speed_kn,
    capacity_type: vesselData.capacity_type
  };
}

/**
 * Calculate fuel consumption for a vessel at a specific speed
 *
 * @param {Object} vessel - Vessel object with type and id
 * @param {number} distance - Route distance in nautical miles
 * @param {number} actualSpeed - Actual speed in knots
 * @param {number} [userId] - User ID (required for custom vessels)
 * @returns {number|null} Required fuel in tons, or null if data not available
 */
function calculateFuelConsumption(vessel, distance, actualSpeed, userId) {
  const fuelData = getVesselFuelData(vessel, userId);
  if (!fuelData) {
    return null;
  }

  const { kg_per_nm: kgPerNmRef, speed_kn: refSpeed } = fuelData;

  // Calculate fuel consumption:
  // fuel_kg = distance * (actual_speed / ref_speed) * kg_per_nm_ref
  const fuelKg = distance * (actualSpeed / refSpeed) * kgPerNmRef;
  const fuelTons = fuelKg / 1000;

  return fuelTons;
}

/**
 * Get formatted fuel consumption display string for UI
 *
 * @param {Object} vessel - Vessel object with type and id
 * @param {number} [userId] - User ID (required for custom vessels)
 * @returns {string|null} Formatted string like "77 kg/nm @ 17kn" or null if not available
 */
function getFuelConsumptionDisplay(vessel, userId) {
  const fuelData = getVesselFuelData(vessel, userId);
  if (!fuelData) {
    return null;
  }

  const { kg_per_nm, speed_kn } = fuelData;
  return `${kg_per_nm} kg/nm @ ${speed_kn}kn`;
}

/**
 * Add custom vessel to fuel data (called after vessel build)
 *
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {number} speed - Reference speed in knots
 * @param {number} fuelConsumption - Fuel consumption in kg/nm
 * @param {string} capacityType - 'container' or 'tanker'
 */
function addCustomVesselFuelData(userId, vesselId, speed, fuelConsumption, capacityType) {
  try {
    const fuelDataPath = path.join(__dirname, '../../userdata/vessel-appearances/custom_vessels_fuel_consumption.json');
    const data = JSON.parse(fs.readFileSync(fuelDataPath, 'utf8'));

    const key = `${userId}_${vesselId}`;
    data.vessels[key] = {
      speed_kn: speed,
      kg_per_nm: fuelConsumption,
      capacity_type: capacityType
    };

    fs.writeFileSync(fuelDataPath, JSON.stringify(data, null, 2), 'utf8');
    logger.info(`[Fuel Calculator] Added custom vessel ${key} to fuel data`);

    // Reload cache
    reloadCustomFuelData();
  } catch (error) {
    logger.error(`[Fuel Calculator] Failed to add custom vessel fuel data: ${error.message}`);
  }
}

/**
 * Remove custom vessel from fuel data (called after vessel sell)
 *
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 */
function removeCustomVesselFuelData(userId, vesselId) {
  try {
    const fuelDataPath = path.join(__dirname, '../../userdata/vessel-appearances/custom_vessels_fuel_consumption.json');
    const data = JSON.parse(fs.readFileSync(fuelDataPath, 'utf8'));

    const key = `${userId}_${vesselId}`;
    if (data.vessels[key]) {
      delete data.vessels[key];
      fs.writeFileSync(fuelDataPath, JSON.stringify(data, null, 2), 'utf8');
      logger.info(`[Fuel Calculator] Removed custom vessel ${key} from fuel data`);

      // Reload cache
      reloadCustomFuelData();
    }
  } catch (error) {
    logger.error(`[Fuel Calculator] Failed to remove custom vessel fuel data: ${error.message}`);
  }
}

module.exports = {
  calculateFuelConsumption,
  getFuelConsumptionDisplay,
  getVesselFuelData,
  addCustomVesselFuelData,
  removeCustomVesselFuelData,
  reloadCustomFuelData
};
