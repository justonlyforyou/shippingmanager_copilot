/**
 * @fileoverview Alliance Chat Read Tracking Module
 *
 * This module manages per-user read timestamps for alliance chat messages.
 * Uses SQLite (per-user database metadata table) for persistent storage.
 *
 * Key Features:
 * - Per-user read timestamp storage
 * - Persistent SQLite storage
 * - In-memory cache for performance
 * - Auto-migration from legacy JSON file
 *
 * Why This Exists:
 * - Game API does not track alliance chat read status (unlike private messages)
 * - Backend tracking enables consistent state across all connected clients
 * - Prevents old messages from repeatedly showing as unread
 *
 * @requires server/database
 * @module server/utils/read-tracker
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { getDb } = require('../database');
const { getAppBaseDir, isPackaged } = require('../config');

const METADATA_KEY = 'alliance_chat_last_read';

/**
 * In-memory cache of read tracking data per user
 * @type {Map<string, number>}
 */
const readTrackingCache = new Map();

/**
 * Flag to track if migration has been attempted
 * @type {boolean}
 */
let migrationAttempted = false;

/**
 * Get the path to the legacy JSON file
 * @returns {string} Path to read-tracking.json
 */
function getLegacyJsonPath() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'userdata', 'read-tracking.json');
  }
  return path.join(__dirname, '..', '..', 'userdata', 'read-tracking.json');
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

    if (!jsonData || typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
      logger.debug('[Read Tracker] Legacy JSON file has no valid data, skipping migration');
      fs.unlinkSync(jsonPath);
      return;
    }

    let migratedCount = 0;

    // Migrate each user's data
    for (const [userIdStr, timestamp] of Object.entries(jsonData)) {
      try {
        const db = getDb(userIdStr);

        // Check if this user already has data in SQLite
        const existingRow = db.prepare('SELECT value FROM metadata WHERE key = ?').get(METADATA_KEY);
        if (existingRow && existingRow.value) {
          logger.debug(`[Read Tracker] User ${userIdStr} already has SQLite data, skipping`);
          continue;
        }

        // Migrate timestamp to SQLite
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(METADATA_KEY, String(timestamp));
        migratedCount++;

      } catch (userError) {
        logger.error(`[Read Tracker] Error migrating user ${userIdStr}:`, userError);
      }
    }

    logger.info(`[Read Tracker] Migrated ${migratedCount} user(s) from JSON to SQLite`);

    // Delete legacy JSON file
    fs.unlinkSync(jsonPath);
    logger.info('[Read Tracker] Deleted legacy JSON file after successful migration');

  } catch (error) {
    logger.error('[Read Tracker] Error during migration from JSON:', error);
  }
}

/**
 * Gets the last read timestamp for a user's alliance chat.
 * Automatically migrates from legacy JSON file if it exists.
 *
 * New User Behavior:
 * - First time a user is seen, auto-initializes timestamp to NOW
 * - This prevents showing hundreds of old messages as "unread" after fresh install
 *
 * @function getLastReadTimestamp
 * @param {number} userId - User's unique identifier
 * @returns {number} Unix timestamp in milliseconds, or current time if user never seen before
 */
function getLastReadTimestamp(userId) {
  // Try migration from legacy JSON on first access
  migrateFromJson();

  const userIdStr = String(userId);

  // Check cache first
  if (readTrackingCache.has(userIdStr)) {
    return readTrackingCache.get(userIdStr);
  }

  try {
    const db = getDb(userIdStr);
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(METADATA_KEY);

    if (row && row.value) {
      const timestamp = parseInt(row.value, 10);
      readTrackingCache.set(userIdStr, timestamp);
      return timestamp;
    }

    // User has never read chat - initialize to NOW and save
    const now = Date.now();
    updateLastReadTimestamp(userId, now);
    logger.debug(`[Read Tracker] New user ${userId} - initialized last read timestamp to NOW`);
    return now;
  } catch (error) {
    logger.error('[Read Tracker] Error getting last read timestamp:', error);
    // Return current time on error to prevent showing all messages as unread
    return Date.now();
  }
}

/**
 * Updates the last read timestamp for a user's alliance chat.
 *
 * @function updateLastReadTimestamp
 * @param {number} userId - User's unique identifier
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {boolean} True if update successful, false otherwise
 */
function updateLastReadTimestamp(userId, timestamp) {
  const userIdStr = String(userId);

  try {
    const db = getDb(userIdStr);
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(METADATA_KEY, String(timestamp));

    // Update cache
    readTrackingCache.set(userIdStr, timestamp);

    logger.debug(`[Read Tracker] Updated last read timestamp for user ${userId} to ${new Date(timestamp).toISOString()}`);
    return true;
  } catch (error) {
    logger.error('[Read Tracker] Error updating last read timestamp:', error);
    return false;
  }
}

module.exports = {
  getLastReadTimestamp,
  updateLastReadTimestamp
};
