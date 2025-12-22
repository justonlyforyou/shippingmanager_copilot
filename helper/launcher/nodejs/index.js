#!/usr/bin/env node
/**
 * @fileoverview ShippingManager CoPilot Launcher
 * @module launcher
 *
 * Main entry point - GUI launcher with system tray.
 * For headless mode, use launcher/headless.js
 */

const fs = require('fs');

const config = require('./config');
const logger = require('./logger');
const tray = require('./tray');
const webview = require('./webview');
const sessionManager = require('../../../server/utils/session-manager');
const serverManager = require('./server-manager');
const steamExtractor = require('./session/steam-extractor');
const cli = require('./cli');

// Global state
let settings = null;

// Use centralized session validation from session-manager
const { validateSessionCookie } = sessionManager;

// Use server processes from server-manager
const serverProcesses = serverManager.getServerProcesses();

/**
 * Log message with timestamp - delegates to logger module
 * @param {string} level - Log level
 * @param {string} message - Message
 */
function log(level, message) {
  logger.log(level, message);
}

// Delegate server management to server-manager module
const { startServerForSession, stopAllServers, restartAllServers, stopServerForUser } = serverManager;

// Set log function for server-manager
serverManager.setLogFunction(log);

// Set up global event emitter for launcher events (session_invalid, etc.)
const { EventEmitter } = require('events');
if (!global.launcherEvents) {
  global.launcherEvents = new EventEmitter();
}

// Listen for session_invalid events and show renewal dialog
global.launcherEvents.on('session_invalid', async (data) => {
  log('error', `Session invalid for ${data.companyName} (user ${data.userId}): ${data.error.message}`);

  // Show dialog to user offering session renewal
  try {
    const result = await webview.showSessionExpiredDialog({
      companyName: data.companyName,
      userId: data.userId,
      errorMessage: data.error.message
    });

    if (result && result.action === 'renew') {
      log('info', `User chose to renew session for ${data.companyName}`);

      // Stop the failed server
      await stopServerForUser(data.userId);

      // Show login dialog
      const loginResult = await webview.showLoginMethodDialog({
        steamAvailable: steamExtractor.isAvailable(),
        renewFor: data.companyName
      });

      if (loginResult) {
        let newCookie = null;

        if (loginResult.method === 'steam') {
          const steamResult = await steamExtractor.steamLogin();
          if (steamResult) newCookie = steamResult.cookie;
        } else if (loginResult.method === 'browser') {
          const browserResult = await webview.showBrowserLoginDialog();
          if (browserResult) newCookie = browserResult.cookie;
        }

        if (newCookie) {
          const validation = await validateSessionCookie(newCookie);
          if (validation && String(validation.userId) === String(data.userId)) {
            // Update session and restart server
            await sessionManager.saveSession(data.userId, newCookie, validation.companyName, loginResult.method);
            const sessions = await sessionManager.getAvailableSessions();
            const session = sessions.find(s => String(s.userId) === String(data.userId));
            if (session) {
              await startServerForSession(session, data.port);
              log('info', `Session renewed and server restarted for ${data.companyName}`);
            }
          } else {
            log('error', 'Session renewal failed - user ID mismatch or validation failed');
          }
        }
      }
    } else if (result && result.action === 'remove') {
      log('info', `User chose to remove account ${data.companyName}`);
      await sessionManager.deleteSession(data.userId);
      await stopServerForUser(data.userId);
    }
  } catch (err) {
    log('error', `Failed to handle session_invalid: ${err.message}`);
  }
});

/**
 * Restart a single server by user ID
 * @param {string} userId - User ID of server to restart
 * @returns {Promise<void>}
 */
async function restartServerForUser(userId) {
  const userIdStr = String(userId);

  // Get current port before stopping
  const serverInfo = serverProcesses.get(userIdStr);
  const port = serverInfo ? serverInfo.port : null;

  if (!port) {
    log('error', `Cannot restart server for user ${userId} - not found`);
    return;
  }

  // Stop the server
  await stopServerForUser(userId);

  // Get updated session
  const sessions = await sessionManager.getAvailableSessions();
  const session = sessions.find(s => String(s.userId) === userIdStr);

  if (!session) {
    log('error', `No session found for user ${userId}`);
    return;
  }

  // Start the server again on the same port
  await startServerForSession(session, port);
}

/**
 * Handle dialog result (refresh, add account, open, etc.)
 * @param {object} dialogResult - Result from dialog
 * @param {string[]} allUrls - Server URLs
 * @param {object[]} sessionInfos - Session info array
 * @returns {Promise<boolean>} True if dialog should reopen
 */
async function handleDialogResult(dialogResult, allUrls, sessionInfos) {
  if (!dialogResult) {
    return false;
  }

  if (dialogResult.action === 'open') {
    tray.openUrl(dialogResult.url);
    return false;
  }

  if (dialogResult.action === 'openAll') {
    const openUrls = dialogResult.urls || allUrls;
    for (const url of openUrls) {
      tray.openUrl(url);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  if (dialogResult.action === 'minimize') {
    return false;
  }

  if (dialogResult.action === 'doRefresh') {
    const refreshUserId = dialogResult.userId;
    const refreshLoginMethod = dialogResult.loginMethod;
    const sessionToRefresh = sessionInfos.find(s => String(s.userId) === String(refreshUserId));

    if (sessionToRefresh) {
      log('info', `Refreshing session for ${sessionToRefresh.companyName} (${refreshLoginMethod})...`);

      let refreshSuccess = false;

      if (refreshLoginMethod === 'steam') {
        const steamResult = await steamExtractor.steamLogin();
        if (steamResult) {
          const validation = await validateSessionCookie(steamResult.cookie);
          if (validation) {
            await sessionManager.saveSession(
              validation.userId,
              steamResult.cookie,
              validation.companyName,
              'steam'
            );
            log('info', `Session refreshed for ${validation.companyName}`);
            refreshSuccess = true;
          } else {
            log('error', 'Steam cookie validation failed');
          }
        } else {
          log('error', 'Steam cookie extraction failed - database may be locked by Steam');
        }
      } else {
        let browserLogin;
        try {
          browserLogin = require('./session/browser-login');
        } catch {
          log('error', 'Browser login not available');
        }

        if (browserLogin && browserLogin.isAvailable()) {
          try {
            const browserResult = await browserLogin.browserLogin();
            if (browserResult && browserResult.shipping_manager_session) {
              const validation = await validateSessionCookie(browserResult.shipping_manager_session);
              if (validation) {
                await sessionManager.saveSession(
                  validation.userId,
                  browserResult.shipping_manager_session,
                  validation.companyName,
                  'browser'
                );
                log('info', `Session refreshed for ${validation.companyName}`);
                refreshSuccess = true;
              }
            } else {
              log('warn', 'Browser login cancelled or failed');
            }
          } catch (browserErr) {
            log('error', `Browser login error: ${browserErr.message}`);
          }
        }
      }

      if (refreshSuccess) {
        await restartServerForUser(refreshUserId);
        log('info', `Server for user ${refreshUserId} restarted with new session`);
      }
    }
    return true; // Reopen dialog
  }

  if (dialogResult.action === 'addAccount') {
    log('info', 'Adding new account...');
    log('debug', 'About to show login method dialog...');

    const loginResult = await webview.showLoginMethodDialog({
      steamAvailable: steamExtractor.isAvailable()
    });
    log('debug', 'Login method dialog returned: ' + JSON.stringify(loginResult));

    if (loginResult && loginResult.method) {
      let newCookie = null;
      let loginMethod = loginResult.method;

      if (loginResult.method === 'steam') {
        const steamResult = await steamExtractor.steamLogin();
        if (steamResult) {
          newCookie = steamResult.cookie;
        } else {
          log('error', 'Steam cookie extraction failed - database may be locked by Steam');
        }
      } else {
        log('debug', 'Browser login selected, loading module...');
        let browserLogin;
        try {
          browserLogin = require('./session/browser-login');
          log('debug', 'Browser login module loaded');
        } catch (loadErr) {
          log('error', 'Browser login not available: ' + loadErr.message);
        }

        log('debug', 'Checking if browser login is available...');
        if (browserLogin && browserLogin.isAvailable()) {
          log('debug', 'Browser login is available, starting browserLogin()...');
          try {
            const browserResult = await browserLogin.browserLogin();
            log('debug', 'browserLogin() returned');
            if (browserResult && browserResult.shipping_manager_session) {
              newCookie = browserResult.shipping_manager_session;
              loginMethod = 'browser';
            } else {
              log('warn', 'Browser login cancelled or failed');
            }
          } catch (browserErr) {
            log('error', `Browser login error: ${browserErr.message}`);
          }
        } else {
          log('warn', 'Browser login not available');
        }
      }

      if (newCookie) {
        const validation = await validateSessionCookie(newCookie);
        if (validation) {
          await sessionManager.saveSession(
            validation.userId,
            newCookie,
            validation.companyName,
            loginMethod
          );
          log('info', `New session saved for ${validation.companyName}`);

          const newPort = settings.port + serverProcesses.size;
          const newSession = {
            userId: validation.userId,
            companyName: validation.companyName,
            cookie: newCookie,
            loginMethod: loginMethod
          };
          await startServerForSession(newSession, newPort);
          log('info', `New server started for ${validation.companyName} on port ${newPort}`);
        }
      }
    }
    return true; // Reopen dialog
  }

  if (dialogResult.action === 'removeAccount') {
    const removeUserId = dialogResult.userId;
    const deleteData = dialogResult.deleteData;

    log('info', `Removing account ${removeUserId}...`);

    // Stop the server first
    await stopServerForUser(removeUserId);

    // Delete user data if requested
    if (deleteData) {
      log('info', 'Deleting user data...');
      const { deleteUserData } = require('./cli');
      const stats = await deleteUserData(removeUserId);
      log('info', `Deleted ${stats.deleted} file(s)/folder(s)`);
    }

    // Delete the session
    await sessionManager.deleteSession(removeUserId);
    log('info', `Account ${removeUserId} removed`);

    return true; // Reopen dialog
  }

  if (dialogResult.action === 'setAutostart') {
    const userId = dialogResult.userId;
    const autostart = dialogResult.autostart;

    log('info', `Setting autostart=${autostart} for user ${userId}`);
    await sessionManager.setAutostart(userId, autostart);

    return true; // Reopen dialog
  }

  return false; // Unknown action
}

/**
 * Update session infos from running servers
 * @param {string[]} allUrls - Array to fill with URLs
 * @param {object[]} sessionInfos - Array to fill with session info
 */
async function updateSessionInfos(allUrls, sessionInfos) {
  const updatedSessions = await sessionManager.getAvailableSessions();
  allUrls.length = 0;
  sessionInfos.length = 0;

  for (const [uId, sInfo] of serverProcesses) {
    allUrls.push(`https://localhost:${sInfo.port}`);
    const sData = updatedSessions.find(s => String(s.userId) === String(uId));
    sessionInfos.push({
      userId: uId,
      companyName: sInfo.companyName,
      loginMethod: sData?.loginMethod || 'unknown',
      port: sInfo.port,
      autostart: sData?.autostart !== false,
      status: 'ready'
    });
  }
}

/**
 * Show server ready dialog and handle results in loop
 * @param {string[]} allUrls - Server URLs
 * @param {object[]} sessionInfos - Session info
 */
async function showServerReadyDialogLoop(allUrls, sessionInfos) {
  let keepDialogOpen = true;

  while (keepDialogOpen) {
    const dialogResult = await webview.showServerReadyDialog({
      urls: allUrls,
      sessions: sessionInfos,
      userdataPath: config.getUserDataDir()
    });

    keepDialogOpen = await handleDialogResult(dialogResult, allUrls, sessionInfos);

    if (keepDialogOpen) {
      await updateSessionInfos(allUrls, sessionInfos);
    }
  }
}

/**
 * Open the Server Ready dialog from systray
 */
async function launchApp() {
  const allUrls = [];
  const sessionInfos = [];
  const currentSessions = await sessionManager.getAvailableSessions();

  for (const [userId, serverInfo] of serverProcesses) {
    allUrls.push(`https://localhost:${serverInfo.port}`);
    const sData = currentSessions.find(s => String(s.userId) === String(userId));
    sessionInfos.push({
      userId: String(userId),
      companyName: serverInfo.companyName,
      loginMethod: serverInfo.loginMethod,
      port: serverInfo.port,
      autostart: sData?.autostart !== false,
      status: 'ready'
    });
  }

  if (allUrls.length === 0) {
    log('warn', 'No servers running, showing error dialog');
    await webview.showErrorDialog('No Servers Running', 'No servers are currently running. Please restart the application or add an account.');
    return;
  }

  await showServerReadyDialogLoop(allUrls, sessionInfos);
}

/**
 * Handle exit
 */
async function handleExit() {
  log('info', 'Shutting down...');

  await stopAllServers();
  tray.kill(true);

  process.exit(0);
}

/**
 * Main function
 */
async function main() {
  // Parse CLI arguments first
  const args = cli.parseArgs();

  // Handle CLI commands (these exit immediately)
  if (args.help) {
    cli.showHelp();
    process.exit(0);
  }

  if (args.listSessions) {
    await cli.listSessions();
    process.exit(0);
  }

  if (args.removeSession) {
    await cli.removeSession(args.removeSession);
    process.exit(0);
  }

  if (args.addSession) {
    await cli.addSessionInteractive();
    process.exit(0);
  }

  log('info', 'ShippingManager CoPilot Launcher starting...');
  log('info', `Platform: ${process.platform}, Packaged: ${config.isPackaged()}`);
  log('info', `App base: ${config.getAppBaseDir()}`);
  log('info', `User data: ${config.getUserDataDir()}`);

  // Ensure directories exist
  const settingsDir = config.getSettingsDir();
  const logsDir = config.getLogsDir();
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Headless mode - delegate to headless.js
  if (args.headless) {
    log('info', 'Headless mode requested, delegating to headless.js...');
    require('./headless');
    return;
  }

  // Check if first run - show settings dialog
  if (!config.settingsExist()) {
    log('info', 'First run detected, showing settings dialog...');

    const defaultSettings = config.DEFAULT_SETTINGS;
    const result = await webview.showSettingsDialog(defaultSettings);

    if (result) {
      config.saveSettings(result);
      log('info', 'Initial settings saved');
    } else {
      // User cancelled - save defaults
      config.saveSettings(defaultSettings);
      log('info', 'Using default settings');
    }
  }

  // Load settings
  settings = config.loadSettings();
  log('info', `Settings: port=${settings.port}, host=${settings.host}`);

  // Set up tray handlers
  tray.setHandler('onLaunchApp', launchApp);
  tray.setHandler('onRestart', restartAllServers);
  tray.setHandler('onExit', handleExit);
  tray.setHandler('onToggleDebug', async (enabled) => {
    log('info', `Debug mode ${enabled ? 'enabled' : 'disabled'}`);
    // Reload settings to get updated debugMode value
    settings = config.loadSettings();
    // Restart servers to apply debug mode change
    log('info', 'Restarting servers to apply debug mode change...');
    await restartAllServers();
  });

  // Initialize tray
  try {
    await tray.init();
    log('info', 'Tray initialized');
  } catch (err) {
    log('error', `Failed to initialize tray: ${err.message}`);
    // Continue without tray for headless mode
  }

  // Check for existing sessions
  const sessions = await sessionManager.getAvailableSessions();
  log('info', `Found ${sessions.length} saved session(s)`);

  // If no sessions, prompt for login
  if (sessions.length === 0) {
    log('info', 'No sessions found, showing login dialog...');

    const loginResult = await webview.showLoginMethodDialog({
      steamAvailable: steamExtractor.isAvailable()
    });

    if (!loginResult) {
      log('info', 'Login cancelled, exiting...');
      await handleExit();
      return;
    }

    if (loginResult.method === 'steam') {
      log('info', 'Attempting Steam cookie extraction...');
      const steamResult = await steamExtractor.steamLogin();

      if (steamResult) {
        // Validate and save session
        const validation = await validateSessionCookie(steamResult.cookie);
        if (validation) {
          await sessionManager.saveSession(
            validation.userId,
            steamResult.cookie,
            validation.companyName,
            'steam'
          );
          log('info', `Session saved for ${validation.companyName}`);
        } else {
          await webview.showErrorDialog('Login Failed', 'Could not validate Steam session. Please try again or use browser login.');
          await handleExit();
          return;
        }
      } else {
        await webview.showErrorDialog('Steam Extraction Failed', 'Could not extract session from Steam. Please ensure you have logged into Shipping Manager via Steam browser, then try again.');
        await handleExit();
        return;
      }
    } else {
      // Browser login via Selenium
      log('info', 'Attempting browser login...');

      // Check if selenium is available
      let browserLogin;
      try {
        browserLogin = require('./session/browser-login');
      } catch {
        await webview.showErrorDialog('Browser Login Unavailable', 'Browser login requires selenium-webdriver. Please install it with: npm install selenium-webdriver');
        await handleExit();
        return;
      }

      if (!browserLogin.isAvailable()) {
        await webview.showErrorDialog('Browser Login Unavailable', 'Browser login requires selenium-webdriver. Please install it with: npm install selenium-webdriver');
        await handleExit();
        return;
      }

      let browserResult = null;
      try {
        browserResult = await browserLogin.browserLogin();
      } catch (browserErr) {
        log('error', `Browser login error: ${browserErr.message}`);
        await webview.showErrorDialog('Browser Login Error', `An error occurred: ${browserErr.message}`);
        await handleExit();
        return;
      }

      if (browserResult && browserResult.shipping_manager_session) {
        // Validate and save session
        const validation = await validateSessionCookie(browserResult.shipping_manager_session);
        if (validation) {
          await sessionManager.saveSession(
            validation.userId,
            browserResult.shipping_manager_session,
            validation.companyName,
            'browser'
          );
          log('info', `Session saved for ${validation.companyName}`);
        } else {
          await webview.showErrorDialog('Login Failed', 'Could not validate browser session. Please try again.');
          await handleExit();
          return;
        }
      } else {
        await webview.showErrorDialog('Browser Login Failed', 'Could not extract session from browser. Please ensure you logged in successfully.');
        await handleExit();
        return;
      }
    }
  }

  // Start all servers in parallel and show dialog immediately
  try {
    settings = config.loadSettings();

    // Get sessions to start
    const allSessions = await sessionManager.getAvailableSessions();
    const autostartSessions = allSessions.filter(s => s.autostart !== false);

    if (autostartSessions.length === 0) {
      log('error', 'No sessions to start');
      await webview.showErrorDialog('Startup Failed', 'No sessions found. Please add an account.');
      await handleExit();
      return;
    }

    log('info', `Starting ${autostartSessions.length} server(s) in parallel...`);

    // Prepare initial session list with loading state
    const sessionInfos = autostartSessions.map((session, index) => ({
      userId: String(session.userId),
      companyName: session.companyName,
      loginMethod: session.loginMethod,
      port: settings.port + index,
      autostart: session.autostart !== false,
      status: 'loading'
    }));

    // Show dialog - it will poll the status file for updates
    log('info', 'Showing dialog...');
    const dialogPromise = webview.showServerReadyDialog({
      urls: [],
      sessions: sessionInfos,
      userdataPath: config.getUserDataDir()
    });

    // Start servers - status updates go to shared file
    log('info', 'Starting servers in batches of 3...');
    const BATCH_SIZE = 3;
    for (let i = 0; i < autostartSessions.length; i += BATCH_SIZE) {
      const batch = autostartSessions.slice(i, i + BATCH_SIZE);

      // Start batch in parallel - dialog polls /health directly via curl
      batch.forEach((session, batchIndex) => {
        const port = settings.port + i + batchIndex;

        serverManager.startServerForSession(session, port, (userId, companyName, readyPort) => {
          log('info', `Server ${companyName} is ready on port ${readyPort}`);
        }).catch((err) => {
          log('error', `Failed to start ${session.companyName}: ${err.message}`);
        });
      });
    }

    // Wait for dialog result and handle it
    let dialogResult = await dialogPromise;
    let keepDialogOpen = await handleDialogResult(dialogResult, [], sessionInfos);

    // Handle dialog result loop (for refresh, add account, etc.)
    while (keepDialogOpen) {
      await updateSessionInfos([], sessionInfos);
      dialogResult = await webview.showServerReadyDialog({
        urls: sessionInfos.filter(s => s.status === 'ready').map(s => `https://localhost:${s.port}`),
        sessions: sessionInfos,
        userdataPath: config.getUserDataDir()
      });
      keepDialogOpen = await handleDialogResult(dialogResult, [], sessionInfos);
    }

  } catch (err) {
    log('error', `Failed to start: ${err.message}`);
    await webview.showErrorDialog('Startup Failed', err.message);
    await handleExit();
  }

  // Handle process signals
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
  process.on('uncaughtException', (err) => {
    log('error', `Uncaught exception: ${err.message}`);
    console.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    log('error', `Unhandled rejection: ${reason}`);
  });

  // Keep the process alive for tray icon to work
  // The tray icon event loop needs the Node.js event loop to keep running
  log('info', 'Launcher running in background. Use tray icon to interact.');
  await new Promise(() => {
    // This promise never resolves - keeps the process alive
    // Exit happens via handleExit() from tray menu or signals
  });
}

// Run main
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
