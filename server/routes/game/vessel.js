/**
 * @fileoverview Vessel Management Routes
 *
 * This module provides comprehensive endpoints for vessel operations including:
 * - Listing vessels in harbor
 * - Purchasing and selling vessels
 * - Vessel repairs and maintenance
 * - Vessel renaming
 * - Bulk operations with progress notifications
 *
 * Key Features:
 * - Get vessels in harbor with status and cargo information
 * - Purchase vessels with custom configuration
 * - Sell vessels individually or in bulk
 * - Repair vessels based on wear threshold
 * - Rename vessels
 * - Broadcast notifications for bulk operations
 * - Audit logging for all transactions
 * - WebSocket updates for real-time UI synchronization
 *
 * @requires express - Router and middleware
 * @requires fs - File system operations (promises)
 * @requires validator - Input sanitization
 * @requires ../../utils/api - API helper functions
 * @requires ../../gameapi - Game API interface
 * @requires ../../state - Global state management
 * @requires ../../autopilot - For capacity caching
 * @requires ../../settings-schema - Settings file utilities
 * @requires ../../utils/audit-logger - Transaction logging
 * @requires ../../websocket - WebSocket broadcasting
 * @requires ../../utils/logger - Logging utility
 * @module server/routes/game/vessel
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const validator = require('validator');
const { apiCall, apiCallWithRetry, getUserId } = require('../../utils/api');
const gameapi = require('../../gameapi');
const { broadcastToUser } = require('../../websocket');
const logger = require('../../utils/logger');
const autopilot = require('../../autopilot');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../../utils/audit-logger');
const { getFuelConsumptionDisplay } = require('../../utils/fuel-calculator');
const { getAppDataDir } = require('../../config');

// Determine vessel data directories based on environment
const isPkg = !!process.pkg;
const VESSEL_APPEARANCES_DIR = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'vessel-appearances')
  : path.join(__dirname, '../../../userdata/vessel-appearances');
const VESSEL_IMAGES_DIR = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'vessel-images')
  : path.join(__dirname, '../../../userdata/vessel-images');

const router = express.Router();

/**
 * Fetch current user data from API, update cache and broadcast
 * @param {string} userId - User ID
 */
async function refreshAndBroadcastHeader(userId) {
  try {
    const state = require('../../state');

    // 1. Get anchor_points from the small API (not /game/index!)
    const response = await apiCall('/user/get-user-settings', 'POST', {});
    const user = response?.user;
    const gameSettings = response?.data?.settings;

    if (!user || !gameSettings || gameSettings.anchor_points === undefined) {
      logger.warn('[Vessel] No user/settings in API response');
      return;
    }

    // 2. Fetch vessel counts fresh from API (cache may be stale after vessel build)
    const gameIndex = await apiCall('/game/index', 'POST', {});
    const vessels = gameIndex?.data?.user_vessels || [];
    const totalVessels = vessels.length;
    const pendingVessels = vessels.filter(v => v.status === 'pending').length;

    // Update vessel counts cache for other modules
    const readyToDepart = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
    const atAnchor = vessels.filter(v => v.status === 'anchor').length;
    state.updateVesselCounts(userId, { readyToDepart, atAnchor, pending: pendingVessels, total: totalVessels });

    // 3. Calculate available: max - delivered - pending
    const maxAnchorPoints = gameSettings.anchor_points;
    const deliveredVessels = totalVessels - pendingVessels;
    const availableCapacity = maxAnchorPoints - deliveredVessels - pendingVessels;

    // 4. Get pending anchor points from settings (for anchor build timer)
    const settings = state.getSettings(userId);
    const anchorNextBuild = gameSettings.anchor_next_build || null;
    const now = Math.floor(Date.now() / 1000);
    const pendingAnchorPoints = (anchorNextBuild && anchorNextBuild > now) ? (settings?.pendingAnchorPoints || 0) : 0;

    const currentHeaderData = state.getHeaderData(userId) || {};

    const newHeaderData = {
      stock: currentHeaderData.stock || {
        value: user.stock_value,
        trend: user.stock_trend,
        ipo: user.ipo
      },
      anchor: {
        available: availableCapacity,
        max: maxAnchorPoints,
        pending: pendingAnchorPoints,
        nextBuild: anchorNextBuild
      }
    };

    // Update cache
    state.updateHeaderData(userId, newHeaderData);

    // Broadcast immediately
    broadcastToUser(userId, 'header_data_update', newHeaderData);

    logger.info(`[Vessel] Header refresh: anchor=${newHeaderData.anchor.available}/${newHeaderData.anchor.max}`);
  } catch (err) {
    logger.warn('[Vessel] Failed to refresh header:', err.message);
  }
}

// Maximum file size for uploaded images (20MB)
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/**
 * Validate that uploaded data is actually an image
 * Checks magic bytes to prevent malicious file uploads
 * @param {string} base64Data - Base64 encoded image data (with or without data URI prefix)
 * @returns {{valid: boolean, type: string|null, error: string|null}}
 */
function validateImageData(base64Data) {
  if (!base64Data) {
    return { valid: false, type: null, error: 'No image data provided' };
  }

  // Remove data URI prefix if present
  const base64Only = base64Data.replace(/^data:image\/\w+;base64,/, '');

  // Check base64 length (rough size estimate: base64 is ~33% larger than binary)
  const estimatedSize = (base64Only.length * 3) / 4;
  if (estimatedSize > MAX_IMAGE_SIZE) {
    return { valid: false, type: null, error: `Image too large. Maximum size is ${MAX_IMAGE_SIZE / 1024 / 1024}MB` };
  }

  // Decode first bytes to check magic numbers
  let buffer;
  try {
    buffer = Buffer.from(base64Only, 'base64');
  } catch {
    return { valid: false, type: null, error: 'Invalid base64 encoding' };
  }

  if (buffer.length < 8) {
    return { valid: false, type: null, error: 'File too small to be a valid image' };
  }

  // Check magic bytes for common image formats
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { valid: true, type: 'jpeg', error: null };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return { valid: true, type: 'png', error: null };
  }

  // GIF: 47 49 46 38 (GIF8)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return { valid: true, type: 'gif', error: null };
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF...WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return { valid: true, type: 'webp', error: null };
  }

  return { valid: false, type: null, error: 'Invalid image format. Supported formats: JPEG, PNG, GIF, WebP' };
}

/**
 * GET /api/vessel/get-vessels
 * Retrieves all vessels currently in harbor
 *
 * Uses /game/index endpoint to get complete vessel list with status, cargo, maintenance needs, etc.
 * Also caches company_type in local settings for offline access.
 *
 * @route GET /api/vessel/get-vessels
 *
 * @returns {object} Vessel data:
 *   - vessels {array} - All user vessels with full details
 *   - experience_points {number} - Current experience points
 *   - levelup_experience_points {number} - Experience needed for next level
 *   - company_type {object} - Company type configuration
 *
 * @error 500 - Failed to retrieve vessels
 *
 * Side effects:
 * - Caches company_type to local settings file
 */
router.get('/get-vessels', async (req, res) => {
  try {
    const data = await apiCallWithRetry('/game/index', 'POST', {});

    // Cache company_type in local settings for offline access
    const userId = getUserId();
    if (userId && data.user?.company_type) {
      try {
        const { getSettingsFilePath } = require('../../settings-schema');
        const settingsFile = getSettingsFilePath(userId);

        // Read current settings
        const settingsData = await fs.readFile(settingsFile, 'utf8');
        const settings = JSON.parse(settingsData);

        // Update company_type
        settings.company_type = data.user.company_type;

        // Write back to file
        await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');

        logger.debug(`[Vessel API] Cached company_type: ${JSON.stringify(data.user.company_type)}`);
      } catch (cacheError) {
        // Don't fail the request if caching fails
        logger.warn('[Vessel API] Failed to cache company_type:', cacheError.message);
      }
    }

    // Enrich vessels with fuel consumption data
    const enrichedVessels = data.data.user_vessels ? data.data.user_vessels.map(vessel => ({
      ...vessel,
      fuel_consumption_display: getFuelConsumptionDisplay(vessel, userId)
    })) : [];

    res.json({
      vessels: enrichedVessels,
      experience_points: data.data.experience_points,
      levelup_experience_points: data.data.levelup_experience_points,
      company_type: data.user?.company_type
    });
  } catch (error) {
    logger.error('Error getting vessels:', error);
    res.status(500).json({ error: 'Failed to retrieve vessels' });
  }
});

/**
 * GET /api/vessel/get-all-acquirable
 * Fetches all vessels available for purchase from the marketplace
 *
 * @route GET /api/vessel/get-all-acquirable
 *
 * @returns {object} Acquirable vessels data from game API
 *
 * @error 500 - Failed to retrieve acquirable vessels
 */
router.get('/get-all-acquirable', async (req, res) => {
  try {
    const data = await apiCall('/vessel/get-all-acquirable-vessels', 'POST', {});

    // Enrich vessels with fuel consumption data
    if (data && data.data && data.data.vessels_for_sale) {
      data.data.vessels_for_sale = data.data.vessels_for_sale.map(vessel => ({
        ...vessel,
        fuel_consumption_display: getFuelConsumptionDisplay(vessel)
      }));
    }

    res.json(data);
  } catch (error) {
    logger.error('Error getting acquirable vessels:', error);
    res.status(500).json({ error: 'Failed to retrieve acquirable vessels' });
  }
});

/**
 * POST /api/vessel/get-sell-price
 * Gets the selling price for a vessel
 *
 * Returns the selling price and original price for a user-owned vessel.
 *
 * @route POST /api/vessel/get-sell-price
 * @body {number} vessel_id - ID of the vessel to check price for
 *
 * @returns {object} Selling price data from game API
 *
 * @error 400 - Missing vessel_id
 * @error 500 - Failed to get sell price
 */
router.post('/get-sell-price', express.json(), async (req, res) => {
  const { vessel_id } = req.body;

  if (!vessel_id) {
    return res.status(400).json({ error: 'Missing vessel_id' });
  }

  try {
    const data = await apiCall('/vessel/get-sell-price', 'POST', { vessel_id });
    res.json(data);
  } catch (error) {
    logger.error(`[Get Sell Price] Failed for vessel ${vessel_id}:`, error.message);
    res.status(500).json({ error: 'Failed to get sell price', message: error.message });
  }
});

/**
 * POST /api/vessel/sell-vessels
 * Sells multiple vessels by their IDs
 *
 * Accepts an array of vessel IDs and sells each one individually.
 * Broadcasts notifications and bunker updates to all connected clients.
 *
 * @route POST /api/vessel/sell-vessels
 * @body {array} vessel_ids - Array of vessel IDs to sell
 *
 * @returns {object} Sale results:
 *   - success {boolean} - Operation success
 *   - sold {number} - Number of vessels successfully sold
 *   - errors {array} - Any errors that occurred (optional)
 *
 * @error 400 - Missing or invalid vessel_ids array
 * @error 500 - Failed to sell vessels
 *
 * Side effects:
 * - Broadcasts bunker update (cash increased)
 * - Sends error notifications if sale fails
 */
router.post('/sell-vessels', express.json(), async (req, res) => {
  const { vessel_ids } = req.body;

  if (!vessel_ids || !Array.isArray(vessel_ids) || vessel_ids.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid vessel_ids array' });
  }

  try {
    const userId = getUserId();

    // Fetch vessel details BEFORE selling to get prices
    let vesselDetails = [];
    const vesselPriceMap = new Map();

    try {
      const gameData = await apiCallWithRetry('/game/index', 'POST', {});
      const allVessels = gameData.data?.vessels || [];
      vesselDetails = allVessels.filter(v => vessel_ids.includes(v.id));

      // Build price map from vessel details (BEFORE selling)
      vesselDetails.forEach(v => {
        if (v.sell_price) {
          vesselPriceMap.set(v.id, v.sell_price);
        }
      });

      logger.debug(`[Vessel Sell] Fetched prices for ${vesselPriceMap.size} vessels before selling`);
    } catch (error) {
      logger.warn('[Vessel Sell] Failed to fetch vessel details for audit log:', error.message);
    }

    let soldCount = 0;
    const errors = [];
    const soldVessels = []; // Track sold vessels for audit log
    let lastUserData = null; // Track latest user data from sell responses

    // Sell each vessel individually (API only supports single vessel sales)
    for (const vesselId of vessel_ids) {
      try {
        const data = await apiCall('/vessel/sell-vessel', 'POST', { vessel_id: vesselId });
        if (data.success) {
          soldCount++;

          // Store user data from response (each sell returns updated user state)
          if (data.user) {
            lastUserData = data.user;
          }

          // Use price from BEFORE selling (from /game/index) or fall back to API response
          const sellPrice = vesselPriceMap.get(vesselId) || data.vessel?.sell_price || 0;
          const vesselInfo = vesselDetails.find(v => v.id === vesselId);

          if (sellPrice === 0) {
            logger.error(`[Vessel Sell] Vessel ${vesselId} sold but no price found (neither in /game/index nor in API response)`);
          } else {
            logger.debug(`[Vessel Sell] Vessel ${vesselId} sold for $${sellPrice.toLocaleString()}`);
          }

          // Track for audit log
          soldVessels.push({
            id: vesselId,
            name: vesselInfo?.name || `Vessel ${vesselId}`,
            sell_price: sellPrice
          });

          // Delete custom vessel image and appearance data
          const svgFile = path.join(VESSEL_IMAGES_DIR, `${userId}_${vesselId}.svg`);
          const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${userId}_${vesselId}.json`);

          await fs.unlink(svgFile).catch(() => {});
          await fs.unlink(appearanceFile).catch(() => {});
          logger.debug(`[Vessel Sell] Cleaned up custom vessel files for ${vesselId}`);
        }
      } catch (error) {
        logger.error(`[Vessel Sell] Failed to sell vessel ${vesselId}:`, error.message);
        errors.push({ vesselId, error: error.message });
      }
    }

    // Broadcast updated bunker state using user data from sell response (no extra API call!)
    if (lastUserData) {
      const cachedCapacity = autopilot.getCachedCapacity(userId);

      broadcastToUser(userId, 'bunker_update', {
        fuel: lastUserData.fuel / 1000,
        co2: (lastUserData.co2 || lastUserData.co2_certificate) / 1000,
        cash: lastUserData.cash,
        maxFuel: cachedCapacity.maxFuel,
        maxCO2: cachedCapacity.maxCO2
      });
      logger.debug(`[Vessel Sell] Broadcast bunker update from sell response: cash=$${lastUserData.cash?.toLocaleString()}`);
    }

    // Refresh header from API and broadcast
    await refreshAndBroadcastHeader(userId);

    // AUDIT LOG: Vessel sale
    if (soldVessels.length > 0) {
      try {
        const totalPrice = soldVessels.reduce((sum, v) => sum + v.sell_price, 0);

        await auditLog(
          userId,
          CATEGORIES.VESSEL,
          'Manual Vessel Sale',
          `Sold ${soldVessels.length} vessel${soldVessels.length > 1 ? 's' : ''} for ${formatCurrency(totalPrice)}`,
          {
            vessel_count: soldVessels.length,
            total_price: totalPrice,
            vessels: soldVessels.map(v => ({
              id: v.id,
              name: v.name,
              sell_price: v.sell_price
            }))
          },
          'SUCCESS',
          SOURCES.MANUAL
        );
      } catch (auditError) {
        logger.error('[Vessel Sell] Audit logging failed:', auditError.message);
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
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `⛴️ <strong>Sale Failed</strong><br><br>${safeErrorMessage}`
      });
    }
    res.status(500).json({ error: 'Failed to sell vessels' });
  }
});

/**
 * POST /api/vessel/purchase-vessel
 * Purchases a new vessel with specified configuration
 *
 * Default configuration: 4-blade propeller, optional antifouling, no enhanced deck beams.
 * Validation: vessel_id and name are required fields.
 *
 * @route POST /api/vessel/purchase-vessel
 * @body {number} vessel_id - ID of vessel type to purchase
 * @body {string} name - Name for the new vessel
 * @body {string} [antifouling_model] - Optional antifouling type
 * @body {number} [count] - Number of vessels being purchased (for notification)
 * @body {boolean} [silent] - If true, suppresses notifications
 *
 * @returns {object} Purchase result from game API
 *
 * @error 400 - Invalid vessel_id, name, or other parameters
 * @error 500 - Failed to purchase vessel
 *
 * Side effects:
 * - Sends purchase notification (unless silent)
 * - Updates bunker display (cash decreased)
 * - Updates vessel count badges
 */
router.post('/purchase-vessel', express.json(), async (req, res) => {
  const { vessel_id, name, antifouling_model, count, silent } = req.body;

  // Validate required fields
  if (!vessel_id || !name) {
    return res.status(400).json({ error: 'Missing required fields: vessel_id, name' });
  }

  // Validate vessel_id is a positive integer
  if (!Number.isInteger(vessel_id) || vessel_id <= 0) {
    return res.status(400).json({ error: 'Invalid vessel_id. Must be a positive integer' });
  }

  // Validate name is a string with reasonable length
  if (typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid name. Must be a string' });
  }

  if (name.length < 1 || name.length > 100) {
    return res.status(400).json({ error: 'Invalid name length. Must be between 1 and 100 characters' });
  }

  // Validate antifouling_model if provided
  if (antifouling_model !== undefined && antifouling_model !== null && typeof antifouling_model !== 'string') {
    return res.status(400).json({ error: 'Invalid antifouling_model. Must be a string or null' });
  }

  try {
    const userId = getUserId();

    // Fetch vessel price BEFORE purchasing
    let vesselCost = 0;
    try {
      const acquirableData = await apiCall('/vessel/get-all-acquirable-vessels', 'POST', {});
      const vessels = acquirableData.data?.vessels_for_sale || [];
      const vessel = vessels.find(v => v.id === vessel_id);
      if (vessel && vessel.price) {
        vesselCost = vessel.price;
        logger.debug(`[Vessel Purchase] Fetched price $${vesselCost.toLocaleString()} for vessel ${vessel_id} before purchasing`);
      } else {
        logger.warn(`[Vessel Purchase] Could not find vessel ${vessel_id} in acquirable vessels list (${vessels.length} vessels available)`);
      }
    } catch (priceError) {
      logger.warn('[Vessel Purchase] Failed to fetch vessel price before purchase:', priceError.message);
    }

    const data = await apiCall('/vessel/purchase-vessel', 'POST', {
      vessel_id,
      name,
      adjust_speed: '4_blade_propeller',
      antifouling_model: antifouling_model || null,
      enhanced_deck_beams: 0
    });

    // Broadcast notification to all clients (unless silent=true)
    if (userId && data.user_vessel && !silent) {
      const vesselName = data.user_vessel.name || name;
      const purchaseCount = count || 1;
      const safeVesselName = validator.escape(vesselName);

      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `🚢 <strong>Purchase Successful!</strong><br><br>Purchased ${purchaseCount}x ${safeVesselName}`
      });
    }

    // Broadcast bunker update (cash decreased from purchase)
    if (userId && data.user) {
      broadcastToUser(userId, 'bunker_update', {
        cash: data.user.cash
      });
      logger.debug(`[Vessel Purchase] Broadcast cash update: $${data.user.cash.toLocaleString()}`);
    }

    // Refresh header from API and broadcast
    if (userId) {
      await refreshAndBroadcastHeader(userId);
    }

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing vessel:', error);

    const userId = getUserId();
    if (userId && !silent) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🚢 <strong>Purchase Failed</strong><br><br>${safeErrorMessage}`
      });
    }

    res.status(500).json({ error: 'Failed to purchase vessel' });
  }
});

/**
 * POST /api/vessel/bulk-buy-start
 * Broadcasts bulk buy start to lock buttons across all clients
 *
 * @route POST /api/vessel/bulk-buy-start
 *
 * @returns {object} Success status
 *
 * @error 401 - Not authenticated
 * @error 500 - Failed to broadcast start
 *
 * Side effects:
 * - Broadcasts bulk_buy_start event to lock UI
 */
router.post('/bulk-buy-start', express.json(), async (req, res) => {
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
 * POST /api/vessel/broadcast-purchase-summary
 * Broadcasts a summary notification of vessel purchases to all clients
 *
 * @route POST /api/vessel/broadcast-purchase-summary
 * @body {array} vessels - Array of purchased vessel details
 * @body {number} totalCost - Total cost of all purchases
 *
 * @returns {object} Success status
 *
 * @error 400 - Missing required field: vessels
 * @error 401 - Not authenticated
 * @error 500 - Failed to broadcast summary
 *
 * Side effects:
 * - Sends formatted purchase summary notification
 * - Logs purchase to audit log
 * - Broadcasts bulk_buy_complete to unlock UI
 * - Triggers harbor map refresh
 */
router.post('/broadcast-purchase-summary', express.json(), async (req, res) => {
  const { vessels, totalCost } = req.body;

  if (!vessels || !Array.isArray(vessels)) {
    return res.status(400).json({ error: 'Missing required field: vessels (array)' });
  }

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Group vessels by name for display
    const vesselGroups = vessels.reduce((acc, v) => {
      if (!acc[v.name]) {
        acc[v.name] = { name: v.name, quantity: 0, price: v.price, totalPrice: 0 };
      }
      acc[v.name].quantity++;
      acc[v.name].totalPrice += v.price;
      return acc;
    }, {});
    const groupedVessels = Object.values(vesselGroups);

    // Build vessel list HTML with prices
    let vesselListHtml = '';
    if (groupedVessels.length > 5) {
      // If more than 5 types, show scrollable list
      vesselListHtml = '<div style="max-height: 200px; overflow-y: auto; margin: 10px 0; padding-right: 5px;"><ul style="margin: 0; padding-left: 20px; text-align: left;">';
      groupedVessels.forEach(v => {
        vesselListHtml += `<li>${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}</li>`;
      });
      vesselListHtml += '</ul></div>';
    } else {
      // If 5 or fewer types, show simple list
      vesselListHtml = '<br>';
      groupedVessels.forEach(v => {
        vesselListHtml += `${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}<br>`;
      });
    }

    const message = `🚢 <strong>Purchased ${vessels.length} vessel${vessels.length > 1 ? 's' : ''}!</strong>${vesselListHtml}Total Cost: $${totalCost.toLocaleString()}`;

    broadcastToUser(userId, 'user_action_notification', {
      type: 'success',
      message
    });

    // AUDIT LOG: Manual vessel purchase - Log matching the notification message
    // (using audit-logger imported at top of file)
    try {
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Vessel Purchase',
        `Purchased ${vessels.length} vessel${vessels.length > 1 ? 's' : ''}! Total Cost: $${totalCost.toLocaleString()}`,
        {
          vessel_count: vessels.length,
          total_cost: totalCost,
          vessels: groupedVessels.map(v => ({
            name: v.name,
            quantity: v.quantity,
            price_per_vessel: v.price,
            total_price: v.totalPrice
          }))
        },
        'SUCCESS',
        SOURCES.MANUAL
      );
    } catch (auditError) {
      logger.error('[Vessel Purchase] Audit logging failed:', auditError.message);
    }

    // Broadcast bulk buy complete to unlock buttons
    broadcastToUser(userId, 'bulk_buy_complete', {
      count: vessels.length
    });

    // Trigger Harbor Map refresh (vessels purchased)
    const { broadcastHarborMapRefresh } = require('../../websocket');
    if (broadcastHarborMapRefresh) {
      broadcastHarborMapRefresh(userId, 'vessels_purchased', {
        count: vessels.length
      });
    }

    // Update anchor points - just decrement available by purchased count (no extra API call needed!)
    const state = require('../../state');
    const currentHeaderData = state.getHeaderData(userId);
    const currentAnchor = currentHeaderData?.anchor;

    if (currentAnchor && currentAnchor.available !== undefined) {
      const newAnchor = {
        available: currentAnchor.available - vessels.length,
        max: currentAnchor.max,
        pending: currentAnchor.pending
      };

      // Update state cache
      state.updateHeaderData(userId, {
        ...currentHeaderData,
        anchor: newAnchor
      });

      // Broadcast immediately
      broadcastToUser(userId, 'header_data_update', {
        stock: currentHeaderData?.stock,
        anchor: newAnchor
      });
      logger.info(`[Bulk Purchase] Broadcast anchor update: ${newAnchor.available}/${newAnchor.max} (-${vessels.length})`);
    } else {
      logger.warn('[Bulk Purchase] Could not update anchor points - no cached anchor data');
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting purchase summary:', error);
    res.status(500).json({ error: 'Failed to broadcast summary' });
  }
});

/**
 * POST /api/vessel/broadcast-sale-summary
 * Broadcasts a summary notification of vessel sales to all clients
 *
 * @route POST /api/vessel/broadcast-sale-summary
 * @body {array} vessels - Array of sold vessel details
 * @body {number} totalPrice - Total revenue from sales
 * @body {number} totalVessels - Total number of vessels sold
 *
 * @returns {object} Success status
 *
 * @error 400 - Missing required field: vessels
 * @error 401 - Not authenticated
 * @error 500 - Failed to broadcast summary
 *
 * Side effects:
 * - Sends formatted sale summary notification
 * - Logs sale to audit log
 * - Triggers harbor map refresh
 */
router.post('/broadcast-sale-summary', express.json(), async (req, res) => {
  const { vessels, totalPrice, totalVessels } = req.body;

  if (!vessels || !Array.isArray(vessels)) {
    return res.status(400).json({ error: 'Missing required field: vessels (array)' });
  }

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Build vessel list HTML with prices
    let vesselListHtml = '';
    if (vessels.length > 5) {
      // If more than 5, show scrollable list
      vesselListHtml = '<div style="max-height: 200px; overflow-y: auto; margin: 10px 0; padding-right: 5px;"><ul style="margin: 0; padding-left: 20px; text-align: left;">';
      vessels.forEach(v => {
        vesselListHtml += `<li>${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}</li>`;
      });
      vesselListHtml += '</ul></div>';
    } else {
      // If 5 or fewer, show simple list
      vesselListHtml = '<br>';
      vessels.forEach(v => {
        vesselListHtml += `${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}<br>`;
      });
    }

    const message = `⛴️ <strong>Sold ${totalVessels} vessel${totalVessels > 1 ? 's' : ''}!</strong>${vesselListHtml}Total Revenue: $${totalPrice.toLocaleString()}`;

    broadcastToUser(userId, 'user_action_notification', {
      type: 'success',
      message
    });

    // AUDIT LOG: Manual vessel sale - Log matching the notification message
    // (using audit-logger imported at top of file)
    try {
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Vessel Sale',
        `Sold ${totalVessels} vessel${totalVessels > 1 ? 's' : ''}! Total Revenue: $${totalPrice.toLocaleString()}`,
        {
          vessel_count: totalVessels,
          total_price: totalPrice,
          vessels: vessels.map(v => ({
            name: v.name,
            quantity: v.quantity,
            price_per_vessel: v.price,
            total_price: v.totalPrice
          }))
        },
        'SUCCESS',
        SOURCES.MANUAL
      );
    } catch (auditError) {
      logger.error('[Vessel Sale] Audit logging failed:', auditError.message);
    }

    // Trigger Harbor Map refresh (vessels sold)
    const { broadcastHarborMapRefresh } = require('../../websocket');
    if (broadcastHarborMapRefresh) {
      broadcastHarborMapRefresh(userId, 'vessels_sold', {
        count: totalVessels
      });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting sale summary:', error);
    res.status(500).json({ error: 'Failed to broadcast summary' });
  }
});

/**
 * POST /api/vessel/get-repair-preview
 * Gets repair preview with vessel list and costs
 *
 * @route POST /api/vessel/get-repair-preview
 * @body {number} threshold - Wear percentage threshold (0-100)
 *
 * @returns {object} Repair preview:
 *   - vessels {array} - Vessels needing repair with costs
 *   - totalCost {number} - Total repair cost
 *   - cash {number} - User's current cash
 *
 * @error 400 - Invalid threshold
 * @error 500 - Failed to get repair preview
 */
router.post('/get-repair-preview', express.json(), async (req, res) => {
  const { threshold } = req.body;

  if (threshold === null || threshold === undefined || threshold < 0 || threshold > 100) {
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

/**
 * POST /api/vessel/bulk-repair
 * Repairs all vessels needing maintenance based on threshold
 *
 * @route POST /api/vessel/bulk-repair
 * @body {number} threshold - Wear percentage threshold (0-100)
 *
 * @returns {object} Repair results:
 *   - count {number} - Number of vessels repaired
 *   - totalCost {number} - Total repair cost
 *   - vessels {array} - Details of repaired vessels
 *
 * @error 400 - Invalid threshold or not enough cash
 * @error 500 - Failed to repair vessels
 *
 * Side effects:
 * - Broadcasts repair start/complete events
 * - Updates bunker display (cash decreased)
 * - Logs repairs to audit log
 * - Sends success/error notifications
 */
router.post('/bulk-repair', express.json(), async (req, res) => {
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
    const state = require('../../state');
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

    // AUDIT LOG: Manual bulk repair
    // (using audit-logger imported at top of file)

    // Validate data - FAIL LOUD if missing
    if (vesselsToRepair.length === 0) {
      throw new Error('No vessels to repair');
    }

    if (actualCost === 0) {
      throw new Error('Repair cost is 0 - API data invalid');
    }

    await auditLog(
      userId,
      CATEGORIES.VESSEL,
      'Manual Bulk Repair',
      `Repaired ${vesselsToRepair.length} vessel(s) for ${formatCurrency(actualCost)}`,
      {
        vessel_count: vesselsToRepair.length,
        total_cost: actualCost,
        threshold: threshold,
        vessels: vesselDetails.map(v => {
          if (!v.cost) {
            throw new Error(`Vessel ${v.id} (${v.name}) missing cost in repair data`);
          }
          return {
            id: v.id,
            name: v.name,
            wear: v.wear,
            cost: v.cost
          };
        })
      },
      'SUCCESS',
      SOURCES.MANUAL
    );

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
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🔧 <strong>Error</strong><br><br>${safeErrorMessage}`
      });
    }

    res.status(500).json({ error: 'Failed to repair vessels' });
  }
});

/**
 * POST /api/vessel/rename-vessel
 * Rename a vessel
 *
 * @route POST /api/vessel/rename-vessel
 * @body {number} vessel_id - ID of vessel to rename
 * @body {string} name - New name for the vessel (2-30 characters)
 *
 * @returns {object} Rename result from game API
 *
 * @error 400 - Invalid vessel_id or name
 * @error 500 - Failed to rename vessel
 *
 * Side effects:
 * - Triggers harbor map refresh with vessel_renamed event
 */
router.post('/rename-vessel', express.json(), async (req, res) => {
  try {
    const { vessel_id, name } = req.body;

    // Validate input
    if (!vessel_id) {
      return res.status(400).json({ error: 'Vessel ID is required' });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Vessel name is required' });
    }

    // Validate name length (2-30 characters)
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 30) {
      return res.status(400).json({ error: 'Vessel name must be between 2 and 30 characters' });
    }

    logger.info(`[Vessel Rename] Renaming vessel ${vessel_id} to "${trimmedName}"`);

    // Call game API
    const data = await apiCall('/vessel/rename-vessel', 'POST', {
      vessel_id: vessel_id,
      name: trimmedName
    });

    logger.info(`[Vessel Rename] Success - Vessel ${vessel_id} renamed to "${trimmedName}"`);

    // Broadcast Harbor Map refresh
    const userId = getUserId();
    if (userId) {
      const { broadcastHarborMapRefresh } = require('../../websocket');
      if (broadcastHarborMapRefresh) {
        broadcastHarborMapRefresh(userId, 'vessel_renamed', {
          vessel_id: vessel_id,
          new_name: trimmedName
        });
      }
    }

    res.json(data);
  } catch (error) {
    logger.error('[Vessel Rename] Error:', error.message);
    res.status(500).json({ error: 'Failed to rename vessel' });
  }
});

/**
 * POST /api/vessel/park-vessel
 * Parks a vessel (moors it)
 */
router.post('/park-vessel', express.json(), async (req, res) => {
  const { vessel_id } = req.body;

  if (!vessel_id) {
    return res.status(400).json({ error: 'Missing vessel_id' });
  }

  try {
    const data = await apiCall('/vessel/park-vessel', 'POST', { vessel_id });
    logger.info(`[Park Vessel] Vessel ${vessel_id} parked successfully`);
    res.json(data);
  } catch (error) {
    logger.error(`[Park Vessel] Failed for vessel ${vessel_id}:`, error.message);
    res.status(500).json({ error: 'Failed to park vessel', message: error.message });
  }
});

/**
 * POST /api/vessel/resume-parked-vessel
 * Resumes a parked vessel (unmoores it)
 */
router.post('/resume-parked-vessel', express.json(), async (req, res) => {
  const { vessel_id } = req.body;

  if (!vessel_id) {
    return res.status(400).json({ error: 'Missing vessel_id' });
  }

  try {
    const data = await apiCall('/vessel/resume-parked-vessel', 'POST', { vessel_id });
    logger.info(`[Resume Parked Vessel] Vessel ${vessel_id} resumed successfully`);
    res.json(data);
  } catch (error) {
    logger.error(`[Resume Parked Vessel] Failed for vessel ${vessel_id}:`, error.message);
    res.status(500).json({ error: 'Failed to resume parked vessel', message: error.message });
  }
});

/**
 * POST /api/vessel/build-vessel
 * Builds a new custom vessel from scratch
 *
 * Allows users to configure:
 * - Vessel type (container/tanker)
 * - Capacity (2000-27000 TEU or 148000-1998000 BBL)
 * - Engine type and power (6 engine options with configurable KW)
 * - Delivery port (36 shipyard options)
 * - Perks (antifouling, bulbous bow, propellers, enhanced thrusters)
 *
 * @route POST /api/vessel/build-vessel
 * @body {string} name - Vessel name (1-50 characters)
 * @body {string} ship_yard - Shipyard port code
 * @body {string} vessel_model - 'container' or 'tanker'
 * @body {string} engine_type - Engine model (mih_x1, wartsila_syk_6, man_p22l, mih_xp9, man_p22l_z, mih_cp9)
 * @body {number} engine_kw - Engine power in kW (within engine's min/max range)
 * @body {number} capacity - Vessel capacity (TEU or BBL)
 * @body {string|null} antifouling_model - Antifouling type ('type_a', 'type_b', or null)
 * @body {number} bulbous - Bulbous bow (0 or 1)
 * @body {number} enhanced_thrusters - Enhanced thrusters (0 or 1)
 * @body {number} range - Vessel range in nautical miles
 * @body {string} propeller_types - Propeller type ('4_blade_propeller', '5_blade_propeller', '6_blade_propeller')
 *
 * @returns {object} Build result from game API
 *
 * @error 400 - Invalid or missing parameters
 * @error 500 - Failed to build vessel
 *
 * Side effects:
 * - Sends build notification
 * - Updates bunker display (cash decreased)
 * - Updates vessel count badges (pending vessel added)
 * - Logs build to audit log
 */
router.post('/build-vessel', express.json(), async (req, res) => {
  const {
    name,
    ship_yard,
    vessel_model,
    engine_type,
    engine_kw,
    capacity,
    antifouling_model,
    bulbous,
    enhanced_thrusters,
    range,
    speed,
    fuel_consumption,
    propeller_types,
    hull_color,
    deck_color,
    bridge_color,
    container_color_1,
    container_color_2,
    container_color_3,
    container_color_4,
    name_color,
    custom_image,
    build_price
  } = req.body;

  // Validate required fields
  if (!name || !ship_yard || !vessel_model || !engine_type || !engine_kw || !capacity || !range || !propeller_types) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate name
  if (typeof name !== 'string' || name.length < 1 || name.length > 50) {
    return res.status(400).json({ error: 'Invalid name. Must be 1-50 characters' });
  }

  // Validate vessel_model
  if (!['container', 'tanker'].includes(vessel_model)) {
    return res.status(400).json({ error: 'Invalid vessel_model. Must be "container" or "tanker"' });
  }

  // Validate capacity ranges
  if (vessel_model === 'container' && (capacity < 2000 || capacity > 27000)) {
    return res.status(400).json({ error: 'Invalid capacity for container. Must be 2000-27000 TEU' });
  }
  if (vessel_model === 'tanker' && (capacity < 148000 || capacity > 1998000)) {
    return res.status(400).json({ error: 'Invalid capacity for tanker. Must be 148000-1998000 BBL' });
  }

  // Validate engine type and KW ranges
  const validEngines = {
    mih_x1: { min: 2500, max: 11000 },
    wartsila_syk_6: { min: 5000, max: 15000 },
    man_p22l: { min: 8000, max: 17500 },
    mih_xp9: { min: 10000, max: 20000 },
    man_p22l_z: { min: 15000, max: 25000 },
    mih_cp9: { min: 25000, max: 60000 }
  };

  if (!validEngines[engine_type]) {
    return res.status(400).json({ error: 'Invalid engine_type' });
  }

  const engineLimits = validEngines[engine_type];
  if (engine_kw < engineLimits.min || engine_kw > engineLimits.max) {
    return res.status(400).json({
      error: `Invalid engine_kw for ${engine_type}. Must be ${engineLimits.min}-${engineLimits.max} kW`
    });
  }

  // Validate propeller types
  if (!['4_blade_propeller', '5_blade_propeller', '6_blade_propeller'].includes(propeller_types)) {
    return res.status(400).json({ error: 'Invalid propeller_types' });
  }

  // Validate antifouling
  if (antifouling_model !== null && !['type_a', 'type_b'].includes(antifouling_model)) {
    return res.status(400).json({ error: 'Invalid antifouling_model' });
  }

  // Validate bulbous and enhanced_thrusters
  if (![0, 1].includes(bulbous) || ![0, 1].includes(enhanced_thrusters)) {
    return res.status(400).json({ error: 'Invalid bulbous or enhanced_thrusters. Must be 0 or 1' });
  }

  // Validate custom image if provided
  if (custom_image && custom_image.startsWith('data:image/')) {
    const validation = validateImageData(custom_image);
    if (!validation.valid) {
      logger.warn(`[Build Vessel] Invalid custom image: ${validation.error}`);
      return res.status(400).json({ error: validation.error });
    }
  }

  try {
    const userId = getUserId();

    // Forward build request to game API
    const data = await apiCall('/vessel/build-vessel', 'POST', {
      name,
      ship_yard,
      vessel_model,
      engine_type,
      engine_kw,
      capacity,
      antifouling_model,
      bulbous,
      enhanced_thrusters,
      range,
      propeller_types
    });

    // Check if API returned an error
    if (data.error) {
      logger.warn(`[Build Vessel] API rejected build request: ${data.error}`);
      return res.status(400).json({ error: data.error });
    }

    // Verify build was successful - API returns { data: { success: true }, user: {...} }
    if (!data.data?.success) {
      logger.error('[Build Vessel] API did not confirm success');
      return res.status(500).json({ error: 'Build failed - API did not confirm' });
    }

    logger.info(`[Build Vessel] Built vessel "${name}" (${vessel_model}, ${capacity} ${vessel_model === 'container' ? 'TEU' : 'BBL'}, ${engine_type} ${engine_kw}kW)`);

    // Fetch vessel list to get the new vessel's ID (API doesn't return it directly)
    // Retry up to 3 times with delay - API sometimes needs time to register the new vessel
    let newVesselId = null;
    const maxRetries = 3;
    const retryDelay = 500; // ms

    for (let attempt = 1; attempt <= maxRetries && !newVesselId; attempt++) {
      try {
        if (attempt > 1) {
          logger.debug(`[Build Vessel] Retry ${attempt}/${maxRetries} - waiting ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }

        const vesselsData = await apiCall('/vessel/get-vessels', 'GET');
        const pendingVessels = vesselsData.data?.user_vessels?.filter(v =>
          v.status === 'pending' || v.status === 'delivery'
        ) || [];

        // First try exact name match
        let newVessel = pendingVessels.find(v => v.name === name);

        // If not found by name, take the newest pending vessel (highest ID)
        if (!newVessel && pendingVessels.length > 0) {
          newVessel = pendingVessels.reduce((newest, v) =>
            v.id > newest.id ? v : newest
          , pendingVessels[0]);
          logger.debug(`[Build Vessel] Name match failed, using newest pending vessel: ${newVessel.id} (${newVessel.name})`);
        }

        if (newVessel) {
          newVesselId = newVessel.id;
          logger.debug(`[Build Vessel] Found new vessel ID: ${newVesselId} (status: ${newVessel.status}, attempt: ${attempt})`);
        }
      } catch (fetchError) {
        logger.warn(`[Build Vessel] Attempt ${attempt} - Could not fetch vessel ID:`, fetchError.message);
      }
    }

    if (!newVesselId) {
      logger.error('[Build Vessel] Failed to find new vessel ID after all retries');
    }

    // Store vessel appearance data if we found the vessel ID
    if (newVesselId) {
      try {
        await fs.mkdir(VESSEL_APPEARANCES_DIR, { recursive: true });

        // Check if custom image is provided
        const hasOwnImage = custom_image && custom_image.startsWith('data:image/');

        const appearanceData = {
          vesselId: newVesselId,
          name,
          vessel_model,
          capacity,
          engine_type,
          engine_kw,
          range,
          speed,
          fuel_consumption,
          antifouling_model,
          bulbous,
          enhanced_thrusters,
          propeller_types,
          hull_color: hull_color || '#b30000',
          deck_color: deck_color || '#272525',
          bridge_color: bridge_color || '#dbdbdb',
          container_color_1: container_color_1 || '#ff8000',
          container_color_2: container_color_2 || '#0000ff',
          container_color_3: container_color_3 || '#670000',
          container_color_4: container_color_4 || '#777777',
          name_color: name_color || '#ffffff',
          ownImage: hasOwnImage
        };

        const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${userId}_${newVesselId}.json`);
        await fs.writeFile(appearanceFile, JSON.stringify(appearanceData, null, 2), 'utf8');
        logger.debug(`[Build Vessel] Saved appearance data for vessel ${userId}_${newVesselId}`);

        // Save custom image if provided - to ownimages folder
        if (hasOwnImage) {
          const ownImagesDir = path.join(VESSEL_IMAGES_DIR, 'ownimages');
          await fs.mkdir(ownImagesDir, { recursive: true });
          const base64Data = custom_image.replace(/^data:image\/\w+;base64,/, '');
          const imageBuffer = Buffer.from(base64Data, 'base64');
          const imagePath = path.join(ownImagesDir, `${newVesselId}.png`);
          await fs.writeFile(imagePath, imageBuffer);
          logger.info(`[Build Vessel] Saved own image for vessel ${newVesselId}`);
        } else {
          // Generate SVG if no custom image
          const { generateVesselSvg } = require('../../utils/vessel-svg-generator');
          const svg = generateVesselSvg(appearanceData);
          const svgFilePath = path.join(VESSEL_IMAGES_DIR, `${userId}_${newVesselId}.svg`);
          await fs.writeFile(svgFilePath, svg, 'utf8');
          logger.info(`[Build Vessel] Generated SVG for vessel ${newVesselId}`);
        }
      } catch (appearanceError) {
        logger.error('[Build Vessel] Failed to save appearance:', appearanceError.message);
      }
    }

    // Use build_price from frontend (calculated before build)
    const buildCost = build_price || 0;

    // Broadcast notification with receipt-style format
    if (userId) {
      const safeVesselName = validator.escape(name);
      const capacityUnit = vessel_model === 'container' ? 'TEU' : 'BBL';
      const vesselTypeLabel = vessel_model === 'container' ? 'Container' : 'Tanker';

      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `
          <div style="font-family: monospace; font-size: 13px;">
            <div style="text-align: center; border-bottom: 2px solid rgba(255,255,255,0.3); padding-bottom: 8px; margin-bottom: 12px;">
              <strong style="font-size: 14px;">🔨 Vessel Build Started</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Vessel:</span>
              <span><strong>${safeVesselName}</strong></span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Type:</span>
              <span>${vesselTypeLabel}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Capacity:</span>
              <span><strong>${capacity.toLocaleString('en-US')} ${capacityUnit}</strong></span>
            </div>
            <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
            <div style="display: flex; justify-content: space-between; font-size: 15px;">
              <span><strong>Total:</strong></span>
              <span style="color: #ef4444;"><strong>$${buildCost.toLocaleString('en-US')}</strong></span>
            </div>
          </div>
        `
      });
    }

    // Broadcast bunker update (cash decreased from build)
    if (userId && data.user) {
      broadcastToUser(userId, 'bunker_update', {
        cash: data.user.cash
      });
      logger.debug(`[Build Vessel] Broadcast cash update: $${data.user.cash.toLocaleString()}`);
    }

    // Refresh header from API and broadcast
    if (userId) {
      await refreshAndBroadcastHeader(userId);
    }

    // AUDIT LOG: Vessel build
    try {

      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Vessel Build',
        `Built vessel "${name}" (${vessel_model}, ${capacity.toLocaleString()} ${vessel_model === 'container' ? 'TEU' : 'BBL'}) | $${buildCost.toLocaleString()}`,
        {
          name,
          vessel_model,
          capacity,
          engine_type,
          engine_kw,
          ship_yard,
          antifouling_model,
          bulbous,
          enhanced_thrusters,
          propeller_types,
          range,
          build_cost: buildCost
        },
        'SUCCESS',
        SOURCES.MANUAL
      );
    } catch (auditError) {
      logger.error('[Build Vessel] Audit logging failed:', auditError.message);
    }

    res.json(data);
  } catch (error) {
    logger.error('[Build Vessel] Error:', error);

    const userId = getUserId();
    if (userId) {
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🔨 <strong>Build Failed</strong><br><br>${safeErrorMessage}`
      });
    }

    res.status(500).json({ error: 'Failed to build vessel' });
  }
});

/**
 * GET /api/vessel/get-appearance/:vesselId
 * Get vessel appearance data (colors, ownImage flag)
 */
router.get('/get-appearance/:vesselId', async (req, res) => {
  const { vesselId } = req.params;
  const userId = getUserId();

  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  try {
    const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${userId}_${vesselId}.json`);
    const fileContent = await fs.readFile(appearanceFile, 'utf8');
    const data = JSON.parse(fileContent);
    res.json(data);
  } catch {
    // No appearance file - return defaults
    res.json({ ownImage: false });
  }
});

/**
 * POST /api/vessel/save-appearance
 * Save vessel appearance data for custom vessels (image and SVG colors only)
 *
 * Note: Fuel/Speed data is no longer needed - calculated from game API data using formula
 *
 * @route POST /api/vessel/save-appearance
 * @body {number} vesselId - Vessel ID
 * @body {string} name - Vessel name
 * @body {string} hull_color - Hull color hex
 * @body {string} deck_color - Deck color hex
 * @body {string} bridge_color - Bridge color hex
 * @body {string} name_color - Name color hex
 * @body {string} container_color_1 - Container color 1 hex
 * @body {string} container_color_2 - Container color 2 hex
 * @body {string} container_color_3 - Container color 3 hex
 * @body {string} container_color_4 - Container color 4 hex
 * @body {string} [imageData] - Base64 encoded image data
 *
 * @returns {object} Result:
 *   - success {boolean}
 *   - vesselId {number}
 *
 * @error 400 - Missing required fields
 * @error 500 - Failed to save appearance
 */
router.post('/save-appearance', express.json({ limit: '20mb' }), async (req, res) => {
  const {
    vesselId, name,
    hull_color, deck_color, bridge_color, name_color,
    container_color_1, container_color_2, container_color_3, container_color_4,
    imageData, removeOwnImage
  } = req.body;

  // Validate required fields
  if (!vesselId) {
    return res.status(400).json({ error: 'Vessel ID is required' });
  }

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  try {
    // Ensure directories exist
    await fs.mkdir(VESSEL_APPEARANCES_DIR, { recursive: true });
    await fs.mkdir(VESSEL_IMAGES_DIR, { recursive: true });

    const filePrefix = `${userId}_${vesselId}`;

    // Check if image is being uploaded
    const hasOwnImage = imageData && imageData.startsWith('data:image/');

    // Validate image data if uploading
    if (hasOwnImage) {
      const validation = validateImageData(imageData);
      if (!validation.valid) {
        logger.warn(`[Vessel Appearance] Invalid image upload attempt: ${validation.error}`);
        return res.status(400).json({ error: validation.error });
      }
      logger.debug(`[Vessel Appearance] Image validated as ${validation.type}`);
    }

    // Save appearance JSON - only if we have data to save
    const hasAppearanceData = hull_color || hasOwnImage || removeOwnImage;

    if (hasAppearanceData) {
      // Read existing appearance to preserve ownImage flag if not uploading new image
      let existingData = {};
      const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${filePrefix}.json`);
      try {
        const existing = await fs.readFile(appearanceFile, 'utf8');
        existingData = JSON.parse(existing);
      } catch {
        // File doesn't exist yet
      }

      // If existing data is missing type info, fetch from API
      if (!existingData.vessel_model && !existingData.capacity_type && !existingData.capacity) {
        logger.info(`[Vessel Appearance] No type info in existing data for vessel ${vesselId}, fetching from API...`);
        try {
          const vesselsResponse = await apiCallWithRetry('/vessel/get-vessels', 'GET', null);
          if (vesselsResponse && vesselsResponse.data && vesselsResponse.data.user_vessels) {
            const apiVessel = vesselsResponse.data.user_vessels.find(v => v.id === parseInt(vesselId));
            if (apiVessel) {
              existingData.capacity_type = apiVessel.capacity_type;
              existingData.capacity = apiVessel.capacity_max?.dry || apiVessel.capacity;
              existingData.vessel_model = apiVessel.capacity_type;
              existingData.type = apiVessel.type;
              logger.info(`[Vessel Appearance] Fetched type info: capacity_type=${apiVessel.capacity_type}`);
            }
          }
        } catch (apiErr) {
          logger.warn(`[Vessel Appearance] Could not fetch vessel type info: ${apiErr.message}`);
        }
      }

      // Determine ownImage flag:
      // - If uploading new image: true
      // - If removing image: false
      // - Otherwise: preserve existing value
      let ownImageFlag = existingData.ownImage || false;
      if (hasOwnImage) {
        ownImageFlag = true;
      } else if (removeOwnImage) {
        ownImageFlag = false;
      }

      const appearanceData = {
        vesselId: parseInt(vesselId),
        name: validator.escape(name || ''),
        // Preserve vessel type info from existing data (needed for SVG generation)
        vessel_model: existingData.vessel_model || existingData.capacity_type,
        capacity: existingData.capacity,
        capacity_type: existingData.capacity_type,
        type: existingData.type,
        hull_color: hull_color || '#b30000',
        deck_color: deck_color || '#272525',
        bridge_color: bridge_color || '#dbdbdb',
        name_color: name_color || '#ffffff',
        container_color_1: container_color_1 || '#ff8000',
        container_color_2: container_color_2 || '#0000ff',
        container_color_3: container_color_3 || '#670000',
        container_color_4: container_color_4 || '#777777',
        ownImage: ownImageFlag
      };

      await fs.writeFile(appearanceFile, JSON.stringify(appearanceData, null, 2), 'utf8');
      logger.info(`[Vessel Appearance] Saved appearance for ${filePrefix}, type: ${appearanceData.capacity_type || 'unknown'}`);
    }

    // Save image if provided - to ownimages folder
    if (hasOwnImage) {
      const ownImagesDir = path.join(VESSEL_IMAGES_DIR, 'ownimages');
      await fs.mkdir(ownImagesDir, { recursive: true });
      const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const imagePath = path.join(ownImagesDir, `${vesselId}.png`);
      await fs.writeFile(imagePath, imageBuffer);
      logger.info(`[Vessel Appearance] Saved own image for vessel ${vesselId}`);
    }

    // If removing own image, generate SVG from appearance data
    if (removeOwnImage) {
      const { generateVesselSvg } = require('../../utils/vessel-svg-generator');

      // Read the appearance data we just saved
      const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${filePrefix}.json`);
      try {
        let appearanceData = JSON.parse(await fs.readFile(appearanceFile, 'utf8'));

        // Always fetch vessel type info from API to ensure correct SVG generation
        logger.info(`[Vessel Appearance] Fetching type info for vessel ${vesselId} from API...`);
        try {
          const vesselsResponse = await apiCallWithRetry('/vessel/get-vessels', 'GET', null);
          if (vesselsResponse && vesselsResponse.data && vesselsResponse.data.user_vessels) {
            const apiVessel = vesselsResponse.data.user_vessels.find(v => v.id === parseInt(vesselId));
            if (apiVessel) {
              appearanceData.capacity_type = apiVessel.capacity_type;
              appearanceData.capacity = apiVessel.capacity_max?.dry || apiVessel.capacity;
              appearanceData.vessel_model = apiVessel.capacity_type;
              appearanceData.type = apiVessel.type;
              // Save updated appearance file with type info
              await fs.writeFile(appearanceFile, JSON.stringify(appearanceData, null, 2), 'utf8');
              logger.info(`[Vessel Appearance] Updated appearance with type info: capacity_type=${apiVessel.capacity_type}`);
            }
          }
        } catch (apiErr) {
          logger.warn(`[Vessel Appearance] Could not fetch vessel type info: ${apiErr.message}`);
        }

        const svg = generateVesselSvg(appearanceData);
        const svgFilePath = path.join(VESSEL_IMAGES_DIR, `${filePrefix}.svg`);
        await fs.writeFile(svgFilePath, svg, 'utf8');
        logger.info(`[Vessel Appearance] Generated SVG for vessel ${vesselId}, type: ${appearanceData.capacity_type || 'unknown'}`);
      } catch (err) {
        logger.warn(`[Vessel Appearance] Could not generate SVG: ${err.message}`);
      }
    }

    res.json({ success: true, vesselId: parseInt(vesselId) });

  } catch (error) {
    logger.error('[Vessel Appearance] Error saving:', error);
    res.status(500).json({ error: 'Failed to save vessel appearance' });
  }
});

/**
 * DELETE /api/vessel/delete-custom-image/:vesselId
 * Delete custom vessel image (returns to SVG)
 */
router.delete('/delete-custom-image/:vesselId', async (req, res) => {
  const { vesselId } = req.params;

  if (!vesselId) {
    return res.status(400).json({ error: 'Vessel ID is required' });
  }

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  try {
    // Delete from ownimages folder (where user-uploaded images are stored)
    const ownImagesDir = path.join(VESSEL_IMAGES_DIR, 'ownimages');
    const imagePath = path.join(ownImagesDir, `${vesselId}.png`);

    try {
      await fs.unlink(imagePath);
      logger.info(`[Vessel Appearance] Deleted own image for vessel ${vesselId}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      // File doesn't exist, that's fine
    }

    res.json({ success: true, vesselId: parseInt(vesselId) });

  } catch (error) {
    logger.error('[Vessel Appearance] Error deleting image:', error);
    res.status(500).json({ error: 'Failed to delete custom image' });
  }
});

module.exports = router;