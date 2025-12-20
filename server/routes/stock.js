/**
 * @fileoverview Stock Market Routes
 *
 * Handles stock market functionality including viewing market data,
 * company stock history, and purchasing stocks.
 *
 * @module server/routes/stock
 * @requires express
 * @requires ../utils/api
 */

const express = require('express');
const router = express.Router();
const { apiCall, getUserId } = require('../utils/api');
const logger = require('../utils/logger');
const { logAutopilotAction } = require('../logbook');
const { triggerImmediateIpoRefresh } = require('../websocket/ipo-refresh');

/**
 * GET /api/stock/finance-overview - Retrieves stock finance overview for a user
 *
 * Fetches complete stock data including:
 * - Stock info with historical price data
 * - Investors (who invested in this company)
 * - Investments (companies this user invested in)
 *
 * @name GET /api/stock/finance-overview
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request with query.user_id
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with finance overview
 */
router.get('/stock/finance-overview', async (req, res) => {
  try {
    const userId = req.query.user_id;

    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const result = await apiCall('/stock/get-finance-overview', 'POST', {
      user_id: parseInt(userId, 10)
    });

    res.json(result);
  } catch (error) {
    logger.error('[STOCK] Error fetching finance overview:', error);
    res.status(500).json({ error: 'Failed to fetch finance overview' });
  }
});

/**
 * GET /api/stock/market - Retrieves stock market listings
 *
 * Fetches paginated market data with filter options:
 * - top: Highest stock values
 * - low: Lowest stock values
 * - activity: Most active trading
 * - recent-ipo: Recently listed companies
 *
 * @name GET /api/stock/market
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request with query params
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with market data
 */
router.get('/stock/market', async (req, res) => {
  try {
    const {
      filter = 'top',
      page = 1,
      limit = 40,
      search = ''
    } = req.query;

    const validFilters = ['top', 'low', 'activity', 'recent-ipo', 'search'];
    if (!validFilters.includes(filter)) {
      return res.status(400).json({
        error: `Invalid filter. Must be one of: ${validFilters.join(', ')}`
      });
    }

    // search filter requires search_by parameter
    if (filter === 'search' && !search) {
      return res.status(400).json({
        error: 'search_by parameter is required when using filter=search'
      });
    }

    const result = await apiCall('/stock/get-market', 'POST', {
      filter,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      search_by: search
    });

    res.json(result);
  } catch (error) {
    logger.error('[STOCK] Error fetching market data:', error);
    res.status(500).json({ error: 'Failed to fetch market data' });
  }
});

/**
 * POST /api/stock/purchase - Purchase stocks from a company
 *
 * Requires IPO=1 on the calling user's account.
 * Returns error "user_has_not_done_ipo" if user has not completed IPO.
 *
 * @name POST /api/stock/purchase
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request with body { stock_issuer_user_id, amount }
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with purchase result
 */
router.post('/stock/purchase', async (req, res) => {
  try {
    const { stock_issuer_user_id, amount, company_name, price_per_share } = req.body;

    if (!stock_issuer_user_id) {
      return res.status(400).json({ error: 'stock_issuer_user_id is required' });
    }

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'amount must be at least 1' });
    }

    logger.info(`[STOCK] Purchasing ${amount} shares from company ${stock_issuer_user_id}`);

    const result = await apiCall('/stock/purchase-stock', 'POST', {
      stock_issuer_user_id: parseInt(stock_issuer_user_id, 10),
      amount: parseInt(amount, 10)
    });

    if (result.error === 'user_has_not_done_ipo') {
      return res.status(403).json({
        error: 'IPO required',
        message: 'You must complete your IPO before purchasing stocks'
      });
    }

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // Log to logbook
    const userId = getUserId();
    if (userId) {
      const totalCost = price_per_share ? amount * price_per_share : 0;
      const companyDisplay = company_name || `Company #${stock_issuer_user_id}`;
      const costDisplay = totalCost > 0 ? ` | -$${totalCost.toLocaleString()}` : '';

      await logAutopilotAction(
        userId,
        'Manual Stock Purchase',
        'SUCCESS',
        `Bought ${amount.toLocaleString()} shares of ${companyDisplay}${costDisplay}`,
        {
          stock_issuer_user_id,
          company_name: company_name || null,
          amount,
          price_per_share: price_per_share || null,
          total_cost: totalCost || null
        }
      );
    }

    // Trigger IPO refresh to update available shares in IPO Alert tab
    triggerImmediateIpoRefresh();

    res.json(result);
  } catch (error) {
    logger.error('[STOCK] Error purchasing stock:', error);
    res.status(500).json({ error: 'Failed to purchase stock' });
  }
});

/**
 * POST /api/stock/sell - Sell stocks from a company
 *
 * @name POST /api/stock/sell
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request with body { stock_issuer_user_id, amount }
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with sale result
 */
router.post('/stock/sell', async (req, res) => {
  try {
    const { stock_issuer_user_id, amount, company_name, price_per_share } = req.body;

    if (!stock_issuer_user_id) {
      return res.status(400).json({ error: 'stock_issuer_user_id is required' });
    }

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'amount must be at least 1' });
    }

    logger.info(`[STOCK] Selling ${amount} shares from company ${stock_issuer_user_id}`);

    // Game API uses 'stock_user_id' instead of 'stock_issuer_user_id' for selling
    const result = await apiCall('/stock/sell-stock', 'POST', {
      stock_user_id: parseInt(stock_issuer_user_id, 10),
      amount: parseInt(amount, 10)
    });

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // Log to logbook
    const userId = getUserId();
    if (userId) {
      const totalRevenue = price_per_share ? amount * price_per_share : 0;
      const companyDisplay = company_name || `Company #${stock_issuer_user_id}`;
      const revenueDisplay = totalRevenue > 0 ? ` | +$${totalRevenue.toLocaleString()}` : '';

      await logAutopilotAction(
        userId,
        'Manual Stock Sale',
        'SUCCESS',
        `Sold ${amount.toLocaleString()} shares of ${companyDisplay}${revenueDisplay}`,
        {
          stock_issuer_user_id,
          company_name: company_name || null,
          amount,
          price_per_share: price_per_share || null,
          total_revenue: totalRevenue || null
        }
      );
    }

    // Trigger IPO refresh to update available shares in IPO Alert tab
    triggerImmediateIpoRefresh();

    res.json(result);
  } catch (error) {
    logger.error('[STOCK] Error selling stock:', error);
    res.status(500).json({ error: 'Failed to sell stock' });
  }
});

/**
 * POST /api/stock/increase-stock-for-sale - Issue new shares to the market
 *
 * Only available for users who have completed IPO.
 * Each purchase issues 25,000 shares.
 * Price doubles with each tier based on shares in circulation:
 * - 0-25k: 6.5M
 * - 25k-50k: 12.5M
 * - 50k-75k: 25M
 * - 75k-100k: 50M
 * - etc. (doubles each tier)
 *
 * @name POST /api/stock/increase-stock-for-sale
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with result
 */
router.post('/stock/increase-stock-for-sale', async (req, res) => {
  try {
    logger.info('[STOCK] Increasing shares for sale');

    const result = await apiCall('/stock/increase-stock-for-sale', 'POST', {});

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    logger.error('[STOCK] Error increasing stock for sale:', error);
    res.status(500).json({ error: 'Failed to increase stock for sale' });
  }
});

/**
 * GET /api/stock/recent-ipos - Get all recent IPOs for the IPO Alert tab
 *
 * Returns fresh IPOs from the WebSocket cache (already filtered by max age).
 * Falls back to fetching from API if cache is empty.
 *
 * @name GET /api/stock/recent-ipos
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with recent IPOs
 */
router.get('/stock/recent-ipos', async (req, res) => {
  try {
    const { getFreshIpos, performIpoRefresh } = require('../websocket/ipo-refresh');
    let freshIpos = getFreshIpos();

    // Cache empty? Trigger refresh and wait for it
    if (!freshIpos || freshIpos.length === 0) {
      logger.debug('[STOCK] IPO cache empty, triggering refresh');
      await performIpoRefresh();
      freshIpos = getFreshIpos();
    }

    // Return cached fresh IPOs (already filtered by age + stock_for_sale > 0)
    res.json({ ipos: freshIpos || [] });
  } catch (error) {
    logger.error('[STOCK] Error fetching recent IPOs:', error);
    res.status(500).json({ error: 'Failed to fetch recent IPOs' });
  }
});

/**
 * GET /api/stock/check-company-age - Check age of a single company
 *
 * @name GET /api/stock/check-company-age
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request with query.user_id and query.max_age_days
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with company age info
 */
router.get('/stock/check-company-age', async (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10);
    const maxAgeDays = parseInt(req.query.max_age_days, 10) || 7;

    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const companyData = await apiCall('/user/get-company', 'POST', {
      user_id: userId
    });

    if (!companyData.data || !companyData.data.company || !companyData.data.company.created_at) {
      return res.json({ user_id: userId, is_fresh: false, age_days: null });
    }

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const createdAt = new Date(companyData.data.company.created_at).getTime();
    const ageMs = now - createdAt;
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const isFresh = ageMs <= maxAgeMs;

    res.json({
      user_id: userId,
      is_fresh: isFresh,
      age_days: ageDays,
      created_at: companyData.data.company.created_at
    });
  } catch (error) {
    logger.error('[STOCK] Error checking company age:', error);
    res.status(500).json({ error: 'Failed to check company age' });
  }
});

/**
 * GET /api/stock/purchase-times - Get stock purchase timestamps from logbook and game transactions
 *
 * Returns the most recent purchase timestamp for each company the user invested in.
 * Used to calculate 48h lock period for selling.
 *
 * First checks logbook, then falls back to game transaction history (matching by amount).
 *
 * @name GET /api/stock/purchase-times
 * @function
 * @memberof module:server/routes/stock
 * @param {express.Request} req - Express request
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with purchase timestamps by company
 */
router.get('/stock/purchase-times', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { getLogEntries } = require('../logbook');
    const { transactionStore } = require('../database/store-adapter');

    // Get all stock purchase logs from last 7 days (covers 48h lock period with margin)
    const logs = await getLogEntries(userId, {
      autopilot: 'Manual Stock Purchase',
      timeRange: '7days'
    });

    // Build map of company_id -> most recent purchase timestamp from logbook
    const purchaseTimes = {};

    logs.forEach(log => {
      const companyId = log.details?.stock_issuer_user_id;
      if (companyId) {
        // Keep the most recent purchase time
        if (!purchaseTimes[companyId] || log.timestamp > purchaseTimes[companyId]) {
          purchaseTimes[companyId] = log.timestamp;
        }
      }
    });

    // Also get ALL game transactions for stock purchases (days=0 means all time)
    // These have { time, cash, context: 'purchase_stock' }
    const gameTransactions = await transactionStore.getTransactionsByDays(userId, 0);
    const stockPurchases = gameTransactions
      .filter(t => t.context === 'purchase_stock')
      .sort((a, b) => b.time - a.time); // newest first

    // Return both logbook times and game transactions for matching by amount
    res.json({
      purchaseTimes,
      gameStockPurchases: stockPurchases.map(t => ({
        time: t.time * 1000, // convert to milliseconds
        amount: Math.abs(t.cash)
      }))
    });
  } catch (error) {
    logger.error('[STOCK] Error getting purchase times:', error);
    res.status(500).json({ error: 'Failed to get purchase times' });
  }
});

module.exports = router;
