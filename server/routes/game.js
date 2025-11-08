/**
 * @fileoverview Game Management API Routes
 *
 * This module provides HTTP endpoints for managing game resources including vessels,
 * fuel/CO2 purchases, user settings, vessel maintenance, marketing campaigns, and
 * vessel acquisitions. These endpoints proxy requests to the Shipping Manager game API
 * while adding validation and error handling.
 *
 * Key Features:
 * - Vessel management (list vessels in harbor, purchase new vessels, bulk repairs)
 * - Bunker operations (fuel and CO2 price monitoring and purchasing)
 * - Route management (depart all vessels at once)
 * - Marketing campaigns (view available campaigns, activate/renew)
 * - User settings retrieval (anchor points, company data)
 *
 * Why This Module:
 * - Consolidates all game resource management endpoints
 * - Provides validation before forwarding to game API
 * - Standardizes error responses across all game operations
 * - Enables automation features (auto-rebuy, auto-depart, auto-repair)
 *
 * Common Patterns:
 * - GET endpoints retrieve current state (prices, vessels, settings)
 * - POST endpoints perform actions (purchase, depart, repair)
 * - All endpoints include error handling with descriptive messages
 * - Graceful degradation (empty arrays instead of errors for UI-critical endpoints)
 *
 * @requires express - Router and middleware
 * @requires ../utils/api - API helper function (apiCall)
 * @module server/routes/game
 */

const express = require('express');
const { apiCall, apiCallWithRetry, getUserId } = require('../utils/api');
const gameapi = require('../gameapi');
const { broadcastToUser } = require('../websocket');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const autopilot = require('../autopilot');

const router = express.Router();

// Auto-depart log file path - use APPDATA when running as .exe
const { getAppDataDir } = require('../config');
const LOG_DIR = process.pkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'logs')
  : path.join(__dirname, '../..', 'userdata', 'logs');

const AUTO_DEPART_LOG = path.join(LOG_DIR, 'auto-depart.log');

/** GET /api/vessel/get-vessels - Retrieves all vessels currently in harbor. Uses /game/index endpoint to get complete vessel list with status, cargo, maintenance needs, etc. */
router.get('/vessel/get-vessels', async (req, res) => {
  try {
    const data = await apiCallWithRetry('/game/index', 'POST', {});
    res.json({
      vessels: data.data.user_vessels,
      experience_points: data.data.experience_points,
      levelup_experience_points: data.data.levelup_experience_points,
      company_type: data.user?.company_type
    });
  } catch (error) {
    logger.error('Error getting vessels:', error);
    res.status(500).json({ error: 'Failed to retrieve vessels' });
  }
});

/** POST /api/user/get-company - Returns user company data including capacity values. */
router.post('/user/get-company', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/user/get-company', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error fetching company data:', error);
    res.status(500).json({ error: 'Failed to fetch company data' });
  }
});

/** GET /api/user/get-settings - Retrieves user settings including anchor points (used for auto-rebuy calculations). */
router.get('/user/get-settings', async (req, res) => {
  try {
    const data = await apiCall('/user/get-user-settings', 'GET', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting user settings:', error);
    res.status(500).json({ error: 'Failed to retrieve user settings' });
  }
});

/** GET /api/bunker/get-prices - Fetches current market prices for fuel and CO2. Critical for price alerts and auto-rebuy features. */
router.get('/bunker/get-prices', async (req, res) => {
  try {
    const data = await apiCall('/bunker/get-prices', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting bunker prices:', error);
    res.status(500).json({ error: 'Failed to retrieve bunker prices' });
  }
});

/**
 * POST /api/bunker/purchase-fuel - Purchases specified amount of fuel.
 * Validation: amount must be positive integer. Used by manual purchases and auto-rebuy automation.
 */
router.post('/bunker/purchase-fuel', express.json(), async (req, res) => {
  const { amount } = req.body;

  if (!amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Broadcast fuel purchase start to lock buttons on all clients
  const userId = getUserId();
  if (userId) {
    broadcastToUser(userId, 'fuel_purchase_start', {});
  }

  try {
    // Get cash BEFORE purchase to calculate actual cost
    const state = require('../state');
    const bunkerBefore = state.getBunkerState(userId);
    const cashBefore = bunkerBefore ? bunkerBefore.cash : 0;

    // API expects amount in tons (NOT kg) - send directly
    const data = await apiCall('/bunker/purchase-fuel', 'POST', { amount });

    // Broadcast bunker update to all clients (manual purchase)
    if (userId && data.user) {
      // API doesn't return capacity fields - use cached values from autopilot
      const cachedCapacity = autopilot.getCachedCapacity(userId);
      const { broadcastBunkerUpdate } = require('../websocket');

      broadcastBunkerUpdate(userId, {
        fuel: data.user.fuel / 1000,
        co2: (data.user.co2 || data.user.co2_certificate) / 1000,
        cash: data.user.cash,
        maxFuel: cachedCapacity.maxFuel,
        maxCO2: cachedCapacity.maxCO2
      });

      // Calculate ACTUAL cost from API response (includes discounts!)
      const cashAfter = data.user.cash;
      const actualCost = Math.round(cashBefore - cashAfter);
      const actualPricePerTon = Math.round(actualCost / amount);

      logger.log(`[Manual Fuel Purchase] User bought ${amount}t @ $${actualPricePerTon}/t = $${actualCost.toLocaleString('en-US')} (Cash: $${cashBefore.toLocaleString('en-US')} → $${cashAfter.toLocaleString('en-US')})`);

      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `
          <div style="font-family: monospace; font-size: 13px;">
            <div style="text-align: center; border-bottom: 2px solid rgba(255,255,255,0.3); padding-bottom: 8px; margin-bottom: 12px;">
              <strong style="font-size: 14px;">⛽ Fuel Purchase</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Amount:</span>
              <span><strong>${Math.round(amount).toLocaleString('en-US')}t</strong></span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Price per ton:</span>
              <span>$${actualPricePerTon}/t</span>
            </div>
            <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
            <div style="display: flex; justify-content: space-between; font-size: 15px;">
              <span><strong>Total:</strong></span>
              <span style="color: #ef4444;"><strong>$${actualCost.toLocaleString('en-US')}</strong></span>
            </div>
          </div>
        `
      });

      // Broadcast fuel purchase complete to unlock buttons
      broadcastToUser(userId, 'fuel_purchase_complete', { amount });

      // Trigger immediate data update
      await autopilot.tryUpdateAllData();
    }

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing fuel:', error);

    // Broadcast error notification to all clients
    const errorUserId = getUserId();
    if (errorUserId) {
      broadcastToUser(errorUserId, 'user_action_notification', {
        type: 'error',
        message: `⛽ <strong>Purchase Failed</strong><br><br>${error.message}`
      });

      // Broadcast fuel purchase complete to unlock buttons even on error
      broadcastToUser(errorUserId, 'fuel_purchase_complete', { amount: 0 });
    }

    res.status(500).json({ error: 'Failed to purchase fuel' });
  }
});

/**
 * POST /api/bunker/purchase-co2 - Purchases specified amount of CO2 certificates.
 * Validation: amount must be positive integer. Used by manual purchases and auto-rebuy automation.
 */
router.post('/bunker/purchase-co2', express.json(), async (req, res) => {
  const { amount } = req.body;

  if (!amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Broadcast CO2 purchase start to lock buttons on all clients
  const userId = getUserId();
  if (userId) {
    broadcastToUser(userId, 'co2_purchase_start', {});
  }

  try {
    // Get cash BEFORE purchase to calculate actual cost
    const state = require('../state');
    const bunkerBefore = state.getBunkerState(userId);
    const cashBefore = bunkerBefore ? bunkerBefore.cash : 0;

    // API expects amount in tons (NOT kg) - send directly
    const data = await apiCall('/bunker/purchase-co2', 'POST', { amount });

    // Broadcast bunker update to all clients (manual purchase)
    if (userId && data.user) {
      // API doesn't return capacity fields - use cached values from autopilot
      const cachedCapacity = autopilot.getCachedCapacity(userId);
      const { broadcastBunkerUpdate } = require('../websocket');

      broadcastBunkerUpdate(userId, {
        fuel: data.user.fuel / 1000,
        co2: (data.user.co2 || data.user.co2_certificate) / 1000,
        cash: data.user.cash,
        maxFuel: cachedCapacity.maxFuel,
        maxCO2: cachedCapacity.maxCO2
      });

      // Calculate ACTUAL cost from API response (includes discounts!)
      const cashAfter = data.user.cash;
      const actualCost = Math.round(cashBefore - cashAfter);
      const actualPricePerTon = Math.round(actualCost / amount);

      logger.log(`[Manual CO2 Purchase] User bought ${amount}t @ $${actualPricePerTon}/t = $${actualCost.toLocaleString('en-US')} (Cash: $${cashBefore.toLocaleString('en-US')} → $${cashAfter.toLocaleString('en-US')})`);

      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `
          <div style="font-family: monospace; font-size: 13px;">
            <div style="text-align: center; border-bottom: 2px solid rgba(255,255,255,0.3); padding-bottom: 8px; margin-bottom: 12px;">
              <strong style="font-size: 14px;">💨 CO2 Purchase</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Amount:</span>
              <span><strong>${Math.round(amount).toLocaleString('en-US')}t</strong></span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Price per ton:</span>
              <span>$${actualPricePerTon}/t</span>
            </div>
            <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
            <div style="display: flex; justify-content: space-between; font-size: 15px;">
              <span><strong>Total:</strong></span>
              <span style="color: #ef4444;"><strong>$${actualCost.toLocaleString('en-US')}</strong></span>
            </div>
          </div>
        `
      });

      // Broadcast CO2 purchase complete to unlock buttons
      broadcastToUser(userId, 'co2_purchase_complete', { amount });

      // Trigger immediate data update
      await autopilot.tryUpdateAllData();
    }

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing CO2:', error);

    // Broadcast error notification to all clients
    const errorUserId = getUserId();
    if (errorUserId) {
      broadcastToUser(errorUserId, 'user_action_notification', {
        type: 'error',
        message: `💨 <strong>Purchase Failed</strong><br><br>${error.message}`
      });

      // Broadcast CO2 purchase complete to unlock buttons even on error
      broadcastToUser(errorUserId, 'co2_purchase_complete', { amount: 0 });
    }

    res.status(500).json({ error: 'Failed to purchase CO2' });
  }
});

/**
 * POST /api/route/depart - Universal depart endpoint
 * Accepts optional array of vessel IDs. If no IDs provided, departs ALL vessels in harbor.
 * Uses the EXACT same logic and notifications as autopilot.
 *
 * Request body (optional):
 * {
 *   vessel_ids: [123, 456, 789]  // Optional - if omitted, departs ALL vessels
 * }
 */
router.post('/route/depart', async (req, res) => {
  try {
    const userId = getUserId();

    // Extract vessel IDs from request body (optional)
    const vesselIds = req.body?.vessel_ids || null;

    if (vesselIds && !Array.isArray(vesselIds)) {
      return res.status(400).json({ error: 'vessel_ids must be an array' });
    }

    if (vesselIds) {
      logger.log(`[Depart API] Departing ${vesselIds.length} specific vessels`);
    } else {
      logger.log(`[Depart API] Departing ALL vessels in harbor`);
    }

    // Call universal depart function
    // vesselIds = null means "depart all"
    // vesselIds = [1,2,3] means "depart these specific vessels"
    const { broadcastToUser } = require('../websocket');
    const result = await autopilot.departVessels(userId, vesselIds, broadcastToUser, autopilot.autoRebuyAll, autopilot.tryUpdateAllData);

    res.json(result || { success: true, message: 'Depart triggered' });
  } catch (error) {
    logger.error('[Depart API] Error:', error);
    res.status(500).json({ error: 'Failed to depart vessels' });
  }
});



/**
 * GET /api/port/get-assigned-ports - Retrieves demand and consumed data for all assigned ports.
 * Used by intelligent auto-depart to calculate remaining port capacity.
 * Returns port demand/consumed for both container and tanker cargo types.
 * @returns {Object} data.ports - Array of port objects with demand/consumed data
 */
router.get('/port/get-assigned-ports', async (req, res) => {
  try {
    const data = await apiCall('/port/get-assigned-ports', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error fetching assigned ports:', error);
    res.status(500).json({ error: 'Failed to fetch assigned ports' });
  }
});

/** POST /api/maintenance/get - Calculates maintenance cost for specified vessels. Returns total repair cost and individual vessel costs. */
router.post('/maintenance/get', express.json(), async (req, res) => {
  const { vessel_ids } = req.body;

  if (!vessel_ids) {
    return res.status(400).json({ error: 'Missing vessel_ids' });
  }

  try {
    const data = await apiCall('/maintenance/get', 'POST', { vessel_ids });
    res.json(data);
  } catch (error) {
    logger.error('Error getting maintenance cost:', error);
    res.status(500).json({ error: 'Failed to get maintenance cost' });
  }
});

/** POST /api/maintenance/do-wear-maintenance-bulk - Performs bulk wear maintenance on multiple vessels. Repairs all specified vessels in a single API call. */
router.post('/maintenance/do-wear-maintenance-bulk', express.json(), async (req, res) => {
  const { vessel_ids } = req.body;

  if (!vessel_ids) {
    return res.status(400).json({ error: 'Missing vessel_ids' });
  }

  try {
    const data = await apiCall('/maintenance/do-wear-maintenance-bulk', 'POST', { vessel_ids });
    res.json(data);
  } catch (error) {
    logger.error('Error performing bulk maintenance:', error);
    res.status(500).json({ error: 'Failed to perform bulk maintenance' });
  }
});

/**
 * GET /api/marketing/get-campaigns - Retrieves available marketing campaigns and active campaign status.
 * Graceful error handling: Returns empty arrays instead of error to prevent UI breaking.
 */
router.get('/marketing/get-campaigns', async (req, res) => {
  try {
    const data = await apiCall('/marketing-campaign/get-marketing', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting marketing campaigns:', error.message, error.stack);

    // Return empty campaigns instead of error to prevent UI breaking
    res.json({
      data: {
        marketing_campaigns: [],
        active_campaigns: []
      },
      user: {
        reputation: 0
      }
    });
  }
});

/** POST /api/marketing/activate-campaign - Activates a marketing campaign by campaign_id. Used for manual activation and auto-renewal automation. */
router.post('/marketing/activate-campaign', express.json(), async (req, res) => {
  const { campaign_id } = req.body;

  if (!campaign_id) {
    return res.status(400).json({ error: 'Missing campaign_id' });
  }

  try {
    const data = await apiCall('/marketing-campaign/activate-marketing-campaign', 'POST', { campaign_id });
    res.json(data);
  } catch (error) {
    logger.error('Error activating campaign:', error);
    res.status(500).json({ error: 'Failed to activate campaign' });
  }
});

/** GET /api/vessel/get-all-acquirable - Fetches all vessels available for purchase from the marketplace. */
router.get('/vessel/get-all-acquirable', async (req, res) => {
  try {
    const data = await apiCall('/vessel/get-all-acquirable-vessels', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting acquirable vessels:', error);
    res.status(500).json({ error: 'Failed to retrieve acquirable vessels' });
  }
});

/**
 * POST /api/vessel/sell-vessels - Sells multiple vessels by their IDs.
 * Accepts an array of vessel IDs and sells each one individually.
 * Broadcasts notifications and bunker updates to all connected clients.
 */
router.post('/vessel/sell-vessels', express.json(), async (req, res) => {
  const { vessel_ids } = req.body;

  if (!vessel_ids || !Array.isArray(vessel_ids) || vessel_ids.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid vessel_ids array' });
  }

  try {
    let soldCount = 0;
    const errors = [];

    // Sell each vessel individually (API only supports single vessel sales)
    for (const vesselId of vessel_ids) {
      try {
        const data = await apiCall('/vessel/sell-vessel', 'POST', { vessel_id: vesselId });
        if (data.success) {
          soldCount++;
        }
      } catch (error) {
        logger.error(`[Vessel Sell] Failed to sell vessel ${vesselId}:`, error.message);
        errors.push({ vesselId, error: error.message });
      }
    }

    const userId = getUserId();
    if (userId && soldCount > 0) {
      logger.log(`[Manual Vessel Sell] User sold ${soldCount} vessel(s)`);

      // Broadcast notification to all clients
      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `⛴️ <strong>Vessels Sold!</strong><br><br>Successfully sold ${soldCount} vessel${soldCount > 1 ? 's' : ''}`
      });

      // Fetch and broadcast updated bunker state (cash increased)
      try {
        const gameData = await apiCallWithRetry('/game/index', 'POST', {});
        if (gameData.data?.user) {
          const user = gameData.data.user;

          // API doesn't return capacity fields - use cached values from autopilot
          const cachedCapacity = autopilot.getCachedCapacity(userId);

          broadcastToUser(userId, 'bunker_update', {
            fuel: user.fuel / 1000,
            co2: (user.co2 || user.co2_certificate) / 1000,
            cash: user.cash,
            maxFuel: cachedCapacity.maxFuel,
            maxCO2: cachedCapacity.maxCO2
          });
        }
      } catch (error) {
        logger.error('[Vessel Sell] Failed to fetch updated bunker state:', error);
      }
    }

    res.json({
      success: true,
      sold: soldCount,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    logger.error('[Vessel Sell] Error:', error);
    const userId = getUserId();
    if (userId) {
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `⛴️ <strong>Sale Failed</strong><br><br>${error.message}`
      });
    }
    res.status(500).json({ error: 'Failed to sell vessels' });
  }
});

/**
 * POST /api/vessel/purchase-vessel - Purchases a new vessel with specified configuration.
 * Default configuration: 4-blade propeller, optional antifouling, no enhanced deck beams.
 * Validation: vessel_id and name are required fields.
 */
router.post('/vessel/purchase-vessel', express.json(), async (req, res) => {
  const { vessel_id, name, antifouling_model, count, silent } = req.body;

  if (!vessel_id || !name) {
    return res.status(400).json({ error: 'Missing required fields: vessel_id, name' });
  }

  try {
    const data = await apiCall('/vessel/purchase-vessel', 'POST', {
      vessel_id,
      name,
      adjust_speed: '4_blade_propeller',
      antifouling_model: antifouling_model || null,
      enhanced_deck_beams: 0
    });

    const userId = getUserId();
    if (userId && data.user_vessel && !silent) {
      const vesselName = data.user_vessel.name || name;
      const purchaseCount = count || 1;

      logger.log(`[Manual Vessel Purchase] User bought ${purchaseCount}x ${vesselName}`);

      // Broadcast notification to all clients (unless silent=true)
      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `🚢 <strong>Purchase Successful!</strong><br><br>Purchased ${purchaseCount}x ${vesselName}`
      });
    }

    // Always broadcast bunker update (cash decreased)
    if (userId && data.user) {
      broadcastToUser(userId, 'bunker_update', {
        fuel: data.user.fuel / 1000,
        co2: (data.user.co2 || data.user.co2_certificate) / 1000,
        cash: data.user.cash,
        maxFuel: data.user.fuel_capacity / 1000,
        maxCO2: data.user.co2_certificate_capacity / 1000
      });
    }

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing vessel:', error);

    const userId = getUserId();
    if (userId && !silent) {
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🚢 <strong>Purchase Failed</strong><br><br>${error.message}`
      });
    }

    res.status(500).json({ error: 'Failed to purchase vessel' });
  }
});

/**
 * POST /api/vessel/bulk-buy-start - Broadcasts bulk buy start to lock buttons across all clients
 */
router.post('/vessel/bulk-buy-start', express.json(), async (req, res) => {
  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    broadcastToUser(userId, 'bulk_buy_start', {});
    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting bulk buy start:', error);
    res.status(500).json({ error: 'Failed to broadcast start' });
  }
});

/**
 * POST /api/vessel/broadcast-purchase-summary - Broadcasts a summary notification of vessel purchases to all clients
 */
router.post('/vessel/broadcast-purchase-summary', express.json(), async (req, res) => {
  const { vessels, totalCost } = req.body;

  if (!vessels || !Array.isArray(vessels)) {
    return res.status(400).json({ error: 'Missing required field: vessels (array)' });
  }

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Build vessel list HTML
    let vesselListHtml = '';
    if (vessels.length > 5) {
      // If more than 5, show scrollable list
      vesselListHtml = '<div style="max-height: 200px; overflow-y: auto; margin: 10px 0; padding-right: 5px;"><ul style="margin: 0; padding-left: 20px; text-align: left;">';
      vessels.forEach(v => {
        vesselListHtml += `<li>${v.name}</li>`;
      });
      vesselListHtml += '</ul></div>';
    } else {
      // If 5 or fewer, show simple list
      vesselListHtml = '<br>';
      vessels.forEach(v => {
        vesselListHtml += `${v.name}<br>`;
      });
    }

    const message = `🚢 <strong>Purchased ${vessels.length} vessel${vessels.length > 1 ? 's' : ''}!</strong>${vesselListHtml}Total Cost: $${totalCost.toLocaleString()}`;

    broadcastToUser(userId, 'user_action_notification', {
      type: 'success',
      message
    });

    // Broadcast bulk buy complete to unlock buttons
    broadcastToUser(userId, 'bulk_buy_complete', {
      count: vessels.length
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting purchase summary:', error);
    res.status(500).json({ error: 'Failed to broadcast summary' });
  }
});

/** POST /api/vessel/get-repair-preview - Gets repair preview with vessel list and costs */
router.post('/vessel/get-repair-preview', express.json(), async (req, res) => {
  const { threshold } = req.body;

  if (!threshold || threshold < 0 || threshold > 100) {
    return res.status(400).json({ error: 'Invalid threshold' });
  }

  try {
    // Get all vessels
    const vesselData = await apiCallWithRetry('/game/index', 'POST', {});
    const allVessels = vesselData.data.user_vessels;
    const user = vesselData.user;

    // Filter vessels needing repair
    const vesselsToRepair = allVessels.filter(v => {
      const wear = parseInt(v.wear);
      return wear >= threshold;
    });

    if (vesselsToRepair.length === 0) {
      return res.json({ vessels: [], totalCost: 0, cash: user.cash });
    }

    // Get repair costs
    const vesselIds = vesselsToRepair.map(v => v.id);
    const costData = await gameapi.getMaintenanceCost(vesselIds);

    // Build vessel details with costs
    const vesselDetails = vesselsToRepair.map(vessel => {
      const costVessel = costData.vessels.find(v => v.id === vessel.id);
      const wearMaintenance = costVessel?.maintenance_data?.find(m => m.type === 'wear');
      const cost = wearMaintenance?.price;
      return {
        id: vessel.id,
        name: vessel.name,
        wear: vessel.wear,
        cost: cost
      };
    });

    // Calculate total cost
    const calculatedTotalCost = vesselDetails.reduce((sum, v) => sum + v.cost, 0);
    const finalTotalCost = costData.totalCost > 0 ? costData.totalCost : calculatedTotalCost;

    res.json({
      vessels: vesselDetails,
      totalCost: finalTotalCost,
      cash: user.cash
    });

  } catch (error) {
    logger.error('Error getting repair preview:', error);
    res.status(500).json({ error: 'Failed to get repair preview' });
  }
});

/** POST /api/vessel/bulk-repair - Repairs all vessels needing maintenance based on threshold */
router.post('/vessel/bulk-repair', express.json(), async (req, res) => {
  const { threshold } = req.body;

  if (!threshold || threshold < 0 || threshold > 100) {
    return res.status(400).json({ error: 'Invalid threshold' });
  }

  try {
    // Get all vessels
    const vesselData = await apiCallWithRetry('/game/index', 'POST', {});
    const allVessels = vesselData.data.user_vessels;

    // Filter vessels needing repair
    const vesselsToRepair = allVessels.filter(v => {
      const wear = parseInt(v.wear);
      return wear >= threshold;
    });

    if (vesselsToRepair.length === 0) {
      const userId = getUserId();
      if (userId) {
        broadcastToUser(userId, 'user_action_notification', {
          type: 'info',
          message: '🔧 No vessels need repair!'
        });
      }
      return res.json({ count: 0, totalCost: 0 });
    }

    // Get repair costs
    const vesselIds = vesselsToRepair.map(v => v.id);
    const costData = await gameapi.getMaintenanceCost(vesselIds);
    const totalCost = costData.totalCost;

    // Build vessel details with costs
    const vesselDetails = vesselsToRepair.map(vessel => {
      const costVessel = costData.vessels.find(v => v.id === vessel.id);
      const wearMaintenance = costVessel?.maintenance_data?.find(m => m.type === 'wear');
      const cost = wearMaintenance?.price;
      logger.debug(`[Bulk Repair] Vessel ${vessel.name} (ID: ${vessel.id}): wear=${vessel.wear}%, cost=$${cost}`);
      return {
        id: vessel.id,
        name: vessel.name,
        wear: vessel.wear,
        cost: cost
      };
    });

    // Recalculate totalCost from vessel details (in case API returned 0)
    const calculatedTotalCost = vesselDetails.reduce((sum, v) => sum + v.cost, 0);
    logger.debug(`[Bulk Repair] Total calculated from vessels: $${calculatedTotalCost.toLocaleString()}, costData.totalCost: $${costData.totalCost.toLocaleString()}`);

    // Check cash (use calculatedTotalCost if totalCost is 0)
    const finalTotalCost = totalCost > 0 ? totalCost : calculatedTotalCost;
    const state = require('../state');
    const userId = getUserId();
    const bunker = state.getBunkerState(userId);

    if (finalTotalCost > bunker.cash) {
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🔧 <strong>Not enough cash!</strong><br><br>Repair cost: $${totalCost.toLocaleString()}<br>Your cash: $${bunker.cash.toLocaleString()}<br>Missing: $${(totalCost - bunker.cash).toLocaleString()}`
      });
      return res.status(400).json({ error: 'Not enough cash' });
    }

    // Broadcast repair start (lock buttons across all tabs)
    if (userId) {
      broadcastToUser(userId, 'repair_start', {});
    }

    // Execute repairs
    const repairData = await gameapi.bulkRepairVessels(vesselIds);

    // Use repairData.totalCost if available (API sometimes returns it), otherwise use finalTotalCost
    const actualCost = repairData.totalCost > 0 ? repairData.totalCost : finalTotalCost;

    logger.debug(`[Manual Bulk Repair] Repaired ${vesselsToRepair.length} vessels - costData.totalCost: $${totalCost.toLocaleString()}, calculatedTotalCost: $${calculatedTotalCost.toLocaleString()}, repairData.totalCost: $${repairData.totalCost.toLocaleString()}, Using: $${actualCost.toLocaleString()}`);

    // Broadcast success to all clients using same format as autopilot
    if (userId) {
      broadcastToUser(userId, 'vessels_repaired', {
        count: vesselsToRepair.length,
        totalCost: actualCost,
        vessels: vesselDetails
      });

      // Update bunker cash
      broadcastToUser(userId, 'bunker_update', {
        fuel: bunker.fuel,
        co2: bunker.co2,
        cash: bunker.cash - actualCost,
        maxFuel: bunker.maxFuel,
        maxCO2: bunker.maxCO2
      });

      // Broadcast repair complete (unlock buttons across all tabs)
      broadcastToUser(userId, 'repair_complete', {
        count: vesselsToRepair.length
      });
    }

    res.json({
      count: vesselsToRepair.length,
      totalCost: actualCost,
      vessels: vesselDetails
    });
  } catch (error) {
    logger.error('Error repairing vessels:', error);

    const userId = getUserId();
    if (userId) {
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🔧 <strong>Error</strong><br><br>${error.message}`
      });
    }

    res.status(500).json({ error: 'Failed to repair vessels' });
  }
});

/** POST /api/check-price-alerts - Manually trigger price alert check (called on page load) */
router.post('/check-price-alerts', async (req, res) => {
  try {
    await autopilot.checkPriceAlerts();
    res.json({ success: true });
  } catch (error) {
    logger.error('[API] Failed to check price alerts:', error.message);
    res.status(500).json({ error: 'Failed to check price alerts' });
  }
});

/** POST /api/autopilot/trigger-depart - Event-driven auto-depart trigger (called when vessels arrive in harbor) */
router.post('/autopilot/trigger-depart', async (req, res) => {
  try {
    const userId = getUserId();
    const state = require('../state');

    const settings = state.getSettings(userId);

    // Only execute if auto-depart is enabled
    if (!settings?.autoDepartAll) {
      return res.json({ success: false, message: 'Auto-depart not enabled' });
    }

    logger.log(`[Auto-Depart] Event-driven trigger received for user ${userId}`);

    // Execute auto-depart directly
    await autopilot.autoDepartVessels();

    res.json({ success: true, message: 'Auto-depart triggered' });
  } catch (error) {
    logger.error('[Auto-Depart] Trigger failed:', error);
    res.status(500).json({ error: 'Failed to trigger auto-depart' });
  }
});

/**
 * POST /api/autopilot/toggle - Pause/Resume autopilot
 *
 * Toggles autopilot paused state. When paused, the central autopilot monitor
 * still runs on its schedule, but skips all actions (depart, repair, rebuy, etc.).
 * Header data updates continue to run normally.
 */
router.post('/autopilot/toggle', async (req, res) => {
  try {
    const userId = getUserId();
    const { broadcastToUser } = require('../websocket');

    // Toggle paused state in autopilot.js (global state)
    const currentlyPaused = autopilot.isAutopilotPaused();
    const newPausedState = !currentlyPaused;

    if (newPausedState) {
      autopilot.pauseAutopilot();
    } else {
      autopilot.resumeAutopilot();
    }

    const status = newPausedState ? 'paused' : 'resumed';
    logger.log(`[Autopilot] User ${userId} ${status} autopilot`);

    // Broadcast status to this user's connected clients
    broadcastToUser(userId, 'autopilot_status', {
      paused: newPausedState,
      message: `Autopilot ${status}`
    });

    res.json({
      success: true,
      paused: newPausedState,
      message: `Autopilot ${status}`
    });
  } catch (error) {
    logger.error('[Autopilot] Toggle failed:', error);
    res.status(500).json({ error: 'Failed to toggle autopilot' });
  }
});

/**
 * GET /api/autopilot/status - Get current autopilot pause status
 *
 * Returns the current autopilot paused state (global state from autopilot.js).
 * Used on page load to sync button state across all devices.
 */
router.get('/autopilot/status', async (req, res) => {
  try {
    const isPaused = autopilot.isAutopilotPaused();

    res.json({
      success: true,
      paused: isPaused
    });
  } catch (error) {
    logger.error('[Autopilot] Get status failed:', error);
    res.status(500).json({ error: 'Failed to get autopilot status' });
  }
});

/** POST /api/game/index - Proxies /game/index endpoint from game API */
router.post('/game/index', async (req, res) => {
  try {
    const data = await apiCall('/game/index', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error calling /game/index:', error);
    res.status(500).json({ error: 'Failed to fetch game index data' });
  }
});

module.exports = router;
