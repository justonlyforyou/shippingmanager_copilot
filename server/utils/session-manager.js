/**
 * @fileoverview Secure Session Manager
 *
 * Manages user sessions with encrypted storage of sensitive cookies.
 * Sessions are stored in sessions.json but cookies are encrypted using OS-native storage.
 *
 * Features:
 * - Automatic encryption of session cookies
 * - Platform-independent (Windows/macOS/Linux)
 * - Migration of old plaintext sessions
 * - Session validation
 *
 * @module server/utils/session-manager
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { encryptData, decryptData, isEncrypted } = require('./encryption');
const logger = require('./logger');

/**
 * Get sessions file path based on execution mode
 * @returns {string} Path to sessions.json
 */
function getSessionsPath() {
    const { getAppBaseDir } = require('../config');

    // Check if running from installed location (AppData)
    const appDataBase = getAppBaseDir();
    const isInstalled = process.execPath.toLowerCase().includes('appdata') ||
                        process.execPath.toLowerCase().includes('shippingmanagercopilot');

    if (isInstalled) {
        return path.join(appDataBase, 'userdata', 'settings', 'sessions.json');
    }

    // Development: use project folder
    return path.join(__dirname, '..', '..', 'userdata', 'settings', 'sessions.json');
}

/**
 * Load all sessions from file
 *
 * @returns {Promise<Object>} Sessions object with user IDs as keys
 */
async function loadSessions() {
    const sessionsFile = getSessionsPath();
    logger.debug(`[SessionManager] Loading sessions from: ${sessionsFile}`);
    try {
        const data = await fs.readFile(sessionsFile, 'utf8');
        const sessions = JSON.parse(data);
        logger.debug(`[SessionManager] Loaded ${Object.keys(sessions).length} session(s)`);
        return sessions;
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist yet
            logger.warn(`[SessionManager] Sessions file not found: ${sessionsFile}`);
            return {};
        }
        logger.error('[SessionManager] Error loading sessions:', error);
        return {};
    }
}

/**
 * Load all available sessions (Python and Node.js now use same file)
 *
 * @returns {Promise<Object>} Sessions object
 */
async function loadAllSessions() {
    // Both Python and Node.js now use the same sessions.json
    return await loadSessions();
}

/**
 * Get all available sessions with decrypted cookies
 *
 * @returns {Promise<Array>} Array of {userId, cookie, companyName, loginMethod, timestamp}
 */
async function getAvailableSessions() {
    const sessions = await loadAllSessions();
    const available = [];

    for (const userId of Object.keys(sessions)) {
        try {
            const session = await getSession(userId);
            if (session && session.cookie) {
                // Load app_platform and app_version if available
                let appPlatform = null;
                let appVersion = null;

                if (session.app_platform && isEncrypted(session.app_platform)) {
                    const accountName = `app_platform_${userId}`;
                    appPlatform = await decryptData(session.app_platform, accountName);
                }

                if (session.app_version && isEncrypted(session.app_version)) {
                    const accountName = `app_version_${userId}`;
                    appVersion = await decryptData(session.app_version, accountName);
                }

                // Handle both old format (timestamp as Unix) and new format (last_updated as ISO)
                let timestamp = session.timestamp;
                if (!timestamp && session.last_updated) {
                    timestamp = Math.floor(new Date(session.last_updated).getTime() / 1000);
                }

                available.push({
                    userId: String(session.user_id || userId),
                    cookie: session.cookie,
                    appPlatform: appPlatform,
                    appVersion: appVersion,
                    companyName: session.company_name || 'Unknown',
                    loginMethod: session.login_method || 'unknown',
                    timestamp: timestamp,
                    autostart: session.autostart !== false  // Default true for backwards compatibility
                });
            }
        } catch (error) {
            logger.error(`[SessionManager] Failed to decrypt session for user ${userId}:`, error);
        }
    }

    // Sort by timestamp (most recent first)
    available.sort((a, b) => b.timestamp - a.timestamp);

    return available;
}

/**
 * Save sessions to file
 *
 * @param {Object} sessions - Sessions object to save
 * @returns {Promise<void>}
 */
async function saveSessions(sessions) {
    const sessionsFile = getSessionsPath();
    try {
        // Ensure directory exists
        const dir = path.dirname(sessionsFile);
        await fs.mkdir(dir, { recursive: true });

        await fs.writeFile(
            sessionsFile,
            JSON.stringify(sessions, null, 2),
            'utf8'
        );
    } catch (error) {
        logger.error('[SessionManager] Error saving sessions:', error);
        throw error;
    }
}

/**
 * Get session for a specific user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<Object|null>} Session object with decrypted cookie, or null if not found
 */
async function getSession(userId) {
    const sessions = await loadAllSessions();  // Load from both locations
    const session = sessions[String(userId)];

    if (!session) {
        return null;
    }

    // Support both old format (cookie) and new format (encrypted_cookie)
    const encryptedCookie = session.cookie || session.encrypted_cookie;

    // Decrypt cookie if encrypted
    if (encryptedCookie && isEncrypted(encryptedCookie)) {
        const accountName = `session_${userId}`;
        const decryptedCookie = await decryptData(encryptedCookie, accountName);

        if (!decryptedCookie) {
            logger.error(`[SessionManager] Failed to decrypt session for user ${userId}`);
            return null;
        }

        return {
            ...session,
            cookie: decryptedCookie
        };
    }

    // Return as-is if not encrypted (for backward compatibility during migration)
    return {
        ...session,
        cookie: encryptedCookie
    };
}

/**
 * Save or update session for a user
 *
 * @param {string|number} userId - User ID
 * @param {string} cookie - Session cookie (will be encrypted)
 * @param {string} companyName - Company name
 * @param {string} loginMethod - Login method used ('steam', 'firefox', 'chrome', etc.)
 * @returns {Promise<void>}
 */
async function saveSession(userId, cookie, companyName, loginMethod) {
    const sessions = await loadSessions();
    const accountName = `session_${userId}`;

    // Encrypt the cookie
    const encryptedCookie = await encryptData(cookie, accountName);

    // Store session with encrypted cookie
    sessions[String(userId)] = {
        cookie: encryptedCookie,
        timestamp: Math.floor(Date.now() / 1000),
        company_name: companyName,
        login_method: loginMethod
    };

    await saveSessions(sessions);

    logger.debug(`[SessionManager] Saved encrypted session for user ${userId} (${companyName})`);
}

/**
 * Delete session for a user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<boolean>} True if session was deleted
 */
async function deleteSession(userId) {
    const sessions = await loadSessions();

    if (!sessions[String(userId)]) {
        return false;
    }

    delete sessions[String(userId)];
    await saveSessions(sessions);

    logger.debug(`[SessionManager] Deleted session for user ${userId}`);
    return true;
}

/**
 * Get all user IDs that have sessions
 *
 * @returns {Promise<string[]>} Array of user IDs
 */
async function getAllUserIds() {
    const sessions = await loadAllSessions();  // Load from both locations
    return Object.keys(sessions);
}

/**
 * Migrate plaintext sessions to encrypted format
 * This should be called once during upgrade
 *
 * @returns {Promise<number>} Number of sessions migrated
 */
async function migrateToEncrypted() {
    logger.debug('[SessionManager] Starting session migration...');

    const sessions = await loadSessions();
    let migratedCount = 0;

    for (const [userId, session] of Object.entries(sessions)) {
        if (session.cookie && !isEncrypted(session.cookie)) {
            logger.debug(`[SessionManager] Migrating session for user ${userId}...`);

            const accountName = `session_${userId}`;
            const encryptedCookie = await encryptData(session.cookie, accountName);

            sessions[userId] = {
                ...session,
                cookie: encryptedCookie
            };

            migratedCount++;
        }
    }

    if (migratedCount > 0) {
        await saveSessions(sessions);
        logger.debug(`[SessionManager] OK Migrated ${migratedCount} session(s) to encrypted format`);
    } else {
        logger.debug('[SessionManager] No sessions needed migration');
    }

    return migratedCount;
}

/**
 * Check if a session exists for a user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<boolean>} True if session exists
 */
async function hasSession(userId) {
    const sessions = await loadAllSessions();  // Load from both locations
    return !!sessions[String(userId)];
}

/**
 * Set autostart preference for a session
 *
 * @param {string|number} userId - User ID
 * @param {boolean} autostart - Whether to autostart this session
 * @returns {Promise<boolean>} True if updated successfully
 */
async function setAutostart(userId, autostart) {
    const sessions = await loadSessions();
    const userIdStr = String(userId);

    if (!sessions[userIdStr]) {
        logger.warn(`[SessionManager] Cannot set autostart - session not found for user ${userId}`);
        return false;
    }

    sessions[userIdStr].autostart = autostart;
    await saveSessions(sessions);

    logger.debug(`[SessionManager] Set autostart=${autostart} for user ${userId}`);
    return true;
}

/**
 * Validate a session cookie by making an API call to the game server
 *
 * @param {string} cookie - Session cookie to validate
 * @returns {Promise<object|null>} User data {userId, companyName} if valid, null if invalid/expired
 */
function validateSessionCookie(cookie) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'shippingmanager.cc',
            port: 443,
            path: '/api/user/get-user-settings',
            method: 'GET',
            headers: {
                'Cookie': `shipping_manager_session=${cookie}`,
                'Accept': 'application/json'
            },
            rejectUnauthorized: true
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.user && json.user.id) {
                        resolve({
                            userId: json.user.id,
                            companyName: json.user.company_name || json.user.name || 'Unknown'
                        });
                    } else {
                        resolve(null);
                    }
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => {
            req.destroy();
            resolve(null);
        });

        req.end();
    });
}

/**
 * Get the first valid session from stored sessions
 * Validates each session against the game API and returns the first one that works
 *
 * @param {Function} [logFn] - Optional logging function (receives level and message)
 * @returns {Promise<object|null>} First valid session or null if none valid
 */
async function getFirstValidSession(logFn) {
    const log = logFn || ((level, msg) => logger[level](`[SessionManager] ${msg}`));

    const availableSessions = await getAvailableSessions();

    if (availableSessions.length === 0) {
        return null;
    }

    log('info', `Found ${availableSessions.length} stored session(s), validating...`);

    for (const session of availableSessions) {
        log('debug', `Validating session for ${session.companyName} (${session.userId})...`);
        const validation = await validateSessionCookie(session.cookie);

        if (validation) {
            log('info', `Valid session: ${session.companyName} (${session.userId})`);
            return session;
        } else {
            log('warn', `Session expired or invalid: ${session.companyName} (${session.userId})`);
        }
    }

    return null;
}

module.exports = {
    getSession,
    saveSession,
    deleteSession,
    getAllUserIds,
    hasSession,
    migrateToEncrypted,
    getAvailableSessions,
    setAutostart,
    validateSessionCookie,
    getFirstValidSession
};
