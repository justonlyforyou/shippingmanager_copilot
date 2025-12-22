/**
 * @fileoverview Cross-Platform Encryption Utility
 *
 * Provides secure storage for sensitive data using OS-native credential storage:
 * - Windows: DPAPI (Data Protection API)
 * - macOS: Keychain
 * - Linux: libsecret (Secret Service API)
 *
 * Uses 'keytar' package which abstracts the platform-specific implementations.
 *
 * Security Features:
 * - Data is encrypted with OS user account credentials
 * - Only the same user on the same machine can decrypt
 * - No master password needed (uses OS authentication)
 * - If file is copied to another machine, data is useless
 * - NO FALLBACK ENCRYPTION - keytar is required
 *
 * Known Issues & Workarounds:
 * - Python/Node.js keyring incompatibility on Windows: Python's keyring library stores
 *   credentials as UTF-16, creating null bytes between characters when read by Node.js
 *   keytar (which expects UTF-8). The decryptData() function includes automatic detection
 *   and removal of these null bytes. This affects sessions saved by Python (browser login)
 *   but not sessions saved differently (Steam login).
 *
 * @module server/utils/encryption
 */

const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const logger = require('./logger');

// Try to load keytar - required for secure credential storage
// SEA: __dirname = directory containing executable, keytar is at node_modules/keytar next to exe
let keytar;
try {
    keytar = require('keytar');
    logger.debug('[Encryption] Using native OS credential storage (keytar)');
} catch {
    // SEA build: use createRequire from exe directory (__dirname in SEA = exe dir)
    try {
        const keytarPath = path.join(__dirname, 'node_modules', 'keytar');
        logger.debug('[Encryption] Trying to load keytar from: ' + keytarPath);
        
        const exeRequire = createRequire(path.join(__dirname, 'package.json'));
        keytar = exeRequire('keytar');
        logger.debug('[Encryption] Loaded keytar from: ' + keytarPath);
    } catch (seaErr) {
        logger.error('[Encryption] keytar not available - secure credential storage unavailable');
        logger.debug('[Encryption] SEA load error: ' + seaErr.message);
        logger.debug('[Encryption] __dirname: ' + __dirname);
        keytar = null;
    }
}

/**
 * Service name used for keytar credential storage
 * @constant {string}
 */
const SERVICE_NAME = 'ShippingManagerCoPilot';

/**
 * Encrypt sensitive data using OS-native credential storage
 *
 * @param {string} data - Data to encrypt (will be converted to string if not already)
 * @param {string} accountName - Unique identifier for this data (e.g., 'session_1234567')
 * @returns {Promise<string>} Reference to stored credential
 * @throws {Error} If keytar is not available or storage fails
 *
 * @example
 * const encrypted = await encryptData('my-secret-cookie', 'session_12345');
 * // Returns: "KEYRING:session_12345"
 */
async function encryptData(data, accountName) {
    const dataString = String(data);

    if (!keytar) {
        throw new Error('Secure credential storage (keytar) is not available. Please ensure keytar is properly installed.');
    }

    try {
        // Store in OS credential manager
        await keytar.setPassword(SERVICE_NAME, accountName, dataString);

        // Return a marker that indicates data is in keyring
        return `KEYRING:${accountName}`;
    } catch (error) {
        logger.error(`[Encryption] Failed to store in keyring: ${error.message}`);
        throw new Error(`Failed to encrypt data: ${error.message}`);
    }
}

/**
 * Decrypt data that was encrypted with encryptData()
 *
 * Handles two storage formats:
 * 1. OS keyring (KEYRING:account_name) - Uses Windows DPAPI/macOS Keychain/Linux libsecret
 * 2. Plaintext (legacy) - For migration from older versions
 *
 * IMPORTANT: This function includes a workaround for Python/Node.js keyring incompatibility.
 * Python's keyring library stores credentials as UTF-16 on Windows, which creates null bytes (0x00)
 * between each character when read by Node.js's keytar library (which expects UTF-8).
 * Example: "eyJpdiI6..." becomes "e\0y\0J\0p\0d\0i\0..." (680 chars instead of 340)
 *
 * The workaround:
 * - Uses findCredentials() instead of getPassword() (which returns null for UTF-16 entries)
 * - Detects UTF-16 encoding by checking for null bytes at every 2nd position
 * - Removes null bytes by filtering to even-indexed characters only
 *
 * This affects browser sessions saved by Python but not Steam sessions (saved differently).
 *
 * @param {string} encryptedData - Encrypted data string from encryptData()
 * @returns {Promise<string|null>} Decrypted data or null if decryption fails
 *
 * @example
 * const decrypted = await decryptData('KEYRING:session_12345');
 * // Returns: 'my-secret-cookie' or null
 *
 * @example
 * // UTF-16 workaround automatically applied:
 * // Input from keyring: "e\0y\0J\0..." (680 chars with null bytes)
 * // Output: "eyJ..." (340 chars, null bytes removed)
 */
async function decryptData(encryptedData) {
    if (!encryptedData) {
        return null;
    }

    // Check if data is in OS keyring
    if (encryptedData.startsWith('KEYRING:')) {
        if (!keytar) {
            logger.error('[Encryption] Data is in keyring but keytar not available');
            return null;
        }

        try {
            const storedAccountName = encryptedData.substring(8); // Remove "KEYRING:" prefix

            // WORKAROUND for Python/Node.js keyring incompatibility:
            // Use findCredentials() instead of getPassword() because getPassword() returns null
            // for UTF-16 encoded entries stored by Python's keyring library.
            // This happens because Python stores as UTF-16 on Windows while Node.js keytar expects UTF-8.
            const credentials = await keytar.findCredentials(SERVICE_NAME);
            const credential = credentials.find(c => c.account === storedAccountName);

            if (!credential) {
                logger.error(`[Encryption] Credential not found for ${storedAccountName}`);
                return null;
            }

            let password = credential.password;

            // WORKAROUND: Fix Python's UTF-16 encoding (creates null bytes between characters)
            // Python's keyring stores "eyJpdiI6..." as "e\0y\0J\0p\0d\0i\0..." (UTF-16 LE)
            // This doubles the length: 340 chars -> 680 chars with null bytes at every odd index
            // Detection: Check if every 2nd character (index 1, 3, 5...) is 0x00
            if (password && password.length > 300 && password.length % 2 === 0) {
                // Sample first 20 characters to check for UTF-16 pattern
                let hasNullBytes = true;
                for (let i = 1; i < Math.min(20, password.length); i += 2) {
                    if (password.charCodeAt(i) !== 0) {
                        hasNullBytes = false;
                        break;
                    }
                }

                if (hasNullBytes) {
                    // Remove null bytes: keep only even-indexed characters (0, 2, 4, 6...)
                    // Example: "e\0y\0J\0" -> "eyJ"
                    const fixed = password.split('').filter((_, i) => i % 2 === 0).join('');
                    logger.info(`[Encryption] Migrating Python UTF-16 credential to UTF-8 (${password.length} to ${fixed.length} chars)`);
                    password = fixed;

                    // Re-save in correct UTF-8 format so this migration only happens once
                    try {
                        await keytar.setPassword(SERVICE_NAME, storedAccountName, fixed);
                        logger.info(`[Encryption] Credential migrated successfully: ${storedAccountName}`);
                    } catch (migrationErr) {
                        logger.error(`[Encryption] Failed to migrate credential: ${migrationErr.message}`);
                    }
                }
            }
            return password;
        } catch (error) {
            logger.error(`[Encryption] Failed to retrieve from keyring: ${error.message}`);
            return null;
        }
    }

    // Legacy fallback format (v1:...) is no longer supported
    if (encryptedData.startsWith('v1:')) {
        logger.error('[Encryption] Legacy fallback encryption format (v1:) is no longer supported. Please re-authenticate.');
        return null;
    }

    // If data doesn't start with known prefix, assume it's plaintext (for migration)
    logger.warn('[Encryption] Detected plaintext data (not encrypted)');
    return encryptedData;
}

/**
 * Check if data is encrypted
 *
 * @param {string} data - Data to check
 * @returns {boolean} True if data appears to be encrypted
 */
function isEncrypted(data) {
    if (!data || typeof data !== 'string') {
        return false;
    }
    return data.startsWith('KEYRING:');
}

/**
 * Delete encrypted data from OS keyring
 * Only works for keyring-stored data
 *
 * @param {string} accountName - Account name to delete
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteEncryptedData(accountName) {
    if (keytar) {
        try {
            return await keytar.deletePassword(SERVICE_NAME, accountName);
        } catch (error) {
            logger.error(`[Encryption] Failed to delete from keyring: ${error.message}`);
            return false;
        }
    }
    return false;
}

/**
 * Clean up old format credentials that may have been created by older versions.
 * Old format: service name without account suffix in target name.
 * This ensures Node.js and C# use identical credential formats.
 *
 * @returns {Promise<void>}
 */
async function cleanupOldCredentials() {
    if (!keytar) {
        return;
    }

    try {
        const credentials = await keytar.findCredentials(SERVICE_NAME);
        logger.debug(`[Encryption] Found ${credentials.length} credentials in keyring`);

        // Check for duplicates (same account with different formats)
        const accountCounts = {};
        for (const cred of credentials) {
            accountCounts[cred.account] = (accountCounts[cred.account] || 0) + 1;
        }

        // Log any duplicates found
        for (const [account, count] of Object.entries(accountCounts)) {
            if (count > 1) {
                logger.warn(`[Encryption] Found ${count} duplicate entries for account: ${account}`);
            }
        }
    } catch (error) {
        logger.error(`[Encryption] Cleanup error: ${error.message}`);
    }
}

/**
 * Get information about the encryption system
 *
 * @returns {Object} System information
 */
function getEncryptionInfo() {
    return {
        platform: os.platform(),
        usingKeyring: !!keytar,
        backend: keytar ? (
            os.platform() === 'win32' ? 'Windows DPAPI' :
            os.platform() === 'darwin' ? 'macOS Keychain' :
            'Linux libsecret'
        ) : 'UNAVAILABLE - keytar required',
        secure: !!keytar
    };
}

module.exports = {
    encryptData,
    decryptData,
    isEncrypted,
    deleteEncryptedData,
    cleanupOldCredentials,
    getEncryptionInfo
};
