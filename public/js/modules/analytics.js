/**
 * @fileoverview Analytics Dashboard Module
 *
 * Business intelligence dashboard showing:
 * - Weekly cash flow summary (revenue, expenses, profit)
 * - Detailed expense breakdown by category
 * - Vessel performance metrics
 * - Route profitability analysis
 * - Route contribution analysis
 * - Revenue trend chart (using TradingView Lightweight Charts)
 *
 * @module analytics
 */

import { getAnalyticsAll, syncTransactions, getTransactionData, getTransactionList } from './api.js';
import { escapeHtml, showNotification, formatNumber } from './utils.js';

// State
let analyticsData = null;
let transactionData = null;
let currentDays = 7;
let trendChart = null;

// Sort state for tables
const sortState = {
  vessels: { column: 'totalRevenue', direction: 'desc' },
  routes: { column: 'totalRevenue', direction: 'desc' }
};

// Raw transactions lazy loading state
const rawTransactionState = {
  transactions: [],
  offset: 0,
  limit: 50,
  total: 0,
  sortBy: 'time',
  sortDir: 'desc',
  loading: false,
  observer: null,
  hasMore: true
};

/**
 * Format currency with $ sign and K/M suffixes
 * @param {number} amount - Amount to format
 * @param {boolean} showSign - Show + sign for positive
 * @returns {string} Formatted amount
 */
function formatCurrency(amount, showSign = false) {
  const sign = showSign && amount > 0 ? '+' : '';
  const absAmount = Math.abs(amount);

  if (absAmount >= 1000000) {
    return `${sign}$${(amount / 1000000).toFixed(2)}M`;
  } else if (absAmount >= 1000) {
    return `${sign}$${(amount / 1000).toFixed(1)}K`;
  }
  return `${sign}$${formatNumber(Math.round(amount))}`;
}

/**
 * Format percentage
 * @param {number} value - Percentage value
 * @returns {string} Formatted percentage
 */
function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

/**
 * Initialize the analytics module
 */
export function initAnalytics() {
  const overlay = document.getElementById('analyticsOverlay');
  const closeBtn = document.getElementById('analyticsCloseBtn');
  const periodSelect = document.getElementById('analyticsPeriodSelect');
  const refreshBtn = document.getElementById('analyticsRefreshBtn');

  if (!overlay) {
    console.warn('[Analytics] Overlay not found');
    return;
  }

  // Expose function to open analytics
  window.showAnalytics = async () => {
    overlay.classList.remove('hidden');
    await loadAnalyticsData();
  };

  // Close button
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      overlay.classList.add('hidden');
      destroyChart();
    });
  }

  // Period selector
  if (periodSelect) {
    periodSelect.addEventListener('change', async (e) => {
      currentDays = parseInt(e.target.value, 10);
      // Invalidate cached transaction data so it reloads with new days
      transactionData = null;
      await loadAnalyticsData();
      // If Game Log tab is active, reload its data too
      const gameLogTab = document.getElementById('analytics-game-log');
      if (gameLogTab && !gameLogTab.classList.contains('hidden')) {
        loadGameLogData();
      }
    });
  }

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      // Invalidate cached transaction data to force reload
      transactionData = null;
      await loadAnalyticsData();
      // If Game Log tab is active, reload its data too
      const gameLogTab = document.getElementById('analytics-game-log');
      if (gameLogTab && !gameLogTab.classList.contains('hidden')) {
        loadGameLogData();
      }
    });
  }

  // Export button
  const exportBtn = document.getElementById('analyticsExportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportAnalyticsData();
    });
  }

  // Tab navigation
  const tabBtns = document.querySelectorAll('.analytics-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      switchTab(tabId);
    });
  });

  // Game Log sync button
  const syncBtn = document.getElementById('game-log-sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      await syncGameTransactions();
    });
  }

  // Game Log type filter
  const typeFilter = document.getElementById('game-log-type-filter');
  if (typeFilter) {
    typeFilter.addEventListener('change', () => {
      renderGameLogTable(transactionData);
      // Also reload raw transactions with new filter
      loadRawTransactions(true);
    });
  }

  // Initialize sortable table headers
  initSortableHeaders();

  // Vessel row click handler
  const vesselsTbody = document.getElementById('analytics-vessels-tbody');
  if (vesselsTbody) {
    vesselsTbody.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      if (row && row.dataset.vesselId) {
        handleVesselClick(row.dataset.vesselId);
      }
    });
  }

  // Route row click handler
  const routesTbody = document.getElementById('analytics-routes-tbody');
  if (routesTbody) {
    routesTbody.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      if (row && row.dataset.origin && row.dataset.destination) {
        handleRouteClick(row.dataset.origin, row.dataset.destination);
      }
    });
  }

  // Raw transactions - Lazy loading with IntersectionObserver
  setupRawTransactionsLazyLoading();

  // Raw transactions table header sorting
  const rawTable = document.getElementById('game-log-raw-table');
  if (rawTable) {
    rawTable.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const column = th.dataset.sort;
        handleRawTransactionSort(column);
      });
    });
  }

  console.log('[Analytics] Initialized');
}

/**
 * Handle vessel row click - open harbor map and show vessel panel
 * @param {string} vesselId - Vessel ID
 */
async function handleVesselClick(vesselId) {
  // Close analytics overlay
  const overlay = document.getElementById('analyticsOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    destroyChart();
  }

  // Open harbor map overlay
  const harborMapOverlay = document.getElementById('harborMapOverlay');
  if (harborMapOverlay) {
    harborMapOverlay.classList.remove('hidden');
  }

  // Try to select vessel in harbor map to show vessel panel
  if (window.harborMap && typeof window.harborMap.selectVesselFromPort === 'function') {
    try {
      window.harborMap.selectVesselFromPort(parseInt(vesselId, 10));
    } catch (error) {
      console.error('[Analytics] Failed to select vessel:', error);
      showNotification(`Vessel ID: ${vesselId} - View on map`, 'info');
    }
  } else {
    showNotification(`Vessel ID: ${vesselId} - View on map`, 'info');
  }
}

/**
 * Handle route row click - open harbor map with route filter
 * @param {string} origin - Origin port name
 * @param {string} destination - Destination port name
 */
async function handleRouteClick(origin, destination) {
  // Sort alphabetically and join with "<>" (harbor map format: sorted port codes)
  const sortedPorts = [origin, destination].sort();
  const pairKey = sortedPorts.join('<>');

  console.log('[Analytics] Route clicked:', origin, '->', destination, '-> pairKey:', pairKey);

  // Save to localStorage so map picks it up when loading
  localStorage.setItem('harborMapRouteFilter', pairKey);

  // Close analytics overlay
  const overlay = document.getElementById('analyticsOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    destroyChart();
  }

  // Open harbor map overlay
  const harborMapOverlay = document.getElementById('harborMapOverlay');
  if (harborMapOverlay) {
    harborMapOverlay.classList.remove('hidden');
  }

  // Apply route filter - wait for map to be ready if needed
  if (window.harborMap && typeof window.harborMap.setRouteFilter === 'function') {
    await window.harborMap.setRouteFilter(pairKey);
  }
}

/**
 * Initialize sortable table headers
 */
function initSortableHeaders() {
  // Vessel table headers
  const vesselTable = document.querySelector('#analytics-vessels .analytics-table thead');
  if (vesselTable) {
    const vesselHeaders = vesselTable.querySelectorAll('th');
    const vesselColumns = ['name', 'trips', 'totalRevenue', 'avgRevenuePerTrip', 'contribution', 'avgUtilization', 'primaryRoute'];
    vesselHeaders.forEach((th, index) => {
      if (index < vesselColumns.length) {
        th.dataset.column = vesselColumns[index];
        th.dataset.table = 'vessels';
        // Remove existing listener if any (prevent duplicates)
        th.onclick = null;
        th.onclick = () => handleSort('vessels', vesselColumns[index]);
      }
    });
  }

  // Route table headers
  const routeTable = document.querySelector('#analytics-routes .analytics-table thead');
  if (routeTable) {
    const routeHeaders = routeTable.querySelectorAll('th');
    const routeColumns = ['route', 'trips', 'totalRevenue', 'avgRevenuePerTrip', 'harborFeePercent', 'vesselCount'];
    routeHeaders.forEach((th, index) => {
      if (index < routeColumns.length) {
        th.dataset.column = routeColumns[index];
        th.dataset.table = 'routes';
        // Remove existing listener if any (prevent duplicates)
        th.onclick = null;
        th.onclick = () => handleSort('routes', routeColumns[index]);
      }
    });
  }

  // Update sort indicators for initial state
  updateSortIndicators('vessels');
  updateSortIndicators('routes');
}

/**
 * Handle sort click on table header
 * @param {string} table - Table name (vessels or routes)
 * @param {string} column - Column to sort by
 */
function handleSort(table, column) {
  console.log('[Analytics] Sort clicked:', table, column);

  // Toggle direction if same column, else default to desc
  if (sortState[table].column === column) {
    sortState[table].direction = sortState[table].direction === 'asc' ? 'desc' : 'asc';
  } else {
    sortState[table].column = column;
    sortState[table].direction = 'desc';
  }

  console.log('[Analytics] New sort state:', sortState[table]);

  // Update header indicators
  updateSortIndicators(table);

  // Re-render table
  if (table === 'vessels' && analyticsData?.vessels) {
    console.log('[Analytics] Re-rendering vessels table with', analyticsData.vessels.length, 'items');
    renderVesselTable(sortData(analyticsData.vessels, sortState.vessels));
  } else if (table === 'routes' && analyticsData?.routes) {
    console.log('[Analytics] Re-rendering routes table with', analyticsData.routes.length, 'items');
    renderRouteTable(sortData(analyticsData.routes, sortState.routes));
  }
}

/**
 * Sort data array by column and direction
 * @param {Array} data - Data to sort
 * @param {Object} sort - Sort state with column and direction
 * @returns {Array} Sorted data
 */
function sortData(data, sort) {
  const sorted = [...data];
  sorted.sort((a, b) => {
    let aVal = a[sort.column];
    let bVal = b[sort.column];

    // Handle string comparisons
    if (typeof aVal === 'string') {
      aVal = aVal.toLowerCase();
      bVal = (bVal || '').toLowerCase();
    }

    // Handle nullish values
    if (aVal == null) aVal = sort.direction === 'asc' ? Infinity : -Infinity;
    if (bVal == null) bVal = sort.direction === 'asc' ? Infinity : -Infinity;

    if (aVal < bVal) return sort.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return sort.direction === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

/**
 * Update sort indicators on table headers
 * @param {string} table - Table name
 */
function updateSortIndicators(table) {
  const containerId = table === 'vessels' ? '#analytics-vessels' : '#analytics-routes';
  const headers = document.querySelectorAll(`${containerId} .analytics-table thead th`);

  headers.forEach(th => {
    // Remove sort direction attribute from all headers
    delete th.dataset.sortDir;

    // Set sort direction on current sorted column
    if (th.dataset.column === sortState[table].column) {
      th.dataset.sortDir = sortState[table].direction;
    }
  });
}

/**
 * Switch between tabs
 * @param {string} tabId - Tab identifier
 */
function switchTab(tabId) {
  // Update tab buttons
  document.querySelectorAll('.analytics-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Update tab content
  document.querySelectorAll('.analytics-tab-content').forEach(content => {
    content.classList.toggle('hidden', content.id !== `analytics-${tabId}`);
  });

  // Initialize chart when trend tab becomes visible
  if (tabId === 'trend' && analyticsData) {
    setTimeout(() => renderTrendChart(analyticsData.trend), 100);
  }

  // Load game log data when tab becomes visible
  if (tabId === 'game-log' && !transactionData) {
    loadGameLogData();
  }
}

/**
 * Load analytics data from API
 */
async function loadAnalyticsData() {
  const loadingEl = document.getElementById('analyticsLoading');
  const contentEl = document.getElementById('analyticsContent');

  try {
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (contentEl) contentEl.classList.add('hidden');

    analyticsData = await getAnalyticsAll(currentDays);

    renderSummary(analyticsData.summary);
    renderExpenseTable(analyticsData.detailedExpenses);
    renderVesselTable(sortData(analyticsData.vessels, sortState.vessels));
    renderRouteTable(sortData(analyticsData.routes, sortState.routes));
    renderQuickSummary(analyticsData);

    // Re-initialize sortable headers after data is loaded
    initSortableHeaders();

    // Only render chart if trend tab is active
    const trendTab = document.getElementById('analytics-trend');
    if (trendTab && !trendTab.classList.contains('hidden')) {
      renderTrendChart(analyticsData.trend);
    }

    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

  } catch (error) {
    console.error('[Analytics] Failed to load data:', error);
    showNotification('Failed to load analytics data', 'error');
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

/**
 * Render summary cards
 * @param {Object} summary - Summary data (merged format)
 */
function renderSummary(summary) {
  if (!summary) return;

  // Revenue card - use income.total to match Game Log tab's "Total Income"
  const revenueEl = document.getElementById('analytics-revenue');
  if (revenueEl) {
    revenueEl.textContent = formatCurrency(summary.income?.total || 0);
  }

  // Expenses card
  const expensesEl = document.getElementById('analytics-expenses');
  if (expensesEl) {
    expensesEl.textContent = formatCurrency(summary.expenses?.total || 0);
  }

  // Profit card
  const profitEl = document.getElementById('analytics-profit');
  if (profitEl) {
    const profit = summary.profit?.net || 0;
    profitEl.textContent = formatCurrency(profit, true);
    profitEl.classList.toggle('positive', profit >= 0);
    profitEl.classList.toggle('negative', profit < 0);
  }

  // Margin card
  const marginEl = document.getElementById('analytics-margin');
  if (marginEl) {
    marginEl.textContent = formatPercent(summary.profit?.margin || 0);
  }

  // Trips card
  const tripsEl = document.getElementById('analytics-trips');
  if (tripsEl) {
    tripsEl.textContent = formatNumber(summary.operations?.trips || 0);
  }

  // Avg Fuel Price card - from local purchase logs
  const avgFuelEl = document.getElementById('analytics-avg-fuel');
  if (avgFuelEl) {
    const avgFuelPrice = summary.averages?.fuelPrice;
    if (avgFuelPrice && avgFuelPrice > 0) {
      avgFuelEl.textContent = `$${avgFuelPrice.toFixed(0)}/t`;
    } else {
      avgFuelEl.textContent = 'N/A';
    }
  }
}

/**
 * Render quick summary on overview tab
 * Shows operational data from local logs and expense totals from game API
 * Uses card grid layout (3 cards per row)
 * @param {Object} data - Full analytics data
 */
function renderQuickSummary(data) {
  const container = document.getElementById('analytics-quick-summary');
  if (!container) return;

  const summary = data.summary;
  const ops = summary?.operations;
  const expenses = summary?.expenses;
  const byContext = summary?.byContext;

  // Build cards array
  const cards = [];

  // Operations summary (from local logs)
  if (ops) {
    if (ops.fuelUsed > 0) {
      cards.push({ label: 'Fuel Used', value: `${formatNumber(Math.round(ops.fuelUsed))} t` });
    }
    if (ops.co2Used > 0) {
      cards.push({ label: 'CO2 Used', value: `${formatNumber(Math.round(ops.co2Used))} t` });
    }
    if (ops.trips > 0) {
      cards.push({ label: 'Trips', value: formatNumber(ops.trips) });
    }
    if (ops.distance > 0) {
      cards.push({ label: 'Distance', value: `${formatNumber(Math.round(ops.distance))} nm` });
    }
    if (ops.contribution > 0) {
      cards.push({ label: 'Contribution', value: formatNumber(ops.contribution) });
    }
  }

  // Expense totals from game API (actual costs)
  if (expenses) {
    if (expenses.fuel > 0) {
      cards.push({ label: 'Fuel Cost', value: formatCurrency(expenses.fuel) });
    }
    if (expenses.co2 > 0) {
      cards.push({ label: 'CO2 Cost', value: formatCurrency(expenses.co2) });
    }
    if (expenses.repairs > 0 || expenses.drydock > 0) {
      const repairTotal = (expenses.repairs || 0) + (expenses.drydock || 0);
      cards.push({ label: 'Maintenance', value: formatCurrency(repairTotal) });
    }
    if (expenses.harborFees > 0) {
      cards.push({ label: 'Harbor Fees', value: formatCurrency(expenses.harborFees) });
    }
    if (expenses.salary > 0) {
      cards.push({ label: 'Salaries', value: formatCurrency(expenses.salary) });
    }
    if (expenses.guards > 0) {
      cards.push({ label: 'Guards', value: formatCurrency(expenses.guards) });
    }
    if (expenses.routeFees > 0) {
      cards.push({ label: 'Route Fees', value: formatCurrency(expenses.routeFees) });
    }
    if (expenses.anchors > 0) {
      cards.push({ label: 'Anchors', value: formatCurrency(expenses.anchors) });
    }
    if (expenses.marketing > 0) {
      cards.push({ label: 'Marketing', value: formatCurrency(expenses.marketing) });
    }
  }

  // Transaction counts from byContext
  if (byContext) {
    const repairCount = (byContext.bulk_wear_maintenance?.count || 0) + (byContext.bulk_vessel_major_service?.count || 0);
    if (repairCount > 0) {
      cards.push({ label: 'Maintenance Events', value: `${formatNumber(repairCount)}` });
    }
  }

  // Render cards directly (container is inside parent grid)
  if (cards.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  cards.forEach(card => {
    html += `
      <div class="analytics-card">
        <div class="analytics-card-label">${card.label}</div>
        <div class="analytics-card-value">${card.value}</div>
      </div>`;
  });

  container.innerHTML = html;
}

/**
 * Render expense details table (merged from breakdown + details)
 * @param {Object} expenses - Detailed expense data (already merged in backend)
 */
function renderExpenseTable(expenses) {
  const tbody = document.getElementById('analytics-expenses-tbody');
  if (!tbody || !expenses) return;

  // Category display name mapping
  const categoryLabels = {
    fuel: 'Fuel',
    co2: 'CO2',
    harborFees: 'Harbor Fees',
    repairs: 'Repairs',
    drydock: 'Drydock',
    campaigns: 'Marketing',
    salary: 'Salaries',
    guards: 'Guards',
    routeFees: 'Route Fees',
    anchors: 'Anchors',
    hijacking: 'Hijacking Ransom',
    pirateRaid: 'Pirate Raid',
    vesselPurchases: 'Vessel Purchases',
    vesselBuilding: 'Vessel Building',
    stockPurchases: 'Stock Purchases',
    allianceContribution: 'Alliance Contribution'
  };

  // Build rows dynamically from expenses object
  const rows = [];
  const skipKeys = ['grandTotal', 'netVesselCost', 'vesselSales'];

  Object.keys(expenses).forEach(key => {
    if (skipKeys.includes(key)) return;

    const data = expenses[key];
    if (!data) return;

    // Handle hijacking special structure
    if (key === 'hijacking') {
      if (data.ransomPaid > 0) {
        rows.push({
          name: categoryLabels[key] || key,
          data: { total: data.ransomPaid, auto: 0, manual: data.ransomPaid, count: data.count || 0 }
        });
      }
      return;
    }

    // Handle harborFees special structure
    if (key === 'harborFees') {
      if (data.total > 0) {
        rows.push({
          name: categoryLabels[key] || key,
          data: { total: data.total, auto: data.total, manual: 0, count: data.count || 0 }
        });
      }
      return;
    }

    // Handle vesselPurchases special structure
    if (key === 'vesselPurchases') {
      if (data.total > 0) {
        rows.push({
          name: categoryLabels[key] || key,
          data: { total: data.total, auto: 0, manual: data.total, count: data.count || 0 }
        });
      }
      return;
    }

    // Standard category
    if (typeof data.total === 'number' && data.total > 0) {
      rows.push({
        name: categoryLabels[key] || key,
        data: data
      });
    }
  });

  // Sort rows by total descending
  rows.sort((a, b) => (b.data?.total || 0) - (a.data?.total || 0));

  // Use merged grand total from backend
  const grandTotal = expenses.grandTotal || 0;
  let totalAuto = 0;
  let totalManual = 0;
  let totalCount = 0;

  let html = '';
  rows.forEach(row => {
    if (row.data && row.data.total > 0) {
      totalAuto += row.data.auto || 0;
      totalManual += row.data.manual || 0;
      totalCount += row.data.count || 0;

      const percentage = grandTotal > 0 ? ((row.data.total / grandTotal) * 100).toFixed(1) : 0;

      html += `
        <tr>
          <td>${row.name}</td>
          <td class="num">${formatCurrency(row.data.total)}</td>
          <td class="num">${percentage}%</td>
          <td class="num">${row.data.auto > 0 ? formatCurrency(row.data.auto) : '-'}</td>
          <td class="num">${row.data.manual > 0 ? formatCurrency(row.data.manual) : '-'}</td>
          <td class="num">${row.data.count || '-'}</td>
        </tr>
      `;
    }
  });

  // Add total row with proper sums
  html += `
    <tr style="font-weight: bold; border-top: 2px solid var(--white-20);">
      <td>Total Expenses</td>
      <td class="num">${formatCurrency(grandTotal)}</td>
      <td class="num">100%</td>
      <td class="num">${totalAuto > 0 ? formatCurrency(totalAuto) : '-'}</td>
      <td class="num">${totalManual > 0 ? formatCurrency(totalManual) : '-'}</td>
      <td class="num">${totalCount || '-'}</td>
    </tr>
  `;

  // Add vessel sales if any
  if (expenses.vesselSales?.total > 0) {
    html += `
      <tr class="positive">
        <td>Vessel Sales (Income)</td>
        <td class="num positive">+${formatCurrency(expenses.vesselSales.total)}</td>
        <td class="num">-</td>
        <td class="num">-</td>
        <td class="num">+${formatCurrency(expenses.vesselSales.total)}</td>
        <td class="num">${expenses.vesselSales.count || 0}</td>
      </tr>
      <tr style="font-weight: bold;">
        <td>Net Vessel Cost</td>
        <td class="num ${expenses.netVesselCost > 0 ? 'negative' : 'positive'}">${formatCurrency(expenses.netVesselCost, true)}</td>
        <td class="num">-</td>
        <td class="num">-</td>
        <td class="num">-</td>
        <td class="num">-</td>
      </tr>
    `;
  }

  tbody.innerHTML = html || '<tr><td colspan="6" class="no-data">No expense data</td></tr>';
}

/**
 * Render vessel performance table
 * @param {Array} vessels - Vessel data
 */
function renderVesselTable(vessels) {
  const tbody = document.getElementById('analytics-vessels-tbody');
  if (!tbody) return;

  if (!vessels || vessels.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="no-data">No vessel data available</td></tr>';
    return;
  }

  let html = '';
  vessels.forEach(v => {
    html += `
      <tr data-vessel-id="${v.vesselId}">
        <td class="vessel-name">${escapeHtml(v.name)}</td>
        <td class="num">${v.trips}</td>
        <td class="num">${formatCurrency(v.totalRevenue)}</td>
        <td class="num">${formatCurrency(v.avgRevenuePerTrip)}</td>
        <td class="num">${formatNumber(v.contribution || v.totalContribution || 0)}</td>
        <td class="num">${formatPercent(v.avgUtilization)}</td>
        <td class="route">${escapeHtml(v.primaryRoute || '-')}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

/**
 * Render route profitability table
 * @param {Array} routes - Route data
 */
function renderRouteTable(routes) {
  const tbody = document.getElementById('analytics-routes-tbody');
  if (!tbody) return;

  if (!routes || routes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="no-data">No route data available</td></tr>';
    return;
  }

  let html = '';
  routes.forEach(r => {
    const feeClass = r.harborFeePercent > 20 ? 'warning' : '';
    html += `
      <tr data-origin="${escapeHtml(r.origin)}" data-destination="${escapeHtml(r.destination)}">
        <td class="route-name">${escapeHtml(r.displayRoute || r.origin + ' - ' + r.destination)}</td>
        <td class="num">${r.trips}</td>
        <td class="num">${formatCurrency(r.totalRevenue)}</td>
        <td class="num">${formatCurrency(r.avgRevenuePerTrip)}</td>
        <td class="num ${feeClass}">${formatPercent(r.harborFeePercent)}</td>
        <td class="num">${r.vesselCount}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}


/**
 * Render revenue trend chart using TradingView Lightweight Charts
 * @param {Array} trend - Daily trend data
 */
function renderTrendChart(trend) {
  const container = document.getElementById('analytics-chart-container');
  if (!container) return;

  // Destroy existing chart
  destroyChart();

  if (!trend || trend.length === 0) {
    container.innerHTML = '<div class="no-data">No trend data available</div>';
    return;
  }

  // Check if LightweightCharts is available
  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="no-data">Chart library not loaded</div>';
    return;
  }

  // Clear container but keep legend
  const legendHtml = `
    <div class="analytics-chart-legend">
      <span class="analytics-chart-legend-item">
        <span class="analytics-chart-legend-dot revenue"></span>
        Revenue
      </span>
      <span class="analytics-chart-legend-item">
        <span class="analytics-chart-legend-dot profit"></span>
        Profit
      </span>
    </div>
  `;
  container.innerHTML = legendHtml;

  // Create chart container
  const chartDiv = document.createElement('div');
  chartDiv.style.height = '280px';
  container.appendChild(chartDiv);

  // Create chart
  const chart = LightweightCharts.createChart(chartDiv, {
    width: container.clientWidth,
    height: 280,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af'
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.1)' },
      horzLines: { color: 'rgba(255,255,255,0.1)' }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.2)'
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.2)',
      timeVisible: false
    }
  });

  // Revenue line (v4+ vs v3 API compatibility)
  const areaOptions = {
    lineColor: '#10b981',
    topColor: 'rgba(16, 185, 129, 0.3)',
    bottomColor: 'rgba(16, 185, 129, 0.0)',
    lineWidth: 2
  };
  let revenueSeries;
  if (typeof chart.addAreaSeries === 'function') {
    revenueSeries = chart.addAreaSeries(areaOptions);
  } else {
    revenueSeries = chart.addSeries(LightweightCharts.AreaSeries, areaOptions);
  }

  // Profit line (v4+ vs v3 API compatibility)
  const lineOptions = {
    color: '#3b82f6',
    lineWidth: 2
  };
  let profitSeries;
  if (typeof chart.addLineSeries === 'function') {
    profitSeries = chart.addLineSeries(lineOptions);
  } else {
    profitSeries = chart.addSeries(LightweightCharts.LineSeries, lineOptions);
  }

  // Prepare data
  const revenueData = trend.map(d => ({
    time: d.date,
    value: d.revenue
  }));

  const profitData = trend.map(d => ({
    time: d.date,
    value: d.profit
  }));

  revenueSeries.setData(revenueData);
  profitSeries.setData(profitData);

  // Fit content
  chart.timeScale().fitContent();

  // Store chart reference for cleanup
  trendChart = { chart, container: chartDiv };

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    if (trendChart && trendChart.chart) {
      trendChart.chart.applyOptions({ width: container.clientWidth });
    }
  });
  resizeObserver.observe(container);
  trendChart.resizeObserver = resizeObserver;
}

/**
 * Destroy trend chart
 */
function destroyChart() {
  if (trendChart) {
    if (trendChart.resizeObserver) {
      trendChart.resizeObserver.disconnect();
    }
    if (trendChart.chart) {
      trendChart.chart.remove();
    }
    trendChart = null;
  }
}

// ============================================
// Game Transaction Log Functions
// ============================================

/**
 * Human-readable names for transaction contexts
 */
const CONTEXT_LABELS = {
  'vessels_departed': 'Vessel Revenue',
  'harbor_fee_on_depart': 'Harbor Fees',
  'fuel_purchased': 'Fuel Purchase',
  'co2_emission_quota': 'CO2 Quota',
  'bulk_wear_maintenance': 'Maintenance',
  'bulk_vessel_major_service': 'Major Service',
  'guard_payment_on_depart': 'Guard Payment',
  'marketing_campaign_activation': 'Marketing Campaign',
  'route_fee_on_creating': 'Route Fee',
  'anchor_points': 'Anchor Points',
  'buy_vessel': 'Vessel Purchase',
  'Sold_vessel_in_port': 'Vessel Sale',
  'salary_payment': 'Salaries',
  'hijacking': 'Hijacking',
  'purchase_stock': 'Stock Purchase',
  'sell_stock': 'Stock Sale',
  'Increase_shares': 'Share Increase'
};

/**
 * Get human-readable label for context
 * @param {string} context - Transaction context
 * @returns {string} Human-readable label
 */
function getContextLabel(context) {
  return CONTEXT_LABELS[context] || context.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Load game transaction data
 */
async function loadGameLogData() {
  try {
    transactionData = await getTransactionData(currentDays);
    renderGameLogInfo(transactionData.info);
    renderGameLogSummary(transactionData);
    renderGameLogTable(transactionData);
    populateTypeFilter(transactionData.types);

    // Also load raw transactions for lazy loading table
    loadRawTransactions(true);
    updateRawSortIndicators();
  } catch (error) {
    console.error('[Analytics] Failed to load game log data:', error);
    showNotification('Failed to load game transaction data', 'error');
  }
}

/**
 * Sync transactions from game API
 */
async function syncGameTransactions() {
  const syncBtn = document.getElementById('game-log-sync-btn');
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
  }

  try {
    const result = await syncTransactions();
    showNotification(`Synced ${result.synced} new transactions (${result.total} total)`, 'success');
    await loadGameLogData();
  } catch (error) {
    console.error('[Analytics] Failed to sync transactions:', error);
    showNotification('Failed to sync transactions from game', 'error');
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync from Game';
    }
  }
}

/**
 * Render game log info (metadata)
 * @param {Object} info - Store info
 */
function renderGameLogInfo(info) {
  const totalEl = document.getElementById('game-log-total');
  const spanEl = document.getElementById('game-log-span');
  const syncEl = document.getElementById('game-log-sync');

  if (totalEl) {
    totalEl.textContent = formatNumber(info.totalTransactions);
  }

  if (spanEl) {
    spanEl.textContent = info.dataSpanDays ? `${info.dataSpanDays} days` : 'No data';
  }

  if (syncEl) {
    if (info.lastSync) {
      const date = new Date(info.lastSync);
      syncEl.textContent = date.toLocaleString();
    } else {
      syncEl.textContent = 'Never';
    }
  }
}

/**
 * Render game log summary cards
 * @param {Object} data - Transaction data
 */
function renderGameLogSummary(data) {
  const container = document.getElementById('game-log-summary');
  if (!container) return;

  const { totals } = data;

  container.innerHTML = `
    <div class="analytics-card">
      <div class="analytics-card-label">Total Income</div>
      <div class="analytics-card-value positive">${formatCurrency(totals.income)}</div>
    </div>
    <div class="analytics-card">
      <div class="analytics-card-label">Total Expenses</div>
      <div class="analytics-card-value negative">${formatCurrency(totals.expenses)}</div>
    </div>
    <div class="analytics-card">
      <div class="analytics-card-label">Net Cash Flow</div>
      <div class="analytics-card-value ${totals.net >= 0 ? 'positive' : 'negative'}">${formatCurrency(totals.net, true)}</div>
    </div>
    <div class="analytics-card">
      <div class="analytics-card-label">Transaction Types</div>
      <div class="analytics-card-value">${data.types.length}</div>
    </div>
  `;
}

/**
 * Populate type filter dropdown
 * @param {Array} types - Available transaction types
 */
function populateTypeFilter(types) {
  const select = document.getElementById('game-log-type-filter');
  if (!select) return;

  // Keep first option (All Types)
  select.innerHTML = '<option value="">All Types</option>';

  // Add sorted types
  const sortedTypes = [...types].sort();
  for (const type of sortedTypes) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = getContextLabel(type);
    select.appendChild(option);
  }
}

/**
 * Render game log table
 * @param {Object} data - Transaction data
 */
function renderGameLogTable(data) {
  const tbody = document.getElementById('game-log-tbody');
  if (!tbody) return;

  const filterValue = document.getElementById('game-log-type-filter')?.value || '';
  const { summary } = data;

  // Convert summary object to array and sort by expense amount
  let entries = Object.values(summary);

  // Filter if type is selected
  if (filterValue) {
    entries = entries.filter(e => e.context === filterValue);
  }

  // Sort by total amount (expense + income)
  entries.sort((a, b) => (b.totalIncome + b.totalExpense) - (a.totalIncome + a.totalExpense));

  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="analytics-empty">No transactions found</td></tr>';
    return;
  }

  tbody.innerHTML = entries.map(entry => {
    const incomeClass = entry.totalIncome > 0 ? 'positive' : '';
    const expenseClass = entry.totalExpense > 0 ? 'negative' : '';
    const netClass = entry.netAmount >= 0 ? 'positive' : 'negative';

    return `
      <tr>
        <td>${escapeHtml(getContextLabel(entry.context))}</td>
        <td class="num">${formatNumber(entry.count)}</td>
        <td class="num ${incomeClass}">${entry.totalIncome > 0 ? formatCurrency(entry.totalIncome) : '-'}</td>
        <td class="num ${expenseClass}">${entry.totalExpense > 0 ? formatCurrency(entry.totalExpense) : '-'}</td>
        <td class="num ${netClass}">${formatCurrency(entry.netAmount, true)}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Export analytics data as JSON file
 */
function exportAnalyticsData() {
  if (!analyticsData) {
    showNotification('No analytics data to export', 'warning');
    return;
  }

  // Prepare export data
  const exportData = {
    exportDate: new Date().toISOString(),
    period: `${currentDays} days`,
    summary: analyticsData.summary,
    vessels: analyticsData.vessels,
    routes: analyticsData.routes,
    detailedExpenses: analyticsData.detailedExpenses,
    trend: analyticsData.trend
  };

  // Add transaction data if available
  if (transactionData) {
    exportData.gameTransactions = {
      info: transactionData.info,
      totals: transactionData.totals,
      types: transactionData.types
    };
  }

  // Create and download file
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().split('T')[0];
  a.href = url;
  a.download = `analytics-export-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showNotification('Analytics data exported', 'success');
}

// ============================================
// Raw Transaction Lazy Loading Functions
// ============================================

/**
 * Load raw transactions with pagination (initial load or reset)
 * @param {boolean} reset - If true, reset offset and clear existing data
 */
async function loadRawTransactions(reset = true) {
  if (rawTransactionState.loading) return;

  rawTransactionState.loading = true;

  if (reset) {
    rawTransactionState.offset = 0;
    rawTransactionState.transactions = [];
  }

  const filterValue = document.getElementById('game-log-type-filter')?.value || '';

  try {
    const result = await getTransactionList({
      days: currentDays,
      context: filterValue || undefined,
      limit: rawTransactionState.limit,
      offset: rawTransactionState.offset,
      sortBy: rawTransactionState.sortBy,
      sortDir: rawTransactionState.sortDir
    });

    // Handle missing or malformed response
    const transactions = result?.transactions || [];
    const pagination = result?.pagination || { total: 0, hasMore: false };

    if (reset) {
      rawTransactionState.transactions = transactions;
    } else {
      rawTransactionState.transactions = [...rawTransactionState.transactions, ...transactions];
    }

    rawTransactionState.total = pagination.total;
    rawTransactionState.offset += transactions.length;

    renderRawTransactionsTable();
    updateRawTransactionCounts();
    updateLoadMoreButton(pagination.hasMore);

  } catch (error) {
    console.error('[Analytics] Failed to load raw transactions:', error);
    showNotification('Failed to load transactions', 'error');
  } finally {
    rawTransactionState.loading = false;
  }
}

/**
 * Load more raw transactions (append to existing)
 */
async function loadMoreRawTransactions() {
  await loadRawTransactions(false);
}

/**
 * Handle sort click on raw transactions table header
 * @param {string} column - Column to sort by
 */
function handleRawTransactionSort(column) {
  // Toggle direction if same column
  if (rawTransactionState.sortBy === column) {
    rawTransactionState.sortDir = rawTransactionState.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    rawTransactionState.sortBy = column;
    rawTransactionState.sortDir = 'desc';
  }

  // Update sort indicator classes
  updateRawSortIndicators();

  // Reload from beginning with new sort
  loadRawTransactions(true);
}

/**
 * Update sort indicator CSS classes on raw table headers
 */
function updateRawSortIndicators() {
  const table = document.getElementById('game-log-raw-table');
  if (!table) return;

  table.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.remove('sort-active', 'sort-asc', 'sort-desc');

    if (th.dataset.sort === rawTransactionState.sortBy) {
      th.classList.add('sort-active');
      th.classList.add(rawTransactionState.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

/**
 * Render the raw transactions table body
 */
function renderRawTransactionsTable() {
  const tbody = document.getElementById('game-log-raw-tbody');
  if (!tbody) return;

  if (rawTransactionState.transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="analytics-empty">No transactions found</td></tr>';
    return;
  }

  tbody.innerHTML = rawTransactionState.transactions.map(t => {
    const date = new Date(t.time * 1000);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const amountClass = t.cash >= 0 ? 'positive' : 'negative';
    const amountStr = t.cash >= 0 ? '+' + formatCurrency(t.cash) : formatCurrency(t.cash);

    return `
      <tr>
        <td>${escapeHtml(dateStr)}</td>
        <td>${escapeHtml(getContextLabel(t.context))}</td>
        <td class="num ${amountClass}">${amountStr}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Update the count displays for raw transactions
 */
function updateRawTransactionCounts() {
  const countEl = document.getElementById('game-log-raw-count');
  const totalEl = document.getElementById('game-log-raw-total');

  if (countEl) {
    countEl.textContent = formatNumber(rawTransactionState.transactions.length);
  }
  if (totalEl) {
    totalEl.textContent = formatNumber(rawTransactionState.total);
  }
}

/**
 * Update hasMore state for lazy loading
 * @param {boolean} hasMore - Whether there are more transactions to load
 */
function updateLoadMoreButton(hasMore) {
  rawTransactionState.hasMore = hasMore;
  // Hide the load more button as we use IntersectionObserver now
  const btn = document.getElementById('game-log-load-more-btn');
  if (btn) {
    btn.style.display = 'none';
  }
}

/**
 * Setup IntersectionObserver for lazy loading raw transactions
 */
function setupRawTransactionsLazyLoading() {
  // Clean up existing observer
  if (rawTransactionState.observer) {
    rawTransactionState.observer.disconnect();
  }

  const analyticsContent = document.querySelector('.analytics-content');
  if (!analyticsContent) return;

  rawTransactionState.observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && rawTransactionState.hasMore && !rawTransactionState.loading) {
        loadMoreRawTransactions();
      }
    });
  }, {
    root: analyticsContent,
    rootMargin: '200px',
    threshold: 0
  });

  // Observe the load more button area as the sentinel
  const loadMoreArea = document.querySelector('.game-log-load-more');
  if (loadMoreArea) {
    rawTransactionState.observer.observe(loadMoreArea);
  }
}

// Export for global access
export { loadAnalyticsData };
