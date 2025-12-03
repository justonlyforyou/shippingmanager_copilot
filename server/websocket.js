/**
 * @fileoverview WebSocket Server and Real-Time Chat Update Management
 *
 * This module manages bidirectional real-time communication between the server and connected
 * browser clients using WebSocket protocol. It implements automatic chat feed broadcasting
 * at regular intervals to keep all connected clients synchronized with alliance chat updates.
 *
 * Key Features:
 * - WebSocket server initialization and connection lifecycle management
 * - Automatic chat feed polling every 25 seconds (configurable in config.js)
 * - Broadcast system pushing updates to all connected clients simultaneously
 * - Message transformation (converting API format to client-ready format)
 * - Company name caching to reduce API calls during message processing
 * - Graceful handling of users not in alliance (skips polling)
 *
 * Architecture:
 * This file serves as the main entry point and orchestrates sub-modules:
 * - websocket/message-cache.js - Processed DM message ID caching
 * - websocket/messenger-cache.js - Messenger chat list caching
 * - websocket/hijacking-cache.js - Hijacking case details caching
 * - websocket/broadcaster.js - WebSocket broadcasting functions
 * - websocket/chat-refresh.js - Alliance chat auto-refresh logic
 * - websocket/messenger-refresh.js - Messenger inbox auto-refresh logic
 * - websocket/hijacking-refresh.js - Hijacking cases auto-refresh logic
 *
 * @requires ws - WebSocket server implementation
 * @requires ./utils/api - API helper functions
 * @requires ./config - Configuration constants
 * @module server/websocket
 */

const WebSocket = require('ws');
const { getChatFeed, getCompanyName, getAllianceId, apiCall } = require('./utils/api');
const logger = require('./utils/logger');

// Import sub-modules
const messageCache = require('./websocket/message-cache');
const messengerCache = require('./websocket/messenger-cache');
const hijackingCache = require('./websocket/hijacking-cache');
const broadcaster = require('./websocket/broadcaster');
const chatRefresh = require('./websocket/chat-refresh');
const messengerRefresh = require('./websocket/messenger-refresh');
const hijackingRefresh = require('./websocket/hijacking-refresh');
const ipoRefresh = require('./websocket/ipo-refresh');

// Wire up cross-module dependencies
chatRefresh.setMessengerRefreshFn(messengerRefresh.performMessengerRefresh);

/**
 * Initializes the WebSocket server and sets up connection event handlers.
 *
 * This function creates a WebSocket server that operates in "noServer" mode, meaning
 * it shares the HTTPS server's port rather than opening a separate port. The upgrade
 * from HTTP to WebSocket happens via the HTTP server's 'upgrade' event (handled in app.js).
 *
 * Why noServer Mode:
 * - Shares HTTPS port 12345 instead of requiring separate WebSocket port
 * - Simplifies firewall configuration (one port instead of two)
 * - Works seamlessly with HTTPS and self-signed certificates
 * - Standard pattern for integrating WebSocket with Express
 *
 * Connection Lifecycle:
 * 1. Client sends HTTP Upgrade request to wss://localhost:12345
 * 2. Server upgrades connection to WebSocket protocol
 * 3. 'connection' event fires, logging "Client connected"
 * 4. Client remains connected until page close or network interruption
 * 5. 'close' event fires, logging "Client disconnected"
 *
 * Error Handling:
 * - Errors logged to console but don't crash server
 * - Clients can reconnect automatically after errors
 *
 * Side Effects:
 * - Sets module-level `wss` variable for use in broadcast()
 * - Logs connection/disconnection events to console
 *
 * @function initWebSocket
 * @param {https.Server} server - HTTPS server instance (from app.js)
 * @returns {WebSocket.Server} WebSocket server instance
 *
 * @example
 * const server = createHttpsServer(app);
 * const wss = initWebSocket();
 * // WebSocket server now listening for upgrade requests
 */
function initWebSocket() {
  const wss = new WebSocket.Server({ noServer: true });

  // Set the WebSocket server instance in broadcaster module
  broadcaster.setWebSocketServer(wss);

  wss.on('connection', async (ws) => {
    logger.debug('[WebSocket] Client connected');

    // Send ALL cached data immediately on connect
    try {
      const autopilot = require('./autopilot');
      const { getUserId } = require('./utils/api');
      const state = require('./state');

      const userId = getUserId();
      if (userId) {
        // Load processed message IDs cache for this user (if not already loaded)
        if (!messageCache.processedMessageIds.has(String(userId))) {
          messageCache.loadProcessedMessageCache(userId);
        }

        logger.debug('[WebSocket] Sending all cached data to client...');

        // Send current autopilot pause status FIRST
        ws.send(JSON.stringify({
          type: 'autopilot_status',
          data: { paused: autopilot.isAutopilotPaused() }
        }));

        // Send current lock statuses (prevents stuck locks after page reload/server restart)
        const locks = state.getAllLocks(userId);
        ws.send(JSON.stringify({
          type: 'lock_status',
          data: locks
        }));

        // Send ALL cached data from state
        try {
          // Prices
          const prices = state.getPrices(userId);
          // CRITICAL: Only send prices if BOTH fuel AND co2 are valid (> 0)
          // DO NOT send if either is 0, undefined, or null - frontend will keep cached value
          if (prices && prices.fuel > 0 && prices.co2 > 0) {
            ws.send(JSON.stringify({
              type: 'price_update',
              data: {
                fuel: prices.fuel,
                co2: prices.co2,
                eventDiscount: prices.eventDiscount,
                regularFuel: prices.regularFuel,
                regularCO2: prices.regularCO2
              }
            }));
            logger.debug('[WebSocket] OK Prices sent');
          } else if (prices) {
            logger.warn(`[WebSocket] Prices NOT sent - invalid values: fuel=${prices.fuel}, co2=${prices.co2}`);
          }

          // Bunker state (fuel, CO2, cash, points)
          // CRITICAL: Only send if bunker data has VALID values (not 0 defaults from empty cache)
          const bunker = state.getBunkerState(userId);
          if (bunker && bunker.cash !== undefined && bunker.maxFuel > 0 && bunker.maxCO2 > 0) {
            ws.send(JSON.stringify({
              type: 'bunker_update',
              data: bunker
            }));
            logger.debug('[WebSocket] OK Bunker state sent');
          } else {
            logger.warn('[WebSocket] Bunker state NOT sent - no valid cached data (waiting for autopilot loop)');
          }

          // Vessel counts
          let vesselCounts = state.getVesselCounts(userId);
          if (!vesselCounts) {
            // No cached data - fetch fresh from game API
            try {
              const vesselsResponse = await apiCall('/game/index', 'GET');
              if (vesselsResponse?.vessels) {
                const readyToDepart = vesselsResponse.vessels.filter(v =>
                  v.status === 'port' && !v.is_parked
                ).length;
                const atAnchor = vesselsResponse.vessels.filter(v =>
                  v.status === 'anchor'
                ).length;
                const pending = vesselsResponse.vessels.filter(v =>
                  v.status === 'pending'
                ).length;

                vesselCounts = { readyToDepart, atAnchor, pending, total: vesselsResponse.vessels.length };
                state.updateVesselCounts(userId, vesselCounts);
                logger.debug('[WebSocket] Vessel counts fetched from API');
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch vessel counts:', error.message);
            }
          }

          if (vesselCounts) {
            ws.send(JSON.stringify({
              type: 'vessel_count_update',
              data: vesselCounts
            }));
            logger.debug('[WebSocket] OK Vessel counts sent');
          }

          // Repair count
          let repairCount = state.getRepairCount(userId);
          if (repairCount === undefined) {
            // No cached data - fetch fresh from game API
            try {
              const vesselsResponse = await apiCall('/game/index', 'GET');
              if (vesselsResponse?.vessels) {
                const { getUserSettings } = require('./utils/api');
                const userSettings = getUserSettings();
                const maintenanceThreshold = userSettings?.maintenanceThreshold;
                if (maintenanceThreshold !== undefined) {
                  repairCount = vesselsResponse.vessels.filter(v =>
                    v.status === 'port' && !v.is_parked && v.maintenance < maintenanceThreshold
                  ).length;
                  state.updateRepairCount(userId, repairCount);
                  logger.debug('[WebSocket] Repair count fetched from API');
                }
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch repair count:', error.message);
            }
          }

          if (repairCount !== undefined) {
            ws.send(JSON.stringify({
              type: 'repair_count_update',
              data: { count: repairCount }
            }));
            logger.debug('[WebSocket] OK Repair count sent');
          }

          // Drydock count
          let drydockCount = state.getDrydockCount(userId);
          if (drydockCount === undefined) {
            // No cached data - fetch fresh from game API
            try {
              const vesselsResponse = await apiCall('/game/index', 'GET');
              if (vesselsResponse?.vessels) {
                const { getUserSettings } = require('./utils/api');
                const userSettings = getUserSettings();
                const drydockThreshold = userSettings?.autoDrydockThreshold;
                if (drydockThreshold !== undefined) {
                  drydockCount = vesselsResponse.vessels.filter(v =>
                    v.status === 'port' && !v.is_parked && v.age >= drydockThreshold
                  ).length;
                  state.updateDrydockCount(userId, drydockCount);
                  logger.debug('[WebSocket] Drydock count fetched from API');
                }
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch drydock count:', error.message);
            }
          }

          if (drydockCount !== undefined) {
            ws.send(JSON.stringify({
              type: 'drydock_count_update',
              data: { count: drydockCount }
            }));
            logger.debug('[WebSocket] OK Drydock count sent');
          }

          // Campaign status
          let campaignStatus = state.getCampaignStatus(userId);
          if (!campaignStatus) {
            // No cached data - fetch fresh from game API
            try {
              const campaignsResponse = await apiCall('/campaign/get-campaign', 'POST', {});
              if (campaignsResponse?.data?.campaigns) {
                const campaigns = campaignsResponse.data.campaigns;
                const activeCount = campaigns.filter(c => c.status === 'active').length;
                const active = campaigns.filter(c => c.status === 'active');
                campaignStatus = { activeCount, active };
                state.updateCampaignStatus(userId, campaignStatus);
                logger.debug('[WebSocket] Campaign status fetched from API');
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch campaign status:', error.message);
            }
          }

          if (campaignStatus) {
            ws.send(JSON.stringify({
              type: 'campaign_status_update',
              data: campaignStatus
            }));
            logger.debug('[WebSocket] OK Campaign status sent');
          }

          // COOP data - alliance-dependent
          const allianceId = getAllianceId();

          if (!allianceId) {
            // User NOT in alliance - send explicit clear signal
            ws.send(JSON.stringify({
              type: 'coop_update',
              data: { available: 0, cap: 0, coop_boost: 0 }
            }));
            logger.debug('[WebSocket] OK COOP cleared (no alliance)');
          } else {
            // User in alliance - fetch/send COOP data
            let coopData = state.getCoopData(userId);
            if (!coopData) {
              // No cached data - fetch fresh from game API
              try {
                const coopResponse = await apiCall('/coop/get-coop-data', 'POST', {});
                if (coopResponse?.data?.coop) {
                  const coop = coopResponse.data.coop;
                  coopData = {
                    available: coop.available,
                    cap: coop.cap,
                    coop_boost: coop.coop_boost
                  };
                  // Cache for future use
                  state.updateCoopData(userId, coopData);
                  logger.debug('[WebSocket] OK COOP data fetched from API (cache was empty)');
                }
              } catch (coopError) {
                logger.error('[WebSocket] Failed to fetch COOP data:', coopError.message);
              }
            }

            // Always send COOP data (even if null - will be loaded later by updateAllData)
            // This ensures the COOP button becomes visible immediately for alliance members
            if (coopData) {
              ws.send(JSON.stringify({
                type: 'coop_update',
                data: coopData
              }));
              logger.debug('[WebSocket] OK COOP data sent');
            } else {
              // Send placeholder to make button visible (data will be updated later)
              ws.send(JSON.stringify({
                type: 'coop_update',
                data: { available: 0, cap: 1, coop_boost: 0 }  // cap: 1 to show button
              }));
              logger.debug('[WebSocket] OK COOP placeholder sent (data will load later)');
            }
          }

          // Header data (stock, anchor) - alliance-dependent
          // Send header data (stock + anchor)
          let headerData = state.getHeaderData(userId);
          if (!headerData) {
            // No cached data - fetch fresh from game API
            try {
              const userSettingsResponse = await apiCall('/user/get-user-settings', 'POST', {});
              const user = userSettingsResponse?.user;
              if (user && user.anchorpoints) {
                const anchor = user.anchorpoints;
                headerData = {
                  stock: {
                    value: user.stock_value,
                    trend: user.stock_trend,
                    ipo: user.ipo
                  },
                  anchor: {
                    available: anchor.available,
                    max: anchor.max
                  }
                };
                state.updateHeaderData(userId, headerData);
                logger.debug('[WebSocket] Header data fetched from API');
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch header data:', error.message);
            }
          }

          if (headerData) {
            // If user NOT in alliance, clear stock but keep anchor (anchor is NOT alliance-dependent)
            if (!allianceId) {
              ws.send(JSON.stringify({
                type: 'header_data_update',
                data: {
                  stock: { value: 0, trend: 'none', ipo: 0 },
                  anchor: headerData.anchor || { available: 0, max: 0 }
                }
              }));
              logger.debug('[WebSocket] OK Header data sent (stock cleared, anchor kept - no alliance)');
            } else {
              // User in alliance - send full header data
              ws.send(JSON.stringify({
                type: 'header_data_update',
                data: headerData
              }));
              logger.debug('[WebSocket] OK Header data sent');
            }
          }

          // Event data
          const eventData = state.getEventData(userId);
          if (eventData) {
            ws.send(JSON.stringify({
              type: 'event_data_update',
              data: eventData
            }));
            logger.debug('[WebSocket] OK Event data sent');
          }

        } catch (cacheError) {
          logger.error('[WebSocket] Failed to send cached data:', cacheError.message);
        }

        // Send initial chat data
        try {
          const allianceId = getAllianceId();
          if (allianceId) {
            const chatData = await getChatFeed();
            if (chatData && chatData.messages && chatData.messages.length > 0) {
              const messages = await Promise.all(
                chatData.messages.map(async (msg) => {
                  let companyName = msg.user_company_name || 'Unknown';
                  if (!msg.user_company_name && msg.user_id) {
                    companyName = await getCompanyName(msg.user_id);
                  }
                  return {
                    type: msg.type || 'chat',
                    userId: msg.user_id,
                    companyName: companyName,
                    message: msg.message,
                    timestamp: msg.timestamp
                  };
                })
              );
              ws.send(JSON.stringify({
                type: 'chat_update',
                data: messages
              }));
              logger.debug('[WebSocket] OK Chat data sent');
            }
          }
        } catch (chatError) {
          logger.error('[WebSocket] Failed to send chat data:', chatError.message);
        }

        // Send messenger/hijacking counts
        try {
          const chats = await messengerCache.getCachedMessengerChats();
          const unreadCount = chats.filter(chat => {
            if (!chat.new) return false;
            if (chat.system_chat && chat.body === 'vessel_got_hijacked') return false;
            return true;
          }).length;

          ws.send(JSON.stringify({
            type: 'messenger_update',
            data: { messages: unreadCount, chats: chats.length }
          }));
          logger.debug('[WebSocket] OK Messenger counts sent');

          // Hijacking counts
          const hijackingChats = chats.filter(chat =>
            chat.system_chat && chat.body === 'vessel_got_hijacked'
          );
          const casesWithDetails = await Promise.all(
            hijackingChats.map(async (chat) => {
              const caseId = chat.values?.case_id;
              if (!caseId) return null;
              return await hijackingCache.getCachedHijackingCase(caseId);
            })
          );
          const cases = casesWithDetails.filter(c => c !== null);
          const openCases = cases.filter(c => c.isOpen).length;
          const hijackedCount = cases.filter(c => {
            const status = c.details?.status;
            return status === 'in_progress' || (c.isOpen && status !== 'solved');
          }).length;

          ws.send(JSON.stringify({
            type: 'hijacking_update',
            data: { openCases, totalCases: cases.length, hijackedCount }
          }));
          logger.debug('[WebSocket] OK Hijacking counts sent');

        } catch (messengerError) {
          logger.error('[WebSocket] Failed to send messenger/hijacking data:', messengerError.message);
        }

        logger.debug('[WebSocket] All cached data sent to client');
      }
    } catch (error) {
      logger.error('[WebSocket] Failed to send initial data:', error.message);
    }

    ws.on('close', () => {
      logger.debug('[WebSocket] Client disconnected');
    });

    ws.on('error', (error) => {
      logger.error('[WebSocket] Error:', error.message);
    });
  });

  return wss;
}

// Re-export all functions for backward compatibility
module.exports = {
  // Core WebSocket
  initWebSocket,

  // Broadcasting (from broadcaster.js)
  broadcast: broadcaster.broadcast,
  broadcastToUser: broadcaster.broadcastToUser,
  broadcastBunkerUpdate: broadcaster.broadcastBunkerUpdate,
  broadcastHarborMapRefresh: broadcaster.broadcastHarborMapRefresh,

  // Chat refresh (from chat-refresh.js)
  startChatAutoRefresh: chatRefresh.startChatAutoRefresh,
  stopChatAutoRefresh: chatRefresh.stopChatAutoRefresh,
  triggerImmediateChatRefresh: chatRefresh.triggerImmediateChatRefresh,

  // Messenger refresh (from messenger-refresh.js)
  startMessengerAutoRefresh: messengerRefresh.startMessengerAutoRefresh,
  stopMessengerAutoRefresh: messengerRefresh.stopMessengerAutoRefresh,
  triggerImmediateMessengerRefresh: messengerRefresh.triggerImmediateMessengerRefresh,

  // Hijacking refresh (from hijacking-refresh.js)
  startHijackingAutoRefresh: hijackingRefresh.startHijackingAutoRefresh,
  stopHijackingAutoRefresh: hijackingRefresh.stopHijackingAutoRefresh,
  triggerImmediateHijackingRefresh: hijackingRefresh.triggerImmediateHijackingRefresh,

  // IPO refresh (from ipo-refresh.js)
  startIpoAutoRefresh: ipoRefresh.startIpoAutoRefresh,
  stopIpoAutoRefresh: ipoRefresh.stopIpoAutoRefresh,
  triggerImmediateIpoRefresh: ipoRefresh.triggerImmediateIpoRefresh,
  resetIpoCache: ipoRefresh.resetIpoCache,
  getFreshIpos: ipoRefresh.getFreshIpos,

  // Caching functions (from cache modules)
  getCachedMessengerChats: messengerCache.getCachedMessengerChats,
  getCachedHijackingCase: hijackingCache.getCachedHijackingCase,
  invalidateHijackingCase: hijackingCache.invalidateHijackingCase
};
