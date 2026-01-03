/**
 * @fileoverview Barrel Boss - Auto-Rebuy Fuel Pilot
 *
 * Automatically purchases fuel when price is below threshold and bunker has space.
 * NO COOLDOWNS - purchases immediately when conditions are met.
 *
 * @module server/autopilot/pilot_barrel_boss
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');
const { calculateFuelConsumption } = require('../utils/fuel-calculator');

/**
 * Auto-rebuy fuel for a single user.
 * NO COOLDOWN - purchases whenever price is good and space available.
 *
 * Modes:
 * - Normal (intelligentRebuyFuel=false): Fill bunker when price <= threshold
 * - Intelligent (intelligentRebuyFuel=true): Buy for vessels OR refill when price <= intelligentMaxPrice
 *
 * @async
 * @param {Object|null} bunkerState - Optional pre-fetched bunker state to avoid duplicate API calls
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all header data
 * @returns {Promise<void>}
 */
async function autoRebuyFuel(bunkerState = null, autopilotPaused, broadcastToUser, tryUpdateAllData) {
  if (autopilotPaused) {
    logger.debug('[Barrel Boss] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoRebuyFuel) {
    logger.debug('[Barrel Boss] Feature disabled in settings');
    return;
  }

  try {
    const bunker = bunkerState || state.getBunkerState(userId);
    const prices = state.getPrices(userId);

    if (!prices.fuel || prices.fuel === 0) {
      logger.debug('[Barrel Boss] No price data available yet');
      return;
    }

    const minCash = settings.autoRebuyFuelMinCash;
    if (minCash === undefined || minCash === null) {
      logger.error('[Barrel Boss] ERROR: autoRebuyFuelMinCash setting is missing!');
      return;
    }

    const availableSpace = bunker.maxFuel - bunker.fuel;
    const cashAvailable = Math.max(0, bunker.cash - minCash);
    const maxAffordable = Math.floor(cashAvailable / prices.fuel);

    let amountToBuy = 0;
    let isEmergencyBuy = false;
    let isIntelligentBuy = false;

    // Determine threshold for normal mode
    const threshold = settings.autoRebuyFuelUseAlert
      ? settings.fuelThreshold
      : settings.autoRebuyFuelThreshold;

    // ========== EMERGENCY MODE: Check FIRST, independent of price threshold ==========
    if (settings.autoRebuyFuelEmergency) {
      const emergencyBelowThreshold = settings.autoRebuyFuelEmergencyBelow;
      const emergencyShipsRequired = settings.autoRebuyFuelEmergencyShips;
      const emergencyMaxPrice = settings.autoRebuyFuelEmergencyMaxPrice;

      if (bunker.fuel < emergencyBelowThreshold && prices.fuel <= emergencyMaxPrice) {
        const vessels = await gameapi.fetchVessels();
        const shipsAtPort = vessels.filter(v => v.status === 'port').length;

        if (shipsAtPort >= emergencyShipsRequired) {
          isEmergencyBuy = true;
          logger.info(`[Barrel Boss] EMERGENCY: Bunker=${bunker.fuel.toFixed(1)}t < ${emergencyBelowThreshold}t, ${shipsAtPort} ships at port, price $${prices.fuel}/t <= max $${emergencyMaxPrice}/t`);

          if (availableSpace < 0.5) {
            logger.debug('[Barrel Boss] Emergency: Bunker full');
            return;
          }

          amountToBuy = Math.min(Math.ceil(availableSpace), maxAffordable);
        }
      }
    }

    // ========== NORMAL MODE: Price below threshold - fill bunker ==========
    if (!isEmergencyBuy && prices.fuel <= threshold) {
      if (availableSpace < 0.5) {
        logger.debug('[Barrel Boss] Bunker full');
        return;
      }

      amountToBuy = Math.min(Math.ceil(availableSpace), maxAffordable);
      logger.debug(`[Barrel Boss] Normal: Price $${prices.fuel}/t <= threshold $${threshold}/t - filling bunker`);

    // ========== INTELLIGENT MODE: Price above threshold but vessels need fuel ==========
    } else if (!isEmergencyBuy && settings.intelligentRebuyFuel) {
      const maxPrice = settings.intelligentRebuyFuelMaxPrice;

      if (prices.fuel > maxPrice) {
        logger.debug(`[Barrel Boss] Intelligent: Price $${prices.fuel}/t > max $${maxPrice}/t - skipping`);
        return;
      }

      // Get vessels ready to depart and calculate fuel needs
      const vessels = await gameapi.fetchVessels();
      const readyVessels = vessels.filter(v => v.status === 'port' && !v.is_parked && v.route_destination);

      let totalFuelNeeded = 0;
      for (const vessel of readyVessels) {
        const distance = vessel.route_distance;
        if (!distance || distance <= 0) continue;

        const speed = vessel.route_speed || vessel.max_speed;
        let fuelNeeded = vessel.route_fuel_required || vessel.fuel_required;
        if (!fuelNeeded) {
          fuelNeeded = calculateFuelConsumption(vessel, distance, speed, userId);
        }
        if (fuelNeeded === null) fuelNeeded = 0;
        totalFuelNeeded += fuelNeeded;
      }

      const shortfall = Math.ceil(totalFuelNeeded - bunker.fuel);

      if (shortfall > 0) {
        // Not enough fuel for vessels - buy what's missing
        amountToBuy = Math.min(shortfall, Math.floor(availableSpace), maxAffordable);
        isIntelligentBuy = true;
        logger.info(`[Barrel Boss] Intelligent: Price $${prices.fuel}/t > threshold $${threshold}/t but ${readyVessels.length} vessels need ${totalFuelNeeded.toFixed(1)}t, bunker has ${bunker.fuel.toFixed(1)}t (shortfall: ${shortfall}t)`);
      } else {
        // No shortfall - vessels have enough fuel
        logger.debug(`[Barrel Boss] Intelligent: No shortfall, ${readyVessels.length} vessels need ${totalFuelNeeded.toFixed(1)}t, bunker has ${bunker.fuel.toFixed(1)}t - skipping (price too high for refill)`);
        return;
      }

    // ========== NO MODE ACTIVE: Price too high ==========
    } else if (!isEmergencyBuy) {
      logger.debug(`[Barrel Boss] Price $${prices.fuel}/t > threshold $${threshold}/t and intelligent rebuy disabled - skipping`);
      return;
    }

    if (amountToBuy <= 0) {
      logger.debug('[Barrel Boss] Cannot buy: insufficient funds or space');
      return;
    }

    // Purchase fuel
    const result = await gameapi.purchaseFuel(amountToBuy, prices.fuel);
    const actionTimestamp = Date.now();

    // Update bunker state
    bunker.fuel = result.newTotal;
    bunker.cash -= result.cost;
    state.updateBunkerState(userId, bunker);

    // Broadcast
    if (broadcastToUser) {
      broadcastToUser(userId, 'fuel_purchased', {
        amount: amountToBuy,
        price: prices.fuel,
        newTotal: result.newTotal,
        cost: result.cost,
        isEmergency: isEmergencyBuy,
        isIntelligent: isIntelligentBuy
      });

      broadcastToUser(userId, 'bunker_update', {
        fuel: bunker.fuel,
        co2: bunker.co2,
        cash: bunker.cash,
        maxFuel: bunker.maxFuel,
        maxCO2: bunker.maxCO2
      });
    }

    logger.info(`[Barrel Boss] Purchased ${amountToBuy}t @ $${prices.fuel}/t = $${result.cost.toLocaleString()}`);

    // Audit log
    let logDescription;
    if (isEmergencyBuy) {
      logDescription = `EMERGENCY: ${amountToBuy}t @ ${formatCurrency(prices.fuel)}/t | -${formatCurrency(result.cost)}`;
    } else if (isIntelligentBuy) {
      logDescription = `INTELLIGENT: ${amountToBuy}t @ ${formatCurrency(prices.fuel)}/t | -${formatCurrency(result.cost)}`;
    } else {
      logDescription = `${amountToBuy}t @ ${formatCurrency(prices.fuel)}/t | -${formatCurrency(result.cost)}`;
    }

    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-Fuel',
      logDescription,
      {
        actionTimestamp,
        amount: amountToBuy,
        price: prices.fuel,
        totalCost: result.cost,
        newTotal: result.newTotal,
        isEmergency: isEmergencyBuy,
        isIntelligent: isIntelligentBuy
      },
      'SUCCESS',
      SOURCES.AUTOPILOT
    );

    if (tryUpdateAllData) {
      await tryUpdateAllData();
    }

  } catch (error) {
    // Ignore "bunker full" errors
    if (error.message === 'max_fuel_reached' || error.message === 'bunker_full') {
      logger.debug('[Barrel Boss] Bunker already full');
      return;
    }

    logger.error('[Barrel Boss] Error:', error.message);

    const isExpectedError = error.message === 'not_enough_cash' || error.message === 'insufficient_funds';
    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-Fuel',
      `Purchase failed: ${error.message}`,
      isExpectedError ? { error: error.message } : { error: error.message, stack: error.stack },
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoRebuyFuel
};
