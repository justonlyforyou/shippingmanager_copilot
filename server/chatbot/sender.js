/**
 * @fileoverview ChatBot Message Sender Module
 *
 * Handles sending responses via alliance chat or private messages.
 * Includes global DM queue with rate limiting to respect Game API limits.
 *
 * @module server/chatbot/sender
 */

const { apiCall, getAllianceId, getUserId } = require('../utils/api');
const { triggerImmediateChatRefresh, triggerImmediateMessengerRefresh } = require('../websocket');
const { broadcast } = require('../websocket/broadcaster');
const logger = require('../utils/logger');

// ============================================================================
// Global DM Queue - Rate limited to 1 message per 20 seconds
// ============================================================================

const dmQueue = [];
let isProcessingDmQueue = false;
const DM_INTERVAL_MS = 45000; // 45 seconds between DMs (Game API rate limit)
const MAX_RETRIES = 2;

/**
 * Queue item structure
 * @typedef {Object} DmQueueItem
 * @property {string|number} userId - Recipient user ID
 * @property {string} subject - Message subject
 * @property {string} message - Message body
 * @property {string} companyName - Company name for logging/notification
 * @property {boolean} notifyChat - Whether to send success/failure to alliance chat
 * @property {number} retries - Number of retry attempts
 * @property {Function} resolve - Promise resolve function
 * @property {Function} reject - Promise reject function
 */

/**
 * Add a DM to the queue and return a promise that resolves when sent
 * @param {string|number} userId - Recipient user ID
 * @param {string} subject - Message subject
 * @param {string} message - Message body
 * @param {string} [companyName] - Company name for logging
 * @param {boolean} [notifyChat] - Whether to send success/failure to alliance chat
 * @returns {Promise<object|null>} Resolves with API response or null on failure
 */
function queuePrivateMessage(userId, subject, message, companyName = null, notifyChat = false) {
    return new Promise((resolve, reject) => {
        const item = {
            userId,
            subject,
            message,
            companyName: companyName || `User ${userId}`,
            notifyChat,
            retries: 0,
            resolve,
            reject
        };

        dmQueue.push(item);
        logger.debug(`[DM Queue] Added: ${item.companyName} (queue size: ${dmQueue.length})`);

        // Start processing if not already running
        processDmQueue();
    });
}

/**
 * Get current queue status
 * @returns {Object} Queue status info
 */
function getDmQueueStatus() {
    return {
        queueLength: dmQueue.length,
        isProcessing: isProcessingDmQueue,
        estimatedTimeSeconds: dmQueue.length * (DM_INTERVAL_MS / 1000)
    };
}

/**
 * Process the DM queue with rate limiting
 */
async function processDmQueue() {
    if (isProcessingDmQueue) return;
    if (dmQueue.length === 0) return;

    isProcessingDmQueue = true;
    logger.debug(`[DM Queue] Starting processing (${dmQueue.length} items)`);

    while (dmQueue.length > 0) {
        const item = dmQueue.shift();

        try {
            logger.debug(`[DM Queue] Sending to ${item.companyName} (${dmQueue.length} remaining)`);
            const result = await sendPrivateMessageDirect(item.userId, item.subject, item.message);
            item.resolve(result);
            logger.info(`[DM Queue] Sent to ${item.companyName}`);

            // Send success notification to alliance chat if enabled
            if (item.notifyChat) {
                await sendAllianceMessage(`${item.subject} sent to ${item.companyName}`);
            }
        } catch (error) {
            // Check if it's a rate limit error
            if (error.message && error.message.includes('Please wait')) {
                item.retries++;

                if (item.retries <= MAX_RETRIES) {
                    // Re-queue at front for retry after delay
                    dmQueue.unshift(item);
                    logger.warn(`[DM Queue] Rate limited, retry ${item.retries}/${MAX_RETRIES} for ${item.companyName}`);

                    // Notify user about rate limit
                    broadcastRateLimitNotification(item.companyName);

                    // Wait extra time before retry
                    await new Promise(resolve => setTimeout(resolve, DM_INTERVAL_MS));
                } else {
                    logger.error(`[DM Queue] Max retries exceeded for ${item.companyName}`);
                    item.reject(error);

                    // Notify about permanent failure
                    broadcastDmFailureNotification(item.companyName, 'Max retries exceeded');

                    // Send failure notification to alliance chat if enabled
                    if (item.notifyChat) {
                        await sendAllianceMessage(`${item.subject} NOT sent to ${item.companyName} because of max retries exceeded`);
                    }
                }
            } else {
                logger.error(`[DM Queue] Failed to send to ${item.companyName}: ${error.message}`);
                item.reject(error);

                // Notify about failure
                broadcastDmFailureNotification(item.companyName, error.message);

                // Send failure notification to alliance chat if enabled
                if (item.notifyChat) {
                    await sendAllianceMessage(`${item.subject} NOT sent to ${item.companyName} because of ${error.message}`);
                }
            }
        }

        // Wait before next message (if queue not empty)
        if (dmQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, DM_INTERVAL_MS));
        }
    }

    isProcessingDmQueue = false;
    logger.debug(`[DM Queue] Processing complete`);
}

/**
 * Broadcast rate limit notification to frontend
 * @param {string} companyName - Company name that was rate limited
 */
function broadcastRateLimitNotification(companyName) {
    broadcast('generic_notification', {
        type: 'warning',
        title: 'API Rate Limit',
        message: `Game API rate limit hit while sending DM to ${companyName}. Retrying in 45 seconds...`,
        desktop: true,
        duration: 5000
    });
}

/**
 * Broadcast DM failure notification to frontend
 * @param {string} companyName - Company name
 * @param {string} reason - Failure reason
 */
function broadcastDmFailureNotification(companyName, reason) {
    broadcast('generic_notification', {
        type: 'error',
        title: 'DM Failed',
        message: `Failed to send DM to ${companyName}: ${reason}`,
        desktop: true,
        duration: 8000
    });
}

/**
 * Broadcast DM queued confirmation to frontend
 * @param {string} templateKey - Template key used
 * @param {Array<string>} companyNames - List of company names queued
 */
function broadcastDmQueuedNotification(templateKey, companyNames) {
    broadcast('generic_notification', {
        type: 'info',
        title: 'Messages Queued',
        message: `${companyNames.length} DM(s) queued for template "${templateKey}"`,
        desktop: false,
        duration: 4000
    });
}

// ============================================================================
// Message Sending Functions
// ============================================================================

/**
 * Send response based on type
 * @param {string} message - Message content
 * @param {string} responseType - Response type ('public', 'dm', 'both')
 * @param {string} userId - User ID to send DM to
 * @param {boolean} isDM - Whether command came from DM
 */
async function sendResponse(message, responseType, userId, isDM) {
    logger.debug(`[ChatBot] sendResponse: userId=${userId}, isDM=${isDM}, configResponseType=${responseType}`);

    // Simple rule: Alliance chat -> public, DM -> dm
    if (!isDM) {
        // Alliance chat command -> always public response
        responseType = 'public';
        logger.debug(`[ChatBot] Alliance chat command -> public response`);
    } else {
        // DM command -> always dm response
        responseType = 'dm';
        logger.debug(`[ChatBot] DM command -> dm response`);
    }

    switch (responseType) {
        case 'public':
            await sendAllianceMessage(message);
            break;

        case 'dm':
            const result = await sendPrivateMessage(userId, 'Bot Response', message);

            // If self-DM failed, fall back to public response
            if (!result) {
                const currentUserId = getUserId();
                if (userId === currentUserId) {
                    // Send shortened public response
                    const shortMsg = message.length > 200 ?
                        message.substring(0, 197) + '...' :
                        message;
                    await sendAllianceMessage(`[Auto-Reply] ${shortMsg}`);
                }
            }
            break;

        case 'both':
            await sendAllianceMessage(message.substring(0, 200) + '...'); // Short version
            await sendPrivateMessage(userId, 'Full Response', message);
            break;
    }
}

/**
 * Log error to console only - NEVER send errors to chat or DM
 * @param {string} userId - User ID
 * @param {string} command - Command name
 * @param {Error} error - Error object
 */
async function sendErrorMessage(userId, command, error) {
    // ONLY log to console - no messages to users
    logger.error(`[ChatBot] Error executing command '${command}' for user ${userId}:`, error);
    // That's it - no sending messages anywhere!
}

/**
 * Send alliance message
 * @param {string} message - Message content
 */
async function sendAllianceMessage(message) {
    try {
        const allianceId = getAllianceId();

        // CRITICAL: Game API has 1000 character limit
        if (message.length > 1000) {
            logger.error(`[ChatBot] WARNING: Message too long! ${message.length} chars (max: 1000)`);
            logger.error(`[ChatBot] Message will be truncated to avoid API error`);

            // Truncate message and add indicator
            message = message.substring(0, 997) + '...';
        }

        // Use the correct endpoint that posts to alliance chat
        const response = await apiCall('/alliance/post-chat', 'POST', {
            alliance_id: allianceId,
            text: message
        });

        // Only log errors
        if (response?.error) {
            logger.error('[ChatBot] API returned error:', response.error);
        } else {
            // Trigger immediate chat refresh so clients see the response quickly
            // instead of waiting up to 25 seconds for next polling cycle
            triggerImmediateChatRefresh();
        }
    } catch (error) {
        logger.error('[ChatBot] Failed to send alliance message:', error);
        logger.error('[ChatBot] Error details:', error.response?.data || error.message);
    }
}

/**
 * Send private message (uses queue for rate limiting)
 * @param {string} userId - Recipient user ID
 * @param {string} subject - Message subject
 * @param {string} message - Message body
 * @param {string} [companyName] - Optional company name for logging
 * @returns {Promise<object|null>} API response or null on failure
 */
async function sendPrivateMessage(userId, subject, message, companyName = null) {
    // Use the queue for rate-limited sending
    return queuePrivateMessage(userId, subject, message, companyName);
}

/**
 * Send private message directly (bypasses queue - internal use only)
 * @param {string} userId - Recipient user ID
 * @param {string} subject - Message subject
 * @param {string} message - Message body
 * @returns {Promise<object|null>} API response or null on failure
 */
async function sendPrivateMessageDirect(userId, subject, message) {
    const myUserId = getUserId();

    try {
        // CRITICAL: Game API has 1000 character limit for messages
        if (message.length > 1000) {
            logger.error(`[ChatBot] WARNING: DM too long! ${message.length} chars (max: 1000)`);
            logger.error(`[ChatBot] Message will be truncated to avoid API error`);

            // Truncate message and add indicator
            message = message.substring(0, 997) + '...';
        }

        const response = await apiCall('/messenger/send-message', 'POST', {
            recipient: userId,
            subject: subject,
            body: message
        });

        // Check for API error in response
        if (response?.error) {
            // Error can be string or object with reason/error fields
            let errorMsg;
            if (typeof response.error === 'string') {
                errorMsg = response.error;
            } else {
                errorMsg = response.error.reason || response.error.error;
            }
            logger.error(`[ChatBot] API error sending DM to ${userId}: ${JSON.stringify(response.error)}`);
            throw new Error(errorMsg);
        }

        // Trigger immediate messenger refresh so user sees the response quickly
        // instead of waiting up to 10 seconds for next polling cycle
        triggerImmediateMessengerRefresh();

        return response;
    } catch (error) {
        logger.error(`[ChatBot] Failed to send private message to ${userId}:`, error);
        logger.error(`[ChatBot] Error details:`, error.response?.data || error.message);

        // Special handling for self-DM attempts
        if (userId === myUserId) {
            logger.error(`[ChatBot] Cannot send DM to yourself - game API limitation`);
            logger.debug(`[ChatBot] Falling back to public response`);
            // Don't re-throw for self-DM, handle gracefully
            return null;
        }

        throw error; // Re-throw for other errors
    }
}

module.exports = {
    sendResponse,
    sendErrorMessage,
    sendAllianceMessage,
    sendPrivateMessage,
    sendPrivateMessageDirect,
    queuePrivateMessage,
    getDmQueueStatus,
    broadcastDmQueuedNotification
};
