/**
 * @fileoverview Client-Side Filtering Logic for Harbor Map
 * All filtering happens in browser - NO API calls when changing filters
 *
 * @module harbor-map/filters
 */

/**
 * Filters vessels based on selected criteria
 *
 * @param {Array<Object>} vessels - All vessels
 * @param {string} filterType - Filter type
 * @returns {Array<Object>} Filtered vessels
 */
export function filterVessels(vessels, filterType) {
  if (!vessels || vessels.length === 0) return [];

  console.log(`[Filter] Filtering ${vessels.length} vessels with filter: ${filterType}`);

  switch (filterType) {
    case 'all_vessels':
      return vessels;

    case 'vessels_arrive_soon':
      // Vessels arriving in less than 10 minutes
      const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
      const arrivingSoon = vessels.filter(v => {
        if (v.status !== 'enroute') return false;
        if (!v.route_end_time) return false;

        const etaSeconds = v.route_end_time - now;
        const etaMinutes = Math.floor(etaSeconds / 60);
        const matches = etaMinutes > 0 && etaMinutes < 10;

        if (v.status === 'enroute' && etaMinutes < 60) {
          console.log(`[Filter] Vessel ${v.id} (${v.name}) - ETA: ${etaMinutes} min, Matches: ${matches}`);
        }
        return matches;
      });
      console.log(`[Filter] Found ${arrivingSoon.length} vessels arriving in <10 min`);
      return arrivingSoon;

    case 'enroute_vessels':
      // Vessels that are currently enroute (have active routes)
      const enrouteVessels = vessels.filter(v => v.status === 'enroute');
      console.log(`[Filter] Found ${enrouteVessels.length} vessels enroute`);
      return enrouteVessels;

    case 'arrived_vessels':
      // Vessels that have arrived at port (status: 'port') and are ready to depart (not parked)
      const arrivedVessels = vessels.filter(v => v.status === 'port' && !v.is_parked);
      console.log(`[Filter] Found ${arrivedVessels.length} arrived vessels (excluding parked)`);
      return arrivedVessels;

    case 'anchored_vessels':
      // Vessels that are anchored (status: 'anchor')
      const anchoredVessels = vessels.filter(v => v.status === 'anchor');
      console.log(`[Filter] Found ${anchoredVessels.length} anchored vessels`);
      return anchoredVessels;

    case 'vessels_in_drydock':
      // Vessels in drydock/maintenance (status: 'maintenance')
      const drydockVessels = vessels.filter(v => v.status === 'maintenance');
      console.log(`[Filter] Found ${drydockVessels.length} vessels in drydock`);
      return drydockVessels;

    case 'vessels_in_delivery':
      // Vessels being delivered (status: 'delivery' or 'pending')
      const deliveryVessels = vessels.filter(v => v.status === 'delivery' || v.status === 'pending');
      console.log(`[Filter] Found ${deliveryVessels.length} vessels in delivery (delivery + pending)`);
      return deliveryVessels;

    case 'tanker_only':
      const tankers = vessels.filter(v => v.capacity_type === 'tanker');
      console.log(`[Filter] Found ${tankers.length} tanker vessels`);
      return tankers;

    case 'container_only':
      const containers = vessels.filter(v => v.capacity_type === 'container');
      console.log(`[Filter] Found ${containers.length} container vessels`);
      return containers;

    case 'low_utilization':
      // Vessels with utilization below settings threshold (default 30%)
      const settings = window.getSettings ? window.getSettings() : {};
      const minUtilization = settings.minCargoUtilization !== null && settings.minCargoUtilization !== undefined
        ? settings.minCargoUtilization
        : 30;

      const lowUtil = vessels.filter(v => {
        if (!v.capacity || !v.capacity_max) {
          console.log(`[Filter] Vessel ${v.id} has no capacity data`);
          return false;
        }
        const utilization = calculateVesselUtilization(v);
        const matches = utilization < minUtilization;
        console.log(`[Filter] Vessel ${v.id} (${v.name}) - Type: ${v.capacity_type}, Utilization: ${utilization.toFixed(1)}%, Threshold: ${minUtilization}%, Matches: ${matches}`);
        return matches;
      });
      console.log(`[Filter] Found ${lowUtil.length} vessels with utilization <${minUtilization}%`);
      return lowUtil;

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

    case 'my_ports_with_arrived_vessels':
      // Only assigned ports with vessels in 'port' status
      const portsWithArrivedVessels = new Set(
        vessels.filter(v => v.status === 'port' && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithArrivedVessels.has(p.code));

    case 'my_ports_with_anchored_vessels':
      // Only assigned ports with vessels in 'anchor' status
      const portsWithAnchoredVessels = new Set(
        vessels.filter(v => v.status === 'anchor' && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithAnchoredVessels.has(p.code));

    case 'my_ports_with_vessels_in_maint':
      // Only assigned ports with vessels in 'maintenance' status
      const portsWithMaintenanceVessels = new Set(
        vessels.filter(v => v.status === 'maintenance' && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithMaintenanceVessels.has(p.code));

    case 'my_ports_with_pending_vessels':
      // Only assigned ports with vessels in 'pending' or 'delivery' status
      const portsWithPendingVessels = new Set(
        vessels.filter(v => (v.status === 'pending' || v.status === 'delivery') && v.current_port_code).map(v => v.current_port_code)
      );
      return ports.filter(p => p.isAssigned && portsWithPendingVessels.has(p.code));

    case 'my_ports_cargo_demand_very_low':
      // Cargo demand <= 10,000 TEU
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container) return false;
        const totalCargo = (p.demand.container.dry || 0) + (p.demand.container.refrigerated || 0);
        return totalCargo > 0 && totalCargo <= 10000;
      });

    case 'my_ports_cargo_demand_low':
      // Cargo demand <= 50,000 TEU
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container) {
          return false;
        }
        const totalCargo = (p.demand.container.dry || 0) + (p.demand.container.refrigerated || 0);
        console.log(`[Filter] Port ${p.code} cargo demand: ${totalCargo} TEU`);
        return totalCargo > 0 && totalCargo <= 50000;
      });

    case 'my_ports_cargo_demand_medium':
      // Cargo demand <= 100,000 TEU
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.container) return false;
        const totalCargo = (p.demand.container.dry || 0) + (p.demand.container.refrigerated || 0);
        return totalCargo > 0 && totalCargo <= 100000;
      });

    case 'my_ports_oil_demand_low':
      // Oil demand <= 50,000 bbl
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.tanker) return false;
        const totalOil = (p.demand.tanker.fuel || 0) + (p.demand.tanker.crude_oil || 0);
        const matches = totalOil > 0 && totalOil <= 50000;
        if (p.isAssigned && p.demand.tanker) {
          console.log(`[Filter] Port ${p.code} oil demand: ${totalOil} bbl, Matches: ${matches}`);
        }
        return matches;
      });

    case 'my_ports_oil_demand_medium':
      // Oil demand <= 100,000 bbl
      return ports.filter(p => {
        if (!p.isAssigned) return false;
        if (!p.demand || !p.demand.tanker) return false;
        const totalOil = (p.demand.tanker.fuel || 0) + (p.demand.tanker.crude_oil || 0);
        return totalOil > 0 && totalOil <= 100000;
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
    const currentCargo = (vessel.capacity.dry || 0) + (vessel.capacity.refrigerated || 0);
    const maxCapacity = (vessel.capacity_max.dry || 0) + (vessel.capacity_max.refrigerated || 0);
    return maxCapacity > 0 ? (currentCargo / maxCapacity) * 100 : 0;
  } else if (vessel.capacity_type === 'tanker') {
    const currentCargo = (vessel.capacity.fuel || 0) + (vessel.capacity.crude_oil || 0);
    const maxCapacity = (vessel.capacity_max.fuel || 0) + (vessel.capacity_max.crude_oil || 0);
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
    { value: 'vessels_in_drydock', label: 'Vessels in Drydock' },
    { value: 'vessels_in_delivery', label: 'Vessels in Delivery' },
    { value: 'tanker_only', label: 'Tanker Only' },
    { value: 'container_only', label: 'Container Only' },
    { value: 'low_utilization', label: `Utilization < ${minUtilization}%` }
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
    { value: 'my_ports_cargo_demand_very_low', label: 'Demand ≤ 10k TEU' },
    { value: 'my_ports_cargo_demand_low', label: 'Demand ≤ 50k TEU' },
    { value: 'my_ports_cargo_demand_medium', label: 'Demand ≤ 100k TEU' },
    { value: 'my_ports_oil_demand_low', label: 'Demand ≤ 50k bbl' },
    { value: 'my_ports_oil_demand_medium', label: 'Demand ≤ 100k bbl' }
  ];
}
