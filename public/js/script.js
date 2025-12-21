/**
 * @fileoverview Main application entry point for the Shipping Manager web interface.
 *
 * This is the SLIM entry point that imports and coordinates all core modules:
 * - Loads and initializes the application via app-initializer
 * - Sets up the DOM ready event listener
 * - Provides security checks (demo mode block)
 *
 * **Architectural Role:**
 * Acts as the entry point that delegates to modular components. Each module
 * handles a specific concern:
 * - storage-manager: Per-user localStorage management
 * - badge-cache: Badge caching and UI updates
 * - debounced-api: Debounced API calls
 * - settings-sync: Settings synchronization across tabs
 * - event-registry: DOM event listener registration
 * - websocket-client: WebSocket connection utilities
 * - auto-refresh: Auto refresh and page visibility handling
 * - global-exports: Window global exports for HTML onclick handlers
 * - app-initializer: Main initialization orchestration
 *
 * **Initialization Sequence (orchestrated by app-initializer):**
 * 1. Load settings from server (blocks until ready)
 * 2. Set per-user storage prefix
 * 3. Register service worker for mobile notifications
 * 4. Initialize custom tooltips
 * 5. Create debounced API functions
 * 6. Attach 60+ event listeners to UI elements
 * 7. Load cached data for instant display
 * 8. Load initial data with delays between calls
 * 9. Initialize WebSocket for real-time updates
 * 10. Update page title based on AutoPilot status
 * 11. Start background image preloading
 * 12. Initialize version checker
 * 13. Set up page visibility handlers
 *
 * @module script
 * @requires ./modules/core/app-initializer - Main initialization orchestrator
 */

// Import the main initialization function
import { initializeApp } from './modules/core/app-initializer.js';
import logger from './modules/core/logger.js';

// =============================================================================
// Security Check
// =============================================================================

// Security: Block demo mode parameter in URL
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('demo')) {
  document.body.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:monospace;font-size:18px;color:#ef4444;">Demo mode has been removed</div>';
  throw new Error('Demo mode has been removed');
}

// =============================================================================
// Constants
// =============================================================================

/**
 * API prefix for all requests.
 * @constant {string}
 */
const API_PREFIX = '/api';
window.API_PREFIX = API_PREFIX;

// =============================================================================
// DOMContentLoaded - Main Application Entry Point
// =============================================================================

/**
 * Main application initialization handler.
 * Executes when DOM is fully loaded and ready for manipulation.
 *
 * This slim entry point delegates all initialization logic to the
 * app-initializer module which orchestrates:
 * - Settings loading and synchronization
 * - Service worker registration
 * - Tooltip initialization
 * - Event listener registration (60+ listeners)
 * - Data loading with anti-socket-hang-up delays
 * - WebSocket connection establishment
 * - Auto-refresh interval setup with randomization
 * - Background image preloading
 * - Version update checking
 *
 * **WebSocket-Only Updates:**
 * ALL data updates come exclusively from backend via WebSocket:
 * - chat_update: Alliance chat messages (25s interval)
 * - vessel_count_update: Vessel badges (60s interval)
 * - repair_count_update: Repair badge (60s interval)
 * - campaign_status_update: Campaigns badge (60s interval)
 * - unread_messages_update: Messages badge (10s interval)
 * - bunker_update: Bunker status (60s interval)
 * - coop_targets_update: COOP badge (60s interval)
 *
 * This eliminates duplicate API calls (frontend + backend both polling same endpoints).
 *
 * @event DOMContentLoaded
 * @async
 * @listens DOMContentLoaded
 */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Initialize the application
    const settings = await initializeApp(API_PREFIX);

    logger.debug('[Init] Application initialized successfully');

    if (window.DEBUG_MODE) {
      logger.debug('[Init] Loaded settings:', settings);
      logger.debug('[Init] API Prefix:', API_PREFIX);
      logger.debug('[Init] User ID:', window.USER_STORAGE_PREFIX);
      logger.debug('[Init] Cache Key:', window.CACHE_KEY);
    }
  } catch (error) {
    console.error('[Init] Application initialization failed:', error);

    // Show error to user
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1f1f1f;padding:20px;border-radius:8px;color:#ef4444;font-family:monospace;z-index:10000;max-width:600px;';
    errorDiv.innerHTML = `
      <h3 style="margin:0 0 10px 0;">Initialization Error</h3>
      <p style="margin:0;">${error.message}</p>
      <p style="margin:10px 0 0 0;font-size:12px;color:#888;">Check the console for more details. Try refreshing the page.</p>
    `;
    document.body.appendChild(errorDiv);
  }
});

// =============================================================================
// Module Information
// =============================================================================

/**
 * This refactored script.js has been split into the following modules:
 *
 * Core Modules (public/js/modules/core/):
 * - storage-manager.js: Per-user localStorage management (~120 lines)
 * - badge-cache.js: Badge cache loading/saving (~600 lines)
 * - debounced-api.js: Debounced API call utilities (~150 lines)
 * - settings-sync.js: Settings synchronization across tabs (~400 lines)
 * - event-registry.js: DOM event listener registration (~900 lines)
 * - websocket-client.js: WebSocket connection utilities (~200 lines)
 * - auto-refresh.js: Auto refresh and visibility handling (~300 lines)
 * - global-exports.js: Window global exports (~200 lines)
 * - app-initializer.js: Main initialization orchestration (~700 lines)
 *
 * Benefits:
 * 1. Separation of Concerns: Each module has single responsibility
 * 2. Better Testing: Individual modules can be tested in isolation
 * 3. Easier Maintenance: Find and fix issues in focused modules
 * 4. Improved Performance: Potential for lazy loading modules
 * 5. Code Reusability: Core modules can be reused across projects
 * 6. Reduced Complexity: ~150-line main file vs 3,717 lines
 *
 * All window.X assignments are preserved for HTML onclick compatibility.
 * WebSocket message handlers remain functional via chat.js.
 * Settings synchronization across tabs works via WebSocket broadcasts.
 * All 60+ event listeners are properly registered via event-registry.
 * Initialization sequence is maintained via app-initializer.
 */
