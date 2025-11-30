/**
 * @fileoverview API Stats Time-Series Store
 *
 * Stores API call statistics in time-series format for analytics.
 * Data is aggregated per minute to keep file sizes manageable.
 *
 * Storage format:
 * - One file per day: api-stats-YYYY-MM-DD.json
 * - Each file contains minute-by-minute stats per endpoint
 *
 * @module server/analytics/api-stats-store
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { getAppDataDir } = require('../config');

const isPkg = !!process.pkg;
const DATA_DIR = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'api-stats')
  : path.join(__dirname, '../../userdata/api-stats');

// In-memory buffer for current minute's stats
let currentMinuteBuffer = {
  minute: null, // YYYY-MM-DD HH:mm
  endpoints: new Map() // endpoint -> { count, totalDuration, errors }
};

// Write buffer to disk every minute
const FLUSH_INTERVAL = 60000;
let flushInterval = null;

/**
 * Get current minute key (YYYY-MM-DD HH:mm)
 * @returns {string} Minute key
 */
function getCurrentMinuteKey() {
  const now = new Date();
  return now.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Get file path for a specific date
 * @param {string} dateKey - Date in YYYY-MM-DD format
 * @returns {string} File path
 */
function getStorePathForDate(dateKey) {
  return path.join(DATA_DIR, `api-stats-${dateKey}.json`);
}

/**
 * Ensure stats directory exists
 */
async function ensureDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logger.error('[APIStatsStore] Failed to create directory:', err);
    }
  }
}

/**
 * Load stats for a specific date
 * @param {string} dateKey - Date in YYYY-MM-DD format
 * @returns {Promise<Object>} Stats data
 */
async function loadDayStats(dateKey) {
  try {
    const filePath = getStorePathForDate(dateKey);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        date: dateKey,
        minutes: {} // minute -> { endpoints: { endpoint -> stats } }
      };
    }
    logger.error('[APIStatsStore] Failed to load stats:', err);
    return { date: dateKey, minutes: {} };
  }
}

/**
 * Save stats for a specific date
 * @param {string} dateKey - Date in YYYY-MM-DD format
 * @param {Object} data - Stats data
 */
async function saveDayStats(dateKey, data) {
  await ensureDir();
  const filePath = getStorePathForDate(dateKey);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Record an API call
 * @param {string} endpoint - API endpoint
 * @param {number} duration - Call duration in ms
 * @param {boolean} success - Whether call succeeded
 */
function recordCall(endpoint, duration = 0, success = true) {
  const minuteKey = getCurrentMinuteKey();

  // If minute changed, flush buffer first
  if (currentMinuteBuffer.minute && currentMinuteBuffer.minute !== minuteKey) {
    flushBuffer();
  }

  currentMinuteBuffer.minute = minuteKey;

  // Get or create endpoint stats
  let stats = currentMinuteBuffer.endpoints.get(endpoint);
  if (!stats) {
    stats = { count: 0, totalDuration: 0, errors: 0 };
    currentMinuteBuffer.endpoints.set(endpoint, stats);
  }

  stats.count++;
  stats.totalDuration += duration;
  if (!success) {
    stats.errors++;
  }
}

/**
 * Flush buffer to disk
 */
async function flushBuffer() {
  if (!currentMinuteBuffer.minute || currentMinuteBuffer.endpoints.size === 0) {
    return;
  }

  const minuteKey = currentMinuteBuffer.minute;
  const dateKey = minuteKey.slice(0, 10);

  try {
    const dayStats = await loadDayStats(dateKey);

    // Convert Map to object for storage
    const endpointStats = {};
    for (const [endpoint, stats] of currentMinuteBuffer.endpoints) {
      endpointStats[endpoint] = {
        count: stats.count,
        avgDuration: stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0,
        errors: stats.errors
      };
    }

    dayStats.minutes[minuteKey] = {
      total: Array.from(currentMinuteBuffer.endpoints.values()).reduce((sum, s) => sum + s.count, 0),
      endpoints: endpointStats
    };

    await saveDayStats(dateKey, dayStats);

    logger.debug(`[APIStatsStore] Flushed ${currentMinuteBuffer.endpoints.size} endpoints for ${minuteKey}`);
  } catch (err) {
    logger.error('[APIStatsStore] Failed to flush buffer:', err);
  }

  // Reset buffer
  currentMinuteBuffer = {
    minute: null,
    endpoints: new Map()
  };
}

/**
 * Get stats for a time range
 * @param {number} hours - Hours to look back (0 = today only)
 * @returns {Promise<Object>} Aggregated stats
 */
async function getStats(hours = 24) {
  // Flush current buffer first
  await flushBuffer();

  const result = {
    timeRange: { hours },
    totalCalls: 0,
    totalErrors: 0,
    byEndpoint: {},
    timeSeries: [] // Array of { minute, total, endpoints }
  };

  // Calculate which days to load
  const now = new Date();
  const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const days = new Set();

  for (let d = new Date(startTime); d <= now; d.setDate(d.getDate() + 1)) {
    days.add(d.toISOString().slice(0, 10));
  }

  // Load each day's stats
  for (const dateKey of days) {
    try {
      const dayStats = await loadDayStats(dateKey);

      for (const [minuteKey, minuteData] of Object.entries(dayStats.minutes)) {
        const minuteTime = new Date(minuteKey.replace(' ', 'T') + ':00Z');
        if (minuteTime < startTime || minuteTime > now) continue;

        result.timeSeries.push({
          minute: minuteKey,
          total: minuteData.total,
          endpoints: minuteData.endpoints
        });

        result.totalCalls += minuteData.total;

        // Aggregate by endpoint
        for (const [endpoint, stats] of Object.entries(minuteData.endpoints)) {
          if (!result.byEndpoint[endpoint]) {
            result.byEndpoint[endpoint] = { count: 0, errors: 0, avgDuration: 0, durations: [] };
          }
          result.byEndpoint[endpoint].count += stats.count;
          result.byEndpoint[endpoint].errors += stats.errors;
          if (stats.avgDuration > 0) {
            result.byEndpoint[endpoint].durations.push({ count: stats.count, avg: stats.avgDuration });
          }
          result.totalErrors += stats.errors;
        }
      }
    } catch (err) {
      logger.error(`[APIStatsStore] Failed to load stats for ${dateKey}:`, err);
    }
  }

  // Calculate weighted average duration per endpoint
  for (const [_endpoint, stats] of Object.entries(result.byEndpoint)) {
    if (stats.durations.length > 0) {
      const totalWeight = stats.durations.reduce((sum, d) => sum + d.count, 0);
      const weightedSum = stats.durations.reduce((sum, d) => sum + d.count * d.avg, 0);
      stats.avgDuration = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    }
    delete stats.durations;
  }

  // Sort time series by minute
  result.timeSeries.sort((a, b) => a.minute.localeCompare(b.minute));

  return result;
}

/**
 * Get aggregated stats by hour for charting
 * @param {number} hours - Hours to look back
 * @returns {Promise<Object>} Hourly aggregated stats
 */
async function getHourlyStats(hours = 24) {
  const stats = await getStats(hours);

  const hourlyData = {};

  for (const entry of stats.timeSeries) {
    const hourKey = entry.minute.slice(0, 13); // YYYY-MM-DD HH

    if (!hourlyData[hourKey]) {
      hourlyData[hourKey] = { total: 0, endpoints: {} };
    }

    hourlyData[hourKey].total += entry.total;

    for (const [endpoint, endpointStats] of Object.entries(entry.endpoints)) {
      if (!hourlyData[hourKey].endpoints[endpoint]) {
        hourlyData[hourKey].endpoints[endpoint] = 0;
      }
      hourlyData[hourKey].endpoints[endpoint] += endpointStats.count;
    }
  }

  return {
    timeRange: { hours },
    totalCalls: stats.totalCalls,
    byEndpoint: stats.byEndpoint,
    hourly: Object.entries(hourlyData)
      .map(([hour, data]) => ({ hour, ...data }))
      .sort((a, b) => a.hour.localeCompare(b.hour))
  };
}

/**
 * Get list of available stat files (for data retention UI)
 * @returns {Promise<Array>} List of available dates
 */
async function getAvailableDates() {
  await ensureDir();
  try {
    const files = await fs.readdir(DATA_DIR);
    return files
      .filter(f => f.startsWith('api-stats-') && f.endsWith('.json'))
      .map(f => f.replace('api-stats-', '').replace('.json', ''))
      .sort()
      .reverse();
  } catch (err) {
    logger.error('[APIStatsStore] Failed to list files:', err);
    return [];
  }
}

/**
 * Delete stats older than N days
 * @param {number} daysToKeep - Number of days to keep
 * @returns {Promise<number>} Number of files deleted
 */
async function cleanupOldStats(daysToKeep = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  const cutoffKey = cutoffDate.toISOString().slice(0, 10);

  let deleted = 0;
  const dates = await getAvailableDates();

  for (const dateKey of dates) {
    if (dateKey < cutoffKey) {
      try {
        await fs.unlink(getStorePathForDate(dateKey));
        deleted++;
        logger.info(`[APIStatsStore] Deleted old stats: ${dateKey}`);
      } catch (err) {
        logger.error(`[APIStatsStore] Failed to delete ${dateKey}:`, err);
      }
    }
  }

  return deleted;
}

/**
 * Start auto-flush interval
 */
function startAutoFlush() {
  if (flushInterval) return;

  flushInterval = setInterval(() => {
    flushBuffer().catch(err => {
      logger.error('[APIStatsStore] Auto-flush failed:', err);
    });
  }, FLUSH_INTERVAL);

  logger.info('[APIStatsStore] Started auto-flush (every 60s)');
}

/**
 * Stop auto-flush and flush remaining data
 */
async function stopAutoFlush() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  await flushBuffer();
  logger.info('[APIStatsStore] Stopped auto-flush');
}

module.exports = {
  recordCall,
  flushBuffer,
  getStats,
  getHourlyStats,
  getAvailableDates,
  cleanupOldStats,
  startAutoFlush,
  stopAutoFlush
};
