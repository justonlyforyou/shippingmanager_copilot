/**
 * @fileoverview Comprehensive Audit Logging System
 * Logs all manual and autopilot actions to the logbook
 * @module server/utils/audit-logger
 */

const { logAutopilotAction } = require('../logbook');
const logger = require('./logger');

/**
 * Audit log categories
 */
const CATEGORIES = {
  BUNKER: 'Bunker',
  VESSEL: 'Vessel',
  AUTOPILOT: 'Autopilot',
  SETTINGS: 'Settings',
  ANCHOR: 'Anchor',
  HIJACKING: 'Hijacking',
  COOP: 'COOP',
  MARKETING: 'Marketing',
  STAFF: 'Staff'
};

/**
 * Action sources
 */
const SOURCES = {
  MANUAL: 'Manual',
  AUTOPILOT: 'Autopilot'
};

/**
 * Format currency
 * @param {number} amount - Amount in dollars
 * @returns {string} Formatted currency
 */
function formatCurrency(amount) {
  return `$${amount.toLocaleString()}`;
}

/**
 * Format number with commas
 * @param {number} num - Number to format
 * @returns {string} Formatted number
 */
function formatNumber(num) {
  return num.toLocaleString();
}

/**
 * Audit log entry
 * @param {string} userId - User ID
 * @param {string} category - CATEGORIES value
 * @param {string} action - Action description (autopilot name)
 * @param {string} summary - Short summary
 * @param {Object} details - Detailed information
 * @param {string} status - SUCCESS, WARNING, or ERROR
 * @param {string} source - SOURCES value (Manual or Autopilot)
 */
async function auditLog(userId, category, action, summary, details = {}, status = 'SUCCESS', source = SOURCES.MANUAL) {
  // Use existing logbook system
  // logAutopilotAction expects: (userId, autopilot, status, summary, details)
  await logAutopilotAction(
    userId,
    action,    // autopilot name (now also used for manual actions)
    status,    // SUCCESS, WARNING, or ERROR
    summary,   // Short summary
    details    // Detailed information
  );

  logger.info(`[AUDIT:${category}:${source}] ${action}: ${summary}`);
}

module.exports = {
  auditLog,
  CATEGORIES,
  SOURCES,
  formatCurrency,
  formatNumber
};
