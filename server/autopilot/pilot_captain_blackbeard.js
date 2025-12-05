/**
 * @fileoverview Captain Blackbeard - Auto-Negotiate Hijacking Pilot
 *
 * Automatically negotiates hijacked vessels.
 * Strategy: Make exactly 2 counter-offers (25%), then accept pirate's price.
 *
 * Flow (identical to manual):
 * 1. Pirate demands X
 * 2. We offer 25% -> API returns pirate counter Y immediately
 * 3. We offer 25% of Y -> API returns pirate counter Z immediately
 * 4. We ACCEPT Z (pay ransom)
 *
 * @module server/autopilot/pilot_captain_blackbeard
 */

const state = require('../state');
const logger = require('../utils/logger');
const { getUserId, apiCall } = require('../utils/api');
const { getAppBaseDir } = require('../config');
const path = require('path');
const fs = require('fs');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

// Use same path logic as messenger.js for hijack history
const isPkg = !!process.pkg;
const DATA_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata')
  : path.join(__dirname, '../../userdata');

/**
 * Save negotiation entry to history file.
 */
function saveToHistory(userId, caseId, entry, metadata = {}) {
  try {
    const historyDir = path.join(DATA_DIR, 'hijack_history');
    const historyPath = path.join(historyDir, `${userId}-${caseId}.json`);

    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }

    let existingData = { history: [] };
    if (fs.existsSync(historyPath)) {
      existingData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (Array.isArray(existingData)) {
        existingData = { history: existingData };
      }
    }

    if (entry) {
      existingData.history.push(entry);
    }

    // Merge metadata
    Object.assign(existingData, metadata);

    fs.writeFileSync(historyPath, JSON.stringify(existingData, null, 2));
    return true;
  } catch (error) {
    logger.error(`[Blackbeard] Failed to save history for case ${caseId}:`, error.message);
    return false;
  }
}

/**
 * Wait for specified milliseconds.
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a single hijacking case with strict verification after each step.
 * Flow:
 * 1. Get case, make 1st offer (25%)
 * 2. WAIT 2 MINUTES
 * 3. Verify response matches current case demand
 * 4. Make 2nd offer (25%)
 * 5. WAIT 2 MINUTES
 * 6. Verify response matches current case demand
 * 7. Check balance, pay if sufficient
 * 8. Verify payment was deducted
 */
async function processHijackingCase(userId, caseId, vesselName, userVesselId, broadcastToUser) {
  const OFFER_PERCENTAGE = 0.25;
  const WAIT_TIME_MS = 2 * 60 * 1000; // 2 minutes

  logger.info(`[Blackbeard] Processing case ${caseId} for ${vesselName}...`);

  // Step 1: Get current case data
  let caseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  if (!caseResponse || !caseResponse.data) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to get case data`);
    return { success: false, reason: 'failed_to_get_case' };
  }

  let currentDemand = caseResponse.data.requested_amount;
  const initialDemand = currentDemand;
  const status = caseResponse.data.status;

  logger.info(`[Blackbeard] Case ${caseId}: Initial demand $${currentDemand}, status=${status}`);

  // Check if already resolved
  if (status === 'solved' || status === 'paid') {
    logger.info(`[Blackbeard] Case ${caseId}: Already resolved`);
    return { success: true, reason: 'already_resolved' };
  }

  // Save initial pirate demand to history
  saveToHistory(userId, caseId, {
    type: 'pirate',
    amount: currentDemand,
    timestamp: Date.now() / 1000
  });

  // Notify frontend
  if (broadcastToUser) {
    broadcastToUser(userId, 'notification', {
      type: 'info',
      message: `<p><strong>Captain Blackbeard</strong></p><p>Negotiating for ${vesselName}...<br>Pirate demand: $${currentDemand.toLocaleString()}</p>`
    });
  }

  // ========== FIRST OFFER ==========
  const offer1Amount = Math.floor(currentDemand * OFFER_PERCENTAGE);
  logger.info(`[Blackbeard] Case ${caseId}: Offer 1: $${offer1Amount} (25% of $${currentDemand})`);

  const offer1Response = await apiCall('/hijacking/submit-offer', 'POST', {
    case_id: caseId,
    amount: offer1Amount
  });

  if (!offer1Response) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to submit offer 1`);
    return { success: false, reason: 'failed_to_submit_offer_1' };
  }

  const offer1PirateCounter = offer1Response.data?.requested_amount;
  if (!offer1PirateCounter) {
    logger.error(`[Blackbeard] Case ${caseId}: No counter-offer in response 1`);
    return { success: false, reason: 'no_counter_offer_1' };
  }

  // Save our offer and pirate counter to history
  saveToHistory(userId, caseId, {
    type: 'user',
    amount: offer1Amount,
    timestamp: Date.now() / 1000
  });
  saveToHistory(userId, caseId, {
    type: 'pirate',
    amount: offer1PirateCounter,
    timestamp: Date.now() / 1000
  });

  logger.info(`[Blackbeard] Case ${caseId}: Pirate counter 1: $${offer1PirateCounter}`);
  logger.info(`[Blackbeard] Case ${caseId}: Waiting 2 minutes before verification...`);

  if (broadcastToUser) {
    broadcastToUser(userId, 'hijacking_update', {
      action: 'counter_offer_made',
      data: { case_id: caseId, offer_number: 1, our_offer: offer1Amount, pirate_counter: offer1PirateCounter }
    });
  }

  // WAIT 2 MINUTES
  await wait(WAIT_TIME_MS);

  // VERIFY: Re-fetch case and check demand matches
  caseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  if (!caseResponse || !caseResponse.data) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to verify case after offer 1`);
    return { success: false, reason: 'failed_to_verify_after_offer_1' };
  }

  const verifiedDemand1 = caseResponse.data.requested_amount;
  if (verifiedDemand1 !== offer1PirateCounter) {
    logger.error(`[Blackbeard] Case ${caseId}: VERIFICATION FAILED after offer 1! Response: $${offer1PirateCounter}, Case: $${verifiedDemand1}`);
    return { success: false, reason: 'verification_mismatch_offer_1', expected: offer1PirateCounter, actual: verifiedDemand1 };
  }

  logger.info(`[Blackbeard] Case ${caseId}: Verification 1 PASSED - demand matches: $${verifiedDemand1}`);
  currentDemand = verifiedDemand1;

  // ========== SECOND OFFER ==========
  const offer2Amount = Math.floor(currentDemand * OFFER_PERCENTAGE);
  logger.info(`[Blackbeard] Case ${caseId}: Offer 2: $${offer2Amount} (25% of $${currentDemand})`);

  const offer2Response = await apiCall('/hijacking/submit-offer', 'POST', {
    case_id: caseId,
    amount: offer2Amount
  });

  if (!offer2Response) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to submit offer 2`);
    return { success: false, reason: 'failed_to_submit_offer_2' };
  }

  const offer2PirateCounter = offer2Response.data?.requested_amount;
  if (!offer2PirateCounter) {
    logger.error(`[Blackbeard] Case ${caseId}: No counter-offer in response 2`);
    return { success: false, reason: 'no_counter_offer_2' };
  }

  // Save our offer and pirate counter to history
  saveToHistory(userId, caseId, {
    type: 'user',
    amount: offer2Amount,
    timestamp: Date.now() / 1000
  });
  saveToHistory(userId, caseId, {
    type: 'pirate',
    amount: offer2PirateCounter,
    timestamp: Date.now() / 1000
  });

  logger.info(`[Blackbeard] Case ${caseId}: Pirate counter 2 (FINAL): $${offer2PirateCounter}`);
  logger.info(`[Blackbeard] Case ${caseId}: Waiting 2 minutes before verification...`);

  if (broadcastToUser) {
    broadcastToUser(userId, 'hijacking_update', {
      action: 'counter_offer_made',
      data: { case_id: caseId, offer_number: 2, our_offer: offer2Amount, pirate_counter: offer2PirateCounter }
    });
  }

  // WAIT 2 MINUTES
  await wait(WAIT_TIME_MS);

  // VERIFY: Re-fetch case and check demand matches
  caseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  if (!caseResponse || !caseResponse.data) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to verify case after offer 2`);
    return { success: false, reason: 'failed_to_verify_after_offer_2' };
  }

  const verifiedDemand2 = caseResponse.data.requested_amount;
  if (verifiedDemand2 !== offer2PirateCounter) {
    logger.error(`[Blackbeard] Case ${caseId}: VERIFICATION FAILED after offer 2! Response: $${offer2PirateCounter}, Case: $${verifiedDemand2}`);
    return { success: false, reason: 'verification_mismatch_offer_2', expected: offer2PirateCounter, actual: verifiedDemand2 };
  }

  logger.info(`[Blackbeard] Case ${caseId}: Verification 2 PASSED - demand matches: $${verifiedDemand2}`);

  // ========== PAYMENT ==========
  const finalPrice = verifiedDemand2;
  const cashBefore = caseResponse.user?.cash;

  logger.info(`[Blackbeard] Case ${caseId}: Ready to pay $${finalPrice}. Cash before: $${cashBefore}`);

  // Check if we have enough cash
  if (cashBefore < finalPrice) {
    logger.warn(`[Blackbeard] Case ${caseId}: Insufficient funds - need $${finalPrice}, have $${cashBefore}`);

    if (broadcastToUser) {
      broadcastToUser(userId, 'notification', {
        type: 'error',
        message: `<p><strong>Captain Blackbeard</strong></p><p>Cannot pay ransom for ${vesselName}!<br>Need: $${finalPrice.toLocaleString()}<br>Have: $${cashBefore.toLocaleString()}</p>`
      });
    }

    return { success: false, reason: 'insufficient_funds', required: finalPrice, available: cashBefore };
  }

  // PAY the ransom
  const payResponse = await apiCall('/hijacking/pay', 'POST', { case_id: caseId });

  if (!payResponse) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to pay ransom`);
    return { success: false, reason: 'failed_to_pay' };
  }

  // IMMEDIATELY check cash after payment for verification
  const cashAfterFromResponse = payResponse.user?.cash;
  const actualPaidFromResponse = cashBefore - cashAfterFromResponse;

  logger.info(`[Blackbeard] Case ${caseId}: Payment made. Cash after (response): $${cashAfterFromResponse}, Deducted: $${actualPaidFromResponse}`);

  // WAIT 2 MINUTES before final verification
  logger.info(`[Blackbeard] Case ${caseId}: Waiting 2 minutes before final payment verification...`);
  await wait(WAIT_TIME_MS);

  // FINAL VERIFICATION: Re-fetch case to confirm payment
  const finalCaseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  const finalStatus = finalCaseResponse?.data?.status;
  const cashAfterVerified = finalCaseResponse?.user?.cash;
  const actualPaidVerified = cashBefore - cashAfterVerified;

  const paymentVerified = (actualPaidVerified === finalPrice) && (finalStatus === 'solved' || finalStatus === 'paid');

  logger.info(`[Blackbeard] Case ${caseId}: FINAL VERIFICATION - Status: ${finalStatus}, Expected: $${finalPrice}, Actual: $${actualPaidVerified}, Verified: ${paymentVerified}`);

  // Save resolution to history
  saveToHistory(userId, caseId, null, {
    autopilot_resolved: true,
    resolved_at: Date.now() / 1000,
    vessel_name: vesselName,
    user_vessel_id: userVesselId,
    payment_verification: {
      verified: paymentVerified,
      expected_amount: finalPrice,
      actual_paid: actualPaidVerified,
      cash_before: cashBefore,
      cash_after: cashAfterVerified,
      final_status: finalStatus
    }
  });

  // Notify frontend with Blackbeard's signature
  if (broadcastToUser) {
    const verificationMsg = paymentVerified
      ? `<span style="color: #4ade80;">Payment verified</span>`
      : `<span style="color: #ef4444;">Payment verification FAILED</span>`;

    const signature = paymentVerified
      ? `<br><br><em style="color: #9ca3af;">~ Captain Blackbeard</em>`
      : '';

    broadcastToUser(userId, 'notification', {
      type: paymentVerified ? 'success' : 'warning',
      message: `<p><strong>Captain Blackbeard</strong></p><p>${vesselName} released!<br>Initial demand: $${initialDemand.toLocaleString()}<br>Final payment: $${actualPaidVerified.toLocaleString()}<br>${verificationMsg}${signature}</p>`
    });

    broadcastToUser(userId, 'hijacking_update', {
      action: 'hijacking_resolved',
      data: {
        case_id: caseId,
        vessel_name: vesselName,
        initial_demand: initialDemand,
        final_payment: actualPaidVerified,
        verified: paymentVerified
      }
    });
  }

  // Log to autopilot logbook
  await auditLog(
    userId,
    CATEGORIES.HIJACKING,
    'Captain Blackbeard',
    `${vesselName} | Initial: ${formatCurrency(initialDemand)} | Paid: ${formatCurrency(actualPaidVerified)}${paymentVerified ? ' | VERIFIED' : ' | UNVERIFIED'}`,
    {
      caseId,
      vesselName,
      initialDemand,
      finalPayment: actualPaidVerified,
      counterOffersMade: 2,
      verified: paymentVerified,
      cashBefore,
      cashAfter: cashAfterVerified,
      finalStatus
    },
    paymentVerified ? 'SUCCESS' : 'WARNING',
    SOURCES.AUTOPILOT
  );

  return {
    success: true,
    initialDemand,
    finalPayment: actualPaidVerified,
    verified: paymentVerified
  };
}

/**
 * Main autopilot entry point - processes all active hijacking cases.
 */
async function autoNegotiateHijacking(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  if (autopilotPaused) {
    logger.debug('[Blackbeard] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoNegotiateHijacking) {
    logger.debug('[Blackbeard] Feature disabled in settings');
    return;
  }

  try {
    const { getCachedMessengerChats } = require('../websocket');
    const chats = await getCachedMessengerChats();

    if (!chats || chats.length === 0) {
      logger.debug('[Blackbeard] No messages data from cache');
      return;
    }

    // Find active hijacking cases
    const hijackingChats = chats.filter(chat => {
      return chat.system_chat && chat.body === 'vessel_got_hijacked';
    });

    if (hijackingChats.length === 0) {
      logger.debug('[Blackbeard] No active hijacking cases');
      return;
    }

    logger.info(`[Blackbeard] Found ${hijackingChats.length} active hijacking case(s)`);

    let processed = 0;
    for (const chat of hijackingChats) {
      const caseId = chat.values?.case_id;
      const vesselName = chat.values?.vessel_name || 'Unknown Vessel';
      const userVesselId = chat.values?.user_vessel_id;

      if (!caseId) {
        logger.debug('[Blackbeard] Case missing ID, skipping');
        continue;
      }

      try {
        const result = await processHijackingCase(userId, caseId, vesselName, userVesselId, broadcastToUser);

        if (result.success) {
          processed++;
        } else {
          logger.warn(`[Blackbeard] Case ${caseId} failed: ${result.reason}`);
        }
      } catch (error) {
        logger.error(`[Blackbeard] Error processing case ${caseId}:`, error.message);

        await auditLog(
          userId,
          CATEGORIES.HIJACKING,
          'Captain Blackbeard',
          `Failed: ${vesselName} - ${error.message}`,
          { caseId, vesselName, error: error.message },
          'ERROR',
          SOURCES.AUTOPILOT
        );

        if (broadcastToUser) {
          broadcastToUser(userId, 'notification', {
            type: 'error',
            message: `<p><strong>Captain Blackbeard</strong></p><p>Failed to negotiate for ${vesselName}:<br>${error.message}</p>`
          });
        }
      }
    }

    if (processed > 0) {
      await tryUpdateAllData();
    }

  } catch (error) {
    logger.error('[Blackbeard] Error:', error.message);

    await auditLog(
      userId,
      CATEGORIES.HIJACKING,
      'Captain Blackbeard',
      `Operation failed: ${error.message}`,
      { error: error.message, stack: error.stack },
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoNegotiateHijacking
};
