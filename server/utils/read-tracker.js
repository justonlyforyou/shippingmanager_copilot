/**
 * @fileoverview Alliance Chat Read Tracking Module
 *
 * This module manages per-user read timestamps for alliance chat messages.
 * It provides persistent storage of when each user last read the alliance chat,
 * enabling accurate unread counts and preventing duplicate notifications.
 *
 * Key Features:
 * - Per-user read timestamp storage
 * - Persistent JSON file storage in userdata/settings/
 * - Thread-safe read/write operations
 * - Automatic file creation if missing
 * - Graceful error handling
 *
 * Why This Exists:
 * - Game API does not track alliance chat read status (unlike private messages)
 * - localStorage-based tracking doesn't sync across devices/browsers
 * - Backend tracking enables consistent state across all connected clients
 * - Prevents old messages from repeatedly showing as unread
 * - Stops notification spam from messages user has already seen
 *
 * Storage Format:
 * {
 *   "userId1": {
 *     "allianceChatLastRead": 1699876543000  // Unix timestamp in milliseconds
 *   },
 *   "userId2": {
 *     "allianceChatLastRead": 1699876600000
 *   }
 * }
 *
 * Design Decisions:
 * - Timestamps in milliseconds (matches JavaScript Date.getTime())
 * - Per-user storage (multiple users can use same server)
 * - JSON format for human readability and easy debugging
 * - Stored in userdata/settings/ alongside other user settings
 * - Single file for all users (simpler than per-user files)
 *
 * @requires fs - File system operations
 * @requires path - Path resolution
 * @module server/utils/read-tracker
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Path to the read tracking JSON file
 * @constant {string}
 */
const READ_TRACKING_FILE = path.join(__dirname, '..', '..', 'userdata', 'settings', 'read-tracking.json');

/**
 * In-memory cache of read tracking data
 * Reduces file I/O for reads, writes still persist to disk
 * @type {Object}
 */
let readTrackingCache = null;

/**
 * Ensures the read tracking file exists and loads it into memory cache.
 * Creates file with empty object {} if it doesn't exist.
 *
 * Why This Function:
 * - Prevents crashes from missing file
 * - Initializes cache on first access
 * - Creates directory structure if needed
 * - Single source of truth for file operations
 *
 * Side Effects:
 * - Creates userdata/settings/ directory if missing
 * - Creates read-tracking.json file if missing
 * - Loads data into readTrackingCache
 *
 * @function ensureReadTrackingFile
 * @returns {Object} Read tracking data from file
 */
function ensureReadTrackingFile() {
  try {
    // Return cached data if available
    if (readTrackingCache !== null) {
      return readTrackingCache;
    }

    // Ensure directory exists
    const dir = path.dirname(READ_TRACKING_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.debug('[Read Tracker] Created directory:', dir);
    }

    // Check if file exists
    if (!fs.existsSync(READ_TRACKING_FILE)) {
      // Create empty file
      fs.writeFileSync(READ_TRACKING_FILE, JSON.stringify({}, null, 2), 'utf8');
      logger.debug('[Read Tracker] Created read tracking file:', READ_TRACKING_FILE);
      readTrackingCache = {};
      return readTrackingCache;
    }

    // Load existing file
    const fileContent = fs.readFileSync(READ_TRACKING_FILE, 'utf8');
    readTrackingCache = JSON.parse(fileContent);
    logger.debug('[Read Tracker] Loaded read tracking data for', Object.keys(readTrackingCache).length, 'users');
    return readTrackingCache;
  } catch (error) {
    logger.error('[Read Tracker] Error ensuring read tracking file:', error);
    // Return empty object on error, prevents crashes
    readTrackingCache = {};
    return readTrackingCache;
  }
}

/**
 * Saves read tracking data to disk.
 *
 * Why This Function:
 * - Persists in-memory cache to disk
 * - Ensures data survives server restarts
 * - Atomic write via writeFileSync (no partial writes)
 * - Pretty-printed JSON for debugging
 *
 * Side Effects:
 * - Writes to read-tracking.json file
 * - Logs errors if write fails
 *
 * @function saveReadTrackingFile
 * @param {Object} data - Read tracking data to save
 * @returns {boolean} True if save successful, false otherwise
 */
function saveReadTrackingFile(data) {
  try {
    fs.writeFileSync(READ_TRACKING_FILE, JSON.stringify(data, null, 2), 'utf8');
    logger.debug('[Read Tracker] Saved read tracking data');
    return true;
  } catch (error) {
    logger.error('[Read Tracker] Error saving read tracking file:', error);
    return false;
  }
}

/**
 * Gets the last read timestamp for a user's alliance chat.
 *
 * Why This Function:
 * - Used by GET /api/chat to calculate unread count
 * - Returns 0 for new users (treats all messages as unread initially)
 * - Cached lookups are fast (no file I/O after initial load)
 *
 * @function getLastReadTimestamp
 * @param {number} userId - User's unique identifier
 * @returns {number} Unix timestamp in milliseconds, or 0 if user has never read chat
 *
 * @example
 * const lastRead = getLastReadTimestamp(12345);
 * // Returns: 1699876543000 (or 0 if user never read chat)
 */
function getLastReadTimestamp(userId) {
  const data = ensureReadTrackingFile();
  const userIdStr = String(userId); // JSON keys are always strings

  if (data[userIdStr] && data[userIdStr].allianceChatLastRead) {
    return data[userIdStr].allianceChatLastRead;
  }

  // User has never read chat, return 0 (epoch start)
  return 0;
}

/**
 * Updates the last read timestamp for a user's alliance chat.
 *
 * Why This Function:
 * - Called by POST /api/chat/mark-read when user opens chat
 * - Persists timestamp to disk for reliability
 * - Updates in-memory cache for performance
 *
 * Side Effects:
 * - Updates readTrackingCache
 * - Writes to read-tracking.json file
 *
 * @function updateLastReadTimestamp
 * @param {number} userId - User's unique identifier
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {boolean} True if update successful, false otherwise
 *
 * @example
 * const success = updateLastReadTimestamp(12345, Date.now());
 * // Returns: true (and saves to disk)
 */
function updateLastReadTimestamp(userId, timestamp) {
  try {
    const data = ensureReadTrackingFile();
    const userIdStr = String(userId);

    // Initialize user data if doesn't exist
    if (!data[userIdStr]) {
      data[userIdStr] = {};
    }

    // Update timestamp
    data[userIdStr].allianceChatLastRead = timestamp;

    // Update cache
    readTrackingCache = data;

    // Save to disk
    const saved = saveReadTrackingFile(data);

    if (saved) {
      logger.debug(`[Read Tracker] Updated last read timestamp for user ${userId} to ${new Date(timestamp).toISOString()}`);
    }

    return saved;
  } catch (error) {
    logger.error('[Read Tracker] Error updating last read timestamp:', error);
    return false;
  }
}

module.exports = {
  getLastReadTimestamp,
  updateLastReadTimestamp
};
