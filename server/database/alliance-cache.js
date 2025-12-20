/**
 * @fileoverview Alliance Pool SQLite Cache
 *
 * Fast searchable cache for alliance data.
 * Replaces alliance_pool.json with SQLite for faster queries.
 *
 * @module server/database/alliance-cache
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getAppBaseDir, isPackaged } = require('../config');

// Get native binding path for better-sqlite3
// In packaged mode, the .node file is in node_modules relative to app base dir
function getNativeBindingPath() {
  const isPkg = isPackaged();
  if (isPkg) {
    return path.join(getAppBaseDir(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  }
  return undefined;
}

const nativeBinding = getNativeBindingPath();
const Database = require('better-sqlite3');

let db = null;

/**
 * Get database path
 * @returns {string} Path to alliance cache database
 */
function getDbPath() {
  const isPkg = isPackaged();
  const baseDir = isPkg
    ? path.join(getAppBaseDir(), 'userdata', 'database')
    : path.join(__dirname, '..', '..', 'userdata', 'database');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  return path.join(baseDir, 'alliance_cache.db');
}

/**
 * Get or create database connection
 * @returns {Database} SQLite database instance
 */
function getDb() {
  if (db) return db;

  const dbPath = getDbPath();
  const dbOptions = nativeBinding ? { nativeBinding } : {};
  db = new Database(dbPath, dbOptions);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create schema with all fields used by alliance-indexer
  db.exec(`
    CREATE TABLE IF NOT EXISTS alliances (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      tag TEXT,
      description TEXT,
      language TEXT,
      members INTEGER DEFAULT 0,
      benefit_level INTEGER DEFAULT 0,
      contribution_score_24h INTEGER DEFAULT 0,
      departures_24h INTEGER DEFAULT 0,
      income_24h INTEGER DEFAULT 0,
      distance_24h INTEGER DEFAULT 0,
      data_json TEXT,
      updated_at INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_alliance_name ON alliances(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_alliance_tag ON alliances(tag COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_alliance_members ON alliances(members DESC);
    CREATE INDEX IF NOT EXISTS idx_alliance_contribution ON alliances(contribution_score_24h DESC);
    CREATE INDEX IF NOT EXISTS idx_alliance_benefit ON alliances(benefit_level DESC);
    CREATE INDEX IF NOT EXISTS idx_alliance_language ON alliances(language);

    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS ipo_tracking (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      highest_seen_user_id INTEGER DEFAULT 0,
      seen_ipo_user_ids_json TEXT DEFAULT '[]'
    );
  `);

  // Ensure ipo_tracking has exactly one row
  db.prepare('INSERT OR IGNORE INTO ipo_tracking (id) VALUES (1)').run();

  logger.info('[AllianceCache] Database initialized');
  return db;
}

/**
 * Close database connection
 */
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Import alliances from JSON file
 * @param {string} jsonPath - Path to alliance_pool.json
 * @returns {{imported: number, updated: number}} Import stats
 */
function importFromJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    logger.warn('[AllianceCache] JSON file not found:', jsonPath);
    return { imported: 0, updated: 0 };
  }

  const database = getDb();
  let data;

  try {
    const content = fs.readFileSync(jsonPath, 'utf8');
    data = JSON.parse(content);
  } catch (err) {
    logger.error('[AllianceCache] Failed to parse JSON:', err.message);
    return { imported: 0, updated: 0, error: err.message };
  }

  if (!data.alliances || !Array.isArray(data.alliances)) {
    logger.warn('[AllianceCache] No alliances array in JSON');
    return { imported: 0, updated: 0 };
  }

  logger.info(`[AllianceCache] Importing ${data.alliances.length} alliances...`);

  const upsert = database.prepare(`
    INSERT INTO alliances (id, name, tag, description, language, members, benefit_level,
                          contribution_score_24h, departures_24h, income_24h, distance_24h, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      tag = excluded.tag,
      description = excluded.description,
      language = excluded.language,
      members = excluded.members,
      benefit_level = excluded.benefit_level,
      contribution_score_24h = excluded.contribution_score_24h,
      departures_24h = excluded.departures_24h,
      income_24h = excluded.income_24h,
      distance_24h = excluded.distance_24h,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `);

  const now = Date.now();
  let imported = 0;

  const insertMany = database.transaction((alliances) => {
    for (const a of alliances) {
      upsert.run(
        a.id,
        a.name,
        a.tag,
        a.description,
        a.language,
        a.members,
        a.benefit_level,
        a.stats?.contribution_score_24h,
        a.stats?.departures_24h,
        a.stats?.income_24h,
        a.stats?.distance_24h,
        JSON.stringify(a),
        now
      );
      imported++;
    }
  });

  insertMany(data.alliances);

  // Save metadata
  database.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run('last_import', String(now));
  database.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run('alliance_count', String(imported));
  if (data.lastUpdate) {
    database.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run('last_update', data.lastUpdate);
  }

  logger.info(`[AllianceCache] Imported ${imported} alliances`);
  return { imported, updated: 0 };
}

/**
 * Search alliances with filters (matches alliance-indexer API)
 * @param {string} query - Search query
 * @param {Object} filters - Filter options
 * @returns {Array} Matching alliances as full objects
 */
function search(query, filters = {}) {
  const database = getDb();

  let sql = 'SELECT data_json FROM alliances WHERE 1=1';
  const params = [];

  // Text search on name or description
  if (query && query.trim().length > 0) {
    sql += ' AND (name LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE)';
    const searchTerm = `%${query}%`;
    params.push(searchTerm, searchTerm);
  }

  // Filter by language
  if (filters.language) {
    sql += ' AND language = ?';
    params.push(filters.language);
  }

  // Filter by member count
  if (filters.minMembers !== undefined) {
    sql += ' AND members >= ?';
    params.push(filters.minMembers);
  }
  if (filters.maxMembers !== undefined) {
    sql += ' AND members <= ?';
    params.push(filters.maxMembers);
  }

  // Filter by benefit level
  if (filters.benefitLevel !== undefined) {
    sql += ' AND benefit_level = ?';
    params.push(filters.benefitLevel);
  }

  // Filter: has open slots
  if (filters.hasOpenSlots) {
    sql += ' AND members < 50';
  }

  // Sorting
  const sortBy = filters.sortBy || 'name_asc';
  switch (sortBy) {
    case 'name_asc':
      sql += ' ORDER BY name COLLATE NOCASE ASC';
      break;
    case 'name_desc':
      sql += ' ORDER BY name COLLATE NOCASE DESC';
      break;
    case 'members_desc':
      sql += ' ORDER BY members DESC';
      break;
    case 'members_asc':
      sql += ' ORDER BY members ASC';
      break;
    case 'contribution_desc':
      sql += ' ORDER BY contribution_score_24h DESC';
      break;
    case 'contribution_asc':
      sql += ' ORDER BY contribution_score_24h ASC';
      break;
    case 'departures_desc':
      sql += ' ORDER BY departures_24h DESC';
      break;
    case 'departures_asc':
      sql += ' ORDER BY departures_24h ASC';
      break;
    default:
      sql += ' ORDER BY name COLLATE NOCASE ASC';
  }

  // Limit
  const limit = filters.limit || 100;
  sql += ' LIMIT ?';
  params.push(limit);

  const rows = database.prepare(sql).all(...params);

  // Parse JSON and return full alliance objects
  return rows.map(row => JSON.parse(row.data_json));
}

/**
 * Get alliance by ID
 * @param {number} allianceId - Alliance ID
 * @returns {Object|null} Alliance or null
 */
function getById(allianceId) {
  const database = getDb();
  const row = database.prepare('SELECT data_json FROM alliances WHERE id = ?').get(allianceId);
  return row ? JSON.parse(row.data_json) : null;
}

/**
 * Get all alliances
 * @returns {Array} All alliances
 */
function getAll() {
  const database = getDb();
  const rows = database.prepare('SELECT data_json FROM alliances ORDER BY contribution_score_24h DESC').all();
  return rows.map(row => JSON.parse(row.data_json));
}

/**
 * Get top alliances by contribution
 * @param {number} limit - Max results
 * @returns {Array} Top alliances
 */
function getTopByContribution(limit = 100) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT data_json FROM alliances
    ORDER BY contribution_score_24h DESC
    LIMIT ?
  `).all(limit);
  return rows.map(row => JSON.parse(row.data_json));
}

/**
 * Get total alliance count
 * @returns {number} Total count
 */
function getCount() {
  const database = getDb();
  const row = database.prepare('SELECT COUNT(*) as count FROM alliances').get();
  return row.count;
}

/**
 * Get last update timestamp from meta
 * @returns {string|null} Last update ISO string or null
 */
function getLastUpdate() {
  const database = getDb();
  const row = database.prepare('SELECT value FROM cache_meta WHERE key = ?').get('last_update');
  return row ? row.value : null;
}

/**
 * Update or insert a single alliance
 * @param {Object} alliance - Alliance data
 */
function upsertAlliance(alliance) {
  const database = getDb();
  database.prepare(`
    INSERT INTO alliances (id, name, tag, description, language, members, benefit_level,
                          contribution_score_24h, departures_24h, income_24h, distance_24h, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      tag = excluded.tag,
      description = excluded.description,
      language = excluded.language,
      members = excluded.members,
      benefit_level = excluded.benefit_level,
      contribution_score_24h = excluded.contribution_score_24h,
      departures_24h = excluded.departures_24h,
      income_24h = excluded.income_24h,
      distance_24h = excluded.distance_24h,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(
    alliance.id,
    alliance.name,
    alliance.tag,
    alliance.description,
    alliance.language,
    alliance.members,
    alliance.benefit_level,
    alliance.stats?.contribution_score_24h,
    alliance.stats?.departures_24h,
    alliance.stats?.income_24h,
    alliance.stats?.distance_24h,
    JSON.stringify(alliance),
    Date.now()
  );
}

/**
 * Bulk update alliances
 * @param {Array} alliances - Array of alliance objects
 * @returns {number} Number updated
 */
function bulkUpdate(alliances) {
  const database = getDb();

  const upsert = database.prepare(`
    INSERT INTO alliances (id, name, tag, description, language, members, benefit_level,
                          contribution_score_24h, departures_24h, income_24h, distance_24h, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      tag = excluded.tag,
      description = excluded.description,
      language = excluded.language,
      members = excluded.members,
      benefit_level = excluded.benefit_level,
      contribution_score_24h = excluded.contribution_score_24h,
      departures_24h = excluded.departures_24h,
      income_24h = excluded.income_24h,
      distance_24h = excluded.distance_24h,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `);

  const now = Date.now();
  let count = 0;

  const updateMany = database.transaction((items) => {
    for (const a of items) {
      upsert.run(
        a.id,
        a.name,
        a.tag,
        a.description,
        a.language,
        a.members,
        a.benefit_level,
        a.stats?.contribution_score_24h,
        a.stats?.departures_24h,
        a.stats?.income_24h,
        a.stats?.distance_24h,
        JSON.stringify(a),
        now
      );
      count++;
    }
  });

  updateMany(alliances);
  return count;
}

/**
 * Get cache statistics
 * @returns {Object} Cache stats
 */
function getStats() {
  const database = getDb();

  const count = database.prepare('SELECT COUNT(*) as count FROM alliances').get();
  const lastImport = database.prepare('SELECT value FROM cache_meta WHERE key = ?').get('last_import');

  return {
    allianceCount: count.count,
    lastImport: lastImport ? parseInt(lastImport.value, 10) : null,
    lastImportDate: lastImport ? new Date(parseInt(lastImport.value, 10)).toISOString() : null
  };
}

/**
 * Delete an alliance by ID
 * @param {number} allianceId - Alliance ID to delete
 */
function deleteAlliance(allianceId) {
  const database = getDb();
  database.prepare('DELETE FROM alliances WHERE id = ?').run(allianceId);
}

/**
 * Clear all cached alliances
 */
function clearCache() {
  const database = getDb();
  database.exec('DELETE FROM alliances');
  database.exec('DELETE FROM cache_meta');
  logger.info('[AllianceCache] Cache cleared');
}

module.exports = {
  getDb,
  closeDb,
  importFromJson,
  search,
  getById,
  getAll,
  getTopByContribution,
  getCount,
  getLastUpdate,
  upsertAlliance,
  bulkUpdate,
  getStats,
  deleteAlliance,
  clearCache
};
