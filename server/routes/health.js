/**
 * @fileoverview Health Check Endpoint
 *
 * Provides HTTP health check endpoint for monitoring server status.
 * Used by start.py to detect when server is fully initialized.
 *
 * @module server/routes/health
 */

const express = require('express');
const router = express.Router();

/**
 * Health check endpoint
 * Returns server status and ready state
 *
 * @route GET /health
 * @returns {Object} { status: "ok"|"error", ready: boolean, error?: Object, timestamp: ISO8601 }
 */
router.get('/', (req, res) => {
  const { isServerReady, getInitError } = require('../scheduler');

  // Allow cross-origin requests (for launcher dialog health polling)
  res.setHeader('Access-Control-Allow-Origin', '*');

  const initError = getInitError();
  const ready = isServerReady();

  res.json({
    status: initError ? 'error' : 'ok',
    ready: ready,
    error: initError,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
