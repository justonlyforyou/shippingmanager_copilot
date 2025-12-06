/**
 * @fileoverview Hijacking Auto-Refresh Logic
 *
 * Manages automatic polling of hijacking cases and broadcasting badge/header counts to clients.
 * Tracks open cases and hijacked vessel counts.
 *
 * @module server/websocket/hijacking-refresh
 */

const logger = require('../utils/logger');
const { broadcast } = require('./broadcaster');
const { getCachedMessengerChats } = require('./messenger-cache');
const { getCachedHijackingCase } = require('./hijacking-cache');

/**
 * Interval timer for automatic hijacking refresh (30-second polling)
 * @type {NodeJS.Timeout|null}
 */
let hijackingRefreshInterval = null;

/**
 * Flag to prevent overlapping hijacking refresh requests.
 * @type {boolean}
 */
let isHijackingRefreshing = false;

/**
 * Performs a single hijacking refresh cycle.
 * Fetches hijacking cases and broadcasts badge/header counts to all clients.
 * Uses module-level isHijackingRefreshing flag to prevent overlapping requests.
 *
 * What This Does:
 * - Fetches all hijacking cases via /api/hijacking/get-cases
 * - Counts OPEN cases (paid_amount === null && status !== 'solved')
 * - Counts total cases (open + closed)
 * - Counts hijacked vessels (vessels with status 'in_progress')
 * - Broadcasts to all clients for badge and header updates
 *
 * Why This Exists:
 * - Keeps hijacking inbox badge count up-to-date
 * - Updates header pirate emoji count (hijacked vessels)
 * - Separates hijacking from messenger badge logic
 * - Enables real-time tracking of hijacking status changes
 *
 * Broadcast Data:
 * {
 *   openCases: number,      // Open hijacking cases (for badge)
 *   totalCases: number,     // Total cases (open + closed)
 *   hijackedCount: number   // Currently hijacked vessels (for header emoji)
 * }
 *
 * @async
 * @function performHijackingRefresh
 * @returns {Promise<void>}
 */
async function performHijackingRefresh() {
  // Skip if previous refresh is still running
  if (isHijackingRefreshing) {
    logger.debug('[Hijacking Refresh] Skipping - previous request still running');
    return;
  }

  isHijackingRefreshing = true;

  try {
    // Fetch messenger chats (using shared cache to reduce API calls)
    const allChats = await getCachedMessengerChats();

    // Filter for hijacking cases
    const hijackingChats = allChats.filter(chat =>
      chat.system_chat && chat.body === 'vessel_got_hijacked'
    );

    // Fetch details for each case (using shared cache)
    const casesWithDetails = await Promise.all(
      hijackingChats.map(async (chat) => {
        const caseId = chat.values?.case_id;
        if (!caseId) return null;

        // Use shared cache function to get case details
        return await getCachedHijackingCase(caseId);
      })
    );

    const cases = casesWithDetails.filter(c => c !== null);

    // Count cached vs fetched for logging
    const cachedCount = cases.filter(c => c.cached).length;
    const fetchedCount = cases.length - cachedCount;

    // Count open cases (for badge)
    const openCases = cases.filter(c => c.isOpen).length;

    // Count hijacked vessels (status = 'in_progress')
    const hijackedCount = cases.filter(c => {
      const status = c.details?.status;
      return status === 'in_progress' || (c.isOpen && status !== 'solved');
    }).length;

    // Broadcast to all clients
    const hijackingData = {
      openCases: openCases,
      totalCases: cases.length,
      hijackedCount: hijackedCount
    };
    logger.debug(`[Hijacking Refresh] Broadcasting update: ${openCases} open, ${hijackedCount} hijacked (${fetchedCount} API calls, ${cachedCount} cached)`);
    broadcast('hijacking_update', hijackingData);

    logger.debug(`[Hijacking] ${openCases} open cases, ${hijackedCount} hijacked vessels`);
  } catch (error) {
    // Only log non-timeout and non-connection errors
    if (!error.message.includes('socket hang up') &&
        !error.message.includes('ECONNRESET') &&
        !error.message.includes('ECONNREFUSED')) {
      logger.error('[Hijacking Refresh] Error:', error.message);
    }
  } finally {
    isHijackingRefreshing = false; // Always release the lock
  }
}

/**
 * Starts automatic hijacking refresh polling at 5-minute interval.
 * Calls performHijackingRefresh() on each cycle.
 *
 * Why 5 Minutes:
 * - Hijacking status changes very infrequently (only during active negotiations)
 * - Closed cases never change - no need to refetch
 * - Matches the cache TTL for open cases (5 minutes)
 * - Drastically reduces API calls when all cases are closed
 * - Active negotiations use direct API calls anyway (pilot_captain_blackbeard)
 *
 * @function startHijackingAutoRefresh
 * @returns {void}
 */
function startHijackingAutoRefresh() {
  hijackingRefreshInterval = setInterval(async () => {
    await performHijackingRefresh();
  }, 5 * 60 * 1000); // 5 minutes
}

/**
 * Stops the automatic hijacking polling and clears the interval timer.
 *
 * @function stopHijackingAutoRefresh
 * @returns {void}
 */
function stopHijackingAutoRefresh() {
  if (hijackingRefreshInterval) {
    clearInterval(hijackingRefreshInterval);
    hijackingRefreshInterval = null;
  }
}

/**
 * Triggers an immediate hijacking refresh after a short delay.
 * Used after auto-negotiate completes or when case status changes.
 *
 * @function triggerImmediateHijackingRefresh
 * @returns {void}
 */
function triggerImmediateHijackingRefresh() {
  logger.debug('[Hijacking Refresh] Immediate refresh triggered - will execute in 2 seconds');
  setTimeout(async () => {
    await performHijackingRefresh();
  }, 2000); // 2-second delay to allow API to update
}

module.exports = {
  performHijackingRefresh,
  startHijackingAutoRefresh,
  stopHijackingAutoRefresh,
  triggerImmediateHijackingRefresh
};
