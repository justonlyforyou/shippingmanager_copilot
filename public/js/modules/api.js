/**
 * @fileoverview API module for all client-server communication.
 * Handles all HTTP requests to the backend API endpoints including chat,
 * vessels, bunker management, messenger, campaigns, and user data.
 *
 * All functions implement proper error handling and return promises.
 *
 * @module api
 */

// Vessel data cache - only invalidated on actual changes (purchase, sale, WebSocket updates)
const vesselDataCache = {
  acquirable: { data: null, valid: false },
  owned: { data: null, valid: false }
};

// Force cache refresh (called by WebSocket updates or after purchases/sales)
export function invalidateVesselCache(type = 'all') {
  if (type === 'all' || type === 'acquirable') {
    vesselDataCache.acquirable.valid = false;
  }
  if (type === 'all' || type === 'owned') {
    vesselDataCache.owned.valid = false;
  }
}

/**
 * Fetches company name for a user from backend.
 * Backend handles caching, so no frontend cache needed.
 * Falls back to "User {id}" if fetch fails.
 *
 * @param {number|string} userId - User ID to fetch company name for
 * @returns {Promise<string>} Company name or fallback string
 * @example
 * const name = await getCompanyNameCached(123);
 * // => "Acme Shipping Co."
 */
export async function getCompanyNameCached(userId) {
  const userIdInt = parseInt(userId);

  try {
    const response = await fetch(window.apiUrl('/api/company-name'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userIdInt })
    });

    if (!response.ok) throw new Error('Failed to get company name');
    const data = await response.json();
    return data.company_name;
  } catch {
    return `User ${userIdInt}`;
  }
}

/**
 * Fetches the list of all alliance members.
 * Returns empty array if request fails.
 *
 * @returns {Promise<Array<Object>>} Array of alliance member objects
 * @property {number} user_id - Member's user ID
 * @property {string} company_name - Member's company name
 */
export async function fetchAllianceMembers() {
  try {
    const response = await fetch(window.apiUrl('/api/alliance-members'));
    if (!response.ok) throw new Error('Failed to load alliance members');
    const data = await response.json();
    return data.members || [];
  } catch (error) {
    console.error('Error loading alliance members:', error);
    return [];
  }
}

/**
 * Fetches the alliance chat feed including both chat messages and system feed events.
 *
 * @returns {Promise<Object>} Chat data object
 * @property {Array<Object>} feed - Array of chat/feed events
 * @property {number} own_user_id - Current user's ID
 * @property {string} own_company_name - Current user's company name
 * @throws {Error} If fetch fails
 */
export async function fetchChat() {
  try {
    const response = await fetch(window.apiUrl('/api/chat'));
    if (!response.ok) throw new Error('Failed to load chat feed');
    return await response.json();
  } catch (error) {
    console.error('Error loading messages:', error);
    throw error;
  }
}

/**
 * Sends a message to the alliance chat.
 * Message must be valid according to game rules (length, content).
 *
 * @param {string} message - Message text to send
 * @returns {Promise<Object>} Response data from server
 * @property {boolean} success - Whether message was sent successfully
 * @throws {Error} If message sending fails or validation fails
 */
export async function sendChatMessage(message) {
  try {
    const response = await fetch(window.apiUrl('/api/send-message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error);
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Fetches all vessels owned by the current user.
 * Includes vessels in harbor, at sea, and pending delivery.
 *
 * @returns {Promise<Object>} Vessel data object
 * @property {Array<Object>} vessels - Array of vessel objects
 * @property {Object} vessels[].vessel_id - Unique vessel ID
 * @property {string} vessels[].name - Vessel name
 * @property {string} vessels[].status - Status (harbor/at_sea/pending)
 * @property {number} vessels[].wear - Wear percentage (0-100)
 * @throws {Error} If fetch fails
 */
export async function fetchVessels(useCache = true) {
  // Return cached data if valid
  if (useCache && vesselDataCache.owned.valid && vesselDataCache.owned.data) {
    if (window.DEBUG_MODE) {
      console.log('[API Cache] fetchVessels - returning from cache');
    }
    return vesselDataCache.owned.data;
  }

  if (window.DEBUG_MODE) {
    console.log('[API Cache] fetchVessels - cache miss, fetching from API (valid:', vesselDataCache.owned.valid, ', hasData:', !!vesselDataCache.owned.data, ')');
  }

  try {
    const response = await fetch(window.apiUrl('/api/vessel/get-vessels'));
    if (!response.ok) throw new Error('Failed to get vessels');
    const data = await response.json();

    // Update cache
    vesselDataCache.owned.data = data;
    vesselDataCache.owned.valid = true;

    if (window.DEBUG_MODE) {
      console.log('[API Cache] fetchVessels - cached', data.vessels?.length || 0, 'vessels');
    }

    return data;
  } catch (error) {
    console.error('Error fetching vessels:', error);
    throw error;
  }
}

/**
 * Fetches current user settings and account information.
 *
 * @returns {Promise<Object>} User settings object
 * @property {number} user_id - User ID
 * @property {string} company_name - Company name
 * @property {number} cash - Current cash balance
 * @throws {Error} If fetch fails
 */
export async function fetchUserSettings() {
  try {
    const response = await fetch(window.apiUrl('/api/user/get-settings'));
    if (!response.ok) throw new Error('Failed to get user settings');
    return await response.json();
  } catch (error) {
    console.error('Error fetching user settings:', error);
    throw error;
  }
}

/**
 * Fetches current bunker fuel and CO2 prices.
 * Prices fluctuate based on game economy and are updated every 30-35 seconds.
 *
 * @returns {Promise<Object>} Bunker prices and status
 * @property {number} fuel_price - Current fuel price per ton
 * @property {number} co2_price - Current CO2 price per ton
 * @property {number} current_fuel - Current fuel in bunker
 * @property {number} max_fuel - Maximum fuel capacity
 * @property {number} current_co2 - Current CO2 in bunker
 * @property {number} max_co2 - Maximum CO2 capacity
 * @property {number} current_cash - Current cash balance
 * @throws {Error} If fetch fails
 */
export async function fetchBunkerPrices() {
  try {
    const response = await fetch(window.apiUrl('/api/bunker/get-prices'));
    if (!response.ok) throw new Error('Failed to get bunker prices');
    return await response.json();
  } catch (error) {
    console.error('Error fetching bunker prices:', error);
    throw error;
  }
}

/**
 * Purchases fuel for the bunker.
 * Amount is multiplied by 1000 before sending (API expects millitons).
 *
 * @param {number} amount - Amount of fuel to purchase in tons
 * @returns {Promise<Object>} Purchase result
 * @property {boolean} success - Whether purchase was successful
 * @property {number} new_balance - New cash balance after purchase
 * @throws {Error} If purchase fails (insufficient funds, invalid amount)
 */
export async function purchaseFuel(amount) {
  try {
    const response = await fetch(window.apiUrl('/api/bunker/purchase-fuel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(amount) })  // Send amount in tons, server converts to kg
    });

    const data = await response.json();

    // Check for errors - don't hide them behind success!
    if (!response.ok || data.error) {
      const errorMsg = data.error || data.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMsg);
    }

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * Purchases CO2 credits for the bunker.
 * Amount is multiplied by 1000 before sending (API expects millitons).
 *
 * @param {number} amount - Amount of CO2 to purchase in tons
 * @returns {Promise<Object>} Purchase result
 * @property {boolean} success - Whether purchase was successful
 * @property {number} new_balance - New cash balance after purchase
 * @throws {Error} If purchase fails (insufficient funds, invalid amount)
 */
export async function purchaseCO2(amount) {
  try {
    const response = await fetch(window.apiUrl('/api/bunker/purchase-co2'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(amount) })  // Send amount in tons, server converts to kg
    });

    const data = await response.json();

    // Check for errors - don't hide them behind success!
    if (!response.ok || data.error) {
      const errorMsg = data.error || data.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMsg);
    }

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * Universal depart function - departs vessels using autopilot logic.
 * Can depart ALL vessels or specific vessels by ID.
 *
 * @param {Array<number>} [vesselIds=null] - Optional array of vessel IDs. If omitted, departs ALL vessels in harbor.
 * @returns {Promise<Object>} Departure result
 * @property {boolean} success - Whether departure was triggered
 * @property {string} message - Status message
 * @throws {Error} If request fails
 *
 * @example
 * // Depart all vessels in harbor
 * await departVessels();
 *
 * @example
 * // Depart specific vessels
 * await departVessels([123, 456, 789]);
 */
export async function departVessels(vesselIds = null) {
  try {
    const body = vesselIds ? { vessel_ids: vesselIds } : {};

    const response = await fetch(window.apiUrl('/api/route/depart'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error('Failed to depart vessels');
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Departs all vessels currently in harbor (backwards compatibility wrapper).
 * Uses the universal departVessels() function with no vessel IDs.
 *
 * @returns {Promise<Object>} Departure result
 * @throws {Error} If request fails
 */
export async function departAllVessels() {
  return await departVessels(null);
}

/**
 * Fetches the user's contact list.
 * Returns both regular contacts and alliance contacts.
 *
 * @returns {Promise<Object>} Contact data
 * @property {Array<Object>} contacts - Regular contacts
 * @property {Array<Object>} alliance_contacts - Alliance member contacts
 * @throws {Error} If fetch fails
 */
export async function fetchContacts() {
  try {
    const response = await fetch(window.apiUrl('/api/contact/get-contacts'));
    if (!response.ok) throw new Error('Failed to get contacts');
    return await response.json();
  } catch (error) {
    console.error('Error loading contact list:', error);
    throw error;
  }
}

/**
 * Search for users by company name.
 * Returns array of matching users with IDs and company names.
 *
 * @param {string} name - Search term (partial match)
 * @returns {Promise<Object>} Search results
 * @property {Array<Object>} data.companies - Array of matching companies
 * @property {Object} user - Current user data
 * @throws {Error} If fetch fails
 */
export async function searchUsers(name) {
  try {
    const response = await fetch(window.apiUrl('/api/user/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    if (!response.ok) throw new Error('Failed to search users');
    return await response.json();
  } catch (error) {
    console.error('Error searching users:', error);
    throw error;
  }
}

/**
 * Fetches all messenger chats for the current user.
 * Includes both regular chats and system messages.
 *
 * @returns {Promise<Object>} Messenger data
 * @property {Array<Object>} chats - Array of chat conversations
 * @property {number} own_user_id - Current user's ID
 * @property {string} own_company_name - Current user's company name
 * @throws {Error} If fetch fails
 */
export async function fetchMessengerChats() {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/get-chats'));
    if (!response.ok) throw new Error('Failed to get chats');
    return await response.json();
  } catch (error) {
    console.error('Error getting chats:', error);
    throw error;
  }
}

/**
 * Fetches all messages for a specific chat conversation.
 *
 * @param {number} chatId - Chat ID to fetch messages for
 * @param {boolean} forceRefresh - If true, bypasses cache and fetches fresh data
 * @returns {Promise<Object>} Messages data
 * @property {Array<Object>} messages - Array of message objects
 * @throws {Error} If fetch fails
 */
export async function fetchMessengerMessages(chatId, forceRefresh = false) {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/get-messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, force_refresh: forceRefresh })
    });

    if (!response.ok) throw new Error('Failed to load messages');
    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Sends a private message to another user.
 * Creates a new chat or continues existing conversation.
 *
 * @param {number} targetUserId - Recipient's user ID
 * @param {string} subject - Message subject (only for new chats)
 * @param {string} message - Message content
 * @returns {Promise<Object>} Send result
 * @property {boolean} success - Whether message was sent
 * @throws {Error} If send fails or validation fails
 */
export async function sendPrivateMessage(targetUserId, subject, message, retryCount = 0) {
  const maxRetries = 3;
  const retryDelay = 2000; // 2 seconds

  if (window.DEBUG_MODE) {
    console.log('[API DEBUG] sendPrivateMessage called with:');
    console.log('  targetUserId:', targetUserId, 'type:', typeof targetUserId);
    console.log('  subject:', subject);
    console.log('  message:', message);
    console.log('  retryCount:', retryCount);
  }

  const payload = {
    target_user_id: targetUserId,
    subject: subject,
    message: message
  };

  if (window.DEBUG_MODE) {
    console.log('[API DEBUG] Payload to send:', JSON.stringify(payload, null, 2));
  }

  try {
    const response = await fetch(window.apiUrl('/api/messenger/send-private'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (window.DEBUG_MODE) {
      console.log('[API DEBUG] Response status:', response.status, response.statusText);
    }

    // Handle rate limiting with retry
    if (response.status === 429 && retryCount < maxRetries) {
      console.log(`[Messenger] Rate limited, retrying in ${retryDelay}ms (attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return sendPrivateMessage(targetUserId, subject, message, retryCount + 1);
    }

    if (!response.ok) {
      const error = await response.json();
      if (window.DEBUG_MODE) {
        console.log('[API DEBUG] Error response:', error);
      }
      throw new Error(error.error);
    }

    const result = await response.json();
    if (window.DEBUG_MODE) {
      console.log('[API DEBUG] Success response:', result);
    }
    return result;
  } catch (error) {
    if (window.DEBUG_MODE) {
      console.log('[API DEBUG] Exception caught:', error.message);
    }
    throw error;
  }
}

/**
 * Marks a chat conversation or system message as read.
 * System messages and regular chats are handled differently by the API.
 *
 * @param {number} chatId - Chat ID to mark as read
 * @param {boolean} [isSystemChat=false] - Whether this is a system message
 * @returns {Promise<Object>} Mark-as-read result
 * @property {boolean} success - Whether marking as read was successful
 * @throws {Error} If marking as read fails
 */
export async function markChatAsRead(chatId, isSystemChat = false) {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/mark-as-read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_ids: isSystemChat ? '[]' : `[${chatId}]`,
        system_message_ids: isSystemChat ? `[${chatId}]` : '[]'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to mark chat as read');
    }

    return await response.json();
  } catch (error) {
    console.error('[API] Mark as read error:', error);
    throw error;
  }
}

/**
 * Deletes a chat conversation or system message.
 * System messages and regular chats are handled differently by the API.
 *
 * @param {number} chatId - Chat ID to delete
 * @param {boolean} [isSystemChat=false] - Whether this is a system message
 * @param {number} [caseId=null] - Hijacking case ID (for hijacking messages)
 * @returns {Promise<Object>} Deletion result
 * @property {boolean} success - Whether deletion was successful
 * @throws {Error} If deletion fails
 */
export async function deleteChat(chatId, isSystemChat = false, caseId = null) {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/delete-chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_ids: isSystemChat ? '[]' : `[${chatId}]`,
        system_message_ids: isSystemChat ? `[${chatId}]` : '[]',
        case_id: caseId
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete chat');
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Fetches available marketing campaigns and currently active campaigns.
 * Campaigns provide temporary bonuses (reputation, awareness, green).
 *
 * @returns {Promise<Object>} Campaign data
 * @property {Object} data - Campaign data
 * @property {Array<Object>} data.marketing_campaigns - All available campaigns
 * @property {Array<Object>} data.active_campaigns - Currently active campaigns
 * @property {Object} user - User data including reputation
 * @throws {Error} If fetch fails
 */
export async function fetchCampaigns() {
  try {
    const response = await fetch(window.apiUrl('/api/marketing/get-campaigns'));
    if (!response.ok) throw new Error('Failed to fetch campaigns');
    return await response.json();
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    throw error;
  }
}

/**
 * Activates a marketing campaign by purchasing it.
 * Only 3 campaigns can be active simultaneously (one of each type).
 *
 * @param {number} campaignId - Campaign ID to activate
 * @returns {Promise<Object>} Activation result
 * @property {boolean} success - Whether activation was successful
 * @property {number} new_balance - New cash balance after purchase
 * @throws {Error} If activation fails (insufficient funds, already active)
 */
export async function activateCampaign(campaignId) {
  try {
    console.log(`[API] activateCampaign REQUEST: campaign_id=${campaignId}`);

    const response = await fetch(window.apiUrl('/api/marketing/activate-campaign'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId })
    });

    console.log(`[API] activateCampaign RESPONSE: status=${response.status} ${response.statusText}`);

    const data = await response.json();
    console.log(`[API] activateCampaign RESPONSE body:`, JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error(`[API] activateCampaign FAILED: HTTP ${response.status}`, data);
      throw new Error('Failed to activate campaign');
    }

    return data;
  } catch (error) {
    console.error('[API] Error activating campaign:', error);
    throw error;
  }
}

/**
 * Fetches all vessels available for purchase in the market.
 * Includes vessel specifications, prices, and engine types.
 *
 * @returns {Promise<Object>} Available vessels data
 * @property {Array<Object>} vessels - Array of purchasable vessels
 * @throws {Error} If fetch fails
 */
export async function fetchAcquirableVessels(useCache = true) {
  // Return cached data if valid
  if (useCache && vesselDataCache.acquirable.valid && vesselDataCache.acquirable.data) {
    return vesselDataCache.acquirable.data;
  }

  try {
    const response = await fetch(window.apiUrl('/api/vessel/get-all-acquirable'));
    if (!response.ok) throw new Error('Failed to load vessels');
    const data = await response.json();

    // Update cache
    vesselDataCache.acquirable.data = data;
    vesselDataCache.acquirable.valid = true;

    return data;
  } catch (error) {
    console.error('Error loading vessels:', error);
    throw error;
  }
}

/**
 * Verifies if a vessel with given name exists in fleet.
 * Used to check if a purchase succeeded after network error.
 *
 * @param {string} vesselName - Name of vessel to check
 * @returns {Promise<boolean>} True if vessel exists in fleet
 */
async function verifyVesselPurchased(vesselName) {
  try {
    // Force fresh fetch, bypass cache
    invalidateVesselCache('owned');
    const data = await fetchVessels(false);
    if (data && data.vessels) {
      return data.vessels.some(v => v.name === vesselName);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Purchases a vessel from the market.
 * User provides name and antifouling choice during purchase.
 * Includes retry logic for network errors with verification to prevent duplicates.
 *
 * @param {number} vesselId - Vessel ID to purchase
 * @param {string} name - Custom name for the vessel
 * @param {string} antifouling - Antifouling model choice
 * @returns {Promise<Object>} Purchase result
 * @property {boolean} success - Whether purchase was successful
 * @property {number} new_balance - New cash balance
 * @throws {Error} If purchase fails (insufficient funds, invalid name)
 */
export async function purchaseVessel(vesselId, name, antifouling, silent = false) {
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(window.apiUrl('/api/vessel/purchase-vessel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vessel_id: vesselId,
          name: name,
          antifouling_model: antifouling,
          silent: silent
        })
      });

      const result = await response.json();

      // Invalidate vessel cache after successful purchase
      if (result.success || response.ok) {
        invalidateVesselCache('owned');
      }

      return result;
    } catch (error) {
      lastError = error;
      console.warn(`[Purchase] Network error on attempt ${attempt + 1}:`, error.message);

      // Wait for network to stabilize
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Check if vessel was actually purchased despite network error
      const wasActuallyPurchased = await verifyVesselPurchased(name);
      if (wasActuallyPurchased) {
        console.info(`[Purchase] Verified: ${name} was purchased despite network error`);
        invalidateVesselCache('owned');
        return {
          success: true,
          verified: true,
          message: 'Purchase verified after network recovery'
        };
      }

      // If last attempt, throw error
      if (attempt === maxRetries) {
        console.error(`[Purchase] All ${maxRetries + 1} attempts failed for ${name}`);
        throw lastError;
      }

      console.info(`[Purchase] Retrying purchase of ${name} (attempt ${attempt + 2})`);
    }
  }

  throw lastError;
}

/**
 * Gets the total maintenance cost for specified vessels.
 * Used before performing bulk repair to show cost to user.
 *
 * @param {Array<number>} vesselIds - Array of vessel IDs to check cost for
 * @returns {Promise<Object>} Cost data
 * @property {number} total_cost - Total repair cost
 * @throws {Error} If request fails
 */
export async function getMaintenanceCost(vesselIds) {
  try {
    const response = await fetch(window.apiUrl('/api/maintenance/get'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
    });

    if (!response.ok) throw new Error('Failed to get repair cost');
    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Performs wear maintenance (repair) on multiple vessels at once.
 * Used by auto-repair feature and manual bulk repair button.
 *
 * @param {Array<number>} vesselIds - Array of vessel IDs to repair
 * @returns {Promise<Object>} Repair result
 * @property {number} repaired - Number of vessels repaired
 * @property {number} cost - Total cost of repairs
 * @throws {Error} If repair fails (insufficient funds)
 */
export async function doWearMaintenanceBulk(vesselIds) {
  try {
    const response = await fetch(window.apiUrl('/api/maintenance/do-wear-maintenance-bulk'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
    });

    if (!response.ok) throw new Error('Failed to repair vessels');
    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Departs a single vessel on its assigned route.
 * Used by intelligent auto-depart to send only profitable vessels.
 *
 * @param {number} vesselId - Vessel ID to depart
 * @param {number} speed - Speed to travel at (usually % of max_speed)
 * @param {number} [guards=0] - Number of guards (0 or 10 based on hijacking_risk)
 * @returns {Promise<Object>} Departure result
 * @property {boolean} success - Whether vessel was departed successfully
 * @throws {Error} If departure fails (no route, insufficient fuel)
 */
export async function departVessel(vesselId, speed, guards = 0) {
  try {
    const response = await fetch(window.apiUrl('/api/route/depart'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_vessel_id: vesselId,
        speed: speed,
        guards: guards,
        history: 0
      })
    });

    if (!response.ok) {
      throw new Error('Failed to depart vessel');
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Fetches demand and consumed data for all assigned ports.
 * Used by intelligent auto-depart to calculate remaining port capacity.
 *
 * @returns {Promise<Array<Object>>} Array of port objects with demand/consumed data
 * @property {string} code - Port code (e.g., "BOS")
 * @property {Object} demand - Port demand for container and tanker cargo
 * @property {Object} consumed - Amount already delivered to port
 * @throws {Error} If fetch fails
 */
export async function fetchAssignedPorts() {
  try {
    const response = await fetch(window.apiUrl('/api/port/get-assigned-ports'));
    if (!response.ok) throw new Error('Failed to fetch assigned ports');
    const data = await response.json();
    return data.data?.ports || [];
  } catch (error) {
    console.error('Error fetching assigned ports:', error);
    throw error;
  }
}

/**
 * Fetches user company data including fuel and CO2 capacity.
 * Used to get actual capacity values from API instead of hardcoding.
 *
 * @returns {Promise<Object>} User company data
 * @property {number} fuel_capacity - Max fuel capacity in kg
 * @property {number} co2_capacity - Max CO2 capacity in kg
 * @throws {Error} If fetch fails
 */
export async function fetchUserCompany() {
  try {
    const response = await fetch(window.apiUrl('/api/user/get-company'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error('Failed to fetch user company');
    const data = await response.json();
    // Return both data.data.company and data.user for full access to all properties
    return { company: data.data?.company || {}, user: data.user || {} };
  } catch (error) {
    console.error('Error fetching user company:', error);
    throw error;
  }
}

/**
 * Fetches autopilot log entries with optional filters
 *
 * @param {Object} filters - Filter options
 * @param {string} filters.status - "SUCCESS", "ERROR", or "ALL"
 * @param {string} filters.timeRange - "today", "yesterday", "48h", or "all"
 * @param {string} filters.search - Search term for autopilot name or summary
 * @returns {Promise<Object>} Log entries data
 * @throws {Error} If fetch fails
 */
export async function fetchLogbookEntries(filters = {}) {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/get-logs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters)
    });
    if (!response.ok) throw new Error('Failed to fetch log entries');
    return await response.json();
  } catch (error) {
    console.error('Error fetching log entries:', error);
    throw error;
  }
}

/**
 * Downloads autopilot logs in specified format
 *
 * @param {string} format - "txt", "csv", or "json"
 * @param {Object} filters - Same filters as fetchLogbookEntries
 * @returns {Promise<string>} File content as text
 * @throws {Error} If download fails
 */
export async function downloadLogbookExport(format, filters = {}) {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/download'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, ...filters })
    });
    if (!response.ok) throw new Error('Failed to download logs');
    return await response.text();
  } catch (error) {
    console.error('Error downloading logs:', error);
    throw error;
  }
}

/**
 * Deletes all autopilot logs for the current user
 *
 * @returns {Promise<Object>} Success response
 * @throws {Error} If deletion fails
 */
export async function deleteAllLogs() {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/delete-all'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error('Failed to delete logs');
    return await response.json();
  } catch (error) {
    console.error('Error deleting logs:', error);
    throw error;
  }
}

/**
 * Fetches current log file size
 *
 * @returns {Promise<Object>} File size data
 * @property {number} bytes - Size in bytes
 * @property {string} formatted - Human-readable size (e.g., "2.4 MB")
 * @throws {Error} If fetch fails
 */
export async function fetchLogbookFileSize() {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/file-size'));
    if (!response.ok) throw new Error('Failed to fetch file size');
    return await response.json();
  } catch (error) {
    console.error('Error fetching file size:', error);
    throw error;
  }
}

// ============================================================================
// Stock Market API Functions
// ============================================================================

/**
 * Fetches stock finance overview for a user
 * Includes stock info with history, investors, and investments
 *
 * @param {number} userId - User ID to fetch data for
 * @returns {Promise<Object>} Finance overview data
 */
export async function getStockFinanceOverview(userId) {
  try {
    const response = await fetch(window.apiUrl(`/api/stock/finance-overview?user_id=${userId}`));
    if (!response.ok) throw new Error('Failed to fetch finance overview');
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error fetching finance overview:', error);
    throw error;
  }
}

/**
 * Fetches stock market listings with filter and pagination
 *
 * @param {string} filter - Filter type: 'top', 'low', 'activity', 'recent-ipo'
 * @param {number} page - Page number (default 1)
 * @param {number} limit - Items per page (default 40)
 * @param {string} search - Search term (optional)
 * @returns {Promise<Object>} Market data with companies list
 */
export async function getStockMarket(filter = 'top', page = 1, limit = 40, search = '') {
  try {
    const params = new URLSearchParams({ filter, page, limit, search });
    const response = await fetch(window.apiUrl(`/api/stock/market?${params}`));
    if (!response.ok) throw new Error('Failed to fetch market data');
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error fetching market:', error);
    throw error;
  }
}

/**
 * Purchase stocks from a company
 * Requires IPO=1 on the calling user's account
 *
 * @param {number} stockIssuerUserId - Company (user) ID to buy from
 * @param {number} amount - Number of shares to purchase
 * @param {string} [companyName] - Company name for logging
 * @param {number} [pricePerShare] - Current price per share for logging
 * @returns {Promise<Object>} Purchase result
 */
export async function purchaseStock(stockIssuerUserId, amount, companyName = '', pricePerShare = 0) {
  try {
    const response = await fetch(window.apiUrl('/api/stock/purchase'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stock_issuer_user_id: stockIssuerUserId,
        amount,
        company_name: companyName,
        price_per_share: pricePerShare
      })
    });
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error purchasing stock:', error);
    throw error;
  }
}

/**
 * Increase shares for sale (issue new shares to the market)
 * Only available for users who have completed IPO
 * Price doubles with each 25k tranche based on shares in circulation
 * @returns {Promise<Object>} Result from API
 */
export async function increaseStockForSale() {
  try {
    const response = await fetch(window.apiUrl('/api/stock/increase-stock-for-sale'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error increasing stock for sale:', error);
    throw error;
  }
}

/**
 * Sell stock shares
 * @param {number} stockIssuerUserId - The user ID of the company to sell shares from
 * @param {number} amount - Number of shares to sell
 * @param {string} [companyName] - Company name for logging
 * @param {number} [pricePerShare] - Current price per share for logging
 * @returns {Promise<Object>} Sale result from API
 */
export async function sellStock(stockIssuerUserId, amount, companyName = '', pricePerShare = 0) {
  try {
    const response = await fetch(window.apiUrl('/api/stock/sell'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stock_issuer_user_id: stockIssuerUserId,
        amount,
        company_name: companyName,
        price_per_share: pricePerShare
      })
    });
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error selling stock:', error);
    throw error;
  }
}

/**
 * Get recent IPOs for the IPO Alert tab
 * @returns {Promise<Object>} Recent IPOs data
 */
export async function getRecentIpos() {
  try {
    const response = await fetch(window.apiUrl('/api/stock/recent-ipos'));
    if (!response.ok) throw new Error('Failed to fetch recent IPOs');
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error fetching recent IPOs:', error);
    throw error;
  }
}

/**
 * Check age of a single company (non-blocking)
 * @param {number} userId - User ID of the company
 * @param {number} maxAgeDays - Maximum age in days for fresh IPOs
 * @returns {Promise<Object>} Company age info { user_id, is_fresh, age_days, created_at }
 */
export async function checkCompanyAge(userId, maxAgeDays = 7) {
  try {
    const response = await fetch(window.apiUrl(`/api/stock/check-company-age?user_id=${userId}&max_age_days=${maxAgeDays}`));
    if (!response.ok) throw new Error('Failed to check company age');
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error checking company age:', error);
    throw error;
  }
}

/**
 * Get stock purchase timestamps from logbook
 * Returns the most recent purchase timestamp for each company.
 * Used to calculate 48h lock period for selling.
 * @returns {Promise<Object>} { purchaseTimes: { companyId: timestamp, ... } }
 */
export async function getStockPurchaseTimes() {
  try {
    const response = await fetch(window.apiUrl('/api/stock/purchase-times'));
    if (!response.ok) throw new Error('Failed to fetch purchase times');
    return await response.json();
  } catch (error) {
    console.error('[Stock API] Error fetching purchase times:', error);
    throw error;
  }
}

// ==================== Analytics API ====================

/**
 * Get all analytics data in one call (for dashboard)
 * @param {number} days - Number of days to analyze (default 7)
 * @returns {Promise<Object>} All analytics data
 */
export async function getAnalyticsAll(days = 7) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/all?days=${days}`));
    if (!response.ok) throw new Error('Failed to fetch analytics');
    return await response.json();
  } catch (error) {
    console.error('[Analytics API] Error fetching analytics:', error);
    throw error;
  }
}

/**
 * Get overview tab data only (fast load)
 * @param {number} days - Number of days to analyze (default 7)
 * @returns {Promise<Object>} Overview data (summary + detailedExpenses)
 */
export async function getAnalyticsOverview(days = 7) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/overview?days=${days}`));
    if (!response.ok) throw new Error('Failed to fetch overview');
    return await response.json();
  } catch (error) {
    console.error('[Analytics API] Error fetching overview:', error);
    throw error;
  }
}

/**
 * Get weekly summary
 * @param {number} weeks - Number of weeks (default 1)
 * @returns {Promise<Object>} Weekly summary data
 */
export async function getAnalyticsSummary(weeks = 1) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/summary?weeks=${weeks}`));
    if (!response.ok) throw new Error('Failed to fetch summary');
    return await response.json();
  } catch (error) {
    console.error('[Analytics API] Error fetching summary:', error);
    throw error;
  }
}

/**
 * Get vessel performance metrics
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Object>} Vessel performance data
 */
export async function getAnalyticsVessels(days = 30) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/vessels?days=${days}`));
    if (!response.ok) throw new Error('Failed to fetch vessel performance');
    return await response.json();
  } catch (error) {
    console.error('[Analytics API] Error fetching vessel performance:', error);
    throw error;
  }
}

/**
 * Get route profitability
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Object>} Route profitability data
 */
export async function getAnalyticsRoutes(days = 30) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/routes?days=${days}`));
    if (!response.ok) throw new Error('Failed to fetch route profitability');
    return await response.json();
  } catch (error) {
    console.error('[Analytics API] Error fetching route profitability:', error);
    throw error;
  }
}

/**
 * Get vessel performance for a specific route
 * @param {string} origin - Route origin port
 * @param {string} destination - Route destination port
 * @param {number} days - Number of days (default 30)
 * @returns {Promise<Object>} Route vessel comparison data
 */
export async function getRouteVessels(origin, destination, days = 30) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/route-vessels?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&days=${days}`));
    if (!response.ok) throw new Error('Failed to fetch route vessels');
    return await response.json();
  } catch (error) {
    console.error('[Analytics API] Error fetching route vessels:', error);
    throw error;
  }
}

/**
 * Get daily revenue trend
 * @param {number} days - Number of days (default 30)
 * @returns {Promise<Object>} Trend data
 */
export async function getAnalyticsTrend(days = 30) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/trend?days=${days}`));
    if (!response.ok) throw new Error('Failed to fetch trend');
    return await response.json();
  } catch (error) {
    console.error('[Analytics API] Error fetching trend:', error);
    throw error;
  }
}

// ============================================
// Transaction History API (Game Data)
// ============================================

/**
 * Sync transactions from game API
 * Fetches latest transactions and merges with local store
 * @returns {Promise<Object>} Sync result {synced, total}
 */
export async function syncTransactions() {
  try {
    const response = await fetch(window.apiUrl('/api/transactions/sync'), {
      method: 'POST'
    });
    if (!response.ok) throw new Error('Failed to sync transactions');
    return await response.json();
  } catch (error) {
    console.error('[Transactions API] Error syncing:', error);
    throw error;
  }
}

/**
 * Get transaction store info
 * @returns {Promise<Object>} Store metadata
 */
export async function getTransactionInfo() {
  try {
    const response = await fetch(window.apiUrl('/api/transactions/info'));
    if (!response.ok) throw new Error('Failed to get transaction info');
    return await response.json();
  } catch (error) {
    console.error('[Transactions API] Error getting info:', error);
    throw error;
  }
}

/**
 * Get all transaction data for dashboard
 * @param {number} days - Number of days (default 7)
 * @returns {Promise<Object>} Complete transaction data
 */
export async function getTransactionData(days = 7) {
  try {
    const response = await fetch(window.apiUrl(`/api/transactions/all?days=${days}`));
    if (!response.ok) throw new Error('Failed to get transaction data');
    return await response.json();
  } catch (error) {
    console.error('[Transactions API] Error getting data:', error);
    throw error;
  }
}

/**
 * Get paginated transaction list with sorting and filtering
 * @param {Object} options - Query options
 * @param {number} options.days - Number of days (default 30)
 * @param {string} options.context - Filter by context (optional)
 * @param {number} options.limit - Max entries per page (default 100)
 * @param {number} options.offset - Skip entries for pagination (default 0)
 * @param {string} options.sortBy - Sort column (time, cash, context) default: time
 * @param {string} options.sortDir - Sort direction (asc, desc) default: desc
 * @returns {Promise<Object>} Paginated transaction list with metadata
 */
export async function getTransactionList(options = {}) {
  try {
    const params = new URLSearchParams();
    if (options.days) params.set('days', options.days);
    if (options.context) params.set('context', options.context);
    if (options.limit) params.set('limit', options.limit);
    if (options.offset) params.set('offset', options.offset);
    if (options.sortBy) params.set('sortBy', options.sortBy);
    if (options.sortDir) params.set('sortDir', options.sortDir);

    const response = await fetch(window.apiUrl(`/api/transactions/list?${params.toString()}`));
    if (!response.ok) throw new Error('Failed to get transaction list');
    return await response.json();
  } catch (error) {
    console.error('[Transactions API] Error getting list:', error);
    throw error;
  }
}

/**
 * Get transaction summary by context
 * @param {number} days - Number of days (default 30)
 * @returns {Promise<Object>} Summary grouped by context
 */
export async function getTransactionSummary(days = 30) {
  try {
    const response = await fetch(window.apiUrl(`/api/transactions/summary?days=${days}`));
    if (!response.ok) throw new Error('Failed to get transaction summary');
    return await response.json();
  } catch (error) {
    console.error('[Transactions API] Error getting summary:', error);
    throw error;
  }
}

/**
 * Get daily transaction breakdown
 * @param {number} days - Number of days (default 30)
 * @returns {Promise<Object>} Daily breakdown
 */
export async function getTransactionDaily(days = 30) {
  try {
    const response = await fetch(window.apiUrl(`/api/transactions/daily?days=${days}`));
    if (!response.ok) throw new Error('Failed to get daily breakdown');
    return await response.json();
  } catch (error) {
    console.error('[Transactions API] Error getting daily:', error);
    throw error;
  }
}

/**
 * Get available transaction types
 * @returns {Promise<Object>} Available types
 */
export async function getTransactionTypes() {
  try {
    const response = await fetch(window.apiUrl('/api/transactions/types'));
    if (!response.ok) throw new Error('Failed to get transaction types');
    return await response.json();
  } catch (error) {
    console.error('[Transactions API] Error getting types:', error);
    throw error;
  }
}

// ============================================
// LOOKUP STORE API (POD4)
// ============================================

/**
 * Build/update the lookup table from all PODs
 * @param {number} days - Number of days to process (0 = all)
 * @returns {Promise<Object>} Build result
 */
export async function buildLookup(days = 0) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/lookup/build?days=${days}`), {
      method: 'POST'
    });
    if (!response.ok) throw new Error('Failed to build lookup');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error building lookup:', error);
    throw error;
  }
}

/**
 * Get lookup entries
 * @param {Object} options - Query options
 * @param {number} options.days - Number of days (0 = all)
 * @param {number} options.limit - Max entries (default 100)
 * @param {number} options.offset - Pagination offset
 * @returns {Promise<Object>} Lookup entries with pagination
 */
export async function getLookupEntries(options = {}) {
  try {
    const params = new URLSearchParams();
    if (options.days) params.set('days', options.days);
    if (options.limit) params.set('limit', options.limit);
    if (options.offset) params.set('offset', options.offset);

    const response = await fetch(window.apiUrl(`/api/analytics/lookup/entries?${params.toString()}`));
    if (!response.ok) throw new Error('Failed to get lookup entries');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error getting entries:', error);
    throw error;
  }
}

/**
 * Get income/expense totals from lookup
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Object>} Totals
 */
export async function getLookupTotals(days = 0) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/lookup/totals?days=${days}`));
    if (!response.ok) throw new Error('Failed to get lookup totals');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error getting totals:', error);
    throw error;
  }
}

/**
 * Get breakdown by transaction type
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Object>} Breakdown
 */
export async function getLookupBreakdown(days = 0) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/lookup/breakdown?days=${days}`));
    if (!response.ok) throw new Error('Failed to get lookup breakdown');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error getting breakdown:', error);
    throw error;
  }
}

/**
 * Get daily breakdown from lookup store
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Object>} Daily breakdown
 */
export async function getLookupDaily(days = 0) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/lookup/daily?days=${days}`));
    if (!response.ok) throw new Error('Failed to get lookup daily');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error getting daily:', error);
    throw error;
  }
}

/**
 * Get full details for a lookup entry from all PODs
 * @param {string} lookupId - Lookup entry ID
 * @returns {Promise<Object>} Full details
 */
export async function getLookupDetails(lookupId) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/lookup/details/${lookupId}`));
    if (!response.ok) throw new Error('Failed to get lookup details');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error getting details:', error);
    throw error;
  }
}

/**
 * Get lookup store info
 * @returns {Promise<Object>} Store info
 */
export async function getLookupInfo() {
  try {
    const response = await fetch(window.apiUrl('/api/analytics/lookup/info'));
    if (!response.ok) throw new Error('Failed to get lookup info');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error getting info:', error);
    throw error;
  }
}

/**
 * Rebuild lookup store (clears, syncs vessel history, rebuilds)
 * @param {number} days - Number of days to process (0 = all)
 * @returns {Promise<Object>} Result with sync and lookup stats
 */
export async function rebuildLookup(days = 0) {
  try {
    const response = await fetch(window.apiUrl(`/api/analytics/lookup/rebuild?days=${days}`), {
      method: 'POST'
    });
    if (!response.ok) throw new Error('Failed to rebuild lookup');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error rebuilding lookup:', error);
    throw error;
  }
}

/**
 * Clear lookup store
 * @returns {Promise<Object>} Result
 */
export async function clearLookup() {
  try {
    const response = await fetch(window.apiUrl('/api/analytics/lookup/clear'), {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to clear lookup');
    return await response.json();
  } catch (error) {
    console.error('[Lookup API] Error clearing lookup:', error);
    throw error;
  }
}

