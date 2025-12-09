/**
 * @fileoverview Hijacking Case Caching - File-Based Persistent Cache
 *
 * Uses LOCAL FILES to cache hijacking case details - NO API calls for resolved cases!
 * Strategy:
 * - First check: Local file in userdata/hijack_history/{userId}-{caseId}.json
 * - If file has resolved:true -> Use local data, ZERO API calls
 * - If no file or not resolved -> API call once, then save locally
 *
 * This eliminates ALL API calls for resolved cases, even after server restart!
 *
 * @module server/websocket/hijacking-cache
 */

const { apiCall, getUserId } = require('../utils/api');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const { getAppBaseDir } = require('../config');

// Path to hijack history files
const isPkg = !!process.pkg;
const HIJACK_HISTORY_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'hijack_history')
  : path.join(__dirname, '../../userdata/hijack_history');

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
 * Reads local history file for a hijacking case.
 * File format: {userId}-{caseId}.json
 * @param {number} caseId - Case ID
 * @returns {Object|null} Local history data or null if not found
 */
function readLocalCaseFile(caseId) {
  try {
    if (!fs.existsSync(HIJACK_HISTORY_DIR)) return null;

    const userId = getUserId();
    let filePath;

    if (userId) {
      // Normal case: userId is known
      filePath = path.join(HIJACK_HISTORY_DIR, `${userId}-${caseId}.json`);
    } else {
      // Fallback: userId not yet initialized (server startup)
      // Search for any file ending with -{caseId}.json
      const files = fs.readdirSync(HIJACK_HISTORY_DIR);
      const matchingFile = files.find(f => f.endsWith(`-${caseId}.json`));
      if (matchingFile) {
        filePath = path.join(HIJACK_HISTORY_DIR, matchingFile);
        logger.debug(`[Hijacking Cache] Found case ${caseId} via filename search (userId not yet set)`);
      }
    }

    if (!filePath || !fs.existsSync(filePath)) {
      logger.debug(`[Hijacking Cache] No local file for case ${caseId} (user ${userId})`);
      return null;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data;
  } catch (error) {
    logger.debug(`[Hijacking Cache] Could not read local file for case ${caseId}: ${error.message}`);
    return null;
  }
}

/**
 * Saves case details to local file for persistent caching.
 * @param {number} caseId - Case ID
 * @param {Object} details - Case details from API
 * @param {boolean} isOpen - Whether case is still open
 */
function saveLocalCaseFile(caseId, details, isOpen) {
  try {
    const userId = getUserId();
    if (!userId) return;

    if (!fs.existsSync(HIJACK_HISTORY_DIR)) {
      fs.mkdirSync(HIJACK_HISTORY_DIR, { recursive: true });
    }

    const filePath = path.join(HIJACK_HISTORY_DIR, `${userId}-${caseId}.json`);

    // Load existing data (preserve history array)
    let existingData = {};
    if (fs.existsSync(filePath)) {
      existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    // Merge with new data
    const updatedData = {
      ...existingData,
      case_details: details,         // Full API response data
      resolved: !isOpen,             // For quick lookup
      final_status: details.status,  // For quick lookup
      cached_at: Date.now()
    };

    // CRITICAL: Ensure history array exists (Blackbeard needs it)
    if (!updatedData.history) {
      updatedData.history = [];
    }

    fs.writeFileSync(filePath, JSON.stringify(updatedData, null, 2));
    logger.debug(`[Hijacking Cache] Saved case ${caseId} to local file (resolved: ${!isOpen})`);
  } catch (error) {
    logger.error(`[Hijacking Cache] Failed to save case ${caseId} locally: ${error.message}`);
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
 * Gets hijacking case details - checks LOCAL FILE first, then memory, then API.
 *
 * Priority:
 * 1. Local file with resolved:true -> Use it, ZERO API calls
 * 2. Memory cache (for open cases during session)
 * 3. API call (only for new/unknown cases) -> Then save locally
 *
 * @param {number} caseId - Hijacking case ID
 * @returns {Promise<{isOpen: boolean, details: Object, cached: boolean}|null>}
 */
async function getCachedHijackingCase(caseId) {
  try {
    const now = Date.now();

    // FIRST: Check local file (survives server restart!)
    const localData = readLocalCaseFile(caseId);
    logger.debug(`[Hijacking Cache] Case ${caseId} - localData found: ${!!localData}, resolved: ${localData?.resolved}, autopilot_resolved: ${localData?.autopilot_resolved}, resolved_at: ${localData?.resolved_at}`);

    if (localData) {
      // Only use file if case is RESOLVED - open cases need fresh API data
      const isResolved = localData.resolved === true ||
                         localData.autopilot_resolved === true ||
                         localData.resolved_at !== undefined;

      logger.debug(`[Hijacking Cache] Case ${caseId} - isResolved check: ${isResolved}`);

      if (isResolved) {
        // Case is closed - use cached data, NO API call needed
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
      // CRITICAL: Override paid_amount from payment_verification (case_details may have null from pre-payment API call)
      if (localData.payment_verification?.actual_paid) {
        details.paid_amount = localData.payment_verification.actual_paid;
      }
      // Ensure requested_amount exists
      if (!details.requested_amount && localData.payment_verification?.expected_amount) {
        details.requested_amount = localData.payment_verification.expected_amount;
      }
      // Force status to paid/solved for resolved cases
      if (details.status !== 'paid' && details.status !== 'solved') {
        details.status = 'paid';
      }
      // CRITICAL: Include negotiation history (stored as 'history' in local file)
      // Frontend expects this as 'offers' array
      if (localData.history && Array.isArray(localData.history)) {
        details.offers = localData.history;
      }
      // Include payment verification for display
      if (localData.payment_verification) {
        details.payment_verification = localData.payment_verification;
      }
      logger.debug(`[Hijacking Cache] Case ${caseId} RESOLVED from local file (paid: $${details.paid_amount})`);
      return { isOpen: false, details, cached: true };
      } else {
        logger.debug(`[Hijacking Cache] Case ${caseId} - File exists but NOT resolved, fetching from API`);
      }
    } else {
      logger.debug(`[Hijacking Cache] Case ${caseId} - No local file found, fetching from API`);
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
    logger.debug(`[Hijacking Cache] Case ${caseId} - Making API call to /hijacking/get-case`);
    const caseData = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
    const details = caseData?.data;
    if (!details) return null;

    const isOpen = details.paid_amount === null &&
                   details.status !== 'solved' &&
                   details.status !== 'paid';

    // Store in memory cache
    hijackingCaseDetailsCache.set(caseId, {
      details,
      timestamp: now,
      isOpen
    });

    // Save to local file for persistence (especially important for resolved cases!)
    saveLocalCaseFile(caseId, details, isOpen);

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
  getCachedHijackingCase
};
