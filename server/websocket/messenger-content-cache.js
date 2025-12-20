/**
 * @fileoverview Messenger Content Cache (SQLite)
 *
 * SQLite-based cache for messenger message content.
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

const { getDb } = require('../database');
const logger = require('../utils/logger');

/**
 * In-memory cache for chat list (frequently accessed)
 * @type {{ chatList: Array, chatListUpdated: number, userId: string|null }}
 */
let chatListCache = {
  chatList: [],
  chatListUpdated: 0,
  userId: null
};

/**
 * Load chat list from SQLite into memory
 * @param {string|number} userId - User ID
 */
function loadChatListFromDb(userId) {
  const userIdStr = String(userId);

  if (chatListCache.userId === userIdStr && chatListCache.chatList.length > 0) {
    return;
  }

  try {
    const db = getDb(userIdStr);
    const rows = db.prepare('SELECT * FROM messenger_chats ORDER BY last_message_at DESC').all();

    chatListCache = {
      chatList: rows.map(row => ({
        id: row.chat_id,
        subject: row.subject,
        new: row.is_new === 1,
        message_count: row.message_count,
        last_message_at: row.last_message_at,
        ...(row.metadata_json ? JSON.parse(row.metadata_json) : {})
      })),
      chatListUpdated: Date.now(),
      userId: userIdStr
    };

    logger.debug(`[Messenger Cache] Loaded ${rows.length} chats from SQLite for user ${userId}`);
  } catch (error) {
    logger.error(`[Messenger Cache] Error loading chats from SQLite for user ${userId}:`, error.message);
    chatListCache = {
      chatList: [],
      chatListUpdated: 0,
      userId: userIdStr
    };
  }
}

/**
 * Update cached chat list (from /messenger/get-chats)
 * @param {string|number} userId - User ID
 * @param {Array} chatList - Array of chat objects
 */
function updateChatList(userId, chatList) {
  const userIdStr = String(userId);

  try {
    const db = getDb(userIdStr);

    const upsertChat = db.prepare(`
      INSERT INTO messenger_chats (chat_id, subject, is_new, message_count, last_message_at, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        subject = excluded.subject,
        is_new = excluded.is_new,
        message_count = COALESCE(excluded.message_count, messenger_chats.message_count),
        last_message_at = COALESCE(excluded.last_message_at, messenger_chats.last_message_at),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);

    const updateMany = db.transaction((chats) => {
      for (const chat of chats) {
        upsertChat.run(
          chat.id,
          chat.subject,
          chat.new ? 1 : 0,
          chat.message_count,
          chat.last_message_at,
          JSON.stringify(chat),
          Math.floor(Date.now() / 1000)
        );
      }
    });

    updateMany(chatList);

    // Update memory cache
    chatListCache = {
      chatList: chatList,
      chatListUpdated: Date.now(),
      userId: userIdStr
    };

    logger.debug(`[Messenger Cache] Updated chat list: ${chatList.length} chats`);
  } catch (error) {
    logger.error(`[Messenger Cache] Error updating chat list in SQLite:`, error.message);
  }
}

/**
 * Get cached chat list
 * @param {string|number} userId - User ID
 * @returns {{ chatList: Array, updatedAt: number }} Cached chat list and timestamp
 */
function getCachedChatList(userId) {
  loadChatListFromDb(userId);

  return {
    chatList: chatListCache.chatList,
    updatedAt: chatListCache.chatListUpdated
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
  const userIdStr = String(userId);
  const chatIdNum = parseInt(chatId, 10);

  try {
    const db = getDb(userIdStr);

    // Find last message timestamp
    let lastMessageAt = 0;
    if (messages.length > 0) {
      lastMessageAt = Math.max(...messages.map(m => m.created_at || 0));
    }

    // Update chat metadata
    db.prepare(`
      INSERT INTO messenger_chats (chat_id, subject, is_new, message_count, last_message_at, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        subject = COALESCE(excluded.subject, messenger_chats.subject),
        is_new = excluded.is_new,
        message_count = excluded.message_count,
        last_message_at = excluded.last_message_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      chatIdNum,
      metadata.subject,
      metadata.isNew ? 1 : 0,
      messages.length,
      lastMessageAt,
      JSON.stringify(metadata),
      Math.floor(Date.now() / 1000)
    );

    // Insert messages
    const insertMessage = db.prepare(`
      INSERT OR IGNORE INTO messenger_messages (chat_id, body, is_mine, sender_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((msgs) => {
      for (const msg of msgs) {
        insertMessage.run(
          chatIdNum,
          msg.body,
          msg.is_mine ? 1 : 0,
          msg.user_id,
          msg.created_at
        );
      }
    });

    insertMany(messages);

    logger.debug(`[Messenger Cache] Updated chat ${chatId}: ${messages.length} messages`);
  } catch (error) {
    logger.error(`[Messenger Cache] Error updating chat ${chatId} in SQLite:`, error.message);
  }
}

/**
 * Get cached messages for a specific chat
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 * @returns {{ messages: Array, metadata: Object, lastUpdated: number }|null} Cached chat data or null
 */
function getCachedChatMessages(userId, chatId) {
  const userIdStr = String(userId);
  const chatIdNum = parseInt(chatId, 10);

  try {
    const db = getDb(userIdStr);

    // Get chat metadata
    const chatRow = db.prepare('SELECT * FROM messenger_chats WHERE chat_id = ?').get(chatIdNum);
    if (!chatRow) {
      logger.debug(`[Messenger Cache] Cache MISS for chat ${chatId}`);
      return null;
    }

    // Get messages
    const messageRows = db.prepare('SELECT * FROM messenger_messages WHERE chat_id = ? ORDER BY created_at ASC').all(chatIdNum);

    const result = {
      messages: messageRows.map(row => ({
        body: row.body,
        is_mine: row.is_mine === 1,
        user_id: row.sender_user_id,
        created_at: row.created_at
      })),
      metadata: chatRow.metadata_json ? JSON.parse(chatRow.metadata_json) : {},
      lastUpdated: chatRow.updated_at * 1000
    };

    logger.debug(`[Messenger Cache] Cache HIT for chat ${chatId} (${result.messages.length} messages)`);
    return result;
  } catch (error) {
    logger.error(`[Messenger Cache] Error getting chat ${chatId} from SQLite:`, error.message);
    return null;
  }
}

/**
 * Check if a chat has new messages compared to cache
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 * @param {number} messageCount - Current message count from chat list
 * @returns {boolean} True if there are new messages
 */
function hasNewMessages(userId, chatId, messageCount) {
  const userIdStr = String(userId);
  const chatIdNum = parseInt(chatId, 10);

  try {
    const db = getDb(userIdStr);
    const row = db.prepare('SELECT message_count FROM messenger_chats WHERE chat_id = ?').get(chatIdNum);

    if (!row) {
      return true; // No cache = definitely new
    }

    return row.message_count < messageCount;
  } catch (error) {
    logger.debug(`[Messenger Cache] Error checking new messages for chat ${chatId}:`, error.message);
    return true;
  }
}

/**
 * Mark a chat as read in cache (update metadata)
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 */
function markChatAsReadInCache(userId, chatId) {
  const userIdStr = String(userId);
  const chatIdNum = parseInt(chatId, 10);

  try {
    const db = getDb(userIdStr);
    db.prepare('UPDATE messenger_chats SET is_new = 0 WHERE chat_id = ?').run(chatIdNum);

    // Update memory cache
    const chatInList = chatListCache.chatList.find(c => c.id === chatIdNum);
    if (chatInList) {
      chatInList.new = false;
    }
  } catch (error) {
    logger.error(`[Messenger Cache] Error marking chat ${chatId} as read:`, error.message);
  }
}

/**
 * Delete a chat from cache
 * @param {string|number} userId - User ID
 * @param {string|number} chatId - Chat ID
 */
function deleteChatFromCache(userId, chatId) {
  const userIdStr = String(userId);
  const chatIdNum = parseInt(chatId, 10);

  try {
    const db = getDb(userIdStr);

    // Delete messages first (foreign key)
    db.prepare('DELETE FROM messenger_messages WHERE chat_id = ?').run(chatIdNum);
    // Delete chat
    db.prepare('DELETE FROM messenger_chats WHERE chat_id = ?').run(chatIdNum);

    // Update memory cache
    chatListCache.chatList = chatListCache.chatList.filter(c => c.id !== chatIdNum);

    logger.debug(`[Messenger Cache] Deleted chat ${chatId} from cache`);
  } catch (error) {
    logger.error(`[Messenger Cache] Error deleting chat ${chatId}:`, error.message);
  }
}

/**
 * Get cache statistics
 * @param {string|number} userId - User ID
 * @returns {Object} Cache stats
 */
function getCacheStats(userId) {
  const userIdStr = String(userId);

  try {
    const db = getDb(userIdStr);

    const chatCount = db.prepare('SELECT COUNT(*) as count FROM messenger_chats').get();
    const messageCount = db.prepare('SELECT COUNT(*) as count FROM messenger_messages').get();

    return {
      chatCount: chatCount.count,
      totalMessages: messageCount.count,
      chatListSize: chatListCache.chatList.length,
      chatListAge: Date.now() - chatListCache.chatListUpdated,
      lastSync: chatListCache.chatListUpdated
    };
  } catch (error) {
    logger.error(`[Messenger Cache] Error getting cache stats:`, error.message);
    return {
      chatCount: 0,
      totalMessages: 0,
      chatListSize: 0,
      chatListAge: 0,
      lastSync: 0
    };
  }
}

/**
 * Load messenger cache from disk into memory (compatibility - now loads from SQLite)
 * @param {string|number} userId - User ID
 */
function loadMessengerCache(userId) {
  loadChatListFromDb(userId);
}

// Legacy path function (for migration detection only)
const path = require('path');
const { getAppBaseDir, isPackaged } = require('../config');
const isPkg = isPackaged();

function getMessengerCachePath(userId) {
  return isPkg
    ? path.join(getAppBaseDir(), 'userdata', 'messenger', `content-cache-${userId}.json`)
    : path.join(__dirname, '..', '..', 'userdata', 'messenger', `content-cache-${userId}.json`);
}

module.exports = {
  loadMessengerCache,
  updateChatList,
  getCachedChatList,
  updateChatMessages,
  getCachedChatMessages,
  hasNewMessages,
  markChatAsReadInCache,
  deleteChatFromCache,
  getCacheStats,
  getMessengerCachePath
};
