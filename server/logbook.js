/**
 * Autopilot Logbook Module
 *
 * Manages logging of all autopilot actions (success and errors) for debugging,
 * transparency, and accountability. Logs are stored in SQLite database.
 *
 * Features:
 * - SQLite storage for reliable persistence
 * - Filter support (status, time range, search)
 * - Export to TXT, CSV, JSON formats
 * - Manual deletion
 */

const crypto = require('crypto');
const logger = require('./utils/logger');

/**
 * Log an autopilot action
 *
 * @param {string} userId - User ID
 * @param {string} autopilot - Autopilot name (e.g., "Auto-Depart", "Auto-Fuel")
 * @param {string} status - "SUCCESS" or "ERROR"
 * @param {string} summary - Human-readable summary (e.g., "12 vessels | +$1,876,204")
 * @param {object} details - Autopilot-specific details object
 * @returns {object} The created log entry
 */
async function logAutopilotAction(userId, autopilot, status, summary, details = {}) {
  // Use actionTimestamp from details if provided (for accurate matching with game transactions)
  // Otherwise fall back to current time
  const timestamp = details.actionTimestamp || Date.now();

  // Remove actionTimestamp from details to keep it clean
  const cleanDetails = { ...details };
  delete cleanDetails.actionTimestamp;

  const logEntry = {
    id: crypto.randomUUID(),
    timestamp,
    autopilot,
    status,
    summary,
    details: cleanDetails
  };

  // Write to SQLite
  try {
    const { getDb } = require('./database');
    const db = getDb(userId);
    db.prepare(`
      INSERT OR IGNORE INTO autopilot_log (id, timestamp, autopilot, status, summary, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      logEntry.id,
      logEntry.timestamp,
      logEntry.autopilot,
      logEntry.status,
      logEntry.summary,
      JSON.stringify(logEntry.details)
    );
  } catch (dbErr) {
    logger.error(`Logbook: SQLite write failed: ${dbErr.message}`);
  }

  logger.debug(`Logbook: [${status}] ${autopilot}: ${summary}`);

  // Broadcast to all connected clients via WebSocket
  try {
    const { broadcastToUser } = require('./websocket');
    broadcastToUser(userId, 'logbook_update', logEntry);
  } catch {
    // Silently fail if WebSocket not available (e.g., during startup)
  }

  return logEntry;
}

/**
 * Determines transaction type from log entry
 * @param {object} log - Log entry
 * @returns {string} - 'INCOME', 'EXPENSE', or ''
 */
function getTransactionType(log) {
  if (!log.summary) return '';

  // Income: summary contains "+$" (e.g., "+$1,234")
  if (log.summary.includes('+$')) {
    return 'INCOME';
  }

  // Expense: summary contains "-$" (e.g., "-$1,234") OR contains only "$" with specific autopilots
  if (log.summary.includes('-$')) {
    return 'EXPENSE';
  }

  // Additional expense autopilots that show cost without minus sign
  const expenseAutopilots = ['Auto-Drydock', 'Auto-Fuel', 'Auto-CO2', 'Auto-Anchor Purchase', 'Auto-Reputation'];
  if (expenseAutopilots.includes(log.autopilot) && log.summary.includes('$')) {
    return 'EXPENSE';
  }

  return '';
}

/**
 * Get category from action name
 * @param {string} action - Action/autopilot name
 * @returns {string} Category (BUNKER, VESSEL, AUTOPILOT, ANCHOR, SETTINGS, STOCK)
 */
function getCategoryFromAction(action) {
  if (!action) return 'AUTOPILOT';

  if (action.includes('Fuel') || action.includes('CO2') || action.includes('Bunker')) {
    return 'BUNKER';
  }

  if (action.includes('Vessel') || action.includes('Depart') || action.includes('Repair') || action.includes('Drydock')) {
    return 'VESSEL';
  }

  if (action.includes('Anchor')) {
    return 'ANCHOR';
  }

  if (action.includes('Settings')) {
    return 'SETTINGS';
  }

  if (action.includes('Stock')) {
    return 'STOCK';
  }

  return 'AUTOPILOT';
}

/**
 * Get source from action name
 * @param {string} action - Action/autopilot name
 * @returns {string} Source (MANUAL or AUTOPILOT)
 */
function getSourceFromAction(action) {
  if (!action) return 'AUTOPILOT';

  if (action.startsWith('Manual ') || action.includes('Manual')) {
    return 'MANUAL';
  }

  return 'AUTOPILOT';
}

/**
 * Recursively searches through an object for a search term
 * @param {*} obj - Object to search through
 * @param {string} searchTerm - Term to search for (case-insensitive)
 * @returns {boolean} - True if term found anywhere in object
 */
function searchInObject(obj, searchTerm) {
  if (!searchTerm) return true;

  const lowerSearch = searchTerm.toLowerCase();

  // Handle primitive types
  if (obj === null || obj === undefined) {
    return false;
  }
  if (typeof obj !== 'object') {
    return String(obj).toLowerCase().includes(lowerSearch);
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.some(item => searchInObject(item, searchTerm));
  }

  // Handle objects
  for (const value of Object.values(obj)) {
    if (searchInObject(value, searchTerm)) {
      return true;
    }
  }

  return false;
}

/**
 * Get log entries with optional filters from SQLite
 *
 * @param {string} userId - User ID
 * @param {object} filters - Filter options
 * @param {string} filters.status - "SUCCESS", "ERROR", "WARNING", or "ALL"
 * @param {string} filters.timeRange - "1h", "2h", "6h", "12h", "24h", "today", "yesterday", "48h", "7days", "lastweek", "30days", "lastmonth", or "all"
 * @param {string} filters.autopilot - Autopilot name or "ALL"
 * @param {string} filters.search - Search term (full-text search across all fields including details)
 * @returns {array} Filtered log entries
 */
async function getLogEntries(userId, filters = {}) {
  const { getDb } = require('./database');
  const db = getDb(userId);

  // Build SQL query with filters
  let query = 'SELECT id, timestamp, autopilot, status, summary, details FROM autopilot_log WHERE 1=1';
  const params = [];

  // Status filter
  if (filters.status && filters.status !== 'ALL') {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  // Autopilot filter
  if (filters.autopilot && filters.autopilot !== 'ALL') {
    query += ' AND autopilot = ?';
    params.push(filters.autopilot);
  }

  // Time range filter
  if (filters.timeRange && filters.timeRange !== 'all') {
    const now = Date.now();
    let cutoffStart;
    let cutoffEnd;

    if (filters.timeRange === '1h') {
      cutoffStart = now - (1 * 60 * 60 * 1000);
    } else if (filters.timeRange === '2h') {
      cutoffStart = now - (2 * 60 * 60 * 1000);
    } else if (filters.timeRange === '6h') {
      cutoffStart = now - (6 * 60 * 60 * 1000);
    } else if (filters.timeRange === '12h') {
      cutoffStart = now - (12 * 60 * 60 * 1000);
    } else if (filters.timeRange === '24h') {
      cutoffStart = now - (24 * 60 * 60 * 1000);
    } else if (filters.timeRange === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      cutoffStart = today.getTime();
    } else if (filters.timeRange === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      cutoffStart = yesterday.getTime();
      cutoffEnd = today.getTime();
    } else if (filters.timeRange === '48h') {
      cutoffStart = now - (48 * 60 * 60 * 1000);
    } else if (filters.timeRange === '7days') {
      cutoffStart = now - (7 * 24 * 60 * 60 * 1000);
    } else if (filters.timeRange === 'lastweek') {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - daysToMonday);
      thisMonday.setHours(0, 0, 0, 0);
      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(thisMonday.getDate() - 7);
      cutoffStart = lastMonday.getTime();
      cutoffEnd = thisMonday.getTime();
    } else if (filters.timeRange === '30days') {
      cutoffStart = now - (30 * 24 * 60 * 60 * 1000);
    } else if (filters.timeRange === 'lastmonth') {
      const today = new Date();
      const firstDayOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const firstDayOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      cutoffStart = firstDayOfLastMonth.getTime();
      cutoffEnd = firstDayOfThisMonth.getTime();
    }

    if (cutoffStart !== undefined) {
      query += ' AND timestamp >= ?';
      params.push(cutoffStart);
    }
    if (cutoffEnd !== undefined) {
      query += ' AND timestamp < ?';
      params.push(cutoffEnd);
    }
  }

  query += ' ORDER BY timestamp DESC';

  // Execute query
  let logs = db.prepare(query).all(...params);

  // Parse details JSON and add computed fields
  logs = logs.map(log => ({
    ...log,
    details: log.details ? JSON.parse(log.details) : {},
    category: getCategoryFromAction(log.autopilot),
    source: getSourceFromAction(log.autopilot)
  }));

  // Apply transaction filter (post-query because it's computed)
  if (filters.transaction && filters.transaction !== 'ALL') {
    logs = logs.filter(log => getTransactionType(log) === filters.transaction);
  }

  // Apply category filter (post-query because it's computed)
  if (filters.category && filters.category !== 'ALL') {
    logs = logs.filter(log => getCategoryFromAction(log.autopilot) === filters.category);
  }

  // Apply source filter (post-query because it's computed)
  if (filters.source && filters.source !== 'ALL') {
    logs = logs.filter(log => getSourceFromAction(log.autopilot) === filters.source);
  }

  // Apply search filter (full-text search across all fields)
  if (filters.search && filters.search.trim() !== '') {
    const searchTerm = filters.search.toLowerCase();
    logs = logs.filter(log => searchInObject(log, searchTerm));
  }

  return logs;
}

/**
 * Delete all logs for a user
 */
async function deleteAllLogs(userId) {
  try {
    const { getDb } = require('./database');
    const db = getDb(userId);
    db.prepare('DELETE FROM autopilot_log').run();
    logger.debug(`Logbook: Deleted all logs for user ${userId}`);
    return true;
  } catch (err) {
    logger.error(`Logbook: Failed to delete logs for user ${userId}:`, err);
    return false;
  }
}

/**
 * Get log count
 */
async function getLogCount(userId) {
  try {
    const { getDb } = require('./database');
    const db = getDb(userId);
    const row = db.prepare('SELECT COUNT(*) as count FROM autopilot_log').get();
    return row.count;
  } catch (err) {
    logger.error(`Logbook: Failed to get log count for user ${userId}:`, err);
    return 0;
  }
}

/**
 * Get log file size in bytes (legacy compatibility - returns estimated size)
 */
async function getLogFileSize(userId) {
  const count = await getLogCount(userId);
  // Estimate ~500 bytes per log entry
  return count * 500;
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Shutdown the logbook system gracefully (no-op for SQLite)
 */
async function shutdown() {
  logger.debug('Logbook: Shutdown complete');
}

/**
 * Flush to disk (no-op for SQLite - writes are immediate)
 */
async function flushAllToDisk() {
  // No-op for SQLite
}

module.exports = {
  logAutopilotAction,
  getLogEntries,
  deleteAllLogs,
  getLogFileSize,
  getLogCount,
  formatFileSize,
  flushAllToDisk,
  shutdown,
  getCategoryFromAction,
  getSourceFromAction
};
