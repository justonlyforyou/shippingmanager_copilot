/**
 * @fileoverview Vessel Image Caching Proxy
 *
 * Proxies vessel images from shippingmanager.cc with aggressive caching:
 * - Filesystem cache for downloaded images (persistent)
 * - Browser cache headers (1 year)
 * - Reduces external API calls and improves load times
 *
 * @module server/routes/vessel-image
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');

// Cache directory - use APPDATA when running as .exe
const CACHE_DIR = process.pkg
  ? path.join(config.getAppBaseDir(), 'userdata', 'cache', 'vessel-images')
  : path.join(__dirname, '..', '..', 'userdata', 'cache', 'vessel-images');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  logger.info(`[VesselImage] Created cache directory: ${CACHE_DIR}`);
}

/**
 * Vessel image proxy with filesystem caching
 *
 * Downloads images from shippingmanager.cc and caches them locally.
 * Sets aggressive browser cache headers (1 year) since vessel images never change.
 *
 * @route GET /api/vessel-image/*
 * @param {string} * - Vessel image path (e.g., 'compressed/container/20-TEU.jpg')
 * @returns {Binary} Image file with cache headers
 *
 * @example
 * GET /api/vessel-image/compressed/container/20-TEU.jpg
 * Response: Image with Cache-Control: public, max-age=31536000, immutable
 */
router.use(async (req, res, next) => {
  // Only handle GET and HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }

  // Extract full path from req.url (relative to router mount point /api/vessel-image)
  const vesselImagePath = req.url.startsWith('/') ? req.url.substring(1) : req.url;

  // Check if this is an own image (user uploaded)
  if (vesselImagePath.startsWith('ownimage/')) {
    const vesselId = vesselImagePath.split('/').pop().replace(/\?.*$/, '');
    // ownimages are in userdata/vessel-images/ownimages (not in cache folder)
    const ownImagesDir = process.pkg
      ? path.join(config.getAppBaseDir(), 'userdata', 'vessel-images', 'ownimages')
      : path.join(__dirname, '..', '..', 'userdata', 'vessel-images', 'ownimages');
    const ownImagePath = path.join(ownImagesDir, `${vesselId}.png`);
    logger.debug(`[VesselImage] Looking for own image: ${ownImagePath}`);
    try {
      const exists = fs.existsSync(ownImagePath);
      logger.debug(`[VesselImage] File exists: ${exists}`);
      if (exists) {
        res.set({
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        return res.sendFile(path.resolve(ownImagePath));
      }
    } catch (err) {
      logger.error(`[VesselImage] Error reading own image: ${err.message}`);
    }
    logger.warn(`[VesselImage] Own image not found: ${ownImagePath}`);
    return res.status(404).json({ error: 'Own image not found' });
  }

  // Check if this is a custom vessel (redirect to SVG generator with query params)
  if (vesselImagePath.startsWith('custom/')) {
    const vesselId = vesselImagePath.split('/').pop().split('?')[0];
    // Pass through any query params from the original request
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    return res.redirect(`/api/vessel-svg/${vesselId}${queryString}`);
  }

  // Validate path (alphanumeric, underscore, hyphen, slash, dot only - prevent directory traversal)
  if (!vesselImagePath || /\.\./.test(vesselImagePath) || !/^[a-zA-Z0-9_\-\/\.]+$/.test(vesselImagePath)) {
    logger.warn(`[VesselImage] Invalid vessel image path requested: ${vesselImagePath}`);
    return res.status(400).json({ error: 'Invalid vessel image path' });
  }

  try{

  // Build cache file path (preserve directory structure)
  const cacheFilePath = path.join(CACHE_DIR, vesselImagePath);

  // Detect content type from file extension
  const ext = path.extname(vesselImagePath).toLowerCase();
  const contentTypeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  const contentType = contentTypeMap[ext] || 'image/jpeg';

  // Check if image exists in cache
  if (fs.existsSync(cacheFilePath)) {
    // Serve from cache with 1 week cache for shop vessels
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800', // 1 week
      'ETag': vesselImagePath // Simple ETag based on image path
    });

    return res.sendFile(cacheFilePath);
  }

  // Not in cache - download from shippingmanager.cc
  const imageUrl = `https://shippingmanager.cc/images/acquirevessels/${vesselImagePath}`;

  logger.debug(`[VesselImage] Downloading: ${imageUrl}`);

  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: {
      'User-Agent': 'ShippingManagerCoPilot/1.0'
    }
  });

  // Ensure subdirectories exist before saving
  const cacheDir = path.dirname(cacheFilePath);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Save to cache
  fs.writeFileSync(cacheFilePath, response.data);
  logger.info(`[VesselImage] Cached: ${vesselImagePath}`);

  // Serve image with cache headers
  res.set({
    'Content-Type': response.headers['content-type'] || contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': vesselImagePath
  });

  res.send(response.data);

  } catch (error) {
    logger.error(`[VesselImage] Failed to download ${vesselImagePath}:`, error.message);

    // Return fallback SVG (ship emoji)
    const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect fill="#374151" width="400" height="300"/><text x="50%" y="50%" fill="#9ca3af" text-anchor="middle" font-size="24">⛴️</text></svg>`;

    res.set({
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache' // Don't cache fallback
    });

    res.send(fallbackSvg);
  }
});

module.exports = router;
