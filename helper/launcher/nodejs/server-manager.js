/**
 * @fileoverview Server Process Manager
 * @module launcher/server-manager
 *
 * Manages server processes for all sessions.
 * Used by both GUI launcher and headless mode.
 */

const { spawn } = require('child_process');
const net = require('net');
const config = require('./config');
const sessionManager = require('../../../server/utils/session-manager');

// Server processes map: userId -> { process, port, companyName, loginMethod }
const serverProcesses = new Map();
let serverStarting = false;
let settings = null;

// Log function - can be overridden
let logFn = (level, message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] [ServerManager] ${message}`);
};

/**
 * Set custom log function
 * @param {Function} fn - Log function (level, message)
 */
function setLogFunction(fn) {
  logFn = fn;
}

function log(level, message) {
  logFn(level, message);
}

/**
 * Check if a port is available
 * @param {number} port - Port number
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Wait for server to be ready on port
 * Checks the /api/health endpoint for ready: true
 * @param {number} port - Port number
 * @param {number} [timeout=60000] - Timeout in ms
 * @returns {Promise<{ready: boolean, error?: Object}>} Result with ready state and optional error
 */
function waitForServerReady(port, timeout = 60000) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const checkHealth = async () => {
      try {
        // Use dynamic import for https module
        const https = require('https');

        const options = {
          hostname: '127.0.0.1',
          port: port,
          path: '/health',
          method: 'GET',
          rejectUnauthorized: false // Self-signed cert
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const health = JSON.parse(data);

              // Check for initialization error (e.g., 401 session invalid)
              if (health.error) {
                log('error', `Server init error: ${health.error.code} - ${health.error.message}`);
                resolve({ ready: false, error: health.error });
                return;
              }

              if (health.ready === true) {
                log('info', `Server ready on port ${port}`);
                resolve({ ready: true });
              } else {
                log('debug', `Server not ready yet (ready: ${health.ready})`);
                scheduleNextCheck();
              }
            } catch {
              scheduleNextCheck();
            }
          });
        });

        req.on('error', () => {
          scheduleNextCheck();
        });

        req.setTimeout(5000, () => {
          req.destroy();
          scheduleNextCheck();
        });

        req.end();
      } catch {
        scheduleNextCheck();
      }
    };

    const scheduleNextCheck = () => {
      if (Date.now() - startTime > timeout) {
        log('error', `Server startup timeout after ${timeout}ms`);
        resolve({ ready: false, error: { code: 'TIMEOUT', message: 'Server startup timeout' } });
      } else {
        setTimeout(checkHealth, 1000);
      }
    };

    checkHealth();
  });
}

/**
 * Start server for a single session (waits for /health endpoint to report ready)
 * @param {object} session - Session object
 * @param {number} port - Port to start on
 * @param {function} [onReady] - Optional callback when server is ready
 * @returns {Promise<void>}
 */
async function startServerForSession(session, port, onReady) {
  // Delegate to startServerProcess which polls /health for ready state
  return startServerProcess(session, port, onReady);
}

/**
 * Start servers for all valid sessions (waits for each to be ready)
 * @returns {Promise<number>} Number of servers started
 */
async function startAllServers() {
  if (serverStarting) {
    log('warn', 'Servers already starting');
    return 0;
  }

  serverStarting = true;
  settings = config.loadSettings();

  // Get and validate sessions
  const validSession = await sessionManager.getFirstValidSession((level, msg) => {
    log(level, msg);
  });

  if (!validSession) {
    log('error', 'No valid sessions found');
    serverStarting = false;
    return 0;
  }

  // Get all sessions and start servers for each
  const sessions = await sessionManager.getAvailableSessions();

  // Filter to only autostart-enabled sessions
  const autostartSessions = sessions.filter(s => s.autostart !== false);
  const skippedCount = sessions.length - autostartSessions.length;

  if (skippedCount > 0) {
    log('info', `Skipping ${skippedCount} session(s) with autostart disabled`);
  }

  log('info', `Starting ${autostartSessions.length} server(s)...`);

  let startedCount = 0;

  for (const [index, session] of autostartSessions.entries()) {
    const port = settings.port + index;

    // Validate this session before starting
    const validation = await sessionManager.validateSessionCookie(session.cookie);
    if (!validation) {
      log('warn', `Skipping ${session.companyName} - session expired`);
      continue;
    }

    try {
      await startServerForSession(session, port);
      startedCount++;
    } catch (err) {
      log('error', `Failed to start server for ${session.companyName}: ${err.message}`);
    }
  }

  serverStarting = false;
  return startedCount;
}

/**
 * Start servers quickly without waiting for ready (for loading dialog)
 * Returns session info with ports for the loading dialog to poll
 * @returns {Promise<{sessions: Array, startedCount: number}>}
 */
async function startAllServersQuick() {
  if (serverStarting) {
    log('warn', 'Servers already starting');
    return { sessions: [], startedCount: 0 };
  }

  serverStarting = true;
  settings = config.loadSettings();

  // Get all sessions
  const sessions = await sessionManager.getAvailableSessions();

  // Filter to only autostart-enabled sessions
  const autostartSessions = sessions.filter(s => s.autostart !== false);
  const skippedCount = sessions.length - autostartSessions.length;

  if (skippedCount > 0) {
    log('info', `Skipping ${skippedCount} session(s) with autostart disabled`);
  }

  if (autostartSessions.length === 0) {
    log('error', 'No valid sessions found');
    serverStarting = false;
    return { sessions: [], startedCount: 0 };
  }

  log('info', `Starting ${autostartSessions.length} server(s) (quick mode)...`);

  const sessionInfos = [];
  let startedCount = 0;

  // Start all servers in parallel without waiting for ready
  const startPromises = autostartSessions.map(async (session, index) => {
    const port = settings.port + index;

    // Validate this session before starting
    const validation = await sessionManager.validateSessionCookie(session.cookie);
    if (!validation) {
      log('warn', `Skipping ${session.companyName} - session expired`);
      return null;
    }

    try {
      // Start server without waiting for ready
      await startServerProcess(session, port);
      startedCount++;
      return {
        userId: String(session.userId),
        companyName: session.companyName,
        loginMethod: session.loginMethod,
        port: port
      };
    } catch (err) {
      log('error', `Failed to start server for ${session.companyName}: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.all(startPromises);
  results.forEach(r => { if (r) sessionInfos.push(r); });

  serverStarting = false;
  return { sessions: sessionInfos, startedCount };
}

/**
 * Start server process and wait for health endpoint to report ready
 * @param {object} session - Session object
 * @param {number} port - Port to start on
 * @param {function} [onReady] - Optional callback when server is ready
 * @returns {Promise<void>} Resolves when server reports ready via /health
 */
async function startServerProcess(session, port, onReady) {
  const userId = String(session.userId);

  // Check if server already running for this user
  if (serverProcesses.has(userId)) {
    log('warn', `Server for ${session.companyName} already running`);
    return;
  }

  // Check port availability
  const portAvailable = await isPortAvailable(port);
  if (!portAvailable) {
    throw new Error(`Port ${port} is already in use`);
  }

  log('info', `Starting server process for ${session.companyName} on port ${port}...`);

  const serverPath = config.getServerPath();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: settings?.host || '127.0.0.1',
    SELECTED_USER_ID: userId,
    DEBUG_MODE: settings?.debugMode ? '1' : ''
  };

  let serverProcess;
  if (config.isPackaged()) {
    serverProcess = spawn(serverPath, [], {
      env,
      cwd: config.getAppBaseDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
  } else {
    serverProcess = spawn(process.execPath, [serverPath], {
      env,
      cwd: config.getAppBaseDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
  }

  // Store in map
  serverProcesses.set(userId, {
    process: serverProcess,
    port,
    companyName: session.companyName,
    loginMethod: session.loginMethod,
    ready: false
  });

  // Forward stdout/stderr to console
  serverProcess.stdout.on('data', (data) => {
    console.log(data.toString().trim());
  });

  serverProcess.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      console.error(output);
    }
  });

  serverProcess.on('error', (err) => {
    log('error', `Server for ${session.companyName} error: ${err.message}`);
    serverProcesses.delete(userId);
  });

  serverProcess.on('exit', async (code, signal) => {
    log('info', `Server for ${session.companyName} exited (code ${code}, signal ${signal})`);
    serverProcesses.delete(userId);

    // Exit code 100 = restart requested
    if (code === 100) {
      log('info', `Restart requested for ${session.companyName}, reloading settings and restarting...`);
      settings = config.loadSettings();
      await new Promise(r => setTimeout(r, 500));
      await startAllServers();
    }
  });

  // Use health endpoint polling instead of stdout text matching
  // This is more reliable as stdout chunks can be fragmented
  const result = await waitForServerReady(port, 90000);

  if (result.ready) {
    const serverInfo = serverProcesses.get(userId);
    if (serverInfo) serverInfo.ready = true;
    log('info', `Server for ${session.companyName} is READY (port ${port})`);
    if (onReady) onReady(userId, session.companyName, port);
  } else if (result.error) {
    const serverInfo = serverProcesses.get(userId);
    if (serverInfo) {
      serverInfo.ready = false;
      serverInfo.error = result.error;
    }

    // Handle session invalid error - emit event for UI to handle
    if (result.error.code === 'SESSION_INVALID' || result.error.is401) {
      log('error', `Server for ${session.companyName} has INVALID SESSION - needs renewal`);
      // Emit event so tray/UI can show dialog
      const { EventEmitter } = require('events');
      if (!global.launcherEvents) {
        global.launcherEvents = new EventEmitter();
      }
      global.launcherEvents.emit('session_invalid', {
        userId,
        companyName: session.companyName,
        port,
        error: result.error
      });
    } else {
      log('warn', `Server for ${session.companyName} startup failed: ${result.error.message}`);
    }
  } else {
    log('warn', `Server for ${session.companyName} startup timeout - continuing anyway`);
  }
}

/**
 * Stop server for a specific user
 * @param {string|number} userId - User ID
 * @returns {Promise<void>}
 */
async function stopServerForUser(userId) {
  const userIdStr = String(userId);
  const serverInfo = serverProcesses.get(userIdStr);

  if (!serverInfo) {
    log('warn', `No server running for user ${userId}`);
    return;
  }

  log('info', `Stopping server for ${serverInfo.companyName}...`);

  return new Promise((resolve) => {
    const proc = serverInfo.process;

    proc.once('exit', () => {
      serverProcesses.delete(userIdStr);
      log('info', `Server for ${serverInfo.companyName} stopped`);
      resolve();
    });

    proc.kill('SIGTERM');

    // Force kill after timeout
    setTimeout(() => {
      if (serverProcesses.has(userIdStr)) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  });
}

/**
 * Stop all running servers
 * @returns {Promise<void>}
 */
async function stopAllServers() {
  log('info', `Stopping ${serverProcesses.size} server(s)...`);

  const stopPromises = [];
  for (const userId of serverProcesses.keys()) {
    stopPromises.push(stopServerForUser(userId));
  }

  await Promise.all(stopPromises);
  log('info', 'All servers stopped');
}

/**
 * Restart all servers
 * @returns {Promise<void>}
 */
async function restartAllServers() {
  log('info', 'Restarting all servers...');
  await stopAllServers();
  await startAllServers();
}

/**
 * Get running server processes
 * @returns {Map} Server processes map
 */
function getServerProcesses() {
  return serverProcesses;
}

/**
 * Get server URLs
 * @returns {string[]} Array of URLs
 */
function getServerUrls() {
  const urls = [];
  for (const serverInfo of serverProcesses.values()) {
    urls.push(`https://localhost:${serverInfo.port}`);
  }
  return urls;
}

/**
 * Check if any servers are running
 * @returns {boolean}
 */
function hasRunningServers() {
  return serverProcesses.size > 0;
}

module.exports = {
  setLogFunction,
  startServerForSession,
  startAllServers,
  startAllServersQuick,
  stopServerForUser,
  stopAllServers,
  restartAllServers,
  getServerProcesses,
  getServerUrls,
  hasRunningServers,
  isPortAvailable,
  waitForServerReady
};
