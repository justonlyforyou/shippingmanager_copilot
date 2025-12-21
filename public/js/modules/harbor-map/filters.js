/**
 * @fileoverview Client-Side Filtering Logic for Harbor Map
 * All filtering happens in browser - NO API calls when changing filters
 *
 * Filter Types:
 * - Max Demand: Uses the `demand` field directly (total demand capacity)
 * - Current Demand: Uses `demand - consumed` (remaining unfulfilled demand)
 * - My Ports: Only ports where isAssigned === true
 * - All Ports: All ports regardless of assignment
 *
 * @module harbor-map/filters
 */

import logger from '../core/logger.js';

/**
 * Filters vessels based on selected criteria
 *
 * @param {Array<Object>} vessels - All vessels
 * @param {string} filterType - Filter type
 * @returns {Array<Object>} Filtered vessels
 */
export function filterVessels(vessels, filterType) {
  if (!vessels || vessels.length === 0) return [];

  logger.debug('[Filter] Filtering ' + vessels.length + ' vessels with filter: ' + filterType);

  switch (filterType) {
    case 'all_vessels':
      return vessels;

    case 'vessels_arrive_soon': {
      // Vessels arriving in less than 10 minutes
      const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
      const arrivingSoon = vessels.filter(v => {
        if (v.status !== 'enroute') return false;
        if (!v.route_end_time) return false;

        const etaSeconds = v.route_end_time - now;
        const etaMinutes = Math.floor(etaSeconds / 60);
        const matches = etaMinutes > 0 && etaMinutes < 10;

        if (v.status === 'enroute' && etaMinutes < 60) {
          logger.debug('[Filter] Vessel ' + v.id + ' (' + v.name + ') - ETA: ' + etaMinutes + ' min, Matches: ' + matches);
        }
        return matches;
      });
      logger.debug('[Filter] Found ' + arrivingSoon.length + ' vessels arriving in <10 min');
      return arrivingSoon;
    }

    case 'enroute_vessels': {
      // Vessels that are currently enroute (have active routes)
      const enrouteVessels = vessels.filter(v => v.status === 'enroute');
      logger.debug('[Filter] Found ' + enrouteVessels.length + ' vessels enroute');
      return enrouteVessels;
    }

    case 'arrived_vessels': {
      // Vessels that have arrived at port (status: 'port') and are ready to depart (not parked)
      const arrivedVessels = vessels.filter(v => v.status === 'port' && !v.is_parked);
      logger.debug('[Filter] Found ' + arrivedVessels.length + ' arrived vessels (excluding parked)');
      return arrivedVessels;
    }

    case 'anchored_vessels': {
      // Vessels that are anchored (status: 'anchor')
      const anchoredVessels = vessels.filter(v => v.status === 'anchor');
      logger.debug('[Filter] Found ' + anchoredVessels.length + ' anchored vessels');
      return anchoredVessels;
    }

    case 'moored_vessels': {
      // Vessels that are moored/parked at port (status: 'port' && is_parked)
      const mooredVessels = vessels.filter(v => v.status === 'port' && v.is_parked === true);
      logger.debug('[Filter] Found ' + mooredVessels.length + ' moored vessels');
      return mooredVessels;
    }

    case 'vessels_in_drydock': {
      // Vessels in drydock/maintenance (status: 'maintenance') OR enroute to/from drydock (route_dry_operation === 1)
      const drydockVessels = vessels.filter(v =>
        v.status === 'maintenance' ||
        (v.status === 'enroute' && v.route_dry_operation === 1)
      );
      logger.debug('[Filter] Found ' + drydockVessels.length + ' vessels in drydock (maintenance + enroute drydock trips)');
      return drydockVessels;
    }

    case 'vessels_in_delivery': {
      // Vessels being delivered (status: 'delivery' or 'pending')
      const deliveryVessels = vessels.filter(v => v.status === 'delivery' || v.status === 'pending');
      logger.debug('[Filter] Found ' + deliveryVessels.length + ' vessels in delivery (delivery + pending)');
      return deliveryVessels;
    }

    case 'tanker_only': {
      const tankers = vessels.filter(v => v.capacity_type === 'tanker');
      logger.debug('[Filter] Found ' + tankers.length + ' tanker vessels');
      return tankers;
    }

    case 'container_only': {
      const containers = vessels.filter(v => v.capacity_type === 'container');
      logger.debug('[Filter] Found ' + containers.length + ' container vessels');
      return containers;
    }

    case 'low_utilization': {
      // Vessels with utilization below settings threshold (default 30%)
      const settings = window.getSettings ? window.getSettings() : {};
      const minUtilization = settings.minCargoUtilization !== null && settings.minCargoUtilization !== undefined
        ? settings.minCargoUtilization
        : 30;

      const lowUtil = vessels.filter(v => {
        if (!v.capacity || !v.capacity_max) {
          logger.debug('[Filter] Vessel ' + v.id + ' has no capacity data');
          return false;
        }
        const utilization = calculateVesselUtilization(v);
        const matches = utilization < minUtilization;
        logger.debug('[Filter] Vessel ' + v.id + ' (' + v.name + ') - Type: ' + v.capacity_type + ', Utilization: ' + utilization.toFixed(1) + '%, Threshold: ' + minUtilization + '%, Matches: ' + matches);
        return matches;
      });
      logger.debug('[Filter] Found ' + lowUtil.length + ' vessels with utilization <' + minUtilization + '%');
      return lowUtil;
    }

    default:
      return vessels;
  }
}

/**
 * Filters ports based on selected criteria
 *
 * @param {Array<Object>} ports - All ports
 * @param {Array<Object>} vessels - All vessels (needed for some filters)
 * @param {string} filterType - Filter type
 * @returns {Array<Object>} Filtered ports
 */
export function filterPorts(ports, vessels, filterType) {
  if (!ports || ports.length === 0) return [];

  switch (filterType) {
    case 'my_ports':
      // Only ports assigned to user (default)
      return ports.filter(p => p.isAssigned === true);

    case 'all_ports':
      return ports;

    case 'my_ports_with_arrived_vessels': {
      // Only assigned ports with vessels in 'port' status
      const portsWithArrivedVessels = new Set(
        vessels.filter(v => v.status === 'port' && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithArrivedVessels.has(p.code));
    }

    case 'my_ports_with_anchored_vessels': {
      // Only assigned ports with vessels in 'anchor' status
      const portsWithAnchoredVessels = new Set(
        vessels.filter(v => v.status === 'anchor' && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithAnchoredVessels.has(p.code));
    }

    case 'my_ports_with_vessels_in_maint': {
      // Only assigned ports with vessels in 'maintenance' status
      const portsWithMaintenanceVessels = new Set(
        vessels.filter(v => v.status === 'maintenance' && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithMaintenanceVessels.has(p.code));
    }

    case 'my_ports_with_pending_vessels': {
      // Only assigned ports with vessels in 'pending' or 'delivery' status
      const portsWithPendingVessels = new Set(
        vessels.filter(v => (v.status === 'pending' || v.status === 'delivery') && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithPendingVessels.has(p.code));
    }

    case 'my_ports_no_route': {
      // Ports that are NOT assigned to me (opposite of my_ports)
      const filtered = ports.filter(p => !p.isAssigned);
      logger.debug('[Filter] Ports not assigned: ' + filtered.length);
      return filtered;
    }

    case 'my_ports_cargo_demand_very_low':
      // Actual cargo demand <= 10,000 TEU (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container || !p.consumed || !p.consumed.container) return false;
        let actualCargo = 0;
        if (p.demand.container.dry !== undefined && p.consumed.container.dry !== undefined) {
          actualCargo += p.demand.container.dry - p.consumed.container.dry;
        }
        if (p.demand.container.refrigerated !== undefined && p.consumed.container.refrigerated !== undefined) {
          actualCargo += p.demand.container.refrigerated - p.consumed.container.refrigerated;
        }
        return actualCargo > 0 && actualCargo <= 10000;
      });

    case 'my_ports_cargo_demand_low':
      // Actual cargo demand <= 50,000 TEU (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container || !p.consumed || !p.consumed.container) return false;
        let actualCargo = 0;
        if (p.demand.container.dry !== undefined && p.consumed.container.dry !== undefined) {
          actualCargo += p.demand.container.dry - p.consumed.container.dry;
        }
        if (p.demand.container.refrigerated !== undefined && p.consumed.container.refrigerated !== undefined) {
          actualCargo += p.demand.container.refrigerated - p.consumed.container.refrigerated;
        }
        logger.debug('[Filter] Port ' + p.code + ' actual cargo demand: ' + actualCargo + ' TEU');
        return actualCargo > 0 && actualCargo <= 50000;
      });

    case 'my_ports_cargo_demand_medium':
      // Actual cargo demand <= 100,000 TEU (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container || !p.consumed || !p.consumed.container) return false;
        let actualCargo = 0;
        if (p.demand.container.dry !== undefined && p.consumed.container.dry !== undefined) {
          actualCargo += p.demand.container.dry - p.consumed.container.dry;
        }
        if (p.demand.container.refrigerated !== undefined && p.consumed.container.refrigerated !== undefined) {
          actualCargo += p.demand.container.refrigerated - p.consumed.container.refrigerated;
        }
        return actualCargo > 0 && actualCargo <= 100000;
      });

    case 'my_ports_oil_demand_low':
      // Actual oil demand <= 50,000 bbl (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.tanker || !p.consumed || !p.consumed.tanker) return false;
        let actualOil = 0;
        if (p.demand.tanker.fuel !== undefined && p.consumed.tanker.fuel !== undefined) {
          actualOil += p.demand.tanker.fuel - p.consumed.tanker.fuel;
        }
        if (p.demand.tanker.crude_oil !== undefined && p.consumed.tanker.crude_oil !== undefined) {
          actualOil += p.demand.tanker.crude_oil - p.consumed.tanker.crude_oil;
        }
        const matches = actualOil > 0 && actualOil <= 50000;
        if (p.isAssigned && p.demand.tanker) {
          logger.debug('[Filter] Port ' + p.code + ' actual oil demand: ' + actualOil + ' bbl, Matches: ' + matches);
        }
        return matches;
      });

    case 'my_ports_oil_demand_medium':
      // Actual oil demand <= 100,000 bbl (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.tanker || !p.consumed || !p.consumed.tanker) return false;
        let actualOil = 0;
        if (p.demand.tanker.fuel !== undefined && p.consumed.tanker.fuel !== undefined) {
          actualOil += p.demand.tanker.fuel - p.consumed.tanker.fuel;
        }
        if (p.demand.tanker.crude_oil !== undefined && p.consumed.tanker.crude_oil !== undefined) {
          actualOil += p.demand.tanker.crude_oil - p.consumed.tanker.crude_oil;
        }
        return actualOil > 0 && actualOil <= 100000;
      });

    // >= Filters (high demand)
    case 'my_ports_cargo_demand_gte_10k':
      // Actual cargo demand >= 10,000 TEU (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container || !p.consumed || !p.consumed.container) return false;
        let actualCargo = 0;
        if (p.demand.container.dry !== undefined && p.consumed.container.dry !== undefined) {
          actualCargo += p.demand.container.dry - p.consumed.container.dry;
        }
        if (p.demand.container.refrigerated !== undefined && p.consumed.container.refrigerated !== undefined) {
          actualCargo += p.demand.container.refrigerated - p.consumed.container.refrigerated;
        }
        return actualCargo >= 10000;
      });

    case 'my_ports_cargo_demand_gte_50k':
      // Actual cargo demand >= 50,000 TEU (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container || !p.consumed || !p.consumed.container) return false;
        let actualCargo = 0;
        if (p.demand.container.dry !== undefined && p.consumed.container.dry !== undefined) {
          actualCargo += p.demand.container.dry - p.consumed.container.dry;
        }
        if (p.demand.container.refrigerated !== undefined && p.consumed.container.refrigerated !== undefined) {
          actualCargo += p.demand.container.refrigerated - p.consumed.container.refrigerated;
        }
        return actualCargo >= 50000;
      });

    case 'my_ports_cargo_demand_gte_100k':
      // Actual cargo demand >= 100,000 TEU (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container || !p.consumed || !p.consumed.container) return false;
        let actualCargo = 0;
        if (p.demand.container.dry !== undefined && p.consumed.container.dry !== undefined) {
          actualCargo += p.demand.container.dry - p.consumed.container.dry;
        }
        if (p.demand.container.refrigerated !== undefined && p.consumed.container.refrigerated !== undefined) {
          actualCargo += p.demand.container.refrigerated - p.consumed.container.refrigerated;
        }
        return actualCargo >= 100000;
      });

    case 'my_ports_oil_demand_gte_50k':
      // Actual oil demand >= 50,000 bbl (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.tanker || !p.consumed || !p.consumed.tanker) return false;
        let actualOil = 0;
        if (p.demand.tanker.fuel !== undefined && p.consumed.tanker.fuel !== undefined) {
          actualOil += p.demand.tanker.fuel - p.consumed.tanker.fuel;
        }
        if (p.demand.tanker.crude_oil !== undefined && p.consumed.tanker.crude_oil !== undefined) {
          actualOil += p.demand.tanker.crude_oil - p.consumed.tanker.crude_oil;
        }
        return actualOil >= 50000;
      });

    case 'my_ports_oil_demand_gte_100k':
      // Actual oil demand >= 100,000 bbl (demand - consumed)
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.tanker || !p.consumed || !p.consumed.tanker) return false;
        let actualOil = 0;
        if (p.demand.tanker.fuel !== undefined && p.consumed.tanker.fuel !== undefined) {
          actualOil += p.demand.tanker.fuel - p.consumed.tanker.fuel;
        }
        if (p.demand.tanker.crude_oil !== undefined && p.consumed.tanker.crude_oil !== undefined) {
          actualOil += p.demand.tanker.crude_oil - p.consumed.tanker.crude_oil;
        }
        return actualOil >= 100000;
      });

    default:
      return ports;
  }
}

/**
 * Calculates vessel utilization percentage
 * Uses capacity (current cargo) and capacity_max (maximum capacity)
 *
 * @param {Object} vessel - Vessel object with capacity and capacity_max
 * @returns {number} Utilization percentage (0-100)
 */
function calculateVesselUtilization(vessel) {
  if (!vessel.capacity || !vessel.capacity_max) return 0;

  if (vessel.capacity_type === 'container') {
    let currentCargo = 0;
    let maxCapacity = 0;
    if (vessel.capacity.dry !== undefined) currentCargo += vessel.capacity.dry;
    if (vessel.capacity.refrigerated !== undefined) currentCargo += vessel.capacity.refrigerated;
    if (vessel.capacity_max.dry !== undefined) maxCapacity += vessel.capacity_max.dry;
    if (vessel.capacity_max.refrigerated !== undefined) maxCapacity += vessel.capacity_max.refrigerated;
    return maxCapacity > 0 ? (currentCargo / maxCapacity) * 100 : 0;
  } else if (vessel.capacity_type === 'tanker') {
    let currentCargo = 0;
    let maxCapacity = 0;
    if (vessel.capacity.fuel !== undefined) currentCargo += vessel.capacity.fuel;
    if (vessel.capacity.crude_oil !== undefined) currentCargo += vessel.capacity.crude_oil;
    if (vessel.capacity_max.fuel !== undefined) maxCapacity += vessel.capacity_max.fuel;
    if (vessel.capacity_max.crude_oil !== undefined) maxCapacity += vessel.capacity_max.crude_oil;
    return maxCapacity > 0 ? (currentCargo / maxCapacity) * 100 : 0;
  }

  return 0;
}

/**
 * Returns available vessel filter options
 *
 * @returns {Array<Object>} Filter options with {value, label}
 */
export function getVesselFilterOptions() {
  const settings = window.getSettings ? window.getSettings() : {};
  const minUtilization = settings.minCargoUtilization !== null && settings.minCargoUtilization !== undefined
    ? settings.minCargoUtilization
    : 30;

  return [
    { value: 'all_vessels', label: 'All My Vessels' },
    { value: 'enroute_vessels', label: 'Vessels Enroute' },
    { value: 'vessels_arrive_soon', label: 'Arriving in <10 min' },
    { value: 'arrived_vessels', label: 'Arrived Vessels' },
    { value: 'anchored_vessels', label: 'Anchored Vessels' },
    { value: 'moored_vessels', label: 'Moored Vessels' },
    { value: 'vessels_in_drydock', label: 'Vessels in Drydock' },
    { value: 'vessels_in_delivery', label: 'Vessels in Delivery' },
    { value: 'tanker_only', label: 'Tanker Only' },
    { value: 'container_only', label: 'Container Only' },
    { value: 'low_utilization', label: 'Utilization < ' + minUtilization + '%' }
  ];
}

/**
 * Returns available port filter options
 *
 * @returns {Array<Object>} Filter options with {value, label}
 */
export function getPortFilterOptions() {
  return [
    { value: 'my_ports', label: 'My Ports' },
    { value: 'all_ports', label: 'All Ports' },
    { value: 'my_ports_no_route', label: 'Ports No Route' },
    { value: 'my_ports_cargo_demand_very_low', label: 'Demand <= 10k TEU' },
    { value: 'my_ports_cargo_demand_low', label: 'Demand <= 50k TEU' },
    { value: 'my_ports_cargo_demand_medium', label: 'Demand <= 100k TEU' },
    { value: 'my_ports_cargo_demand_gte_10k', label: 'Demand >= 10k TEU' },
    { value: 'my_ports_cargo_demand_gte_50k', label: 'Demand >= 50k TEU' },
    { value: 'my_ports_cargo_demand_gte_100k', label: 'Demand >= 100k TEU' },
    { value: 'my_ports_oil_demand_low', label: 'Demand <= 50k bbl' },
    { value: 'my_ports_oil_demand_medium', label: 'Demand <= 100k bbl' },
    { value: 'my_ports_oil_demand_gte_50k', label: 'Demand >= 50k bbl' },
    { value: 'my_ports_oil_demand_gte_100k', label: 'Demand >= 100k bbl' }
  ];
}

/**
 * Filters vessels by port-pair (route)
 * Returns only vessels that have the specified port-pair as their route
 *
 * @param {Array<Object>} vessels - All vessels
 * @param {string} pairKey - Port-pair key like "hamburg<>new_york" (alphabetically sorted)
 * @returns {Array<Object>} Filtered vessels on this route
 */
export function filterVesselsByPortPair(vessels, pairKey) {
  if (!vessels || vessels.length === 0) return [];
  if (!pairKey) return vessels;

  const filtered = vessels.filter(v => {
    if (!v.route_origin || !v.route_destination) return false;
    const ports = [v.route_origin, v.route_destination].sort();
    const vesselPairKey = ports[0] + '<>' + ports[1];
    return vesselPairKey === pairKey;
  });

  logger.debug('[Filter] Filtered by port-pair ' + pairKey + ': ' + filtered.length + ' vessels');
  return filtered;
}

/**
 * Filters ports to only show ports involved in a specific port-pair route
 *
 * @param {Array<Object>} ports - All ports
 * @param {string} pairKey - Port-pair key like "hamburg<>new_york"
 * @returns {Array<Object>} Filtered ports (the two ports in the pair)
 */
export function filterPortsByPortPair(ports, pairKey) {
  if (!ports || ports.length === 0) return [];
  if (!pairKey) return ports;

  const portCodes = pairKey.split('<>');
  if (portCodes.length !== 2) return ports;

  const filtered = ports.filter(p => portCodes.includes(p.code));
  logger.debug('[Filter] Filtered ports by port-pair ' + pairKey + ': ' + filtered.length + ' ports');
  return filtered;
}

/**
 * Calculates the MAX cargo demand for a port (total demand capacity).
 * Uses the `demand` field directly without subtracting consumed.
 *
 * @param {Object} port - Port object with demand data
 * @returns {number} Total cargo demand in TEU, or -1 if no data
 */
export function calculatePortMaxCargoDemand(port) {
  if (!port.demand || !port.demand.container) return -1;

  let totalDemand = 0;
  let hasData = false;

  if (port.demand.container.dry !== undefined) {
    totalDemand += port.demand.container.dry;
    hasData = true;
  }
  if (port.demand.container.refrigerated !== undefined) {
    totalDemand += port.demand.container.refrigerated;
    hasData = true;
  }

  return hasData ? totalDemand : -1;
}

/**
 * Calculates the CURRENT (actual) cargo demand for a port.
 * Uses `demand - consumed` to get remaining unfulfilled demand.
 *
 * @param {Object} port - Port object with demand and consumed data
 * @returns {number} Actual cargo demand in TEU, or -1 if no data
 */
export function calculatePortCurrentCargoDemand(port) {
  if (!port.demand || !port.demand.container) return -1;
  if (!port.consumed || !port.consumed.container) return -1;

  let actualDemand = 0;
  let hasData = false;

  if (port.demand.container.dry !== undefined && port.consumed.container.dry !== undefined) {
    actualDemand += port.demand.container.dry - port.consumed.container.dry;
    hasData = true;
  }
  if (port.demand.container.refrigerated !== undefined && port.consumed.container.refrigerated !== undefined) {
    actualDemand += port.demand.container.refrigerated - port.consumed.container.refrigerated;
    hasData = true;
  }

  return hasData ? actualDemand : -1;
}

/**
 * Calculates the MAX oil demand for a port (total demand capacity).
 * Uses the `demand` field directly without subtracting consumed.
 *
 * @param {Object} port - Port object with demand data
 * @returns {number} Total oil demand in bbl, or -1 if no data
 */
export function calculatePortMaxOilDemand(port) {
  if (!port.demand || !port.demand.tanker) return -1;

  let totalDemand = 0;
  let hasData = false;

  if (port.demand.tanker.fuel !== undefined) {
    totalDemand += port.demand.tanker.fuel;
    hasData = true;
  }
  if (port.demand.tanker.crude_oil !== undefined) {
    totalDemand += port.demand.tanker.crude_oil;
    hasData = true;
  }

  return hasData ? totalDemand : -1;
}

/**
 * Calculates the CURRENT (actual) oil demand for a port.
 * Uses `demand - consumed` to get remaining unfulfilled demand.
 *
 * @param {Object} port - Port object with demand and consumed data
 * @returns {number} Actual oil demand in bbl, or -1 if no data
 */
export function calculatePortCurrentOilDemand(port) {
  if (!port.demand || !port.demand.tanker) return -1;
  if (!port.consumed || !port.consumed.tanker) return -1;

  let actualDemand = 0;
  let hasData = false;

  if (port.demand.tanker.fuel !== undefined && port.consumed.tanker.fuel !== undefined) {
    actualDemand += port.demand.tanker.fuel - port.consumed.tanker.fuel;
    hasData = true;
  }
  if (port.demand.tanker.crude_oil !== undefined && port.consumed.tanker.crude_oil !== undefined) {
    actualDemand += port.demand.tanker.crude_oil - port.consumed.tanker.crude_oil;
    hasData = true;
  }

  return hasData ? actualDemand : -1;
}

/**
 * Returns available demand filter options for the filter modal.
 * Organized by: Max/Current and My Ports/All Ports
 *
 * @param {string} demandType - 'max_my' | 'current_my' | 'max_all' | 'current_all'
 * @returns {Array<Object>} Filter options with {value, label}
 */
export function getDemandFilterOptions(demandType) {
  const baseOptions = [
    { value: '', label: 'No Filter' }
  ];

  const cargoThresholds = [
    { value: '10000', label: '>= 10k TEU', comparison: 'gte' },
    { value: '50000', label: '>= 50k TEU', comparison: 'gte' },
    { value: '100000', label: '>= 100k TEU', comparison: 'gte' },
    { value: '-10000', label: '<= 10k TEU', comparison: 'lte' },
    { value: '-50000', label: '<= 50k TEU', comparison: 'lte' },
    { value: '-100000', label: '<= 100k TEU', comparison: 'lte' }
  ];

  const oilThresholds = [
    { value: 'oil_50000', label: '>= 50k bbl', comparison: 'gte' },
    { value: 'oil_100000', label: '>= 100k bbl', comparison: 'gte' },
    { value: 'oil_5000000', label: '>= 5M bbl', comparison: 'gte' },
    { value: 'oil_10000000', label: '>= 10M bbl', comparison: 'gte' },
    { value: 'oil_15000000', label: '>= 15M bbl', comparison: 'gte' },
    { value: 'oil_-50000', label: '<= 50k bbl', comparison: 'lte' },
    { value: 'oil_-100000', label: '<= 100k bbl', comparison: 'lte' }
  ];

  // Build options with type prefix
  const prefix = demandType + '_';
  const options = [...baseOptions];

  // Add cargo options
  cargoThresholds.forEach(t => {
    options.push({
      value: prefix + 'cargo_' + t.value,
      label: 'Cargo ' + t.label
    });
  });

  // Add oil options
  oilThresholds.forEach(t => {
    options.push({
      value: prefix + t.value,
      label: 'Oil ' + t.label.replace('>=', '>=').replace('<=', '<=')
    });
  });

  return options;
}

/**
 * Applies a demand filter to ports based on the filter value.
 * Filter value format: {demandType}_{cargoType}_{threshold}
 * Example: 'max_my_cargo_50000' or 'current_all_oil_-100000'
 *
 * @param {Array<Object>} ports - All ports
 * @param {string} filterValue - Filter value from dropdown
 * @returns {Array<Object>} Filtered ports
 */
export function applyDemandFilter(ports, filterValue) {
  if (!ports || ports.length === 0) return [];
  if (!filterValue) return ports;

  // Parse filter value: demandType_scope_cargoType_threshold
  // Examples: max_my_cargo_50000, current_all_oil_-100000
  const parts = filterValue.split('_');
  if (parts.length < 4) return ports;

  const demandType = parts[0]; // 'max' or 'current'
  const scope = parts[1]; // 'my' or 'all'
  const cargoType = parts[2]; // 'cargo' or 'oil'
  const thresholdStr = parts.slice(3).join('_'); // handle negative numbers

  const threshold = parseInt(thresholdStr, 10);
  if (isNaN(threshold)) return ports;

  const isLessThanOrEqual = threshold < 0;
  const absThreshold = Math.abs(threshold);

  return ports.filter(p => {
    // Check scope
    if (scope === 'my' && !p.isAssigned) return false;

    // Calculate demand based on type and cargo
    let demandValue;
    if (cargoType === 'cargo') {
      demandValue = demandType === 'max'
        ? calculatePortMaxCargoDemand(p)
        : calculatePortCurrentCargoDemand(p);
    } else {
      demandValue = demandType === 'max'
        ? calculatePortMaxOilDemand(p)
        : calculatePortCurrentOilDemand(p);
    }

    // No data available
    if (demandValue === -1) return false;

    // Apply comparison
    if (isLessThanOrEqual) {
      return demandValue > 0 && demandValue <= absThreshold;
    }
    return demandValue >= absThreshold;
  });
}
