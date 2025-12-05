/**
 * @fileoverview Broadcast Templates API Routes
 *
 * Manages broadcast message templates that can be sent to all alliance members via DM.
 * Templates are stored per-user in userdata/broadcast-templates/{userId}.json
 *
 * Features:
 * - CRUD operations for broadcast templates (key + message text)
 * - Send broadcast to all alliance members (sends DM to each member)
 * - Rate limiting to prevent spam
 *
 * @module server/routes/broadcast
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { getUserId, apiCall } = require('../utils/api');
const { getAppBaseDir } = require('../config');
const logger = require('../utils/logger');

// Determine data directory based on environment
const isPkg = !!process.pkg;
const BROADCAST_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'broadcast-templates')
  : path.join(__dirname, '../../userdata/broadcast-templates');

/**
 * Ensures broadcast templates directory exists
 */
async function ensureDirectory() {
  try {
    await fs.mkdir(BROADCAST_DIR, { recursive: true });
  } catch (err) {
    logger.error('[Broadcast] Failed to create directory:', err);
  }
}

ensureDirectory();

/**
 * Gets the templates file path for a user
 * @param {string} userId - User ID
 * @returns {string} File path
 */
function getTemplatesFilePath(userId) {
  return path.join(BROADCAST_DIR, `${userId}.json`);
}

/**
 * Loads templates for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Templates object { key: { message, subject } }
 */
async function loadTemplates(userId) {
  const filePath = getTemplatesFilePath(userId);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    // File doesn't exist or is invalid - return empty object
    return {};
  }
}

/**
 * Saves templates for a user
 * @param {string} userId - User ID
 * @param {Object} templates - Templates object
 */
async function saveTemplates(userId, templates) {
  const filePath = getTemplatesFilePath(userId);
  await fs.writeFile(filePath, JSON.stringify(templates, null, 2), 'utf8');
}

/**
 * GET /api/broadcast/templates
 * Get all broadcast templates for current user
 */
router.get('/templates', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'User not logged in' });
    }

    const templates = await loadTemplates(userId);
    res.json({ templates });
  } catch (error) {
    logger.error('[Broadcast] Error loading templates:', error);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

/**
 * POST /api/broadcast/templates
 * Create or update a broadcast template
 * Body: { key: string, subject: string, message: string }
 */
router.post('/templates', express.json(), async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'User not logged in' });
    }

    const { key, subject, message } = req.body;

    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      return res.status(400).json({ error: 'Template key is required' });
    }

    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      return res.status(400).json({ error: 'Subject is required' });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Max 900 characters for message (game API limit)
    if (message.trim().length > 900) {
      return res.status(400).json({ error: 'Message cannot exceed 900 characters' });
    }

    // Validate key format (alphanumeric + underscore + hyphen only)
    const keyRegex = /^[a-zA-Z0-9_-]+$/;
    if (!keyRegex.test(key.trim())) {
      return res.status(400).json({ error: 'Key can only contain letters, numbers, underscore and hyphen' });
    }

    const templates = await loadTemplates(userId);
    templates[key.trim().toLowerCase()] = {
      subject: subject.trim(),
      message: message.trim(),
      enabled: false,
      updatedAt: Date.now()
    };

    await saveTemplates(userId, templates);

    logger.info(`[Broadcast] Template saved: ${key} by user ${userId}`);
    res.json({ success: true, templates });
  } catch (error) {
    logger.error('[Broadcast] Error saving template:', error);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

/**
 * DELETE /api/broadcast/templates/:key
 * Delete a broadcast template
 */
router.delete('/templates/:key', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'User not logged in' });
    }

    const { key } = req.params;

    if (!key) {
      return res.status(400).json({ error: 'Template key is required' });
    }

    const templates = await loadTemplates(userId);

    if (!templates[key]) {
      return res.status(404).json({ error: 'Template not found' });
    }

    delete templates[key];
    await saveTemplates(userId, templates);

    logger.info(`[Broadcast] Template deleted: ${key} by user ${userId}`);
    res.json({ success: true, templates });
  } catch (error) {
    logger.error('[Broadcast] Error deleting template:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

/**
 * POST /api/broadcast/templates/:key/toggle
 * Toggle enabled state of a broadcast template
 */
router.post('/templates/:key/toggle', async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'User not logged in' });
    }

    const { key } = req.params;

    if (!key) {
      return res.status(400).json({ error: 'Template key is required' });
    }

    const templates = await loadTemplates(userId);

    if (!templates[key]) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Toggle enabled state
    templates[key].enabled = !templates[key].enabled;
    await saveTemplates(userId, templates);

    logger.info(`[Broadcast] Template ${key} ${templates[key].enabled ? 'enabled' : 'disabled'} by user ${userId}`);
    res.json({ success: true, templates });
  } catch (error) {
    logger.error('[Broadcast] Error toggling template:', error);
    res.status(500).json({ error: 'Failed to toggle template' });
  }
});

/**
 * POST /api/broadcast/send
 * Send a broadcast message to alliance members
 * Body: { key: string, targetUserId?: number } - template key and optional single recipient
 *
 * If targetUserId is provided, sends only to that user
 * If targetUserId is not provided, sends to ALL alliance members
 *
 * Returns: { success: true, sent: number, failed: number, errors: string[] }
 */
router.post('/send', express.json(), async (req, res) => {
  try {
    const userId = getUserId();
    if (!userId) {
      return res.status(401).json({ error: 'User not logged in' });
    }

    const { key, targetUserId } = req.body;

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Template key is required' });
    }

    // Load template
    const templates = await loadTemplates(userId);
    const template = templates[key.toLowerCase()];

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    let recipients = [];

    if (targetUserId) {
      // Single user mode - send only to specified user
      const targetId = parseInt(targetUserId);
      if (isNaN(targetId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }

      // Get alliance members to find the target user's name
      const membersResponse = await apiCall('/alliance/get-alliance-members', 'POST', {});
      const members = membersResponse?.data?.members || membersResponse?.members || [];
      const targetMember = members.find(m => m.user_id === targetId);

      if (targetMember) {
        recipients = [targetMember];
      } else {
        // User not in alliance, but still try to send
        recipients = [{ user_id: targetId, company_name: `User ${targetId}` }];
      }

      logger.info(`[Broadcast] Sending "${key}" to single user: ${targetId}`);
    } else {
      // Broadcast mode - send to all alliance members
      const membersResponse = await apiCall('/alliance/get-alliance-members', 'POST', {});
      const members = membersResponse?.data?.members || membersResponse?.members || [];

      if (members.length === 0) {
        return res.status(400).json({ error: 'No alliance members found' });
      }

      // Filter out self
      recipients = members.filter(m => m.user_id !== parseInt(userId));

      if (recipients.length === 0) {
        return res.status(400).json({ error: 'No other alliance members to send to' });
      }

      logger.info(`[Broadcast] Sending "${key}" to ${recipients.length} members`);
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    // Send to each member with delay to avoid rate limiting
    for (const member of recipients) {
      try {
        await apiCall('/messenger/send-message', 'POST', {
          subject: template.subject,
          body: template.message,
          recipient: member.user_id
        });
        sent++;
        logger.debug(`[Broadcast] Sent to ${member.company_name} (${member.user_id})`);

        // Small delay between messages to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        failed++;
        const errorMsg = `Failed to send to ${member.company_name}: ${err.message}`;
        errors.push(errorMsg);
        logger.warn(`[Broadcast] ${errorMsg}`);
      }
    }

    logger.info(`[Broadcast] Completed: ${sent} sent, ${failed} failed`);

    res.json({
      success: true,
      sent,
      failed,
      total: recipients.length,
      errors: errors.slice(0, 5) // Return max 5 errors
    });
  } catch (error) {
    logger.error('[Broadcast] Error sending broadcast:', error);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

module.exports = router;
