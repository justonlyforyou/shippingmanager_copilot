/**
 * @fileoverview Live-updating Dialog Process
 *
 * Runs the server-ready dialog in a separate process.
 * Receives session status updates via stdin and updates the UI in real-time.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

// Parse command line arguments
const dialogType = process.argv[2];
const dataJson = process.argv[3];

if (!dialogType || !dataJson) {
  console.error('Usage: dialog-live.js <dialogType> <dataJson>');
  process.exit(1);
}

let dialogData;
try {
  dialogData = JSON.parse(dataJson);
} catch (err) {
  console.error('Failed to parse dialog data:', err.message);
  process.exit(1);
}

// Determine base directory
function getAppBaseDir() {
  // Check if we're in packaged mode by looking for Server.exe
  const exeDir = path.dirname(process.execPath);
  const serverExe = path.join(exeDir, 'ShippingManagerCoPilot-Server.exe');
  if (fs.existsSync(serverExe)) {
    return exeDir;
  }
  // Development: find project root
  let searchDir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(searchDir, 'app.js'))) {
      return searchDir;
    }
    const parent = path.dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }
  return __dirname;
}

function isPackaged() {
  const exeDir = path.dirname(process.execPath);
  return fs.existsSync(path.join(exeDir, 'ShippingManagerCoPilot-Server.exe'));
}

// Load webview-nodejs
let Webview;
if (isPackaged()) {
  const exeDir = path.dirname(process.execPath);
  const moduleRequire = createRequire(path.join(exeDir, 'node_modules', 'package.json'));
  Webview = moduleRequire('webview-nodejs').Webview;
} else {
  Webview = require('webview-nodejs').Webview;
}

// Dialog configuration
const DIALOGS = {
  serverReady: {
    htmlFile: 'server-ready.html',
    title: 'ShippingManager CoPilot',
    width: 800,
    height: (d) => {
      const sessionCount = d.sessions ? d.sessions.length : 0;
      const baseHeight = 275;
      const perSession = 85;
      const minHeight = 405;
      const maxHeight = 800;
      return Math.min(maxHeight, Math.max(minHeight, baseHeight + (sessionCount * perSession)));
    }
  }
};

const dialogConfig = DIALOGS[dialogType];
if (!dialogConfig) {
  console.error('Unknown dialog type:', dialogType);
  process.exit(1);
}

// Resolve HTML file path
const baseDir = getAppBaseDir();
const dialogsDir = path.join(baseDir, 'helper', 'launcher', 'nodejs', 'dialogs');
const htmlPath = path.join(dialogsDir, dialogConfig.htmlFile);

if (!fs.existsSync(htmlPath)) {
  console.error('Dialog HTML not found:', htmlPath);
  process.exit(1);
}

// Create webview
let result = null;
const webview = new Webview();
webview.title(dialogConfig.title);

const width = typeof dialogConfig.width === 'function' ? dialogConfig.width(dialogData) : dialogConfig.width;
const height = typeof dialogConfig.height === 'function' ? dialogConfig.height(dialogData) : dialogConfig.height;
webview.size(width, height);

// Bind closeDialog
webview.bind('closeDialog', (wv, resultJson) => {
  try {
    result = resultJson ? JSON.parse(resultJson) : null;
  } catch {
    result = resultJson;
  }
  wv.terminate();
});

// Bind getData - returns initial data
webview.bind('getData', () => {
  return JSON.stringify(dialogData);
});

// Track which sessions are ready (so we don't re-poll them)
const readySessions = new Set();

// Bind getSessionStatus - polls each server's /health endpoint using curl
webview.bind('getSessionStatus', () => {
  const sessions = [];

  if (dialogData.sessions) {
    for (const session of dialogData.sessions) {
      const port = session.port;
      const sessionKey = String(session.userId);

      // Skip already ready sessions
      if (readySessions.has(sessionKey)) {
        sessions.push({ userId: session.userId, status: 'ready', port });
        continue;
      }

      let status = 'loading';

      try {
        // Use curl with -k to ignore self-signed cert, -s for silent, very short timeout
        const curlResult = spawnSync('curl', [
          '-k', '-s', '--connect-timeout', '0.1', '--max-time', '0.2',
          `https://127.0.0.1:${port}/health`
        ], { encoding: 'utf8', timeout: 500 });

        if (curlResult.status === 0 && curlResult.stdout) {
          const health = JSON.parse(curlResult.stdout);
          if (health.ready === true) {
            status = 'ready';
            readySessions.add(sessionKey);
          }
        }
      } catch {
        // Server not ready yet
      }

      sessions.push({
        userId: session.userId,
        status,
        port
      });
    }
  }

  return JSON.stringify({ sessions });
});

// Setup window (Windows only)
if (process.platform === 'win32') {
  const windowIcon = require('./window-icon');
  webview.bind('setupWindow', () => {
    const iconPath = windowIcon.getDefaultIconPath();
    windowIcon.setIconByTitle(dialogConfig.title, iconPath);
    windowIcon.centerWindowByTitle(dialogConfig.title);
    return true;
  });
  webview.init('window.addEventListener("load", () => setupWindow());');
}

// Navigate and run
const fileUrl = `file://${htmlPath.replace(/\\/g, '/')}`;
webview.navigate(fileUrl);

// Run the webview (blocks until closed)
webview.start();

// Cleanup
try {
  webview.unbind('closeDialog');
  webview.unbind('getData');
  webview.unbind('getSessionStatus');
  if (process.platform === 'win32') {
    webview.unbind('setupWindow');
  }
} catch {}

try {
  webview.destroy();
} catch {}

// Output result and exit
console.log(JSON.stringify(result));
process.exit(0);
