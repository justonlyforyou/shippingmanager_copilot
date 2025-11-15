/**
 * Harbor Map Calculator Utilities
 * Handles position calculations, ETA formatting, and demand level determination
 *
 * @module harbor-map-calculator
 */

/**
 * Calculates vessel's current position on route
 * If vessel is not sailing, returns port coordinates
 * If sailing, calculates position along route path using linear interpolation
 *
 * @param {Object} vessel - Vessel object with active_route and status
 * @param {Array<Object>} allPorts - All ports for fallback coordinates
 * @returns {Object|null} { lat: number, lon: number } or null if no position available
 * @example
 * const position = calculateVesselPosition(vessel, allPorts);
 * // Returns: { lat: -33.970, lon: 151.205 }
 */
function calculateVesselPosition(vessel, allPorts) {
  // If vessel not sailing, return port coordinates
  if (vessel.status !== 'enroute' || !vessel.active_route?.path || vessel.active_route.path.length === 0) {
    const port = allPorts.find(p => p.code === vessel.current_port_code);
    if (!port) return null;
    return {
      lat: parseFloat(port.lat),
      lon: parseFloat(port.lon)
    };
  }

  // Calculate progress along route
  const now = Date.now() / 1000; // Unix timestamp in seconds
  const departureTime = vessel.route_end_time - vessel.active_route.duration;
  const totalDuration = vessel.route_end_time - departureTime;

  // Ensure progress is between 0 and 1
  const progress = Math.max(0, Math.min(1, (now - departureTime) / totalDuration));

  // Handle reversed routes - if reversed=true, path direction is opposite
  const isReversed = vessel.active_route.reversed === true;
  const path = isReversed
    ? vessel.active_route.path.slice().reverse()
    : vessel.active_route.path;
  const pathLength = path.length;

  // Calculate index on path
  const exactIndex = progress * (pathLength - 1);
  const index = Math.floor(exactIndex);

  // Get two points for interpolation
  const point1 = path[index];
  const point2 = path[Math.min(index + 1, pathLength - 1)];

  // Linear interpolation between points
  const segmentProgress = exactIndex - index;

  return {
    lat: point1.lat + (point2.lat - point1.lat) * segmentProgress,
    lon: point1.lon + (point2.lon - point1.lon) * segmentProgress,
    progress: Math.round(progress * 100) // Progress percentage
  };
}

/**
 * Calculates time until arrival and formats as human-readable string
 *
 * @param {Object} vessel - Vessel with route_end_time
 * @returns {string} Formatted ETA like "2h 45m", "45m", or "Arrived"
 * @example
 * const eta = calculateETA(vessel);
 * // Returns: "2h 45m"
 */
function calculateETA(vessel) {
  if (!vessel.route_end_time) return 'N/A';

  const now = Date.now() / 1000; // Unix timestamp in seconds
  const secondsUntilArrival = vessel.route_end_time - now;

  // Already arrived
  if (secondsUntilArrival <= 0) return 'Arrived';

  const hours = Math.floor(secondsUntilArrival / 3600);
  const minutes = Math.floor((secondsUntilArrival % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

/**
 * Calculates cargo capacity utilization percentage
 *
 * @param {Object} vessel - Vessel with capacity and capacity_max
 * @returns {number} Utilization percentage (0-100)
 * @example
 * const utilization = calculateCargoUtilization(vessel);
 * // Returns: 79
 */
function calculateCargoUtilization(vessel) {
  if (!vessel.capacity || !vessel.capacity_max) return 0;

  let current = 0;
  let max = 0;

  if (vessel.capacity_type === 'container') {
    current = (vessel.capacity.dry || 0) + (vessel.capacity.refrigerated || 0);
    max = (vessel.capacity_max.dry || 0) + (vessel.capacity_max.refrigerated || 0);
  } else if (vessel.capacity_type === 'tanker') {
    current = (vessel.capacity.fuel || 0) + (vessel.capacity.crude_oil || 0);
    max = (vessel.capacity_max.fuel || 0) + (vessel.capacity_max.crude_oil || 0);
  }

  if (max === 0) return 0;
  return Math.round((current / max) * 100);
}

/**
 * Determines demand level indicator based on cargo type and demand value
 * Uses thresholds to categorize demand as high/medium/low
 *
 * @param {number} demand - Demand value
 * @param {string} cargoType - 'container' | 'tanker'
 * @returns {string} 'high' | 'medium' | 'low'
 * @example
 * const level = calculateDemandLevel(67578, 'container');
 * // Returns: "high"
 */
function calculateDemandLevel(demand, cargoType) {
  if (!demand || demand === 0) return 'low';

  // Thresholds based on cargo type
  if (cargoType === 'container') {
    if (demand > 50000) return 'high';
    if (demand > 20000) return 'medium';
    return 'low';
  } else if (cargoType === 'tanker') {
    if (demand > 5000000) return 'high';
    if (demand > 2000000) return 'medium';
    return 'low';
  }

  return 'low';
}

/**
 * Formats cargo capacity as human-readable string
 *
 * @param {Object} vessel - Vessel with capacity information
 * @returns {string} Formatted capacity like "203/250 TEU (79%)"
 * @example
 * const formatted = formatCargoCapacity(vessel);
 * // Returns: "203/250 TEU (79%)"
 */
function formatCargoCapacity(vessel) {
  if (!vessel.capacity || !vessel.capacity_max) return 'N/A';

  const utilization = calculateCargoUtilization(vessel);

  if (vessel.capacity_type === 'container') {
    const current = (vessel.capacity.dry || 0) + (vessel.capacity.refrigerated || 0);
    const max = (vessel.capacity_max.dry || 0) + (vessel.capacity_max.refrigerated || 0);
    return `${current}/${max} TEU (${utilization}%)`;
  } else if (vessel.capacity_type === 'tanker') {
    const current = (vessel.capacity.fuel || 0) + (vessel.capacity.crude_oil || 0);
    const max = (vessel.capacity_max.fuel || 0) + (vessel.capacity_max.crude_oil || 0);
    return `${current}/${max} tons (${utilization}%)`;
  }

  return 'N/A';
}

module.exports = {
  calculateVesselPosition,
  calculateETA,
  calculateCargoUtilization,
  calculateDemandLevel,
  formatCargoCapacity
};
