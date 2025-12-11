/**
 * Harbor Map Data Aggregator
 * Aggregates vessel and port data from multiple API sources
 * Combines reachable ports with demand data from game/index
 *
 * @module harbor-map-aggregator
 */

const { calculateVesselPosition, calculateETA, calculateCargoUtilization, formatCargoCapacity } = require('./harbor-map-calculator');
const { getFuelConsumptionDisplay, getVesselFuelData } = require('../utils/fuel-calculator');
const fs = require('fs');
const path = require('path');
const { getAppBaseDir } = require('../config');

// Determine vessel appearances directory
const { isPackaged } = require('../config');
const isPkg = isPackaged();
const VESSEL_APPEARANCES_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'vessel-appearances')
  : path.join(__dirname, '../../userdata/vessel-appearances');

/**
 * Check if vessel has own image flag in appearance file
 */
function hasOwnImage(userId, vesselId) {
  try {
    const filePath = path.join(VESSEL_APPEARANCES_DIR, `${userId}_${vesselId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data.ownImage === true;
    }
  } catch {
    // File doesn't exist or invalid
  }
  return false;
}

/**
 * Aggregates vessel data with calculated positions and formatted info
 */
function aggregateVesselData(vessels, allPorts, userId) {
  const logger = require('../utils/logger');

  logger.debug(`[Harbor Map Aggregator] Processing ${vessels.length} vessels with ${allPorts.length} ports`);

  const result = vessels.map((vessel, index) => {
    const position = calculateVesselPosition(vessel, allPorts);
    const eta = calculateETA(vessel);
    const cargoUtilization = calculateCargoUtilization(vessel);
    const formattedCargo = formatCargoCapacity(vessel);
    const fuelConsumptionDisplay = getFuelConsumptionDisplay(vessel, userId);
    const fuelData = getVesselFuelData(vessel, userId);
    const ownImage = hasOwnImage(userId, vessel.id);

    if (index === 0) {
      logger.debug(`[Harbor Map Aggregator] Sample vessel: ${vessel.name}, status: ${vessel.status}, position: ${JSON.stringify(position)}`);
    }

    return {
      ...vessel,
      position,
      eta,
      cargoUtilization,
      formattedCargo,
      fuel_consumption_display: fuelConsumptionDisplay,
      fuel_consumption_kg_per_nm: fuelData?.kg_per_nm,
      fuel_ref_speed_kn: fuelData?.speed_kn,
      ownImage
    };
  });

  const withPosition = result.filter(v => v.position !== null).length;
  logger.debug(`[Harbor Map Aggregator] Result: ${withPosition}/${vessels.length} vessels have position`);

  return result;
}

/**
 * Aggregates reachable ports with demand data from game/index
 */
function aggregateReachablePorts(reachablePorts, allPortsWithDemand, capacityType) {
  const { calculateDemandLevel } = require('./harbor-map-calculator');

  return reachablePorts.map(reachablePort => {
    const portWithDemand = allPortsWithDemand.find(p => p.code === reachablePort.code);

    if (!portWithDemand) {
      return {
        ...reachablePort,
        demand: null,
        demandLevel: 'low'
      };
    }

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
 */
function categorizeVesselsByPort(portCode, allVessels) {
  const logger = require('../utils/logger');
  const inPort = [];
  const toPort = [];
  const fromPort = [];
  const pending = [];

  if (allVessels.length > 0) {
    const sampleVessel = allVessels[0];
    logger.debug(`[Categorize] Sample vessel fields: current_port_code=${sampleVessel.current_port_code}, status=${sampleVessel.status}, active_route=${JSON.stringify(sampleVessel.active_route)}`);
    logger.debug(`[Categorize] Looking for portCode: "${portCode}"`);
  }

  allVessels.forEach(vessel => {
    if ((vessel.status === 'pending' || vessel.status === 'delivery') && vessel.current_port_code === portCode) {
      pending.push(vessel);
    }
    else if (vessel.current_port_code === portCode && vessel.status !== 'enroute') {
      inPort.push(vessel);
    }
    else if (vessel.status === 'enroute' &&
             (vessel.active_route?.destination === portCode || vessel.active_route?.destination_port_code === portCode)) {
      toPort.push(vessel);
    }
    else if (vessel.status === 'enroute' &&
             (vessel.active_route?.origin === portCode || vessel.active_route?.origin_port_code === portCode)) {
      fromPort.push(vessel);
    }
  });

  logger.debug(`[Categorize] Results for port ${portCode}: inPort=${inPort.length}, toPort=${toPort.length}, fromPort=${fromPort.length}, pending=${pending.length}`);

  return { inPort, toPort, fromPort, pending };
}

/**
 * Filters ports to only user's assigned ports
 */
function filterAssignedPorts(assignedPorts, allPortsWithDemand) {
  return assignedPorts
    .map(assignedPort => {
      const portInGameIndex = allPortsWithDemand.find(p => p.code === assignedPort.code);
      if (!portInGameIndex) {
        return null;
      }
      return assignedPort;
    })
    .filter(port => port !== null);
}

/**
 * Extracts all ports with demand data from game/index response
 */
function extractPortsFromGameIndex(gameIndexData) {
  if (!gameIndexData?.ports) return [];
  return gameIndexData.ports;
}

/**
 * Extracts all vessels from game/index response
 */
function extractVesselsFromGameIndex(gameIndexData) {
  if (!gameIndexData?.vessels) return [];
  return gameIndexData.vessels;
}

/**
 * Groups vessels by their port pairs (routes between two ports)
 * Creates normalized port-pair keys so Hamburg<->NYC = NYC<->Hamburg
 */
function groupVesselsByPortPair(vessels, allPorts) {
  const logger = require('../utils/logger');
  const portLookup = {};
  allPorts.forEach(port => {
    portLookup[port.code] = { code: port.code, country: port.country };
  });

  const groups = {};
  const ungrouped = [];

  vessels.forEach(vessel => {
    const origin = vessel.route_origin;
    const destination = vessel.route_destination;
    if (!origin || !destination) { ungrouped.push(vessel); return; }

    const ports = [origin, destination].sort();
    const pairKey = ports[0] + '<>' + ports[1];

    if (!groups[pairKey]) {
      const portA = portLookup[ports[0]] || { code: ports[0], country: '??' };
      const portB = portLookup[ports[1]] || { code: ports[1], country: '??' };
      const displayA = portA.country + ' ' + formatPortAbbreviation(portA.code);
      const displayB = portB.country + ' ' + formatPortAbbreviation(portB.code);

      groups[pairKey] = {
        pairKey: pairKey,
        displayName: displayA + ' <> ' + displayB,
        portA: ports[0],
        portB: ports[1],
        portACountry: portA.country,
        portBCountry: portB.country,
        vessels: []
      };
    }

    groups[pairKey].vessels.push({
      id: vessel.id,
      name: vessel.name,
      status: vessel.status,
      route_origin: vessel.route_origin,
      route_destination: vessel.route_destination,
      route_name: vessel.route_name
    });
  });

  const groupsArray = Object.values(groups).sort((a, b) => b.vessels.length - a.vessels.length);
  logger.debug('[Harbor Map Aggregator] Port-pair groups: ' + groupsArray.length + ' groups, ' + ungrouped.length + ' ungrouped');
  return { groups: groupsArray, ungrouped: ungrouped };
}

/**
 * Creates a short abbreviation from a port code.
 * Rules:
 * - 3+ significant words: first letter of each (new_york_city -> NYC)
 * - 1-2 significant words: first 3 letters of first word (cape_town -> CAP)
 * - Filters out: port, of, the, de, du, di, der
 */
function formatPortAbbreviation(portCode) {
  if (!portCode) return '???';

  const parts = portCode.split('_');

  // Filter out common prefixes that don't count
  const skipWords = ['port', 'of', 'the', 'de', 'du', 'di', 'der'];
  const filtered = parts.filter(p => !skipWords.includes(p.toLowerCase()));

  if (filtered.length === 0) {
    // Fallback if all words filtered
    return parts[0].substring(0, 3).toUpperCase();
  } else if (filtered.length >= 3) {
    // 3+ words: first letter of each word
    return filtered.map(w => w[0].toUpperCase()).join('');
  } else {
    // 1-2 words: first 3 letters of first word
    return filtered[0].substring(0, 3).toUpperCase();
  }
}

module.exports = {
  aggregateVesselData,
  aggregateReachablePorts,
  categorizeVesselsByPort,
  filterAssignedPorts,
  extractPortsFromGameIndex,
  extractVesselsFromGameIndex,
  groupVesselsByPortPair,
  formatPortAbbreviation
};
