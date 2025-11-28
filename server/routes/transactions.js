/**
 * @fileoverview Transaction History API Routes
 *
 * Provides endpoints for game transaction history:
 * - Sync transactions from game API
 * - Get transaction summary
 * - Get daily breakdown
 * - Get filtered transactions
 *
 * @module server/routes/transactions
 * @requires express
 * @requires ../analytics/transaction-store
 */

const express = require('express');
const router = express.Router();
const transactionStore = require('../analytics/transaction-store');
const { getUserId } = require('../utils/api');
const logger = require('../utils/logger');

/**
 * POST /api/transactions/sync
 * Sync transactions from game API
 */
router.post('/sync', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await transactionStore.syncTransactions(userId);
    res.json(result);
  } catch (error) {
    logger.error('[Transactions] Error syncing:', error);
    res.status(500).json({ error: 'Failed to sync transactions' });
  }
});

/**
 * GET /api/transactions/info
 * Get transaction store metadata
 */
router.get('/info', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const info = await transactionStore.getStoreInfo(userId);
    res.json(info);
  } catch (error) {
    logger.error('[Transactions] Error getting info:', error);
    res.status(500).json({ error: 'Failed to get transaction info' });
  }
});

/**
 * GET /api/transactions/summary
 * Get transaction summary grouped by context
 *
 * Query params:
 * - days: Number of days (default 30)
 */
router.get('/summary', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const summary = await transactionStore.getTransactionSummary(userId, days);

    res.json({ summary, days });
  } catch (error) {
    logger.error('[Transactions] Error getting summary:', error);
    res.status(500).json({ error: 'Failed to get transaction summary' });
  }
});

/**
 * GET /api/transactions/daily
 * Get daily breakdown of transactions
 *
 * Query params:
 * - days: Number of days (default 30)
 */
router.get('/daily', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const daily = await transactionStore.getDailyBreakdown(userId, days);

    res.json({ daily, days });
  } catch (error) {
    logger.error('[Transactions] Error getting daily breakdown:', error);
    res.status(500).json({ error: 'Failed to get daily breakdown' });
  }
});

/**
 * GET /api/transactions/types
 * Get all available transaction types
 */
router.get('/types', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const types = await transactionStore.getTransactionTypes(userId);
    res.json({ types });
  } catch (error) {
    logger.error('[Transactions] Error getting types:', error);
    res.status(500).json({ error: 'Failed to get transaction types' });
  }
});

/**
 * GET /api/transactions/list
 * Get raw transactions with filtering, sorting, and pagination
 *
 * Query params:
 * - days: Number of days (default 30)
 * - context: Filter by context (optional)
 * - limit: Max entries per page (default 100)
 * - offset: Skip entries for pagination (default 0)
 * - sortBy: Sort column (time, cash, context) default: time
 * - sortDir: Sort direction (asc, desc) default: desc
 */
router.get('/list', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const contextFilter = req.query.context || null;
    const limit = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;
    const sortBy = req.query.sortBy || 'time';
    const sortDir = req.query.sortDir || 'desc';

    let transactions = await transactionStore.getTransactionsByDays(userId, days);
    const totalBeforeFilter = transactions.length;

    // Filter by context if specified
    if (contextFilter) {
      transactions = transactions.filter(t => t.context === contextFilter);
    }

    const totalAfterFilter = transactions.length;

    // Sort
    transactions = transactions.sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];

      // Handle string comparison for context
      if (sortBy === 'context') {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }

      if (sortDir === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      }
      return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
    });

    // Paginate
    const paginatedTransactions = transactions.slice(offset, offset + limit);

    res.json({
      transactions: paginatedTransactions,
      pagination: {
        total: totalAfterFilter,
        totalBeforeFilter,
        limit,
        offset,
        hasMore: offset + limit < totalAfterFilter
      },
      sort: { sortBy, sortDir },
      filter: contextFilter,
      days
    });
  } catch (error) {
    logger.error('[Transactions] Error getting list:', error);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

/**
 * GET /api/transactions/all
 * Get complete transaction analytics for dashboard
 *
 * Query params:
 * - days: Number of days (default 7)
 */
router.get('/all', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 7;

    // Fetch all data in parallel
    const [summary, daily, types, info] = await Promise.all([
      transactionStore.getTransactionSummary(userId, days),
      transactionStore.getDailyBreakdown(userId, days),
      transactionStore.getTransactionTypes(userId),
      transactionStore.getStoreInfo(userId)
    ]);

    // Calculate totals
    let totalIncome = 0;
    let totalExpenses = 0;
    for (const key of Object.keys(summary)) {
      totalIncome += summary[key].totalIncome;
      totalExpenses += summary[key].totalExpense;
    }

    res.json({
      summary,
      daily,
      types,
      info,
      totals: {
        income: totalIncome,
        expenses: totalExpenses,
        net: totalIncome - totalExpenses
      },
      days
    });
  } catch (error) {
    logger.error('[Transactions] Error getting all data:', error);
    res.status(500).json({ error: 'Failed to get transaction data' });
  }
});

module.exports = router;
