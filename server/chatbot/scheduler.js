/**
 * @fileoverview ChatBot Scheduler Module
 *
 * Handles scheduled task management (daily forecasts, etc.).
 *
 * @module server/chatbot/scheduler
 */

const { getUserId } = require('../utils/api');
const { broadcastToUser, triggerImmediateChatRefresh } = require('../websocket');
const logger = require('../utils/logger');

/**
 * Setup scheduled tasks
 * @param {object} settings - ChatBot settings
 * @param {Map} scheduledTasksMap - Map of scheduled tasks (taskId -> timeout)
 * @param {object} callbacks - Callback functions { generateForecastText, sendAllianceMessage }
 */
function setupScheduledTasks(settings, scheduledTasksMap, callbacks) {
    // Clear existing tasks
    for (const timeout of scheduledTasksMap.values()) {
        clearTimeout(timeout);
    }
    scheduledTasksMap.clear();

    // Setup daily forecast
    if (settings.scheduledMessages?.dailyForecast?.enabled) {
        scheduleDailyForecast(settings, scheduledTasksMap, callbacks);
    }
}

/**
 * Schedule daily forecast message
 * Uses LOCAL server time, not UTC
 * @param {object} settings - ChatBot settings
 * @param {Map} scheduledTasksMap - Map of scheduled tasks
 * @param {object} callbacks - Callback functions
 */
function scheduleDailyForecast(settings, scheduledTasksMap, callbacks) {
    const config = settings.scheduledMessages.dailyForecast;
    const [hours, minutes] = config.timeUTC.split(':').map(Number);

    const now = new Date();
    const scheduledTime = new Date();

    // Use LOCAL time instead of UTC
    scheduledTime.setHours(hours, minutes, 0, 0);

    // If time has passed today, schedule for tomorrow
    if (scheduledTime <= now) {
        scheduledTime.setDate(scheduledTime.getDate() + 1);
    }

    const msUntilScheduled = scheduledTime - now;

    // Log the scheduled time in local timezone for debugging
    logger.debug(`[ChatBot] Daily forecast scheduled for: ${scheduledTime.toLocaleString('de-DE')} (in ${Math.round(msUntilScheduled / 1000 / 60)} minutes)`);

    const timeout = setTimeout(async () => {
        await sendDailyForecast(settings, callbacks);
        // Reschedule for next day
        scheduleDailyForecast(settings, scheduledTasksMap, callbacks);
    }, msUntilScheduled);

    scheduledTasksMap.set('dailyForecast', timeout);
}

/**
 * Send daily forecast message
 * @param {object} settings - ChatBot settings
 * @param {object} callbacks - Callback functions { generateForecastText, sendAllianceMessage }
 */
async function sendDailyForecast(settings, callbacks) {
    const { generateForecastText, sendAllianceMessage } = callbacks;

    try {
        // Determine timezone based on current date
        const now = new Date();
        const month = now.getMonth(); // 0-11
        const isEuropeSummer = month >= 3 && month <= 9; // April to October
        const timezone = isEuropeSummer ? 'CEST' : 'CET';

        const tomorrow = now.getDate() + 1;
        const forecastText = await generateForecastText(tomorrow, timezone);
        await sendAllianceMessage(forecastText);

        // Broadcast success notification to all connected clients
        const userId = getUserId();
        if (broadcastToUser && userId) {
            logger.debug('[ChatBot] OK Daily forecast sent successfully to alliance chat');
            broadcastToUser(userId, 'user_action_notification', {
                type: 'success',
                message: `📊 <strong>Daily Forecast Posted</strong><br><br>Tomorrow's forecast has been automatically posted to alliance chat at ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
            });
        }

        // Trigger immediate chat refresh so the message appears in UI
        if (triggerImmediateChatRefresh) {
            triggerImmediateChatRefresh();
        }
    } catch (error) {
        logger.error('[ChatBot] Failed to send daily forecast:', error);

        // Broadcast error notification
        const userId = getUserId();
        if (broadcastToUser && userId) {
            broadcastToUser(userId, 'user_action_notification', {
                type: 'error',
                message: `📊 <strong>Forecast Posting Failed</strong><br><br>Could not post daily forecast: ${error.message}`
            });
        }
    }
}

module.exports = {
    setupScheduledTasks,
    scheduleDailyForecast,
    sendDailyForecast
};
