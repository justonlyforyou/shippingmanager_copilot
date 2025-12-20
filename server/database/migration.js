/**
 * @fileoverview JSON to SQLite Migration Module
 *
 * Handles one-time migration of existing JSON data files to SQLite.
 * Designed to be extremely robust and never lose data.
 *
 * Features:
 * - Transactional imports (all or nothing per file)
 * - Moves migrated JSON files to userdata/olddata/{subfolder}/
 * - Logs all operations for debugging
 * - Handles corrupt/partial JSON files gracefully
 * - Idempotent - safe to run multiple times
 *
 * @module server/database/migration
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDb, isMigrationComplete, markMigrationComplete, transaction, setMetadata } = require('./index');
const { getAppBaseDir, isPackaged } = require('../config');
const { repairAllUserFiles } = require('./json-repair');

/**
 * Get userdata directory path
 * @returns {string} Userdata directory path
 */
function getUserdataDir() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'userdata');
  }
  return path.join(__dirname, '..', '..', 'userdata');
}

/**
 * Get legacy olduserdata directory paths (root level ./olduserdata and development/olduserdata)
 * @returns {string[]} Array of legacy olduserdata directory paths
 */
function getLegacyOlduserdataDirs() {
  const isPkg = isPackaged();
  if (isPkg) {
    return [path.join(getAppBaseDir(), 'olduserdata')];
  }
  return [
    path.join(__dirname, '..', '..', 'olduserdata'),
    path.join(__dirname, '..', '..', 'development', 'olduserdata')
  ];
}

/**
 * Safely parse JSON with error handling
 * @param {string} content - JSON string
 * @param {string} filePath - File path for logging
 * @returns {Object|null} Parsed object or null on error
 */
function safeParseJson(content, filePath) {
  try {
    return JSON.parse(content);
  } catch (err) {
    logger.error(`[Migration] Failed to parse JSON: ${filePath}`, err.message);

    // Try to repair common issues
    let repaired = content.trim();

    // Remove trailing commas
    repaired = repaired.replace(/,\s*([\]}])/g, '$1');

    try {
      return JSON.parse(repaired);
    } catch {
      logger.error(`[Migration] JSON repair failed: ${filePath}`);
      return null;
    }
  }
}

/**
 * Find all JSON files for a user across all data directories
 * @param {string} userId - User ID
 * @returns {Array<{type: string, path: string}>} Array of file info
 */
function findUserJsonFiles(userId) {
  const userdataDir = getUserdataDir();
  const legacyDirs = getLegacyOlduserdataDirs();
  const files = [];

  // Directories to search (both current userdata and legacy olduserdata dirs)
  const searchDirs = [userdataDir];
  for (const legacyDir of legacyDirs) {
    if (fs.existsSync(legacyDir)) {
      searchDirs.push(legacyDir);
    }
  }

  for (const baseDir of searchDirs) {
    // vessel-history
    const vesselHistoryPath = path.join(baseDir, 'vessel-history', `${userId}-vessel-history.json`);
    if (fs.existsSync(vesselHistoryPath)) {
      files.push({ type: 'vessel-history', path: vesselHistoryPath });
    }

    // transactions
    const transactionsPath = path.join(baseDir, 'transactions', `${userId}-transactions.json`);
    if (fs.existsSync(transactionsPath)) {
      files.push({ type: 'transactions', path: transactionsPath });
    }

    // lookup (analytics)
    const lookupPath = path.join(baseDir, 'analytics', `${userId}-lookup.json`);
    if (fs.existsSync(lookupPath)) {
      files.push({ type: 'lookup', path: lookupPath });
    }

    // autopilot log
    const logDir = path.join(baseDir, '..', 'logs', 'autopilot');
    const logPath = path.join(logDir, `${userId}-autopilot-log.json`);
    if (fs.existsSync(logPath)) {
      files.push({ type: 'autopilot-log', path: logPath });
    }

    // Also check baseDir/logs/autopilot
    const altLogDir = path.join(baseDir, 'logs', 'autopilot');
    const altLogPath = path.join(altLogDir, `${userId}-autopilot-log.json`);
    if (fs.existsSync(altLogPath) && altLogPath !== logPath) {
      files.push({ type: 'autopilot-log', path: altLogPath });
    }

    // processed_dm_messages (chatbot)
    const dmMessagesPath = path.join(baseDir, 'chatbot', `processed_dm_messages-${userId}.json`);
    if (fs.existsSync(dmMessagesPath)) {
      files.push({ type: 'processed-dm-messages', path: dmMessagesPath });
    }

    // messenger content-cache
    const messengerCachePath = path.join(baseDir, 'messenger', `content-cache-${userId}.json`);
    if (fs.existsSync(messengerCachePath)) {
      files.push({ type: 'messenger-cache', path: messengerCachePath });
    }

    // trip-data (unified store)
    const tripDataPath = path.join(baseDir, 'trip-data', `trip-data-${userId}.json`);
    if (fs.existsSync(tripDataPath)) {
      files.push({ type: 'trip-data', path: tripDataPath });
    }

    // Old separate stores (harbor-fees, contributions, departure-data)
    const harborFeesPath = path.join(baseDir, 'harbor-fees', `harbor-fees-${userId}.json`);
    if (fs.existsSync(harborFeesPath)) {
      files.push({ type: 'harbor-fees', path: harborFeesPath });
    }

    const contributionsPath = path.join(baseDir, 'contributions', `contributions-${userId}.json`);
    if (fs.existsSync(contributionsPath)) {
      files.push({ type: 'contributions', path: contributionsPath });
    }

    const departureDataPath = path.join(baseDir, 'departure-data', `departure-data-${userId}.json`);
    if (fs.existsSync(departureDataPath)) {
      files.push({ type: 'departure-data', path: departureDataPath });
    }
  }

  return files;
}

/**
 * Find all hijack history files for a user
 * @param {string} userId - User ID
 * @returns {Array<{caseId: number, path: string}>} Array of hijack files
 */
function findUserHijackFiles(userId) {
  const userdataDir = getUserdataDir();
  const legacyDirs = getLegacyOlduserdataDirs();
  const files = [];

  // Search in both userdata and legacy olduserdata dirs
  const hijackDirs = [path.join(userdataDir, 'hijack_history')];
  for (const legacyDir of legacyDirs) {
    if (fs.existsSync(legacyDir)) {
      hijackDirs.push(path.join(legacyDir, 'hijack_history'));
    }
  }

  // Escape userId for regex safety (userId should only be digits, but be safe)
  const escapedUserId = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedUserId}-(\\d+)\\.json$`); // eslint-disable-line security/detect-non-literal-regexp

  for (const hijackDir of hijackDirs) {
    if (!fs.existsSync(hijackDir)) {
      continue;
    }

    try {
      const allFiles = fs.readdirSync(hijackDir);

      for (const file of allFiles) {
        // Pattern: {userId}-{caseId}.json
        const match = file.match(pattern);
        if (match) {
          files.push({
            caseId: parseInt(match[1], 10),
            path: path.join(hijackDir, file)
          });
        }
      }
    } catch (err) {
      logger.error(`[Migration] Error scanning hijack_history for user ${userId}:`, err.message);
    }
  }

  return files;
}

/**
 * Find all vessel appearance files for a user
 * @param {string} userId - User ID
 * @returns {Array<{vesselId: number, path: string}>} Array of vessel appearance files
 */
function findUserVesselAppearanceFiles(userId) {
  const userdataDir = getUserdataDir();
  const legacyDirs = getLegacyOlduserdataDirs();
  const files = [];

  // Search in both userdata and legacy olduserdata dirs
  const appearancesDirs = [path.join(userdataDir, 'vessel-appearances')];
  for (const legacyDir of legacyDirs) {
    if (fs.existsSync(legacyDir)) {
      appearancesDirs.push(path.join(legacyDir, 'vessel-appearances'));
    }
  }

  // Escape userId for regex safety
  const escapedUserId = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedUserId}_(\\d+)\\.json$`); // eslint-disable-line security/detect-non-literal-regexp

  for (const appearancesDir of appearancesDirs) {
    if (!fs.existsSync(appearancesDir)) {
      continue;
    }

    try {
      const allFiles = fs.readdirSync(appearancesDir);

      for (const file of allFiles) {
        // Pattern: {userId}_{vesselId}.json
        const match = file.match(pattern);
        if (match) {
          files.push({
            vesselId: parseInt(match[1], 10),
            path: path.join(appearancesDir, file)
          });
        }
      }
    } catch (err) {
      logger.error(`[Migration] Error scanning vessel-appearances for user ${userId}:`, err.message);
    }
  }

  return files;
}

/**
 * Get the olddata directory path
 * @returns {string} Olddata directory path
 */
function getOlddataDir() {
  const userdataDir = getUserdataDir();
  return path.join(userdataDir, 'olddata');
}

/**
 * Move a successfully migrated file to userdata/olddata/{subfolder}/
 * @param {string} filePath - Original file path
 * @returns {boolean} True if moved successfully
 */
function moveToOldData(filePath) {
  try {
    const userdataDir = getUserdataDir();
    const legacyDirs = getLegacyOlduserdataDirs();
    const olddataDir = getOlddataDir();

    // Skip if file is already in olddata
    if (filePath.includes('olddata')) {
      return true;
    }

    // Determine which base directory the file is from and get relative path
    let relativePath;
    let foundLegacyDir = null;
    for (const legacyDir of legacyDirs) {
      if (filePath.startsWith(legacyDir)) {
        foundLegacyDir = legacyDir;
        break;
      }
    }

    if (foundLegacyDir) {
      // File is from legacy olduserdata directory
      relativePath = path.relative(foundLegacyDir, filePath);
    } else {
      // File is from current userdata directory
      relativePath = path.relative(userdataDir, filePath);
    }

    const parts = relativePath.split(path.sep);

    // First part is the subfolder (e.g., "vessel-history", "transactions", etc.)
    const subfolder = parts.length > 1 ? parts[0] : 'misc';
    const fileName = path.basename(filePath);

    // Create olddata subfolder if needed
    const targetDir = path.join(olddataDir, subfolder);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.join(targetDir, fileName);

    // Move the file
    fs.renameSync(filePath, targetPath);
    logger.info(`[Migration] Moved: ${relativePath} -> olddata/${subfolder}/${fileName}`);
    return true;
  } catch (err) {
    logger.error(`[Migration] Failed to move file: ${filePath}`, err.message);
    return false;
  }
}

/**
 * Import vessel history data
 * @param {string} userId - User ID
 * @param {Object} data - Vessel history data
 * @returns {Object} Import stats
 */
function importVesselHistory(userId, data) {
  const stats = { vessels: 0, departures: 0, risks: 0 };

  transaction(userId, () => {
    const db = getDb(userId);

    // Import vessels
    if (data.vessels) {
      const insertVessel = db.prepare(`
        INSERT OR REPLACE INTO vessels (id, name, type_name, last_synced_at, newest_entry_at, entry_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const [vesselId, vessel] of Object.entries(data.vessels)) {
        insertVessel.run(
          parseInt(vesselId, 10),
          vessel.name,
          vessel.typeName,
          vessel.lastSyncedAt,
          vessel.newestEntryAt,
          vessel.entryCount
        );
        stats.vessels++;
      }
    }

    // Import departures
    if (data.departures && Array.isArray(data.departures)) {
      const insertDeparture = db.prepare(`
        INSERT OR IGNORE INTO departures
        (id, timestamp, autopilot, status, source, vessel_id, vessel_name, origin, destination, route_name, distance, fuel_used, income, wear, duration, cargo, harbor_fee)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const dep of data.departures) {
        const vessel = dep.details?.departedVessels?.[0];
        if (!vessel) continue;

        insertDeparture.run(
          dep.id,
          dep.timestamp,
          dep.autopilot,
          dep.status,
          dep.source,
          vessel.vesselId,
          vessel.name,
          vessel.origin,
          vessel.destination,
          vessel.routeName,
          vessel.distance,
          vessel.fuelUsed,
          vessel.income,
          vessel.wear,
          vessel.duration,
          JSON.stringify(vessel.cargo),
          vessel.harborFee
        );
        stats.departures++;
      }
    }

    // Import route hijacking risks
    if (data.routeHijackRisks) {
      const insertRisk = db.prepare(`
        INSERT OR REPLACE INTO route_hijack_risks (route_key, risk) VALUES (?, ?)
      `);

      for (const [routeKey, risk] of Object.entries(data.routeHijackRisks)) {
        insertRisk.run(routeKey, risk);
        stats.risks++;
      }
    }

    // Save sync progress
    if (data.syncProgress) {
      const insertProgress = db.prepare(`
        INSERT OR REPLACE INTO sync_progress (key, value) VALUES (?, ?)
      `);
      insertProgress.run('status', data.syncProgress.status);
      insertProgress.run('lastVesselIndex', String(data.syncProgress.lastVesselIndex));
      insertProgress.run('vesselIds', JSON.stringify(data.syncProgress.vesselIds));
    }

    // Save metadata
    if (data.lastFullSync) {
      setMetadata(userId, 'vessel_history_last_sync', String(data.lastFullSync));
    }
    if (data.tankerCargoMigrationDone) {
      setMetadata(userId, 'tanker_cargo_migration_done', 'true');
    }
  });

  return stats;
}

/**
 * Import transactions data
 * @param {string} userId - User ID
 * @param {Object} data - Transactions data
 * @returns {Object} Import stats
 */
function importTransactions(userId, data) {
  const stats = { transactions: 0 };

  if (!data.transactions || !Array.isArray(data.transactions)) {
    return stats;
  }

  transaction(userId, () => {
    const db = getDb(userId);

    const insertTx = db.prepare(`
      INSERT OR IGNORE INTO transactions (id, time, context, cash) VALUES (?, ?, ?, ?)
    `);

    for (const tx of data.transactions) {
      insertTx.run(tx.id, tx.time, tx.context, tx.cash);
      stats.transactions++;
    }

    if (data.lastSync) {
      setMetadata(userId, 'transactions_last_sync', String(data.lastSync));
    }
  });

  return stats;
}

/**
 * Import autopilot log data
 * @param {string} userId - User ID
 * @param {Array} data - Log entries array
 * @returns {Object} Import stats
 */
function importAutopilotLog(userId, data) {
  const stats = { logs: 0 };

  if (!Array.isArray(data)) {
    return stats;
  }

  transaction(userId, () => {
    const db = getDb(userId);

    const insertLog = db.prepare(`
      INSERT OR IGNORE INTO autopilot_log (id, timestamp, autopilot, status, summary, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const log of data) {
      insertLog.run(
        log.id,
        log.timestamp,
        log.autopilot,
        log.status,
        log.summary,
        JSON.stringify(log.details)
      );
      stats.logs++;
    }
  });

  return stats;
}

/**
 * Import lookup data
 * @param {string} userId - User ID
 * @param {Object} data - Lookup data
 * @returns {Object} Import stats
 */
function importLookup(userId, data) {
  const stats = { entries: 0 };

  if (!data.entries || !Array.isArray(data.entries)) {
    return stats;
  }

  transaction(userId, () => {
    const db = getDb(userId);

    const insertEntry = db.prepare(`
      INSERT OR IGNORE INTO lookup
      (id, timestamp, pod1_id, pod2_id, pod3_id, pod1_timestamp, pod2_timestamp, pod3_timestamp, pod2_vessel, pod3_vessel, cash, cash_confirmed, type, value, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const entry of data.entries) {
      insertEntry.run(
        entry.id,
        entry.timestamp,
        entry.pod1_id,
        entry.pod2_id,
        entry.pod3_id,
        entry.pod1_timestamp,
        entry.pod2_timestamp,
        entry.pod3_timestamp,
        JSON.stringify(entry.pod2_vessel),
        JSON.stringify(entry.pod3_vessel),
        entry.cash,
        entry.cash_confirmed ? 1 : 0,
        entry.type,
        entry.value,
        entry.context
      );
      stats.entries++;
    }

    if (data.lastSync) {
      setMetadata(userId, 'lookup_last_sync', String(data.lastSync));
    }
    if (data.version) {
      setMetadata(userId, 'lookup_version', String(data.version));
    }
  });

  return stats;
}

/**
 * Import processed DM messages
 * @param {string} userId - User ID
 * @param {Array} data - Array of message ID strings
 * @returns {Object} Import stats
 */
function importProcessedDmMessages(userId, data) {
  const stats = { messages: 0 };

  if (!Array.isArray(data)) {
    return stats;
  }

  transaction(userId, () => {
    const db = getDb(userId);

    const insertMsg = db.prepare(`
      INSERT OR IGNORE INTO processed_dm_messages (message_id) VALUES (?)
    `);

    for (const messageId of data) {
      insertMsg.run(messageId);
      stats.messages++;
    }
  });

  return stats;
}

/**
 * Import trip data (unified or from old separate stores)
 * @param {string} userId - User ID
 * @param {Object} data - Trip data map { "vesselId_timestamp": { ...tripData } }
 * @param {string} dataType - Type of data ('trip-data', 'harbor-fees', 'contributions', 'departure-data')
 * @returns {Object} Import stats
 */
function importTripData(userId, data, dataType) {
  const stats = { trips: 0 };

  if (!data || typeof data !== 'object') {
    return stats;
  }

  transaction(userId, () => {
    const db = getDb(userId);

    // Use UPSERT to merge data from different sources
    const upsertTrip = db.prepare(`
      INSERT INTO trip_data (vessel_id, timestamp, harbor_fee, contribution_gained, speed, guards, co2_used, fuel_used, capacity, utilization, dry_rate, ref_rate, fuel_rate, crude_rate, is_drydock_operation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vessel_id, timestamp) DO UPDATE SET
        harbor_fee = COALESCE(excluded.harbor_fee, trip_data.harbor_fee),
        contribution_gained = COALESCE(excluded.contribution_gained, trip_data.contribution_gained),
        speed = COALESCE(excluded.speed, trip_data.speed),
        guards = COALESCE(excluded.guards, trip_data.guards),
        co2_used = COALESCE(excluded.co2_used, trip_data.co2_used),
        fuel_used = COALESCE(excluded.fuel_used, trip_data.fuel_used),
        capacity = COALESCE(excluded.capacity, trip_data.capacity),
        utilization = COALESCE(excluded.utilization, trip_data.utilization),
        dry_rate = COALESCE(excluded.dry_rate, trip_data.dry_rate),
        ref_rate = COALESCE(excluded.ref_rate, trip_data.ref_rate),
        fuel_rate = COALESCE(excluded.fuel_rate, trip_data.fuel_rate),
        crude_rate = COALESCE(excluded.crude_rate, trip_data.crude_rate),
        is_drydock_operation = COALESCE(excluded.is_drydock_operation, trip_data.is_drydock_operation)
    `);

    for (const [key, value] of Object.entries(data)) {
      // Parse key: "vesselId_timestamp"
      const underscoreIndex = key.indexOf('_');
      if (underscoreIndex === -1) continue;

      const vesselId = parseInt(key.substring(0, underscoreIndex), 10);
      const timestamp = key.substring(underscoreIndex + 1);

      if (isNaN(vesselId)) continue;

      // Handle different data types
      let tripData = {};

      if (dataType === 'harbor-fees') {
        // Old format: value is just the fee number
        tripData.harborFee = value;
      } else if (dataType === 'contributions') {
        // Old format: value is just the contribution number
        tripData.contributionGained = value;
      } else if (dataType === 'departure-data' || dataType === 'trip-data') {
        // Full object
        tripData = value;
      }

      upsertTrip.run(
        vesselId,
        timestamp,
        tripData.harborFee,
        tripData.contributionGained,
        tripData.speed,
        tripData.guards,
        tripData.co2Used,
        tripData.fuelUsed,
        tripData.capacity,
        tripData.utilization,
        tripData.dryRate,
        tripData.refRate,
        tripData.fuelRate,
        tripData.crudeRate,
        tripData.isDrydockOperation ? 1 : 0
      );
      stats.trips++;
    }
  });

  return stats;
}

/**
 * Import messenger cache data
 * @param {string} userId - User ID
 * @param {Object} data - Messenger cache data { chats: { chatId: { messages, metadata } }, chatList, chatListUpdated }
 * @returns {Object} Import stats
 */
function importMessengerCache(userId, data) {
  const stats = { chats: 0, messages: 0 };

  if (!data || !data.chats) {
    return stats;
  }

  transaction(userId, () => {
    const db = getDb(userId);

    const insertChat = db.prepare(`
      INSERT OR REPLACE INTO messenger_chats (chat_id, subject, is_new, message_count, last_message_at, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMessage = db.prepare(`
      INSERT OR IGNORE INTO messenger_messages (chat_id, body, is_mine, sender_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const [chatId, chatData] of Object.entries(data.chats)) {
      const messages = chatData.messages || [];
      const metadata = chatData.metadata || {};
      const lastUpdated = chatData.lastUpdated || Date.now();

      // Find last message timestamp
      let lastMessageAt = 0;
      if (messages.length > 0) {
        lastMessageAt = Math.max(...messages.map(m => m.created_at || 0));
      }

      // Insert chat metadata
      insertChat.run(
        parseInt(chatId, 10),
        metadata.subject,
        metadata.isNew ? 1 : 0,
        messages.length,
        lastMessageAt,
        JSON.stringify(metadata),
        Math.floor(lastUpdated / 1000)
      );
      stats.chats++;

      // Insert messages
      for (const msg of messages) {
        insertMessage.run(
          parseInt(chatId, 10),
          msg.body,
          msg.is_mine ? 1 : 0,
          msg.user_id,
          msg.created_at
        );
        stats.messages++;
      }
    }
  });

  return stats;
}

/**
 * Import vessel appearance from JSON file
 * @param {string} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {Object} data - Vessel appearance data
 * @returns {Object} Import stats
 */
function importVesselAppearance(userId, vesselId, data) {
  const stats = { appearances: 0 };

  transaction(userId, () => {
    const db = getDb(userId);

    // Convert undefined to null for SQLite compatibility
    const toNull = (v) => v === undefined ? null : v;

    db.prepare(`
      INSERT OR REPLACE INTO vessel_appearances
      (vessel_id, name, vessel_model, capacity, engine_type, engine_kw, range, speed, fuel_consumption, antifouling_model, bulbous, enhanced_thrusters, propeller_types, hull_color, deck_color, bridge_color, container_color_1, container_color_2, container_color_3, container_color_4, name_color, own_image, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vesselId,
      toNull(data.name),
      toNull(data.vessel_model),
      toNull(data.capacity),
      toNull(data.engine_type),
      toNull(data.engine_kw),
      toNull(data.range),
      toNull(data.speed),
      toNull(data.fuel_consumption),
      toNull(data.antifouling_model),
      data.bulbous ? 1 : 0,
      data.enhanced_thrusters ? 1 : 0,
      toNull(data.propeller_types),
      toNull(data.hull_color),
      toNull(data.deck_color),
      toNull(data.bridge_color),
      toNull(data.container_color_1),
      toNull(data.container_color_2),
      toNull(data.container_color_3),
      toNull(data.container_color_4),
      toNull(data.name_color),
      data.ownImage ? 1 : 0,
      Math.floor(Date.now() / 1000)
    );
    stats.appearances++;
  });

  return stats;
}

/**
 * Import hijack history from JSON file
 * @param {string} userId - User ID
 * @param {number} caseId - Hijack case ID
 * @param {Object|Array} data - Hijack case data from JSON file (can be array for old format)
 * @returns {Object} Import stats
 */
function importHijackCase(userId, caseId, data) {
  const stats = { cases: 0, events: 0 };

  transaction(userId, () => {
    const db = getDb(userId);

    // Handle old format: data is just an array of history events
    // Old format: [{type, amount, timestamp}, ...]
    // New format: {case_details: {...}, history: [...], ...}
    const isOldFormat = Array.isArray(data);
    const historyEvents = isOldFormat ? data : (data.history || []);
    const caseDetails = isOldFormat ? null : data.case_details;

    // For old format, get requested_amount from first pirate offer
    const firstPirateOffer = historyEvents.find(e => e.type === 'pirate');
    const requestedAmount = isOldFormat
      ? (firstPirateOffer?.amount || null)
      : (caseDetails?.requested_amount || null);

    // Insert main case record (IGNORE if already exists - don't overwrite API data)
    const insertCase = db.prepare(`
      INSERT OR IGNORE INTO hijack_cases
      (case_id, user_vessel_id, vessel_name, danger_zone_slug, requested_amount, paid_amount, user_proposal, has_negotiation, round_end_time, status, registered_at, resolved, autopilot_resolved, resolved_at, cash_before, cash_after, payment_verified, case_details_json, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertCase.run(
      caseId,
      isOldFormat ? null : data.user_vessel_id,
      isOldFormat ? null : data.vessel_name,
      caseDetails?.danger_zone_slug,
      requestedAmount,
      isOldFormat ? null : (caseDetails?.paid_amount || data.payment_verification?.actual_paid),
      caseDetails?.user_proposal,
      caseDetails?.has_negotiation,
      caseDetails?.round_end_time,
      isOldFormat ? 'unknown' : (data.final_status || caseDetails?.status || 'unknown'),
      caseDetails?.registered_at,
      isOldFormat ? 0 : (data.resolved ? 1 : 0),
      isOldFormat ? 0 : (data.autopilot_resolved ? 1 : 0),
      isOldFormat ? null : data.resolved_at,
      isOldFormat ? null : data.payment_verification?.cash_before,
      isOldFormat ? null : data.payment_verification?.cash_after,
      isOldFormat ? 0 : (data.payment_verification?.verified ? 1 : 0),
      isOldFormat ? null : JSON.stringify(caseDetails),
      isOldFormat ? Date.now() : data.cached_at
    );
    stats.cases++;

    // Insert negotiation history events
    if (historyEvents.length > 0) {
      const insertEvent = db.prepare(`
        INSERT OR IGNORE INTO hijack_history (case_id, type, amount, timestamp) VALUES (?, ?, ?, ?)
      `);

      for (const event of historyEvents) {
        insertEvent.run(caseId, event.type, event.amount, event.timestamp);
        stats.events++;
      }
    }
  });

  return stats;
}

/**
 * Run migration for a specific user
 * Imports data to SQLite (if not done) AND moves remaining JSON files to olddata
 * @param {string} userId - User ID
 * @returns {Object} Migration results
 */
function migrateUser(userId) {
  const migrationAlreadyComplete = isMigrationComplete(userId);

  // Always check for remaining JSON files to move (cleanup)
  const jsonFiles = findUserJsonFiles(userId);
  const hijackFiles = findUserHijackFiles(userId);
  const vesselAppearanceFiles = findUserVesselAppearanceFiles(userId);
  const totalFiles = jsonFiles.length + hijackFiles.length + vesselAppearanceFiles.length;

  // If migration done AND no files left, skip entirely
  if (migrationAlreadyComplete && totalFiles === 0) {
    logger.debug(`[Migration] Already complete for user ${userId}, no cleanup needed`);
    return { alreadyComplete: true };
  }

  // If migration was done but files still exist, we need to import them first
  // This happens when new data types are added after initial migration
  if (migrationAlreadyComplete && totalFiles > 0) {
    logger.info(`[Migration] Found ${totalFiles} files after migration was marked complete - importing and moving...`);
    // Fall through to normal migration logic below (don't return early)
  }

  logger.info(`[Migration] Starting migration for user ${userId}`);
  const results = {
    userId,
    files: [],
    totals: {
      vessels: 0,
      departures: 0,
      transactions: 0,
      logs: 0,
      lookupEntries: 0,
      risks: 0,
      dmMessages: 0,
      trips: 0,
      hijackCases: 0,
      hijackEvents: 0,
      messengerChats: 0,
      messengerMessages: 0,
      vesselAppearances: 0
    }
  };

  // Step 1: Repair any corrupted JSON files BEFORE attempting import
  logger.info(`[Migration] Repairing corrupted JSON files for user ${userId}...`);
  const userdataDir = getUserdataDir();
  const repairResults = repairAllUserFiles(userId, userdataDir);
  if (repairResults.repaired > 0) {
    logger.info(`[Migration] Repaired ${repairResults.repaired} corrupted files`);
  }
  if (repairResults.failed > 0) {
    logger.warn(`[Migration] ${repairResults.failed} files could not be repaired`);
  }

  // Step 2: Import JSON files (already found at top of function)
  logger.info(`[Migration] Found ${jsonFiles.length} JSON files to migrate`);

  for (const fileInfo of jsonFiles) {
    const fileResult = { type: fileInfo.type, path: fileInfo.path, success: false };

    try {
      const content = fs.readFileSync(fileInfo.path, 'utf8');
      const data = safeParseJson(content, fileInfo.path);

      if (!data) {
        fileResult.error = 'Failed to parse JSON';
        results.files.push(fileResult);
        continue;
      }

      let stats = {};

      switch (fileInfo.type) {
        case 'vessel-history':
          stats = importVesselHistory(userId, data);
          results.totals.vessels += stats.vessels;
          results.totals.departures += stats.departures;
          results.totals.risks += stats.risks;
          break;

        case 'transactions':
          stats = importTransactions(userId, data);
          results.totals.transactions += stats.transactions;
          break;

        case 'autopilot-log':
          stats = importAutopilotLog(userId, data);
          results.totals.logs += stats.logs;
          break;

        case 'lookup':
          stats = importLookup(userId, data);
          results.totals.lookupEntries += stats.entries;
          break;

        case 'processed-dm-messages':
          stats = importProcessedDmMessages(userId, data);
          results.totals.dmMessages += stats.messages;
          break;

        case 'trip-data':
        case 'harbor-fees':
        case 'contributions':
        case 'departure-data':
          stats = importTripData(userId, data, fileInfo.type);
          results.totals.trips += stats.trips;
          break;

        case 'messenger-cache':
          stats = importMessengerCache(userId, data);
          results.totals.messengerChats += stats.chats;
          results.totals.messengerMessages += stats.messages;
          break;
      }

      fileResult.success = true;
      fileResult.stats = stats;

      // Move to olddata folder
      moveToOldData(fileInfo.path);

    } catch (err) {
      fileResult.error = err.message;
      logger.error(`[Migration] Error processing ${fileInfo.path}:`, err.message);
    }

    results.files.push(fileResult);
  }

  // Step 3: Import hijack history files (already found at top of function)
  if (hijackFiles.length > 0) {
    logger.info(`[Migration] Found ${hijackFiles.length} hijack history files to migrate`);

    for (const hijackFile of hijackFiles) {
      const fileResult = { type: 'hijack-history', path: hijackFile.path, caseId: hijackFile.caseId, success: false };

      try {
        const content = fs.readFileSync(hijackFile.path, 'utf8');
        const data = safeParseJson(content, hijackFile.path);

        if (!data) {
          fileResult.error = 'Failed to parse JSON';
          results.files.push(fileResult);
          continue;
        }

        const stats = importHijackCase(userId, hijackFile.caseId, data);
        results.totals.hijackCases += stats.cases;
        results.totals.hijackEvents += stats.events;

        fileResult.success = true;
        fileResult.stats = stats;

        // Move to olddata folder
        moveToOldData(hijackFile.path);

      } catch (err) {
        fileResult.error = err.message;
        logger.error(`[Migration] Error processing hijack case ${hijackFile.caseId}:`, err.message);
      }

      results.files.push(fileResult);
    }
  }

  // Step 4: Import vessel appearance files (already found at top of function)
  if (vesselAppearanceFiles.length > 0) {
    logger.info(`[Migration] Found ${vesselAppearanceFiles.length} vessel appearance files to migrate`);

    for (const appearanceFile of vesselAppearanceFiles) {
      const fileResult = { type: 'vessel-appearance', path: appearanceFile.path, vesselId: appearanceFile.vesselId, success: false };

      try {
        const content = fs.readFileSync(appearanceFile.path, 'utf8');
        const data = safeParseJson(content, appearanceFile.path);

        if (!data) {
          fileResult.error = 'Failed to parse JSON';
          results.files.push(fileResult);
          continue;
        }

        const stats = importVesselAppearance(userId, appearanceFile.vesselId, data);
        results.totals.vesselAppearances += stats.appearances;

        fileResult.success = true;
        fileResult.stats = stats;

        // Move to olddata folder
        moveToOldData(appearanceFile.path);

      } catch (err) {
        fileResult.error = err.message;
        logger.error(`[Migration] Error processing vessel appearance ${appearanceFile.vesselId}:`, err.message);
      }

      results.files.push(fileResult);
    }
  }

  // Mark migration as complete
  markMigrationComplete(userId);

  logger.info(`[Migration] Completed for user ${userId}:`, JSON.stringify(results.totals));
  return results;
}

/**
 * Find all users with JSON data files
 * @returns {string[]} Array of user IDs
 */
function findAllUsersWithData() {
  const userdataDir = getUserdataDir();
  const legacyDirs = getLegacyOlduserdataDirs();
  const userIds = new Set();

  // Check each data directory for user files (both current and legacy)
  const dataDirs = ['vessel-history', 'transactions', 'analytics'];
  const baseDirs = [userdataDir];
  for (const legacyDir of legacyDirs) {
    if (fs.existsSync(legacyDir)) {
      baseDirs.push(legacyDir);
    }
  }

  for (const baseDir of baseDirs) {
    for (const dir of dataDirs) {
      const fullPath = path.join(baseDir, dir);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const files = fs.readdirSync(fullPath);
        for (const file of files) {
          // Only process JSON files (migrated files are moved to olddata folder)
          if (!file.endsWith('.json')) continue;

          // Extract user ID from filename (e.g., "1234567-vessel-history.json" -> "1234567")
          const match = file.match(/^(\d+)-/);
          if (match) {
            userIds.add(match[1]);
          }
        }
      } catch (err) {
        logger.error(`[Migration] Error scanning ${fullPath}:`, err.message);
      }
    }
  }

  return Array.from(userIds);
}

/**
 * Run migration for all users with data
 * @returns {Object} Migration results for all users
 */
function migrateAll() {
  logger.info('[Migration] Starting migration for all users...');

  const userIds = findAllUsersWithData();
  logger.info(`[Migration] Found ${userIds.length} users with data to migrate`);

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
      const userResult = migrateUser(userId);

      if (userResult.alreadyComplete) {
        results.summary.skipped++;
      } else {
        results.summary.migrated++;
      }

      results.users.push({ userId, ...userResult });
    } catch (err) {
      logger.error(`[Migration] Failed for user ${userId}:`, err.message);
      results.summary.failed++;
      results.users.push({ userId, error: err.message });
    }
  }

  logger.info(`[Migration] All users complete: ${results.summary.migrated} migrated, ${results.summary.skipped} skipped, ${results.summary.failed} failed`);
  return results;
}

module.exports = {
  migrateUser,
  migrateAll,
  findAllUsersWithData,
  findUserJsonFiles,
  getUserdataDir
};
