/**
 * @fileoverview Lookup Store (POD4)
 *
 * Combines data from all three PODs into a unified lookup table:
 * - POD1: Game Transactions (transaction-store.js)
 * - POD2: Audit Log (logbook.js)
 * - POD3: Vessel History (vessel-history-store.js)
 *
 * Matching algorithm:
 * 1. Exact: timestamp === pod2.timestamp && cash === pod2.cash
 * 2. Near: |timestamp - pod2.timestamp| <= 2000ms && cash === pod2.cash
 * 3. Tolerant: |timestamp - pod2.timestamp| <= 2000ms && |cash - pod2.cash| <= cash * 0.10
 *
 * @module server/analytics/lookup-store
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { getAppBaseDir } = require('../config');

const { isPackaged } = require('../config');
const isPkg = isPackaged();
const DATA_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'analytics')
  : path.join(__dirname, '../../userdata/analytics');

// Store version - increment when matching logic changes to force rebuild
const STORE_VERSION = 2; // v2: Added POD3 calculation fallback (brutto - harborFee = netto)

// Context to type/value mapping
const CONTEXT_MAPPING = {
  // INCOME
  'vessels_departed': { type: 'Departure', value: 'INCOME' },
  'sell_stock': { type: 'Stock Sale', value: 'INCOME' },
  'Increase_shares': { type: 'Dividends', value: 'INCOME' },
  'sell_vessel': { type: 'Vessel Sale', value: 'INCOME' },
  'Sold_vessel_in_port': { type: 'Vessel Sale', value: 'INCOME' },
  'daily_bonus': { type: 'Bonus', value: 'INCOME' },
  'ad_video': { type: 'Ad Bonus', value: 'INCOME' },

  // EXPENSE (real expenses)
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

  // EXPENSE - Departure shows BRUTTO, so harbor/guard fees are real expenses
  'harbor_fee_on_depart': { type: 'Harbor Fee', value: 'EXPENSE' },
  'guard_payment_on_depart': { type: 'Guard Fee', value: 'EXPENSE' }
};

// Autopilot action to context mapping for POD2 matching
const AUTOPILOT_TO_CONTEXT = {
  'Auto-Depart': 'vessels_departed',
  'Manual Depart': 'vessels_departed',
  'Auto-Fuel': 'fuel_purchased',
  'Manual Fuel Purchase': 'fuel_purchased',
  'Auto-CO2': 'co2_emission_quota',
  'Manual CO2 Purchase': 'co2_emission_quota',
  'Auto-Repair': 'bulk_wear_maintenance',
  'Manual Bulk Repair': 'bulk_wear_maintenance',
  'Auto-Drydock': 'bulk_vessel_major_service',
  'Manual Bulk Drydock': 'bulk_vessel_major_service',
  'Auto-Campaign': 'marketing_campaign_activation',
  'Campaign Activation': 'marketing_campaign_activation',
  'Auto-Anchor': 'anchor_points',
  'Manual Anchor Purchase': 'anchor_points',
  'Manual Vessel Purchase': 'buy_vessel',
  'Manual Vessel Sale': 'Sold_vessel_in_port',
  'Manual Stock Purchase': 'purchase_stock',
  'Manual Stock Sale': 'sell_stock',
  'Auto-Blackbeard': 'hijacking',
  'Manual Ransom': 'hijacking',
  'Manual Pay Ransom': 'hijacking',
  'Manual Route Planner': 'route_fee_on_creating',
  'Manual Vessel Build': 'Vessel_build_Purchase'
};


/**
 * Get file path for user's lookup store
 * @param {string} userId - User ID
 * @returns {string} File path
 */
function getStorePath(userId) {
  return path.join(DATA_DIR, `${userId}-lookup.json`);
}

/**
 * Ensure analytics directory exists
 */
async function ensureDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logger.error('[LookupStore] Failed to create directory:', err);
    }
  }
}

/**
 * Load stored lookup from disk
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Lookup data
 */
async function loadStore(userId) {
  try {
    const filePath = getStorePath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        userId,
        lastSync: 0,
        entries: []
      };
    }
    logger.error('[LookupStore] Failed to load store:', err);
    return {
      userId,
      lastSync: 0,
      entries: []
    };
  }
}

/**
 * Save lookup to disk
 * @param {string} userId - User ID
 * @param {Object} store - Lookup store data
 */
async function saveStore(userId, store) {
  await ensureDir();
  const filePath = getStorePath(userId);
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Extract cash amounts from audit log entry
 * For departures: Returns array of {cash, vessel} per vessel
 * For other actions: Returns array with single {cash, vessel: null}
 * @param {Object} entry - Audit log entry with summary and details
 * @returns {Array<{cash: number, vessel: Object|null}>} Array of cash/vessel pairs
 */
function extractCashFromEntry(entry) {
  if (!entry) return [];

  // For departures: each vessel has income + harborFee = brutto
  if (entry.autopilot === 'Auto-Depart' || entry.autopilot === 'Manual Depart') {
    const vessels = entry.details?.departedVessels || [];
    return vessels.map(v => ({
      cash: v.income + Math.abs(v.harborFee || 0),
      vessel: v
    }));
  }

  // For drydock: check details.totalCost (Auto) or details.total_cost (Manual)
  if (entry.autopilot === 'Auto-Drydock' || entry.autopilot === 'Manual Bulk Drydock') {
    const totalCost = entry.details?.totalCost || entry.details?.total_cost;
    if (totalCost) {
      return [{ cash: -Math.abs(totalCost), vessel: null }];
    }
  }

  // For repairs: check details.totalCost (Auto) or details.total_cost (Manual)
  if (entry.autopilot === 'Auto-Repair' || entry.autopilot === 'Manual Bulk Repair') {
    const totalCost = entry.details?.totalCost || entry.details?.total_cost;
    if (totalCost) {
      return [{ cash: -Math.abs(totalCost), vessel: null }];
    }
  }

  // For hijacking/ransom: check details.finalPayment, pirate_counter, or amount_paid
  if (entry.autopilot === 'Auto-Blackbeard' || entry.autopilot === 'Manual Ransom' || entry.autopilot === 'Manual Pay Ransom') {
    const payment = entry.details?.finalPayment || entry.details?.pirate_counter || entry.details?.amount_paid;
    if (payment) {
      return [{ cash: -Math.abs(payment), vessel: null }];
    }
  }

  // For route planner: check details.total_fee
  if (entry.autopilot === 'Manual Route Planner') {
    const totalFee = entry.details?.total_fee;
    if (totalFee) {
      return [{ cash: -Math.abs(totalFee), vessel: null }];
    }
  }

  // For vessel build: check details.build_cost
  if (entry.autopilot === 'Manual Vessel Build') {
    const buildCost = entry.details?.build_cost;
    if (buildCost) {
      return [{ cash: -Math.abs(buildCost), vessel: null }];
    }
    // For old entries without build_cost, mark with special flag for time-only matching
    return [{ cash: 'TIME_ONLY', vessel: null }];
  }

  // For vessel purchase: check details.total_cost
  if (entry.autopilot === 'Manual Vessel Purchase') {
    const totalCost = entry.details?.total_cost;
    if (totalCost) {
      return [{ cash: -Math.abs(totalCost), vessel: null }];
    }
    // Fall through to summary parsing if total_cost not available
  }

  // For vessel sale: check details.total_price (positive income)
  if (entry.autopilot === 'Manual Vessel Sale') {
    const totalPrice = entry.details?.total_price;
    if (totalPrice) {
      return [{ cash: Math.abs(totalPrice), vessel: null }];
    }
    // Fall through to summary parsing if total_price not available
  }

  const { summary } = entry;
  if (!summary || typeof summary !== 'string') return [];

  // Parse summary string for other actions
  const matches = [...summary.matchAll(/([+-]?)\$([0-9.,]+)/g)];
  if (matches.length === 0) return [];

  const lastMatch = matches[matches.length - 1];
  const sign = lastMatch[1] === '-' ? -1 : 1;
  const amount = parseInt(lastMatch[2].replace(/[,.]/g, ''), 10);
  // For expense categories without sign, assume negative
  const expenseAutopilots = ['Auto-Drydock', 'Manual Bulk Drydock', 'Auto-Repair', 'Manual Bulk Repair',
                              'Auto-Fuel', 'Manual Fuel Purchase', 'Auto-CO2', 'Manual CO2 Purchase',
                              'Auto-Campaign', 'Campaign Activation', 'Auto-Anchor', 'Manual Anchor Purchase',
                              'Manual Route Planner'];
  const isExpense = expenseAutopilots.includes(entry.autopilot);
  const finalSign = lastMatch[1] ? sign : (isExpense ? -1 : 1);
  return [{ cash: finalSign * amount, vessel: null }];
}

/**
 * Check if two values match within tolerance
 * @param {number} a - First value
 * @param {number} b - Second value
 * @param {number} tolerancePercent - Tolerance as decimal (0.05 = 5%)
 * @returns {boolean} True if match
 */
function valuesMatch(a, b, tolerancePercent = 0) {
  if (a === b) return true;
  if (tolerancePercent === 0) return false;

  const tolerance = Math.abs(a) * tolerancePercent;
  return Math.abs(a - b) <= tolerance;
}

/**
 * Build an index of POD2 entries by context for fast lookup
 * For departures: creates one entry per vessel with vessel-specific brutto
 * @param {Array} pod2Entries - All POD2 entries
 * @returns {Map} Map of context -> array of {entry, cash, vessel}
 */
function buildPod2Index(pod2Entries) {
  const index = new Map();
  let totalIndexed = 0;
  let skippedNoContext = 0;
  let skippedNoCash = 0;

  for (const entry of pod2Entries) {
    const context = AUTOPILOT_TO_CONTEXT[entry.autopilot];
    if (!context) {
      skippedNoContext++;
      continue;
    }

    const cashVesselPairs = extractCashFromEntry(entry);
    if (cashVesselPairs.length === 0) {
      skippedNoCash++;
      continue;
    }

    if (!index.has(context)) {
      index.set(context, []);
    }

    // Add one index entry per vessel (with vessel details for departures)
    for (const { cash, vessel } of cashVesselPairs) {
      index.get(context).push({ entry, cash, vessel });
      totalIndexed++;
    }
  }

  logger.info(`[LookupStore] POD2 index: ${totalIndexed} indexed, ${skippedNoContext} skipped (no context), ${skippedNoCash} skipped (no cash)`);
  return index;
}

// Time tolerance for matching (10 minutes = 600000ms)
// If amount matches exactly, 10 min tolerance is safe
const TIME_TOLERANCE_MS = 600000;

/**
 * Find matching POD2 entry for harbor fee by searching departure entries
 * @param {Object} pod1Entry - Harbor fee transaction from POD1
 * @param {Map} pod2Index - Pre-built index of POD2 entries by context
 * @returns {{entry: Object, matchedVessel: Object|null}|null} Matched entry with vessel or null
 */
function findPod2MatchForHarborFee(pod1Entry, pod2Index) {
  const pod1Time = pod1Entry.time * 1000; // Convert to ms
  const pod1Cash = Math.abs(pod1Entry.cash); // Harbor fees are negative in POD1

  // Look in departure entries for matching harbor fee
  const departureCandidates = pod2Index.get('vessels_departed');
  if (!departureCandidates || departureCandidates.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestVessel = null;
  let bestTimeDiff = Infinity;

  for (const { entry, vessel } of departureCandidates) {
    const timeDiff = Math.abs(entry.timestamp - pod1Time);
    if (timeDiff > TIME_TOLERANCE_MS) continue;

    // Check if this vessel's harborFee matches
    if (vessel) {
      const vesselHarborFee = Math.abs(vessel.harborFee || 0);
      if (vesselHarborFee === pod1Cash && timeDiff < bestTimeDiff) {
        bestMatch = entry;
        bestVessel = vessel;
        bestTimeDiff = timeDiff;
      }
    }
  }

  if (bestMatch) return { entry: bestMatch, matchedVessel: bestVessel };
  return null;
}

/**
 * Find matching POD2 entry for route fee by searching departure entries
 * Route fees are paid when routes are assigned, just before departure
 * Match by finding the closest departure within time window
 * @param {Object} pod1Entry - Route fee transaction from POD1
 * @param {Map} pod2Index - Pre-built index of POD2 entries by context
 * @returns {{entry: Object, matchedVessel: Object|null}|null} Matched entry with vessel or null
 */
function findPod2MatchForRouteFee(pod1Entry, pod2Index) {
  const pod1Time = pod1Entry.time * 1000; // Convert to ms

  // Look in departure entries - route fee is paid just before departure
  const departureCandidates = pod2Index.get('vessels_departed');
  if (!departureCandidates || departureCandidates.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestVessel = null;
  let bestTimeDiff = Infinity;

  for (const { entry, vessel } of departureCandidates) {
    const timeDiff = Math.abs(entry.timestamp - pod1Time);
    if (timeDiff > TIME_TOLERANCE_MS) continue;

    // Match closest departure to route fee time
    if (timeDiff < bestTimeDiff) {
      bestMatch = entry;
      bestVessel = vessel;
      bestTimeDiff = timeDiff;
    }
  }

  if (bestMatch) return { entry: bestMatch, matchedVessel: bestVessel };
  return null;
}

/**
 * Find matching POD2 entry for guard fee by searching departure entries
 * Matches by guard count: $700 per guard
 * @param {Object} pod1Entry - Guard fee transaction from POD1
 * @param {Map} pod2Index - Pre-built index of POD2 entries by context
 * @returns {{entry: Object, matchedVessel: Object|null}|null} Matched entry with vessel or null
 */
function findPod2MatchForGuardFee(pod1Entry, pod2Index) {
  const pod1Time = pod1Entry.time * 1000; // Convert to ms
  const pod1Guards = Math.round(Math.abs(pod1Entry.cash) / 700); // $700 per guard

  // Look in departure entries for matching guard count
  const departureCandidates = pod2Index.get('vessels_departed');
  if (!departureCandidates || departureCandidates.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestVessel = null;
  let bestTimeDiff = Infinity;

  for (const { entry, vessel } of departureCandidates) {
    const timeDiff = Math.abs(entry.timestamp - pod1Time);
    if (timeDiff > TIME_TOLERANCE_MS) continue;

    // Check if this vessel's guards count matches (convert both to int for comparison)
    const vesselGuards = parseInt(vessel?.guards, 10);
    if (vessel && vesselGuards === pod1Guards && timeDiff < bestTimeDiff) {
      bestMatch = entry;
      bestVessel = vessel;
      bestTimeDiff = timeDiff;
    }
  }

  if (bestMatch) return { entry: bestMatch, matchedVessel: bestVessel };
  return null;
}

/**
 * Find matching POD2 entry for a POD1 transaction using pre-built index
 * @param {Object} pod1Entry - Transaction from POD1
 * @param {Map} pod2Index - Pre-built index of POD2 entries by context
 * @param {Set} usedPod2Ids - Set of already matched POD2 IDs
 * @returns {{entry: Object, matchedVessel: Object|null}|null} Matched entry with vessel or null
 */
function findPod2Match(pod1Entry, pod2Index, usedPod2Ids) {
  const pod1Time = pod1Entry.time * 1000; // Convert to ms
  const pod1Cash = pod1Entry.cash;
  const pod1Context = pod1Entry.context;

  // Special handling for harbor fees - match against departure entries by harborFee
  if (pod1Context === 'harbor_fee_on_depart') {
    return findPod2MatchForHarborFee(pod1Entry, pod2Index);
  }

  // Special handling for guard fees - match against departure entries by guards count
  if (pod1Context === 'guard_payment_on_depart') {
    return findPod2MatchForGuardFee(pod1Entry, pod2Index);
  }

  // Special handling for route fees - match against departure entries by time
  if (pod1Context === 'route_fee_on_creating') {
    return findPod2MatchForRouteFee(pod1Entry, pod2Index);
  }

  // Get candidates from index
  const candidates = pod2Index.get(pod1Context);
  if (!candidates || candidates.length === 0) {
    return null;
  }

  // For departures, don't filter by usedPod2Ids - multiple POD1 entries
  // (departure + harbor fee + guard fee) can share the same audit entry
  const skipUsedFilter = pod1Context === 'vessels_departed';
  const available = skipUsedFilter
    ? candidates
    : candidates.filter(c => !usedPod2Ids.has(c.entry.id));

  // Try exact cash match within time window, prefer closest time
  let bestMatch = null;
  let bestVessel = null;
  let bestTimeDiff = Infinity;

  for (const { entry, cash, vessel } of available) {
    const timeDiff = Math.abs(entry.timestamp - pod1Time);

    // Must be within time tolerance
    if (timeDiff > TIME_TOLERANCE_MS) continue;

    // TIME_ONLY entries match by time only (for old entries without amount)
    if (cash === 'TIME_ONLY' && timeDiff < bestTimeDiff) {
      bestMatch = entry;
      bestVessel = vessel;
      bestTimeDiff = timeDiff;
      continue;
    }

    // Exact cash match - prefer closest time
    if (cash === pod1Cash && timeDiff < bestTimeDiff) {
      bestMatch = entry;
      bestVessel = vessel;
      bestTimeDiff = timeDiff;
    }
  }

  if (bestMatch) return { entry: bestMatch, matchedVessel: bestVessel };

  // Try tolerant cash match (+-5%) within time window
  for (const { entry, cash, vessel } of available) {
    const timeDiff = Math.abs(entry.timestamp - pod1Time);

    if (timeDiff > TIME_TOLERANCE_MS) continue;

    // Skip TIME_ONLY entries (already matched above)
    if (cash === 'TIME_ONLY') continue;

    if (valuesMatch(pod1Cash, cash, 0.10) && timeDiff < bestTimeDiff) {
      bestMatch = entry;
      bestVessel = vessel;
      bestTimeDiff = timeDiff;
    }
  }

  if (bestMatch) return { entry: bestMatch, matchedVessel: bestVessel };
  return null;
}

/**
 * Build an index of POD3 entries with pre-extracted income per vessel
 * Note: Game API vessel history only has income, no harborFee
 * @param {Array} pod3Entries - All POD3 entries
 * @returns {Array} Array of {entry, income, vessel}
 */
function buildPod3Index(pod3Entries) {
  const indexed = [];
  let skippedNoIncome = 0;
  for (const entry of pod3Entries) {
    const vessels = entry.details?.departedVessels || [];
    for (const v of vessels) {
      // Game history only has income (netto), no harborFee
      if (v.income) {
        indexed.push({ entry, income: v.income, vessel: v });
      } else {
        skippedNoIncome++;
      }
    }
  }
  if (skippedNoIncome > 0) {
    logger.debug(`[LookupStore] POD3 index: ${skippedNoIncome} vessels skipped (no income)`);
  }
  return indexed;
}

// Contexts that are related to vessel departures (should match POD3)
const DEPARTURE_RELATED_CONTEXTS = [
  'vessels_departed',
  'harbor_fee_on_depart',
  'guard_payment_on_depart'
];

/**
 * Find matching POD3 entry using POD2 vessel's income
 * Game history only has income (netto), so we need POD2's vessel income for matching
 * @param {Object} pod1Entry - Transaction from POD1
 * @param {Array} pod3Index - Pre-built index of POD3 entries (indexed by income)
 * @param {Object|null} pod2Vessel - Matched vessel from POD2 (has income field)
 * @returns {{entry: Object, matchedVessel: Object}|null} Matched entry with vessel or null
 */
function findPod3Match(pod1Entry, pod3Index, pod2Vessel) {
  // Only match departure-related contexts
  if (!DEPARTURE_RELATED_CONTEXTS.includes(pod1Entry.context)) return null;

  const pod1Time = pod1Entry.time * 1000; // Convert to ms

  let bestMatch = null;
  let bestVessel = null;
  let bestTimeDiff = Infinity;

  // If we have POD2 vessel, use income-based matching (preferred)
  if (pod2Vessel && pod2Vessel.income) {
    const searchIncome = pod2Vessel.income;

    // Try exact income match within time window, prefer closest time
    for (const { entry, income, vessel } of pod3Index) {
      const timeDiff = Math.abs(entry.timestamp - pod1Time);

      // Must be within time tolerance
      if (timeDiff > TIME_TOLERANCE_MS) continue;

      // Exact income match - prefer closest time
      if (income === searchIncome && timeDiff < bestTimeDiff) {
        bestMatch = entry;
        bestVessel = vessel;
        bestTimeDiff = timeDiff;
      }
    }

    if (bestMatch) return { entry: bestMatch, matchedVessel: bestVessel };

    // Try tolerant income match (+-5%) within time window
    for (const { entry, income, vessel } of pod3Index) {
      const timeDiff = Math.abs(entry.timestamp - pod1Time);

      if (timeDiff > TIME_TOLERANCE_MS) continue;

      if (valuesMatch(searchIncome, income, 0.05) && timeDiff < bestTimeDiff) {
        bestMatch = entry;
        bestVessel = vessel;
        bestTimeDiff = timeDiff;
      }
    }

    if (bestMatch) return { entry: bestMatch, matchedVessel: bestVessel };
  }

  return null;
}

/**
 * Find POD3 match by calculating netto from brutto - harborFee
 * Used when POD2 is not available
 * @param {Object} pod1Entry - Transaction from POD1 (vessels_departed)
 * @param {Array} pod3Index - Pre-built index of POD3 entries
 * @param {Array} pod1Transactions - All POD1 transactions (to find harbor_fee)
 * @returns {{entry: Object, matchedVessel: Object}|null}
 */
function findPod3MatchByCalculation(pod1Entry, pod3Index, pod1Transactions) {
  if (pod1Entry.context !== 'vessels_departed') return null;

  const pod1Time = pod1Entry.time * 1000;
  const pod1Brutto = pod1Entry.cash;

  // Find corresponding harbor_fee_on_depart at same timestamp
  const harborFeeEntry = pod1Transactions.find(t =>
    t.context === 'harbor_fee_on_depart' &&
    t.time === pod1Entry.time
  );

  if (!harborFeeEntry) {
    // No harbor fee found - brutto might equal netto (0% fee)
    logger.debug(`[LookupStore] No harbor_fee_on_depart found for time ${pod1Time}, using brutto as netto`);
  }

  // Calculate netto: brutto - abs(harborFee)
  const harborFee = harborFeeEntry ? Math.abs(harborFeeEntry.cash) : 0;
  const calculatedNetto = pod1Brutto - harborFee;

  logger.debug(`[LookupStore] Calculated netto: ${pod1Brutto} - ${harborFee} = ${calculatedNetto}`);

  let bestMatch = null;
  let bestVessel = null;
  let bestTimeDiff = Infinity;

  // Try exact income match within time window
  for (const { entry, income, vessel } of pod3Index) {
    const timeDiff = Math.abs(entry.timestamp - pod1Time);

    if (timeDiff > TIME_TOLERANCE_MS) continue;

    // Exact netto match - prefer closest time
    if (income === calculatedNetto && timeDiff < bestTimeDiff) {
      bestMatch = entry;
      bestVessel = vessel;
      bestTimeDiff = timeDiff;
    }
  }

  if (bestMatch) {
    logger.debug(`[LookupStore] POD3 calculated match: vessel=${bestVessel?.name}, income=${calculatedNetto}, timeDiff=${bestTimeDiff}ms`);
    return { entry: bestMatch, matchedVessel: bestVessel };
  }

  // Try tolerant match (+-1% for rounding differences)
  for (const { entry, income, vessel } of pod3Index) {
    const timeDiff = Math.abs(entry.timestamp - pod1Time);

    if (timeDiff > TIME_TOLERANCE_MS) continue;

    if (valuesMatch(calculatedNetto, income, 0.01) && timeDiff < bestTimeDiff) {
      bestMatch = entry;
      bestVessel = vessel;
      bestTimeDiff = timeDiff;
    }
  }

  if (bestMatch) {
    logger.debug(`[LookupStore] POD3 tolerant calculated match: vessel=${bestVessel?.name}, timeDiff=${bestTimeDiff}ms`);
    return { entry: bestMatch, matchedVessel: bestVessel };
  }

  return null;
}

/**
 * Build lookup entries from all three PODs
 * @param {string} userId - User ID
 * @param {number} days - Number of days to process (0 = all)
 * @returns {Promise<Object>} Build result
 */
async function buildLookup(userId, days = 0) {
  const transactionStore = require('./transaction-store');
  const vesselHistoryStore = require('./vessel-history-store');
  const { getLogEntries } = require('../logbook');

  // Load all data
  const pod1 = days > 0
    ? await transactionStore.getTransactionsByDays(userId, days)
    : await transactionStore.getTransactions(userId);

  // Get all log entries (no time filter - we filter manually if needed)
  let pod2 = await getLogEntries(userId, {});
  if (days > 0) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    pod2 = pod2.filter(e => e.timestamp >= cutoff);
  }

  const pod3 = days > 0
    ? await vesselHistoryStore.getDeparturesByDays(userId, days)
    : await vesselHistoryStore.getDepartures(userId);

  logger.info(`[LookupStore] Building lookup: POD1=${pod1.length}, POD2=${pod2.length}, POD3=${pod3.length}`);

  // Build indexes for fast lookups (O(n) instead of O(n*m))
  const pod2Index = buildPod2Index(pod2);
  const pod3Index = buildPod3Index(pod3);
  logger.info(`[LookupStore] Indexes built: POD2=${pod2Index.size} contexts, POD3=${pod3Index.length} vessel entries`);

  // Debug: Log sample POD3 entries
  if (pod3Index.length > 0) {
    const sample = pod3Index.slice(0, 3);
    for (const s of sample) {
      logger.debug(`[LookupStore] POD3 sample: income=${s.income}, vessel=${s.vessel?.name}, time=${s.entry?.timestamp}`);
    }
  } else {
    logger.warn(`[LookupStore] POD3 index is EMPTY - vessel history may not be synced`);
  }

  const store = await loadStore(userId);
  const existingIds = new Set(store.entries.map(e => e.pod1_id));
  const usedPod2Ids = new Set();

  let newCount = 0;
  let matchedPod2 = 0;
  let matchedPod3 = 0;

  // Process each POD1 transaction
  for (const pod1Entry of pod1) {
    // Skip if already in lookup
    if (existingIds.has(pod1Entry.id)) continue;

    // Get type/value mapping
    const mapping = CONTEXT_MAPPING[pod1Entry.context];
    const type = mapping?.type || pod1Entry.context;
    const value = mapping?.value || (pod1Entry.cash >= 0 ? 'INCOME' : 'EXPENSE');

    // Find matches using indexes - now returns { entry, matchedVessel } or null
    const pod2Result = findPod2Match(pod1Entry, pod2Index, usedPod2Ids);
    const pod2Entry = pod2Result?.entry;
    const pod2Vessel = pod2Result?.matchedVessel;

    // POD3 matching: try with POD2 first, then use calculation fallback
    let pod3Result = findPod3Match(pod1Entry, pod3Index, pod2Vessel);

    // Fallback: If POD2 not available, calculate netto from brutto - harborFee
    if (!pod3Result && pod1Entry.context === 'vessels_departed') {
      pod3Result = findPod3MatchByCalculation(pod1Entry, pod3Index, pod1);
    }

    const pod3Entry = pod3Result?.entry;
    const pod3Vessel = pod3Result?.matchedVessel;

    // Debug: Log POD3 matching failures for departures
    if (!pod3Result && pod1Entry.context === 'vessels_departed' && pod2Vessel) {
      // Find closest POD3 entry by income to see why it didn't match
      let closestDiff = Infinity;
      let closestEntry = null;
      for (const p3 of pod3Index) {
        const diff = Math.abs(p3.income - pod2Vessel.income);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestEntry = p3;
        }
      }
      if (closestEntry) {
        const timeDiff = Math.abs(closestEntry.entry.timestamp - (pod1Entry.time * 1000));
        logger.debug(`[LookupStore] POD3 miss: search=${pod2Vessel.income}, closest=${closestEntry.income} (diff=${closestDiff}), timeDiff=${timeDiff}ms, tolerance=${TIME_TOLERANCE_MS}ms`);
      }
    }

    if (pod2Entry) {
      usedPod2Ids.add(pod2Entry.id);
      matchedPod2++;
    }
    if (pod3Entry) {
      matchedPod3++;
    }

    // Create lookup entry with matched vessel details
    const lookupEntry = {
      id: `lookup_${crypto.randomUUID()}`,
      timestamp: pod1Entry.time * 1000, // Primary timestamp in ms
      pod1_id: pod1Entry.id,
      pod2_id: pod2Entry?.id || null,
      pod3_id: pod3Entry?.id || null,
      pod1_timestamp: pod1Entry.time * 1000,
      pod2_timestamp: pod2Entry?.timestamp || null,
      pod3_timestamp: pod3Entry?.timestamp || null,
      pod2_vessel: pod2Vessel || null,
      pod3_vessel: pod3Vessel || null,
      cash: pod1Entry.cash,
      cash_confirmed: true,
      type,
      value,
      context: pod1Entry.context
    };

    store.entries.push(lookupEntry);
    existingIds.add(pod1Entry.id);
    newCount++;
  }

  // Re-attempt POD3 matching for existing entries without POD3 match
  // This handles cases where vessel history synced AFTER the lookup entry was created
  let rematched = 0;
  if (pod3Index.length > 0) {
    for (const entry of store.entries) {
      // Only re-match departure-related contexts that don't have POD3 yet
      if (entry.pod3_id) continue;
      if (!DEPARTURE_RELATED_CONTEXTS.includes(entry.context)) continue;

      // Try to find POD3 match using pod2_vessel income
      let pod3Result = null;
      if (entry.pod2_vessel && entry.pod2_vessel.income) {
        // Create a fake pod1Entry for the matching function
        const fakePod1 = { time: entry.timestamp / 1000, context: entry.context };
        pod3Result = findPod3Match(fakePod1, pod3Index, entry.pod2_vessel);
      }

      if (pod3Result) {
        entry.pod3_id = pod3Result.entry.id;
        entry.pod3_timestamp = pod3Result.entry.timestamp;
        entry.pod3_vessel = pod3Result.matchedVessel;
        rematched++;
        matchedPod3++;
      }
    }
    if (rematched > 0) {
      logger.info(`[LookupStore] Re-matched ${rematched} existing entries with POD3`);
    }
  }

  // Sort by timestamp (newest first)
  store.entries.sort((a, b) => b.timestamp - a.timestamp);
  store.lastSync = Date.now();
  store.version = STORE_VERSION;

  await saveStore(userId, store);

  // Debug: Log some sample POD1 entries that didn't match
  const unmatchedSamples = store.entries.filter(e => !e.pod2_id).slice(0, 3);
  for (const sample of unmatchedSamples) {
    const candidates = pod2Index.get(sample.context);
    logger.debug(`[LookupStore] Unmatched POD1: context=${sample.context}, time=${sample.timestamp}, cash=${sample.cash}`);
    logger.debug(`[LookupStore]   POD2 candidates for context: ${candidates ? candidates.length : 0}`);
    if (candidates && candidates.length > 0) {
      const c = candidates[0];
      logger.debug(`[LookupStore]   First candidate: time=${c.entry.timestamp}, cash=${c.cash}, timeDiff=${Math.abs(c.entry.timestamp - sample.timestamp)}`);
    }
  }

  logger.info(`[LookupStore] Built ${newCount} new entries, matched POD2=${matchedPod2}, POD3=${matchedPod3}`);

  return {
    newEntries: newCount,
    totalEntries: store.entries.length,
    matchedPod2,
    matchedPod3
  };
}

/**
 * Get all lookup entries
 * @param {string} userId - User ID
 * @returns {Promise<Array>} All lookup entries
 */
async function getEntries(userId) {
  const store = await loadStore(userId);
  return store.entries;
}

/**
 * Get lookup entries within a time range
 * @param {string} userId - User ID
 * @param {number} days - Number of days to look back
 * @returns {Promise<Array>} Filtered entries
 */
async function getEntriesByDays(userId, days) {
  const store = await loadStore(userId);
  // days === 0 means "all time" - no filtering
  if (days === 0) return store.entries;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return store.entries.filter(e => e.timestamp >= cutoff);
}

/**
 * Get income/expense totals
 * @param {string} userId - User ID
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Object>} Totals
 */
async function getTotals(userId, days = 0) {
  const entries = days > 0
    ? await getEntriesByDays(userId, days)
    : await getEntries(userId);

  let totalIncome = 0;
  let totalExpense = 0;

  for (const entry of entries) {
    if (entry.value === 'INCOME') {
      totalIncome += entry.cash;
    } else if (entry.value === 'EXPENSE') {
      totalExpense += Math.abs(entry.cash);
    }
    // INFO entries are NOT counted
  }

  return {
    income: totalIncome,
    expense: totalExpense,
    profit: totalIncome - totalExpense,
    entryCount: entries.length
  };
}

/**
 * Get breakdown by day
 * @param {string} userId - User ID
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Array>} Daily breakdown sorted by date descending
 */
async function getBreakdownByDay(userId, days = 0) {
  const entries = days > 0
    ? await getEntriesByDays(userId, days)
    : await getEntries(userId);

  const daily = {};

  for (const entry of entries) {
    // Convert timestamp (ms) to date string (YYYY-MM-DD)
    const date = new Date(entry.timestamp).toISOString().split('T')[0];

    if (!daily[date]) {
      daily[date] = {
        date,
        income: 0,
        expenses: 0,
        net: 0,
        count: 0
      };
    }

    daily[date].count++;
    daily[date].net += entry.cash;

    if (entry.cash >= 0) {
      daily[date].income += entry.cash;
    } else {
      daily[date].expenses += Math.abs(entry.cash);
    }
  }

  // Convert to array and sort by date descending (newest first)
  return Object.values(daily).sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Get breakdown by type
 * @param {string} userId - User ID
 * @param {number} days - Number of days (0 = all)
 * @returns {Promise<Object>} Breakdown by type
 */
async function getBreakdownByType(userId, days = 0) {
  const entries = days > 0
    ? await getEntriesByDays(userId, days)
    : await getEntries(userId);

  const breakdown = {};

  for (const entry of entries) {
    const type = entry.type;
    if (!breakdown[type]) {
      breakdown[type] = {
        type,
        value: entry.value,
        count: 0,
        total: 0
      };
    }
    breakdown[type].count++;
    breakdown[type].total += entry.cash;
  }

  return breakdown;
}

/**
 * Get full entry details by lookup ID
 * @param {string} userId - User ID
 * @param {string} lookupId - Lookup entry ID
 * @returns {Promise<Object|null>} Full details from all PODs
 */
async function getEntryDetails(userId, lookupId) {
  const store = await loadStore(userId);
  const entry = store.entries.find(e => e.id === lookupId);

  if (!entry) return null;

  const transactionStore = require('./transaction-store');
  const vesselHistoryStore = require('./vessel-history-store');
  const { getLogEntries } = require('../logbook');

  // Get POD1 details
  let pod1Details = null;
  if (entry.pod1_id) {
    const transactions = await transactionStore.getTransactions(userId);
    pod1Details = transactions.find(t => t.id === entry.pod1_id);
  }

  // Get POD2 details
  let pod2Details = null;
  if (entry.pod2_id) {
    const logs = await getLogEntries(userId, { timeRange: 'all' });
    pod2Details = logs.find(l => l.id === entry.pod2_id);
  }

  // Get POD3 details
  let pod3Details = null;
  if (entry.pod3_id) {
    const departures = await vesselHistoryStore.getDepartures(userId);
    pod3Details = departures.find(d => d.id === entry.pod3_id);
  }

  // Fallback for hijacking: fetch vessel info from messenger if no pod2 match
  let messengerFallback = null;
  if (entry.context === 'hijacking' && !pod2Details && pod1Details) {
    try {
      const { apiCall } = require('../utils/api');
      const chatsResponse = await apiCall('/messenger/get-chats', 'POST', {});
      const chats = chatsResponse?.data || [];
      const hijackChats = chats.filter(c => c.subject === 'vessel_got_hijacked');

      // Match by time proximity
      const pod1Time = pod1Details.time * 1000;

      // Find closest match by amount within reasonable time window (1 hour)
      let bestMatch = null;
      let bestTimeDiff = Infinity;

      for (const chat of hijackChats) {
        const chatTime = chat.created_at * 1000;
        const timeDiff = Math.abs(chatTime - pod1Time);

        // Within 1 hour window
        if (timeDiff < 60 * 60 * 1000) {
          // Check if we have messages with final amount
          if (chat.values?.case_id && chat.values?.vessel_name) {
            if (timeDiff < bestTimeDiff) {
              bestTimeDiff = timeDiff;
              bestMatch = chat;
            }
          }
        }
      }

      if (bestMatch) {
        messengerFallback = {
          vessel_name: bestMatch.values.vessel_name,
          case_id: bestMatch.values.case_id,
          user_vessel_id: bestMatch.values.user_vessel_id
        };
      }
    } catch {
      // Silently fail - messenger lookup is optional fallback
    }
  }

  return {
    lookup: entry,
    pod1: pod1Details,
    pod2: pod2Details,
    pod3: pod3Details,
    messengerFallback
  };
}

/**
 * Get store metadata
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Store info
 */
async function getStoreInfo(userId) {
  const store = await loadStore(userId);

  // Check if store version is outdated
  const storeVersion = store.version || 1;
  const needsRebuild = storeVersion < STORE_VERSION;

  if (needsRebuild) {
    logger.info(`[LookupStore] Store version ${storeVersion} < ${STORE_VERSION}, rebuild recommended`);
  }

  if (store.entries.length === 0) {
    return {
      totalEntries: 0,
      oldestEntry: null,
      newestEntry: null,
      lastSync: store.lastSync,
      dataSpanDays: 0,
      version: storeVersion,
      currentVersion: STORE_VERSION,
      needsRebuild
    };
  }

  const sorted = [...store.entries].sort((a, b) => a.timestamp - b.timestamp);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const spanMs = newest.timestamp - oldest.timestamp;
  const spanDays = Math.ceil(spanMs / (24 * 60 * 60 * 1000));

  return {
    totalEntries: store.entries.length,
    oldestEntry: new Date(oldest.timestamp).toISOString(),
    newestEntry: new Date(newest.timestamp).toISOString(),
    lastSync: store.lastSync ? new Date(store.lastSync).toISOString() : null,
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
  const store = {
    userId,
    lastSync: 0,
    entries: []
  };
  await saveStore(userId, store);
  logger.info('[LookupStore] Store cleared');
}

module.exports = {
  buildLookup,
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
