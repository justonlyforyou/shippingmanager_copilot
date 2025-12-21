/**
 * @fileoverview API Stats Time-Series Store (SQLite)
 *
 * Stores API call statistics in SQLite for reliability and performance.
 * Data is aggregated per minute and automatically cleaned after 7 days.
 *
 * @module server/analytics/api-stats-store
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getAppBaseDir, isPackaged } = require('../config');

// Get native binding path for better-sqlite3
function getNativeBindingPath() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  }
  return undefined;
}

const nativeBinding = getNativeBindingPath();
const Database = require('better-sqlite3');

// Database connection
let db = null;

// Retention: 7 days
const RETENTION_DAYS = 7;

// In-memory buffer for current minute's stats
let currentMinuteBuffer = {
  minute: null, // YYYY-MM-DD HH:mm
  endpoints: new Map() // endpoint -> { count, totalDuration, errors }
};

// Write buffer to disk every minute
const FLUSH_INTERVAL = 60000;
let flushInterval = null;

/**
 * Get database path
 * @returns {string} Path to api stats database
 */
function getDbPath() {
  const isPkg = isPackaged();
  const baseDir = isPkg
    ? path.join(getAppBaseDir(), 'userdata', 'database')
    : path.join(__dirname, '..', '..', 'userdata', 'database');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  return path.join(baseDir, 'api_stats.db');
}

/**
 * Get or create database connection
 * @returns {Database} SQLite database instance
 */
function getDb() {
  if (db) return db;

  const dbPath = getDbPath();
  const dbOptions = nativeBinding ? { nativeBinding } : {};
  db = new Database(dbPath, dbOptions);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      minute_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      total_duration INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(minute_key, endpoint)
    );

    CREATE INDEX IF NOT EXISTS idx_api_stats_minute ON api_stats(minute_key);
    CREATE INDEX IF NOT EXISTS idx_api_stats_endpoint ON api_stats(endpoint);
  `);

  logger.info('[APIStatsStore] SQLite database initialized');
  return db;
}

/**
 * Close database connection
 */
function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.debug('[APIStatsStore] Database closed');
  }
}

/**
 * Get current minute key (YYYY-MM-DD HH:mm)
 * @returns {string} Minute key
 */
function getCurrentMinuteKey() {
  const now = new Date();
  return now.toISOString().slice(0, 16).replace('T', ' ');
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
 * Flush buffer to database
 */
async function flushBuffer() {
  if (!currentMinuteBuffer.minute || currentMinuteBuffer.endpoints.size === 0) {
    return;
  }

  const minuteKey = currentMinuteBuffer.minute;

  try {
    const database = getDb();

    const upsert = database.prepare(`
      INSERT INTO api_stats (minute_key, endpoint, count, total_duration, errors)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(minute_key, endpoint) DO UPDATE SET
        count = count + excluded.count,
        total_duration = total_duration + excluded.total_duration,
        errors = errors + excluded.errors
    `);

    const insertMany = database.transaction((entries) => {
      for (const [endpoint, stats] of entries) {
        upsert.run(minuteKey, endpoint, stats.count, stats.totalDuration, stats.errors);
      }
    });

    insertMany(currentMinuteBuffer.endpoints);

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
 * @param {number} hours - Hours to look back (0 = all)
 * @returns {Promise<Object>} Aggregated stats
 */
async function getStats(hours = 24) {
  // Flush current buffer first
  await flushBuffer();

  const database = getDb();

  const result = {
    timeRange: { hours },
    totalCalls: 0,
    totalErrors: 0,
    byEndpoint: {},
    timeSeries: []
  };

  // Calculate cutoff time
  const now = new Date();
  const startTime = hours > 0 ? new Date(now.getTime() - hours * 60 * 60 * 1000) : null;
  const startMinuteKey = startTime ? startTime.toISOString().slice(0, 16).replace('T', ' ') : null;

  // Query all stats within time range
  let rows;
  if (startMinuteKey) {
    rows = database.prepare(`
      SELECT minute_key, endpoint, count, total_duration, errors
      FROM api_stats
      WHERE minute_key >= ?
      ORDER BY minute_key ASC
    `).all(startMinuteKey);
  } else {
    rows = database.prepare(`
      SELECT minute_key, endpoint, count, total_duration, errors
      FROM api_stats
      ORDER BY minute_key ASC
    `).all();
  }

  // Group by minute for time series
  const minuteData = new Map();

  for (const row of rows) {
    // Build time series
    if (!minuteData.has(row.minute_key)) {
      minuteData.set(row.minute_key, { total: 0, endpoints: {} });
    }
    const minute = minuteData.get(row.minute_key);
    minute.total += row.count;
    minute.endpoints[row.endpoint] = {
      count: row.count,
      avgDuration: row.count > 0 ? Math.round(row.total_duration / row.count) : 0,
      errors: row.errors
    };

    result.totalCalls += row.count;
    result.totalErrors += row.errors;

    // Aggregate by endpoint
    if (!result.byEndpoint[row.endpoint]) {
      result.byEndpoint[row.endpoint] = { count: 0, errors: 0, avgDuration: 0, durations: [] };
    }
    result.byEndpoint[row.endpoint].count += row.count;
    result.byEndpoint[row.endpoint].errors += row.errors;
    if (row.total_duration > 0) {
      result.byEndpoint[row.endpoint].durations.push({
        count: row.count,
        avg: Math.round(row.total_duration / row.count)
      });
    }
  }

  // Convert minute map to time series array
  for (const [minute, data] of minuteData) {
    result.timeSeries.push({
      minute,
      total: data.total,
      endpoints: data.endpoints
    });
  }

  // Calculate weighted average duration per endpoint
  for (const [, stats] of Object.entries(result.byEndpoint)) {
    if (stats.durations.length > 0) {
      const totalWeight = stats.durations.reduce((sum, d) => sum + d.count, 0);
      const weightedSum = stats.durations.reduce((sum, d) => sum + d.count * d.avg, 0);
      stats.avgDuration = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    }
    delete stats.durations;
  }

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
 * Get list of available dates (for compatibility)
 * @returns {Promise<Array>} List of available dates
 */
async function getAvailableDates() {
  const database = getDb();

  const rows = database.prepare(`
    SELECT DISTINCT substr(minute_key, 1, 10) as date_key
    FROM api_stats
    ORDER BY date_key DESC
  `).all();

  return rows.map(r => r.date_key);
}

/**
 * Delete stats older than N days
 * @param {number} daysToKeep - Number of days to keep
 * @returns {Promise<number>} Number of rows deleted
 */
async function cleanupOldStats(daysToKeep = 7) {
  const database = getDb();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  const cutoffKey = cutoffDate.toISOString().slice(0, 16).replace('T', ' ');

  const result = database.prepare(`
    DELETE FROM api_stats WHERE minute_key < ?
  `).run(cutoffKey);

  if (result.changes > 0) {
    logger.info(`[APIStatsStore] Deleted ${result.changes} old stat entries (>${daysToKeep} days)`);
  }

  return result.changes;
}

/**
 * Migrate existing JSON files to SQLite
 * @returns {Promise<Object>} Migration result
 */
async function migrateFromJson() {
  const isPkg = isPackaged();
  const jsonDir = isPkg
    ? path.join(getAppBaseDir(), 'userdata', 'api-stats')
    : path.join(__dirname, '../../userdata/api-stats');

  if (!fs.existsSync(jsonDir)) {
    return { migrated: 0, files: 0 };
  }

  const files = fs.readdirSync(jsonDir)
    .filter(f => {
      // Only migrate clean api-stats-YYYY-MM-DD.json files
      if (!f.startsWith('api-stats-')) return false;
      if (!f.endsWith('.json')) return false;
      if (f.includes('corrupted')) return false;
      if (f.includes('.new.')) return false;
      if (f.includes('.migrated.')) return false;
      // Check format: api-stats-YYYY-MM-DD.json (exactly 25 chars)
      return f.length === 25;
    });

  if (files.length === 0) {
    return { migrated: 0, files: 0 };
  }

  logger.info(`[APIStatsStore] Migrating ${files.length} JSON files to SQLite...`);

  const database = getDb();
  let totalMigrated = 0;

  const upsert = database.prepare(`
    INSERT INTO api_stats (minute_key, endpoint, count, total_duration, errors)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(minute_key, endpoint) DO UPDATE SET
      count = count + excluded.count,
      total_duration = total_duration + excluded.total_duration,
      errors = errors + excluded.errors
  `);

  for (const file of files) {
    const filePath = path.join(jsonDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (!data.minutes) continue;

      const insertMany = database.transaction((minutes) => {
        for (const [minuteKey, minuteData] of Object.entries(minutes)) {
          if (!minuteData.endpoints) continue;

          for (const [endpoint, stats] of Object.entries(minuteData.endpoints)) {
            const totalDuration = stats.avgDuration * stats.count;
            upsert.run(minuteKey, endpoint, stats.count, totalDuration, stats.errors);
            totalMigrated++;
          }
        }
      });

      insertMany(data.minutes);
      logger.debug(`[APIStatsStore] Migrated ${file}`);

      // Rename file to mark as migrated
      const migratedPath = filePath.replace('.json', '.migrated.json');
      fs.renameSync(filePath, migratedPath);
    } catch (err) {
      logger.error(`[APIStatsStore] Failed to migrate ${file}:`, err.message);
    }
  }

  logger.info(`[APIStatsStore] Migration complete: ${totalMigrated} entries from ${files.length} files`);
  return { migrated: totalMigrated, files: files.length };
}

/**
 * Start auto-flush interval and run initial cleanup/migration
 */
function startAutoFlush() {
  if (flushInterval) return;

  // Ensure database is initialized
  getDb();

  flushInterval = setInterval(() => {
    flushBuffer().catch(err => {
      logger.error('[APIStatsStore] Auto-flush failed:', err);
    });
  }, FLUSH_INTERVAL);

  // Run migration from JSON on startup (one-time)
  migrateFromJson().then(result => {
    if (result.files > 0) {
      logger.info(`[APIStatsStore] Migrated ${result.migrated} entries from ${result.files} JSON files`);
    }
  }).catch(err => {
    logger.error('[APIStatsStore] Migration failed:', err);
  });

  // Run cleanup on startup (7 day retention)
  cleanupOldStats(RETENTION_DAYS).catch(err => {
    logger.error('[APIStatsStore] Cleanup failed:', err);
  });

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
  closeDb();
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
  stopAutoFlush,
  migrateFromJson
};
