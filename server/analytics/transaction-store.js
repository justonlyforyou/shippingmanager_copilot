/**
 * @fileoverview Transaction Store
 *
 * Fetches and stores game transaction history locally.
 * The game API only provides ~7 days of data via /user/get-weekly-transactions
 * This module stores all transactions persistently for long-term analytics.
 *
 * @module server/analytics/transaction-store
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { apiCallWithRetry } = require('../utils/api');
const { getAppBaseDir } = require('../config');

const isPkg = !!process.pkg;
const DATA_DIR = isPkg
  ? path.join(getAppBaseDir(), 'userdata', 'transactions')
  : path.join(__dirname, '../../userdata/transactions');

// Short-term cache for loadStore to avoid duplicate file reads
const FILE_CACHE_TTL = 2000; // 2 seconds
const storeCache = new Map(); // userId -> { data, timestamp }

/**
 * Generate deterministic ID for a transaction
 * @param {Object} transaction - Transaction object with time, context, cash
 * @returns {string} Unique ID
 */
function generateTransactionId(transaction) {
  return `pod1_${transaction.time}_${transaction.context}_${transaction.cash}`;
}

/**
 * Get file path for user's transaction store
 * @param {string} userId - User ID
 * @returns {string} File path
 */
function getStorePath(userId) {
  return path.join(DATA_DIR, `${userId}-transactions.json`);
}

/**
 * Ensure transactions directory exists
 */
async function ensureDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logger.error('[TransactionStore] Failed to create directory:', err);
    }
  }
}

/**
 * Load stored transactions from disk (cached for 2 seconds)
 * Migrates old entries without IDs by generating them
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Transaction data
 */
async function loadStore(userId) {
  const now = Date.now();
  const cached = storeCache.get(userId);

  if (cached && (now - cached.timestamp) < FILE_CACHE_TTL) {
    return cached.data;
  }

  try {
    const filePath = getStorePath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    const store = JSON.parse(data);

    // Migration: Add IDs to transactions that don't have them
    let migrated = 0;
    for (const t of store.transactions) {
      if (!t.id) {
        t.id = generateTransactionId(t);
        migrated++;
      }
    }

    // Save if we migrated any entries
    if (migrated > 0) {
      logger.info(`[TransactionStore] Migrated ${migrated} transactions with new IDs`);
      await saveStore(userId, store);
    }

    storeCache.set(userId, { data: store, timestamp: now });
    return store;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File doesn't exist yet
      const emptyStore = {
        userId,
        lastSync: 0,
        transactions: []
      };
      storeCache.set(userId, { data: emptyStore, timestamp: now });
      return emptyStore;
    }
    logger.error('[TransactionStore] Failed to load store:', err);
    return {
      userId,
      lastSync: 0,
      transactions: []
    };
  }
}

/**
 * Save transactions to disk
 * @param {string} userId - User ID
 * @param {Object} store - Transaction store data
 */
async function saveStore(userId, store) {
  await ensureDir();
  const filePath = getStorePath(userId);
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
  // Invalidate cache after write
  storeCache.delete(userId);
}

/**
 * Fetch transactions from game API
 * @returns {Promise<Array>} Array of transactions
 */
async function fetchFromAPI() {
  try {
    const response = await apiCallWithRetry('/user/get-weekly-transactions', 'GET', null);
    if (response.data && response.data.transactions) {
      return response.data.transactions;
    }
    return [];
  } catch (err) {
    logger.error('[TransactionStore] Failed to fetch from API:', err.message);
    return [];
  }
}

/**
 * Sync transactions from API
 * Merges new transactions with existing store
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Sync result
 */
async function syncTransactions(userId) {
  const store = await loadStore(userId);
  const apiTransactions = await fetchFromAPI();

  if (apiTransactions.length === 0) {
    logger.warn('[TransactionStore] No transactions received from API');
    return { synced: 0, total: store.transactions.length };
  }

  // Create a map of existing transactions by time+context+cash for deduplication
  const existingSet = new Set(
    store.transactions.map(t => `${t.time}-${t.context}-${t.cash}`)
  );

  // Add new transactions that don't already exist
  let newCount = 0;
  for (const transaction of apiTransactions) {
    const key = `${transaction.time}-${transaction.context}-${transaction.cash}`;
    if (!existingSet.has(key)) {
      // Add ID to new transaction
      transaction.id = generateTransactionId(transaction);
      store.transactions.push(transaction);
      existingSet.add(key);
      newCount++;
    }
  }

  // Sort by time (newest first for display, oldest first for storage)
  store.transactions.sort((a, b) => a.time - b.time);

  store.lastSync = Date.now();
  await saveStore(userId, store);

  logger.info(`[TransactionStore] Synced ${newCount} new transactions, total: ${store.transactions.length}`);
  return { synced: newCount, total: store.transactions.length };
}

/**
 * Get all stored transactions
 * @param {string} userId - User ID
 * @returns {Promise<Array>} All transactions
 */
async function getTransactions(userId) {
  const store = await loadStore(userId);
  return store.transactions;
}

/**
 * Get transactions within a time range
 * @param {string} userId - User ID
 * @param {number} days - Number of days to look back
 * @returns {Promise<Array>} Filtered transactions
 */
async function getTransactionsByDays(userId, days) {
  const store = await loadStore(userId);
  // days === 0 means "all time" - no filtering
  if (days === 0) return store.transactions;
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  return store.transactions.filter(t => t.time >= cutoff);
}

/**
 * Get transaction summary grouped by context
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze
 * @returns {Promise<Object>} Summary by context
 */
async function getTransactionSummary(userId, days) {
  const transactions = await getTransactionsByDays(userId, days);

  const summary = {};
  for (const t of transactions) {
    const context = t.context;
    if (!summary[context]) {
      summary[context] = {
        context,
        count: 0,
        totalIncome: 0,
        totalExpense: 0,
        netAmount: 0,
        transactions: []
      };
    }
    summary[context].count++;
    summary[context].netAmount += t.cash;
    if (t.cash >= 0) {
      summary[context].totalIncome += t.cash;
    } else {
      summary[context].totalExpense += Math.abs(t.cash);
    }
    summary[context].transactions.push(t);
  }

  return summary;
}

/**
 * Get daily breakdown of transactions
 * @param {string} userId - User ID
 * @param {number} days - Number of days
 * @returns {Promise<Object>} Daily breakdown
 */
async function getDailyBreakdown(userId, days) {
  const transactions = await getTransactionsByDays(userId, days);

  const daily = {};
  for (const t of transactions) {
    const date = new Date(t.time * 1000).toISOString().split('T')[0];
    if (!daily[date]) {
      daily[date] = {
        date,
        income: 0,
        expenses: 0,
        net: 0,
        byContext: {}
      };
    }
    daily[date].net += t.cash;
    if (t.cash >= 0) {
      daily[date].income += t.cash;
    } else {
      daily[date].expenses += Math.abs(t.cash);
    }

    if (!daily[date].byContext[t.context]) {
      daily[date].byContext[t.context] = 0;
    }
    daily[date].byContext[t.context] += t.cash;
  }

  // Sort by date
  return Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get all available transaction types/contexts
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Unique contexts
 */
async function getTransactionTypes(userId) {
  const store = await loadStore(userId);
  const contexts = new Set(store.transactions.map(t => t.context));
  return Array.from(contexts).sort();
}

/**
 * Get store metadata
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Store info
 */
async function getStoreInfo(userId) {
  const store = await loadStore(userId);

  if (store.transactions.length === 0) {
    return {
      totalTransactions: 0,
      oldestTransaction: null,
      newestTransaction: null,
      lastSync: store.lastSync,
      dataSpanDays: 0
    };
  }

  const sorted = [...store.transactions].sort((a, b) => a.time - b.time);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const spanSeconds = newest.time - oldest.time;
  const spanDays = Math.ceil(spanSeconds / (24 * 60 * 60));

  return {
    totalTransactions: store.transactions.length,
    oldestTransaction: new Date(oldest.time * 1000).toISOString(),
    newestTransaction: new Date(newest.time * 1000).toISOString(),
    lastSync: store.lastSync ? new Date(store.lastSync).toISOString() : null,
    dataSpanDays: spanDays
  };
}

// Auto-sync interval (5 minutes)
const SYNC_INTERVAL = 5 * 60 * 1000;
let syncInterval = null;

/**
 * Start automatic background sync
 * @param {string} userId - User ID to sync for
 */
function startAutoSync(userId) {
  if (syncInterval) {
    clearInterval(syncInterval);
  }

  // Do initial sync
  syncTransactions(userId).catch(err => {
    logger.error('[TransactionStore] Initial sync failed:', err.message);
  });

  // Set up recurring sync every 5 minutes
  syncInterval = setInterval(async () => {
    try {
      const result = await syncTransactions(userId);
      if (result.synced > 0) {
        logger.info(`[TransactionStore] Auto-sync: ${result.synced} new transactions`);

        // Rebuild lookup after new transactions
        const lookupStore = require('./lookup-store');
        const lookupResult = await lookupStore.buildLookup(userId, 0);
        logger.info(`[TransactionStore] Lookup rebuilt: ${lookupResult.newEntries} new, POD2=${lookupResult.matchedPod2}`);
      }
    } catch (err) {
      logger.error('[TransactionStore] Auto-sync failed:', err.message);
    }
  }, SYNC_INTERVAL);

  logger.info('[TransactionStore] Started auto-sync (every 5 minutes)');
}

/**
 * Stop automatic background sync
 */
function stopAutoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    logger.info('[TransactionStore] Stopped auto-sync');
  }
}

module.exports = {
  syncTransactions,
  getTransactions,
  getTransactionsByDays,
  getTransactionSummary,
  getDailyBreakdown,
  getTransactionTypes,
  getStoreInfo,
  startAutoSync,
  stopAutoSync,
  generateTransactionId
};
