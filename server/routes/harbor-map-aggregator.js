/**
 * Harbor Map Data Aggregator
 * Aggregates vessel and port data from multiple API sources
 * Combines reachable ports with demand data from game/index
 *
 * @module harbor-map-aggregator
 */

const { calculateVesselPosition, calculateETA, calculateCargoUtilization, formatCargoCapacity } = require('./harbor-map-calculator');

/**
 * Aggregates vessel data with calculated positions and formatted info
 * Adds current position, ETA, cargo utilization to each vessel
 *
 * @param {Array<Object>} vessels - Raw vessel objects from API
 * @param {Array<Object>} allPorts - All ports for position fallback
 * @returns {Array<Object>} Vessels with added calculated fields
 * @example
 * const enrichedVessels = aggregateVesselData(vessels, allPorts);
 * // Returns vessels with .position, .eta, .cargoUtilization, .formattedCargo
 */
function aggregateVesselData(vessels, allPorts) {
  const logger = require('../utils/logger');

  logger.log(`[Harbor Map Aggregator] Processing ${vessels.length} vessels with ${allPorts.length} ports`);

  const result = vessels.map((vessel, index) => {
    const position = calculateVesselPosition(vessel, allPorts);
    const eta = calculateETA(vessel);
    const cargoUtilization = calculateCargoUtilization(vessel);
    const formattedCargo = formatCargoCapacity(vessel);

    if (index === 0) {
      logger.log(`[Harbor Map Aggregator] Sample vessel: ${vessel.name}, status: ${vessel.status}, position: ${JSON.stringify(position)}`);
    }

    return {
      ...vessel,
      position,
      eta,
      cargoUtilization,
      formattedCargo
    };
  });

  const withPosition = result.filter(v => v.position !== null).length;
  logger.log(`[Harbor Map Aggregator] Result: ${withPosition}/${vessels.length} vessels have position`);

  return result;
}

/**
 * Aggregates reachable ports with demand data from game/index
 * Combines port coordinates from reachable ports with demand data
 *
 * @param {Array<Object>} reachablePorts - Ports from /route/get-vessel-ports
 * @param {Array<Object>} allPortsWithDemand - All ports from /game/index with demand
 * @param {string} capacityType - Vessel capacity type ('container' | 'tanker')
 * @returns {Array<Object>} Ports with demand data added
 * @example
 * const portsWithDemand = aggregateReachablePorts(reachable, gameIndexPorts, 'container');
 * // Returns: [{ code: 'AUBNE', lat: -27.38, lon: 153.12, demand: {...}, demandLevel: 'high' }]
 */
function aggregateReachablePorts(reachablePorts, allPortsWithDemand, capacityType) {
  const { calculateDemandLevel } = require('./harbor-map-calculator');

  return reachablePorts.map(reachablePort => {
    // Find matching port in game/index data
    const portWithDemand = allPortsWithDemand.find(p => p.code === reachablePort.code);

    if (!portWithDemand) {
      // Port exists in reachable list but not in game/index - return basic info
      return {
        ...reachablePort,
        demand: null,
        demandLevel: 'low'
      };
    }

    // Determine demand value based on capacity type
    let demandValue = 0;
    if (capacityType === 'container') {
      demandValue = (portWithDemand.demand?.dry || 0) + (portWithDemand.demand?.refrigerated || 0);
    } else if (capacityType === 'tanker') {
      demandValue = (portWithDemand.demand?.fuel || 0) + (portWithDemand.demand?.crude_oil || 0);
    }

    const demandLevel = calculateDemandLevel(demandValue, capacityType);

    return {
      ...reachablePort,
      demand: portWithDemand.demand,
      demandLevel
    };
  });
}

/**
 * Categorizes all vessels by their relationship to a specific port
 * Splits vessels into four categories: in port, heading to, coming from, pending
 *
 * @param {string} portCode - Port code to categorize vessels for
 * @param {Array<Object>} allVessels - All user vessels
 * @returns {Object} { inPort: [], toPort: [], fromPort: [], pending: [] }
 * @example
 * const categorized = categorizeVesselsByPort('AUBNE', allVessels);
 * // Returns: { inPort: [v1, v2], toPort: [v3], fromPort: [v4, v5], pending: [v6] }
 */
function categorizeVesselsByPort(portCode, allVessels) {
  const logger = require('../utils/logger');
  const inPort = [];
  const toPort = [];
  const fromPort = [];
  const pending = [];

  // Debug: Log first vessel structure to understand fields
  if (allVessels.length > 0) {
    const sampleVessel = allVessels[0];
    logger.log(`[Categorize] Sample vessel fields: current_port_code=${sampleVessel.current_port_code}, status=${sampleVessel.status}, active_route=${JSON.stringify(sampleVessel.active_route)}`);
    logger.log(`[Categorize] Looking for portCode: "${portCode}"`);
  }

  allVessels.forEach(vessel => {
    // Vessels being built/delivered (pending status)
    if ((vessel.status === 'pending' || vessel.status === 'delivery') && vessel.current_port_code === portCode) {
      pending.push(vessel);
    }
    // Vessels currently in port
    else if (vessel.current_port_code === portCode && vessel.status !== 'enroute') {
      inPort.push(vessel);
    }
    // Vessels heading to port (check both field names for compatibility)
    else if (vessel.status === 'enroute' &&
             (vessel.active_route?.destination === portCode || vessel.active_route?.destination_port_code === portCode)) {
      toPort.push(vessel);
    }
    // Vessels coming from port (check both field names for compatibility)
    else if (vessel.status === 'enroute' &&
             (vessel.active_route?.origin === portCode || vessel.active_route?.origin_port_code === portCode)) {
      fromPort.push(vessel);
    }
  });

  logger.log(`[Categorize] Results for port ${portCode}: inPort=${inPort.length}, toPort=${toPort.length}, fromPort=${fromPort.length}, pending=${pending.length}`);

  return { inPort, toPort, fromPort, pending };
}

/**
 * Filters ports to only user's assigned ports
 * Uses demand data from assigned-ports (which has correct structure)
 * Validates that ports exist in game/index (for coordinates/metadata)
 *
 * @param {Array<Object>} assignedPorts - Ports from /port/get-assigned-ports (has correct demand)
 * @param {Array<Object>} allPortsWithDemand - All ports from /game/index (for validation)
 * @returns {Array<Object>} Assigned ports with demand data (only ports in game/index)
 * @example
 * const myPorts = filterAssignedPorts(assignedPorts, gameIndexPorts);
 * // Returns: assigned ports that exist in game/index
 */
function filterAssignedPorts(assignedPorts, allPortsWithDemand) {
  return assignedPorts
    .map(assignedPort => {
      const portInGameIndex = allPortsWithDemand.find(p => p.code === assignedPort.code);

      // Skip ports that don't exist in game/index
      if (!portInGameIndex) {
        return null;
      }

      // Use assigned port data (has correct demand structure)
      // Just validate it exists in game/index
      return assignedPort;
    })
    .filter(port => port !== null); // Remove null entries
}

/**
 * Extracts all ports with demand data from game/index response
 * Used as source of truth for demand data across all aggregation functions
 *
 * @param {Object} gameIndexData - Full response from /game/index
 * @returns {Array<Object>} All ports with demand data (360 ports)
 * @example
 * const allPorts = extractPortsFromGameIndex(gameIndexData);
 * // Returns: [{ code: 'AUBNE', lat: -27.38, lon: 153.12, demand: {...} }, ...]
 */
function extractPortsFromGameIndex(gameIndexData) {
  if (!gameIndexData?.ports) return [];
  return gameIndexData.ports;
}

/**
 * Extracts all vessels from game/index response
 * Alternative to /vessel/get-all-user-vessels endpoint
 *
 * @param {Object} gameIndexData - Full response from /game/index
 * @returns {Array<Object>} All user vessels (101 vessels)
 * @example
 * const allVessels = extractVesselsFromGameIndex(gameIndexData);
 * // Returns: [{ id: 1234, name: 'SS Example', ... }, ...]
 */
function extractVesselsFromGameIndex(gameIndexData) {
  if (!gameIndexData?.vessels) return [];
  return gameIndexData.vessels;
}

module.exports = {
  aggregateVesselData,
  aggregateReachablePorts,
  categorizeVesselsByPort,
  filterAssignedPorts,
  extractPortsFromGameIndex,
  extractVesselsFromGameIndex
};
