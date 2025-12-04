/**
 * @fileoverview The Purser - Auto Stock Trading Pilot
 *
 * Automatically purchases stocks from fresh IPOs and sells falling investments.
 * Uses the IPO Alert threshold for finding fresh companies.
 *
 * Auto-Buy Logic:
 * 1. Gets fresh IPOs from ipo-refresh cache (already filtered by max age + stock_for_sale > 0)
 * 2. Filters by max stock price setting
 * 3. Checks cash balance >= min cash reserve
 * 4. Purchases all available shares from each qualifying IPO
 *
 * Auto-Sell Logic:
 * 1. Fetches user investments via /stock/get-finance-overview
 * 2. Tracks purchased stocks (via investments data)
 * 3. Sells when stock is falling for X days OR dropped by Y%
 *
 * @module server/autopilot/pilot_the_purser
 */

const state = require('../state');
const logger = require('../utils/logger');
const { getUserId, apiCall } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency, formatNumber } = require('../utils/audit-logger');
const { getFreshIpos, triggerImmediateIpoRefresh } = require('../websocket/ipo-refresh');

/**
 * Tracks which IPOs we've already purchased from (by user ID)
 * Prevents duplicate purchases within same session
 * @type {Set<number>}
 */
const purchasedIpos = new Set();

/**
 * Tracks investment purchase prices for calculating drop percentage
 * Key: stock_issuer_user_id, Value: { boughtAt, companyName, shares }
 * @type {Map<number, Object>}
 */
const investmentPurchaseData = new Map();

/**
 * Auto-buy stocks from fresh IPOs.
 *
 * Decision Logic:
 * 1. Gets fresh IPOs from cache (filtered by IPO Alert threshold)
 * 2. Filters by maxPrice setting
 * 3. Verifies cash >= minCash reserve
 * 4. Purchases all available shares
 * 5. Broadcasts purchase event and logs to audit
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all header data
 * @returns {Promise<void>}
 */
async function autoBuyStock(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.debug('[The Purser] Auto-Buy skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  // Check settings
  const settings = state.getSettings(userId);
  if (!settings.autoPurserEnabled) {
    logger.debug('[The Purser] Auto-Buy disabled in settings');
    return;
  }

  try {
    // Get current cash balance
    const bunker = state.getBunkerState(userId);
    if (!bunker || bunker.cash === undefined) {
      logger.debug('[The Purser] No bunker data available');
      return;
    }

    const minCash = settings.autoPurserMinCash;
    const maxPrice = settings.autoPurserMaxPrice;

    if (minCash === undefined || minCash === null) {
      logger.error('[The Purser] ERROR: autoPurserMinCash setting is missing!');
      return;
    }

    if (maxPrice === undefined || maxPrice === null) {
      logger.error('[The Purser] ERROR: autoPurserMaxPrice setting is missing!');
      return;
    }

    // Get fresh IPOs from cache (already filtered by age + stock_for_sale > 0)
    const freshIpos = getFreshIpos();
    if (!freshIpos || freshIpos.length === 0) {
      logger.debug('[The Purser] No fresh IPOs available');
      return;
    }

    logger.debug(`[The Purser] Found ${freshIpos.length} fresh IPOs, checking for purchases...`);

    // Filter IPOs we haven't purchased from and are within price limit
    const eligibleIpos = freshIpos.filter(ipo => {
      // Already purchased this session?
      if (purchasedIpos.has(ipo.id)) {
        return false;
      }

      // Stock price within limit?
      if (ipo.stock > maxPrice) {
        logger.debug(`[The Purser] Skipping ${ipo.company_name}: price $${ipo.stock} > max $${maxPrice}`);
        return false;
      }

      // Has shares available?
      if (!ipo.stock_for_sale || ipo.stock_for_sale <= 0) {
        return false;
      }

      return true;
    });

    if (eligibleIpos.length === 0) {
      logger.debug('[The Purser] No eligible IPOs for purchase');
      return;
    }

    // Process each eligible IPO
    for (const ipo of eligibleIpos) {
      // Re-check cash before each purchase
      const currentBunker = state.getBunkerState(userId);
      const availableCash = currentBunker.cash - minCash;

      if (availableCash <= 0) {
        logger.debug(`[The Purser] Not enough cash after reserve: $${currentBunker.cash.toLocaleString()} - $${minCash.toLocaleString()} reserve`);
        break;
      }

      // Calculate how many shares we can buy
      const sharesToBuy = Math.min(
        ipo.stock_for_sale,
        Math.floor(availableCash / ipo.stock)
      );

      if (sharesToBuy <= 0) {
        logger.debug(`[The Purser] Cannot afford any shares of ${ipo.company_name} at $${ipo.stock}/share`);
        continue;
      }

      const totalCost = sharesToBuy * ipo.stock;

      logger.info(`[The Purser] Purchasing ${sharesToBuy.toLocaleString()} shares of ${ipo.company_name} @ $${ipo.stock}/share = $${totalCost.toLocaleString()}`);

      try {
        // Execute purchase via game API
        const result = await apiCall('/stock/purchase-stock', 'POST', {
          stock_issuer_user_id: ipo.id,
          amount: sharesToBuy
        });
        const actionTimestamp = Date.now();

        if (result.error) {
          logger.error(`[The Purser] Purchase failed for ${ipo.company_name}: ${result.error}`);
          await auditLog(
            userId,
            CATEGORIES.AUTOPILOT,
            'The Purser',
            `Buy failed: ${ipo.company_name} - ${result.error}`,
            { stock_issuer_user_id: ipo.id, error: result.error },
            'ERROR',
            SOURCES.AUTOPILOT
          );
          continue;
        }

        // Mark as purchased (prevent duplicates)
        purchasedIpos.add(ipo.id);

        // Track purchase data for auto-sell calculations
        investmentPurchaseData.set(ipo.id, {
          boughtAt: ipo.stock,
          companyName: ipo.company_name,
          shares: sharesToBuy,
          purchaseTime: actionTimestamp
        });

        // Update local bunker state
        currentBunker.cash -= totalCost;
        state.updateBunkerState(userId, currentBunker);

        // Broadcast purchase notification
        if (broadcastToUser) {
          broadcastToUser(userId, 'purser_purchase', {
            companyName: ipo.company_name,
            companyId: ipo.id,
            shares: sharesToBuy,
            pricePerShare: ipo.stock,
            totalCost: totalCost,
            ageDays: ipo.age_days
          });

          // Also update bunker display
          broadcastToUser(userId, 'bunker_update', {
            fuel: currentBunker.fuel,
            co2: currentBunker.co2,
            cash: currentBunker.cash,
            maxFuel: currentBunker.maxFuel,
            maxCO2: currentBunker.maxCO2
          });
        }

        logger.info(`[The Purser] Successfully purchased ${sharesToBuy.toLocaleString()} shares of ${ipo.company_name}`);

        // Log to audit
        await auditLog(
          userId,
          CATEGORIES.AUTOPILOT,
          'The Purser',
          `Bought ${formatNumber(sharesToBuy)} shares of ${ipo.company_name} @ ${formatCurrency(ipo.stock)} | -${formatCurrency(totalCost)}`,
          {
            actionTimestamp,
            stock_issuer_user_id: ipo.id,
            company_name: ipo.company_name,
            shares: sharesToBuy,
            price_per_share: ipo.stock,
            total_cost: totalCost,
            age_days: ipo.age_days
          },
          'SUCCESS',
          SOURCES.AUTOPILOT
        );

      } catch (purchaseError) {
        logger.error(`[The Purser] Error purchasing ${ipo.company_name}:`, purchaseError.message);
        await auditLog(
          userId,
          CATEGORIES.AUTOPILOT,
          'The Purser',
          `Buy error: ${ipo.company_name} - ${purchaseError.message}`,
          { stock_issuer_user_id: ipo.id, error: purchaseError.message },
          'ERROR',
          SOURCES.AUTOPILOT
        );
      }
    }

    // Trigger IPO refresh to update available shares
    triggerImmediateIpoRefresh();

    // Update all header data
    await tryUpdateAllData();

  } catch (error) {
    logger.error('[The Purser] Auto-Buy error:', error.message);
  }
}

/**
 * Auto-sell investments that are falling.
 *
 * Decision Logic:
 * 1. Fetches user investments via /stock/get-finance-overview
 * 2. Checks each investment for falling trend
 * 3. Sells if: falling for X days OR dropped by Y%
 * 4. Broadcasts sell event and logs to audit
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all header data
 * @returns {Promise<void>}
 */
async function autoSellStock(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.debug('[The Purser] Auto-Sell skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  // Check settings
  const settings = state.getSettings(userId);
  if (!settings.autoPurserEnabled || !settings.autoPurserAutoSellEnabled) {
    logger.debug('[The Purser] Auto-Sell disabled in settings');
    return;
  }

  const fallingDays = settings.autoPurserFallingDays;
  const dropPercent = settings.autoPurserDropPercent;

  if (fallingDays === undefined || dropPercent === undefined) {
    logger.error('[The Purser] ERROR: Auto-Sell settings missing!');
    return;
  }

  try {
    // Fetch user's investments
    const financeData = await apiCall('/stock/get-finance-overview', 'POST', {
      user_id: userId
    });

    if (!financeData.data || !financeData.data.investments) {
      logger.debug('[The Purser] No investments data available');
      return;
    }

    const investments = financeData.data.investments;
    if (!investments || Object.keys(investments).length === 0) {
      logger.debug('[The Purser] No investments to check');
      return;
    }

    logger.debug(`[The Purser] Checking ${Object.keys(investments).length} investments for auto-sell...`);

    // Check each investment
    for (const [companyIdStr, investment] of Object.entries(investments)) {
      const companyId = parseInt(companyIdStr, 10);

      // Get investment details
      const currentValue = investment.current_value;
      const boughtAt = investment.bought_at;
      const stockTrend = investment.stock_trend;
      const companyName = investment.company_name;
      const sharesOwned = investment.shares;

      if (!sharesOwned || sharesOwned <= 0) {
        continue;
      }

      // Check falling days criteria
      // stock_trend: negative number means falling (e.g., -3 = falling for 3 days)
      const isFallingLongEnough = stockTrend < 0 && Math.abs(stockTrend) >= fallingDays;

      // Check drop percentage criteria
      let dropPercentage = 0;
      if (boughtAt && boughtAt > 0) {
        dropPercentage = ((boughtAt - currentValue) / boughtAt) * 100;
      }
      const hasDroppedEnough = dropPercentage >= dropPercent;

      // Should we sell?
      const shouldSell = isFallingLongEnough || hasDroppedEnough;

      if (!shouldSell) {
        continue;
      }

      const sellReason = isFallingLongEnough
        ? `falling for ${Math.abs(stockTrend)} days`
        : `dropped ${dropPercentage.toFixed(1)}%`;

      logger.info(`[The Purser] Auto-selling ${sharesOwned.toLocaleString()} shares of ${companyName}: ${sellReason}`);

      try {
        // Execute sale via game API
        const result = await apiCall('/stock/sell-stock', 'POST', {
          stock_user_id: companyId,
          amount: sharesOwned
        });
        const actionTimestamp = Date.now();

        if (result.error) {
          // Check for 48h lock
          if (result.error === 'stock_is_locked') {
            logger.debug(`[The Purser] Cannot sell ${companyName}: 48h lock still active`);
            continue;
          }

          logger.error(`[The Purser] Sell failed for ${companyName}: ${result.error}`);
          await auditLog(
            userId,
            CATEGORIES.AUTOPILOT,
            'The Purser',
            `Sell failed: ${companyName} - ${result.error}`,
            { stock_user_id: companyId, error: result.error },
            'ERROR',
            SOURCES.AUTOPILOT
          );
          continue;
        }

        // Calculate revenue
        const totalRevenue = sharesOwned * currentValue;

        // Update bunker state
        const bunker = state.getBunkerState(userId);
        bunker.cash += totalRevenue;
        state.updateBunkerState(userId, bunker);

        // Remove from our tracking
        investmentPurchaseData.delete(companyId);

        // Broadcast sell notification
        if (broadcastToUser) {
          broadcastToUser(userId, 'purser_sell', {
            companyName: companyName,
            companyId: companyId,
            shares: sharesOwned,
            pricePerShare: currentValue,
            totalRevenue: totalRevenue,
            reason: sellReason,
            boughtAt: boughtAt,
            dropPercent: dropPercentage
          });

          // Update bunker display
          broadcastToUser(userId, 'bunker_update', {
            fuel: bunker.fuel,
            co2: bunker.co2,
            cash: bunker.cash,
            maxFuel: bunker.maxFuel,
            maxCO2: bunker.maxCO2
          });
        }

        logger.info(`[The Purser] Successfully sold ${sharesOwned.toLocaleString()} shares of ${companyName} for $${totalRevenue.toLocaleString()}`);

        // Log to audit
        await auditLog(
          userId,
          CATEGORIES.AUTOPILOT,
          'The Purser',
          `Sold ${formatNumber(sharesOwned)} shares of ${companyName} @ ${formatCurrency(currentValue)} | +${formatCurrency(totalRevenue)} (${sellReason})`,
          {
            actionTimestamp,
            stock_user_id: companyId,
            company_name: companyName,
            shares: sharesOwned,
            price_per_share: currentValue,
            total_revenue: totalRevenue,
            bought_at: boughtAt,
            drop_percent: dropPercentage.toFixed(1),
            falling_days: Math.abs(stockTrend),
            reason: sellReason
          },
          'SUCCESS',
          SOURCES.AUTOPILOT
        );

      } catch (sellError) {
        logger.error(`[The Purser] Error selling ${companyName}:`, sellError.message);
        await auditLog(
          userId,
          CATEGORIES.AUTOPILOT,
          'The Purser',
          `Sell error: ${companyName} - ${sellError.message}`,
          { stock_user_id: companyId, error: sellError.message },
          'ERROR',
          SOURCES.AUTOPILOT
        );
      }
    }

    // Update all header data
    await tryUpdateAllData();

  } catch (error) {
    logger.error('[The Purser] Auto-Sell error:', error.message);
  }
}

/**
 * Clears the purchased IPOs tracking set.
 * Called when user manually triggers a refresh or settings change.
 */
function clearPurchasedCache() {
  purchasedIpos.clear();
  logger.debug('[The Purser] Purchased cache cleared');
}

module.exports = {
  autoBuyStock,
  autoSellStock,
  clearPurchasedCache
};
