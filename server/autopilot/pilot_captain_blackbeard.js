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
const { getAppDataDir } = require('../config');
const path = require('path');
const fs = require('fs');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

// Use same path logic as messenger.js for hijack history
const isPkg = !!process.pkg;
const DATA_DIR = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata')
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
 * Process a single hijacking case with exactly 2 counter-offers then accept.
 */
async function processHijackingCase(userId, caseId, vesselName, userVesselId, broadcastToUser) {
  const OFFER_PERCENTAGE = 0.25;
  const MAX_COUNTER_OFFERS = 2;

  logger.info(`[Blackbeard] Processing case ${caseId} for ${vesselName}...`);

  // Step 1: Get current case data
  let caseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  if (!caseResponse || !caseResponse.data) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to get case data`);
    return { success: false, reason: 'failed_to_get_case' };
  }

  let currentPrice = caseResponse.data.requested_amount;
  const initialDemand = currentPrice;
  const status = caseResponse.data.status;

  logger.info(`[Blackbeard] Case ${caseId}: Initial demand $${currentPrice}, status=${status}`);

  // Check if already resolved
  if (status === 'solved' || status === 'paid') {
    logger.info(`[Blackbeard] Case ${caseId}: Already resolved`);
    return { success: true, reason: 'already_resolved' };
  }

  // Save initial pirate demand to history
  saveToHistory(userId, caseId, {
    type: 'pirate',
    amount: currentPrice,
    timestamp: Date.now() / 1000
  });

  // Notify frontend
  if (broadcastToUser) {
    broadcastToUser(userId, 'notification', {
      type: 'info',
      message: `<p><strong>Captain Blackbeard</strong></p><p>Negotiating for ${vesselName}...<br>Pirate demand: $${currentPrice.toLocaleString()}</p>`
    });
  }

  // Step 2: Make exactly 2 counter-offers
  for (let offerNum = 1; offerNum <= MAX_COUNTER_OFFERS; offerNum++) {
    const offerAmount = Math.floor(currentPrice * OFFER_PERCENTAGE);

    logger.info(`[Blackbeard] Case ${caseId}: Counter-offer ${offerNum}/${MAX_COUNTER_OFFERS}: $${offerAmount} (25% of $${currentPrice})`);

    // Submit offer - API returns pirate counter IMMEDIATELY
    const offerResponse = await apiCall('/hijacking/submit-offer', 'POST', {
      case_id: caseId,
      amount: offerAmount
    });

    if (!offerResponse) {
      logger.error(`[Blackbeard] Case ${caseId}: Failed to submit offer ${offerNum}`);
      return { success: false, reason: 'failed_to_submit_offer' };
    }

    // Save our offer to history
    saveToHistory(userId, caseId, {
      type: 'user',
      amount: offerAmount,
      timestamp: Date.now() / 1000
    });

    // Get pirate's counter-offer from response (IMMEDIATE - no waiting!)
    const pirateCounter = offerResponse.data?.requested_amount;

    if (!pirateCounter) {
      logger.error(`[Blackbeard] Case ${caseId}: API did not return counter-offer`);
      return { success: false, reason: 'no_counter_offer' };
    }

    logger.info(`[Blackbeard] Case ${caseId}: Pirate counter: $${pirateCounter}`);

    // Save pirate counter to history
    saveToHistory(userId, caseId, {
      type: 'pirate',
      amount: pirateCounter,
      timestamp: Date.now() / 1000
    });

    // Update current price for next iteration
    currentPrice = pirateCounter;

    // Notify frontend of progress
    if (broadcastToUser) {
      broadcastToUser(userId, 'hijacking_update', {
        action: 'counter_offer_made',
        data: {
          case_id: caseId,
          offer_number: offerNum,
          our_offer: offerAmount,
          pirate_counter: pirateCounter
        }
      });
    }
  }

  // Step 3: ACCEPT the final pirate price (pay ransom)
  logger.info(`[Blackbeard] Case ${caseId}: Accepting final price $${currentPrice}`);

  // Get fresh case data with user cash BEFORE payment
  caseResponse = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
  if (!caseResponse || !caseResponse.data) {
    logger.error(`[Blackbeard] Case ${caseId}: Failed to get case data before payment`);
    return { success: false, reason: 'failed_to_get_case_before_payment' };
  }

  const cashBefore = caseResponse.user?.cash;
  const finalPrice = caseResponse.data.requested_amount;

  // Verify we have enough cash
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

  // Get cash AFTER payment for verification
  const cashAfter = payResponse.user?.cash;
  const actualPaid = cashBefore - cashAfter;
  const verified = (actualPaid === finalPrice);

  logger.info(`[Blackbeard] Case ${caseId}: Payment verification - Expected: $${finalPrice}, Actual: $${actualPaid}, Verified: ${verified}`);

  // Save resolution to history (same format as manual)
  saveToHistory(userId, caseId, null, {
    autopilot_resolved: true,
    resolved_at: Date.now() / 1000,
    vessel_name: vesselName,
    user_vessel_id: userVesselId,
    payment_verification: {
      verified: verified,
      expected_amount: finalPrice,
      actual_paid: actualPaid,
      cash_before: cashBefore,
      cash_after: cashAfter
    }
  });

  // Notify frontend
  if (broadcastToUser) {
    const verificationMsg = verified
      ? `<span style="color: #4ade80;">Payment verified</span>`
      : `<span style="color: #ef4444;">Payment verification FAILED</span>`;

    broadcastToUser(userId, 'notification', {
      type: verified ? 'success' : 'warning',
      message: `<p><strong>Captain Blackbeard</strong></p><p>${vesselName} released!<br>Initial demand: $${initialDemand.toLocaleString()}<br>Final payment: $${actualPaid.toLocaleString()}<br>${verificationMsg}</p>`
    });

    broadcastToUser(userId, 'hijacking_update', {
      action: 'hijacking_resolved',
      data: {
        case_id: caseId,
        vessel_name: vesselName,
        initial_demand: initialDemand,
        final_payment: actualPaid,
        verified: verified
      }
    });
  }

  // Log to autopilot logbook
  await auditLog(
    userId,
    CATEGORIES.HIJACKING,
    'Captain Blackbeard',
    `${vesselName} | Initial: ${formatCurrency(initialDemand)} | Paid: ${formatCurrency(actualPaid)}`,
    {
      caseId,
      vesselName,
      initialDemand,
      finalPayment: actualPaid,
      counterOffersMade: MAX_COUNTER_OFFERS,
      verified,
      cashBefore,
      cashAfter
    },
    verified ? 'SUCCESS' : 'WARNING',
    SOURCES.AUTOPILOT
  );

  return {
    success: true,
    initialDemand,
    finalPayment: actualPaid,
    verified
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
