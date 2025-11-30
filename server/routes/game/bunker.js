/**
 * @fileoverview Bunker Management Routes
 *
 * This module provides endpoints for fuel and CO2 certificate purchasing.
 * Includes lock management to prevent concurrent purchases, cost calculation,
 * audit logging, and WebSocket broadcasting for real-time UI updates.
 *
 * Key Features:
 * - Get current fuel and CO2 market prices
 * - Purchase fuel with lock management and notifications
 * - Purchase CO2 certificates with lock management and notifications
 * - Calculate actual costs including discounts
 * - Audit logging for all purchases
 * - WebSocket broadcasts for UI synchronization
 *
 * @requires express - Router and middleware
 * @requires validator - Input sanitization
 * @requires ../../utils/api - API helper functions
 * @requires ../../state - Global state management
 * @requires ../../autopilot - For triggering data updates
 * @requires ../../utils/audit-logger - Transaction logging
 * @requires ../../websocket - WebSocket broadcasting
 * @requires ../../utils/logger - Logging utility
 * @module server/routes/game/bunker
 */

const express = require('express');
const validator = require('validator');
const { apiCall, getUserId } = require('../../utils/api');
const { broadcastToUser } = require('../../websocket');
const logger = require('../../utils/logger');
const autopilot = require('../../autopilot');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../../utils/audit-logger');

const router = express.Router();

/**
 * GET /api/bunker/get-prices
 * Fetches current market prices for fuel and CO2
 *
 * Critical for price alerts and auto-rebuy features.
 *
 * @route GET /api/bunker/get-prices
 *
 * @returns {object} Current bunker prices from game API
 *
 * @error 500 - Failed to retrieve bunker prices
 */
router.get('/get-prices', async (req, res) => {
  try {
    const data = await apiCall('/bunker/get-prices', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting bunker prices:', error);
    res.status(500).json({ error: 'Failed to retrieve bunker prices' });
  }
});

/**
 * POST /api/bunker/purchase-fuel
 * Purchases specified amount of fuel
 *
 * Validation: amount must be positive integer.
 * Used by manual purchases and auto-rebuy automation.
 * Implements lock management to prevent concurrent purchases.
 *
 * @route POST /api/bunker/purchase-fuel
 * @body {number} amount - Amount of fuel to purchase in tons (must be positive integer)
 *
 * @returns {object} Purchase result with updated user data
 *
 * @error 400 - Invalid amount
 * @error 409 - Fuel purchase already in progress (lock conflict)
 * @error 500 - Failed to purchase fuel
 *
 * Side effects:
 * - Acquires/releases fuel purchase lock
 * - Broadcasts purchase start/complete notifications
 * - Updates bunker display (fuel/cash)
 * - Logs purchase to audit log
 * - Sends formatted purchase notification
 * - Triggers data update
 */
router.post('/purchase-fuel', express.json(), async (req, res) => {
  const { amount } = req.body;

  if (!amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const userId = getUserId();
  const state = require('../../state');

  // LOCK: Prevent concurrent fuel purchases (race condition protection)
  if (state.getLockStatus(userId, 'fuelPurchase')) {
    logger.debug('[Fuel Purchase] SKIPPED - Another fuel purchase is already in progress');
    return res.status(409).json({ error: 'Fuel purchase already in progress' });
  }

  // Set lock and broadcast to all clients
  state.setLockStatus(userId, 'fuelPurchase', true);
  if (userId) {
    broadcastToUser(userId, 'fuel_purchase_start', {});
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: true,
      co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });
  }
  logger.debug('[Fuel Purchase] Lock acquired');

  try {
    // Get cash BEFORE purchase to calculate actual cost
    const bunkerBefore = state.getBunkerState(userId);
    const cashBefore = bunkerBefore ? bunkerBefore.cash : 0;

    // API expects amount in tons (NOT kg) - send directly
    const data = await apiCall('/bunker/purchase-fuel', 'POST', { amount });
    const actionTimestamp = Date.now(); // Capture timestamp immediately after API response

    // Broadcast bunker update to all clients (manual purchase)
    if (userId && data.user) {
      // API doesn't return capacity fields - use values from state
      const { broadcastBunkerUpdate } = require('../../websocket');

      broadcastBunkerUpdate(userId, {
        fuel: data.user.fuel / 1000,
        co2: (data.user.co2 || data.user.co2_certificate) / 1000,
        cash: data.user.cash,
        maxFuel: bunkerBefore.maxFuel,
        maxCO2: bunkerBefore.maxCO2
      });

      // Calculate ACTUAL cost from API response (includes discounts!)
      const cashAfter = data.user.cash;
      const actualCost = Math.round(cashBefore - cashAfter);
      const actualPricePerTon = Math.round(actualCost / amount);

      logger.info(`[Manual Fuel Purchase] User bought ${amount}t @ $${actualPricePerTon}/t = $${actualCost.toLocaleString('en-US')} (Cash before: $${cashBefore.toLocaleString('en-US')} Cash after: $${cashAfter.toLocaleString('en-US')})`);

      // AUDIT LOG: Manual fuel purchase
      // (using audit-logger imported at top of file)

      // Validate data - FAIL LOUD if missing
      if (!data.user || data.user.fuel === undefined || data.user.fuel === null) {
        throw new Error('API response missing user.fuel data');
      }

      await auditLog(
        userId,
        CATEGORIES.BUNKER,
        'Manual Fuel Purchase',
        `+${amount}t @ ${formatCurrency(actualPricePerTon)}/t = ${formatCurrency(actualCost)}`,
        {
          actionTimestamp,
          amount_tons: amount,
          price_per_ton: actualPricePerTon,
          total_cost: actualCost,
          balance_before: cashBefore,
          balance_after: cashAfter,
          inventory_before_kg: bunkerBefore.fuel,
          inventory_after_kg: data.user.fuel
        },
        'SUCCESS',
        SOURCES.MANUAL
      );

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

      // Trigger immediate data update
      await autopilot.tryUpdateAllData();
    }

    // Release lock BEFORE sending response
    state.setLockStatus(userId, 'fuelPurchase', false);
    logger.debug('[Fuel Purchase] Lock released');

    // Broadcast fuel purchase complete and updated lock status
    broadcastToUser(userId, 'fuel_purchase_complete', { amount });
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: false,
      co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing fuel:', error);

    // Release lock on error
    state.setLockStatus(userId, 'fuelPurchase', false);

    // Broadcast error notification to all clients
    if (userId) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `⛽ <strong>Purchase Failed</strong><br><br>${safeErrorMessage}`
      });

      // Broadcast fuel purchase complete and updated lock status
      broadcastToUser(userId, 'fuel_purchase_complete', { amount: 0 });
      broadcastToUser(userId, 'lock_status', {
        depart: state.getLockStatus(userId, 'depart'),
        fuelPurchase: false,
        co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
        repair: state.getLockStatus(userId, 'repair'),
        bulkBuy: state.getLockStatus(userId, 'bulkBuy')
      });
    }

    res.status(500).json({ error: 'Failed to purchase fuel' });
  } finally {
    // ALWAYS release lock, even if error occurred
    state.setLockStatus(userId, 'fuelPurchase', false);
    logger.debug('[Fuel Purchase] Lock released (finally)');
  }
});

/**
 * POST /api/bunker/purchase-co2
 * Purchases specified amount of CO2 certificates
 *
 * Validation: amount must be positive integer.
 * Used by manual purchases and auto-rebuy automation.
 * Implements lock management to prevent concurrent purchases.
 *
 * @route POST /api/bunker/purchase-co2
 * @body {number} amount - Amount of CO2 to purchase in tons (must be positive integer)
 *
 * @returns {object} Purchase result with updated user data
 *
 * @error 400 - Invalid amount
 * @error 409 - CO2 purchase already in progress (lock conflict)
 * @error 500 - Failed to purchase CO2
 *
 * Side effects:
 * - Acquires/releases CO2 purchase lock
 * - Broadcasts purchase start/complete notifications
 * - Updates bunker display (CO2/cash)
 * - Logs purchase to audit log
 * - Sends formatted purchase notification
 * - Triggers data update
 */
router.post('/purchase-co2', express.json(), async (req, res) => {
  const { amount } = req.body;

  if (!amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const userId = getUserId();
  const state = require('../../state');

  // LOCK: Prevent concurrent CO2 purchases (race condition protection)
  if (state.getLockStatus(userId, 'co2Purchase')) {
    logger.debug('[CO2 Purchase] SKIPPED - Another CO2 purchase is already in progress');
    return res.status(409).json({ error: 'CO2 purchase already in progress' });
  }

  // Set lock and broadcast to all clients
  state.setLockStatus(userId, 'co2Purchase', true);
  if (userId) {
    broadcastToUser(userId, 'co2_purchase_start', {});
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
      co2Purchase: true,
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });
  }
  logger.debug('[CO2 Purchase] Lock acquired');

  try {
    // Get cash BEFORE purchase to calculate actual cost
    const bunkerBefore = state.getBunkerState(userId);
    const cashBefore = bunkerBefore ? bunkerBefore.cash : 0;

    // API expects amount in tons (NOT kg) - send directly
    const data = await apiCall('/bunker/purchase-co2', 'POST', { amount });
    const actionTimestamp = Date.now(); // Capture timestamp immediately after API response

    // Broadcast bunker update to all clients (manual purchase)
    if (userId && data.user) {
      // API doesn't return capacity fields - use values from state
      const { broadcastBunkerUpdate } = require('../../websocket');

      broadcastBunkerUpdate(userId, {
        fuel: data.user.fuel / 1000,
        co2: (data.user.co2 || data.user.co2_certificate) / 1000,
        cash: data.user.cash,
        maxFuel: bunkerBefore.maxFuel,
        maxCO2: bunkerBefore.maxCO2
      });

      // Calculate ACTUAL cost from API response (includes discounts!)
      const cashAfter = data.user.cash;
      const actualCost = Math.round(cashBefore - cashAfter);
      const actualPricePerTon = Math.round(actualCost / amount);

      logger.info(`[Manual CO2 Purchase] User bought ${amount}t @ $${actualPricePerTon}/t = $${actualCost.toLocaleString('en-US')} (Cash before: $${cashBefore.toLocaleString('en-US')} Cash after: $${cashAfter.toLocaleString('en-US')})`);

      // AUDIT LOG: Manual CO2 purchase
      // (using audit-logger imported at top of file)

      // Validate data - FAIL LOUD if missing
      const co2After = data.user.co2 || data.user.co2_certificate;
      if (co2After === undefined || co2After === null) {
        throw new Error('API response missing user.co2/co2_certificate data');
      }

      await auditLog(
        userId,
        CATEGORIES.BUNKER,
        'Manual CO2 Purchase',
        `+${amount}t @ ${formatCurrency(actualPricePerTon)}/t = ${formatCurrency(actualCost)}`,
        {
          actionTimestamp,
          amount_tons: amount,
          price_per_ton: actualPricePerTon,
          total_cost: actualCost,
          balance_before: cashBefore,
          balance_after: cashAfter,
          inventory_before_kg: bunkerBefore.co2,
          inventory_after_kg: co2After
        },
        'SUCCESS',
        SOURCES.MANUAL
      );

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

      // Trigger immediate data update
      await autopilot.tryUpdateAllData();
    }

    // Release lock BEFORE sending response
    state.setLockStatus(userId, 'co2Purchase', false);
    logger.debug('[CO2 Purchase] Lock released');

    // Broadcast CO2 purchase complete and updated lock status
    broadcastToUser(userId, 'co2_purchase_complete', { amount });
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
      co2Purchase: false,
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing CO2:', error);

    // Release lock on error
    state.setLockStatus(userId, 'co2Purchase', false);

    // Broadcast error notification to all clients
    if (userId) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `💨 <strong>Purchase Failed</strong><br><br>${safeErrorMessage}`
      });

      // Broadcast CO2 purchase complete and updated lock status
      broadcastToUser(userId, 'co2_purchase_complete', { amount: 0 });
      broadcastToUser(userId, 'lock_status', {
        depart: state.getLockStatus(userId, 'depart'),
        fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
        co2Purchase: false,
        repair: state.getLockStatus(userId, 'repair'),
        bulkBuy: state.getLockStatus(userId, 'bulkBuy')
      });
    }

    res.status(500).json({ error: 'Failed to purchase CO2' });
  } finally {
    // ALWAYS release lock, even if error occurred
    state.setLockStatus(userId, 'co2Purchase', false);
    logger.debug('[CO2 Purchase] Lock released (finally)');
  }
});

module.exports = router;