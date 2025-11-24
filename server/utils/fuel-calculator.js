/**
 * @fileoverview Fuel Calculator Utility - Calculates vessel fuel consumption
 *
 * Uses the discovered game formula:
 * fuel_kg_per_nm = capacity * Math.sqrt(speed) * fuel_factor / 40
 *
 * All vessel data (capacity, max_speed, fuel_factor) comes from the game API.
 * No lookup tables or user-entered data needed.
 *
 * @module server/utils/fuel-calculator
 */

const logger = require('./logger');

/**
 * Calculate fuel consumption using the game formula
 * Formula: fuel_kg_per_nm = capacity * Math.sqrt(speed) * fuel_factor / 40
 *
 * @param {Object} vessel - Vessel object with capacity and speed data from API
 * @returns {Object|null} Object with { kg_per_nm, speed_kn, capacity_type, calculated: true } or null if missing data
 */
function calculateFuelFromFormula(vessel) {
  if (!vessel) return null;

  // Get capacity - for tankers, capacity is divided by 74
  let capacity = 0;
  const capacityType = vessel.capacity_type || 'container';

  if (vessel.capacity_max) {
    if (capacityType === 'tanker') {
      // Tanker capacity: fuel + crude_oil, divided by 74 for formula
      capacity = ((vessel.capacity_max.fuel || 0) + (vessel.capacity_max.crude_oil || 0)) / 74;
    } else {
      // Container capacity: dry + refrigerated
      capacity = (vessel.capacity_max.dry || 0) + (vessel.capacity_max.refrigerated || 0);
    }
  }

  // Get speed - use max_speed as reference speed
  const speed = vessel.max_speed || vessel.route_speed || 0;

  // If we don't have capacity or speed, we can't calculate
  if (capacity <= 0 || speed <= 0) {
    return null;
  }

  // fuel_factor defaults to 1 if not available from vessel data
  const fuelFactor = vessel.fuel_factor || 1;

  // Calculate fuel consumption: capacity * sqrt(speed) * fuel_factor / 40
  const kgPerNm = Math.round((capacity * Math.sqrt(speed) * fuelFactor / 40) * 100) / 100;

  return {
    kg_per_nm: kgPerNm,
    speed_kn: speed,
    capacity_type: capacityType,
    calculated: true
  };
}

/**
 * Get fuel consumption data for a vessel using game formula
 *
 * @param {Object} vessel - Vessel object from API
 * @param {number} [userId] - User ID (kept for API compatibility, not used)
 * @returns {Object|null} Object with { kg_per_nm, speed_kn, capacity_type } or null if not found
 */
function getVesselFuelData(vessel, _userId) {
  return calculateFuelFromFormula(vessel);
}

/**
 * Calculate fuel consumption for a vessel at a specific speed
 *
 * @param {Object} vessel - Vessel object from API
 * @param {number} distance - Route distance in nautical miles
 * @param {number} actualSpeed - Actual speed in knots
 * @param {number} [userId] - User ID (kept for API compatibility, not used)
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
 * @param {Object} vessel - Vessel object from API
 * @param {number} [userId] - User ID (kept for API compatibility, not used)
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

// Stub functions to maintain API compatibility (do nothing)
function addCustomVesselFuelData() {
  logger.debug('[Fuel Calculator] addCustomVesselFuelData - no longer needed, fuel calculated from formula');
}

function removeCustomVesselFuelData() {
  logger.debug('[Fuel Calculator] removeCustomVesselFuelData - no longer needed, fuel calculated from formula');
}

function reloadCustomFuelData() {
  logger.debug('[Fuel Calculator] reloadCustomFuelData - no longer needed, fuel calculated from formula');
}

module.exports = {
  calculateFuelConsumption,
  calculateFuelFromFormula,
  getFuelConsumptionDisplay,
  getVesselFuelData,
  addCustomVesselFuelData,
  removeCustomVesselFuelData,
  reloadCustomFuelData
};
