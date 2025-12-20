/**
 * @fileoverview Alliance Indexer Service
 *
 * Indexes all alliances from the game API for search functionality.
 *
 * Features:
 * - File-based persistent cache (userdata/cache/alliance_pool.json)
 * - Fast startup by loading from cache file
 * - Background refresh cycle (all alliances over 1 hour)
 * - Search and filter capabilities
 * - WebSocket notification when ready
 *
 * @module server/services/alliance-indexer
 */

const { apiCall } = require('../utils/api');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const { getAppBaseDir, isPackaged } = require('../config');
const allianceCache = require('../database/alliance-cache');

// Legacy JSON path (for initial migration only)
const isPkg = isPackaged();
const CACHE_FILE_PATH = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'cache', 'alliance_pool.json')
  : path.join(__dirname, '..', '..', 'userdata', 'cache', 'alliance_pool.json');

class AllianceIndexer {
  constructor() {
    this.isIndexing = false;
    this.isReady = false;
    this.lastUpdate = null;
    this.totalAlliances = 0;
    this.cacheFilePath = CACHE_FILE_PATH;

    // Background refresh settings
    this.refreshInterval = null;
    this.REFRESH_CYCLE_DURATION = 60 * 60 * 1000; // 1 hour
    this.PAGE_SIZE = 50;
    this.currentRefreshPage = 0;
  }

  /**
   * Start indexer (called from app.js)
   */
  async start() {
    logger.info('[AllianceIndexer] Starting...');

    // Check SQLite cache first
    const sqliteCount = allianceCache.getCount();
    if (sqliteCount > 0) {
      this.totalAlliances = sqliteCount;
      this.lastUpdate = allianceCache.getLastUpdate();
      this.isReady = true;
      logger.info(`[AllianceIndexer] Loaded ${this.totalAlliances} alliances from SQLite cache`);
    } else {
      // Try to migrate from JSON file
      try {
        await fs.access(this.cacheFilePath);
        logger.info('[AllianceIndexer] Migrating from JSON to SQLite...');
        const result = allianceCache.importFromJson(this.cacheFilePath);
        if (result.imported > 0) {
          this.totalAlliances = result.imported;
          this.lastUpdate = allianceCache.getLastUpdate();
          this.isReady = true;
          logger.info(`[AllianceIndexer] Migrated ${result.imported} alliances to SQLite`);
          // Rename old JSON file
          await fs.rename(this.cacheFilePath, this.cacheFilePath + '.migrated');
          logger.info('[AllianceIndexer] Old JSON file renamed to .migrated');
        } else {
          logger.info('[AllianceIndexer] JSON migration failed, building fresh index...');
          await this.initialIndex();
        }
      } catch {
        logger.info('[AllianceIndexer] No cache found, building index...');
        await this.initialIndex();
      }
    }

    this.startBackgroundRefresh();
  }

  /**
   * Load alliances from SQLite cache
   */
  async loadFromCache() {
    try {
      this.totalAlliances = allianceCache.getCount();
      this.lastUpdate = allianceCache.getLastUpdate();
      logger.info(`[AllianceIndexer] Cache loaded: ${this.totalAlliances} alliances, last update: ${this.lastUpdate}`);
    } catch (error) {
      logger.error('[AllianceIndexer] Failed to load cache:', error.message);
      throw error;
    }
  }

  /**
   * Save alliances to SQLite cache
   */
  async saveToCache(alliances) {
    try {
      const count = allianceCache.bulkUpdate(alliances);
      this.totalAlliances = allianceCache.getCount();
      this.lastUpdate = new Date().toISOString();

      // Store last update in meta
      const db = allianceCache.getDb();
      db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run('last_update', this.lastUpdate);

      logger.debug(`[AllianceIndexer] Cache saved: ${count} alliances updated`);
    } catch (error) {
      logger.error('[AllianceIndexer] Failed to save cache:', error.message);
      throw error;
    }
  }

  /**
   * Initial indexing with auto-retry
   */
  async initialIndex() {
    const maxRetries = 5;
    let retries = 0;

    while (retries < maxRetries && !this.isReady) {
      try {
        logger.info(`[AllianceIndexer] Starting initial indexing (attempt ${retries + 1}/${maxRetries})...`);

        const alliances = await this.fetchAllAlliances();
        await this.saveToCache(alliances);

        this.isReady = true;
        logger.info(`[AllianceIndexer] Initial indexing complete: ${this.totalAlliances} alliances`);

        const { broadcast } = require('../websocket/broadcaster');
        broadcast('alliance_index_ready', {
          total: this.totalAlliances,
          timestamp: this.lastUpdate
        });

        break;
      } catch (error) {
        retries++;
        logger.error(`[AllianceIndexer] Initial indexing failed (attempt ${retries}/${maxRetries}):`, error.message);

        if (retries < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, retries), 30000);
          logger.info(`[AllianceIndexer] Retrying in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error('[AllianceIndexer] Max retries reached. Alliance search will be unavailable.');
        }
      }
    }
  }

  /**
   * Fetch all alliances from API
   * Fetches across all supported languages to get complete alliance list
   */
  async fetchAllAlliances() {
    this.isIndexing = true;

    const languages = [
      'en-GB', 'da-DK', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pl-PL', 'tr-TR',
      'ru-RU', 'ar-SA', 'nl-NL', 'pt-BR', 'pt-PT', 'zh-CN', 'id-ID', 'ja-JP',
      'ms-MY', 'ko-KR', 'th-TH'
    ];

    const allianceMap = new Map();
    let totalFetched = 0;

    logger.info(`[AllianceIndexer] Fetching alliances for ${languages.length} languages...`);

    for (let langIndex = 0; langIndex < languages.length; langIndex++) {
      const language = languages[langIndex];
      let offset = 0;
      const limit = this.PAGE_SIZE;
      let page = 1;
      let langTotal = 0;

      logger.info(`[AllianceIndexer] Language ${langIndex + 1}/${languages.length}: ${language}`);

      while (true) {
        try {
          const response = await apiCall('/alliance/get-open-alliances', 'POST', {
            limit: limit,
            offset: offset,
            filter: 'all',
            language: language
          });

          if (!response || !response.data || !response.data.alliances) {
            break;
          }

          const alliances = response.data.alliances;

          if (alliances.length === 0) {
            break;
          }

          alliances.forEach(alliance => {
            if (alliance.members > 0) {
              allianceMap.set(alliance.id, alliance);
            }
          });

          langTotal += alliances.length;
          totalFetched += alliances.length;

          logger.debug(`[AllianceIndexer] ${language} page ${page}: ${alliances.length} alliances (lang total: ${langTotal}, unique: ${allianceMap.size})`);

          offset += limit;
          page++;

          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error(`[AllianceIndexer] Error fetching ${language} page ${page}:`, error.message);
          throw error;
        }
      }

      logger.info(`[AllianceIndexer] ${language} complete: ${langTotal} alliances fetched (unique total: ${allianceMap.size})`);
    }

    const alliances = Array.from(allianceMap.values());
    this.isIndexing = false;

    logger.info(`[AllianceIndexer] All languages complete: ${totalFetched} total fetched, ${alliances.length} unique alliances`);

    return alliances;
  }

  /**
   * Start background refresh cycle
   * Refreshes all alliances over 1 hour (distributed evenly)
   */
  startBackgroundRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    const totalPages = Math.ceil(6400 / this.PAGE_SIZE);
    const intervalPerPage = this.REFRESH_CYCLE_DURATION / totalPages;

    logger.info(`[AllianceIndexer] Starting background refresh: ${totalPages} pages, ${Math.round(intervalPerPage/1000)}s per page`);

    this.refreshInterval = setInterval(async () => {
      if (this.isIndexing || !this.isReady) {
        return;
      }

      try {
        const offset = this.currentRefreshPage * this.PAGE_SIZE;

        const response = await apiCall('/alliance/get-open-alliances', 'POST', {
          limit: this.PAGE_SIZE,
          offset: offset,
          filter: 'all'
        });

        if (response && response.data && response.data.alliances) {
          const freshAlliances = response.data.alliances;

          // Update SQLite cache directly
          const validAlliances = freshAlliances.filter(a => a.members > 0);
          if (validAlliances.length > 0) {
            allianceCache.bulkUpdate(validAlliances);
          }

          // Remove alliances with 0 members
          const emptyAlliances = freshAlliances.filter(a => a.members === 0);
          emptyAlliances.forEach(a => {
            allianceCache.deleteAlliance(a.id);
          });

          this.totalAlliances = allianceCache.getCount();

          logger.debug(`[AllianceIndexer] Refreshed page ${this.currentRefreshPage + 1}/${totalPages} (${freshAlliances.length} alliances)`);
        }

        this.currentRefreshPage++;
        if (this.currentRefreshPage >= totalPages) {
          this.currentRefreshPage = 0;
          logger.info('[AllianceIndexer] Background refresh cycle complete');
        }
      } catch (error) {
        logger.error(`[AllianceIndexer] Error refreshing page ${this.currentRefreshPage}:`, error.message);
      }
    }, intervalPerPage);
  }

  /**
   * Search alliances with filters
   * @param {string} query - Search query (name or description)
   * @param {Object} filters - Filter options
   * @returns {Object} Search results
   */
  async search(query, filters = {}) {
    if (!this.isReady) {
      return {
        results: [],
        total: 0,
        ready: false
      };
    }

    try {
      // Use SQLite search - filtering and sorting is handled by SQLite
      const results = allianceCache.search(query, filters);

      return {
        results,
        total: results.length,
        ready: true,
        lastUpdate: this.lastUpdate
      };
    } catch (error) {
      logger.error('[AllianceIndexer] Error reading cache for search:', error.message);
      return {
        results: [],
        total: 0,
        ready: false
      };
    }
  }

  /**
   * Get indexer status
   */
  getStatus() {
    return {
      isReady: this.isReady,
      isIndexing: this.isIndexing,
      totalAlliances: this.totalAlliances,
      lastUpdate: this.lastUpdate
    };
  }

  /**
   * Get available languages from indexed alliances
   */
  async getAvailableLanguages() {
    if (!this.isReady) {
      logger.warn('[AllianceIndexer] getAvailableLanguages called but indexer not ready');
      return [];
    }

    try {
      const db = allianceCache.getDb();
      const rows = db.prepare('SELECT DISTINCT language FROM alliances WHERE language IS NOT NULL ORDER BY language').all();
      const result = rows.map(r => r.language);
      logger.info(`[AllianceIndexer] getAvailableLanguages returning ${result.length} languages`);
      return result;
    } catch (error) {
      logger.error('[AllianceIndexer] Error reading languages:', error.message);
      return [];
    }
  }

  /**
   * Get alliance by ID from cache
   * @param {number} allianceId - Alliance ID to lookup
   * @returns {Object|null} Alliance object or null if not found
   */
  async getById(allianceId) {
    if (!this.isReady) {
      return null;
    }

    try {
      return allianceCache.getById(allianceId);
    } catch (error) {
      logger.error('[AllianceIndexer] Error looking up alliance by ID:', error.message);
      return null;
    }
  }

  /**
   * Stop indexer
   */
  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    logger.info('[AllianceIndexer] Stopped');
  }
}

// Singleton instance
const indexer = new AllianceIndexer();

module.exports = indexer;
