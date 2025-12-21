/**
 * @fileoverview WebSocket Broadcasting Functions
 *
 * Provides centralized broadcasting functionality for sending messages
 * to all connected WebSocket clients or specific users.
 *
 * @module server/websocket/broadcaster
 */

const WebSocket = require('ws');
const logger = require('../utils/logger');

/**
 * Allowed WebSocket message types (whitelist for security)
 * Only these types can be broadcast to clients
 * @constant {Set<string>}
 */
const ALLOWED_MESSAGE_TYPES = new Set([
  // Bunker/Price updates
  'bunker_update',
  'price_update',
  'price_alert',
  'fuel_purchase_start',
  'fuel_purchase_complete',
  'co2_purchase_start',
  'co2_purchase_complete',
  // Vessel operations
  'vessels_departed',
  'vessels_failed',
  'vessels_repaired',
  'vessel_update',
  'vessel_count_update',
  'vessels_depart_complete',
  'vessels_depart_batch',
  'autopilot_depart_start',
  'depart_start',
  // Purchase events
  'fuel_purchased',
  'co2_purchased',
  'vessel_purchased',
  'bulk_buy_start',
  'bulk_buy_complete',
  'purser_purchase',
  'purser_sell',
  // Repair events
  'repair_start',
  'repair_complete',
  'repair_count_update',
  'auto_repair_complete',
  // Drydock events
  'drydock_start',
  'drydock_complete',
  'vessels_drydocked',
  'drydock_count_update',
  // Logbook
  'logbook_update',
  // Chat/Notifications
  'chat_update',
  'system_notification',
  'generic_notification',
  'user_action_notification',
  'notification',
  'desktop_notification',
  // Messenger
  'messenger_update',
  // Autopilot events
  'autopilot_status',
  'campaigns_renewed',
  'auto_coop_no_targets',
  'auto_coop_complete',
  'coop_send_start',
  'coop_send_complete',
  'coop_update',
  // Lock status
  'lock_status',
  // Data updates
  'company_type_update',
  'staff_training_points_update',
  'header_data_update',
  'event_data_update',
  'campaign_status_update',
  'all_data_updated',
  'settings_update',
  // Harbor map
  'harbor_map_refresh_required',
  // Hijacking
  'hijacking_update',
  // Staff/IPO updates
  'staff_update',
  'ipo_alert_update',
  'price_alerts',
  // Anchor events
  'anchor_update',
  'anchor_purchase_timer',
  // Server lifecycle
  'server_startup',
  // Alliance events
  'alliance_changed',
  'alliance_index_ready',
  // Changelog
  'changelog_acknowledged'
]);

/**
 * WebSocket server instance (shared across all connections)
 * @type {WebSocket.Server|null}
 */
let wss = null;

/**
 * Sets the WebSocket server instance for broadcasting.
 * Must be called after WebSocket server initialization.
 *
 * @param {WebSocket.Server} wsServer - WebSocket server instance
 */
function setWebSocketServer(wsServer) {
  wss = wsServer;
}

/**
 * Gets the WebSocket server instance.
 *
 * @returns {WebSocket.Server|null} WebSocket server instance
 */
function getWebSocketServer() {
  return wss;
}

/**
 * Broadcasts a message to all connected WebSocket clients.
 *
 * This function sends data to every client currently connected to the WebSocket server.
 * It only sends to clients in OPEN state (connected and ready), skipping clients that
 * are CONNECTING, CLOSING, or CLOSED.
 *
 * Why This Pattern:
 * - Centralized broadcast logic used by multiple features (chat updates, system notifications)
 * - Automatically skips clients in transitional states to prevent errors
 * - Type-based routing allows frontend to handle different message types appropriately
 * - JSON serialization ensures structured data transmission
 *
 * Message Format:
 * {
 *   type: 'chat_update' | 'system_notification' | ...,
 *   data: <any>
 * }
 *
 * Safety Features:
 * - Early return if WebSocket server not initialized
 * - readyState check prevents sending to disconnecting clients
 * - JSON.stringify errors won't crash server (client.send handles errors)
 *
 * Use Cases:
 * - Chat feed updates every 25 seconds
 * - New message notifications
 * - System status updates
 * - Real-time game state changes
 *
 * @function broadcast
 * @param {string} type - Message type for client-side routing (e.g., 'chat_update')
 * @param {*} data - Payload data (will be JSON serialized)
 * @returns {void}
 *
 * @example
 * broadcast('chat_update', [
 *   { type: 'chat', company: 'ABC Corp', message: 'Hello!' }
 * ]);
 * // Sends to all connected clients:
 * // {"type":"chat_update","data":[{"type":"chat",...}]}
 *
 * @example
 * broadcast('system_notification', { message: 'Server restarting in 5 minutes' });
 */
function broadcast(type, data) {
  if (!wss) {
    logger.error('[WebSocket] Cannot broadcast, wss is NULL');
    return;
  }

  // Security: Only allow whitelisted message types
  if (!ALLOWED_MESSAGE_TYPES.has(type)) {
    const error = new Error(`[WebSocket] FATAL: Unknown broadcast type '${type}' - add to ALLOWED_MESSAGE_TYPES in broadcaster.js`);
    logger.error(error.message);
    throw error;
  }

  // Security: Validate data is serializable and not null/undefined
  if (data === undefined) {
    logger.warn(`[WebSocket] Blocked broadcast with undefined data for type: ${type}`);
    return;
  }

  const openClients = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);

  logger.debug(`[WebSocket] Broadcasting '${type}' to ${openClients.length} client(s)`);

  try {
    const message = JSON.stringify({ type, data });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (error) {
    logger.error(`[WebSocket] Failed to serialize broadcast data for type ${type}:`, error.message);
  }
}

/**
 * Helper function to broadcast bunker updates with current prices.
 * ALWAYS includes prices to prevent race condition where prices get overwritten with undefined.
 *
 * @param {number} userId - User ID
 * @param {Object} bunkerData - Bunker state (fuel, co2, cash, maxFuel, maxCO2)
 * @returns {void}
 */
function broadcastBunkerUpdate(userId, bunkerData) {
  const state = require('../state');
  const currentPrices = state.getPrices(userId);

  const fullBunkerData = {
    ...bunkerData,
    prices: {
      fuelPrice: currentPrices.fuel,
      co2Price: currentPrices.co2,
      eventDiscount: currentPrices.eventDiscount,
      regularFuel: currentPrices.regularFuel,
      regularCO2: currentPrices.regularCO2
    }
  };

  broadcast('bunker_update', fullBunkerData);
}

/**
 * Broadcasts a message to all WebSocket clients belonging to a specific user.
 *
 * In this single-user application, all connected clients belong to the same user,
 * so this function simply wraps broadcast(). The userId parameter is accepted for
 * future scalability (multi-user support).
 *
 * Used by autopilot features to send events to user's connected clients:
 * - price_update: Price changes (fuel/CO2)
 * - price_alert: Price threshold alerts
 * - fuel_purchased: Auto-rebuy fuel success
 * - co2_purchased: Auto-rebuy CO2 success
 * - vessels_departed: Auto-depart success
 * - vessels_failed: Auto-depart failures
 * - vessels_repaired: Auto-repair success
 * - campaigns_renewed: Auto-campaign renewal success
 *
 * @function broadcastToUser
 * @param {number} userId - User ID (currently unused, for future multi-user support)
 * @param {string} type - Message type for client-side routing
 * @param {*} data - Payload data (will be JSON serialized)
 * @returns {void}
 *
 * @example
 * broadcastToUser(12345, 'fuel_purchased', {
 *   amount: 100,
 *   price: 380,
 *   newTotal: 500,
 *   cost: 38000
 * });
 */
// Debounce for bunker_update - max 1 per second
let lastBunkerUpdate = 0;
let pendingBunkerData = null;
let bunkerDebounceTimer = null;
const BUNKER_UPDATE_COOLDOWN = 1000; // 1 second

function broadcastToUser(userId, type, data) {
  // Special handling for bunker_update: debounce + always include prices
  if (type === 'bunker_update') {
    const state = require('../state');

    // Add prices if missing
    if (data && !data.prices) {
      const currentPrices = state.getPrices(userId);
      if (currentPrices.fuel > 0 && currentPrices.co2 > 0) {
        data.prices = {
          fuelPrice: currentPrices.fuel,
          co2Price: currentPrices.co2,
          eventDiscount: currentPrices.eventDiscount,
          regularFuel: currentPrices.regularFuel,
          regularCO2: currentPrices.regularCO2
        };
      }
    }

    // Debounce: store latest data, send max once per second
    const now = Date.now();
    pendingBunkerData = data;

    if (now - lastBunkerUpdate >= BUNKER_UPDATE_COOLDOWN) {
      // Enough time passed, send immediately
      lastBunkerUpdate = now;
      broadcast(type, data);
      pendingBunkerData = null;
    } else if (!bunkerDebounceTimer) {
      // Schedule send after cooldown
      const delay = BUNKER_UPDATE_COOLDOWN - (now - lastBunkerUpdate);
      bunkerDebounceTimer = setTimeout(() => {
        bunkerDebounceTimer = null;
        if (pendingBunkerData) {
          lastBunkerUpdate = Date.now();
          broadcast('bunker_update', pendingBunkerData);
          pendingBunkerData = null;
        }
      }, delay);
    }
    // If timer already running, pendingBunkerData will be sent when it fires
    return;
  }

  // In single-user mode, broadcast to all clients
  // userId parameter reserved for future multi-user support
  broadcast(type, data);
}

// Rate limiting for Harbor Map refresh broadcasts
let lastHarborMapBroadcast = 0;
const HARBOR_MAP_COOLDOWN = 30000; // 30 seconds

/**
 * Broadcasts a Harbor Map refresh event with rate limiting.
 * Only broadcasts if > 30 seconds since last broadcast.
 *
 * @param {string} userId - User ID
 * @param {string} reason - Reason for refresh (e.g., "vessels_departed", "vessels_purchased", "ports_purchased", "interval")
 * @param {Object} data - Additional data to include in broadcast
 * @returns {boolean} - True if broadcast sent, false if skipped due to cooldown
 */
function broadcastHarborMapRefresh(userId, reason, data = {}) {
  const now = Date.now();
  const timeSinceLastBroadcast = now - lastHarborMapBroadcast;

  // Skip if within cooldown period
  if (timeSinceLastBroadcast < HARBOR_MAP_COOLDOWN) {
    logger.debug(`[Harbor Map] Skipping broadcast (cooldown active, ${Math.floor((HARBOR_MAP_COOLDOWN - timeSinceLastBroadcast) / 1000)}s remaining)`);
    return false;
  }

  // Update last broadcast timestamp
  lastHarborMapBroadcast = now;

  // Broadcast the event
  broadcastToUser(userId, 'harbor_map_refresh_required', {
    reason,
    timestamp: now,
    ...data
  });

  logger.debug(`[Harbor Map] Refresh broadcast sent (reason: ${reason})`);
  return true;
}

module.exports = {
  setWebSocketServer,
  getWebSocketServer,
  broadcast,
  broadcastBunkerUpdate,
  broadcastToUser,
  broadcastHarborMapRefresh
};
