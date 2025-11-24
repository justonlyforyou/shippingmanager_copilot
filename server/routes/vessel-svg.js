/**
 * Dynamic Vessel SVG Route
 * Generates SVG images for custom-built vessels
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { generateVesselSvg } = require('../utils/vessel-svg-generator');
const { getSessionCookie } = require('../utils/session-manager');
const { makeAuthenticatedRequest, getUserId } = require('../utils/api');
const { getAppDataDir } = require('../config');

// Determine vessel data directories based on environment
const isPkg = !!process.pkg;
const VESSEL_IMAGES_DIR = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'vessel-images')
  : path.join(__dirname, '../../userdata/vessel-images');
const VESSEL_APPEARANCES_DIR = isPkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'vessel-appearances')
  : path.join(__dirname, '../../userdata/vessel-appearances');

async function ensureDirectories() {
  try {
    await fs.mkdir(VESSEL_IMAGES_DIR, { recursive: true });
    await fs.mkdir(VESSEL_APPEARANCES_DIR, { recursive: true });
  } catch (err) {
    console.error('[Vessel SVG] Failed to create directories:', err);
  }
}

ensureDirectories();

/**
 * GET /api/vessel-svg/:vesselId
 * Generate or retrieve cached SVG for a vessel
 */
router.get('/:vesselId', async (req, res) => {
  const { vesselId } = req.params;

  // Get userId for unique file naming
  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'No user ID available' });
  }

  const filePrefix = `${userId}_${vesselId}`;

  // IMPORTANT: Own images are stored in ownimages subfolder with just vesselId (no userId prefix)
  // This matches how build-vessel and vessel-image.js handle ownimages
  const ownImagePath = path.join(VESSEL_IMAGES_DIR, 'ownimages', `${vesselId}.png`);
  const svgFilePath = path.join(VESSEL_IMAGES_DIR, `${filePrefix}.svg`);

  // Try to load existing own image (user uploaded) first - stored in ownimages subfolder
  try {
    const existingOwnImage = await fs.readFile(ownImagePath);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(existingOwnImage);
  } catch {
    // Own image doesn't exist, try SVG
  }

  // Try to load existing SVG
  try {
    const existingSvg = await fs.readFile(svgFilePath, 'utf8');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(existingSvg);
  } catch {
    // SVG doesn't exist, generate it
  }

  try {
    const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${filePrefix}.json`);

    let vesselData = null;
    let hasAppearanceFile = false;

    // Try to load appearance file first
    try {
      const appearanceData = await fs.readFile(appearanceFile, 'utf8');
      vesselData = JSON.parse(appearanceData);
      hasAppearanceFile = true;
    } catch {
      // Appearance file doesn't exist - will try API
    }

    // If no appearance file, try to get vessel data from API to generate default SVG
    if (!vesselData) {
      const sessionCookie = await getSessionCookie();
      if (!sessionCookie) {
        return res.status(401).json({ error: 'No session cookie available' });
      }

      // First try user_vessels (owned vessels including pending)
      const vesselsResponse = await makeAuthenticatedRequest(
        `https://shippingmanager.cc/api/vessel/get-vessels`,
        {
          method: 'GET',
          headers: {
            'Cookie': `shipping_manager_session=${sessionCookie}`
          }
        }
      );

      if (vesselsResponse.ok) {
        const vesselsData = await vesselsResponse.json();
        const vessel = vesselsData.data?.user_vessels?.find(v => v.id === parseInt(vesselId));
        if (vessel) {
          vesselData = vessel;
        }
      }

      // If not found in user_vessels, try acquirable vessels (market)
      if (!vesselData) {
        const acquirableResponse = await makeAuthenticatedRequest(
          `https://shippingmanager.cc/api/vessel/get-all-acquirable-vessels`,
          {
            method: 'POST',
            headers: {
              'Cookie': `shipping_manager_session=${sessionCookie}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
          }
        );

        if (acquirableResponse.ok) {
          const acquirableData = await acquirableResponse.json();
          const vessel = acquirableData.data?.vessels_for_sale?.find(v => v.id === parseInt(vesselId));
          if (vessel) {
            vesselData = vessel;
          }
        }
      }

      if (!vesselData) {
        return res.status(404).json({ error: 'Vessel not found' });
      }
    }

    const svg = generateVesselSvg(vesselData);

    await fs.writeFile(svgFilePath, svg, 'utf8');

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(svg);

  } catch (error) {
    console.error('[Vessel SVG] Error generating SVG:', error);
    const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
      <rect fill="#374151" width="400" height="300"/>
      <text x="50%" y="50%" fill="#9ca3af" text-anchor="middle" font-size="24">Ship</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(fallbackSvg);
  }
});

module.exports = router;
