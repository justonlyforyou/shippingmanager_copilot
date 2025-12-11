/**
 * @fileoverview Processed DM Message ID Caching
 *
 * Manages persistence of processed message IDs to prevent duplicate bot replies.
 * Each user has their own cache file stored in userdata/chatbot/.
 *
 * @module server/websocket/message-cache
 */

const fs = require('fs');
const path = require('path');
const { getAppBaseDir, isPackaged } = require('../config');
const logger = require('../utils/logger');

/**
 * In-memory map of processed message IDs per user (loaded from cache files)
 * @type {Map<string, Set<string>>}
 */
const processedMessageIds = new Map();

// Use AppData when packaged as exe
const isPkg = isPackaged();

/**
 * Get cache file path for processed DM message IDs for a specific user
 * @param {string|number} userId - User ID
 * @returns {string} Path to user-specific processed messages cache file
 */
function getProcessedMessagesCachePath(userId) {
  return isPkg
    ? path.join(getAppBaseDir(), 'userdata', 'chatbot', `processed_dm_messages-${userId}.json`)
    : path.join(__dirname, '..', '..', 'userdata', 'chatbot', `processed_dm_messages-${userId}.json`);
}

/**
 * Get processed message IDs set for a specific user
 * @param {string|number} userId - User ID
 * @returns {Set<string>} Set of processed message identifiers
 */
function getProcessedMessageIds(userId) {
  const userIdString = String(userId);
  if (!processedMessageIds.has(userIdString)) {
    processedMessageIds.set(userIdString, new Set());
  }
  return processedMessageIds.get(userIdString);
}

/**
 * Load processed message IDs from cache file for a specific user
 * @param {string|number} userId - User ID
 */
function loadProcessedMessageCache(userId) {
  try {
    const cachePath = getProcessedMessagesCachePath(userId);
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf8');
      const ids = JSON.parse(data);
      const userSet = getProcessedMessageIds(userId);
      ids.forEach(id => userSet.add(id));
      logger.debug(`[Messenger] Loaded ${userSet.size} processed message IDs from cache for user ${userId}`);
    } else {
      logger.debug(`[Messenger] No cache file found for user ${userId}, starting with empty processed messages cache`);
    }
  } catch (error) {
    logger.error(`[Messenger] Error loading processed messages cache for user ${userId}:`, error.message);
    // Ensure empty set exists even on error
    getProcessedMessageIds(userId);
  }
}

/**
 * Save processed message IDs to cache file for a specific user
 * @param {string|number} userId - User ID
 */
function saveProcessedMessageCache(userId) {
  try {
    const cachePath = getProcessedMessagesCachePath(userId);
    const dataDir = path.dirname(cachePath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const userSet = getProcessedMessageIds(userId);
    fs.writeFileSync(cachePath, JSON.stringify([...userSet], null, 2));
  } catch (error) {
    logger.error(`[Messenger] Error saving processed messages cache for user ${userId}:`, error.message);
  }
}

module.exports = {
  processedMessageIds,
  getProcessedMessagesCachePath,
  getProcessedMessageIds,
  loadProcessedMessageCache,
  saveProcessedMessageCache
};
