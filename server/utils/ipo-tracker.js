/**
 * @fileoverview IPO Tracking Module
 *
 * This module manages tracking of seen IPOs to detect new ones.
 * It provides persistent storage of the highest seen user ID and
 * a set of all seen IPO user IDs.
 *
 * Key Features:
 * - Persistent tracking of seen IPO user IDs
 * - Highest user ID tracking for efficient new IPO detection
 * - JSON file storage in userdata/settings/
 * - In-memory cache for performance
 *
 * Storage Format:
 * {
 *   "highestSeenUserId": 123456,
 *   "seenIpoUserIds": [123456, 123455, 123454, ...]
 * }
 *
 * @requires fs - File system operations
 * @requires path - Path resolution
 * @module server/utils/ipo-tracker
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getAppDataDir } = require('../config');

/**
 * Path to the IPO tracking JSON file - use AppData when packaged as exe
 * @constant {string}
 */
const isPkg = !!process.pkg;
const IPO_TRACKING_FILE = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'settings', 'ipo-tracking.json')
  : path.join(__dirname, '..', '..', 'userdata', 'settings', 'ipo-tracking.json');

/**
 * In-memory cache of IPO tracking data
 * @type {Object|null}
 */
let ipoTrackingCache = null;

/**
 * Ensures the IPO tracking file exists and loads it into memory cache.
 * Creates file with default values if it doesn't exist.
 *
 * @function ensureIpoTrackingFile
 * @returns {Object} IPO tracking data from file
 */
function ensureIpoTrackingFile() {
  try {
    // Return cached data if available
    if (ipoTrackingCache !== null) {
      return ipoTrackingCache;
    }

    // Ensure directory exists
    const dir = path.dirname(IPO_TRACKING_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.debug('[IPO Tracker] Created directory:', dir);
    }

    // Check if file exists
    if (!fs.existsSync(IPO_TRACKING_FILE)) {
      // Create empty file with default values
      const defaultData = {
        highestSeenUserId: 0,
        seenIpoUserIds: []
      };
      fs.writeFileSync(IPO_TRACKING_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
      logger.debug('[IPO Tracker] Created IPO tracking file:', IPO_TRACKING_FILE);
      ipoTrackingCache = defaultData;
      return ipoTrackingCache;
    }

    // Load existing file
    const fileContent = fs.readFileSync(IPO_TRACKING_FILE, 'utf8');
    ipoTrackingCache = JSON.parse(fileContent);
    logger.debug(`[IPO Tracker] Loaded IPO tracking data - highest ID: ${ipoTrackingCache.highestSeenUserId}, seen: ${ipoTrackingCache.seenIpoUserIds.length} IPOs`);
    return ipoTrackingCache;
  } catch (error) {
    logger.error('[IPO Tracker] Error ensuring IPO tracking file:', error);
    // Return default values on error
    ipoTrackingCache = {
      highestSeenUserId: 0,
      seenIpoUserIds: []
    };
    return ipoTrackingCache;
  }
}

/**
 * Saves IPO tracking data to disk.
 *
 * @function saveIpoTrackingFile
 * @param {Object} data - IPO tracking data to save
 * @returns {boolean} True if save successful, false otherwise
 */
function saveIpoTrackingFile(data) {
  try {
    fs.writeFileSync(IPO_TRACKING_FILE, JSON.stringify(data, null, 2), 'utf8');
    logger.debug('[IPO Tracker] Saved IPO tracking data');
    return true;
  } catch (error) {
    logger.error('[IPO Tracker] Error saving IPO tracking file:', error);
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
  const data = ensureIpoTrackingFile();
  return data.highestSeenUserId;
}

/**
 * Gets the set of seen IPO user IDs.
 *
 * @function getSeenIpoUserIds
 * @returns {Set<number>} Set of seen user IDs
 */
function getSeenIpoUserIds() {
  const data = ensureIpoTrackingFile();
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
  const data = ensureIpoTrackingFile();
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
    const data = ensureIpoTrackingFile();
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
    saveIpoTrackingFile(data);

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
    const data = ensureIpoTrackingFile();

    // Only initialize if we haven't seen any IPOs yet
    if (data.highestSeenUserId === 0 && data.seenIpoUserIds.length === 0) {
      const userIds = ipos.map(ipo => ipo.id);
      data.seenIpoUserIds = userIds;
      data.highestSeenUserId = Math.max(...userIds, 0);

      ipoTrackingCache = data;
      saveIpoTrackingFile(data);

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
  const data = ensureIpoTrackingFile();
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
