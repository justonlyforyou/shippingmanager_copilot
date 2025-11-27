/**
 * @fileoverview IPO Alert Auto-Refresh Logic
 *
 * Manages automatic polling of recent IPOs and broadcasting updates to clients.
 * Filters IPOs by account age (configurable via settings) and detects new/removed IPOs.
 *
 * @module server/websocket/ipo-refresh
 */

const logger = require('../utils/logger');
const { broadcast } = require('./broadcaster');
const { apiCall, getUserId } = require('../utils/api');
const state = require('../state');
const { hasSeenIpo, markIpoAsSeen } = require('../utils/ipo-tracker');

/**
 * Interval timer for automatic IPO refresh (5-minute polling)
 * @type {NodeJS.Timeout|null}
 */
let ipoRefreshInterval = null;

/**
 * Flag to prevent overlapping IPO refresh requests.
 * @type {boolean}
 */
let isIpoRefreshing = false;

/**
 * Cache of current fresh IPOs (keyed by user ID)
 * @type {Map<number, Object>}
 */
const freshIpoCache = new Map();

/**
 * Flag indicating if this is the first check (to establish baseline)
 * @type {boolean}
 */
let isFirstCheck = true;

/**
 * Performs a single IPO refresh cycle.
 * Fetches recent IPOs, filters by age, and broadcasts changes to all clients.
 *
 * What This Does:
 * - Fetches recent IPOs from game API
 * - Checks account age for top IPOs
 * - Filters by maxAgeDays setting
 * - Detects new fresh IPOs and ones that aged out
 * - Broadcasts changes to all clients
 *
 * Broadcast Data:
 * {
 *   freshIpos: Array,     // All currently fresh IPOs
 *   newIpos: Array,       // Newly detected fresh IPOs (for notifications)
 *   removedIds: Array,    // IDs of IPOs that aged out
 *   maxAgeDays: number    // Current max age setting
 * }
 *
 * @async
 * @function performIpoRefresh
 * @returns {Promise<void>}
 */
async function performIpoRefresh() {
  // Get user ID for settings lookup
  const userId = getUserId();
  if (!userId) {
    logger.debug('[IPO Refresh] No user ID available, skipping');
    return;
  }

  // Skip if IPO alerts are disabled
  let currentSettings;
  try {
    currentSettings = state.getSettings(userId);
  } catch {
    logger.debug('[IPO Refresh] Settings not loaded yet, skipping');
    return;
  }

  if (!currentSettings.enableIpoAlerts) {
    return;
  }

  // Skip if previous refresh is still running
  if (isIpoRefreshing) {
    logger.debug('[IPO Refresh] Skipping - previous request still running');
    return;
  }

  isIpoRefreshing = true;

  try {
    const maxAgeDays = currentSettings.ipoAlertMaxAgeDays || 7;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Fetch recent IPOs from game API
    const result = await apiCall('/stock/get-market', 'POST', {
      filter: 'recent-ipo',
      page: 1,
      limit: 40
    });

    if (!result.data || !result.data.market) {
      logger.debug('[IPO Refresh] No market data returned');
      return;
    }

    // Sort by user ID descending (highest = newest accounts)
    const allIpos = result.data.market.sort((a, b) => b.id - a.id);

    // Check age for top IPOs (limit API calls)
    const topIpos = allIpos.slice(0, 10);
    const newFreshIpos = [];

    for (const ipo of topIpos) {
      try {
        const companyData = await apiCall('/user/get-company', 'POST', {
          user_id: ipo.id
        });

        if (companyData.data && companyData.data.company && companyData.data.company.created_at) {
          const createdAt = new Date(companyData.data.company.created_at).getTime();
          const ageMs = now - createdAt;

          if (ageMs <= maxAgeMs) {
            newFreshIpos.push({
              ...ipo,
              created_at: companyData.data.company.created_at,
              age_days: Math.floor(ageMs / (24 * 60 * 60 * 1000))
            });
          }
        }
      } catch (err) {
        logger.debug(`[IPO Refresh] Could not fetch company data for ${ipo.id}: ${err.message}`);
      }
    }

    // First check - establish baseline without notifications
    if (isFirstCheck) {
      isFirstCheck = false;
      freshIpoCache.clear();
      for (const ipo of newFreshIpos) {
        freshIpoCache.set(ipo.id, ipo);
        // Mark all current IPOs as seen in persistent storage
        // This prevents alerts for already-existing IPOs after restart
        if (!hasSeenIpo(ipo.id)) {
          markIpoAsSeen(ipo.id);
        }
      }
      logger.info(`[IPO Refresh] Initialized with ${newFreshIpos.length} fresh IPOs (max age: ${maxAgeDays} days)`);

      // Broadcast initial state (no newIpos since it's baseline)
      broadcast('ipo_alert_update', {
        freshIpos: newFreshIpos,
        newIpos: [],
        removedIds: [],
        maxAgeDays
      });
      return;
    }

    // Detect changes
    const newIpos = [];
    const removedIds = [];

    // Find new fresh IPOs - check both in-memory cache AND persistent tracker
    // This prevents duplicate alerts after server restart
    for (const ipo of newFreshIpos) {
      if (!freshIpoCache.has(ipo.id) && !hasSeenIpo(ipo.id)) {
        newIpos.push(ipo);
        // Mark as seen in persistent storage BEFORE sending alert
        markIpoAsSeen(ipo.id);
        logger.info(`[IPO Refresh] New fresh IPO: ${ipo.company_name} (ID: ${ipo.id}, Age: ${ipo.age_days}d)`);
      }
    }

    // Find removed IPOs (aged out or no longer in list)
    const newFreshIds = new Set(newFreshIpos.map(i => i.id));
    for (const [id] of freshIpoCache) {
      if (!newFreshIds.has(id)) {
        removedIds.push(id);
        logger.debug(`[IPO Refresh] IPO aged out: ID ${id}`);
      }
    }

    // Update cache
    freshIpoCache.clear();
    for (const ipo of newFreshIpos) {
      freshIpoCache.set(ipo.id, ipo);
    }

    // Only broadcast if there are changes or we have fresh IPOs
    if (newIpos.length > 0 || removedIds.length > 0 || newFreshIpos.length > 0) {
      broadcast('ipo_alert_update', {
        freshIpos: newFreshIpos,
        newIpos,
        removedIds,
        maxAgeDays
      });

      if (newIpos.length > 0 || removedIds.length > 0) {
        logger.debug(`[IPO Refresh] Broadcast: ${newIpos.length} new, ${removedIds.length} removed, ${newFreshIpos.length} total fresh`);
      }
    }

    // Send to alliance chat if enabled and we have new IPOs
    if (currentSettings.ipoAlertSendToAllianceChat && newIpos.length > 0) {
      await sendToAllianceChat(newIpos, maxAgeDays);
    }

  } catch (error) {
    if (!error.message.includes('socket hang up') &&
        !error.message.includes('ECONNRESET') &&
        !error.message.includes('ECONNREFUSED')) {
      logger.error('[IPO Refresh] Error:', error.message);
    }
  } finally {
    isIpoRefreshing = false;
  }
}

/**
 * Sends IPO alert to alliance chat
 * @param {Array} newIpos - Array of new fresh IPOs
 * @param {number} maxAgeDays - Max age in days
 */
async function sendToAllianceChat(newIpos, maxAgeDays) {
  try {
    const { getAllianceId, getUserCompanyName } = require('../utils/api');
    const allianceId = getAllianceId();

    if (!allianceId) return;

    const companyName = getUserCompanyName();
    const maxAgeLabel = maxAgeDays === 1 ? '1 day' : maxAgeDays === 7 ? '1 week' : maxAgeDays === 30 ? '1 month' : '6 months';

    const ipoList = newIpos.map(ipo => `- ${ipo.company_name} ($${ipo.stock}, ${ipo.age_days}d old)`).join('\n');
    const message = `${companyName}'s IPO Alert Service - The following users completed their IPO and their accounts are younger than ${maxAgeLabel}:\n${ipoList}`;

    await apiCall('/alliance/post-chat', 'POST', {
      alliance_id: allianceId,
      text: message
    });

    logger.info(`[IPO Refresh] Sent IPO alert to alliance chat: ${newIpos.length} new IPOs`);
  } catch (error) {
    logger.warn('[IPO Refresh] Failed to send to alliance chat:', error.message);
  }
}

/**
 * Starts automatic IPO refresh polling at 5-minute interval.
 * Game updates stock market every 15 minutes, so 5 minutes gives reasonable freshness.
 *
 * @function startIpoAutoRefresh
 * @returns {void}
 */
function startIpoAutoRefresh() {
  // Perform initial check after 5 seconds (let other systems initialize)
  setTimeout(async () => {
    await performIpoRefresh();
  }, 5000);

  // Then check every 5 minutes
  ipoRefreshInterval = setInterval(async () => {
    await performIpoRefresh();
  }, 5 * 60 * 1000); // 5 minutes

  logger.info('[IPO Refresh] Auto-refresh started (5-minute interval)');
}

/**
 * Stops the automatic IPO polling and clears the interval timer.
 *
 * @function stopIpoAutoRefresh
 * @returns {void}
 */
function stopIpoAutoRefresh() {
  if (ipoRefreshInterval) {
    clearInterval(ipoRefreshInterval);
    ipoRefreshInterval = null;
    logger.debug('[IPO Refresh] Auto-refresh stopped');
  }
}

/**
 * Triggers an immediate IPO refresh.
 * Used when settings change or user requests refresh.
 *
 * @function triggerImmediateIpoRefresh
 * @returns {void}
 */
function triggerImmediateIpoRefresh() {
  logger.debug('[IPO Refresh] Immediate refresh triggered');
  setTimeout(async () => {
    await performIpoRefresh();
  }, 1000);
}

/**
 * Resets the IPO cache (used when max age setting changes)
 *
 * @function resetIpoCache
 * @returns {void}
 */
function resetIpoCache() {
  freshIpoCache.clear();
  isFirstCheck = true;
  logger.debug('[IPO Refresh] Cache reset');
}

/**
 * Gets the current fresh IPOs from cache
 *
 * @function getFreshIpos
 * @returns {Array} Array of fresh IPOs
 */
function getFreshIpos() {
  return Array.from(freshIpoCache.values());
}

module.exports = {
  performIpoRefresh,
  startIpoAutoRefresh,
  stopIpoAutoRefresh,
  triggerImmediateIpoRefresh,
  resetIpoCache,
  getFreshIpos
};
