/**
 * @fileoverview POI (Points of Interest) Routes
 *
 * Provides cached access to maritime POIs (museums, lighthouses, etc.)
 * from OpenStreetMap Overpass API. Caches data for 24 hours to reduce
 * external API load and improve response times.
 *
 * @module server/routes/poi
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

// Cache directory
const CACHE_DIR = path.join(__dirname, '..', '..', 'userdata', 'cache');
const MUSEUMS_CACHE_FILE = path.join(CACHE_DIR, 'museums.json');
const WRECKS_CACHE_FILE = path.join(CACHE_DIR, 'wrecks.json');
const CACHE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Ensures cache directory exists
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.debug('[POI] Created cache directory:', CACHE_DIR);
  }
}

/**
 * Checks if cache file is valid (exists and not expired)
 * @param {string} filePath - Path to cache file
 * @returns {boolean} True if cache is valid
 */
function isCacheValid(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const stats = fs.statSync(filePath);
  const age = Date.now() - stats.mtimeMs;
  return age < CACHE_MAX_AGE;
}

/**
 * Loads POI data from cache file
 * @param {string} filePath - Path to cache file
 * @returns {Array|null} Cached POI data or null if invalid
 */
function loadFromCache(filePath) {
  if (!isCacheValid(filePath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error(`[POI] Error reading cache file ${filePath}:`, error);
    return null;
  }
}

/**
 * Saves POI data to cache file
 * @param {string} filePath - Path to cache file
 * @param {Array} data - POI data to cache
 */
function saveToCache(filePath, data) {
  try {
    ensureCacheDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    logger.info(`[POI] Cached ${data.length} POIs to ${filePath}`);
  } catch (error) {
    logger.error(`[POI] Error writing cache file ${filePath}:`, error);
  }
}

/**
 * Filters POIs by bounding box
 * @param {Array} pois - Array of POI objects
 * @param {string} bbox - Bounding box "south,west,north,east"
 * @returns {Array} Filtered POIs within bbox
 */
function filterPOIsByBbox(pois, bbox) {
  const [south, west, north, east] = bbox.split(',').map(parseFloat);

  return pois.filter(poi => {
    const lat = poi.lat || poi.center?.lat;
    const lon = poi.lon || poi.center?.lon;

    if (!lat || !lon) return false;

    return lat >= south && lat <= north && lon >= west && lon <= east;
  });
}

/**
 * Reduces wreck data to only essential fields for client
 * @param {Object} wreck - Full wreck POI object
 * @returns {Object} Reduced wreck object
 */
function reduceWreckData(wreck) {
  return {
    lat: wreck.lat || wreck.center?.lat,
    lon: wreck.lon || wreck.center?.lon,
    tags: {
      name: wreck.tags?.name,
      'wreck:date_sunk': wreck.tags?.['wreck:date_sunk'],
      'wreck:year_sunk': wreck.tags?.['wreck:year_sunk'],
      'wreck:depth_metres': wreck.tags?.['wreck:depth_metres'],
      'wreck:cargo': wreck.tags?.['wreck:cargo'],
      'wreck:type': wreck.tags?.['wreck:type'],
      'wreck:visible_at_low_tide': wreck.tags?.['wreck:visible_at_low_tide'],
      description: wreck.tags?.description,
      website: wreck.tags?.website,
      wikipedia: wreck.tags?.wikipedia
    }
  };
}

/**
 * Fetches ALL museums globally from Overpass API
 * @returns {Promise<Array>} Array of museum POIs
 */
async function fetchAllMuseumsFromAPI() {
  // Global query - no bbox restriction
  const query = `[out:json][timeout:60];(node["tourism"="museum"]["museum"="maritime"];way["tourism"="museum"]["museum"="maritime"];);out center;`;

  const server = 'https://overpass.kumi.systems/api/interpreter';

  logger.info('[POI] Fetching ALL maritime museums globally from Overpass API...');

  const response = await fetch(server, {
    method: 'POST',
    body: query,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  if (!response.ok) {
    throw new Error(`Overpass API returned ${response.status}`);
  }

  const data = await response.json();
  const elements = data.elements || [];
  logger.info(`[POI] Loaded ${elements.length} museums globally`);
  return elements;
}

/**
 * Fetches ALL shipwrecks globally from Overpass API
 * @returns {Promise<Array>} Array of shipwreck POIs
 */
async function fetchAllWrecksFromAPI() {
  // Global query - no bbox restriction
  const query = `[out:json][timeout:60];(node["historic"="wreck"];way["historic"="wreck"];);out center;`;

  logger.info('[POI] Fetching ALL shipwrecks globally from Overpass API...');

  const server = 'https://overpass.kumi.systems/api/interpreter';

  const response = await fetch(server, {
    method: 'POST',
    body: query,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  if (!response.ok) {
    throw new Error(`Overpass API returned ${response.status}`);
  }

  const data = await response.json();
  const elements = data.elements || [];
  logger.info(`[POI] Loaded ${elements.length} wrecks globally`);
  return elements;
}

/**
 * GET /api/poi/museums - Get all maritime museums
 *
 * Returns ALL museums from cache without filtering (there aren't many museums).
 * Cache is refreshed every 4 hours.
 *
 * Response format:
 * {
 *   "museums": [...],
 *   "timestamp": 1234567890,
 *   "cached": true
 * }
 */
router.get('/museums', async (req, res) => {
  try {
    // Try to load from cache first
    let allMuseums = loadFromCache(MUSEUMS_CACHE_FILE);

    if (!allMuseums) {
      // Cache miss or expired - fetch from API
      logger.info('[POI] Museums cache miss - fetching from Overpass API');
      allMuseums = await fetchAllMuseumsFromAPI();
      saveToCache(MUSEUMS_CACHE_FILE, allMuseums);
    }

    // Return ALL museums (no bbox filtering - there aren't many)
    logger.debug(`[POI] Returning all ${allMuseums.length} museums from cache`);

    res.json({
      museums: allMuseums,
      timestamp: Date.now(),
      cached: true
    });

  } catch (error) {
    logger.error('[POI] Error fetching museums:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/poi/wrecks?bbox=south,west,north,east - Get shipwrecks
 *
 * Returns wrecks from cache, filtered by bbox. Cache is refreshed every 4 hours.
 * Wreck data is reduced to only essential fields to minimize transfer size.
 *
 * Response format:
 * {
 *   "wrecks": [...],
 *   "timestamp": 1234567890,
 *   "cached": true
 * }
 */
router.get('/wrecks', async (req, res) => {
  try {
    const bbox = req.query.bbox;

    if (!bbox) {
      return res.status(400).json({ error: 'bbox parameter required (format: south,west,north,east)' });
    }

    // Try to load from cache first
    let allWrecks = loadFromCache(WRECKS_CACHE_FILE);

    if (!allWrecks) {
      // Cache miss or expired - fetch from API
      logger.info('[POI] Wrecks cache miss - fetching from Overpass API');
      allWrecks = await fetchAllWrecksFromAPI();
      saveToCache(WRECKS_CACHE_FILE, allWrecks);
    }

    // Filter by bbox
    const filteredWrecks = filterPOIsByBbox(allWrecks, bbox);

    // Reduce wreck data to only essential fields
    const reducedWrecks = filteredWrecks.map(reduceWreckData);

    logger.debug(`[POI] Returning ${reducedWrecks.length} wrecks for bbox (${allWrecks.length} total cached)`);

    res.json({
      wrecks: reducedWrecks,
      timestamp: Date.now(),
      cached: true
    });

  } catch (error) {
    logger.error('[POI] Error fetching wrecks:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Initializes POI cache on server startup
 * Loads museums and wrecks if cache is empty or expired
 */
async function initializePOICache() {
  logger.info('[POI] Initializing POI cache on startup...');

  try {
    // Check museums cache
    let museums = loadFromCache(MUSEUMS_CACHE_FILE);
    if (!museums) {
      logger.info('[POI] Museums cache empty - loading from Overpass API');
      museums = await fetchAllMuseumsFromAPI();
      saveToCache(MUSEUMS_CACHE_FILE, museums);
    } else {
      logger.info(`[POI] Museums cache loaded: ${museums.length} museums`);
    }

    // Check wrecks cache
    let wrecks = loadFromCache(WRECKS_CACHE_FILE);
    if (!wrecks) {
      logger.info('[POI] Wrecks cache empty - loading from Overpass API');
      wrecks = await fetchAllWrecksFromAPI();
      saveToCache(WRECKS_CACHE_FILE, wrecks);
    } else {
      logger.info(`[POI] Wrecks cache loaded: ${wrecks.length} wrecks`);
    }

    logger.info('[POI] POI cache initialization complete');
  } catch (error) {
    logger.error('[POI] Error initializing POI cache:', error);
  }
}

/**
 * Starts automatic cache refresh every 4 hours
 */
function startAutomaticCacheRefresh() {
  const REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

  setInterval(async () => {
    logger.info('[POI] Starting automatic cache refresh...');

    try {
      // Refresh museums
      const museums = await fetchAllMuseumsFromAPI();
      saveToCache(MUSEUMS_CACHE_FILE, museums);

      // Refresh wrecks
      const wrecks = await fetchAllWrecksFromAPI();
      saveToCache(WRECKS_CACHE_FILE, wrecks);

      logger.info('[POI] Automatic cache refresh complete');
    } catch (error) {
      logger.error('[POI] Error during automatic cache refresh:', error);
    }
  }, REFRESH_INTERVAL);

  logger.info(`[POI] Automatic cache refresh scheduled every 4 hours`);
}

router.initializePOICache = initializePOICache;
router.startAutomaticCacheRefresh = startAutomaticCacheRefresh;

module.exports = router;
