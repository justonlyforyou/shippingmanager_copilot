/**
 * @fileoverview Port Demand History Store
 *
 * Tracks port demand changes over time for analytics.
 * Stores demand and consumed values for container (dry/refrigerated) and tanker (fuel/crude) cargo.
 *
 * @module server/database/stores/port-demand-store
 */

const logger = require('../../utils/logger');
const { getDb } = require('../index');

/**
 * Save demand data for multiple ports
 * Uses INSERT OR REPLACE to handle duplicates (same timestamp + port_code)
 *
 * @param {string} userId - User ID
 * @param {Array<Object>} ports - Array of port objects with demand data
 * @returns {Object} Save result with counts
 */
function saveDemandSnapshot(userId, ports) {
  if (!ports || ports.length === 0) {
    return { saved: 0, skipped: 0 };
  }

  const db = getDb(userId);
  const timestamp = Math.floor(Date.now() / 1000);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO port_demand_history (
      timestamp, port_code, port_name, country,
      dry_demand, dry_consumed,
      refrigerated_demand, refrigerated_consumed,
      fuel_demand, fuel_consumed,
      crude_demand, crude_consumed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let saved = 0;
  let skipped = 0;

  const insertMany = db.transaction((portsToSave) => {
    for (const port of portsToSave) {
      if (!port.code || !port.demand) {
        skipped++;
        continue;
      }

      const demand = port.demand;
      const consumed = port.consumed || {};

      insert.run(
        timestamp,
        port.code,
        port.name || port.code,
        port.country || null,
        demand.container?.dry || 0,
        consumed.container?.dry || 0,
        demand.container?.refrigerated || 0,
        consumed.container?.refrigerated || 0,
        demand.tanker?.fuel || 0,
        consumed.tanker?.fuel || 0,
        demand.tanker?.crude_oil || 0,
        consumed.tanker?.crude_oil || 0
      );
      saved++;
    }
  });

  try {
    insertMany(ports);
    logger.debug(`[PortDemandStore] Saved ${saved} ports, skipped ${skipped}`);
  } catch (err) {
    logger.error(`[PortDemandStore] Failed to save demand snapshot: ${err.message}`);
    return { saved: 0, skipped: ports.length, error: err.message };
  }

  return { saved, skipped };
}

/**
 * Get demand history for a specific port
 *
 * @param {string} userId - User ID
 * @param {string} portCode - Port code
 * @param {number} days - Number of days to look back (0 = all)
 * @returns {Array<Object>} Demand history entries
 */
function getPortHistory(userId, portCode, days = 7) {
  const db = getDb(userId);

  let query = `
    SELECT timestamp, port_code, port_name, country,
           dry_demand, dry_consumed,
           refrigerated_demand, refrigerated_consumed,
           fuel_demand, fuel_consumed,
           crude_demand, crude_consumed
    FROM port_demand_history
    WHERE port_code = ?
  `;

  const params = [portCode];

  if (days > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
    query += ' AND timestamp >= ?';
    params.push(cutoff);
  }

  query += ' ORDER BY timestamp DESC';

  return db.prepare(query).all(...params);
}

/**
 * Get latest demand for all ports
 *
 * @param {string} userId - User ID
 * @returns {Array<Object>} Latest demand for each port
 */
function getLatestDemand(userId) {
  const db = getDb(userId);

  const query = `
    SELECT h.timestamp, h.port_code, h.port_name, h.country,
           h.dry_demand, h.dry_consumed,
           h.refrigerated_demand, h.refrigerated_consumed,
           h.fuel_demand, h.fuel_consumed,
           h.crude_demand, h.crude_consumed
    FROM port_demand_history h
    INNER JOIN (
      SELECT port_code, MAX(timestamp) as max_ts
      FROM port_demand_history
      GROUP BY port_code
    ) latest ON h.port_code = latest.port_code AND h.timestamp = latest.max_ts
    ORDER BY h.port_code
  `;

  return db.prepare(query).all();
}

/**
 * Get demand trends for a port (hourly averages)
 *
 * @param {string} userId - User ID
 * @param {string} portCode - Port code
 * @param {number} days - Number of days to analyze (default: 7)
 * @returns {Array<Object>} Hourly averages
 */
function getPortTrends(userId, portCode, days = 7) {
  const db = getDb(userId);
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

  const query = `
    SELECT
      strftime('%H', timestamp, 'unixepoch') as hour,
      AVG(dry_demand) as avg_dry_demand,
      AVG(refrigerated_demand) as avg_ref_demand,
      AVG(fuel_demand) as avg_fuel_demand,
      AVG(crude_demand) as avg_crude_demand,
      COUNT(*) as sample_count
    FROM port_demand_history
    WHERE port_code = ? AND timestamp >= ?
    GROUP BY hour
    ORDER BY hour
  `;

  return db.prepare(query).all(portCode, cutoff);
}

/**
 * Get store statistics
 *
 * @param {string} userId - User ID
 * @returns {Object} Store statistics
 */
function getStoreStats(userId) {
  const db = getDb(userId);

  const countRow = db.prepare('SELECT COUNT(*) as total FROM port_demand_history').get();
  const portsRow = db.prepare('SELECT COUNT(DISTINCT port_code) as ports FROM port_demand_history').get();

  if (countRow.total === 0) {
    return {
      totalEntries: 0,
      uniquePorts: 0,
      oldestEntry: null,
      newestEntry: null,
      dataSpanDays: 0
    };
  }

  const oldest = db.prepare('SELECT MIN(timestamp) as ts FROM port_demand_history').get();
  const newest = db.prepare('SELECT MAX(timestamp) as ts FROM port_demand_history').get();

  const spanSeconds = newest.ts - oldest.ts;
  const spanDays = Math.ceil(spanSeconds / (24 * 60 * 60));

  return {
    totalEntries: countRow.total,
    uniquePorts: portsRow.ports,
    oldestEntry: new Date(oldest.ts * 1000).toISOString(),
    newestEntry: new Date(newest.ts * 1000).toISOString(),
    dataSpanDays: spanDays
  };
}

/**
 * Clean up old entries
 *
 * @param {string} userId - User ID
 * @param {number} daysToKeep - Days of data to keep (default: 30)
 * @returns {number} Number of deleted entries
 */
function cleanupOldEntries(userId, daysToKeep = 30) {
  const db = getDb(userId);
  const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);

  const result = db.prepare('DELETE FROM port_demand_history WHERE timestamp < ?').run(cutoff);
  logger.info(`[PortDemandStore] Cleaned up ${result.changes} entries older than ${daysToKeep} days`);

  return result.changes;
}

module.exports = {
  saveDemandSnapshot,
  getPortHistory,
  getLatestDemand,
  getPortTrends,
  getStoreStats,
  cleanupOldEntries
};
