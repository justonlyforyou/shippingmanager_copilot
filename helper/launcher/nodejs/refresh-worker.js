/**
 * @fileoverview Worker thread for session refresh operations
 * @module launcher/refresh-worker
 *
 * Runs session refresh (Steam/Browser login) in a separate thread
 * so the webview event loop isn't blocked.
 */

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

// Set up module paths for worker context
const launcherDir = __dirname;
const projectRoot = path.join(launcherDir, '..');

// Logger for worker
const logger = require('./logger');

// Worker receives: { userId, loginMethod }
const { userId, loginMethod } = workerData;

logger.info(`[Worker] Starting refresh for userId=${userId}, loginMethod=${loginMethod}`);

async function doRefresh() {
  try {
    // Load modules
    logger.info('[Worker] Loading modules...');
    const steamExtractor = require('./session/steam-extractor');
    const browserLogin = require('./session/browser-login');
    const sessionManager = require(path.join(projectRoot, 'server/utils/session-manager'));
    logger.info('[Worker] Modules loaded');

    let newCookie = null;

    if (loginMethod === 'steam') {
      logger.info('[Worker] Starting Steam login...');
      const steamResult = await steamExtractor.steamLogin();
      logger.info(`[Worker] Steam result: ${steamResult ? 'success' : 'null'}`);
      if (steamResult) {
        newCookie = steamResult.cookie;
      }
    } else {
      logger.info('[Worker] Starting Browser login...');
      if (browserLogin.isAvailable()) {
        const browserResult = await browserLogin.browserLogin();
        logger.info(`[Worker] Browser result: ${browserResult ? 'success' : 'null'}`);
        if (browserResult && browserResult.shipping_manager_session) {
          newCookie = browserResult.shipping_manager_session;
        }
      } else {
        logger.error('[Worker] Browser login not available');
        parentPort.postMessage({ success: false, error: 'Browser login not available' });
        return;
      }
    }

    if (!newCookie) {
      logger.warn('[Worker] No cookie obtained');
      parentPort.postMessage({ success: false, error: 'Login cancelled or failed' });
      return;
    }

    // Validate the cookie
    logger.info('[Worker] Validating cookie...');
    const validation = await browserLogin.validateCookie(newCookie);
    if (!validation) {
      logger.error('[Worker] Cookie validation failed');
      parentPort.postMessage({ success: false, error: 'Invalid session cookie' });
      return;
    }

    logger.info(`[Worker] Cookie valid for: ${validation.companyName}`);

    // Save the session
    await sessionManager.saveSession(
      validation.userId,
      newCookie,
      validation.companyName,
      loginMethod
    );
    logger.info('[Worker] Session saved');

    // Get updated sessions
    const updatedSessions = await sessionManager.getAvailableSessions();
    const sessionInfos = updatedSessions.map(s => ({
      userId: String(s.userId),
      companyName: s.companyName,
      loginMethod: s.loginMethod
    }));

    logger.info(`[Worker] Sending success with ${sessionInfos.length} sessions`);
    parentPort.postMessage({
      success: true,
      userId: userId,
      sessions: sessionInfos
    });

  } catch (err) {
    logger.error(`[Worker] Error: ${err.message}`);
    parentPort.postMessage({ success: false, error: err.message });
  }
}

doRefresh();
