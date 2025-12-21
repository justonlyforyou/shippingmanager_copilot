/**
 * @fileoverview Changelog Popup Module
 *
 * Shows a modal popup with changelog/release notes on new versions.
 * User must scroll to bottom and acknowledge before it dismisses.
 * Acknowledgment is stored server-side so it syncs across devices.
 *
 * @module changelog-popup
 */

import logger from './core/logger.js';

let popupOpen = false;

/**
 * Check if changelog needs to be shown and display popup if needed
 * Called on app initialization
 */
export async function checkAndShowChangelog() {
  try {
    const response = await fetch(window.apiUrl('/api/changelog'));
    if (!response.ok) {
      logger.debug('[Changelog] Failed to fetch changelog:', response.status);
      return;
    }

    const data = await response.json();

    if (!data.success) {
      logger.debug('[Changelog] API returned error');
      return;
    }

    // If already acknowledged, don't show
    if (data.acknowledged) {
      logger.debug('[Changelog] Version', data.version, 'already acknowledged');
      return;
    }

    // Show the popup
    showChangelogPopup(data.version, data.changelog);
  } catch (error) {
    logger.debug('[Changelog] Error checking changelog:', error.message);
  }
}

/**
 * Show the changelog popup
 * @param {string} version - Current version
 * @param {string} changelogHtml - Changelog content as HTML
 */
function showChangelogPopup(version, changelogHtml) {
  if (popupOpen) return;
  popupOpen = true;

  const overlay = document.getElementById('changelogOverlay');
  const content = document.getElementById('changelogContent');
  const versionSpan = document.getElementById('changelogVersion');
  const acknowledgeBtn = document.getElementById('changelogAcknowledgeBtn');
  const scrollContainer = document.getElementById('changelogScrollContainer');

  if (!overlay || !content || !versionSpan || !acknowledgeBtn || !scrollContainer) {
    logger.warn('[Changelog] Popup elements not found in DOM');
    popupOpen = false;
    return;
  }

  // Set content
  versionSpan.textContent = version;
  content.innerHTML = changelogHtml;

  // Disable button initially - user must scroll and click "Got it" to dismiss
  acknowledgeBtn.disabled = true;
  acknowledgeBtn.classList.add('disabled');

  // Show overlay
  overlay.classList.remove('hidden');

  // Check scroll position to enable button
  const checkScroll = () => {
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 20; // 20px tolerance

    if (isAtBottom) {
      acknowledgeBtn.disabled = false;
      acknowledgeBtn.classList.remove('disabled');
    }
  };

  // If content is short enough to not need scrolling, enable button immediately
  setTimeout(() => {
    if (scrollContainer.scrollHeight <= scrollContainer.clientHeight) {
      acknowledgeBtn.disabled = false;
      acknowledgeBtn.classList.remove('disabled');
    }
  }, 100);

  // Listen for scroll
  scrollContainer.addEventListener('scroll', checkScroll);

  // Handle acknowledge button click
  acknowledgeBtn.onclick = async () => {
    try {
      acknowledgeBtn.disabled = true;
      acknowledgeBtn.textContent = 'Saving...';

      const response = await fetch(window.apiUrl('/api/changelog/acknowledge'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        closeChangelogPopup();
        logger.debug('[Changelog] Acknowledged version', version);
      } else {
        acknowledgeBtn.disabled = false;
        acknowledgeBtn.textContent = 'Aye Aye - I Understand';
        logger.warn('[Changelog] Failed to acknowledge');
      }
    } catch (error) {
      acknowledgeBtn.disabled = false;
      acknowledgeBtn.textContent = 'Aye Aye - I Understand';
      logger.warn('[Changelog] Error acknowledging:', error.message);
    }
  };

  logger.debug('[Changelog] Showing popup for version', version);
}

/**
 * Close the changelog popup
 */
function closeChangelogPopup() {
  const overlay = document.getElementById('changelogOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
  popupOpen = false;
}

/**
 * Handle WebSocket broadcast when changelog is acknowledged
 * Closes popup on all connected tabs/devices
 */
export function handleChangelogAcknowledged() {
  closeChangelogPopup();
  logger.debug('[Changelog] Popup closed via WebSocket broadcast');
}

/**
 * Initialize changelog popup module
 * Sets up WebSocket listener for cross-tab sync
 */
export function initChangelogPopup() {
  // WebSocket handler will be registered in chat.js where WebSocket is managed
  logger.debug('[Changelog] Module initialized');
}
