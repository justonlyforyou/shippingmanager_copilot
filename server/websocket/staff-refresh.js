/**
 * @fileoverview Staff Morale Auto-Refresh Logic
 *
 * Manages automatic polling of staff morale data and broadcasting updates to clients.
 * Updates every 5 minutes.
 *
 * @module server/websocket/staff-refresh
 */

const logger = require('../utils/logger');
const { broadcast } = require('./broadcaster');
const { apiCall, getUserId } = require('../utils/api');
const state = require('../state');

/**
 * Interval timer for automatic staff refresh
 * @type {NodeJS.Timeout|null}
 */
let staffRefreshInterval = null;

/**
 * Flag to prevent overlapping staff refresh requests.
 * @type {boolean}
 */
let isStaffRefreshing = false;

/**
 * Performs a single staff refresh cycle.
 * Fetches staff data from game API and broadcasts to all clients.
 *
 * What This Does:
 * - Fetches staff morale data from /staff/get-user-staff
 * - Stores in state for autopilot access
 * - Broadcasts to frontend for UI updates
 *
 * Broadcast Data:
 * {
 *   crew: { group, label, percentage },
 *   management: { group, label, percentage },
 *   staff: [array of staff with morale, salary, training]
 * }
 *
 * @async
 * @function performStaffRefresh
 * @returns {Promise<void>}
 */
async function performStaffRefresh() {
  if (isStaffRefreshing) {
    logger.debug('[Staff Refresh] Already refreshing, skipping');
    return;
  }

  const userId = getUserId();
  if (!userId) {
    logger.debug('[Staff Refresh] No user ID available, skipping');
    return;
  }

  isStaffRefreshing = true;

  try {
    logger.debug('[Staff Refresh] Fetching staff data...');

    const staffResponse = await apiCall('/staff/get-user-staff', 'POST', {});

    if (!staffResponse || !staffResponse.data) {
      logger.warn('[Staff Refresh] No staff data in response');
      return;
    }

    const staffData = staffResponse.data;

    // Store in state for autopilot access
    state.updateStaffData(userId, staffData);

    // Broadcast to all clients
    broadcast('staff_update', {
      crew: staffData.info?.crew,
      management: staffData.info?.management,
      staff: staffData.staff
    });

    logger.debug('[Staff Refresh] Staff data updated and broadcast');

  } catch (error) {
    logger.error(`[Staff Refresh] Error: ${error.message}`);
  } finally {
    isStaffRefreshing = false;
  }
}

/**
 * Starts automatic staff refresh polling.
 * Runs every 5 minutes.
 *
 * @function startStaffAutoRefresh
 * @returns {void}
 */
function startStaffAutoRefresh() {
  if (staffRefreshInterval) {
    logger.debug('[Staff Refresh] Auto-refresh already running');
    return;
  }

  logger.info('[Staff Refresh] Starting auto-refresh (5-minute interval)');

  // Perform initial check after 5 seconds (let other systems initialize)
  setTimeout(async () => {
    await performStaffRefresh();
  }, 5000);

  // Then refresh every 5 minutes
  staffRefreshInterval = setInterval(() => {
    performStaffRefresh();
  }, 5 * 60 * 1000); // 5 minutes
}

/**
 * Stops automatic staff refresh polling.
 *
 * @function stopStaffAutoRefresh
 * @returns {void}
 */
function stopStaffAutoRefresh() {
  if (staffRefreshInterval) {
    clearInterval(staffRefreshInterval);
    staffRefreshInterval = null;
    logger.info('[Staff Refresh] Auto-refresh stopped');
  }
}

/**
 * Triggers an immediate staff refresh (bypasses the interval).
 *
 * @async
 * @function triggerImmediateStaffRefresh
 * @returns {Promise<void>}
 */
async function triggerImmediateStaffRefresh() {
  logger.debug('[Staff Refresh] Immediate refresh triggered');
  await performStaffRefresh();
}

module.exports = {
  performStaffRefresh,
  startStaffAutoRefresh,
  stopStaffAutoRefresh,
  triggerImmediateStaffRefresh
};
