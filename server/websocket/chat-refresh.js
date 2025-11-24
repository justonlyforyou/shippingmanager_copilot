/**
 * @fileoverview Alliance Chat Auto-Refresh Logic
 *
 * Manages automatic polling of alliance chat feed and broadcasting updates to clients.
 * Includes ChatBot message processing for new messages.
 *
 * @module server/websocket/chat-refresh
 */

const { getChatFeed, getCompanyName, getAllianceId } = require('../utils/api');
const config = require('../config');
const logger = require('../utils/logger');
const { broadcast } = require('./broadcaster');

/**
 * Interval timer for automatic chat refresh (25-second polling)
 * @type {NodeJS.Timeout|null}
 */
let chatRefreshInterval = null;

/**
 * Flag to prevent overlapping chat refresh requests.
 * @type {boolean}
 */
let isChatRefreshing = false;

/**
 * Timestamp of last processed message (Unix timestamp in seconds).
 * Used to detect new messages for ChatBot processing.
 * @type {number}
 */
let lastProcessedMessageTime = Date.now() / 1000;

/**
 * Set of processed alliance message keys to prevent duplicate processing.
 * Key format: "userId_timeCreated_messageHash"
 * @type {Set<string>}
 */
const processedAllianceMessages = new Set();

/**
 * Maximum size of processedAllianceMessages set before cleanup.
 * @type {number}
 */
const MAX_PROCESSED_MESSAGES = 500;

/**
 * Reference to performMessengerRefresh function (set by main websocket.js)
 * @type {Function|null}
 */
let messengerRefreshFn = null;

/**
 * Sets the messenger refresh function reference.
 * Called by main websocket.js to avoid circular dependency.
 *
 * @param {Function} fn - performMessengerRefresh function
 */
function setMessengerRefreshFn(fn) {
  messengerRefreshFn = fn;
}

/**
 * Performs a single chat refresh cycle.
 * Fetches latest chat messages, broadcasts to clients, and processes with ChatBot.
 * Uses module-level isChatRefreshing flag to prevent overlapping requests.
 *
 * @async
 * @function performChatRefresh
 * @returns {Promise<void>}
 */
async function performChatRefresh() {
  if (!getAllianceId()) {
    return;
  }

  // Skip if previous refresh is still running
  if (isChatRefreshing) {
    logger.debug('[Chat Refresh] Skipping - previous request still running');
    return;
  }

  isChatRefreshing = true;

  try {
    const feed = await getChatFeed();
    const messages = [];
    let hasNewMessages = false;

    for (const msg of feed) {
      if (msg.type === 'chat') {
        const companyName = await getCompanyName(msg.user_id);
        const timestamp = new Date(msg.time_created * 1000).toUTCString();
        messages.push({
          type: 'chat',
          company: companyName,
          message: msg.message,
          timestamp: timestamp,
          user_id: msg.user_id
        });

        // Check if this is a new message for ChatBot processing
        // Use unique key to prevent duplicate processing (no message_id in API)
        const messageKey = `${msg.user_id}_${msg.time_created}_${msg.message.substring(0, 50)}`;

        if (msg.time_created > lastProcessedMessageTime && !processedAllianceMessages.has(messageKey)) {
          hasNewMessages = true;

          // Mark as processed BEFORE calling handler to prevent race conditions
          processedAllianceMessages.add(messageKey);

          // Cleanup old entries if set is too large
          if (processedAllianceMessages.size > MAX_PROCESSED_MESSAGES) {
            const entries = Array.from(processedAllianceMessages);
            entries.slice(0, 100).forEach(key => processedAllianceMessages.delete(key));
          }

          // Process with ChatBot (async, don't await) - lazy-loaded to avoid circular dependency
          const chatBot = require('../chatbot');
          chatBot.processAllianceMessage(msg.message, msg.user_id, companyName)
            .catch(err => logger.error('[ChatBot] Error processing alliance message:', err));
        }
      } else if (msg.type === 'feed') {
        const timestamp = new Date(msg.time_created * 1000).toUTCString();
        messages.push({
          type: 'feed',
          feedType: msg.feed_type,
          company: msg.replacements.company_name,
          timestamp: timestamp
        });
      }
    }

    // Update last processed time if we had new messages
    if (hasNewMessages) {
      lastProcessedMessageTime = Date.now() / 1000;
    }

    // Get wss for client count check
    const { getWebSocketServer } = require('./broadcaster');
    const wss = getWebSocketServer();

    if (messages.length > 0 || (wss && wss.clients.size > 0)) {
      broadcast('chat_update', messages);
    }
  } catch (error) {
    // Only log non-timeout errors
    if (!error.message.includes('socket hang up') && !error.message.includes('ECONNRESET')) {
      logger.error('[Chat Refresh] Error:', error.message);
    }
  } finally {
    isChatRefreshing = false; // Always release the lock
  }
}

/**
 * Starts automatic chat refresh polling at configured interval (default: 20 seconds).
 * Calls performChatRefresh() on each cycle.
 * Chat and messenger polls run simultaneously in the same interval to reduce API load.
 *
 * @function startChatAutoRefresh
 * @returns {void}
 */
function startChatAutoRefresh() {
  chatRefreshInterval = setInterval(async () => {
    // Run chat and messenger refresh in parallel
    const refreshPromises = [performChatRefresh()];
    if (messengerRefreshFn) {
      refreshPromises.push(messengerRefreshFn());
    }
    await Promise.all(refreshPromises);
  }, config.CHAT_REFRESH_INTERVAL);
}

/**
 * Triggers an immediate chat refresh after a short delay.
 * Used by ChatBot to immediately broadcast bot responses without waiting for next polling cycle.
 *
 * The 3-second delay ensures the Game API has time to persist the message before we fetch it.
 * This prevents race conditions where we fetch before the message is saved.
 *
 * Safe to call multiple times - the isChatRefreshing flag prevents overlapping requests.
 *
 * @function triggerImmediateChatRefresh
 * @returns {void}
 *
 * @example
 * // After sending a bot response
 * await sendAllianceMessage(response);
 * triggerImmediateChatRefresh(); // Clients will see response in ~3 seconds instead of up to 25s
 */
function triggerImmediateChatRefresh() {
  logger.debug('[Chat Refresh] Immediate refresh triggered - will execute in 3 seconds');
  setTimeout(async () => {
    await performChatRefresh();
  }, 3000); // 3-second delay to allow Game API to persist the message
}

/**
 * Stops the automatic chat feed polling and clears the interval timer.
 *
 * This function provides a clean shutdown mechanism for the chat auto-refresh feature.
 * It's primarily used during server shutdown or when temporarily disabling automatic updates.
 *
 * Why This Matters:
 * - Prevents interval from continuing after server shutdown
 * - Cleans up resources properly to avoid memory leaks
 * - Allows pausing auto-refresh without restarting server
 * - Sets interval reference to null for garbage collection
 *
 * Use Cases:
 * - Server graceful shutdown (SIGTERM/SIGINT handlers)
 * - Temporarily disabling auto-refresh for maintenance
 * - Reconfiguring refresh interval (stop, then restart with new interval)
 *
 * Side Effects:
 * - Clears the setInterval timer
 * - Sets chatRefreshInterval to null
 * - No more automatic broadcasts until startChatAutoRefresh() called again
 *
 * @function stopChatAutoRefresh
 * @returns {void}
 *
 * @example
 * // During server shutdown
 * process.on('SIGTERM', () => {
 *   console.log('Shutting down server...');
 *   stopChatAutoRefresh();
 *   server.close();
 * });
 *
 * @example
 * // Reconfiguring refresh interval
 * stopChatAutoRefresh();
 * config.CHAT_REFRESH_INTERVAL = 30000; // Change to 30 seconds
 * startChatAutoRefresh();
 */
function stopChatAutoRefresh() {
  if (chatRefreshInterval) {
    clearInterval(chatRefreshInterval);
    chatRefreshInterval = null;
  }
}

module.exports = {
  performChatRefresh,
  startChatAutoRefresh,
  triggerImmediateChatRefresh,
  stopChatAutoRefresh,
  setMessengerRefreshFn
};
