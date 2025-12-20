/**
 * @fileoverview Database Initialization Module
 *
 * Handles automatic migration from JSON to SQLite on first run.
 * Call initDatabase() during server startup to ensure data is migrated.
 *
 * @module server/database/init
 */

const logger = require('../utils/logger');
const { getDb, isMigrationComplete, getDbPath } = require('./index');
const { migrateUser, findUserJsonFiles } = require('./migration');
const fs = require('fs');

/**
 * Initialize database for a specific user
 * Migrates JSON data if SQLite database is new
 *
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Initialization result
 */
async function initUserDatabase(userId) {
  const dbPath = getDbPath(userId);
  const isNew = !fs.existsSync(dbPath);

  // Get or create database (this also creates schema)
  getDb(userId);

  // ALWAYS check for JSON files - even if migration was marked complete,
  // there might be files that were renamed or added later
  const jsonFiles = findUserJsonFiles(userId);
  const migrationComplete = isMigrationComplete(userId);

  if (jsonFiles.length > 0) {
    logger.info(`[DatabaseInit] Found ${jsonFiles.length} JSON files for user ${userId} (migrationComplete=${migrationComplete})`);

    try {
      const result = migrateUser(userId);
      return {
        userId,
        migrated: true,
        isNew,
        ...result
      };
    } catch (err) {
      logger.error(`[DatabaseInit] Migration failed for user ${userId}:`, err.message);
      return {
        userId,
        migrated: false,
        isNew,
        error: err.message
      };
    }
  }

  if (!migrationComplete) {
    logger.debug(`[DatabaseInit] No JSON files to migrate for user ${userId}`);
    return {
      userId,
      migrated: false,
      isNew,
      noDataToMigrate: true
    };
  }

  logger.debug(`[DatabaseInit] Database already initialized for user ${userId}`);
  return {
    userId,
    migrated: false,
    isNew: false,
    alreadyInitialized: true
  };
}

/**
 * Initialize databases for all users with session data
 * Call this during server startup
 *
 * @param {string[]} userIds - Array of user IDs with active sessions
 * @returns {Promise<Object>} Initialization results
 */
async function initAllUserDatabases(userIds) {
  logger.info(`[DatabaseInit] Initializing databases for ${userIds.length} users`);

  const results = {
    users: [],
    summary: {
      total: userIds.length,
      migrated: 0,
      skipped: 0,
      failed: 0
    }
  };

  for (const userId of userIds) {
    try {
      const result = await initUserDatabase(userId);
      results.users.push(result);

      if (result.migrated) {
        results.summary.migrated++;
      } else {
        results.summary.skipped++;
      }
    } catch (err) {
      logger.error(`[DatabaseInit] Failed to init database for user ${userId}:`, err.message);
      results.users.push({ userId, error: err.message });
      results.summary.failed++;
    }
  }

  logger.info(`[DatabaseInit] Complete: ${results.summary.migrated} migrated, ${results.summary.skipped} skipped, ${results.summary.failed} failed`);
  return results;
}

module.exports = {
  initUserDatabase,
  initAllUserDatabases
};
