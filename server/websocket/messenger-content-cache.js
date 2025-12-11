/**
 * @fileoverview Messenger Content Cache
 *
 * Local file-based cache for messenger message content.
 * Stores full message history per chat to enable instant loading.
 *
 * Cache Strategy:
 * - Messages are cached when WebSocket refresh detects new messages
 * - Cache is updated in background, not blocking UI
 * - When user opens a chat, messages load from cache instantly
 * - Fresh data is fetched only if cache is empty or stale
 *
 * @module server/websocket/messenger-content-cache
 */

const fs = require('fs');
const path = require('path');
const { getAppBaseDir } = require('../config');
const logger = require('../utils/logger');

/**
 * In-memory cache of all chats and messages
 * Synced to disk periodically and on updates
 * @type {{ chats: Object, lastSync: number, userId: string|null }}
 */
let memoryCache = {
  chats: {},      // { chatId: { messages: [], metadata: {}, lastUpdated: timestamp } }
  chatList: [],   // Full chat list from /messenger/get-chats
  chatListUpdated: 0,
  lastSync: 0,
  userId: null
};

/**
 * Flag to track if cache has unsaved changes
 * @type {boolean}
 */
let isDirty = false;

/**
 * Minimum time between disk syncs (5 seconds)
 * @constant {number}
 */
const SYNC_DEBOUNCE_MS = 5000;

/**
 * Get cache file path for messenger content
 * @param {string|number} userId - User ID
 * @returns {string} Path to user-specific messenger cache file
 */
function getMessengerCachePath(userId) {
  const { isPackaged } = require('../config');
  const isPkg = isPackaged();
  return isPkg
    ? path.join(getAppBaseDir(), 'userdata', 'messenger', `content-cache-${userId}.json`)
    : path.join(__dirname, '..', '..', 'userdata', 'messenger', `content-cache-${userId}.json`);
}

/**
 * Ensure messenger cache directory exists
 * @param {string|number} userId - User ID
 */
function ensureCacheDir(userId) {
  const cachePath = getMessengerCachePath(userId);
  const cacheDir = path.dirname(cachePath);

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    logger.debug(`[Messenger Cache] Created cache directory: ${cacheDir}`);
  }
}

/**
 * Load messenger cache from disk into memory
 * @param {string|number} userId - User ID
 */
function loadMessengerCache(userId) {
  const userIdStr = String(userId);

  // Already loaded for this user
  if (memoryCache.userId === userIdStr && Object.keys(memoryCache.chats).length > 0) {
    return;
  }

  try {
    ensureCacheDir(userId);
    const cachePath = getMessengerCachePath(userId);

    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(data);

      memoryCache = {
        chats: parsed.chats || {},
        chatList: parsed.chatList || [],
        chatListUpdated: parsed.chatListUpdated || 0,
        lastSync: parsed.lastSync || 0,
        userId: userIdStr
      };

      const chatCount = Object.keys(memoryCache.chats).length;
      logger.info(`[Messenger Cache] Loaded ${chatCount} cached chats for user ${userId}`);
    } else {
      memoryCache = {
        chats: {},
        chatList: [],
        chatListUpdated: 0,
        lastSync: 0,
        userId: userIdStr
      };
      logger.debug(`[Messenger Cache] No cache file found for user ${userId}, starting fresh`);
    }
  } catch (error) {
    logger.error(`[Messenger Cache] Error loading cache for user ${userId}:`, error.message);
    memoryCache = {
      chats: {},
      chatList: [],
      chatListUpdated: 0,
      lastSync: 0,
      userId: userIdStr
    };
  }
}

/**
 * Save messenger cache to disk (debounced)
 * @param {string|number} userId - User ID
 * @param {boolean} force - Force immediate save
 */
function saveMessengerCache(userId, force = false) {
  isDirty = true;

  const now = Date.now();
  if (!force && (now - memoryCache.lastSync) < SYNC_DEBOUNCE_MS) {
    // Debounce - will be saved on next call or forced save
    return;
  }

  try {
    ensureCacheDir(userId);
    const cachePath = getMessengerCachePath(userId);

    memoryCache.lastSync = now;
    fs.writeFileSync(cachePath, JSON.stringify(memoryCache, null, 2));
    isDirty = false;

    logger.debug(`[Messenger Cache] Saved cache for user ${userId}`);
  } catch (error) {
    logger.error(`[Messenger Cache] Error saving cache for user ${userId}:`, error.message);
  }
}

/**
 * Update cached chat list (from /messenger/get-chats)
 * @param {string|number} userId - User ID
 * @param {Array} chatList - Array of chat objects
 */
function updateChatList(userId, chatList) {
  loadMessengerCache(userId);

  memoryCache.chatList = chatList;
  memoryCache.chatListUpdated = Date.now();

  saveMessengerCache(userId);
  logger.debug(`[Messenger Cache] Updated chat list: ${chatList.length} chats`);
}

/**
 * Get cached chat list
 * @param {string|number} userId - User ID
 * @returns {{ chatList: Array, updatedAt: number }} Cached chat list and timestamp
 */
function getCachedChatList(userId) {
  loadMessengerCache(userId);

  return {
    chatList: memoryCache.chatList,
    updatedAt: memoryCache.chatListUpdated
  };
}

/**
 * Update cached messages for a specific chat
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 * @param {Array} messages - Array of message objects
 * @param {Object} metadata - Chat metadata (subject, participants, etc.)
 */
function updateChatMessages(userId, chatId, messages, metadata = {}) {
  loadMessengerCache(userId);

  const chatIdStr = String(chatId);

  memoryCache.chats[chatIdStr] = {
    messages: messages,
    metadata: metadata,
    lastUpdated: Date.now()
  };

  saveMessengerCache(userId);
  logger.debug(`[Messenger Cache] Updated chat ${chatId}: ${messages.length} messages`);
}

/**
 * Get cached messages for a specific chat
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 * @returns {{ messages: Array, metadata: Object, lastUpdated: number }|null} Cached chat data or null
 */
function getCachedChatMessages(userId, chatId) {
  loadMessengerCache(userId);

  const chatIdStr = String(chatId);
  const cached = memoryCache.chats[chatIdStr];

  if (cached) {
    logger.debug(`[Messenger Cache] Cache HIT for chat ${chatId} (${cached.messages.length} messages)`);
    return cached;
  }

  logger.debug(`[Messenger Cache] Cache MISS for chat ${chatId}`);
  return null;
}

/**
 * Check if a chat has new messages compared to cache
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 * @param {number} messageCount - Current message count from chat list
 * @returns {boolean} True if there are new messages
 */
function hasNewMessages(userId, chatId, messageCount) {
  loadMessengerCache(userId);

  const chatIdStr = String(chatId);
  const cached = memoryCache.chats[chatIdStr];

  if (!cached) {
    return true; // No cache = definitely new
  }

  // Compare message counts
  return cached.messages.length < messageCount;
}

/**
 * Mark a chat as read in cache (update metadata)
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 */
function markChatAsReadInCache(userId, chatId) {
  loadMessengerCache(userId);

  const chatIdStr = String(chatId);
  if (memoryCache.chats[chatIdStr]) {
    memoryCache.chats[chatIdStr].metadata.isNew = false;
    saveMessengerCache(userId);
  }

  // Also update chat list
  const chatInList = memoryCache.chatList.find(c => String(c.id) === chatIdStr);
  if (chatInList) {
    chatInList.new = false;
    saveMessengerCache(userId);
  }
}

/**
 * Delete a chat from cache
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 */
function deleteChatFromCache(userId, chatId) {
  loadMessengerCache(userId);

  const chatIdStr = String(chatId);
  delete memoryCache.chats[chatIdStr];

  // Also remove from chat list
  memoryCache.chatList = memoryCache.chatList.filter(c => String(c.id) !== chatIdStr);

  saveMessengerCache(userId, true); // Force immediate save
  logger.debug(`[Messenger Cache] Deleted chat ${chatId} from cache`);
}

/**
 * Get cache statistics
 * @param {string|number} userId - User ID
 * @returns {Object} Cache stats
 */
function getCacheStats(userId) {
  loadMessengerCache(userId);

  const chatCount = Object.keys(memoryCache.chats).length;
  let totalMessages = 0;

  for (const chatId in memoryCache.chats) {
    totalMessages += memoryCache.chats[chatId].messages.length;
  }

  return {
    chatCount,
    totalMessages,
    chatListSize: memoryCache.chatList.length,
    chatListAge: Date.now() - memoryCache.chatListUpdated,
    lastSync: memoryCache.lastSync
  };
}

/**
 * Force save any pending changes (call on shutdown)
 * @param {string|number} userId - User ID
 */
function flushCache(userId) {
  if (isDirty) {
    saveMessengerCache(userId, true);
    logger.info(`[Messenger Cache] Flushed cache for user ${userId}`);
  }
}

module.exports = {
  loadMessengerCache,
  saveMessengerCache,
  updateChatList,
  getCachedChatList,
  updateChatMessages,
  getCachedChatMessages,
  hasNewMessages,
  markChatAsReadInCache,
  deleteChatFromCache,
  getCacheStats,
  flushCache,
  getMessengerCachePath
};
