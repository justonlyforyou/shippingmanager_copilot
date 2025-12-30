/**
 * @fileoverview Secure Session Manager
 *
 * Manages user sessions with encrypted storage of sensitive cookies.
 * Sessions are stored in SQLite database with cookies encrypted using OS-native storage.
 *
 * Features:
 * - Automatic encryption of session cookies
 * - Platform-independent (Windows/macOS/Linux)
 * - SQLite database storage for reliability
 * - Session validation
 *
 * @module server/utils/session-manager
 */

const https = require('https');
const net = require('net');
const { encryptData, decryptData, isEncrypted } = require('./encryption');
const logger = require('./logger');
const db = require('../database');

/**
 * Normalize a session cookie to consistent format (URL-decoded)
 * Handles both URL-encoded (%3D) and raw cookies
 * @param {string} cookie - The cookie value
 * @returns {string} Normalized cookie
 */
function normalizeCookie(cookie) {
    if (!cookie) return cookie;

    if (cookie.includes('%')) {
        try {
            const decoded = decodeURIComponent(cookie);
            logger.debug(`[SessionManager] Cookie was URL-encoded, decoded from ${cookie.length} to ${decoded.length} chars`);
            return decoded;
        } catch {
            logger.debug(`[SessionManager] Cookie contains % but is not URL-encoded`);
            return cookie;
        }
    }

    return cookie;
}

/**
 * Get all available sessions with decrypted cookies
 * IMPORTANT: Always returns ALL stored sessions, even if decryption fails.
 * Sessions with issues will have valid=false so the UI can show them appropriately.
 *
 * @returns {Promise<Array>} Array of session objects
 */
async function getAvailableSessions() {
    const accounts = db.getAllAccounts();
    const available = [];

    for (const account of accounts) {
        let decryptedCookie = null;
        let decryptError = null;

        try {
            if (account.cookie && isEncrypted(account.cookie)) {
                const accountName = `session_${account.userId}`;
                decryptedCookie = await decryptData(account.cookie, accountName);
            } else {
                decryptedCookie = account.cookie;
            }
        } catch (error) {
            logger.error(`[SessionManager] Failed to decrypt session for user ${account.userId}:`, error);
            decryptError = error.message;
        }

        if (decryptedCookie) {
            available.push({
                userId: String(account.userId),
                cookie: decryptedCookie,
                companyName: account.companyName,
                loginMethod: account.loginMethod,
                timestamp: account.timestamp,
                autostart: account.autostart,
                port: account.port,
                valid: true,
                error: null
            });
        } else {
            available.push({
                userId: String(account.userId),
                cookie: null,
                companyName: account.companyName,
                loginMethod: account.loginMethod,
                timestamp: account.timestamp,
                autostart: account.autostart,
                port: account.port,
                valid: false,
                error: decryptError || 'Failed to decrypt session cookie'
            });
            logger.warn(`[SessionManager] Session for ${account.companyName} added with valid=false`);
        }
    }

    // Sort by timestamp (most recent first)
    available.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return available;
}

/**
 * Get session for a specific user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<Object|null>} Session object with decrypted cookie, or null if not found
 */
async function getSession(userId) {
    const account = db.getAccount(String(userId));

    if (!account) {
        return null;
    }

    // Decrypt cookie if encrypted
    if (account.cookie && isEncrypted(account.cookie)) {
        const accountName = `session_${userId}`;
        const decryptedCookie = await decryptData(account.cookie, accountName);

        if (!decryptedCookie) {
            logger.error(`[SessionManager] Failed to decrypt session for user ${userId}`);
            return null;
        }

        return {
            user_id: account.userId,
            cookie: decryptedCookie,
            company_name: account.companyName,
            login_method: account.loginMethod,
            timestamp: account.timestamp,
            autostart: account.autostart,
            port: account.port
        };
    }

    return {
        user_id: account.userId,
        cookie: account.cookie,
        company_name: account.companyName,
        login_method: account.loginMethod,
        timestamp: account.timestamp,
        autostart: account.autostart,
        port: account.port
    };
}

/**
 * Save or update session for a user
 *
 * @param {string|number} userId - User ID
 * @param {string} cookie - Session cookie (will be encrypted)
 * @param {string} companyName - Company name
 * @param {string} loginMethod - Login method used ('steam', 'browser', etc.)
 * @returns {Promise<void>}
 */
async function saveSession(userId, cookie, companyName, loginMethod) {
    const userIdStr = String(userId);
    const accountName = `session_${userId}`;

    // Normalize cookie (ensure consistent format - always URL-decoded)
    const normalizedCookie = normalizeCookie(cookie);

    // Encrypt the cookie
    const encryptedCookie = await encryptData(normalizedCookie, accountName);

    // Get existing account to preserve settings (port, autostart)
    const existingAccount = db.getAccount(userIdStr);

    // Save to database - preserve port and autostart if they exist
    db.saveAccount(userIdStr, {
        companyName: companyName,
        cookie: encryptedCookie,
        loginMethod: loginMethod,
        port: existingAccount?.port || db.findNextAvailablePort(12345),
        autostart: existingAccount?.autostart !== false,
        timestamp: Math.floor(Date.now() / 1000)
    });

    logger.info(`[SessionManager] Saved session for ${companyName} - port=${existingAccount?.port}`);
}

/**
 * Delete session for a user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<boolean>} True if session was deleted
 */
async function deleteSession(userId) {
    const result = db.deleteAccount(String(userId));
    if (result) {
        logger.debug(`[SessionManager] Deleted session for user ${userId}`);
    }
    return result;
}

/**
 * Get all user IDs that have sessions
 *
 * @returns {Promise<string[]>} Array of user IDs
 */
async function getAllUserIds() {
    const accounts = db.getAllAccounts();
    return accounts.map(a => a.userId);
}

/**
 * Check if a session exists for a user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<boolean>} True if session exists
 */
async function hasSession(userId) {
    const account = db.getAccount(String(userId));
    return !!account;
}

/**
 * Set autostart preference for a session
 *
 * @param {string|number} userId - User ID
 * @param {boolean} autostart - Whether to autostart this session
 * @returns {Promise<boolean>} True if updated successfully
 */
async function setAutostart(userId, autostart) {
    const result = db.setAccountAutostart(String(userId), autostart);
    if (result) {
        logger.debug(`[SessionManager] Set autostart=${autostart} for user ${userId}`);
    }
    return result;
}

/**
 * Check if a port is available on the system
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is available
 */
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false);
            } else {
                resolve(true);
            }
        });
        server.once('listening', () => {
            server.close(() => {
                resolve(true);
            });
        });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * Find the next available port starting from basePort
 * Checks both database AND system port availability
 * @param {number} basePort - Starting port number
 * @param {string|number} [excludeUserId] - User ID to exclude from check (for updates)
 * @returns {Promise<number>} First available port
 */
async function findAvailablePort(basePort, _excludeUserId) {
    // Get next port not used in database
    let port = db.findNextAvailablePort(basePort);

    // Also verify it's free on the system
    while (true) {
        const available = await isPortAvailable(port);
        if (available) {
            return port;
        }
        logger.debug(`[SessionManager] Port ${port} in use on system, trying next`);
        port++;
    }
}

/**
 * Set port for a session
 *
 * @param {string|number} userId - User ID
 * @param {number} port - Port number to use for this session
 * @returns {Promise<boolean>} True if updated successfully
 */
async function setPort(userId, port) {
    const result = db.setAccountPort(String(userId), port);
    if (result) {
        logger.info(`[SessionManager] Set port=${port} for user ${userId}`);
    }
    return result;
}

/**
 * Validate a session cookie by making an API call to the game server
 *
 * @param {string} cookie - Session cookie to validate
 * @returns {Promise<object|null>} User data {userId, companyName} if valid, null if invalid/expired
 */
function validateSessionCookie(cookie) {
    // Normalize cookie first (decode URL-encoded cookies)
    const normalizedCookie = normalizeCookie(cookie);

    return new Promise((resolve) => {
        const options = {
            hostname: 'shippingmanager.cc',
            port: 443,
            path: '/api/user/get-user-settings',
            method: 'GET',
            headers: {
                'Cookie': `shipping_manager_session=${normalizedCookie}`,
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

/**
 * Migration function - no longer needed as we use database
 * Kept for backwards compatibility
 * @returns {Promise<number>} Always returns 0
 */
async function migrateToEncrypted() {
    logger.debug('[SessionManager] Migration not needed - using database');
    return 0;
}

/**
 * Migrate all existing cookies to normalized format (URL-decoded)
 * This fixes cookies that were stored with %3D instead of =
 * @returns {Promise<number>} Number of cookies migrated
 */
async function migrateToNormalizedCookies() {
    const accounts = db.getAllAccounts();
    let migrated = 0;

    for (const account of accounts) {
        try {
            // Decrypt current cookie
            let decryptedCookie = null;
            if (account.cookie && isEncrypted(account.cookie)) {
                const accountName = `session_${account.userId}`;
                decryptedCookie = await decryptData(account.cookie, accountName);
            } else {
                decryptedCookie = account.cookie;
            }

            if (!decryptedCookie) {
                continue;
            }

            // Check if cookie needs normalization
            if (decryptedCookie.includes('%3D') || decryptedCookie.includes('%')) {
                const normalizedCookie = normalizeCookie(decryptedCookie);

                if (normalizedCookie !== decryptedCookie) {
                    logger.info(`[SessionManager] Migrating cookie for ${account.companyName}: URL-encoded -> decoded`);

                    // Re-encrypt and save normalized cookie
                    const accountName = `session_${account.userId}`;
                    const encryptedCookie = await encryptData(normalizedCookie, accountName);

                    db.saveAccount(account.userId, {
                        companyName: account.companyName,
                        cookie: encryptedCookie,
                        loginMethod: account.loginMethod,
                        port: account.port,
                        autostart: account.autostart,
                        timestamp: account.timestamp
                    });

                    migrated++;
                }
            }
        } catch (error) {
            logger.error(`[SessionManager] Failed to migrate cookie for ${account.userId}: ${error.message}`);
        }
    }

    if (migrated > 0) {
        logger.info(`[SessionManager] Migrated ${migrated} cookie(s) to normalized format`);
    }

    return migrated;
}

module.exports = {
    getSession,
    saveSession,
    deleteSession,
    getAllUserIds,
    hasSession,
    migrateToEncrypted,
    migrateToNormalizedCookies,
    getAvailableSessions,
    setAutostart,
    setPort,
    isPortAvailable,
    findAvailablePort,
    validateSessionCookie,
    getFirstValidSession,
    normalizeCookie
};
