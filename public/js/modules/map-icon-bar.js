/**
 * @fileoverview Map Icon Bar
 * Floating icon bar on harbor map that provides quick access to actions
 * Desktop: Horizontal top-right, Mobile: Vertical right side
 *
 * @module map-icon-bar
 */

/**
 * Initialize map icon bar
 * - Wire up click handlers to call functions directly
 * - No more hidden buttons or MutationObserver syncing
 */
export function initializeMapIconBar() {
  const iconBar = document.getElementById('mapIconBar');
  if (!iconBar) {
    console.warn('[Map Icon Bar] Icon bar not found');
    return;
  }

  // Import functions dynamically when needed
  // Note: We'll attach these at runtime from script.js to avoid circular dependencies

  // Wire up click handlers
  const iconItems = iconBar.querySelectorAll('.map-icon-item');
  iconItems.forEach(item => {
    const action = item.dataset.action;

    item.addEventListener('click', () => {
      // Call the appropriate function based on action
      handleIconAction(action);
    });
  });

  console.log('[Map Icon Bar] Initialized');
}

/**
 * Close all modal overlays
 * Called before opening a new modal to ensure only one is open at a time
 * Exported on window for use by other modules (Leaflet controls, etc.)
 */
export function closeAllModalOverlays() {
  const modalOverlayIds = [
    'forecastOverlay',
    'logbookOverlay',
    'settingsOverlay',
    'buyVesselsOverlay',
    'sellVesselsOverlay',
    'buildShipOverlay',
    'messengerOverlay',
    'hijackOverlay',
    'campaignsOverlay',
    'coopOverlay',
    'allianceChatOverlay',
    'contactListOverlay',
    'anchorOverlay',
    'docsOverlay',
    'companyProfileOverlay',
    'stockManagerOverlay',
    'stockCompanyDetailOverlay'
  ];

  modalOverlayIds.forEach(id => {
    const overlay = document.getElementById(id);
    if (overlay && !overlay.classList.contains('hidden')) {
      overlay.classList.add('hidden');
    }
  });
}

/**
 * Handle icon click action
 * @param {string} action - Action name from data-action attribute
 */
function handleIconAction(action) {
  // Actions that open modal overlays (need to close others first)
  const modalActions = [
    'buyVessels', 'sellVessels', 'messenger', 'hijacking',
    'campaigns', 'coop', 'allianceChat', 'contactList',
    'settings', 'forecast', 'logbook', 'docs', 'anchor', 'stockManager'
  ];

  // Close other modals before opening a new one
  if (modalActions.includes(action)) {
    closeAllModalOverlays();
  }

  // Map actions to their corresponding window functions
  // Using arrow functions to defer window lookup until click time
  // This fixes timing issues in Edge where modules may load slower
  const actionHandlers = {
    'departAll': () => window.openDepartManager?.(),
    'anchor': () => window.showAnchorInfo?.(),
    'repairAll': () => window.openRepairAndDrydockDialog?.(window.getSettings?.() || {}),
    'buyVessels': () => window.showBuyVesselsOverlay?.(),
    'sellVessels': () => window.openSellVesselsOverlay?.(),
    'messenger': () => window.showAllChats?.(),
    'hijacking': () => window.openHijackingInbox?.(),
    'campaigns': () => window.showCampaignsOverlay?.(),
    'coop': () => window.showCoopOverlay?.(),
    'allianceChat': () => window.showAllianceChatOverlay?.(),
    'contactList': () => window.showContactList?.(),
    'settings': () => window.showSettings?.(),
    'forecast': () => window.showForecastOverlay?.(),
    'logbook': () => window.showLogbookOverlay?.(),
    'docs': () => window.showDocsOverlay?.(),
    'stockManager': () => window.showStockManager?.()
  };

  const handler = actionHandlers[action];
  if (handler) {
    handler();
  } else {
    console.warn(`[Map Icon Bar] No handler found for action: ${action}`);
  }
}
