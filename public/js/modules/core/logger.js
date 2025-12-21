/**
 * @fileoverview Frontend Logger Utility
 *
 * Centralized logging for frontend modules with log level support.
 * Respects window.DEBUG_MODE setting from server config.
 *
 * Log Levels:
 * - debug: Only shown when DEBUG_MODE is true (verbose/development)
 * - info: Always shown (important status messages)
 * - warn: Always shown (warnings)
 * - error: Always shown (errors)
 *
 * @module core/logger
 */

/**
 * Frontend logger with debug mode support
 */
const logger = {
  /**
   * Debug level - only logs when window.DEBUG_MODE is true
   * Use for verbose development/debugging output
   * @param {...any} args - Arguments to log
   */
  debug: (...args) => {
    if (window.DEBUG_MODE) {
      console.log(...args);
    }
  },

  /**
   * Info level - always logs
   * Use for important status messages that should always be visible
   * @param {...any} args - Arguments to log
   */
  info: (...args) => {
    console.log(...args);
  },

  /**
   * Warning level - always logs
   * @param {...any} args - Arguments to log
   */
  warn: (...args) => {
    console.warn(...args);
  },

  /**
   * Error level - always logs
   * @param {...any} args - Arguments to log
   */
  error: (...args) => {
    console.error(...args);
  }
};

export default logger;
