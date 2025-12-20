/**
 * @fileoverview WebView Dialog System
 * @module launcher/webview
 *
 * In development mode: Spawns dialogs as separate Node.js processes
 * In packaged mode: Runs dialogs directly in the main process
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const logger = require('./logger');
const config = require('./config');


/**
 * Show a dialog directly in the current process (for packaged mode)
 * @param {string} dialogType - Type of dialog
 * @param {object} data - Dialog data
 * @returns {Promise<any>} Result from dialog
 */
function showDialogDirect(dialogType, data = {}) {
  return new Promise((resolve, reject) => {
    // Load webview-nodejs from correct path (bundled vs packaged)
    let Webview;
    if (config.isPackaged()) {
      const exeDir = path.dirname(process.execPath);
      const moduleRequire = createRequire(path.join(exeDir, 'node_modules', 'package.json'));
      Webview = moduleRequire('webview-nodejs').Webview;
    } else {
      Webview = require('webview-nodejs').Webview;
    }
    const windowIcon = require('./window-icon');

    // Dialog configurations
    const DIALOGS = {
      serverReady: {
        htmlFile: 'server-ready.html',
        title: 'ShippingManager CoPilot',
        width: 800,
        height: (d) => {
          // Dynamic height based on number of sessions
          const sessionCount = d.sessions ? d.sessions.length : 0;
          const baseHeight = 275; // Header + buttons + padding
          const perSession = 85;  // Height per session card
          const minHeight = 405;
          const maxHeight = windowIcon.getScreenHeight() - 5;
          return Math.min(maxHeight, Math.max(minHeight, baseHeight + (sessionCount * perSession)));
        }
      },
      loading: {
        htmlFile: 'loading.html',
        title: 'ShippingManager CoPilot',
        width: 800,
        height: 600
      },
      loginMethod: {
        htmlFile: 'login-method.html',
        title: 'ShippingManager CoPilot - Login',
        width: 800,
        height: 535
      },
      settings: {
        htmlFile: 'settings.html',
        title: 'Settings',
        width: 450,
        height: 400
      },
      error: {
        htmlFile: 'error.html',
        title: data.title || 'Error',
        width: 400,
        height: 250
      },
      confirm: {
        htmlFile: 'confirm.html',
        title: data.title || 'Confirm',
        width: 400,
        height: 200
      }
    };

    const dialogConfig = DIALOGS[dialogType];
    if (!dialogConfig) {
      reject(new Error('Unknown dialog type: ' + dialogType));
      return;
    }

    // Resolve HTML file path - use app base dir for packaged mode
    const baseDir = config.getAppBaseDir();
    const dialogsDir = path.join(baseDir, 'helper', 'launcher', 'nodejs', 'dialogs');
    const htmlPath = path.join(dialogsDir, dialogConfig.htmlFile);

    if (!fs.existsSync(htmlPath)) {
      reject(new Error('Dialog HTML not found: ' + htmlPath));
      return;
    }

    // Create and show webview
    let result = null;
    const webview = new Webview();
    webview.title(dialogConfig.title);

    // Support dynamic height (can be function or number)
    const width = typeof dialogConfig.width === 'function' ? dialogConfig.width(data) : dialogConfig.width;
    const height = typeof dialogConfig.height === 'function' ? dialogConfig.height(data) : dialogConfig.height;
    webview.size(width, height);

    // Bind closeDialog - stores result and terminates
    webview.bind('closeDialog', (wv, resultJson) => {
      try {
        result = resultJson ? JSON.parse(resultJson) : null;
      } catch {
        result = resultJson;
      }
      wv.terminate();
    });

    // Bind getData - returns initial data to dialog
    webview.bind('getData', () => {
      return JSON.stringify(data);
    });

    // Bind setWindowIcon and centerWindow - called from JS after page loads
    if (process.platform === 'win32') {
      webview.bind('setupWindow', () => {
        const iconPath = windowIcon.getDefaultIconPath();
        windowIcon.setIconByTitle(dialogConfig.title, iconPath);
        windowIcon.centerWindowByTitle(dialogConfig.title);
        return true;
      });

      // Inject JS to call setupWindow after load
      webview.init('window.addEventListener("load", () => setupWindow());');
    }

    // Navigate and run
    const fileUrl = `file://${htmlPath.replace(/\\/g, '/')}`;
    webview.navigate(fileUrl);

    logger.debug(`[Webview] Starting dialog: ${dialogType}`);
    webview.start(); // Blocks until terminate()
    logger.debug(`[Webview] Dialog terminated: ${dialogType}`);

    // Cleanup: unbind all functions first, then destroy
    try {
      webview.unbind('closeDialog');
      webview.unbind('getData');
      if (process.platform === 'win32') {
        webview.unbind('setupWindow');
      }
    } catch (unbindErr) {
      logger.debug('[Webview] unbind error (ignorable): ' + unbindErr.message);
    }

    // Destroy webview to close window
    try {
      webview.destroy();
      logger.debug(`[Webview] Dialog destroyed: ${dialogType}`);
    } catch (destroyErr) {
      logger.debug('[Webview] destroy() error (ignorable): ' + destroyErr.message);
    }

    // Force-close the window using Win32 API IMMEDIATELY (synchronous, no setTimeout)
    if (process.platform === 'win32') {
      // Try multiple times to ensure window is closed
      for (let i = 0; i < 3; i++) {
        const closed = windowIcon.closeWindowByTitle(dialogConfig.title);
        if (closed) {
          logger.debug(`[Webview] Force-closed window: ${dialogConfig.title} (attempt ${i + 1})`);
        } else {
          break; // Window not found, stop trying
        }
      }
    }

    resolve(result);
  });
}

/**
 * Show a dialog in a separate process (for development mode)
 * @param {string} dialogType - Type of dialog
 * @param {object} data - Dialog data
 * @returns {Promise<any>} Result from dialog
 */
function showDialogProcess(dialogType, data = {}) {
  return new Promise((resolve, reject) => {
    const dialogScript = path.join(__dirname, 'dialog-process.js');
    const dataJson = JSON.stringify(data);

    const child = spawn(process.execPath, [dialogScript, dialogType, dataJson], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: __dirname
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      logger.error(`[Webview] Process error: ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      if (stderr) {
        logger.error(`[Webview] Dialog stderr: ${stderr}`);
      }

      if (code !== 0) {
        logger.error(`[Webview] Dialog exited with code ${code}`);
      }

      // Parse result from stdout
      try {
        const result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
        resolve(result);
      } catch (err) {
        logger.error(`[Webview] Failed to parse dialog result: ${err.message}`);
        logger.error(`[Webview] stdout was: ${stdout}`);
        resolve(null);
      }
    });
  });
}

/**
 * Show a dialog - uses direct mode when packaged, process mode in development
 * @param {string} dialogType - Type of dialog
 * @param {object} data - Dialog data
 * @returns {Promise<any>} Result from dialog
 */
function showDialog(dialogType, data = {}) {
  if (config.isPackaged()) {
    // Packaged mode: run dialog directly in main process
    return showDialogDirect(dialogType, data);
  }
  // Development mode: spawn as separate process
  return showDialogProcess(dialogType, data);
}

/**
 * Show server ready dialog
 * @param {object} options - Options
 * @returns {Promise<object>} Dialog result with action
 */
function showServerReadyDialog(options) {
  return showDialog('serverReady', options);
}

/**
 * Show loading dialog during startup
 * @param {object} options - Options
 * @returns {Promise<object>} Dialog result with action
 */
function showLoadingDialog(options) {
  return showDialog('loading', options);
}

/**
 * Show login method dialog
 * @param {object} options - Options
 * @returns {Promise<object|null>} Selected method or null
 */
function showLoginMethodDialog(options) {
  return showDialog('loginMethod', options);
}

/**
 * Show settings dialog
 * @param {object} currentSettings - Current settings
 * @returns {Promise<object|null>} Updated settings or null if cancelled
 */
function showSettingsDialog(currentSettings) {
  return showDialog('settings', currentSettings);
}

/**
 * Show error dialog
 * @param {string} title - Dialog title
 * @param {string} message - Error message
 * @returns {Promise<void>}
 */
function showErrorDialog(title, message) {
  return showDialog('error', { title, message });
}

/**
 * Show confirmation dialog
 * @param {string} title - Dialog title
 * @param {string} message - Confirmation message
 * @returns {Promise<boolean>} True if confirmed, false if cancelled
 */
async function showConfirmDialog(title, message) {
  const result = await showDialog('confirm', { title, message });
  return result === true;
}

module.exports = {
  showServerReadyDialog,
  showLoadingDialog,
  showLoginMethodDialog,
  showSettingsDialog,
  showErrorDialog,
  showConfirmDialog
};
