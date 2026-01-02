/**
 * @fileoverview Server Configuration and Backup/Restore Routes
 *
 * This module handles server configuration (IP/Port) and backup/restore operations.
 * These settings are stored in the Python launcher's settings.json file.
 *
 * @module server/routes/server-config
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const unzipper = require('unzipper');
const multer = require('multer');
const logger = require('../utils/logger');
const { isPackaged, getAppBaseDir } = require('../config');
const { marked } = require('marked');
const { getUserId } = require('../utils/api');
const { getMetadata, setMetadata, getGlobalSetting, setGlobalSetting, getAccount, setAccountPort } = require('../database');

// Get settings directory for devel.json check
const isPkg = isPackaged();
const SETTINGS_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'settings')
  : path.join(__dirname, '../../userdata/settings');

// Get userdata directory for backup/restore
const USERDATA_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata')
  : path.join(__dirname, '../../userdata');

// Configure multer for file uploads (memory storage for ZIP files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || path.extname(file.originalname).toLowerCase() === '.zip') {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

/**
 * GET /api/server-config - Get current server configuration (IP/Port)
 * Reads host from accounts_metadata, port from accounts table for current user
 */
router.get('/server-config', async (req, res) => {
  try {
    // Read host from global settings (accounts_metadata)
    const host = getGlobalSetting('host');
    const logLevel = getGlobalSetting('logLevel');

    // Read port from accounts table for current user
    const userId = getUserId();
    let port = 12345; // Default fallback
    if (userId) {
      const account = getAccount(userId);
      if (account) {
        port = account.port;
      }
    }

    // Check devel.json for debug mode
    const develFile = path.join(SETTINGS_DIR, 'devel.json');
    const debugMode = fss.existsSync(develFile);

    // Validate required fields
    if (!host) {
      throw new Error('host not found in database');
    }

    res.json({
      success: true,
      config: {
        host: host,
        port: port,
        debugMode: debugMode,
        logLevel: logLevel || 'info'
      }
    });
  } catch (error) {
    logger.error('[Server Config] Error reading settings:', error.message);
    res.status(500).json({ error: 'Failed to read server configuration: ' + error.message });
  }
});

/**
 * GET /api/server-config/interfaces - Get all available network interfaces
 */
router.get('/server-config/interfaces', (req, res) => {
  try {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    // Always add localhost first
    addresses.push({
      name: 'Localhost',
      address: '127.0.0.1',
      family: 'IPv4',
      internal: true
    });

    // Add all external IPv4 addresses
    for (const [name, nets] of Object.entries(interfaces)) {
      for (const net of nets) {
        // Skip internal/loopback and IPv6
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push({
            name: name,
            address: net.address,
            family: net.family,
            internal: false
          });
        }
      }
    }

    // Add 0.0.0.0 option at the end with list of all IPs
    const externalIPs = addresses.filter(a => !a.internal).map(a => a.address);
    addresses.push({
      name: 'All Interfaces',
      address: '0.0.0.0',
      family: 'IPv4',
      internal: false,
      allIPs: ['127.0.0.1', ...externalIPs]
    });

    res.json({
      success: true,
      interfaces: addresses
    });
  } catch (error) {
    logger.error('[Server Config] Error getting network interfaces:', error);
    res.status(500).json({ error: 'Failed to get network interfaces' });
  }
});

/**
 * POST /api/server-config - Update server configuration (IP/Port)
 * Writes host to accounts_metadata, port to accounts table for current user
 * NOTE: Server restart required for changes to take effect
 */
router.post('/server-config', async (req, res) => {
  try {
    const { host, port } = req.body;

    // Validate host
    if (!host || typeof host !== 'string') {
      return res.status(400).json({ error: 'Host is required' });
    }

    // Validate port
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Port must be a number between 1 and 65535' });
    }

    // Get current logLevel from database
    const currentLogLevel = getGlobalSetting('logLevel') || 'info';

    // Check devel.json for debug mode
    const develFile = path.join(SETTINGS_DIR, 'devel.json');
    const debugMode = fss.existsSync(develFile);

    // Write host to global settings (accounts_metadata)
    setGlobalSetting('host', host.trim());

    // Write port to accounts table for current user
    const userId = getUserId();
    if (userId) {
      setAccountPort(userId, port);
      logger.info(`[Server Config] Updated settings: host=${host.trim()}, port=${port} for user ${userId}`);
    } else {
      logger.warn('[Server Config] No userId available, port not saved to database');
    }

    res.json({
      success: true,
      message: 'Server configuration updated. Server will restart automatically.',
      config: {
        host: host.trim(),
        port: port,
        debugMode: debugMode,
        logLevel: currentLogLevel
      },
      requiresRestart: true,
      newUrl: `https://${host.trim()}:${port}`
    });
  } catch (error) {
    logger.error('[Server Config] Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save server configuration' });
  }
});

/**
 * POST /api/server/restart - Request server restart
 * Exit code 100 signals launcher to restart the server
 */
router.post('/server/restart', (req, res) => {
  logger.info('[Server] Restart requested via API');

  res.json({
    success: true,
    message: 'Server restarting...'
  });

  // Give response time to send, then exit with restart code
  setTimeout(() => {
    logger.info('[Server] Exiting with code 100 (restart)');
    process.exit(100);
  }, 1000);
});

/**
 * POST /api/backup/create - Create backup of userdata directory
 */
router.post('/backup/create', async (req, res) => {
  try {
    logger.info('[Backup] Creating backup...');

    // Set response headers for file download
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `SMCoPilot_Backup_${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Create archiver instance
    const archive = archiver('zip', { zlib: { level: 9 } });

    // Pipe archive to response
    archive.pipe(res);

    // Add metadata file
    const metadata = {
      version: '1.0',
      created: new Date().toISOString(),
      source: 'ShippingManagerCoPilot',
      execution_mode: isPkg ? 'exe' : 'script'
    };
    archive.append(JSON.stringify(metadata, null, 2), { name: 'backup_metadata.json' });

    // Add all files from userdata directory
    archive.directory(USERDATA_DIR, 'userdata');

    // Finalize archive
    await archive.finalize();

    logger.info(`[Backup] Backup created successfully: ${filename}`);
  } catch (error) {
    logger.error('[Backup] Error creating backup:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create backup' });
    }
  }
});

/**
 * POST /api/backup/restore - Restore backup from uploaded ZIP file
 */
router.post('/backup/restore', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No backup file uploaded' });
    }

    logger.info('[Backup] Restoring backup from uploaded file...');

    // Create temporary backup of current data
    const tempBackupDir = path.join(path.dirname(USERDATA_DIR), `userdata_backup_${Date.now()}`);
    logger.info(`[Backup] Creating temporary backup at: ${tempBackupDir}`);

    try {
      // Check if userdata exists before backing it up
      const userdataExists = fss.existsSync(USERDATA_DIR);
      if (userdataExists) {
        await fs.cp(USERDATA_DIR, tempBackupDir, { recursive: true });
        logger.info('[Backup] Current data backed up successfully');
      }

      // Validate ZIP file
      const buffer = req.file.buffer;
      const directory = await unzipper.Open.buffer(buffer);

      // Check for metadata file
      const hasMetadata = directory.files.some(f => f.path === 'backup_metadata.json');
      if (!hasMetadata) {
        throw new Error('Invalid backup: missing metadata file');
      }

      // Check for userdata directory
      const hasUserdata = directory.files.some(f => f.path.startsWith('userdata/'));
      if (!hasUserdata) {
        throw new Error('Invalid backup: no userdata folder found');
      }

      // Extract ZIP to parent directory (will create userdata folder)
      logger.info('[Backup] Extracting backup files...');
      const parentDir = path.dirname(USERDATA_DIR);

      // Remove existing userdata directory if it exists
      if (userdataExists) {
        await fs.rm(USERDATA_DIR, { recursive: true, force: true });
      }

      // Extract files
      await directory.extract({ path: parentDir });

      // Remove temp backup after successful restore
      if (fss.existsSync(tempBackupDir)) {
        await fs.rm(tempBackupDir, { recursive: true, force: true });
        logger.info('[Backup] Removed temporary backup');
      }

      logger.info('[Backup] Backup restored successfully');
      res.json({
        success: true,
        message: 'Backup restored successfully! Please restart the server to apply changes.'
      });

    } catch (error) {
      // Restore from temp backup if something went wrong
      logger.error('[Backup] Error during restore:', error);

      if (fss.existsSync(tempBackupDir)) {
        logger.info('[Backup] Restoring from temporary backup...');

        // Remove failed userdata directory
        if (fss.existsSync(USERDATA_DIR)) {
          await fs.rm(USERDATA_DIR, { recursive: true, force: true });
        }

        // Restore from temp backup
        await fs.cp(tempBackupDir, USERDATA_DIR, { recursive: true });
        await fs.rm(tempBackupDir, { recursive: true, force: true });

        logger.info('[Backup] Recovered from temporary backup');
      }

      throw error;
    }
  } catch (error) {
    logger.error('[Backup] Error restoring backup:', error);
    res.status(500).json({ error: error.message || 'Failed to restore backup' });
  }
});

/**
 * GET /api/backup/info - Get backup information (userdata directory size, file count, etc.)
 */
router.get('/backup/info', async (req, res) => {
  try {
    // Get directory stats
    const stats = await getDirectoryStats(USERDATA_DIR);

    res.json({
      success: true,
      info: {
        path: USERDATA_DIR,
        fileCount: stats.fileCount,
        totalSize: stats.totalSize,
        lastModified: stats.lastModified
      }
    });
  } catch (error) {
    logger.error('[Backup] Error getting backup info:', error);
    res.status(500).json({ error: 'Failed to get backup information' });
  }
});

/**
 * Helper function to get directory statistics
 */
async function getDirectoryStats(dirPath) {
  let fileCount = 0;
  let totalSize = 0;
  let lastModified = 0;

  async function scan(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scan(fullPath);
        } else {
          fileCount++;
          const stat = await fs.stat(fullPath);
          totalSize += stat.size;
          if (stat.mtimeMs > lastModified) {
            lastModified = stat.mtimeMs;
          }
        }
      }
    } catch (error) {
      logger.warn(`[Backup] Error scanning directory ${dir}:`, error.message);
    }
  }

  await scan(dirPath);

  return {
    fileCount,
    totalSize,
    lastModified: lastModified > 0 ? new Date(lastModified).toISOString() : null
  };
}

// =============================================================================
// Changelog Endpoints
// =============================================================================

/**
 * GET /api/changelog - Get changelog and acknowledgment status
 * Returns current version, changelog HTML, and whether user has acknowledged
 */
router.get('/changelog', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Get the exe directory (for packaged mode) or project root (for dev mode)
    // In SEA mode: package.json and CHANGELOG.md are in same dir as exe
    // In dev mode: they're in project root
    const baseDir = isPkg
      ? path.dirname(process.execPath)
      : path.join(__dirname, '../..');

    // Get version from package.json
    const packageJsonPath = path.join(baseDir, 'package.json');

    let version = '0.0.0';
    try {
      const packageData = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      version = packageData.version;
    } catch (err) {
      logger.warn('[Changelog] Could not read package.json at', packageJsonPath, ':', err.message);
    }

    // Get changelog content
    const changelogPath = path.join(baseDir, 'CHANGELOG.md');

    let changelogHtml = '<p>No changelog available.</p>';
    try {
      const changelogMd = await fs.readFile(changelogPath, 'utf8');
      changelogHtml = marked(changelogMd);
    } catch (err) {
      logger.warn('[Changelog] Could not read CHANGELOG.md at', changelogPath, ':', err.message);
    }

    // Check if current version is acknowledged (stored in database)
    const acknowledgedVersion = getMetadata(userId, 'changelog_acknowledged_version');
    const acknowledged = acknowledgedVersion === version;

    res.json({
      success: true,
      version,
      changelog: changelogHtml,
      acknowledged
    });
  } catch (error) {
    logger.error('[Changelog] Error getting changelog:', error.message);
    res.status(500).json({ error: 'Failed to get changelog' });
  }
});

/**
 * POST /api/changelog/acknowledge - Acknowledge current version's changelog
 * Saves the current version to database so popup won't show again
 */
router.post('/changelog/acknowledge', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Get version from package.json
    const baseDir = isPkg
      ? path.dirname(process.execPath)
      : path.join(__dirname, '../..');
    const packageJsonPath = path.join(baseDir, 'package.json');

    let version = '0.0.0';
    try {
      const packageData = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      version = packageData.version;
    } catch (err) {
      logger.warn('[Changelog] Could not read package.json:', err.message);
    }

    // Save acknowledged version to database
    setMetadata(userId, 'changelog_acknowledged_version', version);

    logger.info(`[Changelog] User ${userId} acknowledged version ${version}`);

    // Broadcast to all connected clients via WebSocket
    const { broadcast } = require('../websocket/broadcaster');
    broadcast('changelog_acknowledged', { version });

    res.json({
      success: true,
      message: 'Changelog acknowledged',
      version
    });
  } catch (error) {
    logger.error('[Changelog] Error acknowledging changelog:', error.message);
    res.status(500).json({ error: 'Failed to acknowledge changelog' });
  }
});

module.exports = router;
