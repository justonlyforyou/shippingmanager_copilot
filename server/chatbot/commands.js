/**
 * @fileoverview ChatBot Command Handlers Module
 *
 * Handles built-in command logic (forecast, help).
 * Custom commands are handled by executor.js.
 *
 * @module server/chatbot/commands
 */

const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const { getUserId, getAllianceName, apiCall } = require('../utils/api');
const db = require('../database');
const { getInternalBaseUrl, getAppBaseDir } = require('../config');
const { getServerLocalTimezone } = require('../routes/forecast');

/**
 * Handle forecast command
 * @param {Array<string>} args - Command arguments [day, timezone]
 * @param {string} userId - User ID
 * @param {string} userName - User name
 * @param {object} config - Command configuration
 * @param {boolean} isDM - Whether command came from DM
 * @param {Function} sendResponseFn - Function to send response
 */
async function handleForecastCommand(args, userId, userName, config, isDM, sendResponseFn) {
    // Parse arguments
    let day;
    let responseType = config.responseType || 'dm';

    // If no arguments, let API use its default (tomorrow with correct month)
    // Only set day if user explicitly provided it
    if (args.length > 0) {
        day = parseInt(args[0]);
        if (isNaN(day)) {
            day = undefined; // Invalid arg - let API use default
        }
    }

    // Default timezone: undefined = server will use its local timezone
    // This allows the API to determine the appropriate timezone
    let timezone = args[1] || undefined;

    // Validate day (1-31) if provided
    if (day !== undefined && (day < 1 || day > 31)) {
        throw new Error('Invalid day. Please specify a day between 1 and 31.');
    }

    // Validate timezone if provided
    const validTimezones = [
        'PST', 'PDT', 'MST', 'MDT', 'CST', 'CDT', 'EST', 'EDT',
        'GMT', 'BST', 'WET', 'WEST', 'CET', 'CEST', 'EET', 'EEST',
        'JST', 'KST', 'IST',
        'AEST', 'AEDT', 'ACST', 'ACDT', 'AWST',
        'NZST', 'NZDT',
        'UTC'
    ];

    if (timezone && !validTimezones.includes(timezone.toUpperCase())) {
        // Invalid timezone - send error message
        const errorMsg = `❌ Invalid timezone: "${timezone}"\n\n`;
        const tzList = `⁉️ Supported timezones:\n${validTimezones.join(', ')}`;
        await sendResponseFn(errorMsg + tzList, responseType, userId, isDM);
        return; // Exit early
    }

    // Normalize timezone to uppercase (if provided)
    if (timezone) {
        timezone = timezone.toUpperCase();
    }

    // Get forecast data
    const forecastText = await generateForecastText(day, timezone);

    // Only send response if we got valid forecast text
    if (forecastText && forecastText.trim()) {
        await sendResponseFn(forecastText, responseType, userId, isDM);
    } else {
        logger.debug('[ChatBot] No forecast text generated - skipping response');
    }
}

/**
 * Generate forecast text for a specific day
 * @param {number} day - Day of month (1-31)
 * @param {string|undefined} timezone - Timezone abbreviation (undefined = server local timezone)
 * @returns {Promise<string>} Forecast text
 */
async function generateForecastText(day, timezone) {
    try {
        logger.debug(`[ChatBot] Generating forecast for day ${day}${timezone ? ` in ${timezone}` : ' (server timezone)'}`);

        // Use the existing forecast API endpoint (includes event discounts, formatting, etc.)
        const axios = require('axios');
        const { getSessionCookie } = require('../config');

        // Build query parameters
        const params = new URLSearchParams({
            source: 'chatbot'
        });

        if (day !== undefined) {
            params.append('day', day.toString());
        }

        if (timezone) {
            params.append('timezone', timezone);
        }

        // Call internal API endpoint
        const response = await axios.get(`${getInternalBaseUrl()}/api/forecast?${params.toString()}`, {
            headers: {
                'Cookie': `shipping_manager_session=${getSessionCookie()}`
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        });

        const forecastText = response.data;

        logger.debug(`[ChatBot] Forecast generated successfully for day ${day}`);
        return forecastText;

    } catch (error) {
        logger.error('[ChatBot] Error generating forecast:', error.message);
        logger.debug('[ChatBot] Full error:', error);
        // Return empty response on error - no error messages to users
        return '';
    }
}

/**
 * Check if user has management role in alliance (CEO, COO, Management, Interim CEO)
 * @param {number|string} checkUserId - User ID to check
 * @returns {Promise<boolean>} True if user has management role
 */
async function hasManagementRole(checkUserId) {
    try {
        const response = await apiCall('/alliance/get-alliance-members', 'POST', {});
        const members = response?.data?.members || response?.members || [];
        const member = members.find(m => m.user_id === parseInt(checkUserId));
        const role = member?.role || 'member';
        const allowedRoles = ['ceo', 'coo', 'management', 'interim_ceo'];
        return allowedRoles.includes(role);
    } catch (error) {
        logger.error('[ChatBot] Error checking management role:', error);
        return false;
    }
}

/**
 * Handle help command
 * @param {string} userId - User ID
 * @param {string} userName - User name
 * @param {object} config - Command configuration
 * @param {boolean} isDM - Whether command came from DM
 * @param {object} settings - ChatBot settings object
 * @param {Function} sendResponseFn - Function to send response
 */
async function handleHelpCommand(userId, userName, config, isDM, settings, sendResponseFn) {
    const prefix = settings.commandPrefix || '!';
    const MAX_MESSAGE_LENGTH = 900;

    // Check if user should see management commands
    // Only show in alliance chat AND only to bot owner or management roles
    const botOwnerId = getUserId();
    const isBotOwner = String(userId) === String(botOwnerId);
    const isManagement = !isDM && (isBotOwner || await hasManagementRole(userId));

    // Build help sections as array for easier splitting
    const sections = [];

    sections.push('Available Commands\n');

    // Built-in commands
    if (settings.commands.forecast?.enabled) {
        const serverTz = getServerLocalTimezone();

        let forecastSection = `Get fuel and CO2 price forecast\n\n`;
        forecastSection += `${prefix}forecast [day] [timezone]\n`;
        forecastSection += `day: 1-31 (default: today)\n`;
        forecastSection += `timezone: (default: ${serverTz.name})\n\n`;
        forecastSection += `Examples\n`;
        forecastSection += `${prefix}forecast 26 UTC\n`;
        forecastSection += `${prefix}forecast 15\n`;
        forecastSection += `${prefix}forecast (for today)\n\n`;
        forecastSection += `Supported timezones:\n`;
        forecastSection += `PST, PDT, MST, MDT, CST, CDT, EST, EDT, GMT, BST, WET, WEST, CET, CEST, EET, EEST, JST, KST, IST, AEST, AEDT, ACST, ACDT, AWST, NZST, NZDT, UTC`;
        sections.push(forecastSection);
    }

    // Management commands - only in alliance chat for bot owner or management roles
    if (isManagement) {
        // !msg command
        if (settings.commands.msg?.enabled) {
            let msgSection = `Send broadcast template\n\n`;
            msgSection += `${prefix}msg <template> - to all members\n`;
            msgSection += `${prefix}msg <template> [id1] [id2] - to specific users\n`;
            msgSection += `(management only)`;
            sections.push(msgSection);
        }

        // !welcome command
        if (settings.commands.welcome?.enabled) {
            let welcomeSection = `Send welcome message\n\n`;
            welcomeSection += `${prefix}welcome [userID]\n`;
            welcomeSection += `(management only)`;
            sections.push(welcomeSection);
        }
    }

    // Custom commands
    for (const cmd of settings.customCommands || []) {
        if (cmd.enabled) {
            let customSection = `${cmd.description || 'Custom command'}\n\n`;
            customSection += `${prefix}${cmd.trigger}`;
            if (cmd.adminOnly) {
                customSection += ' (admin only)';
            }
            sections.push(customSection);
        }
    }

    // Help command at the end
    if (settings.commands.help?.enabled) {
        sections.push(`Show help\n\n${prefix}help`);
    }

    sections.push(`Response times may vary up to 15 seconds - keep calm :)`);

    // Split into messages that fit within 900 character limit
    const messages = [];
    let currentMessage = '';

    for (const section of sections) {
        const separator = currentMessage ? '\n\n' : '';
        const newLength = currentMessage.length + separator.length + section.length;

        if (newLength <= MAX_MESSAGE_LENGTH) {
            currentMessage += separator + section;
        } else {
            // Current message is full, start a new one
            if (currentMessage) {
                messages.push(currentMessage);
            }
            currentMessage = section;
        }
    }

    // Add the last message
    if (currentMessage) {
        messages.push(currentMessage);
    }

    // Send all messages with delay between them
    const responseType = config.responseType || 'public';
    for (let i = 0; i < messages.length; i++) {
        await sendResponseFn(messages[i], responseType, userId, isDM);

        // Add delay between messages to avoid rate limiting
        if (i < messages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

/**
 * Handle welcome command - sends welcome message to a specific user
 * Only usable by management members (CEO, COO, Management, Interim CEO)
 * INTERNAL COMMAND: Only works in alliance chat, NOT in DMs
 * @param {Array<string>} args - Command arguments [targetUserId]
 * @param {string} userName - User name of command caller
 * @param {boolean} isDM - Whether command came from DM
 */
async function handleWelcomeCommand(args, userName, isDM) {
    // CRITICAL: welcome command is ONLY allowed in alliance chat, NEVER in DMs
    if (isDM) {
        logger.debug('[ChatBot] welcome command blocked: not allowed in DMs');
        return;
    }

    // This command only works for the bot owner (management check is done by adminOnly flag)
    let targetUserId = args[0];

    if (!targetUserId) {
        logger.error('[ChatBot] Welcome command missing user ID argument');
        return;
    }

    // Strip brackets if present (game chat wraps numbers in brackets)
    if (/^\[\d+\]$/.test(targetUserId)) {
        targetUserId = targetUserId.slice(1, -1); // Remove [ and ]
    }

    // Validate user ID is numeric
    if (!/^\d+$/.test(targetUserId)) {
        logger.error(`[ChatBot] Welcome command invalid user ID: ${targetUserId}`);
        return;
    }

    try {
        // Load welcome message from bot owner's settings
        const botOwnerId = getUserId();
        const settings = db.getUserSettings(botOwnerId) || {};

        // Get alliance name for variable replacement
        const allianceName = getAllianceName() || 'our Alliance';

        // Load subject and message from settings
        let welcomeSubject = settings.allianceWelcomeSubject ||
            'Welcome to [allianceName]';
        let welcomeMessage = settings.allianceWelcomeMessage ||
            'Welcome to our Alliance!\nJoin the Ally Chat and say Hello :)';

        // Replace [allianceName] variable in subject and message
        welcomeSubject = welcomeSubject.replace(/\[allianceName\]/g, allianceName);
        welcomeMessage = welcomeMessage.replace(/\[allianceName\]/g, allianceName);

        // Send welcome message as DM to target user with custom subject
        // Use dynamic require to avoid circular dependency
        const { sendPrivateMessage } = require('./sender');
        await sendPrivateMessage(targetUserId, welcomeSubject, welcomeMessage);

        logger.debug(`[ChatBot] Welcome message sent to user ${targetUserId} by ${userName}`);
    } catch (error) {
        logger.error('[ChatBot] Error sending welcome message:', error);
    }
}

/**
 * Get broadcast templates directory
 */
function getBroadcastDir() {
    const { isPackaged } = require('../config');
    const isPkg = isPackaged();
    return isPkg
        ? path.join(getAppBaseDir(), 'userdata', 'broadcast-templates')
        : path.join(__dirname, '../../userdata/broadcast-templates');
}

/**
 * Load broadcast templates for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Templates object
 */
async function loadBroadcastTemplates(userId) {
    const filePath = path.join(getBroadcastDir(), `${userId}.json`);
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

/**
 * Handle msg command - send broadcast template to alliance members
 * Format: !msg <templateKey> - broadcast to all members
 * Format: !msg <templateKey> [userID1] [userID2] ... - send to specific users
 * UserIDs MUST be in square brackets
 *
 * @param {Array<string>} args - Command arguments [templateKey, [userID1], [userID2], ...]
 * @param {string} userId - User ID of command caller
 * @param {string} userName - User name
 * @param {object} config - Command configuration
 * @param {boolean} isDM - Whether command came from DM
 */
async function handleMsgCommand(args, userId, userName, config, isDM) {
    logger.info(`[ChatBot] handleMsgCommand ENTRY: args=${JSON.stringify(args)}, userId=${userId}, isDM=${isDM}`);

    // CRITICAL: msg command is ONLY allowed in alliance chat, NEVER in DMs
    if (isDM) {
        logger.debug('[ChatBot] msg command blocked: not allowed in DMs');
        return;
    }

    if (args.length === 0) {
        logger.debug('[ChatBot] msg command missing template key');
        return;
    }

    const templateKey = args[0].toLowerCase();

    // Parse all [userID] arguments (supports multiple)
    const targetUserIds = [];
    for (let i = 1; i < args.length; i++) {
        const userIdArg = args[i];
        // MUST be in square brackets: [12345]
        const bracketMatch = userIdArg.match(/^\[(\d+)\]$/);
        if (bracketMatch) {
            targetUserIds.push(parseInt(bracketMatch[1]));
        } else {
            // If argument exists but is not in brackets, ignore it and log
            logger.debug(`[ChatBot] msg command: skipping invalid userID format: ${userIdArg}`);
        }
    }

    // Load templates for the bot owner (not the command caller)
    const botOwnerId = getUserId();
    const templates = await loadBroadcastTemplates(botOwnerId);
    const template = templates[templateKey];

    if (!template) {
        logger.debug(`[ChatBot] msg command: template "${templateKey}" not found`);
        return;
    }

    if (template.enabled !== true) {
        logger.debug(`[ChatBot] msg command: template "${templateKey}" is disabled (enabled=${template.enabled})`);
        return;
    }

    // Get alliance members for name lookup
    const membersResponse = await apiCall('/alliance/get-alliance-members', 'POST', {});
    const members = membersResponse?.data?.members || membersResponse?.members || [];

    // Build recipients list
    let recipients = [];

    if (targetUserIds.length > 0) {
        // Specific users mode - find each user
        for (const targetId of targetUserIds) {
            const targetMember = members.find(m => m.user_id === targetId);
            if (targetMember) {
                recipients.push(targetMember);
            } else {
                // User not in alliance, still try to send
                recipients.push({ user_id: targetId, company_name: `User ${targetId}` });
            }
        }
        logger.info(`[ChatBot] Sending msg "${templateKey}" to ${recipients.length} user(s) (triggered by ${userName})`);
    } else {
        // Broadcast to all alliance members (exclude self = bot owner)
        recipients = members.filter(m => m.user_id !== parseInt(botOwnerId));
        logger.info(`[ChatBot] Broadcasting msg "${templateKey}" to ${recipients.length} members (triggered by ${userName})`);
    }

    if (recipients.length === 0) {
        logger.debug('[ChatBot] msg command: no recipients');
        return;
    }

    // Import sender functions
    const { queuePrivateMessage, sendAllianceMessage, broadcastDmQueuedNotification } = require('./sender');

    // Build confirmation message for alliance chat
    const recipientNames = recipients.map(r => r.company_name);
    const confirmationLines = [
        `${template.subject} queued for:`
    ];
    for (const name of recipientNames) {
        confirmationLines.push(`- ${name}`);
    }

    // Send confirmation to alliance chat
    const confirmationMsg = confirmationLines.join('\n');
    await sendAllianceMessage(confirmationMsg);

    // Broadcast notification to frontend
    broadcastDmQueuedNotification(templateKey, recipientNames);

    // Queue all DMs (the queue handles rate limiting with 45s intervals)
    // notifyChat = true to send success/failure messages to alliance chat
    for (const recipient of recipients) {
        // Queue message - don't await, let the queue handle it
        queuePrivateMessage(recipient.user_id, template.subject, template.message, recipient.company_name, true)
            .then(() => {
                logger.debug(`[ChatBot] msg "${templateKey}" sent to ${recipient.company_name}`);
            })
            .catch(err => {
                logger.warn(`[ChatBot] msg "${templateKey}" failed for ${recipient.company_name}: ${err.message}`);
            });
    }

    logger.info(`[ChatBot] msg "${templateKey}" queued ${recipients.length} DMs`);
}

/**
 * Get enabled broadcast templates for help display
 * @returns {Promise<Array>} Array of enabled template keys with descriptions
 */
async function getEnabledBroadcastTemplates() {
    const userId = getUserId();
    if (!userId) return [];

    const templates = await loadBroadcastTemplates(userId);
    const enabled = [];

    for (const [key, template] of Object.entries(templates)) {
        if (template.enabled) {
            enabled.push({
                key,
                subject: template.subject
            });
        }
    }

    return enabled;
}

module.exports = {
    handleForecastCommand,
    generateForecastText,
    handleHelpCommand,
    handleWelcomeCommand,
    handleMsgCommand,
    getEnabledBroadcastTemplates,
    loadBroadcastTemplates
};
