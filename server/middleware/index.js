/**
 * @fileoverview Express Middleware Configuration and Setup
 *
 * This module centralizes all middleware configuration for the Express application,
 * including security headers, rate limiting, body parsing, and static file serving.
 * It provides a single point of configuration for application-wide middleware concerns.
 *
 * Key Features:
 * - Security headers via Helmet (customized for network access requirements)
 * - Two-tier rate limiting (global + message-specific)
 * - JSON body parsing with size limits
 * - Static file serving for frontend assets
 *
 * Why This Architecture:
 * - Separates middleware concerns from main app.js logic
 * - Centralizes security and performance configuration
 * - Provides reusable rate limiters for different endpoint types
 * - Ensures consistent middleware application order
 *
 * Middleware Application Order (Critical):
 * 1. Helmet (security headers)
 * 2. Body parser (JSON parsing)
 * 3. Static files (public/ directory)
 * 4. Global rate limiter
 * 5. Routes (defined in app.js)
 * 6. Message-specific limiter (applied per-route)
 *
 * Security Posture:
 * - Helmet disabled CSP to allow network access (192.168.x.x)
 * - Rate limiting prevents API abuse and DoS attacks
 * - 50KB body limit allows history storage while preventing excessive payloads
 * - CORS headers disabled for cross-origin access from LAN devices
 *
 * @requires express - Web framework and middleware
 * @requires helmet - Security header middleware
 * @requires express-rate-limit - Rate limiting middleware
 * @requires ../config - Configuration constants (rate limit settings)
 * @module server/middleware/index
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('../config');

/**
 * Configures and applies all application-wide middleware to the Express app.
 *
 * This function sets up the complete middleware stack in the correct order.
 * Order matters - security headers must be first, body parsing before routes, etc.
 *
 * Helmet Configuration:
 * - contentSecurityPolicy: false - Allows accessing server via network IPs (192.168.x.x)
 * - strictTransportSecurity: false - Self-signed certs require manual certificate warning bypass;
 *   HSTS would prevent users from accessing /ca-cert.pem to install the CA certificate,
 *   creating a Catch-22 where users cannot bypass warnings to get the trusted cert
 * - CORS headers disabled - Enables access from other devices on LAN
 * - This is necessary for LAN accessibility but reduces some security protections
 * - Trade-off accepted for single-user LAN deployment model
 *
 * Body Parser Configuration:
 * - Limit: 50KB - Allows for hijacking negotiation history storage
 * - JSON only - No form data or multipart parsing needed
 * - Auto-rejects requests with Content-Type mismatch
 *
 * Static Files:
 * - Serves public/ directory for HTML, CSS, JS, images
 * - No directory listing enabled (Express default)
 * - Caching headers set automatically by Express
 *
 * Rate Limiting:
 * - Global: 1000 requests per 15 minutes (all endpoints)
 * - Message-specific: Applied separately in routes (30/min)
 * - Sliding window algorithm (default in express-rate-limit)
 * - Returns 429 Too Many Requests when exceeded
 *
 * Why This Order:
 * 1. Helmet first - Sets security headers before any processing
 * 2. Body parser - Needed by routes to read request bodies
 * 3. Static files - Serve static assets before route handlers
 * 4. Rate limiter - Applied after static files (no rate limit on CSS/JS)
 *
 * Side Effects:
 * - Modifies app instance with app.use() calls
 * - Registers middleware in Express middleware stack
 * - No return value (mutates app object)
 *
 * @function setupMiddleware
 * @param {Express} app - Express application instance
 * @returns {void}
 *
 * @example
 * const express = require('express');
 * const { setupMiddleware } = require('./server/middleware');
 *
 * const app = express();
 * setupMiddleware(app);
 * // Middleware now configured, ready to define routes
 */
function setupMiddleware(app) {
  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
    originAgentCluster: false,
    strictTransportSecurity: false  // Self-signed certs require manual certificate warning bypass
  }));

  // Body parser middleware
  // Increased limit for vessel image uploads (base64 encoded images can be large)
  app.use(express.json({ limit: '20mb' }));

  // Static files
  // When running as .exe (pkg), use __dirname which points to snapshot directory
  // When running as .js (dev), __dirname points to server/middleware, so go up two levels
  const baseDir = process.pkg ? path.join(__dirname, '..', '..') : path.join(__dirname, '..', '..');
  app.use(express.static(path.join(baseDir, 'public')));
  app.use('/data', express.static(path.join(baseDir, 'data')));

  // Global rate limiter
  const limiter = rateLimit(config.RATE_LIMIT);
  app.use(limiter);
}

/**
 * Stricter rate limiter specifically for message-sending endpoints.
 *
 * This rate limiter is more restrictive than the global limiter to prevent
 * chat spam and API abuse on message endpoints. It's applied selectively
 * to routes that send messages (alliance chat, private messages).
 *
 * Why Separate Message Limiter:
 * - Prevents chat spam (30 messages per minute max)
 * - More restrictive than global limiter (1000 req/15min)
 * - Protects game API from abuse via our proxy
 * - Reduces risk of account flagging/banning for ToS violations
 *
 * Configuration:
 * - Limit: 30 requests per 1 minute (config.MESSAGE_RATE_LIMIT)
 * - Window: 60 seconds (sliding window)
 * - Response: 429 Too Many Requests when exceeded
 * - Message: "Too many requests, please try again later"
 *
 * Applied To:
 * - POST /api/send-message (alliance chat)
 * - POST /api/messenger/send-private (private messages)
 * - Any other message-sending endpoints added in the future
 *
 * Not Applied To:
 * - GET endpoints (reading data)
 * - Static files (CSS, JS, images)
 * - WebSocket connections (separate rate limiting not needed)
 *
 * Usage Pattern:
 * - Import in route files: const { messageLimiter } = require('../middleware')
 * - Apply to specific routes: router.post('/send-message', messageLimiter, handler)
 * - Order: messageLimiter before route handler function
 *
 * @constant {RateLimitMiddleware} messageLimiter
 *
 * @example
 * // In server/routes/alliance.js
 * const { messageLimiter } = require('../middleware');
 * router.post('/send-message', messageLimiter, async (req, res) => {
 *   // Max 30 calls per minute per IP
 * });
 */
const messageLimiter = rateLimit(config.MESSAGE_RATE_LIMIT);

module.exports = {
  setupMiddleware,
  messageLimiter
};
