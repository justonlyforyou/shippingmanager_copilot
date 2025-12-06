/**
 * @fileoverview Bunker Operations API Client Module
 *
 * This module handles all bunker-related API calls including:
 * - Fetching fuel and CO2 prices (with event discount handling)
 * - Getting bunker state (fuel, CO2, cash, capacity)
 * - Purchasing fuel and CO2 certificates
 * - Price bug detection and logging
 *
 * API Quirks:
 * - Prices use UTC time slots (00:00, 00:30, 01:00, etc.)
 * - Fuel/CO2 stored in kg but displayed in tons (1t = 1000kg)
 * - Purchase API doesn't return cost (must calculate ourselves)
 *
 * @requires ../utils/api - API helper functions
 * @requires ../utils/logger - Logging utility
 * @module server/gameapi/bunker
 */

const { apiCall, getUserId } = require('../utils/api');
const logger = require('../utils/logger');


/**
 * Fetches current fuel and CO2 prices from the game API.
 * Used by scheduler to update prices every 30 minutes.
 *
 * UTC Time Slot Matching:
 * - Prices change every 30 minutes (00:00, 00:30, 01:00, etc.)
 * - Must match current UTC time to correct slot
 * - Falls back to event prices if available during events
 *
 * Event Handling:
 * - API returns event_fuel_discount/event_co2_discount during events
 * - Discounted prices in discounted_fuel/discounted_co2 fields
 * - Event data includes percentage discount and type
 *
 * @async
 * @returns {Promise<Object>} Prices object: {fuel, co2, eventDiscount, eventData, regularFuel, regularCO2}
 * @throws {Error} If no valid price found for current time slot
 */
async function fetchPrices() {
  const data = await apiCall('/bunker/get-prices', 'POST', {});

  // API returns array of prices with timestamps
  // Structure: { data: { prices: [{fuel_price, co2_price, time, day}, ...] }, user: {...} }

  if (!data.data || !data.data.prices || data.data.prices.length === 0) {
    throw new Error('No prices found in API response');
  }

  const prices = data.data.prices;

  // API time slots are in UTC
  // Get current UTC time to find matching price
  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();

  // Between 00:00:00 and 00:29:59 UTC → search for "00:00"
  // Between 00:30:00 and 00:59:59 UTC → search for "00:30"
  const currentTime = `${String(utcHours).padStart(2, '0')}:${utcMinutes < 30 ? '00' : '30'}`;

  logger.debug(`[GameAPI] Searching for UTC time slot "${currentTime}" at ${now.toISOString()}`);
  logger.debug(`[GameAPI] Available time slots:`, prices.map(p => p.time).join(', '));

  // Find price matching current UTC time slot
  let currentPrice = prices.find(p => p.time === currentTime);

  // Check for event discounts
  const eventFuelDiscount = data.data.event_fuel_discount || null;
  const eventCO2Discount = data.data.event_co2_discount || null;
  const discountedFuel = data.data.discounted_fuel || null;
  const discountedCO2 = data.data.discounted_co2 || null;

  // Build eventDiscount object for compatibility
  let eventDiscount = null;
  if (eventFuelDiscount && discountedFuel) {
    eventDiscount = { percentage: eventFuelDiscount, type: 'fuel' };
  } else if (eventCO2Discount && discountedCO2) {
    eventDiscount = { percentage: eventCO2Discount, type: 'co2' };
  }

  // NO FALLBACK - If time slot not found and no event prices, THROW ERROR
  if (!currentPrice && (discountedFuel === null || discountedCO2 === null)) {
    logger.error(`[GameAPI] CRITICAL: Time slot not found in API response`);
    logger.error(`  Searched for: "${currentTime}"`);
    logger.error(`  Current time: ${now.toISOString()} (UTC: ${utcHours}:${utcMinutes})`);
    logger.error(`  Available slots: ${prices.map(p => p.time).join(', ')}`);
    logger.error(`  Event discounts: fuel=${discountedFuel}, co2=${discountedCO2}`);

    throw new Error(`Time slot "${currentTime}" not found in API response. Expected this slot to exist.`);
  }

  // Use discounted prices if available, otherwise use matched price
  const finalFuelPrice = discountedFuel !== null ? discountedFuel : currentPrice.fuel_price;
  const finalCO2Price = discountedCO2 !== null ? discountedCO2 : currentPrice.co2_price;

  // CRITICAL VALIDATION: If API returns invalid prices (0, null, undefined), throw error
  // This prevents broadcasting invalid prices to clients
  if (!finalFuelPrice || finalFuelPrice <= 0) {
    logger.error(`[GameAPI] API returned INVALID fuel price: ${finalFuelPrice} (discounted: ${discountedFuel}, regular: ${currentPrice.fuel_price})`);
    throw new Error(`Invalid fuel price from API: ${finalFuelPrice}`);
  }
  if (!finalCO2Price || finalCO2Price <= 0) {
    logger.error(`[GameAPI] API returned INVALID CO2 price: ${finalCO2Price} (discounted: ${discountedCO2}, regular: ${currentPrice.co2_price})`);
    throw new Error(`Invalid CO2 price from API: ${finalCO2Price}`);
  }

  if (eventDiscount) {
    logger.debug(`[GameAPI] EVENT ACTIVE: ${eventDiscount.percentage}% off ${eventDiscount.type}`);
    logger.debug(`[GameAPI] Current prices (${currentPrice.time}): Fuel=$${finalFuelPrice}/t${discountedFuel ? ` (was $${currentPrice.fuel_price})` : ''}, CO2=$${finalCO2Price}/t${discountedCO2 ? ` (was $${currentPrice.co2_price})` : ''}`);
  } else {
    logger.debug(`[GameAPI] Current prices (${currentPrice.time}): Fuel=$${finalFuelPrice}/t, CO2=$${finalCO2Price}/t`);
  }

  // Fetch full event data if there's an active event
  let eventData = null;
  if (eventDiscount) {
    try {
      // Import from util.js to get event data
      const { fetchEventData } = require('./util');
      eventData = await fetchEventData();
    } catch (error) {
      logger.warn('[GameAPI] Failed to fetch event data:', error.message);
    }
  }

  return {
    fuel: finalFuelPrice,
    co2: finalCO2Price,
    eventDiscount: eventDiscount,
    eventData: eventData, // Full event with time_start, time_end, etc.
    regularFuel: currentPrice.fuel_price,
    regularCO2: currentPrice.co2_price
  };
}

/**
 * Fetches current bunker state (fuel, CO2, cash, capacity).
 * Used by auto-rebuy to check if purchase is needed.
 *
 * CRITICAL API QUIRK:
 * - /bunker/get-prices does NOT return capacity fields (max_fuel, max_co2)
 * - Use /user/get-user-settings which includes settings.max_fuel/.max_co2
 * - This is much smaller than /game/index (no vessel/port data)
 *
 * Unit Conversions:
 * - API stores values in kilograms (kg)
 * - We convert to tons (t) for readability: 1t = 1000kg
 * - All internal logic uses tons, only API calls use kg
 *
 * @async
 * @returns {Promise<Object>} Bunker state with fuel, co2, cash, maxFuel, maxCO2 (all in tons except cash)
 * @throws {Error} If user_settings or capacity fields missing
 */
async function fetchBunkerState() {
  const MAX_RETRIES = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await apiCall('/user/get-user-settings', 'POST', {});
      const user = data.user;
      const settings = data.data.settings;

      if (!user) {
        logger.error('[GameAPI] ERROR: user object missing from API response!');
        throw new Error('user object missing from API');
      }

      if (!settings || !settings.max_fuel || !settings.max_co2) {
        logger.error('[GameAPI] ERROR: user_settings or capacity fields missing from API response!');
        throw new Error('user_settings or capacity fields missing from API');
      }

      // Check if fuel or co2 are missing - retry if so
      if (user.fuel === undefined || user.fuel === null ||
          user.co2 === undefined || user.co2 === null) {

        if (attempt < MAX_RETRIES) {
          logger.warn(`[GameAPI] Attempt ${attempt}/${MAX_RETRIES}: Missing fuel/co2 data (fuel=${user.fuel}, co2=${user.co2}), retrying in ${attempt * 500}ms...`);
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, attempt * 500));
          continue; // Try again
        } else {
          // Final attempt failed
          logger.error(`[GameAPI] ERROR: After ${MAX_RETRIES} attempts, still missing fuel/co2 data!`, {
            fuel: user.fuel,
            co2: user.co2,
            user: user
          });
          throw new Error(`Missing fuel/co2 data after ${MAX_RETRIES} attempts (fuel=${user.fuel}, co2=${user.co2})`);
        }
      }

      // Success! Data is valid
      const bunkerState = {
        fuel: user.fuel / 1000, // Convert kg to tons
        co2: user.co2 / 1000,
        cash: user.cash,
        points: user.points,
        maxFuel: settings.max_fuel / 1000,
        maxCO2: settings.max_co2 / 1000
      };

      if (attempt > 1) {
        logger.info(`[GameAPI] Bunker state fetched successfully on attempt ${attempt}`);
      }

      logger.debug(`[GameAPI] Bunker state: Fuel=${bunkerState.fuel.toFixed(1)}t/${bunkerState.maxFuel.toFixed(0)}t, CO2=${bunkerState.co2.toFixed(1)}t/${bunkerState.maxCO2.toFixed(0)}t, Cash=$${bunkerState.cash}, Points=${bunkerState.points}`);

      return bunkerState;

    } catch (error) {
      lastError = error;

      // If it's not a retryable situation, throw immediately
      if (attempt === MAX_RETRIES ||
          !error.message.includes('Missing fuel/co2')) {
        throw error;
      }
    }
  }

  // Should never reach here, but just in case
  throw lastError || new Error('Failed to fetch bunker state');
}

/**
 * Purchases specified amount of fuel.
 * Used by auto-rebuy feature.
 *
 * API Quirks:
 * - API expects amount in kilograms (kg), not tons
 * - This function accepts tons and converts to kg internally (amount * 1000)
 * - Response does NOT include updated capacity fields (max_fuel, max_co2)
 * - Response does NOT include purchase cost - we calculate it ourselves
 * - Purchase is INSTANT (no delay/cooldown in game API)
 *
 * Why Unit Conversion:
 * - Game UI displays tons (more readable: "500t" vs "500000kg")
 * - API internally uses kg for precision
 * - Conversion factor: 1 ton = 1000 kg (always integer math)
 *
 * @async
 * @param {number} amount - Amount in tons (integer)
 * @param {number|null} [pricePerTon=null] - Optional price override, fetches from state if null
 * @returns {Promise<Object>} Purchase result: {success, amount, newTotal, cost}
 * @throws {Error} If API call fails
 */
async function purchaseFuel(amount, pricePerTon = null, userId = null) {
  // API expects amount in kg, we work in tons - convert tons to kg
  const amountInKg = amount * 1000;

  logger.debug(`[GameAPI] purchaseFuel REQUEST: Sending ${amount}t (${amountInKg}kg) to API`);
  logger.debug(`[GameAPI] purchaseFuel REQUEST body:`, JSON.stringify({ amount: amountInKg }, null, 2));

  const data = await apiCall('/bunker/purchase-fuel', 'POST', { amount: amountInKg });

  logger.debug(`[GameAPI] purchaseFuel RESPONSE:`, JSON.stringify(data, null, 2));

  // Check if purchase was successful
  if (data.error || data.success === false) {
    const errorMsg = data.error || 'Purchase failed';
    if (data.user && data.user.cash !== undefined) {
      logger.info(`[GameAPI] Purchase FAILED with error "${errorMsg}" - API reports current cash: $${data.user.cash.toLocaleString()}`);
    }
    throw new Error(errorMsg);
  }

  // Calculate cost ourselves since API doesn't return it
  // If price not provided, get it from state
  let cost = 0;
  if (pricePerTon) {
    cost = amount * pricePerTon;
  } else {
    const state = require('../state');
    const actualUserId = userId || getUserId();
    const prices = state.getPrices(actualUserId);
    cost = amount * prices.fuel;
  }

  const result = {
    success: true,
    amount: amount, // Return amount in tons
    newTotal: data.user.fuel / 1000, // kg to tons
    cost: cost
  };
  logger.debug(`[GameAPI] Purchased ${amount}t fuel for $${result.cost}, new total: ${result.newTotal.toFixed(1)}t`);
  return result;
}

/**
 * Purchases specified amount of CO2 certificates.
 * Used by auto-rebuy feature.
 *
 * API Quirks:
 * - Same quirks as purchaseFuel (see above)
 * - API field name is 'co2' OR 'co2_certificate' depending on endpoint
 * - Always check both fields: data.user.co2 || data.user.co2_certificate
 *
 * @async
 * @param {number} amount - Amount in tons (integer)
 * @param {number|null} [pricePerTon=null] - Optional price override, fetches from state if null
 * @returns {Promise<Object>} Purchase result: {success, amount, newTotal, cost}
 * @throws {Error} If API call fails
 */
async function purchaseCO2(amount, pricePerTon = null, userId = null) {
  // API expects amount in kg, we work in tons - convert tons to kg
  const amountInKg = amount * 1000;
  const data = await apiCall('/bunker/purchase-co2', 'POST', { amount: amountInKg });

  logger.debug(`[GameAPI] purchaseCO2 API response:`, JSON.stringify(data, null, 2));

  // Check if purchase was successful
  if (data.error || data.success === false) {
    throw new Error(data.error || 'Purchase failed');
  }

  // Calculate cost ourselves since API doesn't return it
  // If price not provided, get it from state
  let cost = 0;
  if (pricePerTon) {
    cost = amount * pricePerTon;
  } else {
    const state = require('../state');
    const actualUserId = userId || getUserId();
    const prices = state.getPrices(actualUserId);
    cost = amount * prices.co2;
  }

  const result = {
    success: true,
    amount: amount, // Return amount in tons
    newTotal: (data.user.co2 || data.user.co2_certificate) / 1000, // kg to tons
    cost: cost
  };
  logger.debug(`[GameAPI] Purchased ${amount}t CO2 for $${result.cost}, new total: ${result.newTotal.toFixed(1)}t`);
  return result;
}

module.exports = {
  fetchPrices,
  fetchBunkerState,
  purchaseFuel,
  purchaseCO2
};