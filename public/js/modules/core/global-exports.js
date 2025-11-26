/**
 * @fileoverview Global exports module.
 * Exposes functions globally via window object for HTML onclick handlers
 * and cross-module communication.
 *
 * @module core/global-exports
 */

/**
 * Export all necessary functions to window object for HTML onclick handlers.
 * This is required because HTML elements cannot directly call module-scoped functions.
 *
 * @param {Object} modules - Object containing all module functions to export
 * @param {Object} modules.uiDialogs - UI dialog functions
 * @param {Object} modules.coop - COOP functions
 * @param {Object} modules.messenger - Messenger functions
 * @param {Object} modules.hijacking - Hijacking functions
 * @param {Object} modules.vesselManagement - Vessel management functions
 * @param {Object} modules.vesselSelling - Vessel selling functions
 * @param {Object} modules.bunkerManagement - Bunker management functions
 * @param {Object} modules.settings - Settings object reference
 * @param {Function} modules.debouncedUpdateBunkerStatus - Debounced bunker update
 */
export function exportGlobals(modules) {
  const {
    uiDialogs,
    coop,
    messenger,
    hijacking,
    vesselManagement,
    vesselSelling,
    bunkerManagement,
    settings,
    debouncedUpdateBunkerStatus
  } = modules;

  // Campaign purchase wrapper
  window.buyCampaign = (campaignId, typeName, duration, price) => {
    uiDialogs.buyCampaign(campaignId, typeName, duration, price, {
      updateBunkerStatus: () => debouncedUpdateBunkerStatus(500)
    });
  };

  // COOP send wrapper
  window.sendCoopMax = (userId) => {
    coop.sendCoopMax(userId);
  };

  // Messenger functions
  window.openMessengerFromChat = messenger.openMessenger;
  window.openNewChatFromContact = messenger.openNewChat;

  // Hijacking functions
  window.updateHijackingBadge = hijacking.updateHijackingBadge;
  window.updateHijackedVesselsDisplay = hijacking.updateHijackedVesselsDisplay;

  // Map icon bar functions
  window.departAllVessels = vesselManagement.departAllVessels;
  window.showAnchorInfo = uiDialogs.showAnchorInfo;
  window.showAllChats = messenger.showAllChats;
  window.openHijackingInbox = hijacking.openHijackingInbox;
  window.showContactList = uiDialogs.showContactList;
  window.showCampaignsOverlay = uiDialogs.showCampaignsOverlay;
  window.showCoopOverlay = coop.showCoopOverlay;
  window.openSellVesselsOverlay = vesselSelling.openSellVesselsOverlay;

  // Settings getter for other modules
  window.getSettings = () => settings;

  // Vessel management functions
  window.updateVesselCount = vesselManagement.updateVesselCount;
  window.lockDepartButton = vesselManagement.lockDepartButton;
  window.unlockDepartButton = vesselManagement.unlockDepartButton;
  window.isDepartInProgress = vesselManagement.isDepartInProgress;
  window.openRepairAndDrydockDialog = vesselManagement.openRepairAndDrydockDialog;

  // Bunker management
  window.setCapacityFromBunkerUpdate = bunkerManagement.setCapacityFromBunkerUpdate;

  // Logbook wrapper
  window.showLogbookOverlay = function() {
    if (window.openLogbook) {
      window.openLogbook();
    }
  };
}

/**
 * Export debounced API functions globally for cross-module access.
 *
 * @param {Object} debouncedFunctions - Object containing debounced functions
 */
export function exportDebouncedFunctions(debouncedFunctions) {
  window.debouncedUpdateBunkerStatus = debouncedFunctions.bunker;
  window.debouncedUpdateVesselCount = debouncedFunctions.vessel;
  window.debouncedUpdateUnreadBadge = debouncedFunctions.unread;
  window.debouncedUpdateRepairCount = debouncedFunctions.repair;
}

/**
 * Export autopilot control functions globally.
 *
 * @param {Object} autopilotFunctions - Autopilot control functions
 */
export function exportAutopilotFunctions(autopilotFunctions) {
  window.updateAutopilotButton = autopilotFunctions.updateButton;
  window.toggleAutopilot = autopilotFunctions.toggle;
  window.onAutopilotStatusUpdate = autopilotFunctions.onStatusUpdate;
}

/**
 * Export settings update handler globally.
 *
 * @param {Function} handleSettingsUpdate - Settings update handler function
 */
export function exportSettingsHandler(handleSettingsUpdate) {
  window.handleSettingsUpdate = handleSettingsUpdate;
}

/**
 * Export version check functions globally.
 *
 * @param {Object} versionFunctions - Version check functions
 */
export function exportVersionFunctions(versionFunctions) {
  window.checkForUpdates = versionFunctions.check;
  window.getUpdateCheckData = versionFunctions.getData;
}

/**
 * Export overlay show functions for map icon bar.
 *
 * @param {Object} overlayFunctions - Overlay show functions
 */
export function exportOverlayFunctions(overlayFunctions) {
  window.showSettings = overlayFunctions.showSettings;
  window.showAllianceChatOverlay = overlayFunctions.showAllianceChat;
  window.showDocsOverlay = overlayFunctions.showDocs;
  window.showForecastOverlay = overlayFunctions.showForecast;
  window.showBuyVesselsOverlay = overlayFunctions.showBuyVessels;
  window.showStockManager = overlayFunctions.showStockManager;
}

/**
 * Export logbook handler for WebSocket updates.
 *
 * @param {Function} prependLogEntry - Function to prepend log entries
 */
export function exportLogbookHandler(prependLogEntry) {
  window.handleLogbookUpdate = function(logEntry) {
    if (typeof prependLogEntry === 'function') {
      prependLogEntry(logEntry);
    }
  };
}

/**
 * Export storage functions globally for backward compatibility.
 *
 * @param {Object} storageFunctions - Storage functions
 */
export function exportStorageFunctions(storageFunctions) {
  window.getStorage = storageFunctions.getStorage;
  window.setStorage = storageFunctions.setStorage;
}

/**
 * Export API URL helper globally.
 *
 * @param {string} apiPrefix - API prefix (e.g., '/api')
 */
export function exportApiUrl(apiPrefix) {
  window.apiUrl = function(endpoint) {
    const cleanEndpoint = endpoint.replace(/^\/api/, '');
    return `${apiPrefix}${cleanEndpoint}`;
  };
}

/**
 * Export cache key and prefix globally.
 *
 * @param {string} cacheKey - Badge cache key
 * @param {string} prefix - User storage prefix
 */
export function exportCacheKeys(cacheKey, prefix) {
  window.CACHE_KEY = cacheKey;
  window.USER_STORAGE_PREFIX = prefix;
}

/**
 * Export debug mode globally.
 *
 * @param {boolean} debugMode - Whether debug mode is enabled
 */
export function exportDebugMode(debugMode) {
  window.DEBUG_MODE = debugMode;
  if (typeof window !== 'undefined') {
    console.log('[Debug] To enable debug mode, run: window.DEBUG_MODE = true');
  }
}
