/**
 * @fileoverview Lookup Store Worker Thread
 *
 * Runs heavy SQLite operations in a separate thread to avoid blocking the main event loop.
 * The main application remains responsive while this worker processes data.
 *
 * This worker contains the FULL matching logic for POD1/POD2/POD3 correlation.
 */

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');

// Setup paths for packaged mode
function getAppBaseDir() {
  if (workerData.isPackaged) {
    return workerData.appBaseDir;
  }
  return path.join(__dirname, '..', '..');
}

function getNativeBindingPath() {
  if (workerData.isPackaged) {
    return path.join(getAppBaseDir(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  }
  return undefined;
}

const nativeBinding = getNativeBindingPath();
const Database = require('better-sqlite3');
const fs = require('fs');

// Get database path
function getDbPath(userId) {
  const baseDir = workerData.isPackaged
    ? path.join(getAppBaseDir(), 'userdata', 'database')
    : path.join(__dirname, '..', '..', 'userdata', 'database');
  return path.join(baseDir, `${userId}.db`);
}

// Context to type/value mapping (must match lookup-store.js)
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
  'Buy Vessel': { type: 'Vessel Purchase', value: 'EXPENSE' },
  'Vessel_build_Purchase': { type: 'Vessel Build', value: 'EXPENSE' },
  'vessel_build_purchase': { type: 'Vessel Build', value: 'EXPENSE' },
  'Vessel Build Purchase': { type: 'Vessel Build', value: 'EXPENSE' },
  'purchase_stock': { type: 'Stock Purchase', value: 'EXPENSE' },
  'anchor_points': { type: 'Anchor', value: 'EXPENSE' },
  'marketing_campaign_activation': { type: 'Marketing', value: 'EXPENSE' },
  'route_fee_on_creating': { type: 'Route Fee', value: 'EXPENSE' },
  'salary_payment': { type: 'Salary', value: 'EXPENSE' },
  'hijacking': { type: 'Ransom', value: 'EXPENSE' },
  'Hijacking': { type: 'Ransom', value: 'EXPENSE' },
  'pirate_raid': { type: 'Pirate Loss', value: 'EXPENSE' },
  'alliance_contribution': { type: 'Alliance', value: 'EXPENSE' },
  'harbor_fee_on_depart': { type: 'Harbor Fee', value: 'EXPENSE' },
  'guard_payment_on_depart': { type: 'Guard Fee', value: 'EXPENSE' }
};

// Time tolerance for matching (60 seconds)
const TIME_TOLERANCE_MS = 60000;

/**
 * Get contexts from autopilot name
 */
function getContextsFromAutopilot(autopilot) {
  const mapping = {
    'Auto-Depart': ['vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart'],
    'Manual Depart': ['vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart'],
    'Auto-Fuel': ['fuel_purchased'],
    'Manual Fuel Purchase': ['fuel_purchased'],
    'Auto-CO2': ['co2_emission_quota'],
    'Manual CO2 Purchase': ['co2_emission_quota'],
    'Auto-Repair': ['bulk_wear_maintenance'],
    'Manual Bulk Repair': ['bulk_wear_maintenance'],
    'Auto-Drydock': ['bulk_vessel_major_service', 'vessel_major_service'],
    'Manual Bulk Drydock': ['bulk_vessel_major_service', 'vessel_major_service'],
    'Auto-Anchor': ['anchor_points'],
    'Manual Anchor Purchase': ['anchor_points'],
    'Auto-Campaign': ['marketing_campaign_activation'],
    'Campaign Activation': ['marketing_campaign_activation'],
    'Captain Blackbeard': ['hijacking', 'Hijacking'],
    'Auto-Blackbeard': ['hijacking'],
    'Manual Pay Ransom': ['hijacking'],
    'Manual Negotiate Hijacking': ['hijacking'],
    'Manual Stock Purchase': ['purchase_stock'],
    'Manual Stock Sale': ['sell_stock'],
    'The Purser': ['purchase_stock', 'sell_stock'],
    'Manual Route Planner': ['route_fee_on_creating'],
    'Manual Vessel Build': ['Vessel Build Purchase', 'vessel_build_purchase', 'Vessel_build_Purchase'],
    'Manual Vessel Purchase': ['buy_vessel', 'Buy Vessel'],
    'Manual Vessel Sale': ['sell_vessel', 'sold_vessel_in_port', 'Sold_vessel_in_port']
  };
  return mapping[autopilot] || [];
}

/**
 * Extract cash value from log entry
 */
function extractCashFromLog(log) {
  if (log.details) {
    try {
      const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;

      if (details.totalCost !== undefined) return Math.abs(details.totalCost);
      if (details.total_cost !== undefined) return Math.abs(details.total_cost);
      if (details.actualCost !== undefined) return Math.abs(details.actualCost);
      if (details.actual_cost !== undefined) return Math.abs(details.actual_cost);
      if (details.totalPrice !== undefined) return Math.abs(details.totalPrice);
      if (details.total_price !== undefined) return Math.abs(details.total_price);
      if (details.totalFee !== undefined) return Math.abs(details.totalFee);
      if (details.total_fee !== undefined) return Math.abs(details.total_fee);
      if (details.buildCost !== undefined) return Math.abs(details.buildCost);
      if (details.build_cost !== undefined) return Math.abs(details.build_cost);
      if (details.cost !== undefined) return Math.abs(details.cost);
      if (details.finalPayment !== undefined) return Math.abs(details.finalPayment);
      if (details.final_payment !== undefined) return Math.abs(details.final_payment);
      if (details.totalRevenue !== undefined) return Math.abs(details.totalRevenue);
      if (details.total_revenue !== undefined) return Math.abs(details.total_revenue);
    } catch {
      // Fall through to summary parsing
    }
  }

  if (!log.summary) return 0;

  const matches = [...log.summary.matchAll(/([+-]?)\$([0-9.,]+)/g)];
  if (matches.length === 0) return 0;

  const lastMatch = matches[matches.length - 1];
  const amount = parseInt(lastMatch[2].replace(/[,.]/g, ''), 10);

  return amount;
}

/**
 * Extract price per unit from log entry
 */
function extractPriceFromLog(log) {
  if (!log.details) return 0;

  try {
    const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
    if (details.price !== undefined) return Math.abs(details.price);
    if (details.price_per_ton !== undefined) return Math.abs(details.price_per_ton);
    if (details.pricePerTon !== undefined) return Math.abs(details.pricePerTon);
  } catch {
    return 0;
  }

  return 0;
}

/**
 * Extract per-item price from log entry
 */
function extractPerItemPriceFromLog(log) {
  if (!log.details) return 0;

  try {
    const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
    if (details.vessels && details.vessels.length > 0) {
      const vessel = details.vessels[0];
      if (vessel.price_per_vessel !== undefined) return Math.abs(vessel.price_per_vessel);
      if (vessel.pricePerVessel !== undefined) return Math.abs(vessel.pricePerVessel);
    }
  } catch {
    return 0;
  }

  return 0;
}

/**
 * Extract first vessel info from log entry
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
 * Extract ALL vessels from log entry
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

// Run the lookup build with FULL matching logic
function runBuild() {
  const { userId, days, clearFirst } = workerData;
  const dbPath = getDbPath(userId);

  if (!fs.existsSync(dbPath)) {
    parentPort.postMessage({ type: 'error', message: 'Database not found' });
    return;
  }

  const dbOptions = nativeBinding ? { nativeBinding } : {};
  const db = new Database(dbPath, dbOptions);

  try {
    parentPort.postMessage({ type: 'progress', stage: 'starting', percent: 0 });

    // Clear if requested (for rebuild)
    if (clearFirst) {
      db.exec('DELETE FROM lookup');
      parentPort.postMessage({ type: 'progress', stage: 'cleared', percent: 5 });
    }

    // Load POD1 (transactions)
    let pod1Query = 'SELECT id, time, context, cash FROM transactions';
    if (days > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      pod1Query += ` WHERE time >= ${cutoff}`;
    }
    pod1Query += ' ORDER BY time ASC';
    const pod1 = db.prepare(pod1Query).all();

    parentPort.postMessage({ type: 'progress', stage: 'loaded_pod1', count: pod1.length, percent: 15 });

    // Load POD2 (autopilot log)
    let pod2Query = 'SELECT id, timestamp, autopilot, status, summary, details FROM autopilot_log';
    if (days > 0) {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      pod2Query += ` WHERE timestamp >= ${cutoff}`;
    }
    pod2Query += ' ORDER BY timestamp ASC';
    const pod2 = db.prepare(pod2Query).all();

    parentPort.postMessage({ type: 'progress', stage: 'loaded_pod2', count: pod2.length, percent: 25 });

    // Load POD3 (departures/vessel history)
    let pod3Query = 'SELECT id, timestamp, vessel_id, vessel_name, origin, destination, route_name, income, harbor_fee FROM departures';
    if (days > 0) {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      pod3Query += ` WHERE timestamp >= ${cutoff}`;
    }
    pod3Query += ' ORDER BY timestamp ASC';
    const pod3 = db.prepare(pod3Query).all();

    parentPort.postMessage({ type: 'progress', stage: 'loaded_pod3', count: pod3.length, percent: 35 });

    // Get existing fully matched IDs
    // For departure contexts: needs BOTH pod2_id AND pod3_id
    // For other contexts: only needs pod2_id
    const fullyMatchedIds = new Set(
      db.prepare(`
        SELECT pod1_id FROM lookup
        WHERE pod2_id IS NOT NULL
        AND (pod3_id IS NOT NULL OR context NOT IN ('vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart'))
      `).all().map(r => r.pod1_id)
    );

    // Get entries that need re-matching:
    // - Entries without pod2_id
    // - Entries with pod2_id but missing pod3_id for departure contexts
    const needsRematchIds = new Set(
      db.prepare(`
        SELECT pod1_id FROM lookup
        WHERE pod2_id IS NULL
        OR (pod2_id IS NOT NULL AND pod3_id IS NULL AND context IN ('vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart'))
      `).all().map(r => r.pod1_id)
    );

    parentPort.postMessage({ type: 'progress', stage: 'building_index', percent: 40 });

    // Build POD2 index by context
    const pod2ByContext = new Map();
    for (const log of pod2) {
      const contexts = getContextsFromAutopilot(log.autopilot);
      if (!contexts || contexts.length === 0) continue;
      for (const context of contexts) {
        if (!pod2ByContext.has(context)) pod2ByContext.set(context, []);
        pod2ByContext.get(context).push(log);
      }
    }

    parentPort.postMessage({ type: 'progress', stage: 'matching', percent: 45 });

    // Prepare statements
    const insertLookup = db.prepare(`
      INSERT OR IGNORE INTO lookup
      (id, timestamp, pod1_id, pod2_id, pod3_id, pod1_timestamp, pod2_timestamp, pod3_timestamp,
       pod2_vessel, pod3_vessel, cash, cash_confirmed, type, value, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateLookup = db.prepare(`
      UPDATE lookup SET
        pod2_id = ?, pod2_timestamp = ?, pod2_vessel = ?,
        pod3_id = ?, pod3_timestamp = ?, pod3_vessel = ?
      WHERE pod1_id = ?
    `);

    let newCount = 0;
    let rematchedCount = 0;
    let matchedPod2 = 0;
    let matchedPod3 = 0;

    // Track used POD2 IDs to prevent duplicate matching
    const usedPod2Ids = new Set();

    // Process each transaction
    const total = pod1.length;
    let lastProgressPercent = 45;

    for (let i = 0; i < pod1.length; i++) {
      const tx = pod1[i];

      // Report progress every 5%
      const currentPercent = 45 + Math.floor((i / total) * 45);
      if (currentPercent > lastProgressPercent) {
        parentPort.postMessage({ type: 'progress', stage: 'matching', percent: currentPercent, current: i, total });
        lastProgressPercent = currentPercent;
      }

      // Skip if already fully matched
      if (fullyMatchedIds.has(tx.id)) continue;

      const needsRematch = needsRematchIds.has(tx.id);

      const mapping = CONTEXT_MAPPING[tx.context];
      const type = mapping?.type || tx.context;
      const value = mapping?.value || (tx.cash >= 0 ? 'INCOME' : 'EXPENSE');

      // Find POD2 match
      let pod2Match = null;
      let pod2Vessel = null;

      const pod2Candidates = pod2ByContext.get(tx.context) || [];
      const isMultiMatchContext = ['vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart', 'buy_vessel'].includes(tx.context);

      for (const log of pod2Candidates) {
        if (!isMultiMatchContext && usedPod2Ids.has(log.id)) continue;

        const timeDiff = Math.abs(log.timestamp - (tx.time * 1000));
        if (timeDiff > TIME_TOLERANCE_MS) continue;

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
        } else if (tx.context === 'harbor_fee_on_depart') {
          const vessels = extractAllVesselsFromLog(log);
          for (const vessel of vessels) {
            const vesselHarborFee = vessel.harborFee || 0;
            if (vesselHarborFee === tx.cash || Math.abs(vesselHarborFee) === Math.abs(tx.cash)) {
              pod2Match = log;
              pod2Vessel = vessel;
              break;
            }
          }
          if (pod2Match) break;
        } else if (tx.context === 'guard_payment_on_depart') {
          const vessels = extractAllVesselsFromLog(log);
          const guardCost = Math.abs(tx.cash);
          const guardCount = guardCost / 1000;

          for (const vessel of vessels) {
            if (vessel.guards === guardCount && vessel.guards > 0) {
              pod2Match = log;
              pod2Vessel = vessel;
              break;
            }
          }

          if (!pod2Match && vessels.length > 0) {
            pod2Match = log;
            pod2Vessel = { ...vessels[0], guards: guardCount };
          }
          if (pod2Match) break;
        } else if (tx.context === 'purchase_stock' || tx.context === 'sell_stock') {
          const logCash = extractCashFromLog(log);
          const pod1Abs = Math.abs(tx.cash);
          const logAbs = Math.abs(logCash);

          const expectedBuy = logAbs * 1.05;
          const expectedSell = logAbs * 0.95;

          const tolerance = 0.01;
          const matchesBuy = Math.abs(pod1Abs - expectedBuy) / expectedBuy < tolerance;
          const matchesSell = Math.abs(pod1Abs - expectedSell) / expectedSell < tolerance;

          if (matchesBuy || matchesSell || logAbs === pod1Abs) {
            pod2Match = log;
            pod2Vessel = extractVesselFromLog(log);
            break;
          }
        } else {
          const logCash = extractCashFromLog(log);
          const pod1Abs = Math.abs(tx.cash);
          const logAbs = Math.abs(logCash);

          if (logAbs === pod1Abs) {
            pod2Match = log;
            pod2Vessel = extractVesselFromLog(log);
            break;
          }

          const price = extractPriceFromLog(log);
          if (price > 0 && (logAbs - price) === pod1Abs) {
            pod2Match = log;
            pod2Vessel = extractVesselFromLog(log);
            break;
          }

          const perItemPrice = extractPerItemPriceFromLog(log);
          if (perItemPrice > 0 && perItemPrice === pod1Abs) {
            pod2Match = log;
            pod2Vessel = extractVesselFromLog(log);
            break;
          }
        }
      }

      if (pod2Match && !isMultiMatchContext) {
        usedPod2Ids.add(pod2Match.id);
      }

      // Find POD3 match (for departures, harbor fees, and guard fees)
      let pod3Match = null;
      let pod3Vessel = null;

      if (tx.context === 'vessels_departed' || tx.context === 'harbor_fee_on_depart' || tx.context === 'guard_payment_on_depart') {
        const pod2VesselId = pod2Vessel?.vesselId;
        const pod2Income = pod2Vessel?.income;
        const pod2HarborFee = pod2Vessel?.harborFee;

        for (const dep of pod3) {
          const timeDiff = Math.abs(dep.timestamp - (tx.time * 1000));
          if (timeDiff > TIME_TOLERANCE_MS) continue;

          if (pod2VesselId && dep.vessel_id === pod2VesselId) {
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

      if (needsRematch) {
        const result = updateLookup.run(
          pod2Match?.id || null,
          pod2Match?.timestamp || null,
          JSON.stringify(pod2Vessel),
          pod3Match?.id || null,
          pod3Match?.timestamp || null,
          JSON.stringify(pod3Vessel),
          tx.id
        );
        if (result.changes > 0) rematchedCount++;
      } else {
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
    }

    parentPort.postMessage({ type: 'progress', stage: 'finalizing', percent: 95 });

    // Get total count
    const totalRow = db.prepare('SELECT COUNT(*) as count FROM lookup').get();

    db.close();

    parentPort.postMessage({
      type: 'complete',
      result: {
        newEntries: newCount,
        rematchedEntries: rematchedCount,
        totalEntries: totalRow.count,
        matchedPod2,
        matchedPod3,
        pod1Count: pod1.length,
        pod2Count: pod2.length,
        pod3Count: pod3.length
      }
    });

  } catch (error) {
    try { db.close(); } catch {}
    parentPort.postMessage({ type: 'error', message: error.message });
  }
}

// Start the build
runBuild();
