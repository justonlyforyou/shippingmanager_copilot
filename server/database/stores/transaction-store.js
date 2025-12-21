/**
 * @fileoverview SQLite-based Transaction Store
 *
 * Drop-in replacement for the JSON-based transaction store.
 * All data is stored in SQLite for better performance and reliability.
 *
 * @module server/database/stores/transaction-store
 */

const logger = require('../../utils/logger');
const { apiCallWithRetry } = require('../../utils/api');
const { getDb, setMetadata, getMetadata } = require('../index');

/**
 * Generate deterministic ID for a transaction
 * @param {Object} transaction - Transaction object with time, context, cash
 * @returns {string} Unique ID
 */
function generateTransactionId(transaction) {
  return `pod1_${transaction.time}_${transaction.context}_${transaction.cash}`;
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
    logger.error('[TransactionStore/SQLite] Failed to fetch from API:', err.message);
    return [];
  }
}

/**
 * Sync transactions from API
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Sync result
 */
async function syncTransactions(userId) {
  const db = getDb(userId);
  const apiTransactions = await fetchFromAPI();

  if (apiTransactions.length === 0) {
    logger.warn('[TransactionStore/SQLite] No transactions received from API');
    const countRow = db.prepare('SELECT COUNT(*) as count FROM transactions').get();
    return { synced: 0, total: countRow.count };
  }

  const insertTx = db.prepare(`
    INSERT OR IGNORE INTO transactions (id, time, context, cash) VALUES (?, ?, ?, ?)
  `);

  let newCount = 0;
  const insertMany = db.transaction((txs) => {
    for (const tx of txs) {
      tx.id = generateTransactionId(tx);
      const result = insertTx.run(tx.id, tx.time, tx.context, tx.cash);
      if (result.changes > 0) {
        newCount++;
      }
    }
  });

  insertMany(apiTransactions);

  setMetadata(userId, 'transactions_last_sync', String(Date.now()));

  const countRow = db.prepare('SELECT COUNT(*) as count FROM transactions').get();
  logger.info(`[TransactionStore/SQLite] Synced ${newCount} new transactions, total: ${countRow.count}`);

  return { synced: newCount, total: countRow.count };
}

/**
 * Get all stored transactions
 * @param {string} userId - User ID
 * @returns {Promise<Array>} All transactions
 */
async function getTransactions(userId) {
  const db = getDb(userId);
  return db.prepare('SELECT id, time, context, cash FROM transactions ORDER BY time ASC').all();
}

/**
 * Get transactions within a time range
 * @param {string} userId - User ID
 * @param {number} days - Number of days to look back (0 = all)
 * @returns {Promise<Array>} Filtered transactions
 */
async function getTransactionsByDays(userId, days) {
  if (days === 0) {
    return getTransactions(userId);
  }

  const db = getDb(userId);
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  return db.prepare('SELECT id, time, context, cash FROM transactions WHERE time >= ? ORDER BY time ASC').all(cutoff);
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
 * @returns {Promise<Array>} Daily breakdown
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

  return Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get all available transaction types/contexts
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Unique contexts
 */
async function getTransactionTypes(userId) {
  const db = getDb(userId);
  const rows = db.prepare('SELECT DISTINCT context FROM transactions ORDER BY context').all();
  return rows.map(r => r.context);
}

/**
 * Get store metadata
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Store info
 */
async function getStoreInfo(userId) {
  const db = getDb(userId);

  const countRow = db.prepare('SELECT COUNT(*) as count FROM transactions').get();
  if (countRow.count === 0) {
    return {
      totalTransactions: 0,
      oldestTransaction: null,
      newestTransaction: null,
      lastSync: null,
      dataSpanDays: 0
    };
  }

  const oldest = db.prepare('SELECT MIN(time) as time FROM transactions').get();
  const newest = db.prepare('SELECT MAX(time) as time FROM transactions').get();
  const lastSync = getMetadata(userId, 'transactions_last_sync');

  const spanSeconds = newest.time - oldest.time;
  const spanDays = Math.ceil(spanSeconds / (24 * 60 * 60));

  return {
    totalTransactions: countRow.count,
    oldestTransaction: new Date(oldest.time * 1000).toISOString(),
    newestTransaction: new Date(newest.time * 1000).toISOString(),
    lastSync: lastSync ? new Date(parseInt(lastSync, 10)).toISOString() : null,
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
    logger.error('[TransactionStore/SQLite] Initial sync failed:', err.message);
  });

  // Set up recurring sync every 5 minutes
  syncInterval = setInterval(async () => {
    try {
      const result = await syncTransactions(userId);
      if (result.synced > 0) {
        logger.info(`[TransactionStore/SQLite] Auto-sync: ${result.synced} new transactions`);

        // Rebuild lookup after new transactions (using worker thread)
        const lookupStore = require('./lookup-store');
        const lookupResult = await lookupStore.buildLookupAsync(userId, 0, false);
        if (!lookupResult.alreadyBuilding) {
          logger.info(`[TransactionStore/SQLite] Lookup rebuilt: ${lookupResult.newEntries} new, POD2=${lookupResult.matchedPod2}`);
        }
      }
    } catch (err) {
      logger.error('[TransactionStore/SQLite] Auto-sync failed:', err.message);
    }
  }, SYNC_INTERVAL);

  logger.info('[TransactionStore/SQLite] Started auto-sync (every 5 minutes)');
}

/**
 * Stop automatic background sync
 */
function stopAutoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    logger.info('[TransactionStore/SQLite] Stopped auto-sync');
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
