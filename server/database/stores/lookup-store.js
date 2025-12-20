/**
 * @fileoverview SQLite-based Lookup Store (POD4)
 *
 * Drop-in replacement for the JSON-based lookup store.
 * Combines data from POD1 (transactions), POD2 (autopilot log), POD3 (vessel history).
 *
 * @module server/database/stores/lookup-store
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { getDb, setMetadata, getMetadata } = require('../index');

// Store version - increment when matching logic changes
const STORE_VERSION = 3;

// Context to type/value mapping
const CONTEXT_MAPPING = {
  'vessels_departed': { type: 'Departure', value: 'INCOME' },
  'sell_stock': { type: 'Stock Sale', value: 'INCOME' },
  'Increase_shares': { type: 'Dividends', value: 'INCOME' },
  'sell_vessel': { type: 'Vessel Sale', value: 'INCOME' },
  'Sold_vessel_in_port': { type: 'Vessel Sale', value: 'INCOME' },
  'daily_bonus': { type: 'Bonus', value: 'INCOME' },
  'ad_video': { type: 'Ad Bonus', value: 'INCOME' },
  'fuel_purchased': { type: 'Fuel', value: 'EXPENSE' },
  'co2_emission_quota': { type: 'CO2', value: 'EXPENSE' },
  'bulk_wear_maintenance': { type: 'Repair', value: 'EXPENSE' },
  'bulk_vessel_major_service': { type: 'Drydock', value: 'EXPENSE' },
  'vessel_major_service': { type: 'Drydock', value: 'EXPENSE' },
  'buy_vessel': { type: 'Vessel Purchase', value: 'EXPENSE' },
  'Vessel_build_Purchase': { type: 'Vessel Build', value: 'EXPENSE' },
  'purchase_stock': { type: 'Stock Purchase', value: 'EXPENSE' },
  'anchor_points': { type: 'Anchor', value: 'EXPENSE' },
  'marketing_campaign_activation': { type: 'Marketing', value: 'EXPENSE' },
  'route_fee_on_creating': { type: 'Route Fee', value: 'EXPENSE' },
  'salary_payment': { type: 'Salary', value: 'EXPENSE' },
  'hijacking': { type: 'Ransom', value: 'EXPENSE' },
  'pirate_raid': { type: 'Pirate Loss', value: 'EXPENSE' },
  'alliance_contribution': { type: 'Alliance', value: 'EXPENSE' },
  'harbor_fee_on_depart': { type: 'Harbor Fee', value: 'EXPENSE' },
  'guard_payment_on_depart': { type: 'Guard Fee', value: 'EXPENSE' }
};

// Time tolerance for matching (60 seconds - times are typically seconds apart)
const TIME_TOLERANCE_MS = 60000;

/**
 * Build lookup entries from all three PODs
 * @param {string} userId - User ID
 * @param {number} days - Number of days to process (0 = all)
 * @returns {Promise<Object>} Build result
 */
async function buildLookup(userId, days = 0) {
  const db = getDb(userId);

  // Get POD1 transactions
  let pod1Query = 'SELECT id, time, context, cash FROM transactions';
  if (days > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
    pod1Query += ` WHERE time >= ${cutoff}`;
  }
  pod1Query += ' ORDER BY time ASC';
  const pod1 = db.prepare(pod1Query).all();

  // Get POD2 autopilot logs
  let pod2Query = 'SELECT id, timestamp, autopilot, status, summary, details FROM autopilot_log';
  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    pod2Query += ` WHERE timestamp >= ${cutoff}`;
  }
  pod2Query += ' ORDER BY timestamp ASC';
  const pod2 = db.prepare(pod2Query).all();

  // Get POD3 departures
  let pod3Query = `
    SELECT id, timestamp, vessel_id, vessel_name, origin, destination, route_name, income, harbor_fee
    FROM departures
  `;
  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    pod3Query += ` WHERE timestamp >= ${cutoff}`;
  }
  pod3Query += ' ORDER BY timestamp ASC';
  const pod3 = db.prepare(pod3Query).all();

  logger.info(`[LookupStore/SQLite] Building lookup: POD1=${pod1.length}, POD2=${pod2.length}, POD3=${pod3.length}`);

  // Get existing lookup IDs
  const existingIds = new Set(
    db.prepare('SELECT pod1_id FROM lookup').all().map(r => r.pod1_id)
  );

  const insertLookup = db.prepare(`
    INSERT OR IGNORE INTO lookup
    (id, timestamp, pod1_id, pod2_id, pod3_id, pod1_timestamp, pod2_timestamp, pod3_timestamp,
     pod2_vessel, pod3_vessel, cash, cash_confirmed, type, value, context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  let matchedPod2 = 0;
  let matchedPod3 = 0;

  // Build indexes for fast matching
  const pod2ByContext = new Map();
  for (const log of pod2) {
    const context = getContextFromAutopilot(log.autopilot);
    if (!context) continue;
    if (!pod2ByContext.has(context)) pod2ByContext.set(context, []);
    pod2ByContext.get(context).push(log);
  }

  const pod3Index = pod3;

  // Process each POD1 transaction
  for (const tx of pod1) {
    if (existingIds.has(tx.id)) continue;

    const mapping = CONTEXT_MAPPING[tx.context];
    const type = mapping?.type || tx.context;
    const value = mapping?.value || (tx.cash >= 0 ? 'INCOME' : 'EXPENSE');

    // Find POD2 match
    let pod2Match = null;
    let pod2Vessel = null;
    const pod2Candidates = pod2ByContext.get(tx.context) || [];

    for (const log of pod2Candidates) {
      const timeDiff = Math.abs(log.timestamp - (tx.time * 1000));
      if (timeDiff > TIME_TOLERANCE_MS) continue;

      // For departures: check ALL vessels in departedVessels array
      // POD1 has one transaction per vessel, POD2 has one log with all vessels
      if (tx.context === 'vessels_departed') {
        const vessels = extractAllVesselsFromLog(log);
        for (const vessel of vessels) {
          const pod2Gross = vessel.income + (vessel.harborFee ? Math.abs(vessel.harborFee) : 0);
          if (pod2Gross === tx.cash) {
            pod2Match = log;
            pod2Vessel = vessel;
            break;
          }
        }
        if (pod2Match) break;
      } else {
        // For non-departures: match against summary cash
        const logCash = extractCashFromLog(log);
        if (logCash === tx.cash) {
          pod2Match = log;
          pod2Vessel = extractVesselFromLog(log);
          break;
        }
      }
    }

    // Find POD3 match (for departures)
    let pod3Match = null;
    let pod3Vessel = null;

    if (tx.context === 'vessels_departed' || tx.context === 'harbor_fee_on_depart') {
      // POD1.cash = GROSS (income + harbor_fee)
      // POD2 has BOTH income and harborFee (source of truth)
      // POD3.income = route_income from Game API vessel history
      // Match strategy:
      //   1. vessel_id (primary key - most reliable)
      //   2. timestamp within tolerance
      //   3. income validation (secondary, may differ slightly)
      const pod2VesselId = pod2Vessel?.vesselId;
      const pod2Income = pod2Vessel?.income;
      const pod2HarborFee = pod2Vessel?.harborFee;

      for (const dep of pod3Index) {
        const timeDiff = Math.abs(dep.timestamp - (tx.time * 1000));
        if (timeDiff > TIME_TOLERANCE_MS) continue;

        // PRIMARY match: vessel_id must match (if available)
        // This is the most reliable matching criteria
        if (pod2VesselId && dep.vessel_id === pod2VesselId) {
          pod3Match = dep;
          // Calculate gross using POD2's harborFee since POD3 doesn't have it
          const gross = dep.income + (pod2HarborFee ? Math.abs(pod2HarborFee) : 0);
          pod3Vessel = {
            vesselId: dep.vessel_id,
            name: dep.vessel_name,
            origin: dep.origin,
            destination: dep.destination,
            routeName: dep.route_name,
            income: dep.income,
            harborFee: pod2HarborFee ? Math.abs(pod2HarborFee) : 0,
            gross: gross
          };
          break;
        }

        // FALLBACK match: if no vesselId in POD2, try income match (legacy data)
        if (!pod2VesselId && pod2Income !== undefined && dep.income === pod2Income) {
          pod3Match = dep;
          const gross = dep.income + (pod2HarborFee ? Math.abs(pod2HarborFee) : 0);
          pod3Vessel = {
            vesselId: dep.vessel_id,
            name: dep.vessel_name,
            origin: dep.origin,
            destination: dep.destination,
            routeName: dep.route_name,
            income: dep.income,
            harborFee: pod2HarborFee ? Math.abs(pod2HarborFee) : 0,
            gross: gross
          };
          break;
        }
      }
    }

    if (pod2Match) matchedPod2++;
    if (pod3Match) matchedPod3++;

    // Insert lookup entry
    const result = insertLookup.run(
      `lookup_${crypto.randomUUID()}`,
      tx.time * 1000,
      tx.id,
      pod2Match?.id || null,
      pod3Match?.id || null,
      tx.time * 1000,
      pod2Match?.timestamp || null,
      pod3Match?.timestamp || null,
      JSON.stringify(pod2Vessel),
      JSON.stringify(pod3Vessel),
      tx.cash,
      1,
      type,
      value,
      tx.context
    );

    if (result.changes > 0) newCount++;
  }

  setMetadata(userId, 'lookup_last_sync', String(Date.now()));
  setMetadata(userId, 'lookup_version', String(STORE_VERSION));

  const countRow = db.prepare('SELECT COUNT(*) as count FROM lookup').get();

  logger.info(`[LookupStore/SQLite] Built ${newCount} new entries, matched POD2=${matchedPod2}, POD3=${matchedPod3}`);

  return {
    newEntries: newCount,
    totalEntries: countRow.count,
    matchedPod2,
    matchedPod3
  };
}

/**
 * Get context from autopilot name
 * @param {string} autopilot - Autopilot name
 * @returns {string|null} Context or null
 */
function getContextFromAutopilot(autopilot) {
  const mapping = {
    'Auto-Depart': 'vessels_departed',
    'Manual Depart': 'vessels_departed',
    'Auto-Fuel': 'fuel_purchased',
    'Manual Fuel Purchase': 'fuel_purchased',
    'Auto-CO2': 'co2_emission_quota',
    'Manual CO2 Purchase': 'co2_emission_quota',
    'Auto-Repair': 'bulk_wear_maintenance',
    'Manual Bulk Repair': 'bulk_wear_maintenance',
    'Auto-Drydock': 'bulk_vessel_major_service',
    'Manual Bulk Drydock': 'bulk_vessel_major_service'
  };
  return mapping[autopilot] || null;
}

/**
 * Extract cash value from log entry
 * @param {Object} log - Log entry
 * @returns {number} Cash value
 */
function extractCashFromLog(log) {
  if (!log.summary) return 0;

  const matches = [...log.summary.matchAll(/([+-]?)\$([0-9.,]+)/g)];
  if (matches.length === 0) return 0;

  const lastMatch = matches[matches.length - 1];
  const sign = lastMatch[1] === '-' ? -1 : 1;
  const amount = parseInt(lastMatch[2].replace(/[,.]/g, ''), 10);

  return sign * amount;
}

/**
 * Extract first vessel info from log entry (for non-departure logs)
 * @param {Object} log - Log entry
 * @returns {Object|null} Vessel info
 */
function extractVesselFromLog(log) {
  if (!log.details) return null;

  try {
    const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
    const vessels = details.departedVessels;
    if (vessels && vessels.length > 0) {
      return vessels[0];
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Extract ALL vessels from log entry (for departure matching)
 * @param {Object} log - Log entry
 * @returns {Array} Array of vessel objects (empty if none found)
 */
function extractAllVesselsFromLog(log) {
  if (!log.details) return [];

  try {
    const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
    return details.departedVessels || [];
  } catch {
    return [];
  }
}

/**
 * Get all lookup entries
 * @param {string} userId - User ID
 * @returns {Promise<Array>} All lookup entries
 */
async function getEntries(userId) {
  const db = getDb(userId);
  const rows = db.prepare(`
    SELECT id, timestamp, pod1_id, pod2_id, pod3_id, pod1_timestamp, pod2_timestamp, pod3_timestamp,
           pod2_vessel, pod3_vessel, cash, cash_confirmed, type, value, context
    FROM lookup ORDER BY timestamp DESC
  `).all();

  return rows.map(row => ({
    ...row,
    pod2_vessel: row.pod2_vessel ? JSON.parse(row.pod2_vessel) : null,
    pod3_vessel: row.pod3_vessel ? JSON.parse(row.pod3_vessel) : null,
    cash_confirmed: row.cash_confirmed === 1
  }));
}

/**
 * Get lookup entries within a time range
 * @param {string} userId - User ID
 * @param {number} days - Number of days to look back (0 = all)
 * @returns {Promise<Array>} Filtered entries
 */
async function getEntriesByDays(userId, days) {
  if (days === 0) return getEntries(userId);

  const db = getDb(userId);
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  const rows = db.prepare(`
    SELECT id, timestamp, pod1_id, pod2_id, pod3_id, pod1_timestamp, pod2_timestamp, pod3_timestamp,
           pod2_vessel, pod3_vessel, cash, cash_confirmed, type, value, context
    FROM lookup WHERE timestamp >= ? ORDER BY timestamp DESC
  `).all(cutoff);

  return rows.map(row => ({
    ...row,
    pod2_vessel: row.pod2_vessel ? JSON.parse(row.pod2_vessel) : null,
    pod3_vessel: row.pod3_vessel ? JSON.parse(row.pod3_vessel) : null,
    cash_confirmed: row.cash_confirmed === 1
  }));
}

/**
 * Get income/expense totals
 * @param {string} userId - User ID
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Object>} Totals
 */
async function getTotals(userId, days = 0) {
  const db = getDb(userId);

  let query = `
    SELECT
      SUM(CASE WHEN value = 'INCOME' THEN cash ELSE 0 END) as income,
      SUM(CASE WHEN value = 'EXPENSE' THEN ABS(cash) ELSE 0 END) as expense,
      COUNT(*) as count
    FROM lookup
  `;

  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    query += ` WHERE timestamp >= ${cutoff}`;
  }

  const row = db.prepare(query).get();

  return {
    income: row.income || 0,
    expense: row.expense || 0,
    profit: (row.income || 0) - (row.expense || 0),
    entryCount: row.count
  };
}

/**
 * Get breakdown by day
 * @param {string} userId - User ID
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Array>} Daily breakdown sorted by date descending
 */
async function getBreakdownByDay(userId, days = 0) {
  const db = getDb(userId);

  let query = `
    SELECT
      date(timestamp / 1000, 'unixepoch') as date,
      SUM(CASE WHEN cash >= 0 THEN cash ELSE 0 END) as income,
      SUM(CASE WHEN cash < 0 THEN ABS(cash) ELSE 0 END) as expenses,
      SUM(cash) as net,
      COUNT(*) as count
    FROM lookup
  `;

  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    query += ` WHERE timestamp >= ${cutoff}`;
  }

  query += ' GROUP BY date ORDER BY date DESC';

  return db.prepare(query).all();
}

/**
 * Get breakdown by type
 * @param {string} userId - User ID
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Object>} Breakdown by type
 */
async function getBreakdownByType(userId, days = 0) {
  const db = getDb(userId);

  let query = `
    SELECT
      type,
      value,
      COUNT(*) as count,
      SUM(cash) as total
    FROM lookup
  `;

  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    query += ` WHERE timestamp >= ${cutoff}`;
  }

  query += ' GROUP BY type, value';

  const rows = db.prepare(query).all();
  const breakdown = {};

  for (const row of rows) {
    breakdown[row.type] = {
      type: row.type,
      value: row.value,
      count: row.count,
      total: row.total
    };
  }

  return breakdown;
}

/**
 * Get store metadata
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Store info
 */
async function getStoreInfo(userId) {
  const db = getDb(userId);

  const countRow = db.prepare('SELECT COUNT(*) as count FROM lookup').get();
  const storeVersion = parseInt(getMetadata(userId, 'lookup_version') || '1', 10);
  const needsRebuild = storeVersion < STORE_VERSION;

  if (countRow.count === 0) {
    return {
      totalEntries: 0,
      oldestEntry: null,
      newestEntry: null,
      lastSync: null,
      dataSpanDays: 0,
      version: storeVersion,
      currentVersion: STORE_VERSION,
      needsRebuild
    };
  }

  const oldest = db.prepare('SELECT MIN(timestamp) as ts FROM lookup').get();
  const newest = db.prepare('SELECT MAX(timestamp) as ts FROM lookup').get();
  const lastSync = getMetadata(userId, 'lookup_last_sync');

  const spanMs = newest.ts - oldest.ts;
  const spanDays = Math.ceil(spanMs / (24 * 60 * 60 * 1000));

  return {
    totalEntries: countRow.count,
    oldestEntry: new Date(oldest.ts).toISOString(),
    newestEntry: new Date(newest.ts).toISOString(),
    lastSync: lastSync ? new Date(parseInt(lastSync, 10)).toISOString() : null,
    dataSpanDays: spanDays,
    version: storeVersion,
    currentVersion: STORE_VERSION,
    needsRebuild
  };
}

/**
 * Clear the lookup store
 * @param {string} userId - User ID
 */
async function clearStore(userId) {
  const db = getDb(userId);
  db.exec('DELETE FROM lookup');
  logger.info('[LookupStore/SQLite] Store cleared');
}

/**
 * Get full details for a lookup entry from all PODs
 * @param {string} userId - User ID
 * @param {string} lookupId - Lookup entry ID
 * @returns {Promise<Object|null>} Full details from all PODs
 */
async function getEntryDetails(userId, lookupId) {
  const db = getDb(userId);
  const entry = db.prepare(`
    SELECT id, timestamp, pod1_id, pod2_id, pod3_id, pod1_timestamp, pod2_timestamp, pod3_timestamp,
           pod2_vessel, pod3_vessel, cash, cash_confirmed, type, value, context
    FROM lookup WHERE id = ?
  `).get(lookupId);

  if (!entry) return null;

  // Get POD1 details (transaction)
  let pod1Details = null;
  if (entry.pod1_id) {
    pod1Details = db.prepare('SELECT id, time, context, cash FROM transactions WHERE id = ?').get(entry.pod1_id);
  }

  // Get POD2 details (autopilot log)
  let pod2Details = null;
  if (entry.pod2_id) {
    const logRow = db.prepare('SELECT id, timestamp, autopilot, status, summary, details FROM autopilot_log WHERE id = ?').get(entry.pod2_id);
    if (logRow) {
      pod2Details = {
        ...logRow,
        details: logRow.details ? JSON.parse(logRow.details) : null
      };
    }
  }

  // Get POD3 details (departure)
  let pod3Details = null;
  if (entry.pod3_id) {
    const depRow = db.prepare(`
      SELECT id, timestamp, autopilot, status, source, vessel_id, vessel_name,
             origin, destination, route_name, distance, fuel_used, income, wear, duration, cargo, harbor_fee
      FROM departures WHERE id = ?
    `).get(entry.pod3_id);
    if (depRow) {
      pod3Details = {
        id: depRow.id,
        timestamp: depRow.timestamp,
        autopilot: depRow.autopilot,
        status: depRow.status,
        source: depRow.source,
        details: {
          departedVessels: [{
            vesselId: depRow.vessel_id,
            name: depRow.vessel_name,
            origin: depRow.origin,
            destination: depRow.destination,
            routeName: depRow.route_name,
            distance: depRow.distance,
            fuelUsed: depRow.fuel_used,
            income: depRow.income,
            wear: depRow.wear,
            duration: depRow.duration,
            cargo: depRow.cargo ? JSON.parse(depRow.cargo) : {},
            harborFee: depRow.harbor_fee || 0
          }]
        }
      };
    }
  }

  return {
    lookup: {
      ...entry,
      pod2_vessel: entry.pod2_vessel ? JSON.parse(entry.pod2_vessel) : null,
      pod3_vessel: entry.pod3_vessel ? JSON.parse(entry.pod3_vessel) : null,
      cash_confirmed: entry.cash_confirmed === 1
    },
    pod1: pod1Details,
    pod2: pod2Details,
    pod3: pod3Details
  };
}

/**
 * Re-match existing lookup entries with POD3 (vessel history)
 * This fixes entries that were created before vessel history was synced
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Rematch result
 */
async function rematchPOD3(userId) {
  const db = getDb(userId);

  // Get lookup entries without POD3 match that should have one (departures)
  const unmatchedEntries = db.prepare(`
    SELECT id, timestamp, pod1_id, pod2_vessel, cash, context
    FROM lookup
    WHERE pod3_id IS NULL
    AND (context = 'vessels_departed' OR context = 'harbor_fee_on_depart')
  `).all();

  if (unmatchedEntries.length === 0) {
    return { matched: 0, total: 0, message: 'No unmatched departure entries' };
  }

  // Get all departures from POD3
  const departures = db.prepare(`
    SELECT id, timestamp, vessel_id, vessel_name, origin, destination, route_name, income, harbor_fee
    FROM departures
  `).all();

  if (departures.length === 0) {
    return { matched: 0, total: unmatchedEntries.length, message: 'No vessel history available yet' };
  }

  const updateStmt = db.prepare(`
    UPDATE lookup
    SET pod3_id = ?, pod3_timestamp = ?, pod3_vessel = ?
    WHERE id = ?
  `);

  let matchedCount = 0;

  for (const entry of unmatchedEntries) {
    // Parse pod2_vessel to get vesselId, income and harborFee for matching
    let pod2VesselId = null;
    let pod2Income = null;
    let pod2HarborFee = null;
    if (entry.pod2_vessel) {
      try {
        const pod2Vessel = JSON.parse(entry.pod2_vessel);
        pod2VesselId = pod2Vessel.vesselId;
        pod2Income = pod2Vessel.income;
        pod2HarborFee = pod2Vessel.harborFee;
      } catch {
        // No pod2_vessel data available
      }
    }

    // Skip if no vesselId AND no income to match against
    if (!pod2VesselId && (pod2Income === null || pod2Income === undefined)) {
      continue;
    }

    // Find matching departure
    for (const dep of departures) {
      const timeDiff = Math.abs(dep.timestamp - entry.timestamp);
      if (timeDiff > TIME_TOLERANCE_MS) continue;

      // PRIMARY match: vessel_id must match (if available) - most reliable
      const vesselIdMatches = pod2VesselId && dep.vessel_id === pod2VesselId;
      // FALLBACK match: income must match (for legacy data without vesselId)
      const incomeMatches = !pod2VesselId && pod2Income !== undefined && dep.income === pod2Income;

      if (vesselIdMatches || incomeMatches) {
        // Calculate gross using POD2's harborFee since POD3 doesn't have it
        const gross = dep.income + (pod2HarborFee ? Math.abs(pod2HarborFee) : 0);
        const pod3Vessel = {
          vesselId: dep.vessel_id,
          name: dep.vessel_name,
          origin: dep.origin,
          destination: dep.destination,
          routeName: dep.route_name,
          income: dep.income,
          harborFee: pod2HarborFee ? Math.abs(pod2HarborFee) : 0,
          gross: gross
        };

        updateStmt.run(dep.id, dep.timestamp, JSON.stringify(pod3Vessel), entry.id);
        matchedCount++;
        break;
      }
    }
  }

  logger.info(`[LookupStore/SQLite] Rematched ${matchedCount}/${unmatchedEntries.length} entries with POD3`);

  return {
    matched: matchedCount,
    total: unmatchedEntries.length,
    message: `Matched ${matchedCount} of ${unmatchedEntries.length} entries`
  };
}

module.exports = {
  buildLookup,
  rematchPOD3,
  getEntries,
  getEntriesByDays,
  getTotals,
  getBreakdownByType,
  getBreakdownByDay,
  getEntryDetails,
  getStoreInfo,
  clearStore,
  CONTEXT_MAPPING
};
