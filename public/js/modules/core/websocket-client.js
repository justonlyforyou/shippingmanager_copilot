/**
 * @fileoverview WebSocket client module.
 * Handles WebSocket connection initialization and provides utilities.
 * Note: The actual WebSocket message handling is in chat.js module
 * which is already set up with the proper handlers.
 *
 * @module core/websocket-client
 */

import logger from './logger.js';

/**
 * WebSocket connection state tracking.
 * @type {Object}
 */
const wsState = {
  connected: false,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
  reconnectDelay: 5000
};

/**
 * Initialize autopilot button update function.
 * This must be defined BEFORE WebSocket connects as the WebSocket may send
 * initial autopilot_status event.
 *
 * @param {Function} getStorage - Storage getter function
 * @param {Function} setStorage - Storage setter function
 * @param {Function} showSideNotification - Notification function
 * @param {Function} apiUrl - API URL builder function
 * @returns {Object} Autopilot control functions
 */
export function initAutopilotControls(getStorage, setStorage, showSideNotification, apiUrl) {
  /**
   * Updates autopilot button icon and title
   * @param {boolean} isPaused - True if autopilot is paused
   */
  const updateButton = (isPaused) => {
    const icon = document.getElementById('autopilotToggleIcon');
    const headerTitle = document.querySelector('.autopilot-active');

    if (icon && headerTitle) {
      if (isPaused) {
        // Paused state - RED with PLAY icon (to resume)
        icon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        headerTitle.classList.add('paused');
      } else {
        // Running state - GREEN with PAUSE icon (two bars)
        icon.innerHTML = `<path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>`;
        headerTitle.classList.remove('paused');
      }
    }
  };

  /**
   * Toggles autopilot pause/resume state
   */
  const toggle = async () => {
    try {
      const cachedPauseState = getStorage('autopilotPaused');
      const currentlyPaused = cachedPauseState ? JSON.parse(cachedPauseState) : false;
      const newPauseState = !currentlyPaused;

      logger.debug('[Autopilot Toggle] Switching from', currentlyPaused ? 'PAUSED' : 'RUNNING', 'to', newPauseState ? 'PAUSED' : 'RUNNING');

      // Send toggle request to backend
      const response = await fetch(apiUrl('/api/autopilot/toggle'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: newPauseState })
      });

      if (!response.ok) {
        throw new Error('Failed to toggle autopilot');
      }

      await response.json();

      // Update UI immediately (WebSocket will send notification to all clients)
      setStorage('autopilotPaused', JSON.stringify(newPauseState));
      updateButton(newPauseState);

    } catch (error) {
      console.error('[Autopilot Toggle] Error:', error);
      showSideNotification('Failed to toggle autopilot', 'error', 5000, true);
    }
  };

  /**
   * Handles autopilot status updates from WebSocket
   * @param {Object} data - Status update data
   * @param {boolean} data.paused - Autopilot pause state
   */
  const onStatusUpdate = (data) => {
    // Get previous state to detect actual changes
    const cachedPauseState = getStorage('autopilotPaused');
    const previousPaused = cachedPauseState ? JSON.parse(cachedPauseState) : null;
    const hasChanged = previousPaused !== null && previousPaused !== data.paused;

    // Save to per-user localStorage for instant load on next page refresh
    setStorage('autopilotPaused', JSON.stringify(data.paused));
    updateButton(data.paused);

    // Show side notification ONLY if state actually changed (not on initial load)
    if (hasChanged) {
      if (data.paused) {
        showSideNotification('<strong>AutoPilot</strong><br><br>All automated functions are now on hold', 'warning', 5000, true);
      } else {
        showSideNotification('<strong>AutoPilot</strong><br><br>All automated functions are now active', 'success', 5000, true);
      }
    }
  };

  return {
    updateButton,
    toggle,
    onStatusUpdate
  };
}

/**
 * Load autopilot pause state from localStorage.
 * CRITICAL: Only load if userId validated to prevent showing wrong account state.
 *
 * @param {Function} updateButton - Function to update autopilot button UI
 * @param {Function} getStorage - Storage getter function
 */
export function loadAutopilotState(updateButton, getStorage) {
  try {
    const currentUserId = window.USER_STORAGE_PREFIX;

    if (!currentUserId) {
      logger.debug('[Autopilot UI] Skipping cached state - userId not validated (will use WebSocket state)');
      updateButton(false);
    } else {
      const cachedPauseState = getStorage('autopilotPaused');
      if (cachedPauseState !== null) {
        const isPaused = JSON.parse(cachedPauseState);
        logger.debug('[Autopilot UI] Loaded cached pause state:', isPaused ? 'PAUSED' : 'RUNNING');
        updateButton(isPaused);
      } else {
        logger.debug('[Autopilot UI] No cached state found - defaulting to RUNNING');
        updateButton(false);
      }
    }
  } catch (error) {
    console.error('[Autopilot UI] Failed to load cached pause state:', error);
    updateButton(false);
  }
}

/**
 * Trigger price alert check on backend.
 * Backend will send alerts via WebSocket if needed.
 *
 * @param {boolean} debugMode - Whether debug mode is enabled
 */
export async function triggerPriceAlertCheck(debugMode) {
  try {
    fetch('/api/check-price-alerts', { method: 'POST' });
    if (debugMode) {
      logger.debug('[Init] Price alert check triggered');
    }
  } catch (error) {
    console.error('[Init] Failed to trigger price alerts:', error);
  }
}

/**
 * Get WebSocket connection state.
 *
 * @returns {Object} Current WebSocket state
 */
export function getWebSocketState() {
  return { ...wsState };
}

/**
 * Update WebSocket connection state.
 *
 * @param {Object} newState - New state properties to merge
 */
export function updateWebSocketState(newState) {
  Object.assign(wsState, newState);
}

/**
 * Reset WebSocket reconnect counter.
 * Called when connection is successfully established.
 */
export function resetReconnectCounter() {
  wsState.reconnectAttempts = 0;
}

/**
 * Increment WebSocket reconnect counter.
 *
 * @returns {boolean} True if can still retry, false if max attempts reached
 */
export function incrementReconnectCounter() {
  wsState.reconnectAttempts++;
  return wsState.reconnectAttempts < wsState.maxReconnectAttempts;
}
