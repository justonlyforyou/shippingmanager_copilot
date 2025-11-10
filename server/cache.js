/**
 * @fileoverview Campaign Cache Module
 *
 * Provides time-based caching ONLY for campaign data.
 * Campaigns change infrequently (only on manual activation).
 *
 * Note: /game/index and port demand data changes too frequently for safe caching.
 *
 * @module server/cache
 */

const logger = require('./utils/logger');

/**
 * Cache entry structure
 * @typedef {Object} CacheEntry
 * @property {*} data - Cached data
 * @property {number} timestamp - When the data was cached (ms)
 * @property {number} ttl - Time to live in milliseconds
 */

/**
 * Campaign cache (/marketing-campaign/get-marketing)
 * @type {CacheEntry|null}
 */
let campaignCache = null;

/**
 * COOP data cache (/coop/get-coop-data)
 * @type {CacheEntry|null}
 */
let coopCache = null;

/**
 * Alliance data cache (/alliance/get-user-alliance)
 * @type {CacheEntry|null}
 */
let allianceCache = null;

/**
 * User company data cache (/user/get-company)
 * @type {CacheEntry|null}
 */
let companyCache = null;

/**
 * Default TTL values
 */
const CAMPAIGN_TTL = 10 * 60 * 1000; // 10 minutes (campaigns change rarely)
const COOP_TTL = 2 * 60 * 1000;      // 2 minutes (COOP targets change when processed)
const ALLIANCE_TTL = 30 * 60 * 1000; // 30 minutes (alliance membership almost never changes)
const COMPANY_TTL = 5 * 60 * 1000;   // 5 minutes (company data changes on upgrades)

/**
 * Check if cache entry is still valid
 * @param {CacheEntry|null} entry - Cache entry to check
 * @returns {boolean} True if cache is valid and not expired
 */
function isCacheValid(entry) {
  if (!entry) return false;
  const age = Date.now() - entry.timestamp;
  return age < entry.ttl;
}

/**
 * Get cached campaign data if valid
 * @returns {Object|null} Cached /marketing-campaign/get-marketing response or null
 */
function getCampaignCache() {
  if (isCacheValid(campaignCache)) {
    logger.debug('[Cache] Campaign cache HIT');
    return campaignCache.data;
  }
  logger.debug('[Cache] Campaign cache MISS');
  return null;
}

/**
 * Set campaign cache
 * @param {Object} data - /marketing-campaign/get-marketing API response
 * @param {number} [ttl] - Optional custom TTL in milliseconds
 */
function setCampaignCache(data, ttl = CAMPAIGN_TTL) {
  campaignCache = {
    data,
    timestamp: Date.now(),
    ttl
  };
  logger.debug(`[Cache] Campaign cached (TTL: ${ttl}ms)`);
}

/**
 * Invalidate campaign cache
 * Call this after campaign activation/renewal
 */
function invalidateCampaignCache() {
  campaignCache = null;
  logger.debug('[Cache] Campaign cache invalidated');
}

/**
 * Get cached COOP data if valid
 * @returns {Object|null} Cached /coop/get-coop-data response or null
 */
function getCoopCache() {
  if (isCacheValid(coopCache)) {
    logger.debug('[Cache] COOP cache HIT');
    return coopCache.data;
  }
  logger.debug('[Cache] COOP cache MISS');
  return null;
}

/**
 * Set COOP cache
 * @param {Object} data - /coop/get-coop-data API response
 * @param {number} [ttl] - Optional custom TTL in milliseconds
 */
function setCoopCache(data, ttl = COOP_TTL) {
  coopCache = {
    data,
    timestamp: Date.now(),
    ttl
  };
  logger.debug(`[Cache] COOP cached (TTL: ${ttl}ms)`);
}

/**
 * Invalidate COOP cache
 * Call this after sending COOP targets
 */
function invalidateCoopCache() {
  coopCache = null;
  logger.debug('[Cache] COOP cache invalidated');
}

/**
 * Get cached Alliance data if valid
 * @returns {Object|null} Cached /alliance/get-user-alliance response or null
 */
function getAllianceCache() {
  if (isCacheValid(allianceCache)) {
    logger.debug('[Cache] Alliance cache HIT');
    return allianceCache.data;
  }
  logger.debug('[Cache] Alliance cache MISS');
  return null;
}

/**
 * Set Alliance cache
 * @param {Object} data - /alliance/get-user-alliance API response
 * @param {number} [ttl] - Optional custom TTL in milliseconds
 */
function setAllianceCache(data, ttl = ALLIANCE_TTL) {
  allianceCache = {
    data,
    timestamp: Date.now(),
    ttl
  };
  logger.debug(`[Cache] Alliance cached (TTL: ${ttl}ms)`);
}

/**
 * Get cached Company data if valid
 * @returns {Object|null} Cached /user/get-company response or null
 */
function getCompanyCache() {
  if (isCacheValid(companyCache)) {
    logger.debug('[Cache] Company cache HIT');
    return companyCache.data;
  }
  logger.debug('[Cache] Company cache MISS');
  return null;
}

/**
 * Set Company cache
 * @param {Object} data - /user/get-company API response
 * @param {number} [ttl] - Optional custom TTL in milliseconds
 */
function setCompanyCache(data, ttl = COMPANY_TTL) {
  companyCache = {
    data,
    timestamp: Date.now(),
    ttl
  };
  logger.debug(`[Cache] Company cached (TTL: ${ttl}ms)`);
}

/**
 * Clear all caches
 */
function clearAllCaches() {
  campaignCache = null;
  coopCache = null;
  allianceCache = null;
  companyCache = null;
  logger.debug('[Cache] All caches cleared');
}

module.exports = {
  // Campaign cache
  getCampaignCache,
  setCampaignCache,
  invalidateCampaignCache,

  // COOP cache
  getCoopCache,
  setCoopCache,
  invalidateCoopCache,

  // Alliance cache
  getAllianceCache,
  setAllianceCache,

  // Company cache
  getCompanyCache,
  setCompanyCache,

  // Utilities
  clearAllCaches,
  CAMPAIGN_TTL,
  COOP_TTL,
  ALLIANCE_TTL,
  COMPANY_TTL
};
