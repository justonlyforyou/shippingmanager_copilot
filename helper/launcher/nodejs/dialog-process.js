#!/usr/bin/env node
/**
 * @fileoverview Standalone dialog process
 * @module launcher/dialog-process
 *
 * Runs as a separate Node.js process so the main launcher stays alive
 * when the dialog closes.
 *
 * Usage: node dialog-process.js <dialogType> <dataJson>
 * Returns result via stdout JSON
 */

const Webview = require('webview-nodejs').Webview;
const path = require('path');
const fs = require('fs');
const windowIcon = require('./window-icon');

// Parse command line args
const dialogType = process.argv[2];
const dataJson = process.argv[3];

if (!dialogType) {
  console.error(JSON.stringify({ error: 'No dialog type specified' }));
  process.exit(1);
}

let data = {};
try {
  if (dataJson) {
    data = JSON.parse(dataJson);
  }
} catch (err) {
  console.error(JSON.stringify({ error: 'Invalid JSON data: ' + err.message }));
  process.exit(1);
}

// Dialog configurations
const DIALOGS = {
  serverReady: {
    htmlFile: 'server-ready.html',
    title: 'ShippingManager CoPilot',
    width: 800,
    height: (d) => {
      // Dynamic height based on number of sessions
      const sessionCount = d.sessions ? d.sessions.length : 0;
      const baseHeight = 275;
      const perSession = 85;
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

const config = DIALOGS[dialogType];
if (!config) {
  console.error(JSON.stringify({ error: 'Unknown dialog type: ' + dialogType }));
  process.exit(1);
}

// Resolve HTML file path
const dialogsDir = path.join(__dirname, 'dialogs');
const htmlPath = path.join(dialogsDir, config.htmlFile);

if (!fs.existsSync(htmlPath)) {
  console.error(JSON.stringify({ error: 'Dialog HTML not found: ' + htmlPath }));
  process.exit(1);
}

// Create and show webview
let result = null;
const webview = new Webview();
webview.title(config.title);

// Support dynamic height (can be function or number)
const width = typeof config.width === 'function' ? config.width(data) : config.width;
const height = typeof config.height === 'function' ? config.height(data) : config.height;
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

// Bind getServerStates - returns current server states from data
// Dialog polls this to get updates as servers become ready
webview.bind('getServerStates', () => {
  // In subprocess mode, we don't have live updates - return initial data
  // The loading dialog will need to use the main process for live updates
  return JSON.stringify(data.serverStates || {});
});

// Bind setWindowIcon and centerWindow - called from JS after page loads
if (process.platform === 'win32') {
  webview.bind('setupWindow', () => {
    const iconPath = windowIcon.getDefaultIconPath();
    windowIcon.setIconByTitle(config.title, iconPath);
    windowIcon.centerWindowByTitle(config.title);
    return true;
  });

  // Inject JS to call setupWindow after load
  webview.init('window.addEventListener("load", () => setupWindow());');
}

// Navigate and run
const fileUrl = `file://${htmlPath.replace(/\\/g, '/')}`;
webview.navigate(fileUrl);
webview.start(); // Blocks until terminate()
webview.destroy();

// Output result as JSON to stdout
console.log(JSON.stringify(result));
process.exit(0);
