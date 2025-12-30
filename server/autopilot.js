/**
 * @fileoverview Autopilot Service - Main Orchestrator
 *
 * Centralized autopilot logic running on the backend.
 * Coordinates all pilot modules and manages shared state.
 *
 * Key Features:
 * - Price updates at fixed times (:01 and :31 every hour)
 * - Orchestrates 8 specialized pilot modules
 * - Badge updates (repair count, campaigns, hijacking)
 * - Main event loop coordination
 *
 * @module server/autopilot
 */

const gameapi = require('./gameapi');
const state = require('./state');
const cache = require('./cache');
const { getUserId, apiCall, checkAndUpdateAllianceId } = require('./utils/api');
const logger = require('./utils/logger');

// Import pilot modules
const { autoRebuyFuel } = require('./autopilot/pilot_barrel_boss');
const { autoRebuyCO2 } = require('./autopilot/pilot_atmosphere_broker');
const { departVessels, autoDepartVessels, calculateRemainingDemand, getTotalCapacity } = require('./autopilot/pilot_cargo_marshal');
const { autoRepairVessels } = require('./autopilot/pilot_yard_foreman');
const { autoDrydockVessels } = require('./autopilot/pilot_drydock_master');
const { autoCampaignRenewal } = require('./autopilot/pilot_reputation_chief');
const { autoCoop } = require('./autopilot/pilot_fair_hand');
const { autoAnchorPointPurchase, setBroadcastFunction: setHarbormasterBroadcast } = require('./autopilot/pilot_harbormaster');
const { vesselHistoryStore } = require('./database/store-adapter');
const { migrateHijackHistoryFromJson } = require('./database');
const { autoNegotiateHijacking } = require('./autopilot/pilot_captain_blackbeard');
const { autoBuyStock, autoSellStock } = require('./autopilot/pilot_the_purser');
const { manageStaffMorale } = require('./autopilot/pilot_staff_captain');
const { sendPriceAlert } = require('./utils/telegram');
const { saveSettings } = require('./settings-schema');

// WebSocket broadcasting function (injected by websocket.js)
let broadcastToUser = null;

/**
 * Fetches /game/index with global caching (10s TTL) to reduce duplicate API calls.
 * Uses cache module for shared cache across all modules.
 */
async function getGameIndexCached() {
  const cached = cache.getGameIndexCache();
  if (cached) {
    return cached;
  }

  const response = await apiCall('/game/index', 'POST', {});
  cache.setGameIndexCache(response);
  return response;
}

/**
 * Injects WebSocket broadcasting function.
 * Called by websocket.js during initialization.
 */
function setBroadcastFunction(broadcastFn) {
  broadcastToUser = broadcastFn;
  logger.debug('[Autopilot] Broadcast function set:', broadcastFn ? 'OK' : 'NULL');

  // Also inject into pilot modules that manage their own broadcast function
  setHarbormasterBroadcast(broadcastFn);
}

// Global pause state
let autopilotPaused = false;

/**
 * Initializes autopilot pause state from persistent settings.
 * Called once during server startup in scheduler.js
 */
function initializeAutopilotState(userId) {
  const settings = state.getSettings(userId);
  if (settings && typeof settings.autopilotPaused === 'boolean') {
    autopilotPaused = settings.autopilotPaused;
    logger.info(`[Autopilot] Loaded pause state from settings: ${autopilotPaused ? 'PAUSED' : 'RUNNING'}`);
  } else {
    logger.info('[Autopilot] No saved pause state, defaulting to RUNNING');
  }

  // Migrate hijack history from JSON files to SQLite (one-time migration)
  try {
    const migrationResults = migrateHijackHistoryFromJson(userId);
    if (migrationResults.migrated > 0 || migrationResults.deleted > 0) {
      logger.info(`[Autopilot] Hijack history migration: ${migrationResults.migrated} migrated, ${migrationResults.deleted} JSON files deleted`);
    }
  } catch (err) {
    logger.error('[Autopilot] Failed to migrate hijack history from JSON:', err.message);
  }

  // Start vessel history slow sync (initial full sync, then ~2 calls/min rotation)
  vesselHistoryStore.startAutoSync(userId)
    .then(() => {
      logger.info('[Autopilot] Vessel history auto-sync started successfully');
    })
    .catch(err => {
      logger.error('[Autopilot] Failed to start vessel history auto-sync:', err.message);
    });
}

/**
 * Pauses all autopilot functions globally and saves state to settings
 */
async function pauseAutopilot() {
  autopilotPaused = true;
  logger.info('[Autopilot] PAUSED - All autopilot functions suspended');
  logger.info(`[Autopilot] Global pause variable set to: ${autopilotPaused}`);

  try {
    const userId = getUserId();
    if (userId) {
      const settings = state.getSettings(userId);
      settings.autopilotPaused = true;

      const { getSettingsFilePath } = require('./settings-schema');
      const fsPromises = require('fs').promises;
      const settingsFile = getSettingsFilePath(userId);
      await fsPromises.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
      logger.debug('[Autopilot] Pause state saved to settings');
    }
  } catch (error) {
    logger.error('[Autopilot] Failed to save pause state:', error);
  }
}

/**
 * Resumes all autopilot functions globally and saves state to settings
 */
async function resumeAutopilot() {
  autopilotPaused = false;
  logger.info('[Autopilot] RESUMED - All autopilot functions active');
  logger.info(`[Autopilot] Global pause variable set to: ${autopilotPaused}`);

  try {
    const userId = getUserId();
    if (userId) {
      const settings = state.getSettings(userId);
      settings.autopilotPaused = false;

      const { getSettingsFilePath } = require('./settings-schema');
      const fsPromises = require('fs').promises;
      const settingsFile = getSettingsFilePath(userId);
      await fsPromises.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
      logger.debug('[Autopilot] Resume state saved to settings');
    }
  } catch (error) {
    logger.error('[Autopilot] Failed to save resume state:', error);
  }
}

/**
 * Returns current autopilot pause state
 */
function isAutopilotPaused() {
  return autopilotPaused;
}

// ============================================================================
// Price Updates & Alerts
// ============================================================================

/**
 * Updates fuel and CO2 prices from API and broadcasts to all users.
 * Called by scheduler at :01 and :31 every hour (twice per hour).
 */
async function updatePrices() {
  try {
    const prices = await gameapi.fetchPrices();

    const userId = getUserId();
    if (!userId) return;

    // Update state with individual price values
    state.updatePrices(userId, prices.fuel, prices.co2, prices.eventDiscount, prices.regularFuel, prices.regularCO2);

    if (broadcastToUser) {
      broadcastToUser(userId, 'price_update', prices);
    }

    await checkPriceAlerts(userId, prices);

    // Telegram alerts for green prices
    await checkTelegramPriceAlerts(userId, prices);

  } catch (error) {
    logger.error('[Prices] Failed to update prices:', error.message);
  }
}

/**
 * Sends Telegram alerts when prices are in the green zone.
 * Uses cooldown to prevent spam (1 hour between alerts).
 * IMPORTANT: Uses regular prices (not discounted) so alerts are consistent for all users.
 */
async function checkTelegramPriceAlerts(userId, prices) {
  try {
    const settings = state.getSettings(userId);
    if (!settings || !settings.telegramAlertEnabled) return;
    if (!prices || !prices.fuel || !prices.co2) return;

    // Reset cooldowns at :01 and :31 (when prices change)
    // This allows alerts for both fuel AND co2 at each price change
    const now = new Date();
    const minutes = now.getMinutes();
    if (minutes === 1 || minutes === 31) {
      settings.telegramLastFuelAlert = 0;
      settings.telegramLastCO2Alert = 0;
      logger.debug('[Telegram] Cooldowns reset for new price slot');
    }

    // Use REGULAR prices (not discounted) for Telegram alerts
    // This ensures alerts show prices that are valid for ALL users, not just personal discounts
    const fuelPrice = prices.regularFuel || prices.fuel;
    const co2Price = prices.regularCO2 || prices.co2;

    // Callback to update cooldown timestamps in settings
    const updateSettings = async (updates) => {
      const newSettings = { ...settings, ...updates };
      state.updateSettings(userId, newSettings);
      await saveSettings(userId, newSettings);
    };

    const result = await sendPriceAlert(settings, fuelPrice, co2Price, updateSettings);

    if (result.sent) {
      logger.info(`[Telegram] Price alert sent (${result.type}): Fuel=$${fuelPrice}, CO2=$${co2Price}`);
    }
  } catch (error) {
    logger.error('[Telegram] Failed to check price alerts:', error.message);
  }
}

/**
 * Checks if current prices trigger user-configured alerts.
 */
async function checkPriceAlerts(userId, prices) {
  const settings = state.getSettings(userId);
  if (!settings) return;
  if (!prices) return;

  const alerts = [];

  if (prices.fuel && settings.fuelThreshold && prices.fuel <= settings.fuelThreshold) {
    alerts.push({
      type: 'fuel',
      price: prices.fuel,
      threshold: settings.fuelThreshold
    });
  }

  if (prices.co2 && settings.co2Threshold && prices.co2 <= settings.co2Threshold) {
    alerts.push({
      type: 'co2',
      price: prices.co2,
      threshold: settings.co2Threshold
    });
  }

  if (alerts.length > 0 && broadcastToUser) {
    broadcastToUser(userId, 'price_alerts', alerts);
  }
}

// ============================================================================
// Auto-Rebuy Orchestration
// ============================================================================

/**
 * Wrapper to rebuy both fuel and CO2.
 * Called after vessel departures and in main loop.
 */
async function autoRebuyAll() {
  const userId = getUserId();
  if (!userId) return;

  try {
    const bunker = await gameapi.fetchBunkerState();

    await autoRebuyFuel(bunker, autopilotPaused, broadcastToUser, tryUpdateAllData);
    await autoRebuyCO2(bunker, autopilotPaused, broadcastToUser, tryUpdateAllData);

  } catch (error) {
    logger.error('[Auto-Rebuy All] Error:', error.message);
  }
}

// ============================================================================
// Badge Updates
// ============================================================================

/**
 * Updates repair count badge
 */
async function updateRepairCount() {
  const userId = getUserId();
  if (!userId) return;

  try {
    const settings = state.getSettings(userId);
    const threshold = settings.maintenanceThreshold;

    const vessels = await gameapi.fetchVessels();
    if (!vessels || vessels.length === 0) {
      logger.warn('[Header] Repair count update skipped - no vessel data from API');
      return;
    }

    const repairCount = vessels.filter(v =>
      v.status === 'port' && !v.is_parked && v.maintenance < threshold
    ).length;

    // Cache the count for reconnecting clients
    state.updateRepairCount(userId, repairCount);

    if (broadcastToUser) {
      broadcastToUser(userId, 'repair_count_update', {
        count: repairCount
      });
    }
  } catch (error) {
    logger.error('[Header] Failed to update repair count:', error.message);
  }
}

/**
 * Updates drydock count badge
 */
async function updateDrydockCount() {
  const userId = getUserId();
  if (!userId) return;

  try {
    const settings = state.getSettings(userId);
    const threshold = settings.autoDrydockThreshold;

    const vessels = await gameapi.fetchVessels();
    if (!vessels || vessels.length === 0) {
      logger.warn('[Header] Drydock count update skipped - no vessel data from API');
      return;
    }

    const drydockCount = vessels.filter(v => {
      const hoursUntilCheck = v.hours_until_check !== undefined ? v.hours_until_check : 999;
      const alreadyScheduled = v.next_route_is_maintenance === true;
      return v.status === 'port' && !v.is_parked && hoursUntilCheck <= threshold && !alreadyScheduled;
    }).length;

    // Cache the count for reconnecting clients
    state.updateDrydockCount(userId, drydockCount);

    if (broadcastToUser) {
      broadcastToUser(userId, 'drydock_count_update', {
        count: drydockCount
      });
    }
  } catch (error) {
    logger.error('[Header] Failed to update drydock count:', error.message);
  }
}

/**
 * Updates campaign status and triggers auto-renewal if needed.
 * EVENT-DRIVEN: Triggers auto-renewal immediately when active campaigns < 3.
 */
async function updateCampaigns() {
  logger.debug(`[Auto-Campaign] updateCampaigns() called`);
  const userId = getUserId();
  if (!userId) {
    logger.debug(`[Auto-Campaign] updateCampaigns() - No userId, returning early`);
    return;
  }

  try {
    const campaigns = await gameapi.fetchCampaigns();
    const activeCount = countActiveCampaignTypes(campaigns);

    logger.debug(`[Auto-Campaign] updateCampaigns() - Active count: ${activeCount}, Total active: ${(campaigns.active || []).length}`);
    logger.debug(`[Auto-Campaign] Active campaigns: ${JSON.stringify((campaigns.active || []).map(c => ({ name: c.name, type: c.option_name })))}`);

    if (broadcastToUser) {
      broadcastToUser(userId, 'campaign_status_update', {
        activeCount: activeCount,
        active: campaigns.active
      });
    }

    // EVENT-DRIVEN: Auto-renew immediately when campaigns drop below 3
    const settings = state.getSettings(userId);
    logger.debug(`[Auto-Campaign] autoCampaignRenewal setting: ${settings.autoCampaignRenewal}, activeCount < 3: ${activeCount < 3}`);
    if (settings.autoCampaignRenewal && activeCount < 3) {
      logger.info(`[Auto-Campaign] EVENT TRIGGERED: ${activeCount}/3 campaigns active, starting renewal`);
      await autoCampaignRenewal(campaigns, autopilotPaused, broadcastToUser, tryUpdateAllData);
    }
  } catch (error) {
    logger.error('[Header] Failed to update campaigns:', error.message);
  }
}

/**
 * Updates unread message count (DISABLED - now handled by WebSocket polling)
 */
async function updateUnreadMessages() {
  // DISABLED: Messenger polling now handled by 10-second WebSocket interval
  return;
}

/**
 * Updates vessel count badges
 */
async function updateVesselCount() {
  const userId = getUserId();
  if (!userId) return;

  try {
    const vessels = await gameapi.fetchVessels();

    const readyToDepart = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
    const atAnchor = vessels.filter(v => v.status === 'anchor').length;
    const pending = vessels.filter(v => v.status === 'pending').length;

    if (broadcastToUser) {
      broadcastToUser(userId, 'vessel_count_update', {
        readyToDepart,
        atAnchor,
        pending
      });
    }
  } catch (error) {
    logger.error('[Header] Failed to update vessel count:', error.message);
  }
}

// ============================================================================
// All Data Update (Game State)
// ============================================================================

let updateAllDataLock = false;

/**
 * Fetches complete game state and broadcasts to all users.
 * Updates: bunker, prices, coop, stock, anchor, events, hijacking.
 */
async function updateAllData() {
  if (updateAllDataLock) {
    logger.debug('[UpdateAll] Skipping - already in progress (locked)');
    return;
  }

  updateAllDataLock = true;

  try {
    const userId = getUserId();
    if (!userId) {
      updateAllDataLock = false;
      return;
    }

    logger.debug('[UpdateAll] Starting complete data fetch...');

    // Fetch all data (with 30-second cache to avoid duplicate calls)
    const gameIndexData = await getGameIndexCached();
    const user = gameIndexData.user;
    const gameSettings = gameIndexData.data.user_settings;
    const vessels = gameIndexData.data.user_vessels;
    const eventArray = gameIndexData.data.event || [];

    // Extract event data if available
    const eventData = eventArray.length > 0 ? eventArray[0] : null;

    // Additional API calls for data not in /game/index
    const [coopData, allianceData, campaigns] = await Promise.all([
      fetchCoopDataCached(),
      fetchAllianceDataCached(),
      gameapi.fetchCampaigns()
    ]);

    // Add coop_boost from alliance data
    if (allianceData.data?.alliance?.benefit?.coop_boost && coopData.data?.coop) {
      coopData.data.coop.coop_boost = allianceData.data.alliance.benefit.coop_boost;
    }

    // Update bunker state - only if data is valid
    if (!user || user.fuel === undefined || user.co2 === undefined || user.cash === undefined) {
      logger.warn('[UpdateAll] Bunker update skipped - invalid API response (user data missing)');
    } else if (!gameSettings || !gameSettings.max_fuel || !gameSettings.max_co2) {
      logger.warn('[UpdateAll] Bunker update skipped - invalid API response (game settings missing)');
    } else {
      const newMaxFuel = gameSettings.max_fuel / 1000;
      const newMaxCO2 = gameSettings.max_co2 / 1000;

      const bunkerUpdate = {
        fuel: user.fuel / 1000,        // Convert kg to tons
        co2: user.co2 / 1000,          // Convert kg to tons
        cash: user.cash,
        points: user.points,
        maxFuel: newMaxFuel,
        maxCO2: newMaxCO2
      };
      state.updateBunkerState(userId, bunkerUpdate);

      if (broadcastToUser) {
        const { broadcastBunkerUpdate } = require('./websocket');
        broadcastBunkerUpdate(userId, bunkerUpdate);

        // Broadcast company_type for vessel purchase restrictions
        if (user.company_type) {
          broadcastToUser(userId, 'company_type_update', {
            company_type: user.company_type
          });
        }

        // Broadcast staff training points for level-ups
        if (user.staff_training_points !== undefined) {
          broadcastToUser(userId, 'staff_training_points_update', {
            staff_training_points: user.staff_training_points,
            ceo_level: user.ceo_level,
            experience_points: user.experience_points,
            levelup_experience_points: user.levelup_experience_points
          });
        }
      }
    }

    // Update COOP data
    if (coopData.data?.coop && allianceData.data?.alliance) {
      const coop = coopData.data.coop;
      const coopUpdate = {
        available: coop.available,
        cap: coop.cap,
        coop_boost: coop.coop_boost
      };
      state.updateCoopData(userId, coopUpdate);

      if (broadcastToUser) {
        broadcastToUser(userId, 'coop_update', coopUpdate);
      }
    }

    // Update stock and anchor data - only if data is valid
    if (user && gameSettings && gameSettings.anchor_points !== undefined && vessels) {
      const stockValue = user.stock_value;
      const stockTrend = user.stock_trend;
      const ipo = user.ipo;
      const maxAnchorPoints = gameSettings.anchor_points;
      const deliveredVessels = vessels.filter(v => v.status !== 'pending').length;
      const pendingVessels = vessels.filter(v => v.status === 'pending').length;
      const availableCapacity = maxAnchorPoints - deliveredVessels - pendingVessels;

      const anchorNextBuild = gameSettings.anchor_next_build || null;
      const now = Math.floor(Date.now() / 1000);
      // Get pending count from settings (stored during purchase)
      const settings = state.getSettings(userId);
      const pendingAnchorPoints = (anchorNextBuild && anchorNextBuild > now) ? settings.pendingAnchorPoints : 0;

      const headerUpdate = {
        stock: { value: stockValue, trend: stockTrend, ipo },
        anchor: {
          available: availableCapacity,
          max: maxAnchorPoints,
          pending: pendingAnchorPoints,
          nextBuild: anchorNextBuild
        }
      };
      state.updateHeaderData(userId, headerUpdate);

      if (broadcastToUser) {
        broadcastToUser(userId, 'header_data_update', headerUpdate);
      }
    } else {
      logger.warn('[UpdateAll] Header update skipped - invalid API response');
    }

    // Update event data
    logger.debug('[UpdateAll] Event data:', eventData ? `Found event: ${eventData.name}` : 'No active event');
    if (eventData) {
      state.updateEventData(userId, eventData);
      if (broadcastToUser) {
        broadcastToUser(userId, 'event_data_update', eventData);
      }
    }

    // Update campaign badge
    const activeCount = countActiveCampaignTypes(campaigns);
    if (broadcastToUser) {
      broadcastToUser(userId, 'campaign_status_update', {
        activeCount: activeCount,
        active: campaigns.active
      });
    }

    // Update vessel counts (triggers Harbor Map refresh if open)
    // Only update if vessels data is valid
    if (vessels && vessels.length > 0) {
      const readyToDepart = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
      const atAnchor = vessels.filter(v => v.status === 'anchor').length;
      const pending = vessels.filter(v => v.status === 'pending').length;

      const vesselCountUpdate = {
        readyToDepart,
        atAnchor,
        pending,
        total: vessels.length
      };
      state.updateVesselCounts(userId, vesselCountUpdate);

      if (broadcastToUser) {
        broadcastToUser(userId, 'vessel_count_update', vesselCountUpdate);
      }
    } else {
      logger.warn('[UpdateAll] Vessel count update skipped - no vessel data from API');
    }

    // Send completion event
    if (broadcastToUser) {
      broadcastToUser(userId, 'all_data_updated', { timestamp: Date.now() });
    }

    logger.debug('[UpdateAll] All data broadcasted successfully');

  } catch (error) {
    logger.error('[UpdateAll] Failed to fetch all data:', error.message);
  } finally {
    updateAllDataLock = false;
  }
}

/**
 * Wrapper for updateAllData() that skips if locked.
 * Used by pilots to avoid blocking when update is already in progress.
 */
async function tryUpdateAllData() {
  if (updateAllDataLock) {
    logger.debug('[UpdateAll] Skipping tryUpdateAllData - locked');
    return;
  }
  await updateAllData();
}

/**
 * Analyze vessels and determine which should depart based on profitability.
 * Shared logic used by BOTH manual and auto departure.
 */
async function analyzeVesselDepartures(allVessels, assignedPorts, settings) {
  const harbourVessels = allVessels.filter(v => v.status === 'port' && !v.is_parked);
  const toDepart = [];
  const toSkip = [];

  const vesselsByDestinationAndType = {};

  for (const vessel of harbourVessels) {
    if (!vessel.route_destination) {
      toSkip.push({
        vessel,
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

  for (const key in vesselsByDestinationAndType) {
    const vessels = vesselsByDestinationAndType[key];
    const firstVessel = vessels[0];
    const vesselType = firstVessel.capacity_type;

    let destination;
    if (firstVessel.route_destination === firstVessel.current_port_code) {
      destination = firstVessel.route_origin;
    } else {
      destination = firstVessel.route_destination;
    }

    const port = assignedPorts.find(p => p.code === destination);
    if (!port) {
      vessels.forEach(v => toSkip.push({
        vessel: v,
        reason: `Port ${destination} not in assigned ports`
      }));
      continue;
    }

    const remainingDemand = calculateRemainingDemand(port, vesselType);

    if (remainingDemand <= 0) {
      vessels.forEach(v => toSkip.push({
        vessel: v,
        reason: `No demand at ${destination}`
      }));
      continue;
    }

    const sortedVessels = vessels.sort((a, b) => getTotalCapacity(b) - getTotalCapacity(a));

    for (const vessel of sortedVessels) {
      const vesselCapacity = getTotalCapacity(vessel);

      if (remainingDemand <= 0) {
        toSkip.push({
          vessel,
          reason: `No demand at ${destination}`
        });
        continue;
      }

      const cargoToLoad = Math.min(remainingDemand, vesselCapacity);
      const utilizationRate = vesselCapacity > 0 ? cargoToLoad / vesselCapacity : 0;
      const minUtilization = settings.minCargoUtilization / 100;

      if (utilizationRate < minUtilization) {
        toSkip.push({
          vessel,
          reason: `Low utilization (${(utilizationRate * 100).toFixed(0)}% < ${settings.minCargoUtilization}% min)`
        });
        continue;
      }

      toDepart.push({
        vessel,
        destination,
        cargoToLoad,
        utilizationRate,
        remainingDemand
      });
    }
  }

  return { toDepart, toSkip };
}

// ============================================================================
// Cached Data Helpers
// ============================================================================

async function fetchCoopDataCached() {
  const cached = cache.getCoopCache();
  if (cached) {
    return cached;
  }

  const data = await apiCall('/coop/get-coop-data', 'POST', {});
  cache.setCoopCache(data);
  return data;
}

async function fetchAllianceDataCached() {
  const cached = cache.getAllianceCache();
  if (cached) {
    return cached;
  }

  const data = await apiCall('/alliance/get-user-alliance', 'POST', {});
  cache.setAllianceCache(data);
  return data;
}

// ============================================================================
// Capacity Helper (for exports)
// ============================================================================

function getCachedCapacity(vessel) {
  return getTotalCapacity(vessel);
}

// ============================================================================
// Main Event Loop
// ============================================================================

const LOOP_INTERVAL_FAST = 60000;  // 60 seconds - fast operations
const LOOP_INTERVAL_SLOW = 5 * 60 * 1000;  // 5 minutes - slow operations

/**
 * Fast autopilot loop (60 seconds).
 * Handles time-sensitive operations: bunker, vessels, repairs, drydock, hijacking.
 */
async function fastEventLoop() {
  const userId = getUserId();
  if (!userId) {
    setTimeout(fastEventLoop, LOOP_INTERVAL_FAST);
    return;
  }

  const settings = state.getSettings(userId);
  if (!settings) {
    setTimeout(fastEventLoop, LOOP_INTERVAL_FAST);
    return;
  }

  try {
    // Validate data
    const prices = state.getPrices(userId);
    const bunker = state.getBunkerState(userId);

    if (!prices || prices.fuel <= 0 || prices.co2 <= 0) {
      logger.warn('[Fast Loop] Skipping - prices not loaded yet (fuel: $' + (prices?.fuel || 0) + ', co2: $' + (prices?.co2 || 0) + ')');
      setTimeout(fastEventLoop, LOOP_INTERVAL_FAST);
      return;
    }

    if (!bunker || bunker.cash === undefined || bunker.points === undefined) {
      logger.warn('[Fast Loop] Skipping - bunker data not loaded yet');
      setTimeout(fastEventLoop, LOOP_INTERVAL_FAST);
      return;
    }

    // Check for alliance changes (user may have switched alliances)
    await checkAndUpdateAllianceId();

    // Fetch vessel data for badges (with 30-second cache to avoid duplicate calls)
    const gameIndexData = await getGameIndexCached();
    const vessels = gameIndexData.data.user_vessels;

    const readyToDepart = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
    const atAnchor = vessels.filter(v => v.status === 'anchor').length;
    const pending = vessels.filter(v => v.status === 'pending').length;

    // Update state cache (so reconnecting clients get correct data)
    state.updateVesselCounts(userId, { readyToDepart, atAnchor, pending, total: vessels.length });

    // Always update vessel count badges
    if (broadcastToUser) {
      broadcastToUser(userId, 'vessel_count_update', {
        readyToDepart,
        atAnchor,
        pending,
        total: vessels.length
      });
    }

    // Update repair and drydock count badges
    await updateRepairCount();
    await updateDrydockCount();

    // Trigger Harbor Map refresh with rate limiting (30s cooldown)
    const { broadcastHarborMapRefresh } = require('./websocket');
    if (broadcastHarborMapRefresh) {
      broadcastHarborMapRefresh(userId, 'interval', { readyToDepart, atAnchor, pending });
    }

    // CRITICAL: Update bunker/header data ALWAYS (regardless of pause state)
    // This ensures cash, fuel, CO2, stock, etc. stay up-to-date even when paused
    try {
      const user = gameIndexData.user;
      const gameSettings = gameIndexData.data.user_settings;

      // CRITICAL: Only update if API returned valid data (not 0, not undefined)
      if (!user || user.fuel === undefined || user.co2 === undefined || user.cash === undefined) {
        logger.warn('[Loop] Bunker update skipped - invalid API response (user data missing)');
      } else if (!gameSettings || !gameSettings.max_fuel || !gameSettings.max_co2) {
        logger.warn('[Loop] Bunker update skipped - invalid API response (game settings missing)');
      } else {
        // Update bunker state (cash, fuel, CO2, points)
        const bunkerUpdate = {
          fuel: user.fuel / 1000,        // Convert kg to tons
          co2: user.co2 / 1000,          // Convert kg to tons
          cash: user.cash,
          points: user.points,
          maxFuel: gameSettings.max_fuel / 1000,
          maxCO2: gameSettings.max_co2 / 1000
        };
        state.updateBunkerState(userId, bunkerUpdate);

        if (broadcastToUser) {
          const { broadcastBunkerUpdate } = require('./websocket');
          broadcastBunkerUpdate(userId, bunkerUpdate);
        }
      }

      // Update header data (stock, anchor slots) - only if data is valid
      if (user && gameSettings && gameSettings.anchor_points !== undefined) {
        const stockValue = user.stock_value;
        const stockTrend = user.stock_trend;
        const ipo = user.ipo;
        const maxAnchorPoints = gameSettings.anchor_points;
        const deliveredVessels = vessels.filter(v => v.status !== 'pending').length;
        const pendingVessels = vessels.filter(v => v.status === 'pending').length;
        const availableCapacity = maxAnchorPoints - deliveredVessels - pendingVessels;

        const anchorNextBuild = gameSettings.anchor_next_build || null;
        const now = Math.floor(Date.now() / 1000);
        // (using settings from outer scope - already loaded on line 669)
        const pendingAnchorPoints = (anchorNextBuild && anchorNextBuild > now) ? settings.pendingAnchorPoints : 0;

        const headerUpdate = {
          stock: { value: stockValue, trend: stockTrend, ipo },
          anchor: {
            available: availableCapacity,
            max: maxAnchorPoints,
            pending: pendingAnchorPoints,
            nextBuild: anchorNextBuild
          }
        };
        state.updateHeaderData(userId, headerUpdate);

        if (broadcastToUser) {
          broadcastToUser(userId, 'header_data_update', headerUpdate);
        }

        logger.debug('[Loop] Header data updated');
      } else {
        logger.warn('[Loop] Header update skipped - invalid API response');
      }
    } catch (error) {
      logger.error('[Loop] Failed to update header/bunker data:', error.message);
    }

    // Skip automation if paused
    if (autopilotPaused) {
      logger.info('[Fast Loop] Autopilot PAUSED - Skipping all automation (badge updates completed)');
      setTimeout(fastEventLoop, LOOP_INTERVAL_FAST);
      return;
    }

    logger.debug('[Fast Loop] Autopilot RUNNING - Executing fast automation tasks');

    // Auto-rebuy runs EVERY loop
    await autoRebuyAll();

    // Vessels ready to depart
    if (settings.autoDepartAll && readyToDepart > 0) {
      logger.debug(`[Loop] ${readyToDepart} vessel(s) ready to depart`);
      await autoDepartVessels(autopilotPaused, broadcastToUser, autoRebuyAll, tryUpdateAllData);
    }

    // Vessels need repair
    const needsRepair = vessels.filter(v => v.wear >= settings.maintenanceThreshold).length;
    if (settings.autoBulkRepair && needsRepair > 0) {
      logger.debug(`[Loop] ${needsRepair} vessel(s) need repair`);
      await autoRepairVessels(autopilotPaused, broadcastToUser, tryUpdateAllData);
    }

    // Vessels need drydock
    const needsDrydock = vessels.filter(v => {
      const hours = v.hours_until_check !== undefined ? v.hours_until_check : 999;
      return hours <= settings.autoDrydockThreshold;
    }).length;
    if (settings.autoDrydock && needsDrydock > 0) {
      logger.debug(`[Loop] ${needsDrydock} vessel(s) need drydock`);
      await autoDrydockVessels(autopilotPaused, broadcastToUser, tryUpdateAllData);
    }

    // Hijacking cases
    if (settings.autoNegotiateHijacking) {
      await autoNegotiateHijacking(autopilotPaused, broadcastToUser, tryUpdateAllData);
    }

    // Anchor point purchase - handled by scheduler (every 5 minutes)
    // Removed from main loop to avoid redundancy

    // Campaign status update and auto-renewal
    await updateCampaigns();

  } catch (error) {
    // Network errors are recoverable - don't crash the app
    const isNetworkError = error.message && (
      error.message.includes('ECONNABORTED') ||
      error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('socket hang up') ||
      error.message.includes('network')
    );

    if (isNetworkError) {
      logger.warn('[Fast Loop] Network error in fast event loop (will retry):', error.message);
    } else {
      logger.error('[Fast Loop] Error in fast event loop:', error);
      logger.error('[Fast Loop] Stack trace:', error.stack);
    }
  }

  setTimeout(fastEventLoop, LOOP_INTERVAL_FAST);
}

/**
 * Slow autopilot loop (5 minutes).
 * Handles slow operations: COOP, IPO/stock trading, staff morale.
 */
async function slowEventLoop() {
  const userId = getUserId();
  if (!userId) {
    setTimeout(slowEventLoop, LOOP_INTERVAL_SLOW);
    return;
  }

  const settings = state.getSettings(userId);
  if (!settings) {
    setTimeout(slowEventLoop, LOOP_INTERVAL_SLOW);
    return;
  }

  try {
    if (autopilotPaused) {
      logger.info('[Slow Loop] Autopilot PAUSED - Skipping slow automation');
      setTimeout(slowEventLoop, LOOP_INTERVAL_SLOW);
      return;
    }

    logger.debug('[Slow Loop] Autopilot RUNNING - Executing slow automation tasks');

    // COOP targets available
    if (settings.autoCoopEnabled) {
      const coopData = await fetchCoopDataCached();
      const available = coopData.data?.coop?.available;
      if (available > 0) {
        logger.debug(`[Slow Loop] ${available} COOP target(s) available`);
        await autoCoop(autopilotPaused, broadcastToUser, tryUpdateAllData);
      }
    }

    // The Purser - Auto stock trading (buy from fresh IPOs, sell falling investments)
    if (settings.autoPurserEnabled) {
      await autoBuyStock(autopilotPaused, broadcastToUser, tryUpdateAllData);
      if (settings.autoPurserAutoSellEnabled) {
        await autoSellStock(autopilotPaused, broadcastToUser, tryUpdateAllData);
      }
    }

    // Staff Captain - Auto staff morale management
    if (settings.enableStaffCaptain) {
      await manageStaffMorale(autopilotPaused, broadcastToUser);
    }

  } catch (error) {
    // Network errors are recoverable - don't crash the app
    const isNetworkError = error.message && (
      error.message.includes('ECONNABORTED') ||
      error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('socket hang up') ||
      error.message.includes('network')
    );

    if (isNetworkError) {
      logger.warn('[Slow Loop] Network error in slow event loop (will retry):', error.message);
    } else {
      logger.error('[Slow Loop] Error in slow event loop:', error);
      logger.error('[Slow Loop] Stack trace:', error.stack);
    }
  }

  setTimeout(slowEventLoop, LOOP_INTERVAL_SLOW);
}

/**
 * Starts both event loops (fast and slow).
 */
function startMainEventLoop() {
  logger.info('[Loop] Starting fast event loop (60s interval)');
  fastEventLoop();

  logger.info('[Loop] Starting slow event loop (5min interval)');
  slowEventLoop();
}

/**
 * Counts active campaign types (reputation, awareness, green).
 */
function countActiveCampaignTypes(campaigns) {
  const active = campaigns.active;
  const activeTypes = new Set(active.map(c => c.option_name));
  const requiredTypes = ['reputation', 'awareness', 'green'];
  return requiredTypes.filter(type => activeTypes.has(type)).length;
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  setBroadcastFunction,
  initializeAutopilotState,
  pauseAutopilot,
  resumeAutopilot,
  isAutopilotPaused,
  updatePrices,
  checkPriceAlerts,
  autoRebuyFuel,
  autoRebuyCO2,
  autoRebuyAll,
  departVessels,
  autoDepartVessels,
  autoRepairVessels,
  autoDrydockVessels,
  autoCoop,
  autoAnchorPointPurchase,
  autoNegotiateHijacking,
  autoCampaignRenewal,
  updateRepairCount,
  updateDrydockCount,
  updateCampaigns,
  updateUnreadMessages,
  updateAllData,
  tryUpdateAllData,
  updateVesselCount,
  getCachedCapacity,
  analyzeVesselDepartures,
  calculateRemainingDemand,
  getTotalCapacity,
  startMainEventLoop
};
