/**
 * @fileoverview IPO Tracking Module
 *
 * This module manages tracking of seen IPOs to detect new ones.
 * Uses SQLite (alliance_cache.db) for persistent storage.
 *
 * Key Features:
 * - Persistent tracking of seen IPO user IDs
 * - Highest user ID tracking for efficient new IPO detection
 * - SQLite storage in alliance_cache.db
 * - In-memory cache for performance
 * - Auto-migration from legacy JSON file
 *
 * @requires server/database/alliance-cache
 * @module server/utils/ipo-tracker
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { getDb } = require('../database/alliance-cache');
const { getAppBaseDir, isPackaged } = require('../config');

/**
 * In-memory cache of IPO tracking data
 * @type {Object|null}
 */
let ipoTrackingCache = null;

/**
 * Flag to track if migration has been attempted
 * @type {boolean}
 */
let migrationAttempted = false;

/**
 * Get the path to the legacy JSON file
 * @returns {string} Path to ipo-tracking.json
 */
function getLegacyJsonPath() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'userdata', 'ipo-tracking.json');
  }
  return path.join(__dirname, '..', '..', 'userdata', 'ipo-tracking.json');
}

/**
 * Migrate data from legacy JSON file to SQLite.
 * Only runs once per session and deletes the JSON file after successful migration.
 */
function migrateFromJson() {
  if (migrationAttempted) {
    return;
  }
  migrationAttempted = true;

  const jsonPath = getLegacyJsonPath();

  if (!fs.existsSync(jsonPath)) {
    return;
  }

  try {
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    if (!jsonData.highestSeenUserId && !jsonData.seenIpoUserIds) {
      logger.debug('[IPO Tracker] Legacy JSON file has no valid data, skipping migration');
      fs.unlinkSync(jsonPath);
      return;
    }

    const db = getDb();
    const row = db.prepare('SELECT highest_seen_user_id FROM ipo_tracking WHERE id = 1').get();

    // Only migrate if SQLite has no data yet
    if (row && row.highest_seen_user_id > 0) {
      logger.debug('[IPO Tracker] SQLite already has data, skipping migration');
      fs.unlinkSync(jsonPath);
      logger.info('[IPO Tracker] Deleted legacy JSON file (SQLite already had data)');
      return;
    }

    // Migrate data to SQLite
    const highestSeenUserId = jsonData.highestSeenUserId || 0;
    const seenIpoUserIds = jsonData.seenIpoUserIds || [];

    db.prepare(`
      UPDATE ipo_tracking
      SET highest_seen_user_id = ?, seen_ipo_user_ids_json = ?
      WHERE id = 1
    `).run(highestSeenUserId, JSON.stringify(seenIpoUserIds));

    logger.info(`[IPO Tracker] Migrated ${seenIpoUserIds.length} IPOs from JSON to SQLite`);

    // Delete legacy JSON file
    fs.unlinkSync(jsonPath);
    logger.info('[IPO Tracker] Deleted legacy JSON file after successful migration');

  } catch (error) {
    logger.error('[IPO Tracker] Error during migration from JSON:', error);
  }
}

/**
 * Loads IPO tracking data from SQLite into memory cache.
 * Automatically migrates from legacy JSON file if it exists.
 *
 * @function loadIpoTracking
 * @returns {Object} IPO tracking data
 */
function loadIpoTracking() {
  // Try migration from legacy JSON on first load
  migrateFromJson();

  if (ipoTrackingCache !== null) {
    return ipoTrackingCache;
  }

  try {
    const db = getDb();
    const row = db.prepare('SELECT highest_seen_user_id, seen_ipo_user_ids_json FROM ipo_tracking WHERE id = 1').get();

    if (row) {
      ipoTrackingCache = {
        highestSeenUserId: row.highest_seen_user_id,
        seenIpoUserIds: JSON.parse(row.seen_ipo_user_ids_json)
      };
    } else {
      ipoTrackingCache = {
        highestSeenUserId: 0,
        seenIpoUserIds: []
      };
    }

    logger.debug(`[IPO Tracker] Loaded IPO tracking data - highest ID: ${ipoTrackingCache.highestSeenUserId}, seen: ${ipoTrackingCache.seenIpoUserIds.length} IPOs`);
    return ipoTrackingCache;
  } catch (error) {
    logger.error('[IPO Tracker] Error loading IPO tracking:', error);
    ipoTrackingCache = {
      highestSeenUserId: 0,
      seenIpoUserIds: []
    };
    return ipoTrackingCache;
  }
}

/**
 * Saves IPO tracking data to SQLite.
 *
 * @function saveIpoTracking
 * @param {Object} data - IPO tracking data to save
 * @returns {boolean} True if save successful
 */
function saveIpoTracking(data) {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE ipo_tracking
      SET highest_seen_user_id = ?, seen_ipo_user_ids_json = ?
      WHERE id = 1
    `).run(data.highestSeenUserId, JSON.stringify(data.seenIpoUserIds));
    logger.debug('[IPO Tracker] Saved IPO tracking data');
    return true;
  } catch (error) {
    logger.error('[IPO Tracker] Error saving IPO tracking:', error);
    return false;
  }
}

/**
 * Gets the highest seen user ID.
 *
 * @function getHighestSeenUserId
 * @returns {number} Highest seen user ID, or 0 if never seen any
 */
function getHighestSeenUserId() {
  const data = loadIpoTracking();
  return data.highestSeenUserId;
}

/**
 * Gets the set of seen IPO user IDs.
 *
 * @function getSeenIpoUserIds
 * @returns {Set<number>} Set of seen user IDs
 */
function getSeenIpoUserIds() {
  const data = loadIpoTracking();
  return new Set(data.seenIpoUserIds);
}

/**
 * Checks if a user ID has been seen before.
 *
 * @function hasSeenIpo
 * @param {number} userId - User ID to check
 * @returns {boolean} True if user ID has been seen
 */
function hasSeenIpo(userId) {
  const data = loadIpoTracking();
  return data.seenIpoUserIds.includes(userId);
}

/**
 * Adds a user ID to the seen list and updates highest if needed.
 *
 * @function markIpoAsSeen
 * @param {number} userId - User ID to mark as seen
 * @returns {boolean} True if this was a new IPO (not seen before)
 */
function markIpoAsSeen(userId) {
  try {
    const data = loadIpoTracking();
    const wasNew = !data.seenIpoUserIds.includes(userId);

    if (wasNew) {
      data.seenIpoUserIds.push(userId);
      logger.debug(`[IPO Tracker] Marked IPO ${userId} as seen`);
    }

    // Update highest seen if this is higher
    if (userId > data.highestSeenUserId) {
      data.highestSeenUserId = userId;
      logger.debug(`[IPO Tracker] Updated highest seen user ID to ${userId}`);
    }

    // Update cache and save
    ipoTrackingCache = data;
    saveIpoTracking(data);

    return wasNew;
  } catch (error) {
    logger.error('[IPO Tracker] Error marking IPO as seen:', error);
    return false;
  }
}

/**
 * Initializes tracking with a list of IPOs (used on first check).
 * Marks all provided IPOs as seen and sets highest user ID.
 *
 * @function initializeWithIpos
 * @param {Array<{id: number}>} ipos - Array of IPO objects with id property
 */
function initializeWithIpos(ipos) {
  try {
    const data = loadIpoTracking();

    // Only initialize if we haven't seen any IPOs yet
    if (data.highestSeenUserId === 0 && data.seenIpoUserIds.length === 0) {
      const userIds = ipos.map(ipo => ipo.id);
      data.seenIpoUserIds = userIds;
      data.highestSeenUserId = Math.max(...userIds, 0);

      ipoTrackingCache = data;
      saveIpoTracking(data);

      logger.info(`[IPO Tracker] Initialized with ${userIds.length} IPOs, highest ID: ${data.highestSeenUserId}`);
    }
  } catch (error) {
    logger.error('[IPO Tracker] Error initializing with IPOs:', error);
  }
}

/**
 * Checks if this is the first time checking IPOs (no data yet).
 *
 * @function isFirstCheck
 * @returns {boolean} True if no IPOs have been tracked yet
 */
function isFirstCheck() {
  const data = loadIpoTracking();
  return data.highestSeenUserId === 0 && data.seenIpoUserIds.length === 0;
}

module.exports = {
  getHighestSeenUserId,
  getSeenIpoUserIds,
  hasSeenIpo,
  markIpoAsSeen,
  initializeWithIpos,
  isFirstCheck
};
