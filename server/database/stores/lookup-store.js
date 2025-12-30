/**
 * @fileoverview SQLite-based Lookup Store (POD4)
 *
 * Drop-in replacement for the JSON-based lookup store.
 * Combines data from POD1 (transactions), POD2 (autopilot log), POD3 (vessel history).
 *
 * @module server/database/stores/lookup-store
 */

const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../../utils/logger');
const { getDb, setMetadata, getMetadata } = require('../index');
const { getAppBaseDir, isPackaged } = require('../../config');

// Store version - increment when matching logic changes
// v4: Fixed POD2 matching for expenses, added multi-context indexing for departures/harbor fees
// v5: Added stock transactions with 5% fee tolerance, fixed Campaign Activation mapping
// v6: Added route fees, vessel build/purchase/sale, marketing campaigns
// v7: Fixed rebuild to re-match entries with missing pod2_id (were being skipped)
// v8: Fixed CO2 1-ton rounding issue (game charges 1 ton less than calculated)
// v9: Fixed snake_case vs camelCase in extractCashFromLog, added bulk vessel matching
// v10: Prevent duplicate POD2 matching for single-match contexts
// v11: Added guard_payment_on_depart matching
// v12: Added 'The Purser' autopilot mapping for stock transactions
// v13: Improved guard_payment matching when route_guards is 0 from game API
// v14: Fixed Manual Vessel Build mapping to use buy_vessel context (same as purchases)
// v15: Added 'Vessel Build Purchase' and 'Hijacking' contexts, Captain Blackbeard mapping, finalPayment extraction
// v16: Added POD3 matching for guard_payment_on_depart (was missing vessel history link)
// v17: Fixed POD3 re-matching bug - entries with pod2_id but no pod3_id were being skipped
const STORE_VERSION = 17;

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

// Time tolerance for matching (60 seconds - times are typically seconds apart)
const TIME_TOLERANCE_MS = 60000;

// Build status tracking
const buildStatus = new Map(); // userId -> { building: boolean, progress: number, total: number, stage: string }

// Active worker threads
const activeWorkers = new Map(); // userId -> Worker

/**
 * Get current build status for a user
 * @param {string} userId - User ID
 * @returns {Object} Build status
 */
function getBuildStatus(userId) {
  return buildStatus.get(userId) || { building: false, progress: 0, total: 0, stage: 'idle' };
}

/**
 * Build lookup using a Worker Thread (non-blocking)
 * This runs the heavy SQLite operations in a separate thread so the main event loop stays responsive.
 * @param {string} userId - User ID
 * @param {number} days - Number of days to process (0 = all)
 * @param {boolean} clearFirst - Clear existing data before building
 * @returns {Promise<Object>} Build result
 */
function buildLookupAsync(userId, days = 0, clearFirst = false) {
  return new Promise((resolve, reject) => {
    // Check if already building
    if (activeWorkers.has(userId)) {
      logger.warn(`[LookupStore] Build already in progress for user ${userId}`);
      resolve({ alreadyBuilding: true, status: getBuildStatus(userId) });
      return;
    }

    const isPkg = isPackaged();
    const workerPath = isPkg
      ? path.join(getAppBaseDir(), 'server', 'workers', 'lookup-worker.js')
      : path.join(__dirname, '..', '..', 'workers', 'lookup-worker.js');

    logger.info(`[LookupStore] Starting worker thread build for user ${userId} (days=${days}, clear=${clearFirst})`);

    // Set initial status
    buildStatus.set(userId, { building: true, progress: 0, total: 0, stage: 'starting' });

    const worker = new Worker(workerPath, {
      workerData: {
        userId,
        days,
        clearFirst,
        isPackaged: isPkg,
        appBaseDir: getAppBaseDir()
      }
    });

    activeWorkers.set(userId, worker);

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        buildStatus.set(userId, {
          building: true,
          progress: msg.percent || 0,
          total: 100,
          stage: msg.stage,
          count: msg.count
        });
        logger.debug(`[LookupStore] Worker progress: ${msg.stage} (${msg.percent}%)`);
      } else if (msg.type === 'complete') {
        logger.info(`[LookupStore] Worker build complete: ${msg.result.newEntries} new, total ${msg.result.totalEntries}`);
        setMetadata(userId, 'lookup_last_sync', String(Date.now()));
        setMetadata(userId, 'lookup_version', String(STORE_VERSION));
        buildStatus.delete(userId);
        activeWorkers.delete(userId);
        resolve(msg.result);
      } else if (msg.type === 'error') {
        logger.error(`[LookupStore] Worker error: ${msg.message}`);
        buildStatus.delete(userId);
        activeWorkers.delete(userId);
        reject(new Error(msg.message));
      }
    });

    worker.on('error', (err) => {
      logger.error(`[LookupStore] Worker thread error:`, err);
      buildStatus.delete(userId);
      activeWorkers.delete(userId);
      reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.error(`[LookupStore] Worker exited with code ${code}`);
        buildStatus.delete(userId);
        activeWorkers.delete(userId);
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

/**
 * Cancel an in-progress build
 * @param {string} userId - User ID
 * @returns {boolean} True if cancelled
 */
function cancelBuild(userId) {
  const worker = activeWorkers.get(userId);
  if (worker) {
    worker.terminate();
    activeWorkers.delete(userId);
    buildStatus.delete(userId);
    logger.info(`[LookupStore] Cancelled build for user ${userId}`);
    return true;
  }
  return false;
}

/**
 * Load data in pages to avoid blocking event loop
 * @param {Database} db - Database instance
 * @param {string} query - SQL query (without LIMIT/OFFSET)
 * @param {number} pageSize - Rows per page
 * @returns {Promise<Array>} All rows
 */
async function loadPaged(db, query, pageSize = 5000) {
  const results = [];
  let offset = 0;

  while (true) {
    const page = db.prepare(`${query} LIMIT ${pageSize} OFFSET ${offset}`).all();
    results.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;

    // Yield to event loop between pages
    await new Promise(resolve => setImmediate(resolve));
  }

  return results;
}

/**
 * Build lookup entries from all three PODs (non-blocking, chunked)
 * @param {string} userId - User ID
 * @param {number} days - Number of days to process (0 = all)
 * @returns {Promise<Object>} Build result
 */
async function buildLookup(userId, days = 0) {
  const db = getDb(userId);

  // Build queries
  let pod1Query = 'SELECT id, time, context, cash FROM transactions';
  if (days > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
    pod1Query += ` WHERE time >= ${cutoff}`;
  }
  pod1Query += ' ORDER BY time ASC';

  let pod2Query = 'SELECT id, timestamp, autopilot, status, summary, details FROM autopilot_log';
  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    pod2Query += ` WHERE timestamp >= ${cutoff}`;
  }
  pod2Query += ' ORDER BY timestamp ASC';

  let pod3Query = `
    SELECT id, timestamp, vessel_id, vessel_name, origin, destination, route_name, income, harbor_fee
    FROM departures`;
  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    pod3Query += ` WHERE timestamp >= ${cutoff}`;
  }
  pod3Query += ' ORDER BY timestamp ASC';

  // Load data in pages to avoid blocking event loop
  const pod1 = await loadPaged(db, pod1Query);
  const pod2 = await loadPaged(db, pod2Query);
  const pod3 = await loadPaged(db, pod3Query);

  logger.info(`[LookupStore/SQLite] Building lookup: POD1=${pod1.length}, POD2=${pod2.length}, POD3=${pod3.length}`);

  // Set build status
  buildStatus.set(userId, { building: true, progress: 0, total: pod1.length });

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

  const insertLookup = db.prepare(`
    INSERT OR IGNORE INTO lookup
    (id, timestamp, pod1_id, pod2_id, pod3_id, pod1_timestamp, pod2_timestamp, pod3_timestamp,
     pod2_vessel, pod3_vessel, cash, cash_confirmed, type, value, context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Update statement for re-matching existing entries
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

  // Track used POD2 IDs to prevent duplicate matching (single-match contexts only)
  const usedPod2Ids = new Set();

  // Build indexes for fast matching (chunked to avoid blocking)
  const pod2ByContext = new Map();
  for (let i = 0; i < pod2.length; i++) {
    const log = pod2[i];
    const contexts = getContextsFromAutopilot(log.autopilot);
    if (!contexts || contexts.length === 0) continue;
    for (const context of contexts) {
      if (!pod2ByContext.has(context)) pod2ByContext.set(context, []);
      pod2ByContext.get(context).push(log);
    }
    // Yield every 2000 items during index build
    if (i > 0 && i % 2000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  const pod3Index = pod3;

  // Process in chunks to avoid blocking event loop
  const CHUNK_SIZE = 200;

  // Process each POD1 transaction (chunked for non-blocking)
  for (let i = 0; i < pod1.length; i++) {
    const tx = pod1[i];

    // Yield to event loop every CHUNK_SIZE items
    if (i > 0 && i % CHUNK_SIZE === 0) {
      buildStatus.set(userId, { building: true, progress: i, total: pod1.length });
      await new Promise(resolve => setImmediate(resolve));
    }
    // Skip if already fully matched (has pod2_id)
    if (fullyMatchedIds.has(tx.id)) continue;

    // Check if this entry needs re-matching (exists but no pod2_id)
    const needsRematch = needsRematchIds.has(tx.id);

    const mapping = CONTEXT_MAPPING[tx.context];
    const type = mapping?.type || tx.context;
    const value = mapping?.value || (tx.cash >= 0 ? 'INCOME' : 'EXPENSE');

    // Find POD2 match
    let pod2Match = null;
    let pod2Vessel = null;

    // Get POD2 candidates for this context
    // (departure logs are indexed under all related contexts: vessels_departed, harbor_fee_on_depart, etc.)
    const pod2Candidates = pod2ByContext.get(tx.context) || [];

    // Contexts where one log can match multiple transactions (bulk operations with multiple vessels)
    const isMultiMatchContext = ['vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart', 'buy_vessel'].includes(tx.context);

    for (const log of pod2Candidates) {
      // Skip already-used logs for single-match contexts (prevents duplicate matching)
      if (!isMultiMatchContext && usedPod2Ids.has(log.id)) continue;

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
      } else if (tx.context === 'harbor_fee_on_depart') {
        // For harbor fees: find the vessel with matching harborFee amount
        // POD1.cash is negative (expense), vessel.harborFee is also negative
        const vessels = extractAllVesselsFromLog(log);
        for (const vessel of vessels) {
          // Harbor fee in vessel is negative, POD1.cash is also negative
          const vesselHarborFee = vessel.harborFee || 0;
          if (vesselHarborFee === tx.cash || Math.abs(vesselHarborFee) === Math.abs(tx.cash)) {
            pod2Match = log;
            pod2Vessel = vessel;
            break;
          }
        }
        if (pod2Match) break;
      } else if (tx.context === 'guard_payment_on_depart') {
        // For guard fees: find vessel where guards * 1000 matches the cash
        // POD1.cash is negative, e.g. -10000 for 10 guards ($1000 per guard)
        // KNOWN ISSUE: Game API returns route_guards=0 even when guards are set
        // So vessel.guards in our log is often 0 - use time-based matching as primary
        const vessels = extractAllVesselsFromLog(log);
        const guardCost = Math.abs(tx.cash);
        const guardCount = guardCost / 1000; // $1000 per guard

        // First try exact match on guards count
        for (const vessel of vessels) {
          if (vessel.guards === guardCount && vessel.guards > 0) {
            pod2Match = log;
            pod2Vessel = vessel;
            break;
          }
        }

        // Fallback: if no exact match, use first vessel from the departure log
        // (guards are typically the same for all vessels in a batch departure)
        if (!pod2Match && vessels.length > 0) {
          pod2Match = log;
          pod2Vessel = { ...vessels[0], guards: guardCount }; // Override with calculated guards
        }
        if (pod2Match) break;
      } else if (tx.context === 'purchase_stock' || tx.context === 'sell_stock') {
        // Stock transactions have 5% broker fee
        // POD1.cash includes fee, POD2 log has stock value before fee
        // Buy: POD1 = -(value + 5% fee) = -1.05 * value
        // Sell: POD1 = +(value - 5% fee) = +0.95 * value
        const logCash = extractCashFromLog(log);
        const pod1Abs = Math.abs(tx.cash);
        const logAbs = Math.abs(logCash);

        // Calculate expected POD1 from POD2 (with 5% fee)
        const expectedBuy = logAbs * 1.05;  // Buy: value + 5%
        const expectedSell = logAbs * 0.95; // Sell: value - 5%

        // Allow 1% tolerance for rounding
        const tolerance = 0.01;
        const matchesBuy = Math.abs(pod1Abs - expectedBuy) / expectedBuy < tolerance;
        const matchesSell = Math.abs(pod1Abs - expectedSell) / expectedSell < tolerance;

        if (matchesBuy || matchesSell || logAbs === pod1Abs) {
          pod2Match = log;
          pod2Vessel = extractVesselFromLog(log);
          break;
        }
      } else {
        // For non-departures: match against summary cash
        // Use absolute values for comparison because:
        // - POD1.cash for expenses is negative (-1500000)
        // - Log summaries may format as positive ("$1,500,000") without sign
        const logCash = extractCashFromLog(log);
        const pod1Abs = Math.abs(tx.cash);
        const logAbs = Math.abs(logCash);

        // Check for exact match first
        if (logAbs === pod1Abs) {
          pod2Match = log;
          pod2Vessel = extractVesselFromLog(log);
          break;
        }

        // For old CO2 logs: Game charges 1 ton less than we calculated
        // Old logs have: logCash = amount * price
        // Game charged: pod1Abs = (amount - 1) * price
        // So check if: logCash - price === pod1Abs
        const price = extractPriceFromLog(log);
        if (price > 0 && (logAbs - price) === pod1Abs) {
          pod2Match = log;
          pod2Vessel = extractVesselFromLog(log);
          break;
        }

        // For bulk purchases (vessels): 1 log with total, multiple transactions per item
        // Check if price_per_vessel matches the transaction
        const perItemPrice = extractPerItemPriceFromLog(log);
        if (perItemPrice > 0 && perItemPrice === pod1Abs) {
          pod2Match = log;
          pod2Vessel = extractVesselFromLog(log);
          break;
        }
      }
    }

    // Mark POD2 log as used (for single-match contexts)
    if (pod2Match && !isMultiMatchContext) {
      usedPod2Ids.add(pod2Match.id);
    }

    // Find POD3 match (for departures, harbor fees, and guard fees)
    let pod3Match = null;
    let pod3Vessel = null;

    if (tx.context === 'vessels_departed' || tx.context === 'harbor_fee_on_depart' || tx.context === 'guard_payment_on_depart') {
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

    if (needsRematch) {
      // Update existing entry with new match data
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
      // Insert new lookup entry
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

  setMetadata(userId, 'lookup_last_sync', String(Date.now()));
  setMetadata(userId, 'lookup_version', String(STORE_VERSION));

  const countRow = db.prepare('SELECT COUNT(*) as count FROM lookup').get();

  // Clear build status
  buildStatus.delete(userId);

  logger.info(`[LookupStore/SQLite] Built ${newCount} new, rematched ${rematchedCount}, POD2=${matchedPod2}, POD3=${matchedPod3}`);

  return {
    newEntries: newCount,
    rematchedEntries: rematchedCount,
    totalEntries: countRow.count,
    matchedPod2,
    matchedPod3
  };
}

/**
 * Get contexts from autopilot name
 * Returns array of possible game transaction contexts for an autopilot
 * (some autopilots handle multiple transaction types)
 *
 * @param {string} autopilot - Autopilot name
 * @returns {string[]} Array of contexts or empty array
 */
function getContextsFromAutopilot(autopilot) {
  const mapping = {
    // Departures (also handles harbor fees)
    'Auto-Depart': ['vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart'],
    'Manual Depart': ['vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart'],
    // Fuel
    'Auto-Fuel': ['fuel_purchased'],
    'Manual Fuel Purchase': ['fuel_purchased'],
    // CO2
    'Auto-CO2': ['co2_emission_quota'],
    'Manual CO2 Purchase': ['co2_emission_quota'],
    // Repair
    'Auto-Repair': ['bulk_wear_maintenance'],
    'Manual Bulk Repair': ['bulk_wear_maintenance'],
    // Drydock (handles both bulk and single)
    'Auto-Drydock': ['bulk_vessel_major_service', 'vessel_major_service'],
    'Manual Bulk Drydock': ['bulk_vessel_major_service', 'vessel_major_service'],
    // Anchor points
    'Auto-Anchor': ['anchor_points'],
    'Manual Anchor Purchase': ['anchor_points'],
    // Marketing campaigns
    'Auto-Campaign': ['marketing_campaign_activation'],
    'Campaign Activation': ['marketing_campaign_activation'],
    // Hijacking ransom
    'Captain Blackbeard': ['hijacking', 'Hijacking'],
    'Auto-Blackbeard': ['hijacking'],
    'Manual Pay Ransom': ['hijacking'],
    'Manual Negotiate Hijacking': ['hijacking'],
    // Stock transactions
    'Manual Stock Purchase': ['purchase_stock'],
    'Manual Stock Sale': ['sell_stock'],
    'The Purser': ['purchase_stock', 'sell_stock'],
    // Route creation
    'Manual Route Planner': ['route_fee_on_creating'],
    // Vessel transactions
    'Manual Vessel Build': ['Vessel Build Purchase', 'vessel_build_purchase', 'Vessel_build_Purchase'],
    'Manual Vessel Purchase': ['buy_vessel', 'Buy Vessel'],
    'Manual Vessel Sale': ['sell_vessel', 'sold_vessel_in_port', 'Sold_vessel_in_port']
  };
  return mapping[autopilot] || [];
}

/**
 * Extract cash value from log entry
 * Priority:
 * 1. details.totalCost (most reliable for bulk operations)
 * 2. details.cost (fallback)
 * 3. details.actualCost (for fuel/co2 purchases)
 * 4. Parse from summary text (last resort)
 *
 * @param {Object} log - Log entry
 * @returns {number} Cash value (always positive, caller handles sign)
 */
function extractCashFromLog(log) {
  // Try to get from details first (most reliable)
  if (log.details) {
    try {
      const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;

      // Auto-* logs use camelCase, Manual * logs use snake_case
      // Check both variants for each field type

      // Total cost (bulk operations, purchases)
      if (details.totalCost !== undefined) return Math.abs(details.totalCost);
      if (details.total_cost !== undefined) return Math.abs(details.total_cost);

      // Actual cost (fuel/co2)
      if (details.actualCost !== undefined) return Math.abs(details.actualCost);
      if (details.actual_cost !== undefined) return Math.abs(details.actual_cost);

      // Total price (vessel sales)
      if (details.totalPrice !== undefined) return Math.abs(details.totalPrice);
      if (details.total_price !== undefined) return Math.abs(details.total_price);

      // Total fee (route creation)
      if (details.totalFee !== undefined) return Math.abs(details.totalFee);
      if (details.total_fee !== undefined) return Math.abs(details.total_fee);

      // Build cost (vessel build)
      if (details.buildCost !== undefined) return Math.abs(details.buildCost);
      if (details.build_cost !== undefined) return Math.abs(details.build_cost);

      // Generic cost field
      if (details.cost !== undefined) return Math.abs(details.cost);

      // Hijacking ransom (Captain Blackbeard)
      if (details.finalPayment !== undefined) return Math.abs(details.finalPayment);
      if (details.final_payment !== undefined) return Math.abs(details.final_payment);

      // Total revenue (departures)
      if (details.totalRevenue !== undefined) return Math.abs(details.totalRevenue);
      if (details.total_revenue !== undefined) return Math.abs(details.total_revenue);
    } catch {
      // Fall through to summary parsing
    }
  }

  // Fallback: parse from summary text
  if (!log.summary) return 0;

  const matches = [...log.summary.matchAll(/([+-]?)\$([0-9.,]+)/g)];
  if (matches.length === 0) return 0;

  const lastMatch = matches[matches.length - 1];
  const amount = parseInt(lastMatch[2].replace(/[,.]/g, ''), 10);

  return amount; // Return positive, caller handles sign comparison
}

/**
 * Extract price per unit from log entry (for CO2/Fuel tolerance matching)
 * @param {Object} log - Log entry
 * @returns {number} Price per unit or 0 if not found
 */
function extractPriceFromLog(log) {
  if (!log.details) return 0;

  try {
    const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
    // CO2/Fuel logs have 'price' field (camelCase for Auto-*, snake_case for Manual *)
    if (details.price !== undefined) return Math.abs(details.price);
    if (details.price_per_ton !== undefined) return Math.abs(details.price_per_ton);
    if (details.pricePerTon !== undefined) return Math.abs(details.pricePerTon);
  } catch {
    return 0;
  }

  return 0;
}

/**
 * Extract per-item price from log entry (for bulk vessel purchases)
 * @param {Object} log - Log entry
 * @returns {number} Price per item or 0 if not found
 */
function extractPerItemPriceFromLog(log) {
  if (!log.details) return 0;

  try {
    const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
    // Vessel purchase logs have vessels array with price_per_vessel
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
  buildLookupAsync,  // Non-blocking worker thread version
  cancelBuild,
  getBuildStatus,
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
