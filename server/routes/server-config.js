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
const archiver = require('archiver');
const unzipper = require('unzipper');
const multer = require('multer');
const logger = require('../utils/logger');

// Get Python settings directory - matches start.py logic
const isPkg = !!process.pkg;
const PYTHON_SETTINGS_DIR = isPkg
  ? path.join(process.env.LOCALAPPDATA, 'ShippingManagerCoPilot', 'settings')
  : path.join(__dirname, '../../userdata/settings');
const PYTHON_SETTINGS_FILE = path.join(PYTHON_SETTINGS_DIR, 'settings.json');

// Get userdata directory for backup/restore
const USERDATA_DIR = isPkg
  ? path.join(process.env.LOCALAPPDATA, 'ShippingManagerCoPilot', 'userdata')
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
 */
router.get('/server-config', async (req, res) => {
  try {
    // Read Python settings file
    const data = await fs.readFile(PYTHON_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(data);

    res.json({
      success: true,
      config: {
        port: settings.port || 12345,
        host: settings.host || '127.0.0.1',
        debugMode: settings.debugMode || false,
        logLevel: settings.logLevel || 'info'
      }
    });
  } catch (error) {
    logger.error('[Server Config] Error reading settings:', error.message);

    // Return defaults if file doesn't exist
    if (error.code === 'ENOENT') {
      res.json({
        success: true,
        config: {
          port: 12345,
          host: '127.0.0.1',
          debugMode: false,
          logLevel: 'info'
        }
      });
    } else {
      res.status(500).json({ error: 'Failed to read server configuration' });
    }
  }
});

/**
 * POST /api/server-config - Update server configuration (IP/Port)
 * NOTE: Server restart required for changes to take effect
 */
router.post('/server-config', async (req, res) => {
  try {
    const { port, host } = req.body;

    // Validate port
    const portNum = parseInt(port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return res.status(400).json({ error: 'Port must be between 1 and 65535' });
    }

    // Validate host
    if (!host || typeof host !== 'string') {
      return res.status(400).json({ error: 'Host is required' });
    }

    // Read current settings
    let currentSettings = { port: 12345, host: '127.0.0.1', debugMode: false, logLevel: 'info' };
    try {
      const data = await fs.readFile(PYTHON_SETTINGS_FILE, 'utf8');
      currentSettings = JSON.parse(data);
    } catch {
      // File doesn't exist, use defaults
      logger.debug('[Server Config] Settings file not found, using defaults');
    }

    // Merge with new values
    const updatedSettings = {
      port: portNum,
      host: host.trim(),
      debugMode: currentSettings.debugMode || false,
      logLevel: currentSettings.logLevel || 'info'
    };

    // Ensure directory exists
    await fs.mkdir(PYTHON_SETTINGS_DIR, { recursive: true });

    // Write updated settings
    await fs.writeFile(PYTHON_SETTINGS_FILE, JSON.stringify(updatedSettings, null, 2), 'utf8');

    logger.info(`[Server Config] Updated settings: port=${portNum}, host=${host.trim()}`);

    res.json({
      success: true,
      message: 'Server configuration updated. Please restart the server for changes to take effect.',
      config: updatedSettings,
      requiresRestart: true
    });
  } catch (error) {
    logger.error('[Server Config] Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save server configuration' });
  }
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

module.exports = router;
