/**
 * @fileoverview Analytics API Routes
 *
 * Provides endpoints for business intelligence and analytics:
 * - Weekly/daily summaries
 * - Vessel performance metrics
 * - Route profitability
 * - Purchase analysis
 * - Harbor fee analysis
 * - Contribution tracking
 *
 * @module server/routes/analytics
 * @requires express
 * @requires ../analytics/aggregator
 */

const express = require('express');
const router = express.Router();
const aggregator = require('../analytics/aggregator');
const { vesselHistoryStore, lookupStore, portDemandStore } = require('../database/store-adapter');
const apiStatsStore = require('../analytics/api-stats-store');
const portDemandSync = require('../services/port-demand-sync');
const { getUserId } = require('../utils/api');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * GET /api/analytics/overview
 * Returns only data needed for Overview tab (fast load)
 * - summary: merged summary data
 * - detailedExpenses: expense breakdown
 *
 * Query params:
 * - days: Number of days (default 7)
 */
router.get('/overview', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 7;

    // Only fetch what Overview tab needs - much faster than /all
    const [mergedSummary, detailedExpenses] = await Promise.all([
      aggregator.getMergedSummary(userId, days),
      aggregator.getDetailedExpenses(userId, days)
    ]);

    res.json({
      summary: mergedSummary,
      detailedExpenses,
      days
    });
  } catch (error) {
    logger.error('[Analytics] Error getting overview:', error);
    res.status(500).json({ error: 'Failed to get analytics overview' });
  }
});

/**
 * GET /api/analytics/summary
 * Returns weekly cash flow summary
 *
 * Query params:
 * - weeks: Number of weeks (default 1)
 */
router.get('/summary', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const weeks = parseInt(req.query.weeks, 10) || 1;
    const summary = await aggregator.getWeeklySummary(userId, weeks);

    res.json(summary);
  } catch (error) {
    logger.error('[Analytics] Error getting summary:', error);
    res.status(500).json({ error: 'Failed to get analytics summary' });
  }
});

/**
 * GET /api/analytics/vessels
 * Returns performance metrics for all vessels with contribution
 *
 * Query params:
 * - days: Number of days to analyze (default 30)
 */
router.get('/vessels', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const vessels = await aggregator.getVesselPerformanceWithContribution(userId, days);

    res.json({ vessels, days });
  } catch (error) {
    logger.error('[Analytics] Error getting vessel performance:', error);
    res.status(500).json({ error: 'Failed to get vessel performance' });
  }
});

/**
 * GET /api/analytics/routes
 * Returns route profitability analysis with contribution
 *
 * Query params:
 * - days: Number of days to analyze (default 30)
 */
router.get('/routes', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const routes = await aggregator.getRouteProfitabilityWithContribution(userId, days);

    res.json({ routes, days });
  } catch (error) {
    logger.error('[Analytics] Error getting route profitability:', error);
    res.status(500).json({ error: 'Failed to get route profitability' });
  }
});

/**
 * GET /api/analytics/purchases
 * Returns fuel and CO2 purchase analysis
 *
 * Query params:
 * - days: Number of days to analyze (default 30)
 */
router.get('/purchases', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const purchases = await aggregator.getPurchaseAnalysis(userId, days);

    res.json({ ...purchases, days });
  } catch (error) {
    logger.error('[Analytics] Error getting purchase analysis:', error);
    res.status(500).json({ error: 'Failed to get purchase analysis' });
  }
});

/**
 * GET /api/analytics/harborfees
 * Returns harbor fee analysis by port
 *
 * Query params:
 * - days: Number of days to analyze (default 30)
 */
router.get('/harborfees', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const ports = await aggregator.getHarborFeeAnalysis(userId, days);

    res.json({ ports, days });
  } catch (error) {
    logger.error('[Analytics] Error getting harbor fee analysis:', error);
    res.status(500).json({ error: 'Failed to get harbor fee analysis' });
  }
});

/**
 * GET /api/analytics/contributions
 * Returns alliance contribution analysis
 *
 * Query params:
 * - days: Number of days to analyze (default 30)
 */
router.get('/contributions', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const contributions = await aggregator.getContributionAnalysis(userId, days);

    res.json({ ...contributions, days });
  } catch (error) {
    logger.error('[Analytics] Error getting contribution analysis:', error);
    res.status(500).json({ error: 'Failed to get contribution analysis' });
  }
});

/**
 * GET /api/analytics/trend
 * Returns daily revenue trend data
 *
 * Query params:
 * - days: Number of days (default 30)
 */
router.get('/trend', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const trend = await aggregator.getDailyRevenueTrend(userId, days);

    res.json({ trend, days });
  } catch (error) {
    logger.error('[Analytics] Error getting revenue trend:', error);
    res.status(500).json({ error: 'Failed to get revenue trend' });
  }
});

/**
 * GET /api/analytics/all
 * Returns all analytics data in one call (for dashboard)
 * Uses merged game + local data for comprehensive overview
 *
 * Query params:
 * - days: Number of days to analyze (default 7)
 */
router.get('/all', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 7;

    // Fetch all data in parallel - using merged summary as primary source
    const [mergedSummary, vessels, routes, purchases, harborFees, contributions, trend, detailedExpenses] = await Promise.all([
      aggregator.getMergedSummary(userId, days),
      aggregator.getVesselPerformanceWithContribution(userId, days),
      aggregator.getRouteProfitabilityWithContribution(userId, days),
      aggregator.getPurchaseAnalysis(userId, days),
      aggregator.getHarborFeeAnalysis(userId, days),
      aggregator.getContributionAnalysis(userId, days),
      aggregator.getDailyRevenueTrend(userId, days),
      aggregator.getDetailedExpenses(userId, days)
    ]);

    res.json({
      summary: mergedSummary,
      vessels,
      routes,
      purchases,
      harborFees,
      contributions,
      trend,
      detailedExpenses,
      days
    });
  } catch (error) {
    logger.error('[Analytics] Error getting all analytics:', error);
    res.status(500).json({ error: 'Failed to get analytics data' });
  }
});

/**
 * GET /api/analytics/route-contribution
 * Returns contribution analysis per route
 *
 * Query params:
 * - days: Number of days to analyze (default 30)
 */
router.get('/route-contribution', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const routeContribution = await aggregator.getRouteContribution(userId, days);

    res.json({ routeContribution, days });
  } catch (error) {
    logger.error('[Analytics] Error getting route contribution:', error);
    res.status(500).json({ error: 'Failed to get route contribution' });
  }
});

/**
 * GET /api/analytics/detailed-expenses
 * Returns detailed expense breakdown
 *
 * Query params:
 * - days: Number of days to analyze (default 30)
 */
router.get('/detailed-expenses', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const expenses = await aggregator.getDetailedExpenses(userId, days);

    res.json({ expenses, days });
  } catch (error) {
    logger.error('[Analytics] Error getting detailed expenses:', error);
    res.status(500).json({ error: 'Failed to get detailed expenses' });
  }
});

/**
 * GET /api/analytics/action-types
 * Returns all unique action types in the log
 */
router.get('/action-types', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const actionTypes = await aggregator.getActionTypes(userId);

    res.json({ actionTypes });
  } catch (error) {
    logger.error('[Analytics] Error getting action types:', error);
    res.status(500).json({ error: 'Failed to get action types' });
  }
});

/**
 * GET /api/analytics/logs
 * Returns filtered log entries
 *
 * Query params:
 * - days: Number of days (default 30)
 * - actions: Comma-separated action types (optional)
 * - status: Filter by status (optional)
 * - limit: Max entries to return (default 100)
 */
router.get('/logs', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const actions = req.query.actions ? req.query.actions.split(',') : null;
    const status = req.query.status || null;
    const limit = parseInt(req.query.limit, 10) || 100;

    let logs = await aggregator.getFilteredLogs(userId, days, actions, status);

    // Apply limit
    if (logs.length > limit) {
      logs = logs.slice(0, limit);
    }

    res.json({ logs, total: logs.length, days });
  } catch (error) {
    logger.error('[Analytics] Error getting filtered logs:', error);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

/**
 * POST /api/analytics/vessel-history/sync
 * Start/resume vessel history sync from game API
 * This imports historical departure data as "Game Departure" entries
 *
 * Query params:
 * - forceResync: Force resync all vessels (default: false)
 * - batchSize: Number of vessels per batch, 0 = all (default: 0)
 */
router.post('/vessel-history/sync', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const forceResync = req.query.forceResync === 'true';
    const batchSize = parseInt(req.query.batchSize, 10) || 0;

    logger.info(`[Analytics] Starting vessel history sync (force=${forceResync}, batch=${batchSize})...`);
    const result = await vesselHistoryStore.syncVesselHistory(userId, { forceResync, batchSize });

    res.json({
      success: !result.error,
      ...result
    });
  } catch (error) {
    logger.error('[Analytics] Error syncing vessel history:', error);
    res.status(500).json({ error: 'Failed to sync vessel history' });
  }
});

/**
 * POST /api/analytics/vessel-history/stop
 * Stop the current sync process
 */
router.post('/vessel-history/stop', async (req, res) => {
  try {
    vesselHistoryStore.stopSync();
    res.json({ success: true, message: 'Stop requested' });
  } catch (error) {
    logger.error('[Analytics] Error stopping vessel history sync:', error);
    res.status(500).json({ error: 'Failed to stop sync' });
  }
});

/**
 * GET /api/analytics/vessel-history/progress
 * Get current sync progress
 */
router.get('/vessel-history/progress', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const progress = await vesselHistoryStore.getSyncProgress(userId);
    res.json(progress);
  } catch (error) {
    logger.error('[Analytics] Error getting sync progress:', error);
    res.status(500).json({ error: 'Failed to get sync progress' });
  }
});

/**
 * GET /api/analytics/vessel-history/info
 * Get vessel history store metadata
 */
router.get('/vessel-history/info', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const info = await vesselHistoryStore.getStoreInfo(userId);
    res.json(info);
  } catch (error) {
    logger.error('[Analytics] Error getting vessel history info:', error);
    res.status(500).json({ error: 'Failed to get vessel history info' });
  }
});

/**
 * POST /api/analytics/vessel-history/migrate-tanker-cargo
 * Run tanker cargo migration manually
 */
router.post('/vessel-history/migrate-tanker-cargo', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await vesselHistoryStore.migrateTankerCargo(userId);
    res.json(result);
  } catch (error) {
    logger.error('[Analytics] Error running tanker cargo migration:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/vessel-history/departures
 * Get stored vessel history departures
 *
 * Query params:
 * - days: Number of days to look back (default: all)
 */
router.get('/vessel-history/departures', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = req.query.days ? parseInt(req.query.days, 10) : null;
    let departures;

    if (days) {
      departures = await vesselHistoryStore.getDeparturesByDays(userId, days);
    } else {
      departures = await vesselHistoryStore.getDepartures(userId);
    }

    res.json({ departures, total: departures.length });
  } catch (error) {
    logger.error('[Analytics] Error getting vessel history departures:', error);
    res.status(500).json({ error: 'Failed to get vessel history departures' });
  }
});

// ============================================
// LOOKUP STORE ENDPOINTS (POD4)
// ============================================

/**
 * POST /api/analytics/lookup/build
 * Build/update the lookup table from all PODs
 *
 * Query params:
 * - days: Number of days to process (default: 0 = all)
 */
router.post('/lookup/build', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 0;
    logger.info(`[Analytics] Building lookup table (days=${days})...`);

    const result = await lookupStore.buildLookup(userId, days);

    // Also rematch existing entries with POD3 (fixes entries created before vessel history sync)
    const rematchResult = await lookupStore.rematchPOD3(userId);

    res.json({ success: true, ...result, rematch: rematchResult });
  } catch (error) {
    logger.error('[Analytics] Error building lookup:', error);
    res.status(500).json({ error: 'Failed to build lookup' });
  }
});

/**
 * GET /api/analytics/lookup/all
 * Get all lookup data in a single request (totals, breakdown, daily, info)
 * This is much faster than making 4 separate requests since the 78MB+ JSON
 * file only needs to be loaded once.
 *
 * Query params:
 * - days: Number of days (default: 0 = all)
 */
router.get('/lookup/all', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 0;

    // Load store once and calculate all metrics
    const [totals, breakdown, daily, info] = await Promise.all([
      lookupStore.getTotals(userId, days),
      lookupStore.getBreakdownByType(userId, days),
      lookupStore.getBreakdownByDay(userId, days),
      lookupStore.getStoreInfo(userId)
    ]);

    res.json({
      totals,
      breakdown,
      daily,
      info,
      days
    });
  } catch (error) {
    logger.error('[Analytics] Error getting lookup all:', error.message);
    res.status(500).json({ error: 'Failed to get lookup data' });
  }
});

/**
 * GET /api/analytics/lookup/entries
 * Get all lookup entries
 *
 * Query params:
 * - days: Number of days (default: 0 = all)
 * - limit: Max entries (default: 100)
 * - offset: Pagination offset (default: 0)
 */
router.get('/lookup/entries', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;

    let entries = days > 0
      ? await lookupStore.getEntriesByDays(userId, days)
      : await lookupStore.getEntries(userId);

    const total = entries.length;

    // Apply pagination
    entries = entries.slice(offset, offset + limit);

    res.json({ entries, total, limit, offset });
  } catch (error) {
    logger.error('[Analytics] Error getting lookup entries:', error);
    res.status(500).json({ error: 'Failed to get lookup entries' });
  }
});

/**
 * GET /api/analytics/lookup/totals
 * Get income/expense totals from lookup
 *
 * Query params:
 * - days: Number of days (default: 0 = all)
 */
router.get('/lookup/totals', async (req, res) => {
  try {
    const userId = getUserId();
    logger.debug(`[Analytics] /lookup/totals called, userId=${userId}, days=${req.query.days}`);
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 0;
    const totals = await lookupStore.getTotals(userId, days);

    res.json(totals);
  } catch (error) {
    logger.error('[Analytics] Error getting lookup totals:', error.message);
    logger.error('[Analytics] Stack:', error.stack);
    res.status(500).json({ error: 'Failed to get lookup totals' });
  }
});

/**
 * GET /api/analytics/lookup/breakdown
 * Get breakdown by transaction type
 *
 * Query params:
 * - days: Number of days (default: 0 = all)
 */
router.get('/lookup/breakdown', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 0;
    const breakdown = await lookupStore.getBreakdownByType(userId, days);

    res.json({ breakdown, days });
  } catch (error) {
    logger.error('[Analytics] Error getting lookup breakdown:', error);
    res.status(500).json({ error: 'Failed to get lookup breakdown' });
  }
});

/**
 * GET /api/analytics/lookup/daily
 * Get breakdown by day
 *
 * Query params:
 * - days: Number of days (default: 0 = all)
 */
router.get('/lookup/daily', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 0;
    const daily = await lookupStore.getBreakdownByDay(userId, days);

    res.json({ daily, days });
  } catch (error) {
    logger.error('[Analytics] Error getting lookup daily:', error);
    res.status(500).json({ error: 'Failed to get lookup daily' });
  }
});

/**
 * GET /api/analytics/lookup/details/:id
 * Get full details for a lookup entry from all PODs
 */
router.get('/lookup/details/:id', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const lookupId = req.params.id;
    const details = await lookupStore.getEntryDetails(userId, lookupId);

    if (!details) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json(details);
  } catch (error) {
    logger.error('[Analytics] Error getting lookup details:', error);
    res.status(500).json({ error: 'Failed to get lookup details' });
  }
});

/**
 * GET /api/analytics/lookup/info
 * Get lookup store metadata
 */
router.get('/lookup/info', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const info = await lookupStore.getStoreInfo(userId);
    res.json(info);
  } catch (error) {
    logger.error('[Analytics] Error getting lookup info:', error);
    res.status(500).json({ error: 'Failed to get lookup info' });
  }
});

/**
 * POST /api/analytics/lookup/rebuild
 * Clear and rebuild the lookup store
 * Also triggers vessel history sync first
 *
 * Query params:
 * - days: Number of days to process (default: 0 = all)
 */
router.post('/lookup/rebuild', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const days = parseInt(req.query.days, 10) || 0;
    logger.info(`[Analytics] Rebuilding lookup table (days=${days})...`);

    // 1. Clear existing lookup
    await lookupStore.clearStore(userId);
    logger.info('[Analytics] Lookup store cleared');

    // 2. Sync vessel history first (to ensure POD3 has data)
    logger.info('[Analytics] Syncing vessel history...');
    const syncResult = await vesselHistoryStore.syncVesselHistory(userId);
    logger.info(`[Analytics] Vessel history sync: ${syncResult.newEntries} new entries`);

    // 3. Now rebuild lookup
    const result = await lookupStore.buildLookup(userId, days);

    res.json({
      success: true,
      vesselHistorySync: syncResult,
      lookup: result
    });
  } catch (error) {
    logger.error('[Analytics] Error rebuilding lookup:', error);
    res.status(500).json({ error: 'Failed to rebuild lookup' });
  }
});

/**
 * DELETE /api/analytics/lookup/clear
 * Clear the lookup store (for rebuild)
 */
router.delete('/lookup/clear', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    await lookupStore.clearStore(userId);
    res.json({ success: true, message: 'Lookup store cleared' });
  } catch (error) {
    logger.error('[Analytics] Error clearing lookup:', error);
    res.status(500).json({ error: 'Failed to clear lookup' });
  }
});

/**
 * POST /api/analytics/lookup/rematch
 * Re-match existing lookup entries with POD3 (vessel history)
 * Call this after vessel history sync to fix entries created before sync
 */
router.post('/lookup/rematch', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await lookupStore.rematchPOD3(userId);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[Analytics] Error rematching POD3:', error);
    res.status(500).json({ error: 'Failed to rematch POD3' });
  }
});

/**
 * GET /api/analytics/devel-mode
 * Returns whether developer mode is enabled (undocumented feature)
 */
router.get('/devel-mode', async (req, res) => {
  res.json({ enabled: config.DEVEL_MODE === true });
});

/**
 * GET /api/analytics/api-stats
 * Returns API call statistics with time-series data
 * Only available in develMode
 *
 * Query params:
 * - hours: Number of hours to look back (default 24)
 */
router.get('/api-stats', async (req, res) => {
  if (!config.DEVEL_MODE) {
    return res.status(403).json({ error: 'Developer mode not enabled' });
  }
  try {
    const hours = parseFloat(req.query.hours) || 24;
    const stats = await apiStatsStore.getStats(hours);
    res.json(stats);
  } catch (error) {
    logger.error('[Analytics] Error getting API stats:', error);
    res.status(500).json({ error: 'Failed to get API stats' });
  }
});

/**
 * GET /api/analytics/api-stats/hourly
 * Returns API call statistics aggregated by hour for charts
 * Only available in develMode
 *
 * Query params:
 * - hours: Number of hours to look back (default 24)
 */
router.get('/api-stats/hourly', async (req, res) => {
  if (!config.DEVEL_MODE) {
    return res.status(403).json({ error: 'Developer mode not enabled' });
  }
  try {
    const hours = parseFloat(req.query.hours) || 24;
    const stats = await apiStatsStore.getHourlyStats(hours);
    res.json(stats);
  } catch (error) {
    logger.error('[Analytics] Error getting hourly API stats:', error);
    res.status(500).json({ error: 'Failed to get hourly API stats' });
  }
});

/**
 * GET /api/analytics/api-stats/dates
 * Returns list of available stat file dates
 * Only available in develMode
 */
router.get('/api-stats/dates', async (req, res) => {
  if (!config.DEVEL_MODE) {
    return res.status(403).json({ error: 'Developer mode not enabled' });
  }
  try {
    const dates = await apiStatsStore.getAvailableDates();
    res.json({ dates });
  } catch (error) {
    logger.error('[Analytics] Error getting API stats dates:', error);
    res.status(500).json({ error: 'Failed to get API stats dates' });
  }
});

/**
 * GET /api/analytics/route-vessels
 * Returns all vessels that have traveled a specific route with performance comparison
 *
 * Query params:
 * - origin: Route origin port (required)
 * - destination: Route destination port (required)
 * - days: Number of days (default 30)
 */
router.get('/route-vessels', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { origin, destination } = req.query;
    if (!origin || !destination) {
      return res.status(400).json({ error: 'Origin and destination are required' });
    }

    const days = parseInt(req.query.days, 10) || 30;

    const vesselStats = await aggregator.getVesselsByRoute(userId, origin, destination, days);

    res.json({
      route: `${origin}<>${destination}`,
      displayRoute: aggregator.formatRouteDisplay(`${origin}<>${destination}`),
      vessels: vesselStats
    });
  } catch (error) {
    logger.error('[Analytics] Error getting route vessels:', error);
    res.status(500).json({ error: 'Failed to get route vessel data' });
  }
});

/**
 * GET /api/analytics/test-vessel-history/:vesselId
 * Debug endpoint to see what Game API returns for a single vessel
 */
router.get('/test-vessel-history/:vesselId', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const vesselId = parseInt(req.params.vesselId, 10);
    const { apiCallWithRetry } = require('../utils/api');
    const { getDb } = require('../database/index');

    // Get current oldest entry for this vessel in DB
    const db = getDb(userId);
    const oldest = db.prepare('SELECT MIN(timestamp) as ts FROM departures WHERE vessel_id = ?').get(vesselId);
    const count = db.prepare('SELECT COUNT(*) as c FROM departures WHERE vessel_id = ?').get(vesselId);

    // Query Game API directly
    const response = await apiCallWithRetry('/vessel/get-vessel-history', 'POST', { vessel_id: vesselId });

    if (response.data?.vessel_history) {
      const history = response.data.vessel_history;
      history.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      res.json({
        vesselId,
        vesselName: response.data.user_vessel?.name,
        database: {
          entryCount: count.c,
          oldestEntry: oldest.ts ? new Date(oldest.ts).toISOString() : null
        },
        gameApi: {
          entryCount: history.length,
          oldestEntry: history.length > 0 ? history[0].created_at : null,
          newestEntry: history.length > 0 ? history[history.length - 1].created_at : null,
          sampleEntries: history.slice(0, 3).map(h => ({ created_at: h.created_at, route: `${h.route_origin} -> ${h.route_destination}` }))
        }
      });
    } else {
      res.json({
        vesselId,
        error: 'No history returned',
        response
      });
    }
  } catch (error) {
    logger.error('[Analytics] Error testing vessel history:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/analytics/force-resync
 * Force a complete resync of vessel history from Game API
 * This fetches the ENTIRE history for all vessels, not just new entries
 * Use this to fill in missing historical data
 */
router.post('/force-resync', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    logger.info('[Analytics] Force resync requested - fetching complete vessel history from Game API');

    // Get current state before resync
    const infoBefore = await vesselHistoryStore.getStoreInfo(userId);

    // Run force resync - this fetches COMPLETE history for all vessels
    const syncResult = await vesselHistoryStore.syncVesselHistory(userId, { forceResync: true });

    // Get state after resync
    const infoAfter = await vesselHistoryStore.getStoreInfo(userId);

    // Rebuild lookup to match new POD3 entries
    const lookupResult = await lookupStore.buildLookup(userId, 0);

    logger.info(`[Analytics] Force resync complete: ${syncResult.newEntries} new departures, lookup matched POD3=${lookupResult.matchedPod3}`);

    res.json({
      success: true,
      message: 'Force resync complete',
      sync: {
        newEntries: syncResult.newEntries,
        totalDepartures: infoAfter.totalDepartures,
        departuresBefore: infoBefore.totalDepartures,
        oldestDeparture: infoAfter.oldestDeparture,
        newestDeparture: infoAfter.newestDeparture
      },
      lookup: {
        newEntries: lookupResult.newEntries,
        matchedPod2: lookupResult.matchedPod2,
        matchedPod3: lookupResult.matchedPod3
      }
    });
  } catch (error) {
    logger.error('[Analytics] Error during force resync:', error);
    res.status(500).json({ error: 'Failed to force resync vessel history' });
  }
});

// ============================================================================
// PORT DEMAND HISTORY ENDPOINTS
// ============================================================================

/**
 * GET /api/analytics/port-demand/status
 * Returns sync status and store statistics
 */
router.get('/port-demand/status', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const syncStatus = portDemandSync.getStatus();
    const storeStats = await portDemandStore.getStoreStats(userId);

    res.json({
      sync: syncStatus,
      store: storeStats
    });
  } catch (error) {
    logger.error('[Analytics] Error getting port demand status:', error);
    res.status(500).json({ error: 'Failed to get port demand status' });
  }
});

/**
 * GET /api/analytics/port-demand/history/:portCode
 * Returns demand history for a specific port
 *
 * Query params:
 * - days: Number of days to look back (default 7)
 */
router.get('/port-demand/history/:portCode', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { portCode } = req.params;
    const days = parseInt(req.query.days, 10);
    if (isNaN(days)) {
      return res.status(400).json({ error: 'Invalid days parameter' });
    }

    const history = await portDemandStore.getPortHistory(userId, portCode, days);

    res.json({
      portCode,
      days,
      entries: history.length,
      history
    });
  } catch (error) {
    logger.error('[Analytics] Error getting port demand history:', error);
    res.status(500).json({ error: 'Failed to get port demand history' });
  }
});

/**
 * GET /api/analytics/port-demand/trends/:portCode
 * Returns hourly demand trends for a port
 *
 * Query params:
 * - days: Number of days to analyze (default 7)
 */
router.get('/port-demand/trends/:portCode', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { portCode } = req.params;
    const days = parseInt(req.query.days, 10);
    if (isNaN(days)) {
      return res.status(400).json({ error: 'Invalid days parameter' });
    }

    const trends = await portDemandStore.getPortTrends(userId, portCode, days);

    res.json({
      portCode,
      days,
      trends
    });
  } catch (error) {
    logger.error('[Analytics] Error getting port demand trends:', error);
    res.status(500).json({ error: 'Failed to get port demand trends' });
  }
});

/**
 * GET /api/analytics/port-demand/latest
 * Returns latest demand snapshot for all ports
 */
router.get('/port-demand/latest', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const latest = await portDemandStore.getLatestDemand(userId);

    res.json({
      ports: latest.length,
      data: latest
    });
  } catch (error) {
    logger.error('[Analytics] Error getting latest port demand:', error);
    res.status(500).json({ error: 'Failed to get latest port demand' });
  }
});

/**
 * POST /api/analytics/port-demand/cleanup
 * Cleans up old entries (admin function)
 *
 * Body:
 * - daysToKeep: Number of days to keep (default 30)
 */
router.post('/port-demand/cleanup', express.json(), async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const daysToKeep = parseInt(req.body.daysToKeep, 10);
    if (isNaN(daysToKeep)) {
      return res.status(400).json({ error: 'Invalid daysToKeep parameter' });
    }

    const deleted = await portDemandStore.cleanupOldEntries(userId, daysToKeep);

    res.json({
      success: true,
      deleted,
      daysKept: daysToKeep
    });
  } catch (error) {
    logger.error('[Analytics] Error cleaning up port demand:', error);
    res.status(500).json({ error: 'Failed to cleanup port demand history' });
  }
});

module.exports = router;
