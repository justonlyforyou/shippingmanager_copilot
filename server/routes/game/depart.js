/**
 * @fileoverview Vessel Departure Routes
 *
 * This module provides the universal endpoint for vessel departures.
 * It supports departing all vessels or specific vessels by ID.
 *
 * Key Features:
 * - Universal depart endpoint for all vessels or specific ones
 * - Integration with autopilot system for departure logic
 * - Audit logging of departure results
 * - Harbor fee tracking for vessel history
 * - WebSocket broadcast notifications
 *
 * @requires express - Router and middleware
 * @requires ../../utils/api - API helper functions
 * @requires ../../autopilot - Autopilot departure logic
 * @requires ../../utils/audit-logger - Transaction logging
 * @requires ../../utils/harbor-fee-store - Harbor fee persistence
 * @module server/routes/game/depart
 */

const express = require('express');
const { getUserId } = require('../../utils/api');
const autopilot = require('../../autopilot');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../../utils/audit-logger');
const logger = require('../../utils/logger');
const { broadcastToUser } = require('../../websocket');
const { syncSpecificVessels } = require('../../analytics/vessel-history-store');

const router = express.Router();

/**
 * Universal depart endpoint
 * Depart all vessels or specific vessels from harbor
 *
 * @route POST /api/route/depart
 * @body {array} [vessel_ids] - Optional array of specific vessel IDs to depart. If not provided, departs all vessels.
 * @body {number} [user_vessel_id] - Optional single vessel ID (alternative to vessel_ids for automation)
 *
 * @returns {object} Departure result with:
 *   - success {boolean} - Whether departure was successful
 *   - departedCount {number} - Number of vessels that departed
 *   - totalRevenue {number} - Total revenue from departed vessels
 *   - totalFuelUsed {number} - Total fuel consumed
 *   - totalCO2Used {number} - Total CO2 consumed
 *   - totalHarborFees {number} - Total harbor fees paid
 *   - departedVessels {array} - Details of each departed vessel
 *   - highFeeCount {number} - Count of vessels with excessive harbor fees
 *   - highFeeVessels {array} - Vessels with excessive harbor fees
 *   - message {string} - Status message if no vessels departed
 *
 * @error 400 - vessel_ids must be an array if provided
 * @error 500 - Failed to depart vessels
 *
 * Side effects:
 * - Broadcasts departure notification via WebSocket
 * - Logs departure results to audit log
 * - Saves harbor fees for vessel history
 * - Triggers harbor map refresh broadcast
 */
router.post('/depart', async (req, res) => {
  try {
    const userId = getUserId();

    // Extract vessel IDs from request body (optional)
    // Support both formats:
    // - vessel_ids: [1,2,3] - array of vessel IDs (used by Depart Manager)
    // - user_vessel_id: 123 - single vessel ID (used by automation/autopilot)
    let vesselIds = req.body?.vessel_ids || null;

    // Handle single vessel ID from automation.js departVessel() calls
    if (!vesselIds && req.body?.user_vessel_id) {
      vesselIds = [req.body.user_vessel_id];
      logger.debug(`[Depart API] Single vessel departure: ${req.body.user_vessel_id}`);
    }

    if (vesselIds && !Array.isArray(vesselIds)) {
      return res.status(400).json({ error: 'vessel_ids must be an array' });
    }

    if (vesselIds) {
      logger.debug(`[Depart API] Departing ${vesselIds.length} specific vessels`);
    } else {
      logger.debug(`[Depart API] Departing ALL vessels in harbor`);
    }

    // Call universal depart function
    // vesselIds = null means "depart all"
    // vesselIds = [1,2,3] means "depart these specific vessels"
    // NOTE: Contribution tracking happens inside autopilot.departVessels()
    const { broadcastHarborMapRefresh } = require('../../websocket');
    // (using broadcastToUser imported at top of file)
    const result = await autopilot.departVessels(userId, vesselIds, broadcastToUser, autopilot.autoRebuyAll, autopilot.tryUpdateAllData);

    // Log all departure outcomes for debugging
    const requestedCount = vesselIds ? vesselIds.length : 'all';
    const departedCount = result?.departedCount ?? 0;
    const failedCount = result?.failedCount ?? 0;
    logger.info(`[Depart API] Result: requested=${requestedCount}, departed=${departedCount}, failed=${failedCount}, success=${result?.success}, reason=${result?.reason || 'none'}`);

    // Log failed vessels with reasons for debugging
    if (result?.failedVessels?.length > 0) {
      result.failedVessels.forEach(v => {
        logger.warn(`[Depart API] Failed: ${v.name} -> ${v.destination || 'N/A'} | Reason: ${v.reason}`);
      });
    }

    // LOGBOOK: Manual vessel departure (same format as Auto-Depart)
    // NOTE: Contribution data comes from individual vessels in departedVessels array
    if (result && result.success && result.departedCount > 0) {
      // Build summary - only include contribution if tracked
      const summary = result.contributionGained
        ? `${result.departedCount} vessels | +${formatCurrency(result.totalRevenue)} | +${result.contributionGained} contribution`
        : `${result.departedCount} vessels | +${formatCurrency(result.totalRevenue)}`;

      // Build details - always include contribution (even if 0)
      const details = {
        vesselCount: result.departedCount,
        totalRevenue: result.totalRevenue,
        totalFuelUsed: result.totalFuelUsed,
        totalCO2Used: result.totalCO2Used,
        totalHarborFees: result.totalHarborFees,
        contributionGainedTotal: result.contributionGained ?? 0,
        departedVessels: result.departedVessels.map(v => ({
          ...v,
          harborFee: v.harborFee ? -Math.abs(v.harborFee) : 0
        }))
      };

      // Log success
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Depart',
        summary,
        details,
        'SUCCESS',
        SOURCES.MANUAL
      );

      // Log warnings if any vessels had excessive harbor fees
      if (result.highFeeCount > 0) {
        const totalHarborFees = result.highFeeVessels.reduce((sum, v) => sum + v.harborFee, 0);
        await auditLog(
          userId,
          CATEGORIES.VESSEL,
          'Manual Depart',
          `${result.highFeeCount} vessel${result.highFeeCount > 1 ? 's' : ''} with excessive harbor fees | ${formatCurrency(totalHarborFees)} fees`,
          {
            vesselCount: result.highFeeCount,
            totalHarborFees: totalHarborFees,
            highFeeVessels: result.highFeeVessels
          },
          'WARNING',
          SOURCES.MANUAL
        );
      }

      // NOTE: Harbor fees and contribution gains are already saved in autopilot.departVessels()
    } else if (result && !result.success) {
      // Early-exit failures (depart_in_progress, insufficient_fuel) are NOT logged to audit
      // These happen BEFORE any vessel processing and create confusing entries
      // The user already sees these via WebSocket notifications in real-time
      const reasonMap = {
        'depart_in_progress': 'Another departure operation was already running',
        'insufficient_fuel': 'Insufficient fuel to depart',
        'error': result.error || 'Unknown error'
      };
      const readableReason = reasonMap[result.reason] || result.reason || 'Unknown reason';
      logger.warn(`[Depart API] Departure blocked: ${readableReason}`);
      // No audit log - these pre-processing blocks are noise in the logbook
    } else if (result && result.success && result.departedCount === 0 && result.failedCount > 0) {
      // All requested vessels failed to depart - this is useful to log
      logger.warn(`[Depart API] All vessels failed: ${result.failedCount} failures`);

      if (vesselIds && vesselIds.length > 0 && result.failedVessels?.length > 0) {
        // Build a readable summary with vessel names and reasons
        const vesselSummaries = result.failedVessels.map(v => `${v.name}: ${v.reason}`);
        const summary = vesselSummaries.join(' | ');

        await auditLog(
          userId,
          CATEGORIES.VESSEL,
          'Manual Depart',
          summary,
          {
            failedVessels: result.failedVessels
          },
          'WARNING',
          SOURCES.MANUAL
        );
      }
    }

    // Trigger Harbor Map refresh (vessels departed)
    if (broadcastHarborMapRefresh) {
      broadcastHarborMapRefresh(userId, 'vessels_departed', {
        count: vesselIds ? vesselIds.length : 'all'
      });
    }

    // Event-based vessel history sync: sync departed vessels immediately
    if (result && result.success && result.departedCount > 0 && result.departedVessels) {
      const departedVesselIds = result.departedVessels.map(v => v.vesselId).filter(Boolean);
      if (departedVesselIds.length > 0) {
        // Run async, don't block response
        syncSpecificVessels(userId, departedVesselIds).then(syncResult => {
          if (syncResult.newEntries > 0) {
            logger.info(`[Depart API] Synced history for ${departedVesselIds.length} vessels: +${syncResult.newEntries} entries`);
          }
        }).catch(err => {
          logger.error('[Depart API] Failed to sync vessel history:', err.message);
        });
      }
    }

    res.json(result || { success: true, message: 'Depart triggered' });
  } catch (error) {
    logger.error('[Depart API] Error:', error);
    res.status(500).json({ error: 'Failed to depart vessels' });
  }
});

module.exports = router;