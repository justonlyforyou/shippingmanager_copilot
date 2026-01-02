/**
 * @fileoverview Atmosphere Broker - Auto-Rebuy CO2 Pilot
 *
 * Automatically purchases CO2 when price is below threshold and bunker has space.
 * NO COOLDOWNS - purchases immediately when conditions are met.
 *
 * @module server/autopilot/pilot_atmosphere_broker
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');
const { calculateCO2Consumption } = require('../utils/fuel-calculator');

/**
 * Auto-rebuy CO2 for a single user.
 * NO COOLDOWN - purchases whenever price is good and space available.
 *
 * Modes:
 * - Normal (intelligentRebuyCO2=false): Fill bunker when price <= threshold
 * - Intelligent (intelligentRebuyCO2=true): Buy for vessels OR refill when price <= intelligentMaxPrice
 *
 * @async
 * @param {Object|null} bunkerState - Optional pre-fetched bunker state to avoid duplicate API calls
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all header data
 * @returns {Promise<void>}
 */
async function autoRebuyCO2(bunkerState = null, autopilotPaused, broadcastToUser, tryUpdateAllData) {
  if (autopilotPaused) {
    logger.debug('[Atmosphere Broker] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoRebuyCO2) {
    logger.debug('[Atmosphere Broker] Feature disabled in settings');
    return;
  }

  try {
    const bunker = bunkerState || state.getBunkerState(userId);
    const prices = state.getPrices(userId);

    if (!prices.co2 || prices.co2 === 0) {
      logger.debug('[Atmosphere Broker] No price data available yet');
      return;
    }

    const minCash = settings.autoRebuyCO2MinCash;
    if (minCash === undefined || minCash === null) {
      logger.error('[Atmosphere Broker] ERROR: autoRebuyCO2MinCash setting is missing!');
      return;
    }

    const availableSpace = bunker.maxCO2 - bunker.co2;
    const cashAvailable = Math.max(0, bunker.cash - minCash);
    const maxAffordable = Math.floor(cashAvailable / prices.co2);

    let amountToBuy = 0;
    let isEmergencyBuy = false;
    let isIntelligentBuy = false;

    // Determine threshold for normal mode
    const threshold = settings.autoRebuyCO2UseAlert
      ? settings.co2Threshold
      : settings.autoRebuyCO2Threshold;

    // ========== NORMAL MODE: Price below threshold - fill bunker ==========
    if (prices.co2 <= threshold) {
      // Check for emergency buy first
      if (settings.autoRebuyCO2Emergency) {
        const emergencyBelowThreshold = settings.autoRebuyCO2EmergencyBelow;
        const emergencyShipsRequired = settings.autoRebuyCO2EmergencyShips;
        const emergencyMaxPrice = settings.autoRebuyCO2EmergencyMaxPrice;

        if (bunker.co2 < emergencyBelowThreshold) {
          const vessels = await gameapi.fetchVessels();
          const shipsAtPort = vessels.filter(v => v.status === 'port').length;

          if (shipsAtPort >= emergencyShipsRequired && prices.co2 <= emergencyMaxPrice) {
            isEmergencyBuy = true;
            logger.info(`[Atmosphere Broker] EMERGENCY: Bunker=${bunker.co2.toFixed(1)}t < ${emergencyBelowThreshold}t, ${shipsAtPort} ships at port`);
          }
        }
      }

      if (availableSpace < 0.5) {
        logger.debug('[Atmosphere Broker] Bunker full');
        return;
      }

      amountToBuy = Math.min(Math.ceil(availableSpace), maxAffordable);
      logger.debug(`[Atmosphere Broker] Normal: Price $${prices.co2}/t <= threshold $${threshold}/t - filling bunker`);

    // ========== INTELLIGENT MODE: Price above threshold but vessels need CO2 ==========
    } else if (settings.intelligentRebuyCO2) {
      const maxPrice = settings.intelligentRebuyCO2MaxPrice;

      if (prices.co2 > maxPrice) {
        logger.debug(`[Atmosphere Broker] Intelligent: Price $${prices.co2}/t > max $${maxPrice}/t - skipping`);
        return;
      }

      // Get vessels ready to depart and calculate CO2 needs
      const vessels = await gameapi.fetchVessels();
      const readyVessels = vessels.filter(v => v.status === 'port' && !v.is_parked && v.route_destination);

      let totalCO2Needed = 0;
      for (const vessel of readyVessels) {
        const distance = vessel.route_distance;
        if (!distance || distance <= 0) continue;

        const co2Needed = calculateCO2Consumption(vessel, distance) || 0;
        totalCO2Needed += co2Needed;
      }

      const shortfall = Math.ceil(totalCO2Needed - bunker.co2);

      if (shortfall > 0) {
        // Not enough CO2 for vessels - buy what's missing
        amountToBuy = Math.min(shortfall, Math.floor(availableSpace), maxAffordable);
        isIntelligentBuy = true;
        logger.info(`[Atmosphere Broker] Intelligent: Price $${prices.co2}/t > threshold $${threshold}/t but ${readyVessels.length} vessels need ${totalCO2Needed.toFixed(1)}t, bunker has ${bunker.co2.toFixed(1)}t (shortfall: ${shortfall}t)`);
      } else {
        // No shortfall - vessels have enough CO2
        logger.debug(`[Atmosphere Broker] Intelligent: No shortfall, ${readyVessels.length} vessels need ${totalCO2Needed.toFixed(1)}t, bunker has ${bunker.co2.toFixed(1)}t - skipping (price too high for refill)`);
        return;
      }

    // ========== NO MODE ACTIVE: Price too high ==========
    } else {
      logger.debug(`[Atmosphere Broker] Price $${prices.co2}/t > threshold $${threshold}/t and intelligent rebuy disabled - skipping`);
      return;
    }

    if (amountToBuy <= 0) {
      logger.debug('[Atmosphere Broker] Cannot buy: insufficient funds or space');
      return;
    }

    // Purchase CO2
    const result = await gameapi.purchaseCO2(amountToBuy, prices.co2);
    const actionTimestamp = Date.now();

    // Update bunker state
    bunker.co2 = result.newTotal;
    bunker.cash -= result.cost;
    state.updateBunkerState(userId, bunker);

    // Broadcast
    if (broadcastToUser) {
      broadcastToUser(userId, 'co2_purchased', {
        amount: amountToBuy,
        price: prices.co2,
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

    logger.info(`[Atmosphere Broker] Purchased ${amountToBuy}t @ $${prices.co2}/t = $${result.cost.toLocaleString()}`);

    // Audit log
    let logDescription;
    if (isEmergencyBuy) {
      logDescription = `EMERGENCY: ${amountToBuy}t @ ${formatCurrency(prices.co2)}/t | -${formatCurrency(result.cost)}`;
    } else if (isIntelligentBuy) {
      logDescription = `INTELLIGENT: ${amountToBuy}t @ ${formatCurrency(prices.co2)}/t | -${formatCurrency(result.cost)}`;
    } else {
      logDescription = `${amountToBuy}t @ ${formatCurrency(prices.co2)}/t | -${formatCurrency(result.cost)}`;
    }

    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-CO2',
      logDescription,
      {
        actionTimestamp,
        amount: amountToBuy,
        price: prices.co2,
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
    if (error.message === 'max_co2_reached' || error.message === 'bunker_full') {
      logger.debug('[Atmosphere Broker] Bunker already full');
      return;
    }

    logger.error('[Atmosphere Broker] Error:', error.message);

    const isExpectedError = error.message === 'not_enough_cash' || error.message === 'insufficient_funds';
    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-CO2',
      `Purchase failed: ${error.message}`,
      isExpectedError ? { error: error.message } : { error: error.message, stack: error.stack },
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoRebuyCO2
};
