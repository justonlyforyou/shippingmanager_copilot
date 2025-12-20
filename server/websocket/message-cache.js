/**
 * @fileoverview Processed DM Message ID Caching (SQLite)
 *
 * Manages persistence of processed message IDs to prevent duplicate bot replies.
 * Uses SQLite for reliable storage with ACID transactions.
 * Auto-migrates from legacy JSON files.
 *
 * @module server/websocket/message-cache
 */

const path = require('path');
const fs = require('fs');
const { getDb } = require('../database');
const logger = require('../utils/logger');
const { getAppBaseDir, isPackaged } = require('../config');

/**
 * In-memory map of processed message IDs per user (loaded from SQLite on first access)
 * @type {Map<string, Set<string>>}
 */
const processedMessageIds = new Map();

/**
 * Track which users have been loaded from SQLite
 * @type {Set<string>}
 */
const loadedUsers = new Set();

/**
 * Track which users have had migration attempted
 * @type {Set<string>}
 */
const migrationAttempted = new Set();

/**
 * Get legacy JSON file path for a user
 * @param {string} userId - User ID
 * @returns {string} Path to legacy JSON file
 */
function getLegacyJsonPath(userId) {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'userdata', 'chatbot', `processed_dm_messages-${userId}.json`);
  }
  return path.join(__dirname, '..', '..', 'userdata', 'chatbot', `processed_dm_messages-${userId}.json`);
}

/**
 * Migrate data from legacy JSON file to SQLite for a specific user.
 * Only runs once per user per session and deletes the JSON file after successful migration.
 * @param {string} userId - User ID
 */
function migrateFromJson(userId) {
  const userIdString = String(userId);

  if (migrationAttempted.has(userIdString)) {
    return;
  }
  migrationAttempted.add(userIdString);

  const jsonPath = getLegacyJsonPath(userIdString);

  if (!fs.existsSync(jsonPath)) {
    return;
  }

  try {
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    if (!Array.isArray(jsonData) || jsonData.length === 0) {
      logger.debug(`[Messenger] Legacy JSON file for user ${userId} has no valid data, deleting`);
      fs.unlinkSync(jsonPath);
      return;
    }

    const db = getDb(userIdString);

    // Check if SQLite already has data
    const existingCount = db.prepare('SELECT COUNT(*) as count FROM processed_dm_messages').get();
    if (existingCount && existingCount.count > 0) {
      logger.debug(`[Messenger] User ${userId} already has SQLite data, skipping migration`);
      fs.unlinkSync(jsonPath);
      logger.info(`[Messenger] Deleted legacy JSON file for user ${userId} (SQLite already had data)`);
      return;
    }

    // Migrate data to SQLite
    const insert = db.prepare('INSERT OR IGNORE INTO processed_dm_messages (message_id) VALUES (?)');
    const insertMany = db.transaction((ids) => {
      for (const id of ids) {
        insert.run(id);
      }
    });

    insertMany(jsonData);
    logger.info(`[Messenger] Migrated ${jsonData.length} processed message IDs from JSON to SQLite for user ${userId}`);

    // Delete legacy JSON file
    fs.unlinkSync(jsonPath);
    logger.info(`[Messenger] Deleted legacy JSON file for user ${userId}`);

  } catch (error) {
    logger.error(`[Messenger] Error during migration from JSON for user ${userId}:`, error);
  }
}

/**
 * Get processed message IDs set for a specific user
 * @param {string|number} userId - User ID
 * @returns {Set<string>} Set of processed message identifiers
 */
function getProcessedMessageIds(userId) {
  const userIdString = String(userId);

  // Load from SQLite on first access
  if (!loadedUsers.has(userIdString)) {
    loadProcessedMessageCache(userIdString);
  }

  if (!processedMessageIds.has(userIdString)) {
    processedMessageIds.set(userIdString, new Set());
  }
  return processedMessageIds.get(userIdString);
}

/**
 * Load processed message IDs from SQLite for a specific user.
 * Automatically migrates from legacy JSON file if it exists.
 * @param {string|number} userId - User ID
 */
function loadProcessedMessageCache(userId) {
  const userIdString = String(userId);

  // Try migration from legacy JSON first
  migrateFromJson(userIdString);

  try {
    const db = getDb(userIdString);
    const rows = db.prepare('SELECT message_id FROM processed_dm_messages').all();
    const userSet = new Set();

    for (const row of rows) {
      userSet.add(row.message_id);
    }

    processedMessageIds.set(userIdString, userSet);
    loadedUsers.add(userIdString);

    if (userSet.size > 0) {
      logger.debug(`[Messenger] Loaded ${userSet.size} processed message IDs from SQLite for user ${userId}`);
    }
  } catch (error) {
    logger.error(`[Messenger] Error loading processed messages from SQLite for user ${userId}:`, error.message);
    // Ensure empty set exists even on error
    if (!processedMessageIds.has(userIdString)) {
      processedMessageIds.set(userIdString, new Set());
    }
    loadedUsers.add(userIdString);
  }
}

/**
 * Add a processed message ID and persist to SQLite
 * @param {string|number} userId - User ID
 * @param {string} messageId - Message ID to add
 */
function addProcessedMessageId(userId, messageId) {
  const userIdString = String(userId);
  const userSet = getProcessedMessageIds(userIdString);

  // Already processed
  if (userSet.has(messageId)) {
    return;
  }

  // Add to memory
  userSet.add(messageId);

  // Persist to SQLite
  try {
    const db = getDb(userIdString);
    db.prepare('INSERT OR IGNORE INTO processed_dm_messages (message_id) VALUES (?)').run(messageId);
  } catch (error) {
    logger.error(`[Messenger] Error saving processed message ID to SQLite for user ${userId}:`, error.message);
  }
}

/**
 * Check if a message has been processed
 * @param {string|number} userId - User ID
 * @param {string} messageId - Message ID to check
 * @returns {boolean} True if message was already processed
 */
function isMessageProcessed(userId, messageId) {
  const userSet = getProcessedMessageIds(userId);
  return userSet.has(messageId);
}

/**
 * Save processed message IDs to SQLite (for batch operations)
 * @param {string|number} userId - User ID
 */
function saveProcessedMessageCache(userId) {
  const userIdString = String(userId);
  const userSet = getProcessedMessageIds(userIdString);

  try {
    const db = getDb(userIdString);
    const insert = db.prepare('INSERT OR IGNORE INTO processed_dm_messages (message_id) VALUES (?)');

    const insertMany = db.transaction((ids) => {
      for (const id of ids) {
        insert.run(id);
      }
    });

    insertMany([...userSet]);
    logger.debug(`[Messenger] Saved ${userSet.size} processed message IDs to SQLite for user ${userId}`);
  } catch (error) {
    logger.error(`[Messenger] Error saving processed messages to SQLite for user ${userId}:`, error.message);
  }
}

module.exports = {
  processedMessageIds,
  getLegacyJsonPath,
  getProcessedMessageIds,
  loadProcessedMessageCache,
  saveProcessedMessageCache,
  addProcessedMessageId,
  isMessageProcessed
};
