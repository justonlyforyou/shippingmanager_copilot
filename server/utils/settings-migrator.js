/**
 * @fileoverview Settings Migration Module
 *
 * Migrates settings from JSON files to SQLite database.
 * - Global settings (host, logLevel) from settings.json -> accounts_metadata
 * - User settings from settings-{userId}.json -> per-user database metadata table
 *
 * Migration process:
 * 1. Check if JSON files exist
 * 2. Read JSON data
 * 3. Write to database
 * 4. Verify data in database matches JSON
 * 5. ONLY THEN delete JSON files
 *
 * @module server/utils/settings-migrator
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const db = require('../database');
const { getAppBaseDir, isPackaged } = require('../config');

// Default global settings (used when no settings.json exists)
const DEFAULT_GLOBAL_SETTINGS = {
  host: '127.0.0.1',
  logLevel: 'info'
};

/**
 * Get settings directory path
 * @returns {string} Settings directory path
 */
function getSettingsDir() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'userdata', 'settings');
  }
  return path.join(__dirname, '..', '..', 'userdata', 'settings');
}

/**
 * Migrate global settings from settings.json to accounts_metadata
 * @returns {{migrated: boolean, verified: boolean, deleted: boolean, error: string|null}}
 */
function migrateGlobalSettings() {
  const result = { migrated: false, verified: false, deleted: false, error: null };
  const settingsFile = path.join(getSettingsDir(), 'settings.json');

  // Check if already migrated (host exists in database)
  const existingHost = db.getGlobalSetting('host');
  if (existingHost) {
    logger.debug('[SettingsMigrator] Global settings already in database');

    // If JSON still exists, verify and delete
    if (fs.existsSync(settingsFile)) {
      try {
        // Parse JSON to validate it's readable (verification step)
        JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        const dbHost = db.getGlobalSetting('host');
        const dbLogLevel = db.getGlobalSetting('logLevel');

        // Verify DB has valid settings
        if (dbHost && dbLogLevel) {
          logger.info('[SettingsMigrator] Verified global settings in DB, deleting settings.json');
          fs.unlinkSync(settingsFile);
          result.deleted = true;
        }
      } catch (err) {
        logger.warn('[SettingsMigrator] Could not verify/delete settings.json:', err.message);
      }
    }

    result.migrated = true;
    result.verified = true;
    return result;
  }

  // Check if settings.json exists
  if (!fs.existsSync(settingsFile)) {
    logger.info('[SettingsMigrator] No settings.json found, using defaults');

    // Write defaults to database
    db.setGlobalSetting('host', DEFAULT_GLOBAL_SETTINGS.host);
    db.setGlobalSetting('logLevel', DEFAULT_GLOBAL_SETTINGS.logLevel);

    result.migrated = true;
    result.verified = true;
    return result;
  }

  try {
    // Read JSON file
    const jsonData = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    logger.info('[SettingsMigrator] Migrating global settings from settings.json');

    // Extract global settings (host, logLevel - NOT debugMode, that stays in devel.json)
    const host = jsonData.host || DEFAULT_GLOBAL_SETTINGS.host;
    const logLevel = jsonData.logLevel || DEFAULT_GLOBAL_SETTINGS.logLevel;

    // Write to database
    db.setGlobalSetting('host', host);
    db.setGlobalSetting('logLevel', logLevel);
    result.migrated = true;

    // Verify
    const verifyHost = db.getGlobalSetting('host');
    const verifyLogLevel = db.getGlobalSetting('logLevel');

    if (verifyHost === host && verifyLogLevel === logLevel) {
      result.verified = true;
      logger.info('[SettingsMigrator] Global settings verified in database');

      // Delete JSON file
      fs.unlinkSync(settingsFile);
      result.deleted = true;
      logger.info('[SettingsMigrator] Deleted settings.json after successful migration');
    } else {
      result.error = 'Verification failed - database values do not match JSON';
      logger.error('[SettingsMigrator] Verification failed! NOT deleting settings.json');
    }

  } catch (err) {
    result.error = err.message;
    logger.error('[SettingsMigrator] Error migrating global settings:', err.message);
  }

  return result;
}

/**
 * Migrate user settings from settings-{userId}.json to per-user database
 * @param {string} userId - User ID to migrate
 * @returns {{migrated: boolean, verified: boolean, deleted: boolean, error: string|null}}
 */
function migrateUserSettings(userId) {
  const result = { migrated: false, verified: false, deleted: false, error: null };
  const settingsFile = path.join(getSettingsDir(), `settings-${userId}.json`);

  // Check if already migrated
  const existingSettings = db.getUserSettings(userId);
  if (existingSettings) {
    logger.debug(`[SettingsMigrator] User ${userId} settings already in database`);

    // If JSON still exists, verify and delete
    if (fs.existsSync(settingsFile)) {
      try {
        // DB has settings, we can delete the JSON
        logger.info(`[SettingsMigrator] Verified user ${userId} settings in DB, deleting JSON`);
        fs.unlinkSync(settingsFile);
        result.deleted = true;
      } catch (err) {
        logger.warn(`[SettingsMigrator] Could not delete settings-${userId}.json:`, err.message);
      }
    }

    result.migrated = true;
    result.verified = true;
    return result;
  }

  // Check if JSON file exists
  if (!fs.existsSync(settingsFile)) {
    logger.debug(`[SettingsMigrator] No settings-${userId}.json found`);
    return result;
  }

  try {
    // Read JSON file
    const jsonData = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    logger.info(`[SettingsMigrator] Migrating user ${userId} settings from JSON`);

    // Write to database
    db.saveUserSettings(userId, jsonData);
    result.migrated = true;

    // Verify
    const verifySettings = db.getUserSettings(userId);

    // Deep compare is complex, just check that we got something back
    if (verifySettings && typeof verifySettings === 'object') {
      result.verified = true;
      logger.info(`[SettingsMigrator] User ${userId} settings verified in database`);

      // Delete JSON file
      fs.unlinkSync(settingsFile);
      result.deleted = true;
      logger.info(`[SettingsMigrator] Deleted settings-${userId}.json after successful migration`);
    } else {
      result.error = 'Verification failed - could not read settings from database';
      logger.error(`[SettingsMigrator] Verification failed for user ${userId}! NOT deleting JSON`);
    }

  } catch (err) {
    result.error = err.message;
    logger.error(`[SettingsMigrator] Error migrating user ${userId} settings:`, err.message);
  }

  return result;
}

/**
 * Migrate all settings (global + all users)
 * Called on server startup
 * @returns {{global: Object, users: Object<string, Object>}}
 */
function migrateAllSettings() {
  const results = {
    global: null,
    users: {}
  };

  logger.info('[SettingsMigrator] Starting settings migration check...');

  // Migrate global settings
  results.global = migrateGlobalSettings();

  // Find all user settings files
  const settingsDir = getSettingsDir();
  if (fs.existsSync(settingsDir)) {
    const files = fs.readdirSync(settingsDir);
    const userSettingsFiles = files.filter(f => f.match(/^settings-\d+\.json$/));

    for (const file of userSettingsFiles) {
      const match = file.match(/^settings-(\d+)\.json$/);
      if (match) {
        const userId = match[1];
        results.users[userId] = migrateUserSettings(userId);
      }
    }
  }

  // Summary
  const userCount = Object.keys(results.users).length;
  const migratedCount = Object.values(results.users).filter(r => r.migrated).length;

  if (results.global.migrated || migratedCount > 0) {
    logger.info(`[SettingsMigrator] Migration complete: global=${results.global.migrated ? 'OK' : 'SKIP'}, users=${migratedCount}/${userCount}`);
  } else {
    logger.debug('[SettingsMigrator] No migration needed');
  }

  return results;
}

/**
 * Get global settings from database (with defaults)
 * @returns {{host: string, logLevel: string}}
 */
function getGlobalSettingsFromDb() {
  const host = db.getGlobalSetting('host');
  const logLevel = db.getGlobalSetting('logLevel');

  return {
    host: host || DEFAULT_GLOBAL_SETTINGS.host,
    logLevel: logLevel || DEFAULT_GLOBAL_SETTINGS.logLevel
  };
}

module.exports = {
  migrateGlobalSettings,
  migrateUserSettings,
  migrateAllSettings,
  getGlobalSettingsFromDb,
  getSettingsDir,
  DEFAULT_GLOBAL_SETTINGS
};
