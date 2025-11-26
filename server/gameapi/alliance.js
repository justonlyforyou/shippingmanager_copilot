/**
 * @fileoverview Alliance API Client Module
 *
 * This module handles alliance-related API calls including:
 * - Fetching user's current contribution points
 * - Alliance member statistics
 *
 * @requires ../utils/api - API helper functions
 * @requires ../utils/logger - Logging utility
 * @module server/gameapi/alliance
 */

const { apiCall, getAllianceId } = require('../utils/api');
const logger = require('../utils/logger');

// Cache for last known contribution value per user
// Key: userId, Value: { contribution: number, timestamp: number }
const contributionCache = new Map();
const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the current user's alliance contribution points with retry and caching
 *
 * Returns the user's current season contribution score from the alliance members API.
 * Used for tracking contribution gains from vessel departures.
 *
 * Features:
 * - Retries once on failure
 * - Falls back to cached value if API fails (within 5 min)
 * - Returns null if user not in alliance OR if we can't get reliable data
 * - Returns number only when we have a reliable value (from API or fresh cache)
 *
 * @async
 * @param {number} userId - User ID to fetch contribution for
 * @returns {Promise<number|null>} Current contribution points, or null if unavailable
 *
 * @example
 * const contribution = await fetchUserContribution(12345);
 * // Returns: 16033 (current season contribution)
 * // Returns: null (user not in alliance or API failed)
 */
async function fetchUserContribution(userId) {
  // Get user's alliance ID
  const allianceId = getAllianceId();

  if (!allianceId) {
    // User not in alliance - contribution tracking not applicable
    logger.debug('[Contribution] User not in alliance');
    return null;
  }

  // Try to fetch from API (with retry)
  let data;
  let retryCount = 0;
  const maxRetries = 1;

  while (retryCount <= maxRetries) {
    try {
      data = await apiCall('/alliance/get-alliance-members', 'POST', {
        alliance_id: allianceId,
        lifetime_stats: false,
        last_24h_stats: false,
        last_season_stats: false,
        include_last_season_top_contributors: false
      });

      // Validate API response structure
      if (data && data.data && data.data.members) {
        break; // Success
      }

      logger.warn(`[Contribution] Invalid API response (attempt ${retryCount + 1})`);
      retryCount++;

    } catch (error) {
      logger.warn(`[Contribution] API call failed (attempt ${retryCount + 1}): ${error.message}`);
      retryCount++;
    }
  }

  // If all retries failed, try cache (but only if fresh)
  if (!data || !data.data || !data.data.members) {
    const cached = contributionCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CACHE_MAX_AGE_MS) {
      logger.warn(`[Contribution] Using cached value: ${cached.contribution}`);
      return cached.contribution;
    }
    // API failed and no valid cache - return null (can't calculate reliably)
    logger.error('[Contribution] API failed and no valid cache');
    return null;
  }

  // Find the user in the members list
  const member = data.data.members.find(m => m.user_id === userId);

  if (!member) {
    // User not found in alliance - this is unusual
    logger.warn(`[Contribution] User ${userId} not found in alliance ${allianceId} members`);
    // Try cache as fallback
    const cached = contributionCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CACHE_MAX_AGE_MS) {
      return cached.contribution;
    }
    return null;
  }

  // Get contribution value
  if (typeof member.contribution !== 'number') {
    logger.warn(`[Contribution] Invalid contribution type: ${typeof member.contribution}`);
    return null;
  }

  const contribution = member.contribution;

  // Update cache
  contributionCache.set(userId, {
    contribution: contribution,
    timestamp: Date.now()
  });

  logger.debug(`[Contribution] User ${userId} contribution = ${contribution}`);
  return contribution;
}

module.exports = {
  fetchUserContribution
};
