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
const { getSettingsFilePath } = require('../settings-schema');
const { getInternalBaseUrl, getAppDataDir } = require('../config');
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
    const now = new Date();
    let day;
    let responseType = config.responseType || 'dm';

    // If no arguments, use tomorrow (default forecast behavior)
    if (args.length === 0) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        day = tomorrow.getDate();
    } else {
        day = parseInt(args[0]) || now.getDate() + 1; // Default to tomorrow if arg invalid
    }

    // Default timezone: undefined = server will use its local timezone
    // This allows the API to determine the appropriate timezone
    let timezone = args[1] || undefined;

    // Validate day (1-31)
    if (day < 1 || day > 31) {
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
            source: 'chatbot',
            day: day.toString()
        });

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

    // Build help sections as array for easier splitting
    const sections = [];

    sections.push('Available Commands\n');

    // Built-in commands
    if (settings.commands.forecast?.enabled) {
        const serverTz = getServerLocalTimezone();

        let forecastSection = `Get fuel and CO2 price forecast\n\n`;
        forecastSection += `${prefix}forecast [day] [timezone]\n`;
        forecastSection += `day: 1-31 (default: tomorrow)\n`;
        forecastSection += `timezone: (default: ${serverTz.name})\n\n`;
        forecastSection += `Examples\n`;
        forecastSection += `${prefix}forecast 26 UTC\n`;
        forecastSection += `${prefix}forecast 15\n`;
        forecastSection += `${prefix}forecast (for tomorrow)\n\n`;
        forecastSection += `Supported timezones:\n`;
        forecastSection += `PST, PDT, MST, MDT, CST, CDT, EST, EDT, GMT, BST, WET, WEST, CET, CEST, EET, EEST, JST, KST, IST, AEST, AEDT, ACST, ACDT, AWST, NZST, NZDT, UTC`;
        sections.push(forecastSection);
    }

    if (settings.commands.welcome?.enabled) {
        let welcomeSection = `Send welcome message\n\n`;
        welcomeSection += `${prefix}welcome @Username\n`;
        welcomeSection += `Type @Username in chat (converts to [UserID])\n`;
        welcomeSection += `Admin only: CEO, COO, Management, Interim CEO`;
        sections.push(welcomeSection);
    }

    // Broadcast msg commands - show enabled templates
    if (settings.commands.msg?.enabled) {
        const enabledTemplates = await getEnabledBroadcastTemplates();
        if (enabledTemplates.length > 0) {
            let msgSection = `Broadcast message to alliance (Alliance Chat only)\n\n`;
            for (const tpl of enabledTemplates) {
                msgSection += `${prefix}msg ${tpl.key} (send to all)\n`;
                msgSection += `${prefix}msg ${tpl.key} @Username (send single user)\n\n`;
            }
            sections.push(msgSection.trim());
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
 * @param {Array<string>} args - Command arguments [targetUserId]
 * @param {string} userName - User name of command caller
 */
async function handleWelcomeCommand(args, userName) {
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
        const settingsPath = getSettingsFilePath(botOwnerId);
        const data = await fs.readFile(settingsPath, 'utf8');
        const settings = JSON.parse(data);

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
    const isPkg = !!process.pkg;
    return isPkg
        ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'broadcast-templates')
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
 * Format: !msg <templateKey> or !msg <templateKey> [userID]
 * UserID MUST be in square brackets to send to single user
 *
 * @param {Array<string>} args - Command arguments [templateKey, [userID]]
 * @param {string} userId - User ID of command caller
 * @param {string} userName - User name
 * @param {object} config - Command configuration
 * @param {boolean} isDM - Whether command came from DM
 */
async function handleMsgCommand(args, userId, userName, config, isDM) {
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

    // Check for optional [userID] in square brackets
    let targetUserId = null;
    if (args.length >= 2) {
        const userIdArg = args[1];
        // MUST be in square brackets: [12345]
        const bracketMatch = userIdArg.match(/^\[(\d+)\]$/);
        if (bracketMatch) {
            targetUserId = parseInt(bracketMatch[1]);
        } else {
            // If second argument exists but is not in brackets, ignore the command
            logger.debug(`[ChatBot] msg command: userID must be in brackets [userID], got: ${userIdArg}`);
            return;
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

    if (!template.enabled) {
        logger.debug(`[ChatBot] msg command: template "${templateKey}" is disabled`);
        return;
    }

    // Get recipients
    let recipients = [];
    const membersResponse = await apiCall('/alliance/get-alliance-members', 'POST', {});
    const members = membersResponse?.data?.members || membersResponse?.members || [];

    if (targetUserId) {
        // Single user mode
        const targetMember = members.find(m => m.user_id === targetUserId);
        if (targetMember) {
            recipients = [targetMember];
        } else {
            recipients = [{ user_id: targetUserId, company_name: `User ${targetUserId}` }];
        }
        logger.info(`[ChatBot] Sending msg "${templateKey}" to user ${targetUserId} (triggered by ${userName})`);
    } else {
        // Broadcast to all alliance members (exclude self = bot owner)
        recipients = members.filter(m => m.user_id !== parseInt(botOwnerId));
        logger.info(`[ChatBot] Broadcasting msg "${templateKey}" to ${recipients.length} members (triggered by ${userName})`);
    }

    if (recipients.length === 0) {
        logger.debug('[ChatBot] msg command: no recipients');
        return;
    }

    // Send to each recipient
    const { sendPrivateMessage } = require('./sender');
    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
        try {
            await sendPrivateMessage(recipient.user_id, template.subject, template.message);
            sent++;

            // Delay between messages to avoid rate limiting
            // Game API may silently drop messages if sent too fast
            if (recipients.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (err) {
            failed++;
            logger.warn(`[ChatBot] Failed to send msg to ${recipient.company_name}: ${err.message}`);
        }
    }

    logger.info(`[ChatBot] msg "${templateKey}" complete: ${sent} sent, ${failed} failed`);
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
