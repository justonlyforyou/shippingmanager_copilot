/**
 * @fileoverview Messenger Auto-Refresh Logic
 *
 * Manages automatic polling of messenger inbox and broadcasting unread counts to clients.
 * Includes ChatBot DM command processing.
 *
 * @module server/websocket/messenger-refresh
 */

const { apiCall, getUserId } = require('../utils/api');
const logger = require('../utils/logger');
const { broadcast } = require('./broadcaster');
const { getCachedMessengerChats } = require('./messenger-cache');
const {
  processedMessageIds,
  getProcessedMessageIds,
  loadProcessedMessageCache,
  saveProcessedMessageCache
} = require('./message-cache');
const {
  loadMessengerCache,
  updateChatList,
  updateChatMessages,
  getCachedChatMessages
} = require('./messenger-content-cache');

/**
 * Interval timer for automatic messenger refresh (15-second polling)
 * @type {NodeJS.Timeout|null}
 */
let messengerRefreshInterval = null;

/**
 * Flag to prevent overlapping messenger refresh requests.
 * @type {boolean}
 */
let isMessengerRefreshing = false;

/**
 * Performs a single messenger refresh cycle.
 * Fetches unread messages, broadcasts to clients, and processes DM commands with ChatBot.
 * Uses module-level isMessengerRefreshing flag to prevent overlapping requests.
 *
 * @async
 * @function performMessengerRefresh
 * @returns {Promise<void>}
 */
async function performMessengerRefresh() {
  // Skip if previous refresh is still running
  if (isMessengerRefreshing) {
    logger.debug('[Messenger Refresh] Skipping - previous request still running');
    return;
  }

  isMessengerRefreshing = true;

  try {
    const userId = getUserId();
    if (!userId) {
      logger.error('[Messenger Refresh] No user ID available');
      isMessengerRefreshing = false;
      return;
    }

    // Load processed messages cache for this user if not already loaded
    if (!processedMessageIds.has(String(userId))) {
      loadProcessedMessageCache(userId);
    }

    // Load messenger content cache for this user
    loadMessengerCache(userId);

    // Fetch messenger chats (using shared cache to reduce API calls)
    const chats = await getCachedMessengerChats();

    // Update chat list cache for instant loading
    updateChatList(userId, chats);

    // Count unread messages (messages with 'new' flag)
    // Exclude hijacking messages - they go to Blackbeard's Phone Booth
    const unreadCount = chats.filter(chat => {
      if (!chat.new) return false;
      // Exclude hijacking system messages
      if (chat.system_chat && chat.body === 'vessel_got_hijacked') {
        return false;
      }
      return true;
    }).length;

    // Broadcast unread count to all clients
    broadcast('messenger_update', {
      messages: unreadCount,
      chats: chats.length
    });

    // Pre-fetch and cache messages for unread chats (background caching)
    // This ensures messages are ready when user opens the chat
    const unreadChats = chats.filter(chat => chat.new && !chat.system_chat);
    for (const chat of unreadChats) {
      try {
        // Check if we already have this chat cached with same message count
        const cached = getCachedChatMessages(userId, chat.id);
        if (cached && cached.messages.length >= (chat.message_count || 0)) {
          continue; // Already cached and up to date
        }

        // Fetch messages for this chat
        const messagesData = await apiCall('/messenger/get-chat', 'POST', {
          chat_id: chat.id
        });

        const messages = messagesData?.data?.chat?.messages || messagesData?.data?.messages;

        if (messages && messages.length > 0) {
          // Cache the messages
          updateChatMessages(userId, chat.id, messages, {
            subject: chat.subject,
            participants: chat.participants_string,
            isNew: chat.new,
            isSystemChat: chat.system_chat
          });

          logger.debug(`[Messenger Cache] Pre-cached ${messages.length} messages for chat ${chat.id}`);
        }
      } catch (error) {
        logger.error(`[Messenger Cache] Error pre-caching chat ${chat.id}:`, error.message);
      }
    }

    // Process chats with ChatBot - Check ONLY UNREAD chats to reduce API spam
    // The processedMessageIds cache ensures we don't reply twice to the same message
    for (const chat of chats) {
      // Skip system chats
      if (chat.system_chat) continue;

      // CRITICAL: Only check unread chats to reduce API calls
      // Without this check, we'd fetch /messenger/get-chat for EVERY chat (10+ chats = 10+ API calls every 15 seconds!)
      if (!chat.new) continue;

      try {
        // Check if we already have this chat cached (from pre-fetch above)
        let messages;
        const cached = getCachedChatMessages(userId, chat.id);

        if (cached && cached.messages) {
          // Use cached messages
          messages = cached.messages;
        } else {
          // Fetch messages for this chat
          const messagesData = await apiCall('/messenger/get-chat', 'POST', {
            chat_id: chat.id
          });

          messages = messagesData?.data?.chat?.messages || messagesData?.data?.messages;

          // Cache the messages for future use
          if (messages && messages.length > 0) {
            updateChatMessages(userId, chat.id, messages, {
              subject: chat.subject,
              participants: chat.participants_string,
              isNew: chat.new,
              isSystemChat: chat.system_chat
            });
          }
        }

        // Find the latest message from the sender (not from us)
        const senderMessages = messages.filter(msg => msg.is_mine === false).reverse();

        if (senderMessages.length === 0) {
          continue; // No messages from sender
        }

        // IMPORTANT: Only process the LATEST message, even if multiple are unread
        // This prevents duplicate replies if user sends same command multiple times
        const latestMessage = senderMessages[0];

        // Create unique identifier
        const messageIdentifier = `${chat.id}_${latestMessage.created_at}`;

        // Check if we've already processed this message
        const userProcessedIds = getProcessedMessageIds(userId);
        if (userProcessedIds.has(messageIdentifier)) {
          continue; // Already replied to this message
        }

        // Only log if chat is unread (to reduce spam in logs)
        if (chat.new) {
          logger.info(`[Messenger] New DM from ${chat.participants_string}: "${latestMessage.body || chat.subject}"`);
        }

        // Process with ChatBot - lazy-loaded to avoid circular dependency
        const chatBot = require('../chatbot');
        const wasProcessed = await chatBot.processPrivateMessage(
          messageIdentifier,
          latestMessage.body || '',
          latestMessage.user_id,
          chat.participants_string
        );

        // Only add to processed cache if bot actually handled the message
        if (wasProcessed) {
          userProcessedIds.add(messageIdentifier);
          saveProcessedMessageCache(userId);
          logger.info(`[Messenger] Bot replied and cached: ${messageIdentifier}`);
        } else {
          // Add to cache even if not processed, so we don't spam logs every polling cycle
          userProcessedIds.add(messageIdentifier);
          saveProcessedMessageCache(userId);
          logger.debug(`[Messenger] Message ignored (not a valid command): ${messageIdentifier}`);
        }

      } catch (error) {
        logger.error(`[Messenger] Error processing chat ${chat.id}:`, error.message);
      }
    }

    // Log only in debug mode
    if (unreadCount > 0) {
      logger.debug(`[Messenger] ${unreadCount} unread messages detected`);
    } else {
      logger.debug(`[Messenger] Poll complete: 0 unread messages`);
    }
  } catch (error) {
    // Only log non-timeout errors
    if (!error.message.includes('socket hang up') && !error.message.includes('ECONNRESET')) {
      logger.error('[Messenger] Error:', error.message);
    }
  } finally {
    isMessengerRefreshing = false; // Always release the lock
  }
}

/**
 * Messenger polling is now handled by startChatAutoRefresh() to run simultaneously.
 * This function is kept for backwards compatibility but does nothing.
 * Both chat and messenger refresh happen together in the same 20-second interval.
 *
 * @function startMessengerAutoRefresh
 * @returns {void}
 */
function startMessengerAutoRefresh() {
  // Messenger refresh now runs together with chat refresh in startChatAutoRefresh()
  // No separate interval needed - both APIs are called simultaneously
  logger.info('[Messenger] Messenger polling synchronized with chat polling (20s interval)');
}

/**
 * Triggers an immediate messenger refresh after a short delay.
 * Used by ChatBot to immediately broadcast DM responses without waiting for next polling cycle.
 *
 * The 3-second delay ensures the Game API has time to persist the message before we fetch it.
 * This prevents race conditions where we fetch before the message is saved.
 *
 * Safe to call multiple times - the isMessengerRefreshing flag prevents overlapping requests.
 *
 * @function triggerImmediateMessengerRefresh
 * @returns {void}
 *
 * @example
 * // After sending a DM response
 * await sendPrivateMessage(userId, subject, response);
 * triggerImmediateMessengerRefresh(); // Client will see response in ~3 seconds instead of up to 10s
 */
function triggerImmediateMessengerRefresh() {
  logger.debug('[Messenger Refresh] Immediate refresh triggered - will execute in 3 seconds');
  setTimeout(async () => {
    await performMessengerRefresh();
  }, 3000); // 3-second delay to allow Game API to persist the message
}

/**
 * Stops the automatic messenger polling and clears the interval timer.
 *
 * @function stopMessengerAutoRefresh
 * @returns {void}
 */
function stopMessengerAutoRefresh() {
  if (messengerRefreshInterval) {
    clearInterval(messengerRefreshInterval);
    messengerRefreshInterval = null;
  }
}

module.exports = {
  performMessengerRefresh,
  startMessengerAutoRefresh,
  triggerImmediateMessengerRefresh,
  stopMessengerAutoRefresh
};
