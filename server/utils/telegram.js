/**
 * @fileoverview Telegram Alert Service
 *
 * Sends price alerts to Telegram when fuel/CO2 prices are in the "green" zone.
 * Uses the Telegram Bot API to send messages.
 *
 * Price Thresholds (from utils.js):
 * - Fuel green: < 500 $/t
 * - CO2 green: < 10 $/t
 *
 * @module server/utils/telegram
 */

const logger = require('./logger');
const { decryptData } = require('./encryption');

// Cooldown between alerts (30 minutes) to prevent spam
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Send a message via Telegram Bot API
 *
 * @param {string} botToken - Telegram bot token
 * @param {string} chatId - Chat ID to send message to
 * @param {string} message - Message text (supports Markdown)
 * @returns {Promise<boolean>} True if message sent successfully
 */
async function sendTelegramMessage(botToken, chatId, message) {
  if (!botToken || !chatId) {
    logger.warn('[Telegram] Missing bot token or chat ID');
    return false;
  }

  let finalChatId = chatId;
  if (/^\d+$/.test(chatId)) {
    finalChatId = `-${chatId}`;
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: finalChatId,
        text: message,
        parse_mode: 'Markdown'
      })
    });

    const data = await response.json();

    if (!data.ok) {
      logger.error(`[Telegram] API error: ${data.description}`);
      return false;
    }

    logger.debug('[Telegram] Message sent successfully');
    return true;
  } catch (error) {
    logger.error(`[Telegram] Failed to send message: ${error.message}`);
    return false;
  }
}

/**
 * Check if price is in "green" zone using user-configured thresholds
 *
 * @param {number} fuelPrice - Current fuel price
 * @param {number} co2Price - Current CO2 price
 * @param {Object} settings - User settings with fuelThreshold and co2Threshold
 * @returns {{fuelGreen: boolean, co2Green: boolean}}
 */
function checkGreenPrices(fuelPrice, co2Price, settings) {
  return {
    fuelGreen: fuelPrice > 0 && settings.fuelThreshold && fuelPrice <= settings.fuelThreshold,
    co2Green: co2Price > 0 && settings.co2Threshold && co2Price <= settings.co2Threshold
  };
}

/**
 * Send price alert if prices are green and cooldown has passed
 *
 * @param {Object} settings - User settings object
 * @param {number} fuelPrice - Current fuel price
 * @param {number} co2Price - Current CO2 price
 * @param {Function} updateSettings - Callback to update settings (for cooldown timestamps)
 * @returns {Promise<{sent: boolean, type: string|null}>}
 */
async function sendPriceAlert(settings, fuelPrice, co2Price, updateSettings) {
  // Check if Telegram alerts are enabled
  if (!settings.telegramAlertEnabled) {
    return { sent: false, type: null };
  }

  // Check if we have bot token and chat ID
  if (!settings.telegramBotToken || !settings.telegramChatId) {
    logger.debug('[Telegram] Alerts enabled but missing token or chat ID');
    return { sent: false, type: null };
  }

  // Check which prices are green using user-configured thresholds
  const { fuelGreen, co2Green } = checkGreenPrices(fuelPrice, co2Price, settings);

  if (!fuelGreen && !co2Green) {
    return { sent: false, type: null };
  }

  const now = Date.now();
  const lastFuelAlert = settings.telegramLastFuelAlert || 0;
  const lastCO2Alert = settings.telegramLastCO2Alert || 0;

  // Check cooldowns
  const canAlertFuel = fuelGreen && (now - lastFuelAlert > ALERT_COOLDOWN_MS);
  const canAlertCO2 = co2Green && (now - lastCO2Alert > ALERT_COOLDOWN_MS);

  if (!canAlertFuel && !canAlertCO2) {
    logger.debug('[Telegram] Prices are green but still in cooldown');
    return { sent: false, type: null };
  }

  // Decrypt bot token
  let botToken = settings.telegramBotToken;
  if (botToken && botToken.startsWith('KEYRING:')) {
    botToken = await decryptData(botToken);
    if (!botToken) {
      logger.error('[Telegram] Failed to decrypt bot token');
      return { sent: false, type: null };
    }
  }

  // Build message
  let message = '';
  let alertType = '';

  if (canAlertFuel && canAlertCO2) {
    // Both prices are green
    message = `*Great news, Captain!*\n\nBoth fuel and CO2 prices are looking fantastic right now!\n\nFuel: *$${fuelPrice}/t*\nCO2: *$${co2Price}/t*\n\nTime to stock up!`;
    alertType = 'both';
  } else if (canAlertFuel) {
    message = `*Ahoy, Captain!*\n\nFuel prices have dropped to a great level!\n\nFuel: *$${fuelPrice}/t*\n\nMight be a good time to fill up your tanks!`;
    alertType = 'fuel';
  } else if (canAlertCO2) {
    message = `*Ahoy, Captain!*\n\nCO2 certificate prices are looking good!\n\nCO2: *$${co2Price}/t*\n\nA fine opportunity to stock up on certificates!`;
    alertType = 'co2';
  }

  // Send message
  const success = await sendTelegramMessage(botToken, settings.telegramChatId, message);

  // Log sent message to console
  if (success) {
    logger.info(`[Telegram] Message sent to chat ${settings.telegramChatId}:`);
    logger.info(`[Telegram] ${message.replace(/\*/g, '')}`); // Remove markdown for console
  }

  if (success && updateSettings) {
    // Update cooldown timestamps
    const updates = {};
    if (canAlertFuel) updates.telegramLastFuelAlert = now;
    if (canAlertCO2) updates.telegramLastCO2Alert = now;

    try {
      await updateSettings(updates);
    } catch (error) {
      logger.error(`[Telegram] Failed to update cooldown timestamps: ${error.message}`);
    }
  }

  return { sent: success, type: alertType };
}

/**
 * Test Telegram connection by sending a test message
 *
 * @param {string} botToken - Bot token (may be encrypted)
 * @param {string} chatId - Chat ID
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function testTelegramConnection(botToken, chatId) {
  if (!botToken || !chatId) {
    return { success: false, error: 'Missing bot token or chat ID' };
  }

  // Decrypt if needed
  let token = botToken;
  if (token.startsWith('KEYRING:')) {
    token = await decryptData(token);
    if (!token) {
      return { success: false, error: 'Failed to decrypt bot token' };
    }
  }

  const message = `*Test Message*\n\nYour Telegram alerts are configured correctly!\n\nYou will receive notifications when fuel or CO2 prices drop to green levels.`;

  const success = await sendTelegramMessage(token, chatId, message);

  return {
    success,
    error: success ? null : 'Failed to send message. Check your bot token and chat ID.'
  };
}

module.exports = {
  sendTelegramMessage,
  checkGreenPrices,
  sendPriceAlert,
  testTelegramConnection,
  ALERT_COOLDOWN_MS
};
