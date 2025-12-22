/**
 * @fileoverview Hijacking Case Caching - SQLite-Based Persistent Cache
 *
 * Uses SQLite to cache hijacking case details - NO API calls for resolved cases!
 * Strategy:
 * - First check: SQLite database for user
 * - If resolved -> Use local data, ZERO API calls
 * - If no record or not resolved -> API call once, then save to SQLite
 *
 * This eliminates ALL API calls for resolved cases, even after server restart!
 *
 * @module server/websocket/hijacking-cache
 */

const { apiCall, getUserId } = require('../utils/api');
const logger = require('../utils/logger');
const { getDb } = require('../database');

/**
 * In-memory cache for current session (fallback + performance)
 * @type {Map<number, {details: Object, timestamp: number, isOpen: boolean}>}
 */
const hijackingCaseDetailsCache = new Map();

/**
 * Cache TTL for open cases in memory (5 minutes)
 * @constant {number}
 */
const HIJACKING_CASE_CACHE_TTL = 5 * 60 * 1000;

/**
 * Reads hijacking case from SQLite database.
 * @param {number} caseId - Case ID
 * @returns {Object|null} Local case data or null if not found
 */
function readLocalCaseFromDb(caseId) {
  try {
    const userId = getUserId();
    if (!userId) {
      logger.debug(`[Hijacking Cache] Cannot read case ${caseId} - userId not set`);
      return null;
    }

    const db = getDb(userId);

    // Get main case data
    const caseRow = db.prepare('SELECT * FROM hijack_cases WHERE case_id = ?').get(caseId);
    if (!caseRow) {
      logger.debug(`[Hijacking Cache] No SQLite record for case ${caseId}`);
      return null;
    }

    // Get negotiation history
    const historyRows = db.prepare('SELECT type, amount, timestamp FROM hijack_history WHERE case_id = ? ORDER BY timestamp').all(caseId);

    // Reconstruct the case data structure
    const data = {
      case_details: caseRow.case_details_json ? JSON.parse(caseRow.case_details_json) : {
        id: caseRow.case_id,
        requested_amount: caseRow.requested_amount,
        paid_amount: caseRow.paid_amount,
        user_proposal: caseRow.user_proposal,
        has_negotiation: caseRow.has_negotiation,
        round_end_time: caseRow.round_end_time,
        status: caseRow.status,
        danger_zone_slug: caseRow.danger_zone_slug,
        registered_at: caseRow.registered_at
      },
      resolved: caseRow.resolved === 1,
      autopilot_resolved: caseRow.autopilot_resolved === 1,
      resolved_at: caseRow.resolved_at,
      final_status: caseRow.status,
      cached_at: caseRow.cached_at,
      vessel_name: caseRow.vessel_name,
      user_vessel_id: caseRow.user_vessel_id,
      history: historyRows,
      payment_verification: caseRow.payment_verified ? {
        verified: caseRow.payment_verified === 1,
        expected_amount: caseRow.requested_amount,
        actual_paid: caseRow.paid_amount,
        cash_before: caseRow.cash_before,
        cash_after: caseRow.cash_after
      } : null
    };

    // Log when we find a resolved case
    if (data.resolved || data.autopilot_resolved) {
      logger.debug(`[Hijacking Cache] SQLite HIT case ${caseId} - resolved=${data.resolved}, autopilot=${data.autopilot_resolved}`);
    }

    return data;
  } catch (error) {
    logger.debug(`[Hijacking Cache] Could not read case ${caseId} from SQLite: ${error.message}`);
    return null;
  }
}

/**
 * Saves case details to SQLite for persistent caching.
 * @param {number} caseId - Case ID
 * @param {Object} details - Case details from API
 * @param {boolean} isOpen - Whether case is still open
 */
function saveLocalCaseToDb(caseId, details, isOpen) {
  try {
    const userId = getUserId();
    if (!userId) return;

    const db = getDb(userId);

    // Load existing data to preserve history and payment verification
    const existing = db.prepare('SELECT * FROM hijack_cases WHERE case_id = ?').get(caseId);

    // Insert or update main case
    db.prepare(`
      INSERT INTO hijack_cases (case_id, user_vessel_id, vessel_name, danger_zone_slug, requested_amount, paid_amount, user_proposal, has_negotiation, round_end_time, status, registered_at, resolved, autopilot_resolved, resolved_at, cash_before, cash_after, payment_verified, case_details_json, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        user_vessel_id = COALESCE(excluded.user_vessel_id, hijack_cases.user_vessel_id),
        vessel_name = COALESCE(excluded.vessel_name, hijack_cases.vessel_name),
        danger_zone_slug = COALESCE(excluded.danger_zone_slug, hijack_cases.danger_zone_slug),
        requested_amount = COALESCE(excluded.requested_amount, hijack_cases.requested_amount),
        paid_amount = COALESCE(excluded.paid_amount, hijack_cases.paid_amount),
        user_proposal = COALESCE(excluded.user_proposal, hijack_cases.user_proposal),
        has_negotiation = COALESCE(excluded.has_negotiation, hijack_cases.has_negotiation),
        round_end_time = COALESCE(excluded.round_end_time, hijack_cases.round_end_time),
        status = excluded.status,
        registered_at = COALESCE(excluded.registered_at, hijack_cases.registered_at),
        resolved = MAX(excluded.resolved, hijack_cases.resolved),
        autopilot_resolved = MAX(excluded.autopilot_resolved, hijack_cases.autopilot_resolved),
        resolved_at = COALESCE(excluded.resolved_at, hijack_cases.resolved_at),
        case_details_json = excluded.case_details_json,
        cached_at = excluded.cached_at
    `).run(
      caseId,
      existing?.user_vessel_id,
      existing?.vessel_name,
      details.danger_zone_slug,
      details.requested_amount,
      details.paid_amount,
      details.user_proposal,
      details.has_negotiation,
      details.round_end_time,
      details.status,
      details.registered_at,
      isOpen ? 0 : 1,
      existing?.autopilot_resolved ? 1 : 0,
      existing?.resolved_at,
      existing?.cash_before,
      existing?.cash_after,
      existing?.payment_verified,
      JSON.stringify(details),
      Date.now()
    );

    // Save offers from API response to history table
    if (details.offers && Array.isArray(details.offers)) {
      for (const offer of details.offers) {
        saveNegotiationEvent(caseId, offer.type, offer.amount, offer.timestamp);
      }
    } else if (details.requested_amount && details.registered_at) {
      // Fallback: save initial pirate request if no offers array
      saveNegotiationEvent(caseId, 'pirate', details.requested_amount, details.registered_at);
    }

    logger.debug(`[Hijacking Cache] Saved case ${caseId} to SQLite (resolved: ${!isOpen})`);
  } catch (error) {
    logger.error(`[Hijacking Cache] Failed to save case ${caseId} to SQLite: ${error.message}`);
  }
}

/**
 * Save negotiation history event to SQLite
 * @param {number} caseId - Case ID
 * @param {string} type - Event type ('pirate' or 'user')
 * @param {number} amount - Offer amount
 * @param {number} timestamp - Event timestamp
 */
function saveNegotiationEvent(caseId, type, amount, timestamp) {
  try {
    const userId = getUserId();
    if (!userId) return;

    const db = getDb(userId);
    db.prepare('INSERT OR IGNORE INTO hijack_history (case_id, type, amount, timestamp) VALUES (?, ?, ?, ?)').run(caseId, type, amount, timestamp);
  } catch (error) {
    logger.error(`[Hijacking Cache] Failed to save negotiation event: ${error.message}`);
  }
}

/**
 * Mark case as resolved with payment verification
 * @param {number} caseId - Case ID
 * @param {Object} paymentData - Payment verification data
 */
function markCaseResolved(caseId, paymentData) {
  try {
    const userId = getUserId();
    if (!userId) return;

    const db = getDb(userId);
    db.prepare(`
      UPDATE hijack_cases SET
        resolved = 1,
        autopilot_resolved = ?,
        resolved_at = ?,
        paid_amount = ?,
        cash_before = ?,
        cash_after = ?,
        payment_verified = ?,
        status = ?
      WHERE case_id = ?
    `).run(
      paymentData.autopilot_resolved ? 1 : 0,
      paymentData.resolved_at,
      paymentData.actual_paid,
      paymentData.cash_before,
      paymentData.cash_after,
      paymentData.verified ? 1 : 0,
      'paid',
      caseId
    );

    logger.debug(`[Hijacking Cache] Marked case ${caseId} as resolved in SQLite`);
  } catch (error) {
    logger.error(`[Hijacking Cache] Failed to mark case ${caseId} as resolved: ${error.message}`);
  }
}

/**
 * Update case with vessel info
 * @param {number} caseId - Case ID
 * @param {number} vesselId - User vessel ID
 * @param {string} vesselName - Vessel name
 */
function updateCaseVesselInfo(caseId, vesselId, vesselName) {
  try {
    const userId = getUserId();
    if (!userId) return;

    const db = getDb(userId);
    db.prepare('UPDATE hijack_cases SET user_vessel_id = ?, vessel_name = ? WHERE case_id = ?').run(vesselId, vesselName, caseId);
  } catch (error) {
    logger.error(`[Hijacking Cache] Failed to update vessel info for case ${caseId}: ${error.message}`);
  }
}

/**
 * Invalidates the cache for a specific hijacking case.
 * @param {number} caseId - Hijacking case ID to invalidate
 */
function invalidateHijackingCase(caseId) {
  if (hijackingCaseDetailsCache.has(caseId)) {
    hijackingCaseDetailsCache.delete(caseId);
    logger.debug(`[Hijacking Cache] Case ${caseId} invalidated from memory`);
  }
}

/**
 * Gets hijacking case details - checks SQLite first, then memory, then API.
 *
 * Priority:
 * 1. SQLite with resolved=true -> Use it, ZERO API calls
 * 2. Memory cache (for open cases during session)
 * 3. API call (only for new/unknown cases) -> Then save to SQLite
 *
 * @param {number} caseId - Hijacking case ID
 * @returns {Promise<{isOpen: boolean, details: Object, cached: boolean}|null>}
 */
async function getCachedHijackingCase(caseId) {
  try {
    const now = Date.now();

    // FIRST: Check SQLite (survives server restart!)
    const localData = readLocalCaseFromDb(caseId);
    logger.debug(`[Hijacking Cache] Case ${caseId} - localData found: ${!!localData}, resolved: ${localData?.resolved}, autopilot_resolved: ${localData?.autopilot_resolved}, resolved_at: ${localData?.resolved_at}`);

    if (localData) {
      // Only use SQLite if case is RESOLVED - open cases need fresh API data
      // Also check status field for 'successful', 'solved', 'paid' as resolved indicators
      const statusResolved = ['successful', 'solved', 'paid'].includes(localData.case_details?.status);
      const isResolved = localData.resolved === true ||
                         localData.autopilot_resolved === true ||
                         localData.resolved_at !== undefined ||
                         statusResolved;

      logger.debug(`[Hijacking Cache] Case ${caseId} - isResolved check: ${isResolved}`);

      if (isResolved) {
        // Case is closed - use cached data, NO API call needed
        // IMPORTANT: case_details already contains requested_amount from DB
        const details = localData.case_details || {
          id: caseId,
          status: localData.final_status || localData.payment_verification?.final_status || 'paid',
          paid_amount: localData.payment_verification?.actual_paid,
          requested_amount: localData.payment_verification?.expected_amount,
          registered_at: localData.resolved_at || localData.cached_at / 1000 || Date.now() / 1000
        };

        // Ensure registered_at exists (for time display in inbox)
        if (!details.registered_at) {
          details.registered_at = localData.resolved_at || localData.cached_at / 1000 || Date.now() / 1000;
        }

        // Override paid_amount from payment_verification if available
        if (localData.payment_verification?.actual_paid) {
          details.paid_amount = localData.payment_verification.actual_paid;
        }

        // Fallback: get requested_amount from first pirate offer in history
        if (!details.requested_amount && localData.history?.length > 0) {
          const firstPirateOffer = localData.history.find(h => h.type === 'pirate');
          if (firstPirateOffer?.amount) {
            details.requested_amount = firstPirateOffer.amount;
          }
        }

        // Force status to paid/solved for resolved cases
        if (details.status !== 'paid' && details.status !== 'solved') {
          details.status = 'paid';
        }

        // Include negotiation history as 'offers'
        if (localData.history && Array.isArray(localData.history)) {
          details.offers = localData.history;
        }

        // Include payment verification for display
        if (localData.payment_verification) {
          details.payment_verification = localData.payment_verification;
        }

        logger.debug(`[Hijacking Cache] Case ${caseId} RESOLVED from SQLite (paid: $${details.paid_amount})`);
        return { isOpen: false, details, cached: true };
      } else {
        logger.debug(`[Hijacking Cache] Case ${caseId} - SQLite record exists but NOT resolved, fetching from API`);
      }
    } else {
      logger.debug(`[Hijacking Cache] Case ${caseId} - No SQLite record found, fetching from API`);
    }

    // SECOND: Check memory cache
    if (hijackingCaseDetailsCache.has(caseId)) {
      const cached = hijackingCaseDetailsCache.get(caseId);
      const age = now - cached.timestamp;

      // Solved cases: Cache forever
      if (!cached.isOpen) {
        logger.debug(`[Hijacking Cache] Case ${caseId} (solved) from memory`);
        return { ...cached, cached: true };
      }

      // Open cases: Cache for 5 minutes
      if (age < HIJACKING_CASE_CACHE_TTL) {
        logger.debug(`[Hijacking Cache] Case ${caseId} (open) from memory (age: ${Math.round(age / 1000)}s)`);
        return { ...cached, cached: true };
      }
    }

    // THIRD: Fetch from API (only for unknown or expired cases)
    logger.info(`[Hijacking Cache] API CALL for case ${caseId} (not in local cache)`);
    const caseData = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
    const details = caseData?.data;
    if (!details) return null;

    const isOpen = details.paid_amount === null &&
                   details.status !== 'solved' &&
                   details.status !== 'paid' &&
                   details.status !== 'successful';

    // Store in memory cache
    hijackingCaseDetailsCache.set(caseId, {
      details,
      timestamp: now,
      isOpen
    });

    // Save to SQLite for persistence
    saveLocalCaseToDb(caseId, details, isOpen);

    logger.debug(`[Hijacking Cache] Case ${caseId} fetched from API (status: ${isOpen ? 'open' : 'resolved'})`);

    return { isOpen, details, cached: false };
  } catch (error) {
    logger.error(`[Hijacking Cache] Error fetching case ${caseId}:`, error.message);
    return null;
  }
}

module.exports = {
  hijackingCaseDetailsCache,
  HIJACKING_CASE_CACHE_TTL,
  invalidateHijackingCase,
  getCachedHijackingCase,
  saveNegotiationEvent,
  markCaseResolved,
  updateCaseVesselInfo
};
