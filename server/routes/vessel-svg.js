/**
 * Dynamic Vessel SVG Route
 * Generates SVG images for custom-built vessels on-the-fly (no disk caching)
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { generateVesselSvg } = require('../utils/vessel-svg-generator');
const { makeAuthenticatedRequest, getUserId } = require('../utils/api');
const { getAppDataDir, getSessionCookie } = require('../config');
const logger = require('../utils/logger');

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
 * Generate SVG for a vessel (no disk caching - always fresh)
 */
router.get('/:vesselId', async (req, res) => {
  const { vesselId } = req.params;
  const forceSvg = req.query.force === 'svg';

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'No user ID available' });
  }

  const filePrefix = `${userId}_${vesselId}`;
  const ownImagePath = path.join(VESSEL_IMAGES_DIR, 'ownimages', `${vesselId}.png`);

  // Check for user-uploaded image first (unless force=svg)
  if (!forceSvg) {
    try {
      const existingOwnImage = await fs.readFile(ownImagePath);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.send(existingOwnImage);
    } catch {
      // Own image doesn't exist, generate SVG
    }
  }

  // Load appearance file for custom colors
  const appearanceFile = path.join(VESSEL_APPEARANCES_DIR, `${filePrefix}.json`);
  let appearanceData = null;

  try {
    const fileContent = await fs.readFile(appearanceFile, 'utf8');
    appearanceData = JSON.parse(fileContent);
    logger.debug(`[Vessel SVG] Loaded appearance for ${vesselId}: capacity_type=${appearanceData.capacity_type}`);
  } catch {
    logger.debug(`[Vessel SVG] No appearance file for vessel ${vesselId}`);
  }

  try {
    let vesselData = appearanceData;

    // Fetch capacity_type from API if missing
    if (!vesselData || !vesselData.capacity_type) {
      logger.debug(`[Vessel SVG] Need to fetch capacity_type from API for vessel ${vesselId}`);
      let sessionCookie = null;
      try {
        sessionCookie = await getSessionCookie();
      } catch (cookieErr) {
        logger.warn(`[Vessel SVG] Could not get session cookie: ${cookieErr.message}`);
      }

      if (sessionCookie) {
        try {
          const vesselsResponse = await makeAuthenticatedRequest(
            `https://shippingmanager.cc/api/vessel/get-vessels`,
            {
              method: 'GET',
              headers: {
                'Cookie': `shipping_manager_session=${sessionCookie}`
              }
            }
          );

          let apiVessel = null;
          if (vesselsResponse.ok) {
            const vesselsData = await vesselsResponse.json();
            apiVessel = vesselsData.data?.user_vessels?.find(v => v.id === parseInt(vesselId));
            if (apiVessel) {
              logger.debug(`[Vessel SVG] Found vessel ${vesselId}: capacity_type=${apiVessel.capacity_type}`);
            }
          }

          // Try acquirable vessels if not found
          if (!apiVessel) {
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
              apiVessel = acquirableData.data?.vessels_for_sale?.find(v => v.id === parseInt(vesselId));
            }
          }

          if (apiVessel) {
            if (appearanceData) {
              // Merge API data into appearance (preserve colors)
              appearanceData.capacity_type = apiVessel.capacity_type;
              appearanceData.capacity = apiVessel.capacity_max?.dry ?? apiVessel.capacity;
              vesselData = appearanceData;

              // Update appearance file with capacity_type
              try {
                await fs.writeFile(appearanceFile, JSON.stringify(appearanceData, null, 2), 'utf8');
                logger.info(`[Vessel SVG] Updated appearance file with capacity_type: ${apiVessel.capacity_type}`);
              } catch (saveErr) {
                logger.warn(`[Vessel SVG] Could not save appearance: ${saveErr.message}`);
              }
            } else {
              vesselData = apiVessel;
            }
          }
        } catch (apiErr) {
          logger.warn(`[Vessel SVG] API fetch failed: ${apiErr.message}`);
        }
      }

      if (!vesselData) {
        return res.status(404).json({ error: 'Vessel not found' });
      }
    }

    // Generate SVG fresh (no disk cache)
    const svg = generateVesselSvg(vesselData);
    logger.debug(`[Vessel SVG] Generated SVG for vessel ${vesselId}: capacity_type=${vesselData.capacity_type}`);

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
