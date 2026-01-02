/**
 * @fileoverview Private Messaging API Routes
 *
 * This module handles all private messaging (DM) functionality between users in the game.
 * It provides endpoints for managing contacts, viewing conversation lists, sending messages,
 * and deleting chats. Acts as a proxy between the frontend and the Shipping Manager game API.
 *
 * Key Features:
 * - Contact list retrieval (both personal contacts and alliance members)
 * - Conversation list management (all active DM threads)
 * - Message history retrieval for specific conversations
 * - Private message sending with validation and rate limiting
 * - Chat deletion functionality
 *
 * Why This Module:
 * - Separates private messaging concerns from alliance chat
 * - Provides unified interface for contact management
 * - Adds input validation before forwarding to game API
 * - Includes user context (own_user_id, own_company_name) in responses
 * - Graceful error handling to prevent UI breakage
 *
 * Security Considerations:
 * - Message length validation (0-1000 characters)
 * - Subject line validation (required, non-empty)
 * - Target user ID validation (must be valid integer)
 * - Input sanitization via validator.trim() and validator.unescape()
 * - Rate limiting on message sending (30 messages/minute)
 *
 * Error Handling Philosophy:
 * - GET endpoints return empty arrays on error (prevents UI breaking)
 * - POST endpoints return 400/500 errors as appropriate
 * - Detailed error logging for debugging
 * - User context always included in successful responses
 *
 * @requires express - Router and middleware
 * @requires validator - Input validation and sanitization
 * @requires ../utils/api - API helper functions (apiCall, getUserId, etc.)
 * @requires ../middleware - Rate limiting middleware (messageLimiter)
 * @module server/routes/messenger
 */

const express = require('express');
const validator = require('validator');
const { apiCall, getUserId, getUserCompanyName } = require('../utils/api');
const { messageLimiter } = require('../middleware');
const logger = require('../utils/logger');
const {
  getCachedChatList,
  getCachedChatMessages,
  updateChatList,
  updateChatMessages,
  markChatAsReadInCache,
  deleteChatFromCache
} = require('../websocket/messenger-content-cache');
const { getCachedHijackingCase, saveNegotiationEvent, markCaseResolved } = require('../websocket/hijacking-cache');
const { getDb } = require('../database');

const router = express.Router();

/**
 * GET /api/contact/get-contacts - Retrieves user's contact list and alliance contacts.
 *
 * This endpoint fetches both personal contacts and alliance member contacts from the game API,
 * sorts them alphabetically by company name, and returns them with user context information.
 *
 * Why Sorting:
 * - Alphabetical sorting improves UX (easier to find contacts)
 * - Game API doesn't guarantee order
 * - Sorted on server to avoid redundant client-side sorting
 *
 * Response Structure:
 * {
 *   contacts: [...],              // Personal contacts
 *   alliance_contacts: [...],     // Alliance member contacts
 *   own_user_id: 12345,          // Current user's ID
 *   own_company_name: "ABC Corp" // Current user's company name
 * }
 *
 * User Context:
 * - own_user_id: Used to filter out self from contact lists
 * - own_company_name: Used for UI display
 *
 * Side Effects:
 * - Makes API call to /contact/get-contacts
 *
 * @name GET /api/contact/get-contacts
 * @function
 * @memberof module:server/routes/messenger
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with contacts and user context
 */
router.get('/contact/get-contacts', async (req, res) => {
  try {
    const data = await apiCall('/contact/get-contacts', 'POST', {});

    const contacts = (data.data.contacts || []).sort((a, b) =>
      (a.company_name || '').localeCompare(b.company_name || '')
    );

    const allianceContacts = (data.data.alliance_contacts || []).sort((a, b) =>
      (a.company_name || '').localeCompare(b.company_name || '')
    );

    res.json({
      contacts: contacts,
      alliance_contacts: allianceContacts,
      own_user_id: getUserId(),
      own_company_name: getUserCompanyName()
    });
  } catch (error) {
    logger.error('Failed to get contacts:', error);
    res.status(500).json({ error: 'Failed to retrieve contacts' });
  }
});

/**
 * POST /api/contact/add-contact - Adds a user to the contact list.
 *
 * Request Body:
 * {
 *   user_id: number  // Required: User ID to add as contact
 * }
 *
 * @name POST /api/contact/add-contact
 */
router.post('/contact/add-contact', express.json(), async (req, res) => {
  const { user_id } = req.body;

  if (!user_id || !Number.isInteger(user_id)) {
    return res.status(400).json({ error: 'Valid user_id required' });
  }

  try {
    const data = await apiCall('/contact/add-contact', 'POST', { user_id });

    if (data.error) {
      return res.status(400).json({ error: data.error });
    }

    res.json({ success: true, data: data.data });
  } catch (error) {
    logger.error('Failed to add contact:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

/**
 * POST /api/contact/remove-contact - Removes a user from the contact list.
 *
 * Request Body:
 * {
 *   user_id: number  // Required: User ID to remove from contacts
 * }
 *
 * @name POST /api/contact/remove-contact
 */
router.post('/contact/remove-contact', express.json(), async (req, res) => {
  const { user_id } = req.body;

  if (!user_id || !Number.isInteger(user_id)) {
    return res.status(400).json({ error: 'Valid user_id required' });
  }

  try {
    // Game API expects user_ids as JSON string array
    const data = await apiCall('/contact/remove-contacts', 'POST', {
      user_ids: JSON.stringify([user_id])
    });

    if (data.error) {
      return res.status(400).json({ error: data.error });
    }

    res.json({ success: true, data: data.data });
  } catch (error) {
    logger.error('Failed to remove contact:', error);
    res.status(500).json({ error: 'Failed to remove contact' });
  }
});

/**
 * GET /api/messenger/get-chats - Retrieves list of all active conversation threads.
 *
 * This endpoint fetches all messenger conversations (DM threads) for the current user.
 * Each chat represents a conversation with another user, including unread status and
 * last message preview.
 *
 * Why Graceful Error Handling:
 * - Returns empty chats array instead of error on API failure
 * - Prevents messenger UI from breaking
 * - Still includes user context for UI initialization
 * - Logs error for debugging but doesn't crash frontend
 *
 * Response Structure:
 * {
 *   chats: [...],                 // Array of conversation objects
 *   own_user_id: 12345,          // Current user's ID
 *   own_company_name: "ABC Corp" // Current user's company name
 * }
 *
 * User Context:
 * - own_user_id: Used to determine message sender/recipient in UI
 * - own_company_name: Used for UI display
 *
 * Side Effects:
 * - Makes API call to /messenger/get-chats
 *
 * @name GET /api/messenger/get-chats
 * @function
 * @memberof module:server/routes/messenger
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with chats and user context
 */
router.get('/messenger/get-chats', async (req, res) => {
  try {
    const userId = getUserId();

    // Try to get from cache first (instant response)
    const cached = getCachedChatList(userId);
    const cacheAge = Date.now() - cached.updatedAt;

    // Use cache if it's less than 30 seconds old
    if (cached.chatList.length > 0 && cacheAge < 30000) {
      logger.debug(`[Messenger] Serving ${cached.chatList.length} chats from cache (age: ${Math.round(cacheAge / 1000)}s)`);
      return res.json({
        chats: cached.chatList,
        own_user_id: userId,
        own_company_name: getUserCompanyName(),
        from_cache: true
      });
    }

    // Cache is stale or empty - fetch fresh data
    const data = await apiCall('/messenger/get-chats', 'POST', {});
    const chats = data?.data || [];

    // Update local cache with fresh data from game API
    if (chats.length > 0) {
      updateChatList(userId, chats);
    }

    res.json({
      chats: chats,
      own_user_id: userId,
      own_company_name: getUserCompanyName()
    });
  } catch (error) {
    logger.error('Failed to get chats:', error.message, error.stack);

    // Try to return cached data even if stale
    const userId = getUserId();
    const cached = getCachedChatList(userId);

    if (cached.chatList.length > 0) {
      logger.warn('[Messenger] API failed, returning stale cache');
      return res.json({
        chats: cached.chatList,
        own_user_id: userId,
        own_company_name: getUserCompanyName(),
        from_cache: true,
        cache_stale: true
      });
    }

    // Return empty chats instead of error to prevent UI breaking
    res.json({
      chats: [],
      own_user_id: userId,
      own_company_name: getUserCompanyName()
    });
  }
});

/**
 * POST /api/messenger/get-messages - Retrieves message history for a specific conversation.
 *
 * This endpoint fetches all messages within a specific chat thread, identified by chat_id.
 * Returns the complete message history with timestamps, sender information, and message content.
 *
 * Why Flexible Data Structure Handling:
 * - Game API response structure varies
 * - data.chat.messages or data.messages depending on endpoint version
 * - Optional chaining (?.) prevents errors from undefined paths
 *
 * Request Body:
 * {
 *   chat_id: number  // Required: ID of the conversation
 * }
 *
 * Response Structure:
 * {
 *   messages: [...],    // Array of message objects
 *   user_id: 12345     // Current user's ID
 * }
 *
 * User Context:
 * - user_id: Used to determine message direction (sent vs received)
 *
 * Validation:
 * - chat_id is required (400 error if missing)
 *
 * Side Effects:
 * - Makes API call to /messenger/get-chat
 *
 * @name POST /api/messenger/get-messages
 * @function
 * @memberof module:server/routes/messenger
 * @param {express.Request} req - Express request object with { chat_id: number } body
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with messages and user_id
 */
router.post('/messenger/get-messages', express.json(), async (req, res) => {
  const { chat_id, force_refresh } = req.body;

  if (!chat_id) {
    return res.status(400).json({ error: 'Invalid chat ID' });
  }

  const userId = getUserId();

  try {
    // Try to get from cache first (instant response)
    if (!force_refresh) {
      const cached = getCachedChatMessages(userId, chat_id);

      if (cached && cached.messages && cached.messages.length > 0) {
        const cacheAge = Date.now() - cached.lastUpdated;

        // Use cache if it's less than 60 seconds old
        if (cacheAge < 60000) {
          logger.debug(`[Messenger] Serving ${cached.messages.length} messages for chat ${chat_id} from cache (age: ${Math.round(cacheAge / 1000)}s)`);
          return res.json({
            messages: cached.messages,
            user_id: userId,
            from_cache: true
          });
        }
      }
    }

    // Cache is stale, empty, or force refresh - fetch fresh data
    const data = await apiCall('/messenger/get-chat', 'POST', { chat_id });
    const messages = data?.data?.chat?.messages || data?.data?.messages;

    // Update cache with fresh data
    if (messages && messages.length > 0) {
      updateChatMessages(userId, chat_id, messages, {
        lastFetched: Date.now()
      });
    }

    res.json({
      messages: messages,
      user_id: userId
    });
  } catch (error) {
    logger.error('Error getting messages:', error);

    // Try to return cached data even if stale
    const cached = getCachedChatMessages(userId, chat_id);
    if (cached && cached.messages && cached.messages.length > 0) {
      logger.warn(`[Messenger] API failed for chat ${chat_id}, returning stale cache`);
      return res.json({
        messages: cached.messages,
        user_id: userId,
        from_cache: true,
        cache_stale: true
      });
    }

    res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

/**
 * POST /api/messenger/send-private - Sends a private message to another user.
 *
 * This endpoint handles sending private messages (DMs) between users. It validates
 * the message content, subject line, and recipient, then forwards the message to
 * the game API. Rate limited to prevent spam.
 *
 * Why This Endpoint:
 * - Bypasses in-game messenger interface (may have bugs/limitations)
 * - Provides input validation before hitting game API
 * - Blocks dangerous HTML/JavaScript patterns to prevent XSS attacks
 * - Rate limits to prevent spam (30 messages/minute)
 *
 * Validation Rules:
 * - message: String, 1-1000 characters
 * - subject: String, non-empty (required)
 * - target_user_id: Positive integer (required)
 * - Dangerous patterns blocked: <script>, <iframe>, javascript:, onerror=, etc.
 *
 * Security Strategy (Defense in Depth):
 * - Backend: Pattern blocking (blocks dangerous HTML/JS in message AND subject)
 * - Frontend: HTML escaping on render (escapes all HTML entities)
 * - This prevents XSS while avoiding double-escaping issues
 *
 * Rate Limiting:
 * - Applied via messageLimiter middleware
 * - Limit: 30 requests per minute per IP
 * - Returns 429 Too Many Requests when exceeded
 *
 * Request Body:
 * {
 *   message: string,         // Message content (1-1000 chars)
 *   subject: string,         // Subject line (required)
 *   target_user_id: number   // Recipient's user ID
 * }
 *
 * Side Effects:
 * - Makes API call to /messenger/send-message
 * - Creates new conversation or adds to existing thread
 * - Recipient receives notification (handled by game)
 *
 * @name POST /api/messenger/send-private
 * @function
 * @memberof module:server/routes/messenger
 * @param {express.Request} req - Express request object with message data in body
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response { success: true } or error
 */
router.post('/messenger/send-private', messageLimiter, express.json(), async (req, res) => {
  const { message, subject, target_user_id } = req.body;

  logger.info(`[Messenger] send-private called: message=${typeof message}, subject=${typeof subject}, target_user_id=${typeof target_user_id}`);
  logger.debug(`[Messenger] Request body: ${JSON.stringify(req.body)}`);

  if (!message || typeof message !== 'string' || message.length === 0 || message.length > 1000) {
    logger.warn(`[Messenger] Invalid message: ${typeof message}, length=${message?.length}`);
    return res.status(400).json({ error: 'Invalid message' });
  }

  if (!subject || typeof subject !== 'string' || subject.length === 0) {
    logger.warn(`[Messenger] Invalid subject: ${typeof subject}, value="${subject}"`);
    return res.status(400).json({ error: 'Subject is required' });
  }

  const targetUserIdNum = typeof target_user_id === 'string' ? parseInt(target_user_id, 10) : target_user_id;

  if (!targetUserIdNum || !Number.isInteger(targetUserIdNum) || targetUserIdNum <= 0) {
    return res.status(400).json({ error: 'Valid target_user_id required' });
  }

  const trimmedMessage = validator.trim(message);
  const trimmedSubject = validator.trim(subject);

  // Block dangerous HTML/JavaScript patterns in message and subject
  const dangerousPatterns = /<script|<iframe|javascript:|data:text\/html|on\w+\s*=/i;
  if (dangerousPatterns.test(trimmedMessage)) {
    return res.status(400).json({
      error: 'Message contains forbidden HTML or JavaScript content'
    });
  }
  if (dangerousPatterns.test(trimmedSubject)) {
    return res.status(400).json({
      error: 'Subject contains forbidden HTML or JavaScript content'
    });
  }

  try {
    const result = await apiCall('/messenger/send-message', 'POST', {
      subject: trimmedSubject,
      body: trimmedMessage,
      recipient: targetUserIdNum
    });

    // Check if API returned an error
    if (result.success === false || result.error) {
      logger.error('[Messenger] Message rejected by API:', JSON.stringify(result, null, 2));
      const errorMessage = result.message || result.error || 'Message rejected by game server';
      return res.status(400).json({ error: errorMessage });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending private message:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/messenger/delete-chat - Deletes a conversation thread.
 *
 * This endpoint handles deletion of messenger conversations. Requires both chat_ids
 * (conversation IDs) and system_message_ids (system message IDs) as the game API
 * needs both to properly clean up all related data.
 *
 * Why Both ID Arrays Required:
 * - Game API separates chat messages from system messages
 * - Both must be deleted to fully remove conversation
 * - Prevents orphaned data in game database
 *
 * Request Body:
 * {
 *   chat_ids: number[],           // Array of chat/conversation IDs to delete
 *   system_message_ids: number[]  // Array of related system message IDs
 * }
 *
 * Validation:
 * - Both chat_ids and system_message_ids required (400 error if missing)
 * - Arrays can be empty but must be present
 *
 * Side Effects:
 * - Makes API call to /messenger/delete-chat
 * - Permanently removes conversation from messenger
 * - Cannot be undone (deletion is permanent)
 *
 * @name POST /api/messenger/delete-chat
 * @function
 * @memberof module:server/routes/messenger
 * @param {express.Request} req - Express request object with chat deletion data
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response { success: true, data: {...} }
 */
router.post('/messenger/mark-as-read', express.json(), async (req, res) => {
  const { chat_ids, system_message_ids } = req.body;

  if (!chat_ids || !system_message_ids) {
    return res.status(400).json({ error: 'chat_ids and system_message_ids required' });
  }

  try {
    // Game API expects arrays as JSON strings, not actual arrays
    const data = await apiCall('/messenger/mark-as-read', 'POST', {
      chat_ids: JSON.stringify(chat_ids),
      system_message_ids: JSON.stringify(system_message_ids)
    });

    // Update cache to mark chats as read
    const userId = getUserId();
    for (const chatId of chat_ids) {
      markChatAsReadInCache(userId, chatId);
    }

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error marking chat as read:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/messenger/delete-chat', express.json(), async (req, res) => {
  const { chat_ids, system_message_ids, case_id } = req.body;

  if (!chat_ids || !system_message_ids) {
    return res.status(400).json({ error: 'chat_ids and system_message_ids required' });
  }

  try {
    logger.info(`[Messenger] Deleting chats: chat_ids=${JSON.stringify(chat_ids)}, system_message_ids=${JSON.stringify(system_message_ids)}`);

    // Game API expects arrays as JSON strings, not actual arrays
    const data = await apiCall('/messenger/delete-chat', 'POST', {
      chat_ids: JSON.stringify(chat_ids),
      system_message_ids: JSON.stringify(system_message_ids)
    });

    logger.info(`[Messenger] Delete API response: ${JSON.stringify(data)}`);

    // Remove deleted chats from cache
    const userId = getUserId();

    // Delete regular chats by chat_id
    for (const chatId of chat_ids) {
      deleteChatFromCache(userId, chatId);
      logger.debug(`[Messenger] Deleted chat ${chatId} from local cache`);
    }

    // Delete system messages by system_message_id
    // For system messages, their ID in the chat list IS the system_message_id
    for (const systemMsgId of system_message_ids) {
      deleteChatFromCache(userId, systemMsgId);
      logger.debug(`[Messenger] Deleted system message ${systemMsgId} from local cache`);
    }

    // If case_id is provided, delete from database
    if (case_id) {
      try {
        const db = getDb();
        db.prepare('DELETE FROM hijack_history WHERE case_id = ?').run(case_id);
        db.prepare('DELETE FROM hijack_cases WHERE case_id = ?').run(case_id);
        logger.debug(`[Hijacking] Deleted case ${case_id} from database`);
      } catch (error) {
        logger.error(`[Hijacking] Failed to delete case ${case_id} from database:`, error);
        // Don't fail the entire request if database deletion fails
      }
    }

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error deleting chat:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/user/search - Search for users by name.
 *
 * This endpoint searches for users matching a given name pattern.
 * Returns array of matching users with their IDs and company names.
 *
 * Why This Endpoint:
 * - Resolves company names to user IDs for users not in contacts
 * - Enables messaging users who sent DMs but aren't in contact list
 * - Provides fallback when contact list lookup fails
 *
 * Request Body:
 * {
 *   name: string  // Search term (partial match supported)
 * }
 *
 * Validation Rules:
 * - Query must be string type
 * - Length: 2-100 characters
 * - Only alphanumeric characters, spaces, hyphens, underscores, and dots allowed
 * - HTML characters are escaped to prevent XSS
 *
 * Response Structure:
 * {
 *   data: {
 *     companies: [{id, company_name, ...}, ...]
 *   },
 *   user: {...}  // Current user data
 * }
 *
 * Side Effects:
 * - Makes API call to /user/search
 *
 * @name POST /api/user/search
 * @function
 * @memberof module:server/routes/messenger
 * @param {express.Request} req - Express request object with { name: string } body
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with search results
 */
router.post('/user/search', express.json(), async (req, res) => {
  const { name } = req.body;

  // Validate search query
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Search name required' });
  }

  const trimmedName = validator.trim(name);

  // Check length constraints
  if (trimmedName.length < 2) {
    return res.status(400).json({ error: 'Search query too short (min 2 characters)' });
  }
  if (trimmedName.length > 100) {
    return res.status(400).json({ error: 'Search query too long (max 100 characters)' });
  }

  // Allow only alphanumeric, spaces, hyphens, underscores, and dots
  if (!/^[a-zA-Z0-9\s\-_.]+$/.test(trimmedName)) {
    return res.status(400).json({ error: 'Search query contains invalid characters' });
  }

  const sanitizedName = validator.escape(trimmedName);

  try {
    const data = await apiCall('/user/search', 'POST', { name: sanitizedName });
    res.json(data);
  } catch (error) {
    // Game API sometimes returns 500 for user search
    // Return empty results instead of error to prevent frontend issues
    logger.error('Error searching users:', error.message);
    res.json({
      data: { companies: [] },
      user: {}
    });
  }
});

/**
 * GET /api/hijacking/history/:caseId - Get negotiation history for a case
 */
router.get('/hijacking/history/:caseId', (req, res) => {
  const { caseId } = req.params;

  // CRITICAL: Validate caseId to prevent path traversal attacks
  if (!caseId || !/^[a-zA-Z0-9\-_]+$/.test(caseId)) {
    return res.status(400).json({
      error: 'Invalid case ID. Only alphanumeric characters, hyphens, and underscores allowed.'
    });
  }

  if (caseId.length > 100) {
    return res.status(400).json({ error: 'Case ID too long (max 100 characters)' });
  }

  const userId = getUserId();
  const caseIdInt = parseInt(caseId, 10);

  try {
    const db = getDb(userId);

    // Get history events from hijack_history
    const historyRows = db.prepare(`
      SELECT type, amount, timestamp
      FROM hijack_history
      WHERE case_id = ?
      ORDER BY timestamp
    `).all(caseIdInt);

    // Get case metadata from hijack_cases
    const caseRow = db.prepare(`
      SELECT resolved, autopilot_resolved, resolved_at, cash_before, cash_after, payment_verified, paid_amount, requested_amount
      FROM hijack_cases
      WHERE case_id = ?
    `).get(caseIdInt);

    const history = historyRows.map(r => ({
      type: r.type,
      amount: r.amount,
      timestamp: r.timestamp
    }));

    const response = {
      history: history,
      autopilot_resolved: caseRow?.autopilot_resolved === 1,
      resolved: caseRow?.resolved === 1
    };

    if (caseRow?.resolved_at) {
      response.resolved_at = caseRow.resolved_at;
    }

    if (caseRow?.payment_verified) {
      response.payment_verification = {
        verified: caseRow.payment_verified === 1,
        actual_paid: caseRow.paid_amount,
        expected_amount: caseRow.requested_amount,
        cash_before: caseRow.cash_before,
        cash_after: caseRow.cash_after
      };
    }

    return res.json(response);
  } catch (error) {
    logger.error('Error reading hijack history:', error);
    res.json({ history: [], autopilot_resolved: false, resolved: false });
  }
});

/**
 * POST /api/hijacking/history/:caseId - Save negotiation history for a case
 */
router.post('/hijacking/history/:caseId', express.json(), (req, res) => {
  const { caseId } = req.params;

  // CRITICAL: Validate caseId to prevent path traversal attacks
  if (!caseId || !/^[a-zA-Z0-9\-_]+$/.test(caseId)) {
    return res.status(400).json({
      error: 'Invalid case ID. Only alphanumeric characters, hyphens, and underscores allowed.'
    });
  }

  if (caseId.length > 100) {
    return res.status(400).json({ error: 'Case ID too long (max 100 characters)' });
  }

  const { history, autopilot_resolved, resolved_at, payment_verification } = req.body;
  const userId = getUserId();
  const caseIdInt = parseInt(caseId, 10);

  try {
    const db = getDb(userId);

    // Save history events using saveNegotiationEvent (handles deduplication)
    if (history && Array.isArray(history)) {
      for (const event of history) {
        saveNegotiationEvent(caseIdInt, event.type, event.amount, event.timestamp);
      }
    }

    // Save metadata to hijack_cases if provided
    if (autopilot_resolved || resolved_at || payment_verification) {
      // Ensure case exists
      const existing = db.prepare('SELECT case_id FROM hijack_cases WHERE case_id = ?').get(caseIdInt);

      if (existing) {
        // Update existing case
        if (autopilot_resolved) {
          db.prepare('UPDATE hijack_cases SET autopilot_resolved = 1, resolved = 1 WHERE case_id = ?').run(caseIdInt);
        }
        if (resolved_at) {
          db.prepare('UPDATE hijack_cases SET resolved_at = ?, resolved = 1 WHERE case_id = ?').run(resolved_at, caseIdInt);
        }
        if (payment_verification) {
          db.prepare(`
            UPDATE hijack_cases SET
              payment_verified = 1,
              paid_amount = ?,
              cash_before = ?,
              cash_after = ?,
              resolved = 1
            WHERE case_id = ?
          `).run(
            payment_verification.actual_paid,
            payment_verification.cash_before,
            payment_verification.cash_after,
            caseIdInt
          );
        }
      } else {
        // Create minimal case entry with metadata
        db.prepare(`
          INSERT INTO hijack_cases (case_id, status, resolved, autopilot_resolved, resolved_at, payment_verified, paid_amount, cash_before, cash_after)
          VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          caseIdInt,
          (autopilot_resolved || resolved_at || payment_verification) ? 1 : 0,
          autopilot_resolved ? 1 : 0,
          resolved_at,
          payment_verification ? 1 : 0,
          payment_verification?.actual_paid,
          payment_verification?.cash_before,
          payment_verification?.cash_after
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error saving hijack history:', error);
    res.status(500).json({ error: 'Failed to save history' });
  }
});

/**
 * POST /api/hijacking/get-case - Get hijacking case details.
 *
 * Request Body:
 * {
 *   case_id: number  // Required: Hijacking case ID
 * }
 *
 * Response Structure:
 * {
 *   data: {
 *     id: number,
 *     requested_amount: number,
 *     paid_amount: number|null,
 *     user_proposal: number|null,
 *     has_negotiation: boolean|number,
 *     round_end_time: number,
 *     status: string,
 *     danger_zone_slug: string,
 *     registered_at: number
 *   },
 *   user: {...}
 * }
 */
router.post('/hijacking/get-case', express.json(), async (req, res) => {
  const { case_id } = req.body;

  if (!case_id || !Number.isInteger(case_id)) {
    return res.status(400).json({ error: 'Valid case_id required' });
  }

  try {
    // Use cache to avoid duplicate API calls for resolved cases
    const cached = await getCachedHijackingCase(case_id);
    if (cached) {
      res.json({ data: cached.details, user: {} });
    } else {
      const data = await apiCall('/hijacking/get-case', 'POST', { case_id });
      res.json(data);
    }
  } catch (error) {
    logger.error('Error getting hijacking case:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/hijacking/submit-offer - Submit ransom counter-offer.
 *
 * Request Body:
 * {
 *   case_id: number,  // Required: Hijacking case ID
 *   amount: number    // Required: Counter-offer amount
 * }
 *
 * Response Structure:
 * {
 *   data: {
 *     id: number,
 *     requested_amount: number,  // Updated pirate counter-offer
 *     user_proposal: number,     // Your last offer
 *     has_negotiation: boolean,
 *     round_end_time: number,    // New deadline
 *     status: string,
 *     ...
 *   },
 *   user: {...}  // Updated user data (reputation may decrease)
 * }
 */
router.post('/hijacking/submit-offer', express.json(), async (req, res) => {
  const { case_id, amount } = req.body;

  if (!case_id || !Number.isInteger(case_id)) {
    return res.status(400).json({ error: 'Valid case_id required' });
  }

  if (!amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Valid amount required' });
  }

  try {
    const data = await apiCall('/hijacking/submit-offer', 'POST', { case_id, amount });

    // Log successful offer submission
    const userId = getUserId();
    if (userId && data.data) {
      const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');
      const pirateCounter = data.data.requested_amount || data.data.pirate_counter || null;

      await auditLog(
        userId,
        CATEGORIES.HIJACKING,
        'Manual Negotiate Hijacking',
        `Offered ${formatCurrency(amount)} for Case #${case_id}${pirateCounter ? ` | Pirate counter: ${formatCurrency(pirateCounter)}` : ''}`,
        {
          case_id,
          user_offer: amount,
          pirate_counter: pirateCounter,
          status: data.data.status || 'pending'
        },
        'SUCCESS',
        SOURCES.MANUAL
      );

      // Save user offer to SQLite history
      saveNegotiationEvent(case_id, 'user', amount, Date.now() / 1000);

      // If pirate counter-offer returned, save it too
      if (pirateCounter) {
        saveNegotiationEvent(case_id, 'pirate', pirateCounter, Date.now() / 1000);
      }
    }

    res.json(data);
  } catch (error) {
    logger.error('Error submitting hijacking offer:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/hijacking/pay - Pay the ransom to close the hijacking case.
 *
 * Request body:
 * {
 *   case_id: number  // The hijacking case ID
 * }
 *
 * Response:
 * {
 *   data: {
 *     id: number,
 *     paid_amount: number,    // Amount actually paid
 *     status: string,         // Case status after payment
 *     ...
 *   },
 *   user: {...},  // Updated user data (cash deducted, reputation may change)
 *   payment_verification: {
 *     verified: boolean,
 *     expected_amount: number,
 *     actual_paid: number,
 *     cash_before: number,
 *     cash_after: number
 *   }
 * }
 */
router.post('/hijacking/pay', express.json(), async (req, res) => {
  const { case_id } = req.body;
  const userId = getUserId();

  if (!case_id || !Number.isInteger(case_id)) {
    return res.status(400).json({ error: 'Valid case_id required' });
  }

  try {
    // Get case data BEFORE payment to capture cash and expected amount
    const caseBeforePay = await apiCall('/hijacking/get-case', 'POST', { case_id });
    const cashBefore = caseBeforePay?.user?.cash;
    const expectedAmount = caseBeforePay?.data?.requested_amount;

    // Get vessel info from messenger (hijacking chats contain vessel_name)
    let vesselName = null;
    let userVesselId = null;
    let dangerZone = null;
    try {
      const chatsResponse = await apiCall('/messenger/get-chats', 'POST', {});
      const chats = chatsResponse?.data || [];
      const hijackChat = chats.find(c =>
        c.subject === 'vessel_got_hijacked' &&
        c.values?.case_id === case_id
      );
      if (hijackChat?.values) {
        vesselName = hijackChat.values.vessel_name;
        userVesselId = hijackChat.values.user_vessel_id;
        dangerZone = hijackChat.values.tr_danger_zone;
      }
    } catch (chatErr) {
      logger.warn(`[Hijacking Payment] Could not fetch vessel info from messenger: ${chatErr.message}`);
    }

    // Execute payment
    const data = await apiCall('/hijacking/pay', 'POST', { case_id });

    // Get case data AFTER payment to capture new cash
    const caseAfterPay = await apiCall('/hijacking/get-case', 'POST', { case_id });
    const cashAfter = caseAfterPay?.user?.cash;
    const actualPaid = cashBefore - cashAfter;
    const verified = actualPaid === expectedAmount;

    logger.info(`[Hijacking Payment] Case ${case_id}: Payment verification - Expected: $${expectedAmount}, Actual: $${actualPaid}, Verified: ${verified}`);

    // Log successful ransom payment
    if (userId && actualPaid > 0) {
      const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

      const vesselDisplay = vesselName ? ` for ${vesselName}` : '';
      await auditLog(
        userId,
        CATEGORIES.HIJACKING,
        'Manual Pay Ransom',
        `Paid ${formatCurrency(actualPaid)} ransom${vesselDisplay} (Case #${case_id})`,
        {
          case_id,
          vessel_name: vesselName,
          user_vessel_id: userVesselId,
          danger_zone: dangerZone,
          amount_paid: actualPaid,
          expected_amount: expectedAmount,
          cash_before: cashBefore,
          cash_after: cashAfter,
          payment_verified: verified
        },
        'SUCCESS',
        SOURCES.MANUAL
      );
    }

    // Save resolution to SQLite database
    try {
      markCaseResolved(case_id, {
        autopilot_resolved: false,
        resolved_at: Date.now() / 1000,
        actual_paid: actualPaid,
        cash_before: cashBefore,
        cash_after: cashAfter,
        verified: verified
      });
      logger.debug(`[Hijacking Payment] Case ${case_id}: Marked as resolved in SQLite`);
    } catch (error) {
      logger.error(`[Hijacking Payment] Case ${case_id}: Failed to save resolution:`, error);
    }

    // Invalidate hijacking cache for this case and trigger immediate refresh
    try {
      const { invalidateHijackingCase, triggerImmediateHijackingRefresh } = require('../websocket');

      // Remove this case from cache so next refresh fetches fresh data
      invalidateHijackingCase(case_id);
      logger.debug(`[Hijacking Payment] Case ${case_id}: Cache invalidated`);

      // Trigger immediate badge/header refresh
      triggerImmediateHijackingRefresh();
      logger.debug(`[Hijacking Payment] Case ${case_id}: Triggered immediate hijacking refresh`);
    } catch (error) {
      logger.error(`[Hijacking Payment] Case ${case_id}: Failed to trigger refresh:`, error);
    }

    // Return response with verification data
    res.json({
      ...data,
      payment_verification: {
        verified: verified,
        expected_amount: expectedAmount,
        actual_paid: actualPaid,
        cash_before: cashBefore,
        cash_after: cashAfter
      }
    });
  } catch (error) {
    logger.error('Error paying hijacking ransom:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/hijacking/get-cases - Get all hijacking cases with details.
 *
 * This endpoint aggregates all hijacking cases from the messenger inbox,
 * fetches full details for each case, and returns them with open/closed status.
 *
 * Why This Endpoint:
 * - Separates hijacking inbox from regular messenger inbox
 * - Provides dedicated list of all hijacking cases (open + closed)
 * - Adds isOpen field for UI rendering (OPEN vs CLOSED status)
 * - Used by "Blackbeard's Phone Booth" overlay
 *
 * Response Structure:
 * {
 *   cases: [{
 *     id: number,                    // System message ID
 *     values: {
 *       case_id: number,             // Hijacking case ID
 *       vessel_name: string,         // Hijacked vessel name
 *       ...
 *     },
 *     caseDetails: {                 // Full case data from /hijacking/get-case
 *       requested_amount: number,
 *       paid_amount: number|null,
 *       user_proposal: number|null,
 *       status: string,
 *       ...
 *     },
 *     isOpen: boolean,               // true if case is still open
 *     time_last_message: number      // Unix timestamp
 *   }, ...],
 *   own_user_id: number
 * }
 *
 * Case Status Logic:
 * - OPEN: paid_amount === null && status !== 'solved'
 * - CLOSED: paid_amount !== null || status === 'solved'
 *
 * Side Effects:
 * - Makes API call to /messenger/get-chats
 * - Makes multiple API calls to /hijacking/get-case (one per case)
 *
 * @name GET /api/hijacking/get-cases
 * @function
 * @memberof module:server/routes/messenger
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with all hijacking cases
 */
router.get('/hijacking/get-cases', async (req, res) => {
  try {
    // Get all messenger chats
    const chatsData = await apiCall('/messenger/get-chats', 'POST', {});
    const allChats = chatsData?.data;

    // Filter for hijacking cases only
    const hijackingChats = allChats.filter(chat =>
      chat.system_chat && chat.body === 'vessel_got_hijacked'
    );

    // Fetch full details for each case (using shared cache)
    const casesWithDetails = await Promise.all(
      hijackingChats.map(async (chat) => {
        try {
          const caseId = chat.values?.case_id;
          if (!caseId) {
            logger.error('[Hijacking] Chat missing case_id:', chat);
            return null;
          }

          // Fetch full case details (from cache if available)
          const caseResult = await getCachedHijackingCase(caseId);

          if (!caseResult || !caseResult.details) {
            logger.error(`[Hijacking] No details for case ${caseId}`);
            return null;
          }

          return {
            id: chat.id,                    // System message ID (for deletion)
            values: chat.values,            // Contains case_id, vessel_name, etc.
            caseDetails: caseResult.details, // Full case data
            isOpen: caseResult.isOpen,
            time_last_message: caseResult.details.registered_at
          };
        } catch (error) {
          logger.error(`[Hijacking] Error fetching case details:`, error.message);
          return null;
        }
      })
    );

    // Filter out any null entries (failed fetches)
    const validCases = casesWithDetails.filter(c => c !== null);

    // Sort by timestamp (newest first)
    validCases.sort((a, b) => b.time_last_message - a.time_last_message);

    res.json({
      cases: validCases,
      own_user_id: getUserId()
    });
  } catch (error) {
    logger.error('[Hijacking] Error fetching cases:', error);
    res.status(500).json({ error: 'Failed to retrieve hijacking cases' });
  }
});

module.exports = router;
