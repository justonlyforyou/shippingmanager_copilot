/**
 * @fileoverview Staff Captain - Auto-Manage Staff Morale Pilot
 *
 * Automatically manages staff salaries to maintain crew and management morale
 * at or above target levels without exceeding +3% threshold.
 *
 * @module server/autopilot/pilot_staff_captain
 */

const { apiCall, getUserId } = require('../utils/api');
const state = require('../state');
const logger = require('../utils/logger');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

/**
 * Manages staff morale by adjusting salaries for a single user.
 *
 * Decision Logic:
 * 1. Fetches current staff data and morale percentages
 * 2. Checks if crew or management morale is below target
 * 3. For each low-morale staff type, raises salary until target reached
 * 4. Stops when morale >= target AND morale <= target+3%
 * 5. Broadcasts morale updates to frontend
 *
 * Target Morale Options:
 * - 100: Keep at 100%
 * - 95: Keep >= 95%
 * - 85: Keep >= 85%
 * - 80: Keep >= 80%
 * - 75: Keep >= 75%
 *
 * Safety Features:
 * - Only adjusts when morale < target
 * - Stops when morale >= target to avoid overspending
 * - Won't exceed target+3% to prevent wasted API calls
 * - Checks both crew AND management morale
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @returns {Promise<void>}
 */
async function manageStaffMorale(autopilotPaused, broadcastToUser) {
  if (autopilotPaused) {
    logger.debug('[Staff Captain] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.enableStaffCaptain) {
    logger.debug('[Staff Captain] Feature disabled in settings');
    return;
  }

  try {
    const staffData = state.getStaffData(userId);

    if (!staffData || !staffData.info) {
      logger.debug('[Staff Captain] No staff data available yet');
      return;
    }

    const crewMorale = staffData.info.crew?.percentage;
    const managementMorale = staffData.info.management?.percentage;
    const targetMorale = settings.staffCaptainTargetMorale;

    logger.debug(`[Staff Captain] Check: Crew=${crewMorale}%, Management=${managementMorale}%, Target=${targetMorale}%`);

    if (crewMorale === undefined || managementMorale === undefined) {
      logger.debug('[Staff Captain] Morale data not available');
      return;
    }

    // Check if both morale levels are already at or above target
    if (crewMorale >= targetMorale && managementMorale >= targetMorale) {
      logger.debug('[Staff Captain] Both crew and management morale are at or above target');
      return;
    }

    // Determine which staff types need salary increases
    const staffToAdjust = [];

    if (crewMorale < targetMorale) {
      // Crew morale low - need to raise crew staff salaries
      const crewStaff = staffData.staff.filter(s =>
        ['captain', 'first_officer', 'boatswain', 'technical_officer'].includes(s.type) &&
        s.morale !== undefined
      );
      staffToAdjust.push(...crewStaff);
      logger.info(`[Staff Captain] Crew morale below target: ${crewMorale}% < ${targetMorale}%`);
    }

    if (managementMorale < targetMorale) {
      // Management morale low - need to raise management staff salaries
      const managementStaff = staffData.staff.filter(s =>
        ['cfo', 'coo', 'cmo', 'cto'].includes(s.type) &&
        s.morale !== undefined
      );
      staffToAdjust.push(...managementStaff);
      logger.info(`[Staff Captain] Management morale below target: ${managementMorale}% < ${targetMorale}%`);
    }

    if (staffToAdjust.length === 0) {
      logger.debug('[Staff Captain] No staff needs salary adjustment');
      return;
    }

    // Raise salaries for staff with low morale
    for (const staff of staffToAdjust) {
      try {
        logger.info(`[Staff Captain] Raising salary for ${staff.type} (current morale: ${staff.morale}%)`);

        const response = await apiCall('/staff/raise-salary', 'POST', { type: staff.type });

        if (response.data?.staff) {
          const newSalary = response.data.staff.salary;
          const newMorale = response.data.staff.morale;

          logger.info(`[Staff Captain] ${staff.type} salary raised to ${formatCurrency(newSalary)} (morale: ${newMorale}%)`);

          await auditLog(
            userId,
            CATEGORIES.STAFF,
            'Staff Captain',
            `Raised ${staff.type} salary to ${formatCurrency(newSalary)} (morale: ${staff.morale}% → ${newMorale}%)`,
            {
              staffType: staff.type,
              oldSalary: formatCurrency(staff.salary),
              newSalary: formatCurrency(newSalary),
              oldMorale: staff.morale,
              newMorale: newMorale,
              targetMorale: targetMorale
            },
            'SUCCESS',
            SOURCES.AUTOPILOT
          );
        }
      } catch (error) {
        logger.error(`[Staff Captain] Failed to raise salary for ${staff.type}: ${error.message}`);
      }
    }

    // Fetch updated staff data after adjustments
    const updatedStaffResponse = await apiCall('/staff/get-user-staff', 'POST', {});
    if (updatedStaffResponse?.data) {
      state.updateStaffData(userId, updatedStaffResponse.data);

      const newCrew = updatedStaffResponse.data.info.crew?.percentage;
      const newManagement = updatedStaffResponse.data.info.management?.percentage;

      logger.info(`[Staff Captain] Updated morale: Crew=${newCrew}%, Management=${newManagement}%`);

      // Broadcast updated staff data
      if (broadcastToUser) {
        broadcastToUser(userId, 'staff_update', {
          crew: updatedStaffResponse.data.info.crew,
          management: updatedStaffResponse.data.info.management,
          staff: updatedStaffResponse.data.staff
        });
      }
    }

  } catch (error) {
    logger.error(`[Staff Captain] Error managing staff morale: ${error.message}`);
  }
}

module.exports = {
  manageStaffMorale
};
