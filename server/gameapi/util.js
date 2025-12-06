/**
 * @fileoverview Utility API Client Module
 *
 * This module handles utility API calls including:
 * - Fetching unread message counts
 * - Getting active event data
 * - Retrieving complete game index state
 *
 * @requires ../utils/api - API helper functions
 * @requires ../utils/logger - Logging utility
 * @module server/gameapi/util
 */

const { apiCall } = require('../utils/api');
const logger = require('../utils/logger');
const cache = require('../cache');

/**
 * Fetches the count of unread messages.
 * Uses cached messenger data from WebSocket to reduce API calls.
 * Includes system messages like hijack notifications.
 *
 * @returns {Promise<number>} Count of unread messages
 */
async function fetchUnreadMessages() {
  try {
    // Use shared cache from websocket.js to reduce duplicate API calls
    const { getCachedMessengerChats } = require('../websocket');
    const chats = await getCachedMessengerChats();

    // Debug: Log all chats with their properties
    logger.debug(`[GameAPI] Total chats: ${chats.length}`);
    chats.forEach((chat, i) => {
      logger.debug(`[GameAPI] Chat ${i}: system_chat=${chat.system_chat}, new=${chat.new}, subject="${chat.subject || 'N/A'}"`);
    });

    // Count ALL chats where new=true (including system messages like hijack notifications)
    const unreadCount = chats.filter(chat => chat.new).length;
    logger.debug(`[GameAPI] Unread messages count (including system): ${unreadCount}`);
    return unreadCount;
  } catch (error) {
    logger.error('[GameAPI] Error fetching unread messages:', error.message);
    return 0;
  }
}

/**
 * Fetches data about the current active event, if any.
 * Uses global cache (10s TTL) to reduce duplicate API calls.
 * Events affect pricing (discounts) and demand multipliers.
 * Used by fetchPrices() to apply event discounts automatically.
 *
 * @returns {Promise<Object|null>} Event data or null if no active event
 */
async function fetchEventData() {
  // Use cache to avoid duplicate /game/index calls
  let data = cache.getGameIndexCache();
  if (!data) {
    data = await apiCall('/game/index', 'POST', {});
    cache.setGameIndexCache(data);
  }

  if (!data.data || !data.data.event || data.data.event.length === 0) {
    logger.debug('[GameAPI] No active events');
    return null;
  }

  const event = data.data.event[0];

  logger.debug(`[GameAPI] Active event: ${event.name} (${event.type})`);
  logger.debug(`[GameAPI] Discount: ${event.discount_percentage}% off ${event.discount_type}`);
  logger.debug(`[GameAPI] Demand multiplier: ${event.daily_demand_multiplier}x`);
  logger.debug(`[GameAPI] Ends in: ${Math.floor(event.ends_in / 3600)}h ${Math.floor((event.ends_in % 3600) / 60)}m`);

  return event;
}

/**
 * Fetches complete game state from /game/index.
 * Uses global cache (10s TTL) to reduce duplicate API calls.
 * Returns all vessels, ports, and game data.
 *
 * @returns {Promise<Object>} Game index data with vessels and ports
 */
async function getGameIndex() {
  let data = cache.getGameIndexCache();
  if (!data) {
    data = await apiCall('/game/index', 'POST', {});
    cache.setGameIndexCache(data);
  }
  return data;
}

module.exports = {
  fetchUnreadMessages,
  fetchEventData,
  getGameIndex
};