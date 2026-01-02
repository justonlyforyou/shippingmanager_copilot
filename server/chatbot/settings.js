/**
 * @fileoverview ChatBot Settings Manager Module
 *
 * Handles loading, mapping, and updating ChatBot settings.
 * Settings are stored in per-user settings files with flat keys.
 *
 * @module server/chatbot/settings
 */

const { getUserId, apiCall } = require('../utils/api');
const db = require('../database');
const logger = require('../utils/logger');

/**
 * Check if user has management role in alliance (CEO, COO, Management, Interim CEO)
 * @param {number} userId - User ID to check
 * @returns {Promise<boolean>} True if user has management role
 */
async function hasManagementRole(userId) {
    try {
        const response = await apiCall('/alliance/get-alliance-members', 'POST', {});
        const members = response?.data?.members || response?.members || [];
        const member = members.find(m => m.user_id === userId);
        const role = member?.role || 'member';
        const allowedRoles = ['ceo', 'coo', 'management', 'interim_ceo'];
        return allowedRoles.includes(role);
    } catch (error) {
        logger.debug('[ChatBot] Error checking management role:', error);
        return false; // Fail-secure: deny access on error
    }
}

/**
 * Load settings from database for user
 * @returns {Promise<object>} ChatBot settings object
 */
async function loadSettings() {
    try {
        const userId = getUserId();
        if (!userId) {
            logger.error('[ChatBot] No user ID available');
            return getDefaultChatBotObject();
        }

        const allSettings = db.getUserSettings(userId);
        if (!allSettings) {
            logger.debug('[ChatBot] No settings found in database, using defaults');
            return getDefaultChatBotObject();
        }

        // Check if user has management role
        const isManagement = await hasManagementRole(userId);

        // Map per-user settings to chatbot settings object
        const chatbotSettings = mapSettingsToChatBotObject(allSettings, isManagement);
        logger.debug('[ChatBot] Settings loaded from database');
        return chatbotSettings;
    } catch (error) {
        logger.error('[ChatBot] Error loading settings:', error);
        return getDefaultChatBotObject();
    }
}

/**
 * Map per-user settings to chatbot settings object
 * @param {object} settings - Flat per-user settings
 * @param {boolean} isManagement - Whether user has management role (CEO, COO, Management, Interim CEO)
 * @returns {object} Nested ChatBot settings object
 */
function mapSettingsToChatBotObject(settings, isManagement = false) {
    // Welcome command: MUST be disabled if user is not management, regardless of saved setting
    const welcomeEnabled = isManagement && (settings.chatbotWelcomeCommandEnabled === true);

    return {
        enabled: settings.chatbotEnabled || false,
        commandPrefix: settings.chatbotPrefix || '!',
        allianceCommands: {
            enabled: settings.chatbotAllianceCommandsEnabled || false,
            cooldownSeconds: settings.chatbotCooldownSeconds || 30
        },
        commands: {
            forecast: {
                enabled: settings.chatbotForecastCommandEnabled || false,
                responseType: 'dm',
                adminOnly: false,
                aliases: settings.chatbotForecastAliases || ['prices', 'price']
            },
            help: {
                enabled: settings.chatbotHelpCommandEnabled || false,
                responseType: 'dm',
                adminOnly: false,
                aliases: settings.chatbotHelpAliases || ['commands', 'help']
            },
            welcome: {
                enabled: welcomeEnabled, // Only enabled if user is management AND setting is true
                responseType: 'dm',
                adminOnly: true, // Requires management role (CEO, COO, Management, Interim CEO)
                aliases: []
            },
            msg: {
                enabled: settings.chatbotMsgCommandEnabled !== false, // Enabled by default
                responseType: 'none', // No response - just sends the broadcast
                adminOnly: false, // Anyone in alliance can use
                allianceOnly: true, // ONLY works in alliance chat, NEVER in DMs
                aliases: ['broadcast']
            }
        },
        scheduledMessages: {
            dailyForecast: {
                enabled: settings.chatbotDailyForecastEnabled || false,
                timeUTC: settings.chatbotDailyForecastTime || '18:00',
                dayOffset: 1 // 1 = tomorrow
            }
        },
        dmCommands: {
            enabled: settings.chatbotDMCommandsEnabled || false
        },
        customCommands: settings.chatbotCustomCommands || []
    };
}

/**
 * Get default chat bot settings object
 * @returns {object} Default ChatBot settings
 */
function getDefaultChatBotObject() {
    return {
        enabled: false,
        commandPrefix: '!',
        allianceCommands: {
            enabled: true,
            cooldownSeconds: 30
        },
        commands: {
            forecast: {
                enabled: true,
                responseType: 'dm',
                adminOnly: false
            },
            help: {
                enabled: true,
                responseType: 'dm',
                adminOnly: false
            },
            welcome: {
                enabled: true,
                responseType: 'dm',
                adminOnly: true
            }
        },
        scheduledMessages: {
            dailyForecast: {
                enabled: false,
                timeUTC: '18:00',
                dayOffset: 1 // 1 = tomorrow
            }
        },
        dmCommands: {
            enabled: false
        },
        customCommands: []
    };
}

/**
 * Map ChatBot object to flat per-user settings keys
 * This is the reverse operation of mapSettingsToChatBotObject()
 * @param {object} chatbotSettings - Nested ChatBot settings object
 * @returns {object} Flat settings keys for per-user settings file
 */
function mapChatBotObjectToFlatSettings(chatbotSettings) {
    const flatSettings = {};

    flatSettings.chatbotEnabled = chatbotSettings.enabled || false;
    flatSettings.chatbotPrefix = chatbotSettings.commandPrefix || '!';

    if (chatbotSettings.allianceCommands) {
        flatSettings.chatbotAllianceCommandsEnabled = chatbotSettings.allianceCommands.enabled || false;
        flatSettings.chatbotCooldownSeconds = chatbotSettings.allianceCommands.cooldownSeconds || 30;
    }

    if (chatbotSettings.commands?.forecast) {
        flatSettings.chatbotForecastCommandEnabled = chatbotSettings.commands.forecast.enabled || false;
    }

    if (chatbotSettings.commands?.help) {
        flatSettings.chatbotHelpCommandEnabled = chatbotSettings.commands.help.enabled || false;
    }

    if (chatbotSettings.scheduledMessages?.dailyForecast) {
        flatSettings.chatbotDailyForecastEnabled = chatbotSettings.scheduledMessages.dailyForecast.enabled || false;
        flatSettings.chatbotDailyForecastTime = chatbotSettings.scheduledMessages.dailyForecast.timeUTC || '18:00';
    }

    if (chatbotSettings.dmCommands) {
        flatSettings.chatbotDMCommandsEnabled = chatbotSettings.dmCommands.enabled || false;
    }

    flatSettings.chatbotCustomCommands = chatbotSettings.customCommands || [];

    return flatSettings;
}

/**
 * Update settings from frontend
 * Settings are saved to database using flat keys
 * @param {object} newSettings - New ChatBot settings (partial or full)
 * @param {object} currentSettings - Current ChatBot settings
 * @returns {Promise<object>} Updated ChatBot settings
 */
async function updateSettings(newSettings, currentSettings) {
    // Merge new settings into current settings
    const mergedSettings = { ...currentSettings, ...newSettings };

    try {
        const userId = getUserId();
        if (!userId) {
            logger.error('[ChatBot] Cannot update settings: No user ID available');
            return mergedSettings;
        }

        // Read current settings from database
        const allSettings = db.getUserSettings(userId) || {};

        // Map ChatBot's nested structure to flat keys
        const flatChatBotSettings = mapChatBotObjectToFlatSettings(mergedSettings);

        // Merge flat ChatBot keys into settings
        Object.assign(allSettings, flatChatBotSettings);

        // Save updated settings to database
        db.saveUserSettings(userId, allSettings);

        logger.debug('[ChatBot] Settings updated in database');

        return mergedSettings;
    } catch (error) {
        logger.error('[ChatBot] Error updating settings:', error);
        return mergedSettings;
    }
}

module.exports = {
    loadSettings,
    mapSettingsToChatBotObject,
    getDefaultChatBotObject,
    mapChatBotObjectToFlatSettings,
    updateSettings
};
