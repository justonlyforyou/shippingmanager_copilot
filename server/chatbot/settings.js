/**
 * @fileoverview ChatBot Settings Manager Module
 *
 * Handles loading, mapping, and updating ChatBot settings.
 * Settings are stored in per-user settings files with flat keys.
 *
 * @module server/chatbot/settings
 */

const fs = require('fs').promises;
const { getUserId } = require('../utils/api');
const { getSettingsFilePath } = require('../settings-schema');
const logger = require('../utils/logger');

/**
 * Load settings from per-user settings file (settings-{userId}.json)
 * @returns {Promise<object>} ChatBot settings object
 */
async function loadSettings() {
    try {
        const userId = getUserId();
        if (!userId) {
            logger.error('[ChatBot] No user ID available');
            return getDefaultChatBotObject();
        }

        const settingsPath = getSettingsFilePath(userId);
        const data = await fs.readFile(settingsPath, 'utf8');
        const allSettings = JSON.parse(data);

        // Map per-user settings to chatbot settings object
        const chatbotSettings = mapSettingsToChatBotObject(allSettings);
        logger.debug('[ChatBot] Settings loaded');
        return chatbotSettings;
    } catch (error) {
        logger.error('[ChatBot] Error loading settings:', error);
        return getDefaultChatBotObject();
    }
}

/**
 * Map per-user settings to chatbot settings object
 * @param {object} settings - Flat per-user settings
 * @returns {object} Nested ChatBot settings object
 */
function mapSettingsToChatBotObject(settings) {
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
 * Settings are saved to per-user settings file using flat keys
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

        // Get per-user settings file path
        const settingsPath = getSettingsFilePath(userId);

        // Read current per-user settings
        const data = await fs.readFile(settingsPath, 'utf8');
        const allSettings = JSON.parse(data);

        // Map ChatBot's nested structure to flat keys
        const flatChatBotSettings = mapChatBotObjectToFlatSettings(mergedSettings);

        // Merge flat ChatBot keys into per-user settings
        Object.assign(allSettings, flatChatBotSettings);

        // Save updated per-user settings
        await fs.writeFile(settingsPath, JSON.stringify(allSettings, null, 2), 'utf8');

        logger.debug('[ChatBot] Settings updated successfully');

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
