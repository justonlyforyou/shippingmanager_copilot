/**
 * @fileoverview Captain Blackbeard - Auto-Negotiate Hijacking Pilot
 *
 * Automatically negotiates hijacked vessels.
 * Strategy: Make exactly 2 counter-offers (25%), then accept pirate's price.
 *
 * Flow:
 * 1. Pirate demands X (save to DB)
 * 2. We offer 25% of X (save to DB) -> API returns pirate counter Y (save to DB)
 * 3. WAIT 2 MINUTES
 * 4. We offer 25% of Y (save to DB) -> API returns pirate counter Z (save to DB)
 * 5. WAIT 2 MINUTES
 * 6. We PAY Z
 *
 * Result: Exactly 2 user offers, 3 pirate demands (initial + 2 counters)
 *
 * @module server/autopilot/pilot_captain_blackbeard
 */

const state = require('../state');
const logger = require('../utils/logger');
const { getUserId, apiCall } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');
const { getCachedHijackingCase, saveNegotiationEvent, markCaseResolved, updateCaseVesselInfo } = require('../websocket/hijacking-cache');

/**
 * Wait for specified milliseconds.
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a single hijacking case.
 * Makes exactly 2 offers, then pays the final pirate counter.
 */
async function processHijackingCase(userId, caseId, vesselName, userVesselId, broadcastToUser, settings) {
  const OFFER_PERCENTAGE = 0.25;
  const WAIT_TIME_MS = 2 * 60 * 1000; // 2 minutes

  // Check if already resolved in cache - skip silently
  const cachedCase = await getCachedHijackingCase(caseId);
  if (cachedCase && !cachedCase.isOpen) {
    return { success: false, reason: 'already_resolved', skipped: true };
  }

  // Get case data from API
  let caseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  if (!caseResponse || !caseResponse.data) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to get case data`);
    return { success: false, reason: 'failed_to_get_case' };
  }

  const initialDemand = caseResponse.data.requested_amount;
  const status = caseResponse.data.status;
  const registeredAt = caseResponse.data.registered_at;

  // Check if already resolved via API - skip silently
  if (status === 'solved' || status === 'paid') {
    return { success: true, reason: 'already_resolved' };
  }

  // Only log for active cases that we're actually processing
  logger.info(`[Blackbeard] === START Case ${caseId} for ${vesselName} ===`);
  logger.info(`[Blackbeard] Case ${caseId}: Initial demand $${initialDemand}, status=${status}`);

  // Save vessel info
  updateCaseVesselInfo(caseId, userVesselId, vesselName);

  // Save initial pirate demand
  saveNegotiationEvent(caseId, 'pirate', initialDemand, registeredAt);
  logger.info(`[Blackbeard] Case ${caseId}: Saved pirate demand $${initialDemand}`);

  // Notify frontend
  if (broadcastToUser) {
    broadcastToUser(userId, 'notification', {
      type: 'info',
      message: `<p><strong>Captain Blackbeard</strong></p><p>Negotiating for ${vesselName}...<br>Pirate demand: $${initialDemand.toLocaleString()}</p>`
    });
  }

  // ========== OFFER 1 ==========
  const offer1 = Math.floor(initialDemand * OFFER_PERCENTAGE);
  logger.info(`[Blackbeard] Case ${caseId}: Making OFFER 1: $${offer1} (25% of $${initialDemand})`);

  const response1 = await apiCall('/hijacking/submit-offer', 'POST', { case_id: caseId, amount: offer1 });
  if (!response1 || !response1.data) {
    logger.error(`[Blackbeard] Case ${caseId}: OFFER 1 failed`);
    return { success: false, reason: 'offer1_failed' };
  }

  const pirateCounter1 = response1.data.requested_amount;
  logger.info(`[Blackbeard] Case ${caseId}: Pirate counter 1: $${pirateCounter1}`);

  // Save offer 1 and pirate counter 1
  const now1 = Date.now() / 1000;
  saveNegotiationEvent(caseId, 'user', offer1, now1);
  saveNegotiationEvent(caseId, 'pirate', pirateCounter1, now1 + 1);
  logger.info(`[Blackbeard] Case ${caseId}: Saved OFFER 1 and COUNTER 1 to DB`);

  if (broadcastToUser) {
    broadcastToUser(userId, 'hijacking_update', {
      action: 'counter_offer_made',
      data: { case_id: caseId, offer_number: 1, our_offer: offer1, pirate_counter: pirateCounter1 }
    });
  }

  // WAIT 2 MINUTES
  logger.info(`[Blackbeard] Case ${caseId}: Waiting 2 minutes...`);
  await wait(WAIT_TIME_MS);

  // ========== OFFER 2 ==========
  const offer2 = Math.floor(pirateCounter1 * OFFER_PERCENTAGE);
  logger.info(`[Blackbeard] Case ${caseId}: Making OFFER 2: $${offer2} (25% of $${pirateCounter1})`);

  const response2 = await apiCall('/hijacking/submit-offer', 'POST', { case_id: caseId, amount: offer2 });
  if (!response2 || !response2.data) {
    logger.error(`[Blackbeard] Case ${caseId}: OFFER 2 failed`);
    return { success: false, reason: 'offer2_failed' };
  }

  const pirateCounter2 = response2.data.requested_amount;
  logger.info(`[Blackbeard] Case ${caseId}: Pirate counter 2 (FINAL): $${pirateCounter2}`);

  // Save offer 2 and pirate counter 2
  const now2 = Date.now() / 1000;
  saveNegotiationEvent(caseId, 'user', offer2, now2);
  saveNegotiationEvent(caseId, 'pirate', pirateCounter2, now2 + 1);
  logger.info(`[Blackbeard] Case ${caseId}: Saved OFFER 2 and COUNTER 2 to DB`);

  if (broadcastToUser) {
    broadcastToUser(userId, 'hijacking_update', {
      action: 'counter_offer_made',
      data: { case_id: caseId, offer_number: 2, our_offer: offer2, pirate_counter: pirateCounter2 }
    });
  }

  // WAIT 2 MINUTES
  logger.info(`[Blackbeard] Case ${caseId}: Waiting 2 minutes before payment...`);
  await wait(WAIT_TIME_MS);

  // ========== PAYMENT ==========
  // Re-fetch case to get current cash
  caseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  const cashBefore = caseResponse?.user?.cash;
  const finalPrice = pirateCounter2;

  logger.info(`[Blackbeard] Case ${caseId}: Ready to pay $${finalPrice}. Cash: $${cashBefore}`);

  if (cashBefore < finalPrice) {
    logger.error(`[Blackbeard] Case ${caseId}: Insufficient funds!`);
    if (broadcastToUser) {
      broadcastToUser(userId, 'notification', {
        type: 'error',
        message: `<p><strong>Captain Blackbeard</strong></p><p>Cannot pay ransom for ${vesselName}!<br>Need: $${finalPrice.toLocaleString()}<br>Have: $${cashBefore.toLocaleString()}</p>`
      });

      // Send desktop notification for error if enabled
      if (settings && settings.enableDesktopNotifications && settings.notifyCaptainBlackbeardDesktop) {
        broadcastToUser(userId, 'desktop_notification', {
          title: '🏴‍☠️ Captain Blackbeard - ERROR',
          message: `Cannot pay ransom for ${vesselName}! Need $${finalPrice.toLocaleString()}, have $${cashBefore.toLocaleString()}`,
          type: 'error'
        });
      }
    }
    return { success: false, reason: 'insufficient_funds' };
  }

  // Lock to prevent race conditions
  state.setLockStatus(userId, 'hijackingPayment', true);
  logger.info(`[Blackbeard] Case ${caseId}: Payment lock ACQUIRED`);

  let paymentVerified = false;
  let cashAfter = null;
  let actualPaid = null;

  try {
    // PAY
    const payResponse = await apiCall('/hijacking/pay', 'POST', { case_id: caseId });
    if (!payResponse) {
      logger.error(`[Blackbeard] Case ${caseId}: Payment API call failed`);
      return { success: false, reason: 'payment_failed' };
    }

    // Verify payment
    const finalResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
    const finalStatus = finalResponse?.data?.status;
    cashAfter = finalResponse?.user?.cash;
    actualPaid = cashBefore - cashAfter;

    paymentVerified = (actualPaid === finalPrice) && (finalStatus === 'solved' || finalStatus === 'paid');

    logger.info(`[Blackbeard] Case ${caseId}: Payment done. Paid: $${actualPaid}, Expected: $${finalPrice}, Verified: ${paymentVerified}`);
  } finally {
    state.setLockStatus(userId, 'hijackingPayment', false);
    logger.info(`[Blackbeard] Case ${caseId}: Payment lock RELEASED`);
  }

  // Save resolution
  markCaseResolved(caseId, {
    autopilot_resolved: true,
    resolved_at: Date.now() / 1000,
    actual_paid: actualPaid,
    cash_before: cashBefore,
    cash_after: cashAfter,
    verified: paymentVerified
  });

  logger.info(`[Blackbeard] === END Case ${caseId}: Paid $${actualPaid}, Verified: ${paymentVerified} ===`);

  // Notify frontend
  if (broadcastToUser) {
    broadcastToUser(userId, 'notification', {
      type: paymentVerified ? 'success' : 'warning',
      message: `<p><strong>Captain Blackbeard</strong></p><p>${vesselName} released!<br>Initial: $${initialDemand.toLocaleString()}<br>Paid: $${actualPaid.toLocaleString()}<br>${paymentVerified ? 'Payment verified' : 'VERIFICATION FAILED'}</p>`
    });

    // Send desktop notification if enabled
    if (settings && settings.enableDesktopNotifications && settings.notifyCaptainBlackbeardDesktop) {
      const saved = initialDemand - actualPaid;
      broadcastToUser(userId, 'desktop_notification', {
        title: '🏴‍☠️ Captain Blackbeard',
        message: `${vesselName} released! Paid $${actualPaid.toLocaleString()} (saved $${saved.toLocaleString()})`,
        type: paymentVerified ? 'success' : 'warning'
      });
    }

    broadcastToUser(userId, 'hijacking_update', {
      action: 'hijacking_resolved',
      data: { case_id: caseId, vessel_name: vesselName, initial_demand: initialDemand, final_payment: actualPaid, verified: paymentVerified }
    });
  }

  // Audit log
  await auditLog(
    userId,
    CATEGORIES.HIJACKING,
    'Captain Blackbeard',
    `${vesselName} | Initial: ${formatCurrency(initialDemand)} | Paid: ${formatCurrency(actualPaid)}${paymentVerified ? ' | VERIFIED' : ' | UNVERIFIED'}`,
    { caseId, vesselName, initialDemand, finalPayment: actualPaid, verified: paymentVerified, cashBefore, cashAfter },
    paymentVerified ? 'SUCCESS' : 'WARNING',
    SOURCES.AUTOPILOT
  );

  return { success: true, initialDemand, finalPayment: actualPaid, verified: paymentVerified };
}

/**
 * Main entry point - find and process all active hijacking cases.
 */
async function autoNegotiateHijacking(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  if (autopilotPaused) {
    logger.debug('[Blackbeard] Skipped - Autopilot PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoNegotiateHijacking) {
    logger.debug('[Blackbeard] Feature disabled');
    return;
  }

  try {
    const { getCachedMessengerChats } = require('../websocket');
    const chats = await getCachedMessengerChats();

    if (!chats || chats.length === 0) {
      logger.debug('[Blackbeard] No chats');
      return;
    }

    const hijackingChats = chats.filter(c => c.system_chat && c.body === 'vessel_got_hijacked');

    if (hijackingChats.length === 0) {
      logger.debug('[Blackbeard] No hijacking cases');
      return;
    }

    logger.info(`[Blackbeard] Found ${hijackingChats.length} hijacking case(s)`);

    let processed = 0;
    for (const chat of hijackingChats) {
      const caseId = chat.values?.case_id;
      const vesselName = chat.values?.vessel_name || 'Unknown';
      const userVesselId = chat.values?.user_vessel_id;

      if (!caseId) continue;

      try {
        const result = await processHijackingCase(userId, caseId, vesselName, userVesselId, broadcastToUser, settings);
        if (result.success) processed++;
      } catch (err) {
        logger.error(`[Blackbeard] Case ${caseId} error: ${err.message}`);
        await auditLog(userId, CATEGORIES.HIJACKING, 'Captain Blackbeard', `Failed: ${vesselName} - ${err.message}`, { caseId, error: err.message }, 'ERROR', SOURCES.AUTOPILOT);
      }
    }

    if (processed > 0) await tryUpdateAllData();
  } catch (err) {
    logger.error(`[Blackbeard] Error: ${err.message}`);
  }
}

module.exports = { autoNegotiateHijacking };
