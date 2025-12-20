/**
 * @fileoverview Port API Client Module
 *
 * This module handles all port and route-related API calls including:
 * - Fetching assigned ports with demand data
 * - Getting auto-price calculations for routes
 * - Retrieving reachable ports for vessels
 *
 * @requires ../utils/api - API helper functions
 * @requires ../utils/logger - Logging utility
 * @module server/gameapi/port
 */

const { apiCall, getUserId } = require('../utils/api');
const logger = require('../utils/logger');
const { portDemandStore } = require('../database/stores');

/**
 * Fetches all assigned ports with demand and consumed data.
 * Used by intelligent auto-depart feature to calculate remaining port capacity.
 *
 * @returns {Promise<Array>} Array of port objects with demand/consumed data
 */
async function fetchAssignedPorts() {
  const data = await apiCall('/port/get-assigned-ports', 'POST', {});
  return data.data.ports;
}

/**
 * Fetches auto-calculated price for a specific vessel on a route.
 * Used for intelligent pricing in auto-depart feature.
 *
 * @param {number} userVesselId - User vessel ID
 * @param {number} routeId - Route ID
 * @returns {Promise<Object>} Auto-price data from API
 */
async function fetchAutoPrice(userVesselId, routeId) {
  try {
    const data = await apiCall('/demand/auto-price', 'POST', {
      user_vessel_id: userVesselId,
      route_id: routeId
    });

    logger.debug(`[GameAPI] Auto-price for vessel ${userVesselId} on route ${routeId}:`, data);

    return data;
  } catch (error) {
    logger.error(`[GameAPI] Error fetching auto-price for vessel ${userVesselId}:`, error.message);
    throw error;
  }
}

/**
 * Gets all assigned ports with their data.
 * Simple wrapper for the API call.
 *
 * @returns {Promise<Object>} Response with ports data
 */
async function getAssignedPorts() {
  return await apiCall('/port/get-assigned-ports', 'POST', {});
}

/**
 * Fetches reachable ports for a specific vessel.
 * Note: Response includes empty demand arrays, must aggregate with game/index
 *
 * @param {number} vesselId - Vessel ID to get reachable ports for
 * @returns {Promise<Object>} Response with ports array
 */
async function getVesselPorts(vesselId) {
  return await apiCall('/route/get-vessel-ports', 'POST', {
    user_vessel_id: vesselId
  });
}

/**
 * Fetches route path between two ports.
 * Returns the actual sea route with all waypoints.
 *
 * @param {string} port1 - Origin port code
 * @param {string} port2 - Destination port code
 * @returns {Promise<Object>} Response with routes array containing path data
 */
async function getRoutesByPorts(port1, port2) {
  return await apiCall('/route/get-routes-by-ports', 'POST', {
    port1: port1,
    port2: port2
  });
}

module.exports = {
  fetchAssignedPorts,
  fetchAutoPrice,
  getAssignedPorts,
  getVesselPorts,
  getRoutesByPorts
};