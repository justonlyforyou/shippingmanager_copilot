/**
 * @fileoverview Auto-refresh and page visibility management module.
 * Handles automatic data refreshes and page visibility change detection.
 *
 * @module core/auto-refresh
 */

import logger from './logger.js';

/**
 * Active interval IDs for cleanup.
 * @type {Map<string, number>}
 */
const activeIntervals = new Map();

/**
 * Refresh cooldown tracking.
 * @type {Object}
 */
const refreshState = {
  inProgress: false,
  lastRefreshTime: 0,
  cooldown: 1000 // 1 second cooldown
};

/**
 * Start version update checker.
 * Checks for updates on startup and every 15 minutes.
 *
 * @param {Function} apiUrl - API URL builder function
 * @param {boolean} debugMode - Whether debug mode is enabled
 * @returns {Object} Version check functions
 */
export function initVersionChecker(apiUrl, debugMode) {
  let updateCheckData = null;

  const checkForUpdates = async () => {
    try {
      const response = await fetch(apiUrl('/api/version/check'));
      const data = await response.json();
      updateCheckData = data;

      // Update Information section in settings
      const currentVersionEl = document.getElementById('currentVersion');
      if (currentVersionEl) {
        currentVersionEl.textContent = `v${data.currentVersion}`;
      }

      if (data.updateAvailable) {
        // Show update available message
        const updateContainer = document.getElementById('updateStatusContainer');
        const upToDateContainer = document.getElementById('upToDateContainer');
        const latestVersionEl = document.getElementById('latestVersion');
        const downloadLink = document.getElementById('downloadLink');

        if (updateContainer) updateContainer.classList.remove('hidden');
        if (upToDateContainer) upToDateContainer.classList.add('hidden');
        if (latestVersionEl) latestVersionEl.textContent = `v${data.latestVersion}`;
        if (downloadLink) downloadLink.href = data.downloadUrl;

        // Show pulsing dot on settings icon
        const updateIndicator = document.getElementById('settingsUpdateIndicator');
        if (updateIndicator) {
          updateIndicator.classList.remove('hidden');
        }

        if (debugMode) {
          console.log(`[Version] Update available: ${data.currentVersion} -> ${data.latestVersion}`);
        }
      } else {
        // Show up-to-date message
        const updateContainer = document.getElementById('updateStatusContainer');
        const upToDateContainer = document.getElementById('upToDateContainer');

        if (updateContainer) updateContainer.classList.add('hidden');
        if (upToDateContainer) upToDateContainer.classList.remove('hidden');

        // Hide pulsing dot on settings icon
        const updateIndicator = document.getElementById('settingsUpdateIndicator');
        if (updateIndicator) {
          updateIndicator.classList.add('hidden');
        }

        if (debugMode) {
          console.log(`[Version] Up to date: v${data.currentVersion}`);
        }
      }
    } catch (error) {
      console.error('[Version] Failed to check for updates:', error);
    }
  };

  // Initial check on startup
  checkForUpdates();

  // Check every 15 minutes
  const intervalId = setInterval(checkForUpdates, 15 * 60 * 1000);
  activeIntervals.set('versionCheck', intervalId);

  return {
    check: checkForUpdates,
    getData: () => updateCheckData
  };
}

/**
 * Initialize page visibility change handler.
 * Refreshes chat messages when page becomes visible again.
 *
 * @param {Function} loadMessages - Function to load chat messages
 * @param {HTMLElement} chatFeed - Chat feed element
 * @param {boolean} debugMode - Whether debug mode is enabled
 */
export function initVisibilityHandler(loadMessages, chatFeed, debugMode) {
  const refreshChatData = async (source) => {
    const now = Date.now();

    // Skip if refresh is already in progress or within cooldown
    if (refreshState.inProgress || (now - refreshState.lastRefreshTime) < refreshState.cooldown) {
      if (debugMode) {
        console.log(`[${source}] Skipping refresh (cooldown or in progress)`);
      }
      return;
    }

    refreshState.inProgress = true;
    refreshState.lastRefreshTime = now;
    if (debugMode) {
      console.log(`[${source}] Refreshing chat messages`);
    }

    try {
      await loadMessages(chatFeed);
      if (debugMode) {
        console.log(`[${source}] Chat messages refreshed`);
      }
    } catch (error) {
      console.error(`[${source}] Error refreshing chat:`, error);
    } finally {
      refreshState.inProgress = false;
    }
  };

  // Page Visibility API
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      await refreshChatData('Visibility');
    }
  });

  // Focus API (additional insurance for PC browsers)
  window.addEventListener('focus', async () => {
    await refreshChatData('Focus');
  });

  return refreshChatData;
}

/**
 * Start notification button state updater.
 * Checks permission status every 2 seconds to auto-hide button when permission granted.
 *
 * @returns {number|null} Interval ID or null if button not found
 */
export function initNotificationButtonUpdater() {
  const notificationBtn = document.getElementById('notificationBtn');
  if (!notificationBtn) return null;

  const updateNotificationButtonState = () => {
    if (Notification.permission !== "granted") {
      notificationBtn.classList.remove('enabled');
      notificationBtn.classList.add('disabled');
      notificationBtn.classList.remove('hidden');
    } else {
      notificationBtn.classList.add('hidden');
    }
  };

  // Set initial state
  updateNotificationButtonState();

  // Check every 2 seconds
  const intervalId = setInterval(updateNotificationButtonState, 2000);
  activeIntervals.set('notificationButton', intervalId);

  return intervalId;
}

/**
 * Preload all images in background for instant display.
 * Waits 2 seconds after page load to not block initial rendering.
 *
 * @param {boolean} debugMode - Whether debug mode is enabled
 */
export async function preloadAllImages(debugMode) {
  try {
    // Wait a bit to not block initial page load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Preload all vessel data and images
    const { fetchAcquirableVessels, fetchVessels } = await import('../api.js');

    // Load acquirable vessels (buy menu) in background
    const acquirableData = await fetchAcquirableVessels().catch(err => {
      logger.debug('[Preload] Acquirable vessels fetch failed:', err);
      return null;
    });

    // Load owned vessels (sell menu) in background
    const ownedData = await fetchVessels().catch(err => {
      logger.debug('[Preload] Owned vessels fetch failed:', err);
      return null;
    });

    if (debugMode) {
      if (ownedData) {
        console.log(`[Preload] Owned vessels cached: ${ownedData.vessels?.length || 0} vessels`);
      } else {
        logger.debug('[Preload] Owned vessels fetch returned null');
      }
    }

    // Also get vessels from harbor map
    const { getCachedOverview: getMapCache } = await import('../harbor-map/api-client.js');
    const mapData = getMapCache();

    // Preload ALL vessel images
    const allVesselTypes = new Set();

    if (acquirableData && acquirableData.data && acquirableData.data.vessels_for_sale) {
      acquirableData.data.vessels_for_sale.forEach(v => allVesselTypes.add(v.type));
    }

    if (ownedData && ownedData.vessels) {
      ownedData.vessels.forEach(v => allVesselTypes.add(v.type));
    }

    if (mapData && mapData.vessels) {
      mapData.vessels.forEach(v => {
        if (v.type) allVesselTypes.add(v.type);
      });
    }

    if (allVesselTypes.size > 0) {
      console.log(`[Preload] Caching ${allVesselTypes.size} vessel types...`);
      [...allVesselTypes].forEach((type, index) => {
        setTimeout(() => {
          const img = new Image();
          img.src = `/api/vessel-image/${type}`;
        }, index * 100);
      });
    }

    // Preload ALL harbor/port images
    const { fetchHarborMapOverview } = await import('../harbor-map/api-client.js');

    const harborData = await fetchHarborMapOverview('all_ports').catch(err => {
      logger.debug('[Preload] Harbor map fetch failed:', err);
      return null;
    });

    if (harborData && harborData.ports) {
      console.log(`[Preload] Caching ${harborData.ports.length} harbor images...`);
      harborData.ports.forEach((port, index) => {
        if (port.code) {
          setTimeout(() => {
            const img = new Image();
            img.src = `/images/ports/${port.code}.jpg`;
          }, index * 50);
        }
      });
    }

    logger.debug('[Preload] Background image and data preloading started');
  } catch (error) {
    logger.debug('[Preload] Background preloading failed:', error);
  }
}

/**
 * Stop all active intervals.
 * Useful during cleanup or page unload.
 */
export function stopAllIntervals() {
  activeIntervals.forEach((intervalId, name) => {
    clearInterval(intervalId);
    console.log(`[Auto-Refresh] Stopped ${name} interval`);
  });
  activeIntervals.clear();
}

/**
 * Stop a specific interval by name.
 *
 * @param {string} name - Name of the interval to stop
 * @returns {boolean} True if interval was stopped, false if not found
 */
export function stopInterval(name) {
  const intervalId = activeIntervals.get(name);
  if (intervalId) {
    clearInterval(intervalId);
    activeIntervals.delete(name);
    return true;
  }
  return false;
}

/**
 * Get list of all active interval names.
 *
 * @returns {string[]} Array of interval names
 */
export function getActiveIntervals() {
  return Array.from(activeIntervals.keys());
}
