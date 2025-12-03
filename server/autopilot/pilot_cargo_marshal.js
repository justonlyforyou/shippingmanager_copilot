/**
 * @fileoverview Cargo Marshal - Auto-Depart Vessels Pilot
 *
 * Automatically departs vessels with intelligent demand-based routing.
 * Includes race condition prevention and $0 revenue protection.
 *
 * @module server/autopilot/pilot_cargo_marshal
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId, getAllianceId } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');
const { saveTripData } = require('../utils/trip-data-store');
const { fetchUserContribution } = require('../gameapi/alliance');
const { calculateFuelConsumption } = require('../utils/fuel-calculator');

/**
 * Tracks vessels that failed fuel check to avoid retrying unnecessarily.
 * Map structure: { userId: { vesselId: { fuelLevel: number, requiredFuel: number, timestamp: number } } }
 *
 * This cache is cleared when fuel level increases, ensuring we retry vessels
 * that previously failed once more fuel is available.
 */
const fuelFailedVesselsCache = new Map();

/**
 * Resets the fuel-failed vessels cache for a specific user when fuel increases.
 * This allows vessels that previously couldn't depart to be retried.
 *
 * @param {number} userId - User ID
 * @param {number} newFuelLevel - New fuel level in tons
 */
function resetFuelFailedCacheIfIncreased(userId, newFuelLevel) {
  const userCache = fuelFailedVesselsCache.get(userId);
  if (!userCache) return;

  // Get the previous fuel level from the first cached vessel (all share same fuel level snapshot)
  const cachedEntries = Array.from(userCache.values());
  if (cachedEntries.length === 0) return;

  const previousFuelLevel = cachedEntries[0].fuelLevel;

  // If fuel increased, clear the cache so we can retry all vessels
  if (newFuelLevel > previousFuelLevel) {
    logger.debug(`[Depart] Fuel increased from ${previousFuelLevel.toFixed(1)}t to ${newFuelLevel.toFixed(1)}t - resetting fuel-failed vessel cache`);
    fuelFailedVesselsCache.delete(userId);
  }
}

/**
 * Calculates remaining demand at a port.
 *
 * @param {Object} port - Port object
 * @param {string} vesselType - 'container' or 'tanker'
 * @returns {number} Remaining demand
 */
function calculateRemainingDemand(port, vesselType) {
  if (vesselType === 'container') {
    const dryDemand = port.demand?.container?.dry || 0;
    const dryConsumed = port.consumed?.container?.dry || 0;
    const refDemand = port.demand?.container?.refrigerated || 0;
    const refConsumed = port.consumed?.container?.refrigerated || 0;

    return (dryDemand - dryConsumed) + (refDemand - refConsumed);
  } else if (vesselType === 'tanker') {
    const fuelDemand = port.demand?.tanker?.fuel || 0;
    const fuelConsumed = port.consumed?.tanker?.fuel || 0;
    const crudeDemand = port.demand?.tanker?.crude_oil || 0;
    const crudeConsumed = port.consumed?.tanker?.crude_oil || 0;

    return (fuelDemand - fuelConsumed) + (crudeDemand - crudeConsumed);
  }

  return 0;
}

/**
 * Calculates total capacity of a vessel.
 *
 * @param {Object} vessel - Vessel object
 * @returns {number} Total capacity
 */
function getTotalCapacity(vessel) {
  if (vessel.capacity_type === 'container') {
    return (vessel.capacity_max?.dry || 0) + (vessel.capacity_max?.refrigerated || 0);
  } else if (vessel.capacity_type === 'tanker') {
    return (vessel.capacity_max?.fuel || 0) + (vessel.capacity_max?.crude_oil || 0);
  }
  return 0;
}

/**
 * Universal vessel departure function with intelligent demand-based routing.
 * Works with any list of vessel IDs or all vessels if vesselIds=null.
 * Used by BOTH autopilot and manual departure operations.
 *
 * @async
 * @param {number} userId - User ID for state management
 * @param {Array<number>|null} vesselIds - Array of vessel IDs to depart, or null for all vessels
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} autoRebuyAll - Function to trigger fuel/CO2 rebuy
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<Object>} Result object: { success: boolean, reason?: string, error?: string }
 */
async function departVessels(userId, vesselIds = null, broadcastToUser, autoRebuyAll, tryUpdateAllData) {
  // LOCK: Prevent concurrent departure operations (race condition protection)
  if (state.getLockStatus(userId, 'depart')) {
    logger.debug('[Depart] SKIPPED - Another departure operation is already in progress');
    return {
      success: false,
      reason: 'depart_in_progress',
      departedCount: 0
    };
  }

  // Set lock and broadcast to all clients
  state.setLockStatus(userId, 'depart', true);
  if (broadcastToUser) {
    // First broadcast lock_status to immediately disable depart buttons
    broadcastToUser(userId, 'lock_status', {
      depart: true
    });
    // Then broadcast depart_start for notifications
    broadcastToUser(userId, 'autopilot_depart_start', {
      vesselCount: vesselIds ? vesselIds.length : 'all'
    });
  }
  logger.debug('[Depart] Lock acquired');

  try {
    const settings = state.getSettings(userId);

    // Get current bunker state
    const bunker = await gameapi.fetchBunkerState();
    state.updateBunkerState(userId, bunker);

    // Reset fuel-failed vessels cache if fuel increased
    resetFuelFailedCacheIfIncreased(userId, bunker.fuel);

    // DEBUG: Log fuel-failed cache status
    const userCache = fuelFailedVesselsCache.get(userId);
    if (userCache && userCache.size > 0) {
      logger.debug(`[Depart] Fuel-failed cache: ${userCache.size} vessel(s) previously failed fuel check`);
      for (const [vesselId, data] of userCache.entries()) {
        logger.debug(`[Depart]   - Vessel ID ${vesselId}: need ${data.requiredFuel.toFixed(1)}t, had ${data.fuelLevel.toFixed(1)}t`);
      }
    } else {
      logger.debug(`[Depart] Fuel-failed cache: empty`);
    }

    // Check if fuel is too low (use minFuelThreshold setting)
    if (bunker.fuel < settings.minFuelThreshold) {
      logger.warn(`[Depart] Skipping - insufficient fuel (${bunker.fuel.toFixed(1)}t < ${settings.minFuelThreshold}t minimum)`);

      // Release lock (will also be done in finally, but doing it here ensures immediate unlock)
      state.setLockStatus(userId, 'depart', false);

      // Notify user about insufficient fuel
      if (broadcastToUser) {
        broadcastToUser(userId, 'notification', {
          type: 'error',
          message: `<p><strong>Harbor master</strong></p><p>Cannot depart vessels - insufficient fuel!<br>Current: ${bunker.fuel.toFixed(1)}t | Required minimum: ${settings.minFuelThreshold}t</p>`
        });

        // Send updated lock status
        broadcastToUser(userId, 'lock_status', {
          depart: false,
          fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
          co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
          repair: state.getLockStatus(userId, 'repair'),
          bulkBuy: state.getLockStatus(userId, 'bulkBuy')
        });
      }
      return { success: false, reason: 'insufficient_fuel' };
    }

    // Fetch vessels ONCE at the start
    const allVessels = await gameapi.fetchVessels();
    // NOTE: We will fetch port data BEFORE EACH DEPART to avoid race conditions

    // Filter vessels: either specific IDs or all in harbor
    let harbourVessels;
    if (vesselIds && vesselIds.length > 0) {
      // Filter by specific vessel IDs
      const vesselIdSet = new Set(vesselIds);
      harbourVessels = allVessels.filter(v =>
        vesselIdSet.has(v.id) &&
        v.status === 'port' &&
        !v.is_parked
      );
      logger.debug(`[Depart] Filtering ${vesselIds.length} requested vessels, found ${harbourVessels.length} in harbor`);
    } else {
      // Depart ALL vessels in harbor
      harbourVessels = allVessels.filter(v => v.status === 'port' && !v.is_parked);
    }

    logger.debug(`[Depart] Found ${harbourVessels.length} vessels to process (total: ${allVessels.length})`);

    if (harbourVessels.length === 0) {
      logger.debug('[Depart] No vessels to depart, skipping');

      // Release lock (will also be done in finally, but doing it here ensures immediate unlock)
      state.setLockStatus(userId, 'depart', false);

      // Send updated lock status
      if (broadcastToUser) {
        broadcastToUser(userId, 'lock_status', {
          depart: false,
          fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
          co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
          repair: state.getLockStatus(userId, 'repair'),
          bulkBuy: state.getLockStatus(userId, 'bulkBuy')
        });

        // Notify user if this was a specific vessel request (not autopilot)
        if (vesselIds && vesselIds.length > 0) {
          broadcastToUser(userId, 'notification', {
            type: 'warning',
            message: '<p><strong>Cargo Marshal</strong></p><p>No vessels ready to depart in harbor.</p>'
          });
        }
      }

      return { success: true, reason: 'no_vessels' };
    }

    // Remove duplicate depart_start broadcast (already sent at function start)
    // Notify frontend that autopilot departure has started (locks depart button)
    if (false && broadcastToUser) {
      broadcastToUser(userId, 'autopilot_depart_start', {
        vesselCount: harbourVessels.length
      });
    }

    // Track departed, failed, and warning vessels
    const departedVessels = [];
    const failedVessels = [];
    const warningVessels = [];

    // Separate arrays for logbook (not cleared after batches)
    const allDepartedVessels = [];
    const allFailedVessels = [];
    const allWarningVessels = [];
    const allHighFeeVessels = [];

    // Check if user is in alliance - only track contribution if yes
    const trackContribution = getAllianceId() !== null;
    if (!trackContribution) {
      logger.debug('[Depart] User not in alliance - contribution tracking disabled');
    }

    const CHUNK_SIZE = 20;
    let processedCount = 0;

    // Helper function to send notifications for current batch
    async function sendBatchNotifications() {
      // Send combined notification if there are any vessels (departed or failed)
      if (departedVessels.length > 0 || failedVessels.length > 0) {
        const totalIncome = departedVessels.reduce((sum, v) => sum + v.income, 0);
        const totalFuelUsed = departedVessels.reduce((sum, v) => sum + v.fuelUsed, 0);
        const totalCO2Used = departedVessels.reduce((sum, v) => sum + v.co2Used, 0);

        logger.debug(`[Depart] Batch: ${departedVessels.length} departed, ${failedVessels.length} failed - Income: $${totalIncome.toLocaleString()}`);

        if (broadcastToUser) {
          let bunkerState = null;
          try {
            bunkerState = await gameapi.fetchBunkerState();
          } catch (fetchError) {
            logger.warn(`[Depart] Failed to fetch bunker state for batch notification: ${fetchError.message}`);
            bunkerState = state.getBunkerState(userId);
          }

          // Send batch update event (does NOT unlock button)
          broadcastToUser(userId, 'vessels_depart_batch', {
            succeeded: {
              count: departedVessels.length,
              vessels: departedVessels.slice(),
              totalIncome: totalIncome,
              totalFuelUsed: totalFuelUsed,
              totalCO2Used: totalCO2Used
            },
            failed: {
              count: failedVessels.length,
              vessels: failedVessels.slice()
            },
            bunker: bunkerState ? {
              fuel: bunkerState.fuel,
              co2: bunkerState.co2
            } : null
          });

          // Send complete bunker update with all fields (fuel, co2, cash, maxFuel, maxCO2)
          if (bunkerState) {
            const { broadcastBunkerUpdate } = require('../websocket');
            broadcastBunkerUpdate(userId, bunkerState);
          }
        }

        // Trigger auto-rebuy after each successful batch (if enabled)
        if (departedVessels.length > 0) {
          logger.debug(`[Depart] Triggering auto-rebuy after ${departedVessels.length} vessels departed in this batch`);
          try {
            await autoRebuyAll();
          } catch (rebuyError) {
            logger.warn(`[Depart] Auto-rebuy failed (non-critical): ${rebuyError.message}`);
          }
        }

        departedVessels.length = 0; // Clear array for next batch
        // Save failed vessels before clearing
        allFailedVessels.push(...failedVessels);
        failedVessels.length = 0; // Clear array for next batch
      }
    }

    // Group vessels by destination and type
    const vesselsByDestinationAndType = {};

    for (const vessel of harbourVessels) {
      if (!vessel.route_destination) {
        logger.debug(`[Depart] Skipping ${vessel.name}: no route destination`);
        failedVessels.push({
          name: vessel.name,
          destination: 'Unknown',
          reason: 'No route assigned'
        });
        continue;
      }

      const destination = vessel.route_destination;
      const type = vessel.capacity_type;
      const key = `${destination}_${type}`;

      if (!vesselsByDestinationAndType[key]) {
        vesselsByDestinationAndType[key] = [];
      }
      vesselsByDestinationAndType[key].push(vessel);
    }

    logger.debug(`[Depart] Grouped vessels into ${Object.keys(vesselsByDestinationAndType).length} destination+type groups`);

    // Fetch assigned ports ONCE at the start (static data that doesn't change during depart)
    const assignedPorts = await gameapi.fetchAssignedPorts();
    logger.debug(`[Depart] Fetched ${assignedPorts.length} assigned ports (cached for all vessels)`);

    // Process each destination+type group
    for (const key in vesselsByDestinationAndType) {
      const vessels = vesselsByDestinationAndType[key];
      const firstVessel = vessels[0];
      const vesselType = firstVessel.capacity_type;

      logger.debug(`[Depart] Processing group: ${key} (${vessels.length} vessels)`);

      // Determine next destination
      let destination;
      if (firstVessel.route_destination === firstVessel.current_port_code) {
        destination = firstVessel.route_origin;
      } else if (firstVessel.route_origin === firstVessel.current_port_code) {
        destination = firstVessel.route_destination;
      } else {
        destination = firstVessel.route_destination;
      }

      logger.debug(`[Depart] Destination: ${destination}`);

      // Sort vessels by capacity (largest first)
      const sortedVessels = vessels.sort((a, b) => getTotalCapacity(b) - getTotalCapacity(a));

      // Process each vessel individually
      for (const vessel of sortedVessels) {
        const vesselCapacity = getTotalCapacity(vessel);

        // OPTIMIZATION: Skip vessels that previously failed fuel check (unless fuel increased)
        const vesselCache = fuelFailedVesselsCache.get(userId) || new Map();
        const cachedFailure = vesselCache.get(vessel.id);

        if (cachedFailure) {
          logger.debug(`[Depart] ${vessel.name}: Skipping - already checked with insufficient fuel (need ${cachedFailure.requiredFuel.toFixed(1)}t, had ${cachedFailure.fuelLevel.toFixed(1)}t)`);
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `Insufficient fuel: need ${cachedFailure.requiredFuel.toFixed(1)}t, have ${bunker.fuel.toFixed(1)}t (cached)`
          });
          continue;
        }

        // Use cached port data (assigned ports don't change during depart process)
        const port = assignedPorts.find(p => p.code === destination);

        if (!port) {
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: 'Port not in assigned ports'
          });
          continue;
        }

        // Calculate CURRENT remaining demand with fresh data
        const remainingDemand = calculateRemainingDemand(port, vesselType);

        logger.debug(`[Depart] ${vessel.name}: Demand check - Remaining: ${remainingDemand}`);

        // Skip if no demand
        if (remainingDemand <= 0) {
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `No demand at destination`
          });
          continue;
        }

        // CRITICAL: Check if price-per-TEU is 0 at destination using auto-price API
        try {
          if (vessel.route_id) {
            const autoPriceData = await gameapi.fetchAutoPrice(vessel.id, vessel.route_id);

            const dryPrice = autoPriceData?.data?.dry || 0;
            const refPrice = autoPriceData?.data?.ref || 0;
            const fuelPrice = autoPriceData?.data?.fuel || 0;
            const crudePrice = autoPriceData?.data?.crude_oil || 0;

            const hasValidPrice = vesselType === 'container'
              ? (dryPrice > 0 || refPrice > 0)
              : (fuelPrice > 0 || crudePrice > 0);

            if (!hasValidPrice) {
              logger.warn(`[Depart] ${vessel.name}: Price per TEU is $0 at ${destination} - BLOCKING departure to avoid losses`);
              failedVessels.push({
                name: vessel.name,
                destination: destination,
                reason: `CRITICAL: Price per TEU is $0 at destination - would result in losses`
              });
              continue;
            }

            logger.debug(`[Depart] ${vessel.name}: Price check OK - Dry: $${dryPrice}, Ref: $${refPrice}, Fuel: $${fuelPrice}, Crude: $${crudePrice}`);

            // Store prices on vessel for later use when saving trip data
            vessel.prices = {
              dry: dryPrice,
              refrigerated: refPrice,
              fuel: fuelPrice,
              crude_oil: crudePrice
            };
          }
        } catch (error) {
          logger.error(`[Depart] ${vessel.name}: Failed to fetch auto-price - BLOCKING departure to avoid potential losses`);
          logger.error(`[Depart] Error details: ${error.message}`);
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `Cannot verify destination price (API error: ${error.message}) - blocking to prevent potential losses`
          });
          continue;
        }

        // Check utilization
        const cargoToLoad = Math.min(remainingDemand, vesselCapacity);
        const utilizationRate = vesselCapacity > 0 ? cargoToLoad / vesselCapacity : 0;
        const minUtilization = settings.minCargoUtilization / 100;

        if (utilizationRate < minUtilization) {
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `Utilization too low (${(utilizationRate * 100).toFixed(0)}% < ${(minUtilization * 100).toFixed(0)}%)`
          });
          continue;
        }

        // Determine speed and guards
        let speed, guards;

        if (settings.autoDepartUseRouteDefaults) {
          speed = vessel.route_speed || vessel.max_speed;
          guards = vessel.route_guards;
        } else {
          const speedPercent = settings.autoVesselSpeed;
          speed = Math.round(vessel.max_speed * (speedPercent / 100));
          guards = vessel.route_guards;
        }

        // PRE-CHECK: Calculate and verify sufficient fuel BEFORE attempting departure
        // Uses actual vessel-specific fuel consumption data (kg/nm at reference speeds)
        let requiredFuel = vessel.route_fuel_required || vessel.fuel_required;

        // If not provided by API, calculate it using vessel-specific fuel consumption data
        if (!requiredFuel && vessel.route_distance) {
          const distance = vessel.route_distance; // nautical miles
          // Use actual speed (might be reduced from max_speed by settings)
          const actualSpeed = speed || vessel.route_speed || vessel.max_speed;

          // Calculate fuel using vessel-specific consumption data
          requiredFuel = calculateFuelConsumption(vessel, distance, actualSpeed, userId);

          // Fallback: If vessel not found in our data, don't block departure
          if (requiredFuel === null) {
            logger.warn(`[Depart] ${vessel.name}: No fuel consumption data available - allowing departure without fuel check`);
            requiredFuel = 0;
          }
        }

        const currentFuel = bunker.fuel;

        if (requiredFuel && currentFuel < requiredFuel) {
          logger.debug(`[Depart] ${vessel.name}: Insufficient fuel - need ${requiredFuel.toFixed(1)}t, have ${currentFuel.toFixed(1)}t`);

          // Cache this vessel as fuel-failed to avoid retrying until fuel increases
          if (!fuelFailedVesselsCache.has(userId)) {
            fuelFailedVesselsCache.set(userId, new Map());
          }
          fuelFailedVesselsCache.get(userId).set(vessel.id, {
            fuelLevel: currentFuel,
            requiredFuel: requiredFuel,
            timestamp: Date.now()
          });

          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `Insufficient fuel: need ${requiredFuel.toFixed(1)}t, have ${currentFuel.toFixed(1)}t`
          });
          continue;
        }

        try {
          logger.debug(`[Depart] Attempting to depart vessel: name="${vessel.name}", id=${vessel.id}, status="${vessel.status}"`);

          // Query contribution BEFORE this vessel departs (only if user is in alliance)
          const contributionBefore = trackContribution ? await fetchUserContribution(userId) : null;

          const result = await gameapi.departVessel(vessel.id, speed, guards);

          // Check if departure failed
          if (result.success === false) {
            // SPECIAL CASE: Vessel already departed (race condition)
            if (result.error === 'Vessel not found or status invalid') {
              logger.warn(`[Depart] Vessel ${vessel.name} was already departed by another process (race condition)`);
              failedVessels.push({
                name: vessel.name,
                destination: destination,
                reason: 'Already departed (race condition with autopilot or game)'
              });
              continue;
            }

            // SPECIAL CASE: CO2 "errors" - vessel was actually sent
            if (result.errorMessage && (result.errorMessage.toLowerCase().includes('co2') ||
                                       result.errorMessage.toLowerCase().includes('emission'))) {
              logger.debug(`[Depart] ${vessel.name} departed with CO2 warning - vessel sent but no stats available, skipping notification`);
              continue;
            }

            // Extract error message safely (API can return strings, objects, or undefined)
            let detailedReason = 'Unknown error';

            if (typeof result.errorMessage === 'string') {
              detailedReason = result.errorMessage;
            } else if (result.errorMessage && typeof result.errorMessage === 'object') {
              detailedReason = JSON.stringify(result.errorMessage);
            }

            if (result.apiResponse && result.apiResponse.message && typeof result.apiResponse.message === 'string') {
              detailedReason = result.apiResponse.message;
            }

            logger.warn(`[Depart] Failed to depart ${vessel.name}: "${detailedReason}"`);

            const lowerReason = detailedReason.toLowerCase();

            if (lowerReason.includes('fuel') || lowerReason.includes('bunker')) {
              // Reuse requiredFuel and currentFuel from outer scope (already declared above)
              if (requiredFuel) {
                detailedReason = `Insufficient fuel: need ${requiredFuel.toFixed(1)}t, have ${currentFuel.toFixed(1)}t`;
              } else {
                detailedReason = `Insufficient fuel: have ${currentFuel.toFixed(1)}t`;
              }
            } else if (lowerReason.includes('demand') || (remainingDemand <= 0 && lowerReason.includes('failed'))) {
              detailedReason = `No demand at ${destination} (${remainingDemand.toFixed(1)}t remaining demand, vessel capacity ${vesselCapacity.toFixed(1)}t)`;
            } else if (lowerReason === 'failed to depart vessel') {
              detailedReason = result.errorMessage || 'Failed to depart vessel';
            }

            failedVessels.push({
              name: vessel.name,
              destination: destination,
              reason: detailedReason
            });
            continue;
          }

          // Check for silent failures (API returned success but no data)
          if (result.income === 0 && result.fuelUsed === 0) {
            logger.warn(`[Depart] ${vessel.name}: Silent failure - $0 income, 0 fuel used (API returned no data)`);
            failedVessels.push({
              name: vessel.name,
              destination: destination,
              reason: 'Silent failure - API returned no departure data'
            });
            continue;
          }

          // Check for $0 revenue
          if (result.income === 0 && result.harborFee === 0) {
            logger.warn(`[Depart] WARNING: ${vessel.name} departed with $0 revenue - demand exhausted during batch`);
            const warningData = {
              name: result.vesselName,
              destination: result.destination,
              reason: 'Demand exhausted - $0 revenue'
            };
            warningVessels.push(warningData);
            allWarningVessels.push(warningData);
            continue;
          }

          // Query contribution AFTER successful departure (only if user is in alliance)
          const contributionAfter = trackContribution ? await fetchUserContribution(userId) : null;

          // Track vessels with excessive harbor fees (using settings threshold)
          // High harbor fee just means the route is not profitable, not a bug
          const harborFeeThreshold = settings.harborFeeWarningThreshold || 50; // Default 50%
          const feePercentage = result.income > 0 ? (result.harborFee / result.income) * 100 : 0;
          const isHighFee = feePercentage > harborFeeThreshold;

          if (isHighFee) {
            const highFeeData = {
              name: result.vesselName,
              destination: result.destination,
              income: result.income,
              harborFee: result.harborFee,
              feePercentage: Math.round(feePercentage),
              reason: `Harbor fee ${Math.round(feePercentage)}% (threshold: ${harborFeeThreshold}%)`
            };
            allHighFeeVessels.push(highFeeData);
          }

          // Calculate actual utilization from API response
          const actualCargoLoaded = result.cargoLoaded;
          const actualUtilization = vesselCapacity > 0 ? actualCargoLoaded / vesselCapacity : 0;

          // Calculate contribution gained by this vessel (only if tracking is enabled)
          let contributionGained = null;
          if (trackContribution) {
            if (contributionBefore !== null && contributionAfter !== null) {
              contributionGained = contributionAfter - contributionBefore;
              logger.debug(`[Depart] ${vessel.name} gained ${contributionGained} contribution`);
            } else {
              // Only log warning if we SHOULD be tracking but got null values
              logger.warn(`[Depart] ${vessel.name} contribution tracking failed: before=${contributionBefore}, after=${contributionAfter}`);
            }
          }

          // Successfully departed
          // Capture timestamp immediately after API response
          const departedAt = Date.now();

          const vesselData = {
            vesselId: vessel.id,
            name: result.vesselName,
            origin: result.origin,
            destination: result.destination,
            distance: result.distance,
            duration: result.duration,
            routeName: result.routeName,
            capacity: vesselCapacity,
            utilization: actualUtilization,  // Use ACTUAL from API
            cargoLoaded: actualCargoLoaded,  // Use ACTUAL from API
            speed: result.speed,
            guards: result.guards,
            income: result.income,
            harborFee: result.harborFee,
            fuelUsed: result.fuelUsed,
            co2Used: result.co2Used,
            contributionGained: contributionGained,  // Individual contribution for this vessel
            departedAt,  // Timestamp when API confirmed departure
            // Include detailed cargo breakdown
            teuDry: result.teuDry,
            teuRefrigerated: result.teuRefrigerated,
            fuelCargo: result.fuelCargo,
            crudeCargo: result.crudeCargo,
            // Cargo rates from vessel prices
            dryRate: vessel.prices?.dry,
            refRate: vessel.prices?.refrigerated,
            fuelRate: vessel.prices?.fuel,
            crudeRate: vessel.prices?.crude_oil
          };
          departedVessels.push(vesselData);
          allDepartedVessels.push(vesselData);

          // Save all trip data for vessel history display
          // Use current timestamp (vessel_history created_at will match this closely)
          const timestamp = new Date(departedAt).toISOString().slice(0, 19).replace('T', ' ');
          await saveTripData(userId, vessel.id, timestamp, {
            harborFee: result.harborFee,
            contributionGained: contributionGained,
            speed: result.speed,
            guards: result.guards,
            co2Used: result.co2Used,
            fuelUsed: result.fuelUsed,
            capacity: vesselCapacity,
            utilization: actualUtilization,
            dryRate: vessel.prices?.dry,
            refRate: vessel.prices?.refrigerated,
            fuelRate: vessel.prices?.fuel,
            crudeRate: vessel.prices?.crude_oil
          });

        } catch (error) {
          logger.error(`[Depart] Failed to depart ${vessel.name}:`, error.message);
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: error.message || 'Unknown error'
          });
        }

        // Check if we've processed a chunk of vessels
        processedCount++;
        if (processedCount % CHUNK_SIZE === 0) {
          await sendBatchNotifications();
        }
      }
    }

    // Send final batch for any remaining vessels
    if (departedVessels.length > 0 || failedVessels.length > 0) {
      await sendBatchNotifications();
    }

    // Trigger rebuy and update data after departures
    if (processedCount > 0) {
      try {
        await autoRebuyAll();
      } catch (rebuyError) {
        logger.warn(`[Depart] Final auto-rebuy failed (non-critical): ${rebuyError.message}`);
      }
      try {
        await tryUpdateAllData();
      } catch (updateError) {
        logger.warn(`[Depart] Data update failed (non-critical): ${updateError.message}`);
      }
    }

    // CRITICAL: Send events in correct order:
    // 1. Bunker update (so UI shows correct fuel/co2/cash)
    // 2. Vessel count update (so badge shows correct counts)
    // 3. THEN depart complete (unlocks button)
    if (broadcastToUser && processedCount > 0) {
      let finalBunkerState = null;
      let updatedVessels = [];

      // Fetch final state - wrapped in try-catch to prevent lock from getting stuck
      try {
        finalBunkerState = await gameapi.fetchBunkerState();
      } catch (fetchError) {
        logger.warn(`[Depart] Failed to fetch final bunker state: ${fetchError.message}`);
        // Use last known bunker state
        finalBunkerState = state.getBunkerState(userId);
      }

      const finalTotalIncome = allDepartedVessels.reduce((sum, v) => sum + v.income, 0);
      const finalTotalFuelUsed = allDepartedVessels.reduce((sum, v) => sum + v.fuelUsed, 0);
      const finalTotalCO2Used = allDepartedVessels.reduce((sum, v) => sum + v.co2Used, 0);

      // 1. Send complete bunker update with all fields (fuel, co2, cash, maxFuel, maxCO2)
      if (finalBunkerState) {
        const { broadcastBunkerUpdate } = require('../websocket');
        broadcastBunkerUpdate(userId, finalBunkerState);
      }

      // 2. Broadcast updated vessel counts BEFORE unlocking button
      // This ensures badge updates BEFORE user can click button again
      try {
        updatedVessels = await gameapi.fetchVessels();
        const readyToDepart = updatedVessels.filter(v => v.status === 'port' && !v.is_parked).length;
        const atAnchor = updatedVessels.filter(v => v.status === 'anchor').length;
        const pending = updatedVessels.filter(v => v.status === 'pending').length;

        broadcastToUser(userId, 'vessel_count_update', {
          readyToDepart,
          atAnchor,
          pending
        });

        logger.debug(`[Depart] Vessel count broadcast: ${readyToDepart} ready, ${atAnchor} anchor, ${pending} pending`);
      } catch (fetchError) {
        logger.warn(`[Depart] Failed to fetch vessel counts: ${fetchError.message}`);
      }

      // 3. Send final completion event to unlock button (ONLY AFTER bunker and vessel count updates)
      // Release lock BEFORE sending complete event (prevents race condition)
      state.setLockStatus(userId, 'depart', false);

      broadcastToUser(userId, 'vessels_depart_complete', {
        succeeded: {
          count: allDepartedVessels.length,
          vessels: allDepartedVessels.slice(),
          totalIncome: finalTotalIncome,
          totalFuelUsed: finalTotalFuelUsed,
          totalCO2Used: finalTotalCO2Used
        },
        failed: {
          count: failedVessels.length,
          vessels: failedVessels
        },
        bunker: finalBunkerState ? {
          fuel: finalBunkerState.fuel,
          co2: finalBunkerState.co2
        } : null
      });

      // Send updated lock status
      broadcastToUser(userId, 'lock_status', {
        depart: false,
        fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
        co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
        repair: state.getLockStatus(userId, 'repair'),
        bulkBuy: state.getLockStatus(userId, 'bulkBuy')
      });

      logger.debug(`[Depart] ALL BATCHES COMPLETE - ${allDepartedVessels.length} total vessels departed - Button unlocked`);
    }

    // Calculate totals from ALL departed vessels (not just last batch)
    const totalRevenue = allDepartedVessels.reduce((sum, v) => sum + (v.income || 0), 0);
    const totalFuelUsed = allDepartedVessels.reduce((sum, v) => sum + (v.fuelUsed || 0), 0);
    const totalCO2Used = allDepartedVessels.reduce((sum, v) => sum + (v.co2Used || 0), 0);
    const totalHarborFees = allDepartedVessels.reduce((sum, v) => sum + (v.harborFee || 0), 0);

    // Calculate total contribution gained (only if tracking is enabled)
    let totalContributionGained = 0;
    if (trackContribution) {
      totalContributionGained = allDepartedVessels.reduce((sum, v) => sum + (v.contributionGained || 0), 0);

      // Output to console for debugging
      if (allDepartedVessels.length > 0 && totalContributionGained > 0) {
        const vesselsWithContribution = allDepartedVessels.filter(v => v.contributionGained !== null);
        console.log(`\n==================================================`);
        console.log(`Contribution for last ride: ${allDepartedVessels.length} vessels`);
        console.log(`Total gained: ${totalContributionGained}`);
        console.log(`Per vessel breakdown:`);
        vesselsWithContribution.forEach(v => {
          console.log(`  - ${v.name}: +${v.contributionGained}`);
        });
        console.log(`==================================================\n`);
      }
    }

    // Build result object - only include contribution fields if tracking is enabled
    // Combine any remaining failed vessels (from last batch) with allFailedVessels
    allFailedVessels.push(...failedVessels);
    const result = {
      success: true,
      departedCount: allDepartedVessels.length,
      failedCount: allFailedVessels.length,
      warningCount: allWarningVessels.length,
      highFeeCount: allHighFeeVessels.length,
      departedVessels: allDepartedVessels.slice(),
      failedVessels: allFailedVessels.slice(),
      warningVessels: allWarningVessels.slice(),
      highFeeVessels: allHighFeeVessels.slice(),
      totalRevenue,
      totalFuelUsed,
      totalCO2Used,
      totalHarborFees
    };

    // Only add contribution fields if user is in alliance and has data
    if (trackContribution && totalContributionGained > 0) {
      result.contributionGained = totalContributionGained;
      result.contributionPerVessel = totalContributionGained / allDepartedVessels.length;
    }

    // Notify user if ALL vessels failed (0 departed, some failed)
    if (broadcastToUser && allDepartedVessels.length === 0 && allFailedVessels.length > 0) {
      // Group failures by reason with vessel names
      const reasonGroups = {};
      allFailedVessels.forEach(v => {
        const reason = v.reason || 'Unknown';
        if (!reasonGroups[reason]) {
          reasonGroups[reason] = [];
        }
        // Strip MV/MS/MT prefix from vessel name
        const vesselName = (v.name || 'Unknown').replace(/^(MV|MS|MT)\s+/i, '');
        reasonGroups[reason].push(vesselName);
      });

      // Build reason summary with vessel names
      const reasonSummary = Object.entries(reasonGroups)
        .map(([reason, vessels]) => `<strong>${reason}:</strong><br>${vessels.join(', ')}`)
        .join('<br><br>');

      broadcastToUser(userId, 'notification', {
        type: 'error',
        message: `<p><strong>Cargo Marshal</strong></p><p>Failed to depart ${allFailedVessels.length} vessel${allFailedVessels.length > 1 ? 's' : ''}:</p><p style="font-size: 0.9em; color: #9ca3af;">${reasonSummary}</p>`
      });
    }

    return result;

  } catch (error) {
    logger.error('[Depart] Error:', error.message);

    // Release lock and notify clients on error
    state.setLockStatus(userId, 'depart', false);
    if (broadcastToUser) {
      broadcastToUser(userId, 'lock_status', {
        depart: false,
        fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
        co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
        repair: state.getLockStatus(userId, 'repair'),
        bulkBuy: state.getLockStatus(userId, 'bulkBuy')
      });
    }

    return { success: false, reason: 'error', error: error.message };
  } finally {
    // ALWAYS release lock, even if error occurred or early return
    state.setLockStatus(userId, 'depart', false);
    logger.debug('[Depart] Lock released');
  }
}

/**
 * Intelligent auto-depart wrapper for autopilot system.
 * Calls departVessels() with null vesselIds to depart ALL vessels in harbor.
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} autoRebuyAll - Function to trigger fuel/CO2 rebuy
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<void>}
 */
async function autoDepartVessels(autopilotPaused, broadcastToUser, autoRebuyAll, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.debug('[Auto-Depart] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);

  if (!settings.autoDepartAll) {
    logger.debug('[Auto-Depart] Feature disabled in settings');
    return;
  }

  logger.debug(`[Auto-Depart] Checking... ${settings.autoDepartAll ? 'ENABLED' : 'DISABLED'}`);

  try {
    // Call universal depart function with all vessels (vesselIds = null)
    const result = await departVessels(userId, null, broadcastToUser, autoRebuyAll, tryUpdateAllData);

    // Log success to autopilot logbook
    if (result.success && result.reason !== 'no_vessels' && result.departedCount > 0) {
      // Build summary - only include contribution if tracked
      const summary = result.contributionGained
        ? `${result.departedCount} vessels | +${formatCurrency(result.totalRevenue)} | +${result.contributionGained} contribution`
        : `${result.departedCount} vessels | +${formatCurrency(result.totalRevenue)}`;

      // Use earliest departedAt timestamp from all vessels (most accurate for matching)
      const actionTimestamp = result.departedVessels.reduce((earliest, v) => {
        return v.departedAt && v.departedAt < earliest ? v.departedAt : earliest;
      }, Date.now());

      // Build details - always include contribution (even if 0)
      const details = {
        actionTimestamp,
        vesselCount: result.departedCount,
        totalRevenue: result.totalRevenue,
        totalFuelUsed: result.totalFuelUsed,
        totalCO2Used: result.totalCO2Used,
        totalHarborFees: result.totalHarborFees,
        contributionGainedTotal: result.contributionGained ?? 0,
        departedVessels: result.departedVessels.map(v => ({
          ...v,
          harborFee: v.harborFee ? -Math.abs(v.harborFee) : 0
        }))
      };

      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Auto-Depart',
        summary,
        details,
        'SUCCESS',
        SOURCES.AUTOPILOT
      );
    }

    // Log warnings if any vessels had $0 revenue
    if (result.success && result.warningCount > 0) {
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Auto-Depart',
        `${result.warningCount} vessel${result.warningCount > 1 ? 's' : ''} with demand exhausted | $0 revenue`,
        {
          vesselCount: result.warningCount,
          warningVessels: result.warningVessels
        },
        'WARNING',
        SOURCES.AUTOPILOT
      );
    }

    // Log warnings if any vessels had excessive harbor fees
    if (result.success && result.highFeeCount > 0) {
      const totalHarborFees = result.highFeeVessels.reduce((sum, v) => sum + (v.harborFee || 0), 0);
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Auto-Depart',
        `${result.highFeeCount} vessel${result.highFeeCount > 1 ? 's' : ''} with excessive harbor fees | ${formatCurrency(totalHarborFees)} fees`,
        {
          vesselCount: result.highFeeCount,
          totalHarborFees: totalHarborFees,
          highFeeVessels: result.highFeeVessels
        },
        'WARNING',
        SOURCES.AUTOPILOT
      );
    }
  } catch (error) {
    logger.error('[Auto-Depart] Error:', error.message);

    // Log error to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.VESSEL,
      'Auto-Depart',
      `Departure failed: ${error.message}`,
      {
        error: error.message,
        stack: error.stack
      },
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  departVessels,
  autoDepartVessels,
  calculateRemainingDemand,
  getTotalCapacity
};
