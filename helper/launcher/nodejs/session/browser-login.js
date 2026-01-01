/**
 * @fileoverview Browser Login via Undetected ChromeDriver
 *
 * Uses undetected-chromedriver-js to open a browser, wait for login, and extract cookies.
 * Ported from Python helper/get_session_windows.py browser_login()
 *
 * @module launcher/session/browser-login
 */

const https = require('https');
const path = require('path');
const { createRequire } = require('module');
const logger = require('../logger');
const config = require('../config');

const TARGET_DOMAIN = 'shippingmanager.cc';
const TARGET_COOKIE_NAME = 'shipping_manager_session';

// Check if undetected chromedriver is available
// TEMPORARILY DISABLED - testing regular selenium first
let undetectedAvailable = false;
let UndetectedChrome = null;

// try {
//   UndetectedChrome = require('undetected-chromedriver-js');
//   undetectedAvailable = true;
// } catch {
//   undetectedAvailable = false;
// }

// Selenium is loaded lazily when needed
let seleniumLoaded = false;
let webdriver = null;

/**
 * Load selenium-webdriver lazily
 * @returns {boolean} True if loaded successfully
 */
function loadSelenium() {
  if (seleniumLoaded) return !!webdriver;

  seleniumLoaded = true;
  try {
    if (config.isPackaged()) {
      // In packaged mode, load from node_modules next to exe
      const exeDir = path.dirname(process.execPath);
      const moduleRequire = createRequire(path.join(exeDir, 'node_modules', 'package.json'));
      webdriver = moduleRequire('selenium-webdriver');
      logger.info('[BrowserLogin] Loaded selenium-webdriver from packaged path');
    } else {
      webdriver = require('selenium-webdriver');
      logger.info('[BrowserLogin] Loaded selenium-webdriver from local path');
    }
    return true;
  } catch (err) {
    logger.error('[BrowserLogin] Failed to load selenium-webdriver: ' + err.message);
    webdriver = null;
    return false;
  }
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
      return decodeURIComponent(cookie);
    } catch {
      return cookie;
    }
  }
  return cookie;
}

/**
 * Validate a session cookie by making an API call
 * @param {string} cookie - Session cookie to validate
 * @returns {Promise<Object|null>} User data if valid, null if invalid
 */
function validateCookie(cookie) {
  // Normalize cookie first (decode URL-encoded cookies)
  const normalizedCookie = normalizeCookie(cookie);

  return new Promise((resolve) => {
    const options = {
      hostname: TARGET_DOMAIN,
      port: 443,
      path: '/api/user/get-user-settings',
      method: 'POST',
      headers: {
        'Cookie': `${TARGET_COOKIE_NAME}=${normalizedCookie}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      rejectUnauthorized: false
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
 * Sleep for ms milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create undetected chrome driver
 * @returns {Promise<{driver: WebDriver, chrome: UndetectedChrome}|null>}
 */
async function createUndetectedDriver() {
  if (!undetectedAvailable) {
    logger.info('[BrowserLogin] Undetected ChromeDriver not available, falling back to regular Selenium');
    return null;
  }

  try {
    logger.info('[BrowserLogin] Creating Undetected ChromeDriver...');
    const chrome = await UndetectedChrome.create({
      headless: false
    });
    const driver = chrome.getDriver();
    logger.info('[BrowserLogin] Undetected ChromeDriver created successfully');
    return { driver, chrome };
  } catch (err) {
    logger.error(`[BrowserLogin] Undetected ChromeDriver failed: ${err.message}`);
    return null;
  }
}

/**
 * Detect available browser and create driver (fallback)
 * @returns {Promise<WebDriver|null>}
 */
async function detectBrowser() {
  if (!loadSelenium()) {
    logger.error('[BrowserLogin] Selenium not available');
    return null;
  }

  const { Builder } = webdriver;
  const platform = process.platform;

  // Try browsers in order: Chrome, Edge (Windows), Firefox
  const browsersToTry = ['chrome'];
  if (platform === 'win32') {
    browsersToTry.push('MicrosoftEdge');
  }
  browsersToTry.push('firefox');

  for (const browserName of browsersToTry) {
    try {
      logger.info(`[BrowserLogin] Trying ${browserName}...`);

      let driver;

      // Create require function for packaged mode
      let moduleRequire = require;
      if (config.isPackaged()) {
        const exeDir = path.dirname(process.execPath);
        moduleRequire = createRequire(path.join(exeDir, 'node_modules', 'package.json'));
      }

      if (browserName === 'chrome') {
        const chrome = moduleRequire('selenium-webdriver/chrome');
        const options = new chrome.Options();
        options.addArguments('--start-maximized');
        options.addArguments('--disable-blink-features=AutomationControlled');
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.excludeSwitches('enable-automation');

        // On Linux, explicitly set Chrome binary path if needed
        if (platform === 'linux') {
          const fs = require('fs');
          const chromePaths = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium'
          ];
          for (const chromePath of chromePaths) {
            if (fs.existsSync(chromePath)) {
              logger.info(`[BrowserLogin] Found Chrome at: ${chromePath}`);
              options.setChromeBinaryPath(chromePath);
              break;
            }
          }
        }

        driver = await new Builder()
          .forBrowser('chrome')
          .setChromeOptions(options)
          .build();
      } else if (browserName === 'MicrosoftEdge') {
        const edge = moduleRequire('selenium-webdriver/edge');
        const options = new edge.Options();
        options.addArguments('--start-maximized');

        driver = await new Builder()
          .forBrowser('MicrosoftEdge')
          .setEdgeOptions(options)
          .build();
      } else if (browserName === 'firefox') {
        const firefox = moduleRequire('selenium-webdriver/firefox');
        const options = new firefox.Options();
        options.setPreference('dom.webdriver.enabled', false);

        driver = await new Builder()
          .forBrowser('firefox')
          .setFirefoxOptions(options)
          .build();
      }

      if (driver) {
        logger.info(`[BrowserLogin] Using ${browserName}`);
        return driver;
      }
    } catch (err) {
      logger.info(`[BrowserLogin] ${browserName} not available: ${err.message.substring(0, 50)}...`);
    }
  }

  logger.error('[BrowserLogin] No compatible browser found');
  return null;
}

/**
 * Perform browser login using Selenium and extract session cookies
 * Ported 1:1 from Python browser_login()
 * @returns {Promise<Object|null>} Cookie object with all cookies, or null on failure
 */
async function browserLogin() {
  // Try to load selenium lazily
  const seleniumAvailable = loadSelenium();

  if (!undetectedAvailable && !seleniumAvailable) {
    logger.error('[BrowserLogin] No browser automation available. Run: npm install selenium-webdriver undetected-chromedriver-js');
    return null;
  }

  logger.info(`[BrowserLogin] Starting browser login for '${TARGET_DOMAIN}'...`);

  let driver = null;
  let undetectedChrome = null;

  try {
    // Try undetected chromedriver first
    const undetectedResult = await createUndetectedDriver();
    if (undetectedResult) {
      driver = undetectedResult.driver;
      undetectedChrome = undetectedResult.chrome;
    } else {
      // Fallback to regular selenium
      driver = await detectBrowser();
    }

    if (!driver) {
      return null;
    }

    logger.info(`[BrowserLogin] Navigating to https://${TARGET_DOMAIN}...`);
    await driver.get(`https://${TARGET_DOMAIN}`);

    logger.info('[BrowserLogin] Waiting for successful login...');
    logger.info('[BrowserLogin] Please log in to Shipping Manager in the browser window.');

    let cookie = null;
    const maxWait = 300000; // 5 minutes
    const startTime = Date.now();
    let lastStatus = null;

    while (Date.now() - startTime < maxWait) {
      try {
        // Check if browser is still open
        try {
          await driver.getCurrentUrl();
        } catch {
          logger.info('[BrowserLogin] Browser was closed by user');
          return null;
        }

        // Get current cookies
        const cookies = await driver.manage().getCookies();
        let tempCookie = null;

        for (const c of cookies) {
          if (c.name === TARGET_COOKIE_NAME) {
            // Decode URL encoding
            tempCookie = decodeURIComponent(c.value).trim();
            break;
          }
        }

        // If we have a cookie, validate it
        if (tempCookie) {
          const userData = await validateCookie(tempCookie);

          if (userData) {
            logger.info('[BrowserLogin] Login successful! Session validated.');
            logger.info(`[BrowserLogin] User: ${userData.companyName} (ID: ${userData.userId})`);
            cookie = tempCookie;
            break;
          } else {
            if (lastStatus !== 'no_user_data') {
              logger.info('[BrowserLogin] Cookie found but not valid yet...');
              lastStatus = 'no_user_data';
            }
          }
        } else {
          if (lastStatus !== 'no_cookie') {
            logger.info('[BrowserLogin] Waiting for session cookie...');
            lastStatus = 'no_cookie';
          }
        }

        await sleep(2000);

      } catch (err) {
        logger.error(`[BrowserLogin] Error: ${err.message}`);
        await sleep(2000);
      }
    }

    if (!cookie) {
      logger.error('[BrowserLogin] Login not completed after 5 minutes.');
      if (driver) {
        await driver.quit();
      }
      return null;
    }

    logger.info('[BrowserLogin] Session cookie successfully validated!');

    // Show success message in browser
    try {
      await driver.executeScript(`
        const overlay = document.createElement('div');
        overlay.style.cssText = \`
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.9);
          z-index: 999999;
          display: flex;
          align-items: center;
          justify-content: center;
        \`;

        const message = document.createElement('div');
        message.style.cssText = \`
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          padding: 40px 60px;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
          text-align: center;
          color: white;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        \`;

        message.innerHTML = \`
          <div style="font-size: 72px; margin-bottom: 20px;">OK</div>
          <div style="font-size: 28px; font-weight: bold; margin-bottom: 10px;">Login successful!</div>
          <div style="font-size: 18px; opacity: 0.9;">You can close the browser now</div>
        \`;

        overlay.appendChild(message);
        document.body.appendChild(overlay);
      `);
      logger.info('[BrowserLogin] Success message displayed in browser.');
    } catch {
      // Ignore display errors
    }

    await sleep(3000);

    // Extract ALL cookies for this account
    logger.info('[BrowserLogin] Extracting all cookies...');
    const allCookies = {};

    try {
      const finalCookies = await driver.manage().getCookies();
      for (const c of finalCookies) {
        const cookieName = c.name;
        const cookieValue = decodeURIComponent(c.value).trim();

        if (cookieName === TARGET_COOKIE_NAME) {
          allCookies.shipping_manager_session = cookieValue;
          logger.info(`[BrowserLogin] Session cookie: ${cookieValue.length} chars`);
        } else if (cookieName === 'app_platform') {
          allCookies.app_platform = cookieValue;
          logger.info(`[BrowserLogin] Found app_platform cookie: ${cookieValue.length} chars`);
        } else if (cookieName === 'app_version') {
          allCookies.app_version = cookieValue;
          logger.info(`[BrowserLogin] Found app_version cookie: ${cookieValue.length} chars`);
        }
      }
    } catch (err) {
      logger.error(`[BrowserLogin] Could not extract all cookies: ${err.message}`);
      allCookies.shipping_manager_session = cookie;
    }

    // Ensure we have at least the session cookie
    if (!allCookies.shipping_manager_session) {
      allCookies.shipping_manager_session = cookie;
    }

    logger.info(`[BrowserLogin] Browser login successful! Extracted ${Object.keys(allCookies).length} cookie(s)`);

    // Close browser
    try {
      if (undetectedChrome) {
        await undetectedChrome.close();
      } else {
        await driver.quit();
      }
    } catch {
      // Ignore quit errors
    }

    return allCookies;

  } catch (err) {
    logger.error(`[BrowserLogin] CRITICAL ERROR: ${err.message}`);
    if (driver) {
      try {
        if (undetectedChrome) {
          await undetectedChrome.close();
        } else {
          await driver.quit();
        }
      } catch {
        // Ignore
      }
    }
    return null;
  }
}

/**
 * Check if browser login is available (selenium or undetected chromedriver installed)
 * @returns {boolean} True if available
 */
function isAvailable() {
  if (undetectedAvailable) return true;

  // Check if selenium module exists without loading it
  try {
    if (config.isPackaged()) {
      const exeDir = path.dirname(process.execPath);
      const seleniumPath = path.join(exeDir, 'node_modules', 'selenium-webdriver');
      const fs = require('fs');
      return fs.existsSync(seleniumPath);
    } else {
      require.resolve('selenium-webdriver');
      return true;
    }
  } catch {
    return false;
  }
}

module.exports = {
  browserLogin,
  isAvailable,
  validateCookie
};
