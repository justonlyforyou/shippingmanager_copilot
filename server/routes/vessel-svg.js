/**
 * Dynamic Vessel SVG Route
 * Generates SVG images for custom-built vessels on-the-fly
 *
 * Flow:
 * 1. Check ownImage PNG exists -> return if exists
 * 2. Get vessel data from QUERY PARAMS (capacity_type, capacity, name)
 * 3. Load Appearance File for colors only (optional)
 * 4. generateVesselSvg with query data + colors
 * 5. Return SVG
 *
 * NO API CALLS - Frontend provides all vessel data via query params!
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { generateVesselSvg } = require('../utils/vessel-svg-generator');
const { getUserId } = require('../utils/api');
const { getAppBaseDir } = require('../config');
const logger = require('../utils/logger');

const isPkg = !!process.pkg;
const VESSEL_IMAGES_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'vessel-images')
  : path.join(__dirname, '../../userdata/vessel-images');
const VESSEL_APPEARANCES_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'vessel-appearances')
  : path.join(__dirname, '../../userdata/vessel-appearances');

async function ensureDirectories() {
  try {
    await fs.mkdir(VESSEL_IMAGES_DIR, { recursive: true });
    await fs.mkdir(VESSEL_APPEARANCES_DIR, { recursive: true });
  } catch (err) {
    logger.error('[Vessel SVG] Failed to create directories:', err);
  }
}

ensureDirectories();

/**
 * GET /api/vessel-svg/preview
 *
 * Preview endpoint for vessel building - no vessel ID needed.
 * All data comes from query params.
 *
 * Query params:
 * - capacity_type: 'container' or 'tanker' (required)
 * - capacity: number (required)
 * - name: vessel name (optional)
 * - hull_color: hex color (optional)
 * - deck_color: hex color (optional)
 * - bridge_color: hex color (optional)
 * - name_color: hex color (optional)
 * - container_color_1-4: hex colors (optional)
 */
router.get('/preview', (req, res) => {
  const {
    capacity_type,
    capacity,
    name,
    hull_color,
    deck_color,
    bridge_color,
    name_color,
    container_color_1,
    container_color_2,
    container_color_3,
    container_color_4
  } = req.query;

  // Validate required params
  if (!capacity_type || !capacity) {
    return res.status(400).json({
      error: 'Missing required query params',
      required: ['capacity_type', 'capacity']
    });
  }

  // Build vessel data from query params
  const vesselData = {
    capacity_type,
    capacity: parseInt(capacity),
    name: name || 'Custom Vessel',
    hull_color: hull_color || '#b30000',
    deck_color: deck_color || '#272525',
    bridge_color: bridge_color || '#dbdbdb',
    name_color: name_color || '#ffffff',
    container_color_1: container_color_1 || '#ff8000',
    container_color_2: container_color_2 || '#0000ff',
    container_color_3: container_color_3 || '#670000',
    container_color_4: container_color_4 || '#777777'
  };

  try {
    const svg = generateVesselSvg(vesselData);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  } catch (error) {
    logger.error('[Vessel SVG] Error generating preview SVG:', error);
    const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
      <rect fill="#374151" width="400" height="300"/>
      <text x="50%" y="50%" fill="#9ca3af" text-anchor="middle" font-size="24">Ship</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(fallbackSvg);
  }
});

/**
 * GET /api/vessel-svg/:vesselId
 *
 * Query params (required for SVG generation):
 * - capacity_type: 'container' or 'tanker'
 * - capacity: number (total capacity)
 * - name: vessel name
 *
 * Optional:
 * - force: 'svg' to skip ownImage check
 */
router.get('/:vesselId', async (req, res) => {
  const { vesselId } = req.params;
  const { capacity_type, capacity, name, force } = req.query;
  const forceSvg = force === 'svg';

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'No user ID available' });
  }

  // [1] Check ownImage PNG exists
  if (!forceSvg) {
    const ownImagePath = path.join(VESSEL_IMAGES_DIR, 'ownimages', `${vesselId}.png`);
    try {
      const ownImage = await fs.readFile(ownImagePath);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.send(ownImage);
    } catch {
      // No ownImage, continue to SVG generation
    }
  }

  // [2] Validate required query params
  if (!capacity_type || !capacity) {
    logger.warn(`[Vessel SVG] Missing query params for ${vesselId}: capacity_type=${capacity_type}, capacity=${capacity}`);
    return res.status(400).json({
      error: 'Missing required query params',
      required: ['capacity_type', 'capacity'],
      received: { capacity_type, capacity, name }
    });
  }

  // [3] Load Appearance File for colors only (optional)
  const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${userId}_${vesselId}.json`);
  let colors = null;
  try {
    const content = await fs.readFile(appearanceFile, 'utf8');
    colors = JSON.parse(content);
  } catch {
    // No appearance file, use defaults
  }

  // [4] Build vessel data from query params + colors
  const vesselData = {
    id: parseInt(vesselId),
    capacity_type: capacity_type,
    capacity: parseInt(capacity),
    name: name || 'Custom Vessel',
    ...(colors && {
      hull_color: colors.hull_color,
      deck_color: colors.deck_color,
      bridge_color: colors.bridge_color,
      name_color: colors.name_color,
      container_color_1: colors.container_color_1,
      container_color_2: colors.container_color_2,
      container_color_3: colors.container_color_3,
      container_color_4: colors.container_color_4
    })
  };

  // [5] Generate and return SVG
  try {
    const svg = generateVesselSvg(vesselData);
    logger.debug(`[Vessel SVG] Generated SVG for ${vesselId}: capacity_type=${vesselData.capacity_type}, capacity=${vesselData.capacity}`);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  } catch (error) {
    logger.error('[Vessel SVG] Error generating SVG:', error);
    const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
      <rect fill="#374151" width="400" height="300"/>
      <text x="50%" y="50%" fill="#9ca3af" text-anchor="middle" font-size="24">Ship</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(fallbackSvg);
  }
});

module.exports = router;
