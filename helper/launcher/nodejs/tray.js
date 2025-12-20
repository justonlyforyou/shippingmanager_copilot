/**
 * @fileoverview Tray Icon Management using systray2
 * @module launcher/tray
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const { createRequire } = require('module');
const { isPackaged, getIconPath, loadSettings, saveSettings, getLogsDir } = require('./config');

// Load systray2 from correct path (bundled vs packaged)
let SysTray;
if (isPackaged()) {
  const exeDir = path.dirname(process.execPath);
  const moduleRequire = createRequire(path.join(exeDir, 'node_modules', 'package.json'));
  SysTray = moduleRequire('systray2').default;
} else {
  SysTray = require('systray2').default;
}
const logger = require('./logger');

let systray = null;
let menuItems = {};

/**
 * Event handlers - set these before calling init()
 */
const handlers = {
  onLaunchApp: null,
  onRestart: null,
  onToggleDebug: null,
  onOpenLog: null,
  onExit: null
};

/**
 * Set event handler
 * @param {string} event - Event name
 * @param {Function} handler - Handler function
 */
function setHandler(event, handler) {
  if (event in handlers) {
    handlers[event] = handler;
  }
}

/**
 * Create the tray menu structure
 * @returns {object} Menu configuration
 */
function createMenu() {
  const settings = loadSettings();
  const debugMode = settings.debugMode || false;

  menuItems.launchApp = {
    title: 'Launch App',
    tooltip: 'Open ShippingManager CoPilot in browser',
    checked: false,
    enabled: true,
    click: async () => {
      if (handlers.onLaunchApp) {
        try {
          await handlers.onLaunchApp();
        } catch (err) {
          logger.error('[Tray] Launch App error:', err.message);
          console.error('[Tray] Launch App error:', err);
        }
      }
    }
  };

  menuItems.restart = {
    title: 'Restart',
    tooltip: 'Restart the server',
    checked: false,
    enabled: true,
    click: () => handlers.onRestart && handlers.onRestart()
  };

  menuItems.debugMode = {
    title: 'Debug Mode',
    tooltip: 'Toggle debug logging',
    checked: debugMode,
    enabled: true,
    click: () => {
      const currentSettings = loadSettings();
      currentSettings.debugMode = !currentSettings.debugMode;
      saveSettings(currentSettings);
      menuItems.debugMode.checked = currentSettings.debugMode;
      systray.sendAction({
        type: 'update-item',
        item: menuItems.debugMode
      });
      handlers.onToggleDebug && handlers.onToggleDebug(currentSettings.debugMode);
    }
  };

  menuItems.openLog = {
    title: 'Open Server Log',
    tooltip: 'Open server log file',
    checked: false,
    enabled: true,
    click: () => {
      const logFile = path.join(getLogsDir(), 'server.log');
      if (fs.existsSync(logFile)) {
        openFile(logFile);
      }
      handlers.onOpenLog && handlers.onOpenLog();
    }
  };

  menuItems.exit = {
    title: 'Exit',
    tooltip: 'Shutdown and exit',
    checked: false,
    enabled: true,
    click: () => handlers.onExit && handlers.onExit()
  };

  // Get icon path - use .ico on Windows, .png on others
  let iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) {
    logger.warn('[Tray] Icon not found: ' + iconPath);
    iconPath = '';
  }

  // Read icon as base64 for systray2
  let iconBase64 = '';
  if (iconPath && fs.existsSync(iconPath)) {
    iconBase64 = fs.readFileSync(iconPath).toString('base64');
  }

  return {
    icon: iconBase64,
    isTemplateIcon: os.platform() === 'darwin',
    title: 'ShippingManager CoPilot',
    tooltip: 'ShippingManager CoPilot',
    items: [
      menuItems.launchApp,
      menuItems.restart,
      SysTray.separator,
      menuItems.debugMode,
      menuItems.openLog,
      SysTray.separator,
      menuItems.exit
    ]
  };
}

/**
 * Open a file with the system default application
 * @param {string} filePath - Path to file
 */
function openFile(filePath) {
  const platform = os.platform();
  let proc;

  if (platform === 'win32') {
    proc = spawn('cmd', ['/c', 'start', '""', filePath], { shell: false, stdio: 'ignore' });
  } else if (platform === 'darwin') {
    proc = spawn('open', [filePath], { stdio: 'ignore' });
  } else {
    proc = spawn('xdg-open', [filePath], { stdio: 'ignore' });
  }

  proc.on('error', (err) => {
    logger.error('[Tray] Failed to open file: ' + err.message);
  });
}

/**
 * Open a URL in the default browser
 * @param {string} url - URL to open
 */
function openUrl(url) {
  const platform = os.platform();
  let proc;

  if (platform === 'win32') {
    proc = spawn('cmd', ['/c', 'start', '""', url], { shell: false, stdio: 'ignore' });
  } else if (platform === 'darwin') {
    proc = spawn('open', [url], { stdio: 'ignore' });
  } else {
    proc = spawn('xdg-open', [url], { stdio: 'ignore' });
  }

  proc.on('error', (err) => {
    logger.error('[Tray] Failed to open URL: ' + err.message);
  });
}

/**
 * Initialize the system tray
 * @returns {Promise<void>}
 */
async function init() {
  const menu = createMenu();

  systray = new SysTray({
    menu,
    debug: false,
    copyDir: true // Required for packaged apps
  });

  systray.onClick(action => {
    if (action.item.click) {
      action.item.click();
    }
  });

  await systray.ready();
  logger.info('[Tray] System tray initialized');
}

/**
 * Update tray icon tooltip
 * @param {string} tooltip - New tooltip text
 */
function setTooltip(tooltip) {
  if (systray) {
    systray.sendAction({
      type: 'update-menu',
      menu: {
        tooltip
      }
    });
  }
}

/**
 * Kill the tray and exit
 * @param {boolean} exitProcess - Whether to exit the process
 */
function kill(exitProcess = true) {
  if (systray) {
    systray.kill(exitProcess);
  }
}

module.exports = {
  init,
  setHandler,
  setTooltip,
  kill,
  openUrl,
  openFile
};
