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

import { getAnalyticsOverview, getAnalyticsVessels, getAnalyticsRoutes, getLookupEntries, getLookupTotals, getLookupBreakdown, getLookupDaily, getLookupInfo, getLookupDetails, checkDevelMode, getApiStats, getApiStatsDates } from './api.js';
import { escapeHtml, showNotification, formatNumber, toGameCode } from './utils.js';

// State
let analyticsData = null;
let lookupData = null; // Used for export
let currentDays = 7;
let trendChart = null;
let isDevelMode = false;
let apiStatsChart = null;

// Cache TTL in milliseconds (1 minute)
const CACHE_TTL = 60000;

// Lazy loading state for tabs with timestamps
const lazyLoadState = {
  vessels: { loaded: false, loading: false, loadedAt: 0 },
  routes: { loaded: false, loading: false, loadedAt: 0 },
  overview: { loaded: false, loading: false, loadedAt: 0 }
};

// Sort state for tables
const sortState = {
  vessels: { column: 'totalRevenue', direction: 'desc' },
  routes: { column: 'avgRevenuePerHour', direction: 'desc' }
};

// Route filter state (which route types to show)
const routeFilterState = {
  showActive: true,
  showInactive: true
};

// Vessel filter state (owned vs sold)
const vesselFilterState = {
  showOwned: true,
  showSold: true
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
 * Check if cache is still valid (within TTL)
 * @param {number} loadedAt - Timestamp when data was loaded
 * @returns {boolean} True if cache is still valid
 */
function isCacheValid(loadedAt) {
  return loadedAt > 0 && (Date.now() - loadedAt) < CACHE_TTL;
}

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
 * Check if lookup store needs building and handle the build process
 * Shows full-modal overlay during build, polls for completion
 * @returns {Promise<boolean>} True if build was needed and started
 */
async function checkAndBuildIndex() {
  const buildingOverlay = document.getElementById('analyticsIndexBuilding');
  const statusEl = document.getElementById('analyticsIndexStatus');
  const tabsEl = document.querySelector('.analytics-tabs');
  const loadingEl = document.getElementById('analyticsLoading');
  const contentEl = document.getElementById('analyticsContent');

  try {
    // Check if lookup store has data and is up-to-date
    const info = await getLookupInfo();

    // If we have data and version is current, no build needed
    if (info.lastSync && info.totalEntries > 0 && !info.needsRebuild) {
      return false;
    }

    // Need to build - show full overlay, hide everything else
    if (buildingOverlay) buildingOverlay.classList.remove('hidden');
    if (tabsEl) tabsEl.style.display = 'none';
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.add('hidden');

    // Show appropriate message
    if (info.needsRebuild) {
      if (statusEl) statusEl.textContent = 'Upgrading index to new version...';
    } else {
      if (statusEl) statusEl.textContent = 'Starting index build...';
    }

    // Trigger rebuild
    const rebuildResponse = await fetch(window.apiUrl('/api/analytics/lookup/rebuild'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 0 })
    });

    if (!rebuildResponse.ok) {
      const errorData = await rebuildResponse.json().catch(() => ({}));
      throw new Error(errorData.error || 'Rebuild failed');
    }

    const result = await rebuildResponse.json();

    if (statusEl) {
      statusEl.textContent = `Index built: ${result.lookup?.newEntries || 0} entries`;
    }

    // Small delay to show success message
    await new Promise(resolve => setTimeout(resolve, 500));

    // Hide overlay, show normal UI
    if (buildingOverlay) buildingOverlay.classList.add('hidden');
    if (tabsEl) tabsEl.style.display = '';

    // Now load the analytics data
    await loadAnalyticsData();

    return true;
  } catch (error) {
    console.error('[Analytics] Failed to check/build index:', error);

    // Hide overlay and show error
    if (buildingOverlay) buildingOverlay.classList.add('hidden');
    if (tabsEl) tabsEl.style.display = '';

    showNotification('Failed to build transaction index: ' + error.message, 'error');
    return false;
  }
}

/**
 * Update the filter name display based on selected period
 * @param {HTMLSelectElement} selectEl - The period select element
 */
function updateFilterName(selectEl) {
  const filterNameEl = document.getElementById('analytics-filter-name');
  if (filterNameEl && selectEl) {
    const selectedOption = selectEl.options[selectEl.selectedIndex];
    filterNameEl.textContent = selectedOption ? selectedOption.text : 'All Time';
  }
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

    // Check if we need to build the index first
    const needsBuild = await checkAndBuildIndex();
    if (!needsBuild) {
      // Index exists, load normally
      await loadAnalyticsData();
    }
    // If needsBuild was true, loadAnalyticsData is called after build completes
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
      updateFilterName(periodSelect);
      // Invalidate all cached data so it reloads with new days
      lookupData = null;
      lazyLoadState.overview.loadedAt = 0;
      lazyLoadState.vessels.loadedAt = 0;
      lazyLoadState.routes.loadedAt = 0;
      // Clear cached analyticsData for vessels and routes
      if (analyticsData) {
        analyticsData.vessels = null;
        analyticsData.routes = null;
      }
      await loadAnalyticsData();
      // Reload active tab data
      const gameLogTab = document.getElementById('analytics-game-log');
      const vesselsTab = document.getElementById('analytics-vessels');
      const routesTab = document.getElementById('analytics-routes');
      if (gameLogTab && !gameLogTab.classList.contains('hidden')) {
        await loadGameLogData();
      }
      if (vesselsTab && !vesselsTab.classList.contains('hidden')) {
        await lazyLoadVessels();
      }
      if (routesTab && !routesTab.classList.contains('hidden')) {
        await lazyLoadRoutes();
      }
    });
    // Set initial filter name
    updateFilterName(periodSelect);
  }

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      // Invalidate all cached data to force reload
      lookupData = null;
      lazyLoadState.overview.loadedAt = 0;
      lazyLoadState.vessels.loadedAt = 0;
      lazyLoadState.routes.loadedAt = 0;
      // Clear cached analyticsData for vessels and routes
      if (analyticsData) {
        analyticsData.vessels = null;
        analyticsData.routes = null;
      }
      await loadAnalyticsData();
      // Reload active tab data
      const gameLogTab = document.getElementById('analytics-game-log');
      const vesselsTab = document.getElementById('analytics-vessels');
      const routesTab = document.getElementById('analytics-routes');
      if (gameLogTab && !gameLogTab.classList.contains('hidden')) {
        await loadGameLogData();
      }
      if (vesselsTab && !vesselsTab.classList.contains('hidden')) {
        await lazyLoadVessels();
      }
      if (routesTab && !routesTab.classList.contains('hidden')) {
        await lazyLoadRoutes();
      }
    });
  }

  // Export dropdown
  const exportBtn = document.getElementById('analyticsExportBtn');
  const exportMenu = document.getElementById('analyticsExportMenu');
  const exportTxt = document.getElementById('analyticsExportTxt');
  const exportCsv = document.getElementById('analyticsExportCsv');
  const exportJson = document.getElementById('analyticsExportJson');

  if (exportBtn && exportMenu) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('hidden');
    });

    // Close menu when clicking outside
    document.addEventListener('click', () => {
      exportMenu.classList.add('hidden');
    });

    exportMenu.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  if (exportTxt) {
    exportTxt.addEventListener('click', () => {
      exportAnalyticsData('txt');
      exportMenu.classList.add('hidden');
    });
  }
  if (exportCsv) {
    exportCsv.addEventListener('click', () => {
      exportAnalyticsData('csv');
      exportMenu.classList.add('hidden');
    });
  }
  if (exportJson) {
    exportJson.addEventListener('click', () => {
      exportAnalyticsData('json');
      exportMenu.classList.add('hidden');
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

  // Check develMode and add API Stats tab if enabled
  checkDevelMode().then(enabled => {
    isDevelMode = enabled;
    if (enabled) {
      addApiStatsTab();
    }
  });

  // Game Log category filter (INCOME/EXPENSE)
  const categoryFilter = document.getElementById('game-log-category-filter');
  if (categoryFilter) {
    categoryFilter.addEventListener('change', () => {
      if (lookupData?.breakdown) {
        renderGameLogTable(lookupData.breakdown);
      }
      loadRawTransactions(true);
    });
  }

  // Game Log type filter (Departure, Repair, Fuel, etc.)
  const typeFilter = document.getElementById('game-log-type-filter');
  if (typeFilter) {
    typeFilter.addEventListener('change', () => {
      if (lookupData?.breakdown) {
        renderGameLogTable(lookupData.breakdown);
      }
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

  // Route vessels info icon - shows explanation tooltip
  const routeVesselsInfo = document.getElementById('route-vessels-info');
  if (routeVesselsInfo) {
    routeVesselsInfo.addEventListener('click', (e) => {
      e.stopPropagation();
      showRouteVesselsInfoTooltip(routeVesselsInfo);
    });
  }

  // Route filter icons - toggle active/inactive route visibility
  const routeFilterActive = document.getElementById('route-filter-active');
  const routeFilterInactive = document.getElementById('route-filter-inactive');

  if (routeFilterActive) {
    routeFilterActive.addEventListener('click', (e) => {
      e.stopPropagation();
      routeFilterState.showActive = !routeFilterState.showActive;
      updateRouteFilterIcons();
      if (analyticsData?.routes) {
        renderRouteTable(sortData(analyticsData.routes, sortState.routes));
      }
    });
  }

  if (routeFilterInactive) {
    routeFilterInactive.addEventListener('click', (e) => {
      e.stopPropagation();
      routeFilterState.showInactive = !routeFilterState.showInactive;
      updateRouteFilterIcons();
      if (analyticsData?.routes) {
        renderRouteTable(sortData(analyticsData.routes, sortState.routes));
      }
    });
  }

  // Initialize filter icon states
  updateRouteFilterIcons();

  // Vessel filter icons - toggle owned/sold vessel visibility
  const vesselFilterOwned = document.getElementById('vessel-filter-owned');
  const vesselFilterSold = document.getElementById('vessel-filter-sold');

  if (vesselFilterOwned) {
    vesselFilterOwned.addEventListener('click', (e) => {
      e.stopPropagation();
      vesselFilterState.showOwned = !vesselFilterState.showOwned;
      updateVesselFilterIcons();
      if (analyticsData?.vessels) {
        renderVesselTable(sortData(analyticsData.vessels, sortState.vessels));
      }
    });
  }

  if (vesselFilterSold) {
    vesselFilterSold.addEventListener('click', (e) => {
      e.stopPropagation();
      vesselFilterState.showSold = !vesselFilterState.showSold;
      updateVesselFilterIcons();
      if (analyticsData?.vessels) {
        renderVesselTable(sortData(analyticsData.vessels, sortState.vessels));
      }
    });
  }

  // Initialize vessel filter icon states
  updateVesselFilterIcons();

  // Raw transaction row click handler
  const rawTbody = document.getElementById('game-log-raw-tbody');
  if (rawTbody) {
    rawTbody.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      if (row && row.dataset.lookupId) {
        showLookupEntryDetails(row.dataset.lookupId);
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
}

/**
 * Handle vessel row click - open harbor map and show vessel panel
 * @param {string} vesselId - Vessel ID
 */
async function handleVesselClick(vesselId) {
  // Mark that we came from analytics so closing vessel panel returns here
  localStorage.setItem('returnToAnalytics', 'true');
  console.log('[Analytics] handleVesselClick - set returnToAnalytics=true for vesselId:', vesselId);

  // Check if vessel is sold (look up in analyticsData.vessels)
  let vesselData = null;
  if (analyticsData && analyticsData.vessels) {
    vesselData = analyticsData.vessels.find(v => v.vesselId === parseInt(vesselId, 10));
  }

  const isSoldVessel = vesselData && vesselData.isOwned === false;

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

  // For sold vessels, show special sold vessel panel with history only
  if (isSoldVessel) {
    console.log('[Analytics] Opening sold vessel panel for:', vesselId);
    try {
      await showSoldVesselPanel(parseInt(vesselId, 10), vesselData.name);
    } catch (error) {
      console.error('[Analytics] Failed to show sold vessel panel:', error);
      showNotification('Failed to load vessel history', 'error');
    }
    return;
  }

  // For owned vessels, try to select on harbor map
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
 * Show sold vessel panel with history only
 * Creates a simplified vessel panel for vessels that have been sold
 * @param {number} vesselId - Vessel ID
 * @param {string} vesselName - Vessel name
 */
async function showSoldVesselPanel(vesselId, vesselName) {
  const panel = document.getElementById('vessel-detail-panel');
  if (!panel) return;

  // Fetch vessel history from API
  let historyData = [];
  try {
    const response = await fetch(window.apiUrl(`/api/harbor-map/vessel/${vesselId}/history`));
    if (!response.ok) {
      throw new Error(`Failed to fetch vessel history: ${response.statusText}`);
    }
    const data = await response.json();
    historyData = data.history || [];
  } catch (error) {
    console.error('[Analytics] Error fetching sold vessel history:', error);
    historyData = [];
  }

  // Render simplified panel for sold vessels
  panel.innerHTML = `
    <div class="panel-header">
      <h3>
        <span class="vessel-name-display">${escapeHtml(vesselName)}</span>
        <span class="vessel-status sold" title="Sold" style="margin-left: 8px;">&#x1F578;&#xFE0F; Sold</span>
      </h3>
      <button class="close-btn" onclick="window.analytics.closeSoldVesselPanel()">×</button>
    </div>

    <div class="panel-body">
      <div class="vessel-info-section">
        <p style="color: var(--color-text-secondary); font-style: italic; margin-bottom: 16px;">
          This vessel has been sold. Only trip history is available.
        </p>
      </div>

      <div class="vessel-info-section vessel-history-section collapsible">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Trip History
        </h4>
        <div class="section-content">
          <div id="vessel-history-loading">${historyData.length === 0 ? 'No trip history available' : ''}</div>
          <div id="vessel-history-content"></div>
        </div>
      </div>
    </div>
  `;

  // Show panel
  panel.classList.add('active');

  // Render history if available
  if (historyData.length > 0) {
    renderSoldVesselHistory(historyData);
  }
}

/**
 * Render trip history for sold vessels
 * Simplified version without live vessel status updates
 * @param {Array} historyData - Array of trip history entries
 */
function renderSoldVesselHistory(historyData) {
  const contentEl = document.getElementById('vessel-history-content');
  if (!contentEl) return;

  // Reverse to show newest first
  const trips = historyData.reverse();

  // Format port name helper - uses game display codes (e.g., "US NYC")
  const formatPortName = (portCode) => {
    if (!portCode) return 'N/A';
    return escapeHtml(toGameCode(portCode));
  };

  // Format cargo helper
  const formatCargo = (cargo) => {
    if (!cargo) return 'N/A';
    if (typeof cargo === 'string') return escapeHtml(cargo);

    if (cargo.dry !== undefined || cargo.refrigerated !== undefined) {
      const dry = cargo.dry || 0;
      const ref = cargo.refrigerated || 0;
      return `${(dry + ref).toLocaleString()} TEU`;
    }

    if (cargo.fuel !== undefined || cargo.crude_oil !== undefined) {
      const fuel = cargo.fuel || 0;
      const crude = cargo.crude_oil || 0;
      return `${(fuel + crude).toLocaleString()} bbl`;
    }

    return escapeHtml(JSON.stringify(cargo));
  };

  // Format duration
  const formatDuration = (seconds) => {
    if (!seconds) return 'N/A';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  // Render trips
  const historyHtml = trips.map(trip => {
    const isDrydockOperation = trip.is_drydock_operation === true;
    const isServiceTrip = !isDrydockOperation && !trip.profit && trip.cargo &&
      (trip.cargo.dry === 0 && trip.cargo.refrigerated === 0 &&
       trip.cargo.fuel === 0 && trip.cargo.crude_oil === 0);

    return `
    <div class="history-entry">
      <div class="history-route">
        <strong>${formatPortName(trip.origin)}</strong> &rarr; <strong>${formatPortName(trip.destination)}</strong>
      </div>
      <div class="history-details">
        <div class="history-row">
          <span>Date: ${trip.date ? new Date(trip.date + ' UTC').toLocaleString() : 'N/A'}</span>
        </div>
        ${isDrydockOperation ? `
        <div class="history-row drydock-trip">
          <span>Drydock Operation</span>
        </div>` : `
        <div class="history-row">
          <span>Cargo: ${formatCargo(trip.cargo)}</span>
        </div>
        <div class="history-row">
          <span>Income: ${isServiceTrip ? 'Service Trip' : '$' + (trip.profit !== null && trip.profit !== undefined ? trip.profit.toLocaleString() : '?')}</span>
        </div>
        ${trip.harbor_fee !== null && trip.harbor_fee !== undefined ? `
        <div class="history-row">
          <span>Harbor Fee: $${trip.harbor_fee.toLocaleString()}</span>
        </div>
        ` : ''}`}
        <div class="history-row">
          <span>Distance: ${trip.distance ? trip.distance.toLocaleString(undefined, {maximumFractionDigits: 0}) + ' nm' : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span>Duration: ${formatDuration(trip.duration)}</span>
        </div>
      </div>
    </div>
    `;
  }).join('');

  contentEl.innerHTML = historyHtml;
}

/**
 * Close sold vessel panel and return to analytics
 */
function closeSoldVesselPanel() {
  const panel = document.getElementById('vessel-detail-panel');
  if (panel) {
    panel.classList.remove('active');
  }

  // Return to analytics overlay
  localStorage.removeItem('returnToAnalytics');
  const harborMapOverlay = document.getElementById('harborMapOverlay');
  if (harborMapOverlay) {
    harborMapOverlay.classList.add('hidden');
  }

  const analyticsOverlay = document.getElementById('analyticsOverlay');
  if (analyticsOverlay) {
    analyticsOverlay.classList.remove('hidden');
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

  // Save to localStorage so map picks it up when loading
  localStorage.setItem('harborMapRouteFilter', pairKey);

  // Mark that we came from analytics so closing route panel returns here
  localStorage.setItem('returnToAnalytics', 'true');

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
    const vesselColumns = ['name', 'trips', 'totalRevenue', 'avgRevenuePerTrip', 'contribution', 'avgRevenuePerHour', 'avgRevenuePerNm', 'avgUtilization', 'primaryRoute'];
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
  // Order: Route, Vessels, Trips, Revenue, Avg/Trip, Avg/h, $/nm, Hijack %, Harbor Fee %
  const routeTable = document.querySelector('#analytics-routes .analytics-table thead');
  if (routeTable) {
    const routeHeaders = routeTable.querySelectorAll('th');
    const routeColumns = ['route', 'vesselCount', 'trips', 'totalRevenue', 'avgRevenuePerTrip', 'avgRevenuePerHour', 'avgIncomePerNm', 'hijackingRisk', 'harborFeePercent'];
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
  // Toggle direction if same column, else default to desc
  if (sortState[table].column === column) {
    sortState[table].direction = sortState[table].direction === 'asc' ? 'desc' : 'asc';
  } else {
    sortState[table].column = column;
    sortState[table].direction = 'desc';
  }

  // Update header indicators
  updateSortIndicators(table);

  // Re-render table
  if (table === 'vessels' && analyticsData?.vessels) {
    renderVesselTable(sortData(analyticsData.vessels, sortState.vessels));
  } else if (table === 'routes' && analyticsData?.routes) {
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

  // Initialize chart when overview tab becomes visible
  if (tabId === 'overview' && analyticsData && analyticsData.summary) {
    setTimeout(() => renderTrendChart(analyticsData.summary.dailyBreakdown), 100);
  }

  // Lazy load vessels data when vessels tab is clicked
  if (tabId === 'vessels') {
    lazyLoadVessels();
  }

  // Lazy load routes data when routes tab is clicked
  if (tabId === 'routes') {
    lazyLoadRoutes();
  }

  // Load game log data when tab becomes visible
  if (tabId === 'game-log' && !lookupData) {
    loadGameLogData();
  }

  // Load API stats when tab becomes visible (develMode only)
  if (tabId === 'api-stats' && isDevelMode) {
    loadApiStats();
  }
}

/**
 * Load analytics data from API - uses lazy loading for vessels/routes tabs
 */
async function loadAnalyticsData() {
  const loadingEl = document.getElementById('analyticsLoading');
  const contentEl = document.getElementById('analyticsContent');

  // Check if overview cache is still valid
  if (isCacheValid(lazyLoadState.overview.loadedAt) && analyticsData) {
    console.log('[Analytics] Using cached overview data');
    // Just re-render from cache
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');
    renderSummary(analyticsData.summary);
    renderExpenseTable(analyticsData.detailedExpenses);
    renderQuickSummary(analyticsData);
    initSortableHeaders();
    const overviewTab = document.getElementById('analytics-overview');
    if (overviewTab && !overviewTab.classList.contains('hidden') && analyticsData.summary) {
      setTimeout(() => renderTrendChart(analyticsData.summary.dailyBreakdown), 50);
    }
    return;
  }

  try {
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (contentEl) contentEl.classList.add('hidden');

    // Reset lazy load state for vessels/routes (they need to reload with new data)
    lazyLoadState.vessels.loaded = false;
    lazyLoadState.vessels.loading = false;
    lazyLoadState.vessels.loadedAt = 0;
    lazyLoadState.routes.loaded = false;
    lazyLoadState.routes.loading = false;
    lazyLoadState.routes.loadedAt = 0;

    // Load only overview data first (fast)
    const overviewData = await getAnalyticsOverview(currentDays);

    // Initialize analyticsData with overview data
    analyticsData = {
      summary: overviewData.summary,
      detailedExpenses: overviewData.detailedExpenses,
      vessels: null,
      routes: null,
      days: overviewData.days
    };

    // Mark overview as loaded with timestamp
    lazyLoadState.overview.loaded = true;
    lazyLoadState.overview.loadedAt = Date.now();

    // Render overview immediately
    renderSummary(analyticsData.summary);
    renderExpenseTable(analyticsData.detailedExpenses);
    renderQuickSummary(analyticsData);

    // Re-initialize sortable headers after data is loaded
    initSortableHeaders();

    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

    // Render chart AFTER content is visible so container has width
    const overviewTab = document.getElementById('analytics-overview');
    if (overviewTab && !overviewTab.classList.contains('hidden') && analyticsData.summary) {
      setTimeout(() => renderTrendChart(analyticsData.summary.dailyBreakdown), 50);
    }

    // Re-render vessel revenue charts with new time-filtered entries
    // (preloadAllTabs won't re-render if vessels are already cached)
    if (analyticsData.vessels) {
      renderVesselsRevenueChart(analyticsData.vessels, analyticsData.summary?.vesselRevenueEntries);
      renderBottomVesselsRevenueChart(analyticsData.vessels, analyticsData.summary?.vesselRevenueEntries);
    }

    // Preload all tabs in background (parallel)
    preloadAllTabs();

  } catch (error) {
    console.error('[Analytics] Failed to load data:', error);
    showNotification('Failed to load analytics data', 'error');
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

/**
 * Lazy load vessels data when tab is opened
 */
async function lazyLoadVessels() {
  const loadingEl = document.getElementById('analytics-vessels-loading');
  const contentEl = document.getElementById('analytics-vessels-content');

  // If already loading, skip
  if (lazyLoadState.vessels.loading) return;

  // If cache is still valid, just render from cache
  if (isCacheValid(lazyLoadState.vessels.loadedAt) && analyticsData.vessels) {
    console.log('[Analytics] Using cached vessels data');
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');
    renderVesselTable(sortData(analyticsData.vessels, sortState.vessels));
    setTimeout(() => renderVesselCharts(analyticsData.vessels, analyticsData.summary?.utilizationEntries), 100);
    return;
  }

  // Show loading, hide content
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (contentEl) contentEl.classList.add('hidden');

  lazyLoadState.vessels.loading = true;
  try {
    const data = await getAnalyticsVessels(currentDays);
    analyticsData.vessels = data.vessels;
    lazyLoadState.vessels.loaded = true;
    lazyLoadState.vessels.loadedAt = Date.now();

    // Hide loading, show content
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

    renderVesselTable(sortData(analyticsData.vessels, sortState.vessels));

    // Render vessel charts
    setTimeout(() => renderVesselCharts(analyticsData.vessels, analyticsData.summary?.utilizationEntries), 100);
  } catch (error) {
    console.error('[Analytics] Failed to load vessels:', error);
    // Show error in loading div
    if (loadingEl) loadingEl.textContent = 'Failed to load vessel data';
  } finally {
    lazyLoadState.vessels.loading = false;
  }
}

/**
 * Lazy load routes data when tab is opened
 */
async function lazyLoadRoutes() {
  const loadingEl = document.getElementById('analytics-routes-loading');
  const contentEl = document.getElementById('analytics-routes-content');

  // If already loading, skip
  if (lazyLoadState.routes.loading) return;

  // If cache is still valid, just render from cache
  if (isCacheValid(lazyLoadState.routes.loadedAt) && analyticsData.routes) {
    console.log('[Analytics] Using cached routes data');
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');
    renderRouteTable(sortData(analyticsData.routes, sortState.routes));
    return;
  }

  // Show loading, hide content
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (contentEl) contentEl.classList.add('hidden');

  lazyLoadState.routes.loading = true;
  try {
    const data = await getAnalyticsRoutes(currentDays);
    analyticsData.routes = data.routes;
    lazyLoadState.routes.loaded = true;
    lazyLoadState.routes.loadedAt = Date.now();

    // Hide loading, show content
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

    renderRouteTable(sortData(analyticsData.routes, sortState.routes));
  } catch (error) {
    console.error('[Analytics] Failed to load routes:', error);
    // Show error in loading div
    if (loadingEl) loadingEl.textContent = 'Failed to load route data';
  } finally {
    lazyLoadState.routes.loading = false;
  }
}

/**
 * Preload all tabs in background (parallel)
 * Data is cached so tabs open instantly when clicked
 */
async function preloadAllTabs() {
  // Load vessels and routes in parallel
  const vesselsPromise = (async () => {
    try {
      if (analyticsData?.vessels) return; // Already cached

      const data = await getAnalyticsVessels(currentDays);
      analyticsData.vessels = data.vessels;
      lazyLoadState.vessels.loaded = true;
      lazyLoadState.vessels.loadedAt = Date.now();

      // Render Top/Bottom charts in Overview
      const entries = analyticsData.summary?.vesselRevenueEntries;
      renderVesselsRevenueChart(data.vessels, entries);
      renderBottomVesselsRevenueChart(data.vessels, entries);
    } catch (error) {
      console.error('[Analytics] Failed to preload vessels:', error);
    }
  })();

  const routesPromise = (async () => {
    try {
      if (analyticsData?.routes) return; // Already cached

      const data = await getAnalyticsRoutes(currentDays);
      analyticsData.routes = data.routes;
      lazyLoadState.routes.loaded = true;
      lazyLoadState.routes.loadedAt = Date.now();
    } catch (error) {
      console.error('[Analytics] Failed to preload routes:', error);
    }
  })();

  // Wait for both (non-blocking for UI)
  await Promise.all([vesselsPromise, routesPromise]);
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
function renderQuickSummary() {
  // Quick summary section removed - all relevant data shown in main summary cards and chart
  const container = document.getElementById('analytics-quick-summary');
  if (container) container.innerHTML = '';
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
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">No vessel data available</td></tr>';
    return;
  }

  // Apply vessel filter (owned vs sold)
  const filteredVessels = vessels.filter(v => {
    const isOwned = v.isOwned !== false; // Default to owned if not specified
    if (isOwned && !vesselFilterState.showOwned) return false;
    if (!isOwned && !vesselFilterState.showSold) return false;
    return true;
  });

  if (filteredVessels.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">No vessels match current filter</td></tr>';
    return;
  }

  let html = '';
  filteredVessels.forEach(v => {
    const isOwned = v.isOwned !== false;
    const statusIcon = isOwned
      ? '<span class="vessel-status owned" title="Currently owned">&#x1F7E2;</span>'
      : '<span class="vessel-status sold" title="Sold">&#x1F578;&#xFE0F;</span>';

    html += `
      <tr data-vessel-id="${v.vesselId}">
        <td class="vessel-name">${statusIcon} ${escapeHtml(v.name)}</td>
        <td class="num">${v.trips}</td>
        <td class="num">${formatCurrency(v.totalRevenue)}</td>
        <td class="num">${formatCurrency(v.avgRevenuePerTrip)}</td>
        <td class="num">${formatNumber(v.contribution || v.totalContribution || 0)}</td>
        <td class="num">${formatCurrency(v.avgRevenuePerHour)}</td>
        <td class="num">${formatCurrency(v.avgRevenuePerNm)}</td>
        <td class="num">${formatPercent(v.avgUtilization)}</td>
        <td class="route">${escapeHtml(v.primaryRoute || '-')}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// Vessel chart instances
let vesselsRevenueChart = null;
let bottomVesselsRevenueChart = null;
let vesselsUtilizationChart = null;

/**
 * Render vessel charts for Vessels tab (composition and utilization only)
 * Top/Bottom revenue charts are now in Overview tab
 * @param {Array} vessels - Vessel data
 * @param {Array} utilizationEntries - Individual utilization entries with timestamps
 */
function renderVesselCharts(vessels, utilizationEntries) {
  if (!vessels || vessels.length === 0) return;

  // Top/Bottom revenue charts are now rendered in Overview tab
  renderVesselsCompositionChart(vessels);
  renderVesselsUtilizationChart(utilizationEntries);
}

/**
 * Render Top 10 Vessels by Revenue line chart with timestamp-based zoom
 * @param {Array|null} vessels - Vessel data (optional, can derive top 10 from entries)
 * @param {Array} vesselRevenueEntries - Individual entries with {time, value, vesselId, vesselName}
 */
function renderVesselsRevenueChart(vessels, vesselRevenueEntries) {
  const container = document.getElementById('vessels-revenue-chart-container');
  if (!container) return;

  if (vesselsRevenueChart) {
    vesselsRevenueChart.remove();
    vesselsRevenueChart = null;
  }

  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="no-data">Chart library not loaded</div>';
    return;
  }

  // Determine top 10 vessels by total revenue
  let top10;
  if (vessels && vessels.length > 0) {
    // Use provided vessels data
    top10 = [...vessels]
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 10);
  } else if (vesselRevenueEntries && vesselRevenueEntries.length > 0) {
    // Calculate from entries
    const vesselTotals = new Map();
    for (const entry of vesselRevenueEntries) {
      const id = String(entry.vesselId);
      if (!vesselTotals.has(id)) {
        vesselTotals.set(id, { vesselId: id, vesselName: entry.vesselName, totalRevenue: 0 });
      }
      vesselTotals.get(id).totalRevenue += entry.value;
    }
    top10 = [...vesselTotals.values()]
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 10);
  } else {
    top10 = [];
  }

  // Colors for vessels
  const colors = [
    '#10b981', '#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#a855f7'
  ];

  // Header with filter info
  const filterText = currentDays === 0 ? 'All Time' : `${currentDays} Days`;
  container.innerHTML = `
    <div class="analytics-chart-header">
      <span class="analytics-chart-title">Top 10 Vessels - Daily Revenue (filtered by ${filterText})</span>
    </div>
  `;

  if (!vesselRevenueEntries || vesselRevenueEntries.length === 0) {
    container.innerHTML += '<div class="no-data">No vessel revenue data available</div>';
    return;
  }

  // Create chart container
  const chartDiv = document.createElement('div');
  chartDiv.style.height = '300px';
  chartDiv.style.width = '100%';
  container.appendChild(chartDiv);

  // Create chart with timestamp support and zoom enabled
  vesselsRevenueChart = LightweightCharts.createChart(chartDiv, {
    autoSize: true,
    height: 300,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af',
      attributionLogo: false
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
      timeVisible: true,
      secondsVisible: true,
      minBarSpacing: 0.0001
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    }
  });

  // Build daily breakdown data per vessel (aggregate by day)
  const top10Ids = new Set(top10.map(v => String(v.vesselId)));
  const dailyByVessel = {};

  for (const vessel of top10) {
    dailyByVessel[vessel.vesselId] = new Map(); // day timestamp -> daily total
  }

  // Filter entries for top 10 vessels and aggregate by day
  const sortedEntries = vesselRevenueEntries
    .filter(e => top10Ids.has(String(e.vesselId)))
    .sort((a, b) => a.time - b.time);

  for (const entry of sortedEntries) {
    const vesselId = String(entry.vesselId);
    if (dailyByVessel[vesselId]) {
      // Convert timestamp to day (start of day in UTC)
      const dayTimestamp = Math.floor(entry.time / 86400) * 86400;
      const currentTotal = dailyByVessel[vesselId].get(dayTimestamp) || 0;
      dailyByVessel[vesselId].set(dayTimestamp, currentTotal + entry.value);
    }
  }

  // Create series for each vessel (daily bars/lines)
  const seriesMap = {};
  top10.forEach((vessel, i) => {
    const lineOptions = {
      color: colors[i],
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: 'custom',
        formatter: formatChartPrice
      }
    };

    let series;
    if (typeof vesselsRevenueChart.addLineSeries === 'function') {
      series = vesselsRevenueChart.addLineSeries(lineOptions);
    } else {
      series = vesselsRevenueChart.addSeries(LightweightCharts.LineSeries, lineOptions);
    }

    // Convert daily Map to sorted array
    const dataMap = dailyByVessel[vessel.vesselId];
    const data = dataMap
      ? Array.from(dataMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([time, value]) => ({ time, value }))
      : [];

    series.setData(data);
    seriesMap[vessel.vesselId] = series;
  });

  vesselsRevenueChart.timeScale().fitContent();

  // Add toggles under chart
  const togglesDiv = document.createElement('div');
  togglesDiv.className = 'analytics-chart-toggles';
  togglesDiv.innerHTML = top10.map((v, i) => `
    <button class="analytics-chart-toggle active" data-vessel-id="${v.vesselId}" style="border-color: ${colors[i]}40;">
      <span class="analytics-chart-legend-dot" style="background: ${colors[i]};"></span>
      ${escapeHtml(v.name || v.vesselName)}
    </button>
  `).join('');
  container.appendChild(togglesDiv);

  // Toggle handlers
  togglesDiv.querySelectorAll('.analytics-chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = btn.dataset.vesselId;
      const isActive = btn.classList.toggle('active');
      if (seriesMap[vesselId]) {
        seriesMap[vesselId].applyOptions({ visible: isActive });
      }
    });
  });
}

/**
 * Render Bottom 10 Vessels by Daily Revenue (worst performers)
 * @param {Array|null} vessels - Vessel data (optional, can derive bottom 10 from entries)
 * @param {Array} vesselRevenueEntries - Time-series revenue entries
 */
function renderBottomVesselsRevenueChart(vessels, vesselRevenueEntries) {
  const container = document.getElementById('vessels-bottom-revenue-chart-container');
  if (!container) return;

  if (bottomVesselsRevenueChart) {
    bottomVesselsRevenueChart.remove();
    bottomVesselsRevenueChart = null;
  }

  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="no-data">Chart library not loaded</div>';
    return;
  }

  // Determine bottom 10 vessels by total revenue (ascending)
  let bottom10;
  if (vessels && vessels.length > 0) {
    // Use provided vessels data
    bottom10 = [...vessels]
      .sort((a, b) => a.totalRevenue - b.totalRevenue)
      .slice(0, 10);
  } else if (vesselRevenueEntries && vesselRevenueEntries.length > 0) {
    // Calculate from entries
    const vesselTotals = new Map();
    for (const entry of vesselRevenueEntries) {
      const id = String(entry.vesselId);
      if (!vesselTotals.has(id)) {
        vesselTotals.set(id, { vesselId: id, vesselName: entry.vesselName, totalRevenue: 0 });
      }
      vesselTotals.get(id).totalRevenue += entry.value;
    }
    bottom10 = [...vesselTotals.values()]
      .sort((a, b) => a.totalRevenue - b.totalRevenue)
      .slice(0, 10);
  } else {
    bottom10 = [];
  }

  // Colors for vessels (no red - reserved for zero line)
  const colors = [
    '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899',
    '#14b8a6', '#f97316', '#06b6d4', '#a855f7', '#84cc16'
  ];

  // Header with filter info
  const filterText = currentDays === 0 ? 'All Time' : `${currentDays} Days`;
  container.innerHTML = `
    <div class="analytics-chart-header">
      <span class="analytics-chart-title">Bottom 10 Vessels - Daily Revenue (filtered by ${filterText})</span>
    </div>
  `;

  if (!vesselRevenueEntries || vesselRevenueEntries.length === 0) {
    container.innerHTML += '<div class="no-data">No vessel revenue data available</div>';
    return;
  }

  // Create chart container
  const chartDiv = document.createElement('div');
  chartDiv.style.height = '300px';
  chartDiv.style.width = '100%';
  container.appendChild(chartDiv);

  // Create chart with timestamp support and zoom enabled
  bottomVesselsRevenueChart = LightweightCharts.createChart(chartDiv, {
    autoSize: true,
    height: 300,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af',
      attributionLogo: false
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.1)' },
      horzLines: { color: 'rgba(255,255,255,0.1)' }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.2)',
      autoScale: true,
      entireTextOnly: true
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.2)',
      timeVisible: true,
      secondsVisible: true,
      minBarSpacing: 0.0001
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    }
  });

  // Build daily breakdown data per vessel (aggregate by day)
  const bottom10Ids = new Set(bottom10.map(v => String(v.vesselId)));
  const dailyByVessel = {};

  for (const vessel of bottom10) {
    dailyByVessel[vessel.vesselId] = new Map(); // day timestamp -> daily total
  }

  // Filter entries for bottom 10 vessels and aggregate by day
  const sortedEntries = vesselRevenueEntries
    .filter(e => bottom10Ids.has(String(e.vesselId)))
    .sort((a, b) => a.time - b.time);

  for (const entry of sortedEntries) {
    const vesselId = String(entry.vesselId);
    if (dailyByVessel[vesselId]) {
      // Convert timestamp to day (start of day in UTC)
      const dayTimestamp = Math.floor(entry.time / 86400) * 86400;
      const currentTotal = dailyByVessel[vesselId].get(dayTimestamp) || 0;
      dailyByVessel[vesselId].set(dayTimestamp, currentTotal + entry.value);
    }
  }

  // Create series for each vessel (daily bars/lines)
  const seriesMap = {};
  bottom10.forEach((vessel, i) => {
    const lineOptions = {
      color: colors[i],
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: 'custom',
        formatter: formatChartPrice
      }
    };

    let series;
    if (typeof bottomVesselsRevenueChart.addLineSeries === 'function') {
      series = bottomVesselsRevenueChart.addLineSeries(lineOptions);
    } else {
      series = bottomVesselsRevenueChart.addSeries(LightweightCharts.LineSeries, lineOptions);
    }

    // Convert daily Map to sorted array
    const dataMap = dailyByVessel[vessel.vesselId];
    const data = dataMap
      ? Array.from(dataMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([time, value]) => ({ time, value }))
      : [];

    series.setData(data);
    seriesMap[vessel.vesselId] = series;
  });

  bottomVesselsRevenueChart.timeScale().fitContent();

  // Add zero line using createPriceLine on first series
  const firstVesselId = Object.keys(seriesMap)[0];
  if (firstVesselId && seriesMap[firstVesselId]) {
    seriesMap[firstVesselId].createPriceLine({
      price: 0,
      color: '#ef4444',
      lineWidth: 1,
      lineStyle: 2, // Dashed
      axisLabelVisible: true
    });
  }

  // Add toggles under chart
  const togglesDiv = document.createElement('div');
  togglesDiv.className = 'analytics-chart-toggles';
  togglesDiv.innerHTML = bottom10.map((v, i) => `
    <button class="analytics-chart-toggle active" data-vessel-id="${v.vesselId}" style="border-color: ${colors[i]}40;">
      <span class="analytics-chart-legend-dot" style="background: ${colors[i]};"></span>
      ${escapeHtml(v.name || v.vesselName)}
    </button>
  `).join('');
  container.appendChild(togglesDiv);

  // Toggle handlers
  togglesDiv.querySelectorAll('.analytics-chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = btn.dataset.vesselId;
      const isActive = btn.classList.toggle('active');
      if (seriesMap[vesselId]) {
        seriesMap[vesselId].applyOptions({ visible: isActive });
      }
    });
  });
}

/**
 * Render Fleet Composition as SVG pie chart
 * @param {Array} vessels - Vessel data
 */
function renderVesselsCompositionChart(vessels) {
  const container = document.getElementById('vessels-composition-chart-container');
  if (!container) return;

  // Calculate total revenue
  const totalRevenue = vessels.reduce((sum, v) => sum + v.totalRevenue, 0);

  // Sort and get contribution percentage - filter out vessels with 0 revenue
  const withPercent = [...vessels]
    .filter(v => v.totalRevenue > 0)
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .map(v => ({
      ...v,
      percent: totalRevenue > 0 ? (v.totalRevenue / totalRevenue * 100) : 0
    }));

  // Cluster vessels by rounded percent (1 decimal place)
  const clusters = new Map();
  for (const v of withPercent) {
    const roundedPercent = Math.round(v.percent * 10) / 10; // Round to 0.1%
    if (!clusters.has(roundedPercent)) {
      clusters.set(roundedPercent, []);
    }
    clusters.get(roundedPercent).push(v);
  }

  // Build slices - single vessels stay single, groups become clusters
  const slices = [];
  for (const [roundedPercent, group] of clusters.entries()) {
    if (group.length === 1) {
      // Single vessel
      slices.push({
        name: group[0].name,
        totalRevenue: group[0].totalRevenue,
        percent: group[0].percent,
        vesselData: [{ name: group[0].name, vesselId: group[0].vesselId }]
      });
    } else {
      // Cluster multiple vessels
      const totalRev = group.reduce((sum, v) => sum + v.totalRevenue, 0);
      const totalPct = group.reduce((sum, v) => sum + v.percent, 0);
      slices.push({
        name: `${group.length} vessels @ ${roundedPercent.toFixed(1)}%`,
        totalRevenue: totalRev,
        percent: totalPct,
        vesselData: group.map(v => ({ name: v.name, vesselId: v.vesselId }))
      });
    }
  }

  // Sort slices by percent descending
  slices.sort((a, b) => b.percent - a.percent);

  // Colors for slices
  const colors = [
    '#10b981', '#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#a855f7',
    '#84cc16', '#e11d48', '#0ea5e9', '#d946ef', '#22c55e', '#eab308'
  ];

  // Header
  container.innerHTML = `
    <div class="analytics-chart-header">
      <span class="analytics-chart-title">Fleet Revenue Composition</span>
    </div>
  `;

  // Create main wrapper with pie chart and treemap side by side
  const mainWrapper = document.createElement('div');
  mainWrapper.className = 'fleet-composition-wrapper';

  // Create container for pie chart with tooltip
  const chartWrapper = document.createElement('div');
  chartWrapper.className = 'fleet-pie-wrapper';

  // Create SVG pie chart (larger since no legend)
  const size = 280;
  const radius = 130;
  const centerX = size / 2;
  const centerY = size / 2;

  let paths = '';
  let currentAngle = -90; // Start at top

  // Draw slices (single vessels or clusters)
  slices.forEach((slice, i) => {
    const angle = (slice.percent / 100) * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;

    // Convert to radians
    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;

    // Calculate arc points
    const x1 = centerX + radius * Math.cos(startRad);
    const y1 = centerY + radius * Math.sin(startRad);
    const x2 = centerX + radius * Math.cos(endRad);
    const y2 = centerY + radius * Math.sin(endRad);

    // Large arc flag (1 if angle > 180)
    const largeArc = angle > 180 ? 1 : 0;

    // Create path with data attributes for tooltip (include vessel data for clicks)
    const pathData = `M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    const vesselDataJson = JSON.stringify(slice.vesselData);
    paths += `<path class="fleet-pie-path" d="${pathData}" fill="${colors[i % colors.length]}" stroke="#1f2937" stroke-width="1"
      data-name="${escapeHtml(slice.name)}"
      data-revenue="${formatCurrency(slice.totalRevenue)}"
      data-percent="${slice.percent.toFixed(1)}"
      data-vessel-data='${vesselDataJson.replace(/'/g, "&#39;")}'></path>`;

    currentAngle = endAngle;
  });

  const svgDiv = document.createElement('div');
  svgDiv.className = 'fleet-pie-svg-container';
  svgDiv.innerHTML = `<svg class="fleet-pie-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}</svg>`;
  chartWrapper.appendChild(svgDiv);

  // Zoom and pan state
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let startX = 0;
  let startY = 0;
  const svg = svgDiv.querySelector('svg');

  const updateTransform = () => {
    svg.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
  };

  // Mouse wheel zoom (up to 20x for small slices)
  svgDiv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.max(0.5, Math.min(20, scale * delta));
    updateTransform();
  });

  // Pan with mouse drag
  svgDiv.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    startX = e.clientX - panX * scale;
    startY = e.clientY - panY * scale;
    svgDiv.style.cursor = 'grabbing';
  });

  svgDiv.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panX = (e.clientX - startX) / scale;
    panY = (e.clientY - startY) / scale;
    updateTransform();
  });

  svgDiv.addEventListener('mouseup', () => {
    isPanning = false;
    svgDiv.style.cursor = 'grab';
  });

  svgDiv.addEventListener('mouseleave', () => {
    isPanning = false;
    svgDiv.style.cursor = 'grab';
  });

  // Double-click to reset
  svgDiv.addEventListener('dblclick', () => {
    scale = 1;
    panX = 0;
    panY = 0;
    updateTransform();
  });

  // Simple hover tooltip (follows mouse, summary only)
  const hoverTooltip = document.createElement('div');
  hoverTooltip.className = 'fleet-hover-tooltip';
  chartWrapper.appendChild(hoverTooltip);

  // Fixed detail panel (opens on click, stays open)
  const detailPanel = document.createElement('div');
  detailPanel.className = 'fleet-detail-panel fleet-pie-detail-panel';
  chartWrapper.appendChild(detailPanel);

  let selectedPath = null;

  const closeDetailPanel = () => {
    detailPanel.classList.remove('visible');
    if (selectedPath) {
      selectedPath.style.opacity = '1';
      selectedPath = null;
    }
  };

  const openDetailPanel = (path) => {
    // Close previous
    if (selectedPath && selectedPath !== path) {
      selectedPath.style.opacity = '1';
    }

    selectedPath = path;
    path.style.opacity = '0.7';

    const name = path.dataset.name;
    const revenue = path.dataset.revenue;
    const percent = path.dataset.percent;
    const vesselData = JSON.parse(path.dataset.vesselData || '[]');

    // Build vessel list with clickable pins
    const vesselListHtml = vesselData.map(v => `
      <div class="fleet-vessel-item">
        <span class="fleet-vessel-name">${escapeHtml(v.name)}</span>
        <button class="fleet-vessel-pin" data-vessel-id="${v.vesselId}" title="Show on map">&#x1F4CD;</button>
      </div>
    `).join('');

    detailPanel.innerHTML = `
      <div class="fleet-detail-header">
        <span class="fleet-detail-name">${escapeHtml(name)}</span>
        <button class="close-btn"><span>&times;</span></button>
      </div>
      <div class="fleet-detail-revenue">${revenue} (${percent}%)</div>
      <div class="fleet-detail-vessels-label">Vessels (${vesselData.length}):</div>
      ${vesselListHtml}
    `;

    // Close button handler
    detailPanel.querySelector('.close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeDetailPanel();
    });

    // Pin click handlers
    detailPanel.querySelectorAll('.fleet-vessel-pin').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vesselId = parseInt(btn.dataset.vesselId, 10);
        if (window.harborMap && window.harborMap.selectVesselFromPort) {
          const modal = document.getElementById('analyticsModal');
          if (modal) modal.classList.add('hidden');
          window.harborMap.selectVesselFromPort(vesselId);
        }
      });
    });

    detailPanel.classList.add('visible');
  };

  // Hover events (simple tooltip)
  svg.querySelectorAll('path').forEach(path => {
    path.addEventListener('mouseenter', () => {
      if (selectedPath === path) return; // Don't show hover tooltip for selected
      const name = path.dataset.name;
      const percent = path.dataset.percent;
      hoverTooltip.textContent = `${name} (${percent}%)`;
      hoverTooltip.classList.add('visible');
      if (selectedPath !== path) path.style.opacity = '0.85';
    });

    path.addEventListener('mousemove', (e) => {
      const rect = chartWrapper.getBoundingClientRect();
      hoverTooltip.style.left = (e.clientX - rect.left + 12) + 'px';
      hoverTooltip.style.top = (e.clientY - rect.top - 8) + 'px';
    });

    path.addEventListener('mouseleave', () => {
      hoverTooltip.classList.remove('visible');
      if (selectedPath !== path) path.style.opacity = '1';
    });

    // Click to open detail panel
    path.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedPath === path) {
        closeDetailPanel();
      } else {
        openDetailPanel(path);
      }
    });
  });

  // Click outside to close panel
  chartWrapper.addEventListener('click', (e) => {
    if (!e.target.closest('path') && !e.target.closest('.close-btn')) {
      closeDetailPanel();
    }
  });

  // Add pie chart to main wrapper
  mainWrapper.appendChild(chartWrapper);

  // === TREEMAP VISUALIZATION ===
  const treemapWrapper = document.createElement('div');
  treemapWrapper.className = 'fleet-treemap-wrapper';

  // Treemap dimensions - height matches pie chart diameter
  const treemapWidth = 320;
  const treemapHeight = 280; // Same as pie SVG size

  // Squarified treemap algorithm
  function squarify(items, x, y, width, height) {
    const rects = [];
    if (items.length === 0) return rects;

    const totalValue = items.reduce((sum, item) => sum + item.percent, 0);
    if (totalValue <= 0) return rects;

    // Create a copy sorted by value descending
    const remaining = [...items].sort((a, b) => b.percent - a.percent);

    let currentX = x;
    let currentY = y;
    let remainingWidth = width;
    let remainingHeight = height;

    while (remaining.length > 0) {
      // Decide if we split horizontally or vertically
      const isWide = remainingWidth >= remainingHeight;

      // Get items for this row/column (use simple slice algorithm)
      const rowItems = [];
      let rowTotal = 0;
      const areaPerUnit = (remainingWidth * remainingHeight) / remaining.reduce((s, i) => s + i.percent, 0);

      // Take items until aspect ratio starts getting worse
      let bestAspect = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const item = remaining[i];
        rowItems.push(item);
        rowTotal += item.percent;

        const rowArea = rowTotal * areaPerUnit;
        const rowSize = isWide ? rowArea / remainingHeight : rowArea / remainingWidth;
        const worstAspect = Math.max(...rowItems.map(ri => {
          const itemArea = ri.percent * areaPerUnit;
          const itemSize = itemArea / rowSize;
          return Math.max(rowSize / itemSize, itemSize / rowSize);
        }));

        if (worstAspect <= bestAspect) {
          bestAspect = worstAspect;
        } else {
          // Aspect got worse, remove last item
          rowItems.pop();
          rowTotal -= item.percent;
          break;
        }
      }

      // Calculate row dimensions
      const rowAreaTotal = rowTotal * areaPerUnit;
      const rowSize = isWide
        ? Math.min(rowAreaTotal / remainingHeight, remainingWidth)
        : Math.min(rowAreaTotal / remainingWidth, remainingHeight);

      // Layout items in this row
      let itemOffset = 0;
      for (const item of rowItems) {
        const itemArea = item.percent * areaPerUnit;
        const itemSize = rowSize > 0 ? itemArea / rowSize : 0;

        let rx, ry, rw, rh;
        if (isWide) {
          rx = currentX;
          ry = currentY + itemOffset;
          rw = rowSize;
          rh = itemSize;
        } else {
          rx = currentX + itemOffset;
          ry = currentY;
          rw = itemSize;
          rh = rowSize;
        }

        rects.push({
          ...item,
          x: rx,
          y: ry,
          width: Math.max(0, rw - 1),
          height: Math.max(0, rh - 1)
        });

        itemOffset += itemSize;

        // Remove from remaining
        const idx = remaining.indexOf(item);
        if (idx > -1) remaining.splice(idx, 1);
      }

      // Update remaining area
      if (isWide) {
        currentX += rowSize;
        remainingWidth -= rowSize;
      } else {
        currentY += rowSize;
        remainingHeight -= rowSize;
      }
    }

    return rects;
  }

  // Build treemap rectangles
  const treemapRects = squarify(slices, 0, 0, treemapWidth, treemapHeight);

  // Create treemap SVG
  let treemapPaths = '';
  treemapRects.forEach((rect, i) => {
    if (rect.width < 2 || rect.height < 2) return; // Skip tiny rects

    const vesselDataJson = JSON.stringify(rect.vesselData);
    const showLabel = rect.width > 40 && rect.height > 20;
    const labelText = showLabel ? (rect.name.length > 12 ? rect.name.substring(0, 10) + '..' : rect.name) : '';

    treemapPaths += `
      <g class="fleet-treemap-cell" data-name="${escapeHtml(rect.name)}"
         data-revenue="${formatCurrency(rect.totalRevenue)}"
         data-percent="${rect.percent.toFixed(1)}"
         data-vessel-data='${vesselDataJson.replace(/'/g, "&#39;")}'>
        <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"
              fill="${colors[i % colors.length]}" stroke="#1f2937" stroke-width="1"/>
        ${showLabel ? `<text x="${rect.x + rect.width / 2}" y="${rect.y + rect.height / 2}"
              text-anchor="middle" dominant-baseline="middle"
              fill="#fff" font-size="10" font-weight="500">${escapeHtml(labelText)}</text>` : ''}
      </g>
    `;
  });

  treemapWrapper.innerHTML = `<svg width="${treemapWidth}" height="${treemapHeight}" viewBox="0 0 ${treemapWidth} ${treemapHeight}">${treemapPaths}</svg>`;

  // Treemap hover tooltip
  const treemapTooltip = document.createElement('div');
  treemapTooltip.className = 'fleet-hover-tooltip';
  treemapWrapper.appendChild(treemapTooltip);

  // Treemap detail panel
  const treemapPanel = document.createElement('div');
  treemapPanel.className = 'fleet-detail-panel fleet-treemap-detail-panel';
  treemapWrapper.appendChild(treemapPanel);

  let selectedTreemapCell = null;

  const closeTreemapPanel = () => {
    treemapPanel.classList.remove('visible');
    if (selectedTreemapCell) {
      selectedTreemapCell.querySelector('rect').style.opacity = '1';
      selectedTreemapCell = null;
    }
  };

  const openTreemapPanel = (cell) => {
    if (selectedTreemapCell && selectedTreemapCell !== cell) {
      selectedTreemapCell.querySelector('rect').style.opacity = '1';
    }

    selectedTreemapCell = cell;
    cell.querySelector('rect').style.opacity = '0.7';

    const name = cell.dataset.name;
    const revenue = cell.dataset.revenue;
    const percent = cell.dataset.percent;
    const vesselData = JSON.parse(cell.dataset.vesselData || '[]');

    const vesselListHtml = vesselData.map(v => `
      <div class="fleet-vessel-item">
        <span class="fleet-vessel-name">${escapeHtml(v.name)}</span>
        <button class="fleet-vessel-pin" data-vessel-id="${v.vesselId}" title="Show on map">&#x1F4CD;</button>
      </div>
    `).join('');

    treemapPanel.innerHTML = `
      <div class="fleet-detail-header">
        <span class="fleet-detail-name">${escapeHtml(name)}</span>
        <button class="close-btn"><span>&times;</span></button>
      </div>
      <div class="fleet-detail-revenue">${revenue} (${percent}%)</div>
      <div class="fleet-detail-vessels-label">Vessels (${vesselData.length}):</div>
      ${vesselListHtml}
    `;

    treemapPanel.querySelector('.close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTreemapPanel();
    });

    treemapPanel.querySelectorAll('.fleet-vessel-pin').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vesselId = parseInt(btn.dataset.vesselId, 10);
        if (window.harborMap && window.harborMap.selectVesselFromPort) {
          const modal = document.getElementById('analyticsModal');
          if (modal) modal.classList.add('hidden');
          window.harborMap.selectVesselFromPort(vesselId);
        }
      });
    });

    treemapPanel.classList.add('visible');
  };

  // Treemap interactions
  treemapWrapper.querySelectorAll('.fleet-treemap-cell').forEach(cell => {
    const rect = cell.querySelector('rect');

    cell.addEventListener('mouseenter', () => {
      if (selectedTreemapCell === cell) return;
      const name = cell.dataset.name;
      const percent = cell.dataset.percent;
      treemapTooltip.textContent = `${name} (${percent}%)`;
      treemapTooltip.classList.add('visible');
      if (selectedTreemapCell !== cell) rect.style.opacity = '0.85';
    });

    cell.addEventListener('mousemove', (e) => {
      const wrapperRect = treemapWrapper.getBoundingClientRect();
      treemapTooltip.style.left = (e.clientX - wrapperRect.left + 10) + 'px';
      treemapTooltip.style.top = (e.clientY - wrapperRect.top - 8) + 'px';
    });

    cell.addEventListener('mouseleave', () => {
      treemapTooltip.classList.remove('visible');
      if (selectedTreemapCell !== cell) rect.style.opacity = '1';
    });

    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedTreemapCell === cell) {
        closeTreemapPanel();
      } else {
        openTreemapPanel(cell);
      }
    });
  });

  // Click outside to close treemap panel
  treemapWrapper.addEventListener('click', (e) => {
    if (!e.target.closest('.fleet-treemap-cell') && !e.target.closest('.close-btn')) {
      closeTreemapPanel();
    }
  });

  mainWrapper.appendChild(treemapWrapper);
  container.appendChild(mainWrapper);
}

/**
 * Render Utilization Over Time chart
 * Shows individual utilization points with timestamps for zoom capability
 * @param {Array} utilizationEntries - Individual entries with {time, value, vesselName}
 */
function renderVesselsUtilizationChart(utilizationEntries) {
  const container = document.getElementById('vessels-utilization-chart-container');
  if (!container) return;

  if (vesselsUtilizationChart) {
    vesselsUtilizationChart.remove();
    vesselsUtilizationChart = null;
  }

  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="no-data">Chart library not loaded</div>';
    return;
  }

  // Filter valid entries - ensure valid timestamps (Unix seconds 2020-2030)
  const minTime = 1577836800; // 2020-01-01
  const maxTime = 1893456000; // 2030-01-01
  const validEntries = utilizationEntries ? utilizationEntries.filter(e =>
    e.time && e.time >= minTime && e.time <= maxTime &&
    e.value !== null && e.value !== undefined && typeof e.value === 'number'
  ) : [];

  if (validEntries.length === 0) {
    container.innerHTML = `
      <div class="analytics-chart-header">
        <span class="analytics-chart-title">Utilization Over Time</span>
      </div>
      <div class="no-data">No utilization data available</div>
    `;
    return;
  }

  // Calculate overall average for display
  const overallAvg = validEntries.reduce((sum, e) => sum + e.value, 0) / validEntries.length;

  // Header with overall average
  container.innerHTML = `
    <div class="analytics-chart-header">
      <span class="analytics-chart-title">Utilization Over Time</span>
      <span class="analytics-chart-subtitle">Avg: ${overallAvg.toFixed(1)}% (${validEntries.length} departures)</span>
    </div>
  `;

  // Create chart container
  const chartDiv = document.createElement('div');
  chartDiv.style.height = '200px';
  chartDiv.style.width = '100%';
  container.appendChild(chartDiv);

  // Create chart with timestamp support and zoom enabled
  vesselsUtilizationChart = LightweightCharts.createChart(chartDiv, {
    autoSize: true,
    height: 200,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af',
      attributionLogo: false
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.1)' },
      horzLines: { color: 'rgba(255,255,255,0.1)' }
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.2)',
      scaleMargins: { top: 0.1, bottom: 0.1 }
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.2)',
      timeVisible: true,
      secondsVisible: true,
      minBarSpacing: 0.0001
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    }
  });

  // Colors for utilization ranges (red to green)
  const rangeColors = {
    '0-25': '#ef4444',
    '25-50': '#f59e0b',
    '50-75': '#84cc16',
    '75-100': '#10b981'
  };

  // Categorize entries by utilization range
  // Use Maps to deduplicate timestamps (LightweightCharts requires unique timestamps)
  const rangeMaps = {
    '0-25': new Map(),
    '25-50': new Map(),
    '50-75': new Map(),
    '75-100': new Map()
  };

  validEntries.forEach(e => {
    const val = e.value;
    let rangeKey;
    if (val < 25) rangeKey = '0-25';
    else if (val < 50) rangeKey = '25-50';
    else if (val < 75) rangeKey = '50-75';
    else rangeKey = '75-100';

    // If same timestamp exists, average the values
    if (rangeMaps[rangeKey].has(e.time)) {
      const existing = rangeMaps[rangeKey].get(e.time);
      rangeMaps[rangeKey].set(e.time, (existing + val) / 2);
    } else {
      rangeMaps[rangeKey].set(e.time, val);
    }
  });

  // Convert Maps to sorted arrays
  const rangeData = {};
  for (const key of Object.keys(rangeMaps)) {
    rangeData[key] = Array.from(rangeMaps[key].entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
  }

  // Create scatter-like series for each range using line series with markers
  const rangeSeries = {};
  const rangeKeys = ['75-100', '50-75', '25-50', '0-25'];

  for (const key of rangeKeys) {
    const lineOptions = {
      color: rangeColors[key],
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      visible: rangeData[key].length > 0, // Hide if no data
      priceFormat: {
        type: 'custom',
        formatter: (value) => `${value.toFixed(1)}%`
      }
    };

    let series;
    if (typeof vesselsUtilizationChart.addLineSeries === 'function') {
      series = vesselsUtilizationChart.addLineSeries(lineOptions);
    } else {
      series = vesselsUtilizationChart.addSeries(LightweightCharts.LineSeries, lineOptions);
    }

    // Always set data (empty array is OK)
    series.setData(rangeData[key]);
    rangeSeries[key] = series;
  }

  vesselsUtilizationChart.timeScale().fitContent();

  // Calculate totals for legend
  const totals = {
    '0-25': rangeData['0-25'].length,
    '25-50': rangeData['25-50'].length,
    '50-75': rangeData['50-75'].length,
    '75-100': rangeData['75-100'].length
  };

  // Add legend under chart
  const legendDiv = document.createElement('div');
  legendDiv.className = 'analytics-chart-toggles';
  legendDiv.innerHTML = `
    <button class="analytics-chart-toggle active" data-series="75-100" style="border-color: ${rangeColors['75-100']}40;">
      <span class="analytics-chart-legend-dot" style="background: ${rangeColors['75-100']};"></span>
      75-100% (${totals['75-100']})
    </button>
    <button class="analytics-chart-toggle active" data-series="50-75" style="border-color: ${rangeColors['50-75']}40;">
      <span class="analytics-chart-legend-dot" style="background: ${rangeColors['50-75']};"></span>
      50-75% (${totals['50-75']})
    </button>
    <button class="analytics-chart-toggle active" data-series="25-50" style="border-color: ${rangeColors['25-50']}40;">
      <span class="analytics-chart-legend-dot" style="background: ${rangeColors['25-50']};"></span>
      25-50% (${totals['25-50']})
    </button>
    <button class="analytics-chart-toggle active" data-series="0-25" style="border-color: ${rangeColors['0-25']}40;">
      <span class="analytics-chart-legend-dot" style="background: ${rangeColors['0-25']};"></span>
      0-25% (${totals['0-25']})
    </button>
  `;
  container.appendChild(legendDiv);

  // Toggle handlers
  legendDiv.querySelectorAll('.analytics-chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const seriesKey = btn.dataset.series;
      btn.classList.toggle('active');
      const isVisible = btn.classList.contains('active');

      if (rangeSeries[seriesKey]) {
        rangeSeries[seriesKey].applyOptions({ visible: isVisible });
      }
    });
  });
}

/**
 * Update route filter icon visual states
 */
function updateRouteFilterIcons() {
  const activeIcon = document.getElementById('route-filter-active');
  const inactiveIcon = document.getElementById('route-filter-inactive');

  if (activeIcon) {
    activeIcon.classList.toggle('filter-enabled', routeFilterState.showActive);
    activeIcon.classList.toggle('filter-disabled', !routeFilterState.showActive);
  }
  if (inactiveIcon) {
    inactiveIcon.classList.toggle('filter-enabled', routeFilterState.showInactive);
    inactiveIcon.classList.toggle('filter-disabled', !routeFilterState.showInactive);
  }
}

/**
 * Update vessel filter icon visual states
 */
function updateVesselFilterIcons() {
  const ownedIcon = document.getElementById('vessel-filter-owned');
  const soldIcon = document.getElementById('vessel-filter-sold');

  if (ownedIcon) {
    ownedIcon.classList.toggle('filter-enabled', vesselFilterState.showOwned);
    ownedIcon.classList.toggle('filter-disabled', !vesselFilterState.showOwned);
  }
  if (soldIcon) {
    soldIcon.classList.toggle('filter-enabled', vesselFilterState.showSold);
    soldIcon.classList.toggle('filter-disabled', !vesselFilterState.showSold);
  }
}

/**
 * Render Top 10 Routes highlight boxes
 * @param {Array} routes - Route data (unsorted, we sort here)
 */
function renderTop10Routes(routes) {
  const byHourEl = document.getElementById('top-routes-by-hour');
  const byNmEl = document.getElementById('top-routes-by-nm');

  if (!byHourEl || !byNmEl || !routes || routes.length === 0) return;

  // Filter to only routes with valid data
  const validRoutes = routes.filter(r => r.avgRevenuePerHour > 0 || r.avgIncomePerNm > 0);

  // Top 10 by $/Hour
  const topByHour = [...validRoutes]
    .filter(r => r.avgRevenuePerHour > 0)
    .sort((a, b) => b.avgRevenuePerHour - a.avgRevenuePerHour)
    .slice(0, 10);

  // Top 10 by $/NM
  const topByNm = [...validRoutes]
    .filter(r => r.avgIncomePerNm > 0)
    .sort((a, b) => b.avgIncomePerNm - a.avgIncomePerNm)
    .slice(0, 10);

  // Reset headers
  const hourHeader = byHourEl.closest('.top-routes-section')?.querySelector('h4');
  if (hourHeader) hourHeader.textContent = 'Top 10 by $/Hour';

  const nmHeader = byNmEl.closest('.top-routes-section')?.querySelector('h4');
  if (nmHeader) nmHeader.textContent = 'Top 10 by $/NM';

  // Render $/Hour list
  byHourEl.innerHTML = topByHour.length > 0
    ? topByHour.map((r, i) => `
        <div class="top-route-item" data-route="${escapeHtml(r.route)}" title="Click to scroll to route">
          <span class="top-route-rank">${i + 1}</span>
          <span class="top-route-name">${escapeHtml(r.displayRoute || r.route)}</span>
          <span class="top-route-value">${formatCurrency(r.avgRevenuePerHour)}/h</span>
        </div>
      `).join('')
    : '<div class="top-routes-empty">No data</div>';

  // Render $/NM list
  byNmEl.innerHTML = topByNm.length > 0
    ? topByNm.map((r, i) => `
        <div class="top-route-item" data-route="${escapeHtml(r.route)}" title="Click to scroll to route">
          <span class="top-route-rank">${i + 1}</span>
          <span class="top-route-name">${escapeHtml(r.displayRoute || r.route)}</span>
          <span class="top-route-value">$${formatNumber(Math.round(r.avgIncomePerNm))}/nm</span>
        </div>
      `).join('')
    : '<div class="top-routes-empty">No data</div>';

  // Add click handlers to scroll to route in table
  document.querySelectorAll('.top-route-item').forEach(item => {
    item.addEventListener('click', () => {
      const routeKey = item.dataset.route;
      // Find row in table and scroll to it
      const row = document.querySelector(`#analytics-routes-tbody tr[data-route="${routeKey}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('highlight-row');
        setTimeout(() => row.classList.remove('highlight-row'), 2000);
      }
    });
  });
}

/**
 * Render route profitability table
 * @param {Array} routes - Route data
 */
function renderRouteTable(routes) {
  const tbody = document.getElementById('analytics-routes-tbody');
  if (!tbody) return;

  // Also render Top 10 boxes with original (unsorted) data
  renderTop10Routes(routes);

  if (!routes || routes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">No route data available</td></tr>';
    return;
  }

  // Apply route filters
  const filteredRoutes = routes.filter(r => {
    const isActive = r.isActive || r.activeVesselCount > 0;
    if (isActive && !routeFilterState.showActive) return false;
    if (!isActive && !routeFilterState.showInactive) return false;
    return true;
  });

  if (filteredRoutes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">No routes match the current filter</td></tr>';
    return;
  }

  let html = '';
  filteredRoutes.forEach(r => {
    const feeClass = r.harborFeePercent > 20 ? 'warning' : '';
    const incomePerNm = r.avgIncomePerNm ? `$${formatNumber(Math.round(r.avgIncomePerNm))}` : '-';

    // Hijacking risk from Game API + incident count from logs
    const hijackingRisk = r.hijackingRisk !== null ? r.hijackingRisk : null;
    const incidents = r.ransomIncidents !== null ? r.ransomIncidents : null;
    const hijackClass = hijackingRisk > 20 ? 'warning' : '';

    // Format: "25% (2)" with tooltips
    let hijackDisplay = '-';
    if (hijackingRisk !== null) {
      const riskSpan = `<span class="hijack-risk" title="Route hijacking probability from game">${hijackingRisk}%</span>`;
      if (incidents !== null && incidents > 0) {
        const incidentSpan = `<span class="hijack-incidents" title="Your hijacking incidents on this route (total ransom: $${formatNumber(r.totalRansomPaid)})">(${incidents})</span>`;
        hijackDisplay = `${riskSpan} ${incidentSpan}`;
      } else {
        hijackDisplay = riskSpan;
      }
    } else if (incidents !== null && incidents > 0) {
      hijackDisplay = `<span class="hijack-incidents" title="Your hijacking incidents on this route (total ransom: $${formatNumber(r.totalRansomPaid)})">(${incidents})</span>`;
    }

    // Route status icon and vessel count with active vessels
    const isActive = r.isActive || r.activeVesselCount > 0;
    const statusIcon = isActive
      ? '<span class="route-status active" title="Active Route">&#x1F7E2;</span>'
      : '<span class="route-status inactive" title="Inactive Route">&#x1F578;&#xFE0F;</span>';

    // Format vessel count: "5 (2)" = 5 historical, 2 currently active
    const activeCount = r.activeVesselCount || 0;
    const vesselDisplay = activeCount > 0
      ? `${r.vesselCount} <span class="active-vessel-count" title="Currently ${activeCount} vessel(s) on this route">(${activeCount})</span>`
      : `${r.vesselCount}`;

    const avgPerHour = r.avgRevenuePerHour ? formatCurrency(r.avgRevenuePerHour) : '-';

    html += `
      <tr data-origin="${escapeHtml(r.origin)}" data-destination="${escapeHtml(r.destination)}" data-route="${escapeHtml(r.route)}" class="${isActive ? '' : 'inactive-route'}">
        <td class="route-name">${statusIcon} ${escapeHtml(r.displayRoute || r.origin + ' - ' + r.destination)}</td>
        <td class="num">${vesselDisplay}</td>
        <td class="num">${r.trips}</td>
        <td class="num">${formatCurrency(r.totalRevenue)}</td>
        <td class="num">${formatCurrency(r.avgRevenuePerTrip)}</td>
        <td class="num">${avgPerHour}</td>
        <td class="num">${incomePerNm}</td>
        <td class="num ${hijackClass}">${hijackDisplay}</td>
        <td class="num ${feeClass}">${formatPercent(r.harborFeePercent)}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}


// Chart series visibility state
const chartSeriesState = {
  income: true,
  profit: true,
  expenses: true,
  trips: false
};

/**
 * Format price for Y-axis (US Dollar with thousand separators)
 * @param {number} price - Price value
 * @returns {string} Formatted price
 */
function formatChartPrice(price) {
  const absPrice = Math.abs(price);
  const sign = price < 0 ? '-' : '';

  if (absPrice >= 1000000) {
    return sign + '$' + (absPrice / 1000000).toFixed(1) + 'M';
  } else if (absPrice >= 1000) {
    return sign + '$' + Math.round(absPrice / 1000).toLocaleString('en-US') + 'K';
  }
  return sign + '$' + Math.round(absPrice).toLocaleString('en-US');
}

/**
 * Render revenue trend chart using TradingView Lightweight Charts
 * @param {Array} dailyData - Daily breakdown data from getMergedSummary
 */
function renderTrendChart(dailyData) {
  const container = document.getElementById('analytics-chart-container');
  if (!container) return;

  // Destroy existing chart
  destroyChart();

  if (!dailyData || dailyData.length === 0) {
    container.innerHTML = '<div class="no-data">No trend data available</div>';
    return;
  }

  // Check if LightweightCharts is available
  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="no-data">Chart library not loaded</div>';
    return;
  }

  // If container not visible yet (width 0), retry after short delay
  if (container.offsetWidth === 0) {
    setTimeout(() => renderTrendChart(dailyData), 100);
    return;
  }

  // Clear container and create header with title left, toggle buttons right
  const headerHtml = `
    <div class="analytics-chart-header">
      <span class="analytics-chart-title">Your Daily Trend</span>
      <div class="analytics-chart-toggles">
        <button class="analytics-chart-toggle ${chartSeriesState.income ? 'active' : ''}" data-series="income">
          <span class="analytics-chart-legend-dot revenue"></span>
          Income
        </button>
        <button class="analytics-chart-toggle ${chartSeriesState.profit ? 'active' : ''}" data-series="profit">
          <span class="analytics-chart-legend-dot profit"></span>
          Profit
        </button>
        <button class="analytics-chart-toggle ${chartSeriesState.expenses ? 'active' : ''}" data-series="expenses">
          <span class="analytics-chart-legend-dot expenses"></span>
          Expenses
        </button>
        <button class="analytics-chart-toggle ${chartSeriesState.trips ? 'active' : ''}" data-series="trips">
          <span class="analytics-chart-legend-dot trips"></span>
          Trips
        </button>
      </div>
    </div>
  `;
  container.innerHTML = headerHtml;

  // Create chart container
  const chartDiv = document.createElement('div');
  chartDiv.style.height = '280px';
  chartDiv.style.width = '100%';
  container.appendChild(chartDiv);

  // Check which scales should be visible
  const hasMoneySeriesVisible = chartSeriesState.income || chartSeriesState.profit || chartSeriesState.expenses;
  const hasTripsVisible = chartSeriesState.trips;

  // Create chart with autoSize to handle dynamic width
  const chart = LightweightCharts.createChart(chartDiv, {
    autoSize: true,
    height: 280,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af',
      attributionLogo: false
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.1)' },
      horzLines: { color: 'rgba(255,255,255,0.1)' }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    },
    rightPriceScale: {
      visible: hasMoneySeriesVisible,
      borderColor: 'rgba(255,255,255,0.2)'
    },
    leftPriceScale: {
      visible: hasTripsVisible,
      borderColor: 'rgba(255,255,255,0.2)'
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.2)',
      timeVisible: true,
      secondsVisible: false,
      minBarSpacing: 0.0001
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    }
  });

  // Series references
  const series = {};

  // Income area (green) - with dollar formatting
  const incomeOptions = {
    lineColor: '#10b981',
    topColor: 'rgba(16, 185, 129, 0.3)',
    bottomColor: 'rgba(16, 185, 129, 0.0)',
    lineWidth: 2,
    lastValueVisible: true,
    priceLineVisible: false,
    visible: chartSeriesState.income,
    priceFormat: {
      type: 'custom',
      formatter: formatChartPrice
    }
  };
  if (typeof chart.addAreaSeries === 'function') {
    series.income = chart.addAreaSeries(incomeOptions);
  } else {
    series.income = chart.addSeries(LightweightCharts.AreaSeries, incomeOptions);
  }

  // Profit line (blue) - with dollar formatting
  const profitOptions = {
    color: '#3b82f6',
    lineWidth: 2,
    lastValueVisible: true,
    priceLineVisible: false,
    visible: chartSeriesState.profit,
    priceFormat: {
      type: 'custom',
      formatter: formatChartPrice
    }
  };
  if (typeof chart.addLineSeries === 'function') {
    series.profit = chart.addLineSeries(profitOptions);
  } else {
    series.profit = chart.addSeries(LightweightCharts.LineSeries, profitOptions);
  }

  // Expenses line (red) - with dollar formatting
  const expensesOptions = {
    color: '#ef4444',
    lineWidth: 2,
    lastValueVisible: true,
    priceLineVisible: false,
    visible: chartSeriesState.expenses,
    priceFormat: {
      type: 'custom',
      formatter: formatChartPrice
    }
  };
  if (typeof chart.addLineSeries === 'function') {
    series.expenses = chart.addLineSeries(expensesOptions);
  } else {
    series.expenses = chart.addSeries(LightweightCharts.LineSeries, expensesOptions);
  }

  // Trips line (yellow, on left scale) - plain number format
  const tripsOptions = {
    color: '#f59e0b',
    lineWidth: 2,
    lastValueVisible: true,
    priceLineVisible: false,
    priceScaleId: 'left',
    visible: chartSeriesState.trips,
    priceFormat: {
      type: 'custom',
      formatter: (value) => Math.round(value).toString()
    }
  };
  if (typeof chart.addLineSeries === 'function') {
    series.trips = chart.addLineSeries(tripsOptions);
  } else {
    series.trips = chart.addSeries(LightweightCharts.LineSeries, tripsOptions);
  }

  // Build data from dailyData (date strings like "2025-11-29")
  // LightweightCharts can use date strings directly in format YYYY-MM-DD
  const incomeData = dailyData.map(d => ({ time: d.date, value: d.income || 0 }));
  const expensesData = dailyData.map(d => ({ time: d.date, value: d.expenses || 0 }));
  const profitData = dailyData.map(d => ({ time: d.date, value: d.net || 0 }));
  const tripsData = dailyData.map(d => ({ time: d.date, value: d.trips || 0 }));

  // Set data on series
  series.income.setData(incomeData);
  series.profit.setData(profitData);
  series.expenses.setData(expensesData);
  series.trips.setData(tripsData);

  // Fit content
  chart.timeScale().fitContent();

  // Store chart reference for cleanup
  trendChart = { chart, container: chartDiv, series };

  // Add toggle button handlers
  container.querySelectorAll('.analytics-chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const seriesName = btn.dataset.series;
      chartSeriesState[seriesName] = !chartSeriesState[seriesName];
      btn.classList.toggle('active', chartSeriesState[seriesName]);

      if (series[seriesName]) {
        series[seriesName].applyOptions({ visible: chartSeriesState[seriesName] });
      }

      // Update scale visibility based on which series are active
      const hasMoneyVisible = chartSeriesState.income || chartSeriesState.profit || chartSeriesState.expenses;
      const hasTripsVisible = chartSeriesState.trips;

      // Use priceScale() method for dynamic updates
      chart.priceScale('right').applyOptions({ visible: hasMoneyVisible });
      chart.priceScale('left').applyOptions({ visible: hasTripsVisible });
    });
  });
}

/**
 * Destroy trend chart
 */
function destroyChart() {
  if (trendChart) {
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
 * Load game transaction data from lookup store
 * Note: Index building is now handled at modal level by checkAndBuildIndex()
 */
async function loadGameLogData() {
  try {
    // Fetch totals, breakdown, daily, and info in parallel from lookup store
    const [totalsRes, breakdownRes, dailyRes, info] = await Promise.all([
      getLookupTotals(currentDays),
      getLookupBreakdown(currentDays),
      getLookupDaily(currentDays),
      getLookupInfo()
    ]);

    // Extract data from response wrappers
    const totals = totalsRes;
    const breakdown = breakdownRes.breakdown;
    const daily = dailyRes.daily;

    // Store data for export
    lookupData = { info, totals, breakdown, daily };

    renderGameLogInfo(info);
    renderGameLogDailyTable(daily);
    renderGameLogTable(breakdown);
    renderGameLogChart(analyticsData?.summary?.chartEntries);

    // Also load raw transactions for lazy loading table
    loadRawTransactions(true);
    updateRawSortIndicators();
  } catch (error) {
    console.error('[Analytics] Failed to load game log data:', error);
    showNotification('Failed to load game transaction data', 'error');
  }
}

/**
 * Render game log info (metadata from lookup store)
 * @param {Object} info - Store info
 */
function renderGameLogInfo(info) {
  const totalEl = document.getElementById('game-log-total');
  const spanEl = document.getElementById('game-log-span');
  const syncEl = document.getElementById('game-log-sync');

  if (totalEl) {
    // Always show total entries regardless of filter
    totalEl.textContent = formatNumber(info.totalEntries);
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

// Game Log chart instance
let gameLogChart = null;

/**
 * Render Game Log breakdown chart showing cumulative income/expenses by type
 * Uses individual transaction timestamps for zoom capability
 * @param {Array} chartEntries - Individual transactions with {time, value, context}
 */
function renderGameLogChart(chartEntries) {
  const container = document.getElementById('game-log-chart-container');
  if (!container) return;

  // Destroy existing chart
  if (gameLogChart) {
    gameLogChart.remove();
    gameLogChart = null;
  }

  if (!chartEntries || chartEntries.length === 0) {
    container.innerHTML = '<div class="no-data">No transaction data available</div>';
    return;
  }

  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="no-data">Chart library not loaded</div>';
    return;
  }

  // DEBUG: Log first few entries to see data structure
  console.log('[GameLogChart] First 3 entries:', JSON.stringify(chartEntries.slice(0, 3), null, 2));

  // Get all categories and their totals from chartEntries
  const categoryTotals = new Map();
  chartEntries.forEach(entry => {
    if (entry.context) {
      const current = categoryTotals.get(entry.context) || 0;
      categoryTotals.set(entry.context, current + Math.abs(entry.value));
    }
  });

  // Sort by absolute value and take top categories
  const sortedCategories = Array.from(categoryTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);

  // Map context names to readable labels (explicit overrides)
  const contextLabels = {
    vessels_departed: 'Departure',
    harbor_fee_on_depart: 'Harbor Fee',
    fuel_purchased: 'Fuel',
    co2_emission_quota: 'CO2',
    bulk_wear_maintenance: 'Repair',
    buy_vessel: 'Vessel Buy',
    marketing_campaign_activation: 'Marketing',
    route_fee_on_creating: 'Route Fee',
    anchor_points: 'Anchor',
    Vessel_build_Purchase: 'Vessel Build',
    bulk_vessel_major_service: 'Drydock',
    salary_payment: 'Salary',
    Sold_vessel_in_port: 'Vessel Sale',
    ad_video: 'Ad Bonus',
    hijacking: 'Ransom',
    guard_payment_on_depart: 'Guard Fee'
  };

  // Auto-format category names: "purchase_stock" -> "Purchase Stock"
  const formatCategoryLabel = (key) => {
    if (contextLabels[key]) return contextLabels[key];
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  };

  // Colors for series (enough for all types)
  const seriesColors = [
    '#10b981', // green - income
    '#ef4444', // red
    '#f59e0b', // yellow
    '#3b82f6', // blue
    '#8b5cf6', // purple
    '#ec4899', // pink
    '#14b8a6', // teal
    '#f97316', // orange
    '#06b6d4', // cyan
    '#a855f7', // violet
    '#84cc16', // lime
    '#e11d48', // rose
    '#0ea5e9', // sky
    '#d946ef', // fuchsia
    '#22c55e', // green
    '#eab308'  // yellow dark
  ];

  // Header only with title
  const headerHtml = `
    <div class="analytics-chart-header">
      <span class="analytics-chart-title">Daily Breakdown</span>
    </div>
  `;
  container.innerHTML = headerHtml;

  // Create chart container
  const chartDiv = document.createElement('div');
  chartDiv.style.height = '350px';
  chartDiv.style.width = '100%';
  container.appendChild(chartDiv);

  // Create chart with timestamp support and zoom enabled
  gameLogChart = LightweightCharts.createChart(chartDiv, {
    autoSize: true,
    height: 350,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af',
      attributionLogo: false
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
      timeVisible: true,
      secondsVisible: true,
      minBarSpacing: 0.0001
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    }
  });

  // Debug: Check what data we're receiving
  console.log('[GameLogChart] chartEntries sample:', chartEntries.slice(0, 3));
  console.log('[GameLogChart] sortedCategories:', sortedCategories);

  // Filter and sort entries by time for cumulative calculation
  const minTime = 1577836800; // 2020-01-01
  const maxTime = 1893456000; // 2030-01-01
  const sortedEntries = chartEntries
    .filter(e => e.time && e.time >= minTime && e.time <= maxTime && typeof e.value === 'number')
    .sort((a, b) => a.time - b.time);

  console.log('[GameLogChart] After filter:', sortedEntries.length, 'entries (was', chartEntries.length, ')');

  // Build daily aggregated data per context
  // Aggregate all transactions per day - show daily totals (not cumulative)
  const dailyByContext = {};
  sortedCategories.forEach(cat => {
    dailyByContext[cat] = { dataMap: new Map() };
  });

  sortedEntries.forEach(entry => {
    if (entry.context && dailyByContext[entry.context]) {
      // Convert timestamp to start of day (midnight UTC)
      const dayTimestamp = Math.floor(entry.time / 86400) * 86400;
      const currentValue = dailyByContext[entry.context].dataMap.get(dayTimestamp) || 0;
      dailyByContext[entry.context].dataMap.set(dayTimestamp, currentValue + Math.abs(entry.value));
    }
  });

  // Convert Maps to sorted arrays - daily totals, NOT cumulative
  sortedCategories.forEach(cat => {
    const dataMap = dailyByContext[cat].dataMap;
    dailyByContext[cat].data = Array.from(dataMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
  });

  const cumulativeByContext = dailyByContext;

  // Create series for each category (only those with data)
  const seriesMap = {};
  const categoriesWithData = sortedCategories.filter(cat => cumulativeByContext[cat].data.length > 0);

  categoriesWithData.forEach((cat, i) => {
    const lineOptions = {
      color: seriesColors[i % seriesColors.length],
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: 'custom',
        formatter: formatChartPrice
      }
    };

    if (typeof gameLogChart.addLineSeries === 'function') {
      seriesMap[cat] = gameLogChart.addLineSeries(lineOptions);
    } else {
      seriesMap[cat] = gameLogChart.addSeries(LightweightCharts.LineSeries, lineOptions);
    }

    seriesMap[cat].setData(cumulativeByContext[cat].data);
  });

  gameLogChart.timeScale().fitContent();

  // Add toggles UNDER the chart (only for categories with data)
  const togglesDiv = document.createElement('div');
  togglesDiv.className = 'analytics-chart-toggles';
  togglesDiv.innerHTML = categoriesWithData.map((cat, i) => `
    <button class="analytics-chart-toggle active" data-series="${cat}" style="border-color: ${seriesColors[i % seriesColors.length]}40;">
      <span class="analytics-chart-legend-dot" style="background: ${seriesColors[i % seriesColors.length]};"></span>
      ${formatCategoryLabel(cat)}
    </button>
  `).join('');
  container.appendChild(togglesDiv);

  // Toggle handlers
  togglesDiv.querySelectorAll('.analytics-chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const seriesName = btn.dataset.series;
      const isActive = btn.classList.toggle('active');
      if (seriesMap[seriesName]) {
        seriesMap[seriesName].applyOptions({ visible: isActive });
      }
    });
  });
}

/**
 * Populate type filter dropdown dynamically from breakdown data
 * @param {Object} breakdown - Breakdown object with type names
 */
function populateTypeFilter(breakdown) {
  const typeFilter = document.getElementById('game-log-type-filter');
  if (!typeFilter) return;

  // Get current selection to preserve it
  const currentValue = typeFilter.value;

  // Get unique types from breakdown
  const types = Object.values(breakdown).map(e => e.type).sort();

  // Build options HTML
  let optionsHtml = '<option value="">All</option>';
  for (const type of types) {
    optionsHtml += `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`;
  }

  typeFilter.innerHTML = optionsHtml;

  // Restore selection if still valid
  if (currentValue && types.includes(currentValue)) {
    typeFilter.value = currentValue;
  }
}

/**
 * Render game log table (Breakdown by Type from Lookup)
 * @param {Object} breakdown - Breakdown object from lookup
 */
function renderGameLogTable(breakdown) {
  const tbody = document.getElementById('game-log-tbody');
  if (!tbody) return;

  // Populate type filter dropdown
  populateTypeFilter(breakdown);

  const categoryValue = document.getElementById('game-log-category-filter')?.value || '';
  const typeValue = document.getElementById('game-log-type-filter')?.value || '';

  // Convert breakdown object to array
  let entries = Object.values(breakdown);

  // Filter by category (INCOME, EXPENSE)
  if (categoryValue) {
    entries = entries.filter(e => e.value === categoryValue);
  }

  // Filter by type (Departure, Repair, Fuel, etc.)
  if (typeValue) {
    entries = entries.filter(e => e.type === typeValue);
  }

  // Sort by absolute total amount
  entries.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="analytics-empty">No entries found</td></tr>';
    return;
  }

  // Calculate totals for percentage (separate for income and expense)
  const totalIncome = entries.filter(e => e.value === 'INCOME').reduce((sum, e) => sum + e.total, 0);
  const totalExpense = entries.filter(e => e.value === 'EXPENSE').reduce((sum, e) => sum + Math.abs(e.total), 0);

  tbody.innerHTML = entries.map(entry => {
    const amountClass = entry.value === 'INCOME' ? 'positive' : entry.value === 'EXPENSE' ? 'negative' : '';
    const categoryClass = entry.value === 'INFO' ? 'warning' : '';
    const amountStr = entry.total >= 0 ? '+' + formatCurrency(entry.total) : '-' + formatCurrency(Math.abs(entry.total));

    // Calculate percentage based on category
    let percent = 0;
    if (entry.value === 'INCOME' && totalIncome > 0) {
      percent = (entry.total / totalIncome) * 100;
    } else if (entry.value === 'EXPENSE' && totalExpense > 0) {
      percent = (Math.abs(entry.total) / totalExpense) * 100;
    }
    const percentStr = percent > 0 ? percent.toFixed(1) + '%' : '-';

    return `
      <tr>
        <td>${escapeHtml(entry.type)}</td>
        <td class="num">${formatNumber(entry.count)}</td>
        <td class="num ${amountClass}">${amountStr}</td>
        <td class="num">${percentStr}</td>
        <td class="${categoryClass}">${entry.value}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Render daily breakdown table
 * @param {Array} daily - Daily breakdown array from lookup
 */
function renderGameLogDailyTable(daily) {
  const tbody = document.getElementById('game-log-daily-tbody');
  if (!tbody) return;

  if (!daily || daily.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="analytics-empty">No daily data available</td></tr>';
    return;
  }

  tbody.innerHTML = daily.map(day => {
    const netClass = day.net >= 0 ? 'positive' : 'negative';
    const netStr = day.net >= 0 ? '+' + formatCurrency(day.net) : '-' + formatCurrency(Math.abs(day.net));

    // Format date nicely (e.g., "Dec 2, 2025")
    const dateObj = new Date(day.date + 'T00:00:00');
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    return `
      <tr>
        <td>${dateStr}</td>
        <td class="num positive">+${formatCurrency(day.income)}</td>
        <td class="num negative">-${formatCurrency(day.expenses)}</td>
        <td class="num ${netClass}">${netStr}</td>
        <td class="num">${formatNumber(day.count)}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Export analytics data in specified format - includes ALL available data
 * @param {string} format - Export format: 'json', 'csv', or 'txt'
 */
async function exportAnalyticsData(format = 'json') {
  if (!analyticsData) {
    showNotification('No analytics data to export', 'warning');
    return;
  }

  showNotification('Preparing export...', 'info');

  const date = new Date().toISOString().split('T')[0];
  let blob;
  let filename;

  // Fetch ALL lookup entries (raw POD4 data) for complete export
  let allLookupEntries = [];
  try {
    const entriesResult = await getLookupEntries({
      days: currentDays,
      limit: 100000,
      offset: 0
    });
    allLookupEntries = entriesResult?.entries || [];
  } catch (err) {
    console.warn('[Analytics Export] Could not fetch lookup entries:', err);
  }

  // Ensure we have vessels and routes data (lazy load if not loaded)
  let vessels = analyticsData.vessels;
  let routes = analyticsData.routes;

  if (!vessels) {
    try {
      const result = await getAnalyticsVessels(currentDays);
      vessels = result?.vessels || [];
    } catch (err) {
      console.warn('[Analytics Export] Could not fetch vessels:', err);
      vessels = [];
    }
  }

  if (!routes) {
    try {
      const result = await getAnalyticsRoutes(currentDays);
      routes = result?.routes || [];
    } catch (err) {
      console.warn('[Analytics Export] Could not fetch routes:', err);
      routes = [];
    }
  }

  if (format === 'json') {
    // JSON: Export EVERYTHING
    const exportData = {
      exportDate: new Date().toISOString(),
      period: `${currentDays} days`,
      periodDays: currentDays,

      // Summary data
      summary: analyticsData.summary,
      detailedExpenses: analyticsData.detailedExpenses,
      dailyBreakdown: analyticsData.summary?.dailyBreakdown,

      // All vessel performance data
      vessels: vessels,

      // All route performance data
      routes: routes,

      // Game log aggregates
      gameLog: lookupData ? {
        info: lookupData.info,
        totals: lookupData.totals,
        breakdown: lookupData.breakdown
      } : null,

      // Raw lookup entries (POD4 - combined transaction data)
      rawEntries: allLookupEntries,

      // Metadata
      meta: {
        totalVessels: vessels?.length || 0,
        totalRoutes: routes?.length || 0,
        totalRawEntries: allLookupEntries.length,
        exportVersion: '2.0'
      }
    };

    blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    filename = `analytics-export-${date}.json`;

  } else if (format === 'csv') {
    const lines = [];

    // Summary section
    lines.push('=== SUMMARY ===');
    lines.push('Metric,Value');
    if (analyticsData.summary) {
      const s = analyticsData.summary;
      lines.push(`Total Income,${s.income?.total || 0}`);
      lines.push(`Total Expenses,${s.expenses?.total || 0}`);
      lines.push(`Net Profit,${s.profit?.net || 0}`);
      lines.push(`Profit Margin %,${s.profit?.margin?.toFixed(1) || 0}`);
    }
    lines.push('');

    // Vessels section - ALL vessels
    lines.push('=== VESSELS ===');
    lines.push('Name,VesselID,Trips,Revenue,Expenses,Contribution,Avg/Trip,Avg/h,Avg/nm,Utilization %,Primary Route');
    if (vessels && vessels.length > 0) {
      vessels.forEach(v => {
        const name = (v.name || '').replace(/"/g, '""');
        const route = (v.primaryRoute || '').replace(/"/g, '""');
        lines.push(`"${name}",${v.vesselId || ''},${v.trips || 0},${v.totalRevenue || 0},${v.totalExpenses || 0},${v.totalContribution || 0},${Math.round(v.avgRevenuePerTrip || 0)},${Math.round(v.avgRevenuePerHour || 0)},${Math.round(v.avgRevenuePerNm || 0)},${(v.avgUtilization || 0).toFixed(1)},"${route}"`);
      });
    }
    lines.push('');

    // Routes section - ALL routes
    lines.push('=== ROUTES ===');
    lines.push('Route,Origin,Destination,Vessels,Trips,Revenue,Expenses,Contribution,Avg/Trip,$/nm,Distance,Hijack Risk %,Incidents,Total Ransom,Harbor Fee %');
    if (routes && routes.length > 0) {
      routes.forEach(r => {
        const displayRoute = (r.displayRoute || r.route || '').replace(/"/g, '""');
        const hijackRisk = r.hijackingRisk !== null && r.hijackingRisk !== undefined ? r.hijackingRisk : '';
        const incidents = r.ransomIncidents !== null && r.ransomIncidents !== undefined ? r.ransomIncidents : '';
        const totalRansom = r.totalRansomPaid !== null && r.totalRansomPaid !== undefined ? r.totalRansomPaid : '';
        lines.push(`"${displayRoute}",${r.origin || ''},${r.destination || ''},${r.vesselCount || 0},${r.trips || 0},${r.totalRevenue || 0},${r.totalExpenses || 0},${r.totalContribution || 0},${Math.round(r.avgRevenuePerTrip || 0)},${Math.round(r.avgIncomePerNm || 0)},${r.distance || ''},${hijackRisk},${incidents},${totalRansom},${(r.harborFeePercent || 0).toFixed(1)}`);
      });
    }
    lines.push('');

    // Game Log Breakdown
    if (lookupData?.breakdown && lookupData.breakdown.length > 0) {
      lines.push('=== GAME LOG BREAKDOWN ===');
      lines.push('Type,Category,Count,Total');
      lookupData.breakdown.forEach(b => {
        const type = (b.type || '').replace(/"/g, '""');
        lines.push(`"${type}",${b.value || ''},${b.count || 0},${b.total || 0}`);
      });
      lines.push('');
    }

    // Raw Entries - ALL lookup entries
    if (allLookupEntries.length > 0) {
      lines.push('=== RAW ENTRIES ===');
      lines.push('ID,Timestamp,Date,Type,Category,Cash,Description,VesselName,VesselID,Origin,Destination,Context');
      allLookupEntries.forEach(e => {
        const desc = (e.description || '').replace(/"/g, '""');
        const vesselName = (e.vessel_name || '').replace(/"/g, '""');
        const context = (e.context || '').replace(/"/g, '""');
        const dateStr = e.timestamp ? new Date(e.timestamp * 1000).toISOString() : '';
        lines.push(`"${e.id || ''}",${e.timestamp || ''},"${dateStr}","${e.type || ''}",${e.value || ''},${e.cash || 0},"${desc}","${vesselName}",${e.vessel_id || ''},${e.origin || ''},${e.destination || ''},"${context}"`);
      });
    }

    blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    filename = `analytics-export-${date}.csv`;

  } else if (format === 'txt') {
    const lines = [];
    lines.push(`Analytics Export - ${date}`);
    lines.push(`Period: ${currentDays === 0 ? 'All Time' : currentDays + ' days'}`);
    lines.push('');

    // Summary
    lines.push('================================================================================');
    lines.push('SUMMARY');
    lines.push('================================================================================');
    if (analyticsData.summary) {
      const s = analyticsData.summary;
      lines.push(`Total Income:    $${formatNumber(s.income?.total || 0)}`);
      lines.push(`Total Expenses:  $${formatNumber(s.expenses?.total || 0)}`);
      lines.push(`Net Profit:      $${formatNumber(s.profit?.net || 0)}`);
      lines.push(`Profit Margin:   ${(s.profit?.margin || 0).toFixed(1)}%`);
    }
    lines.push('');

    // Detailed Expenses
    if (analyticsData.detailedExpenses && Object.keys(analyticsData.detailedExpenses).length > 0) {
      lines.push('--------------------------------------------------------------------------------');
      lines.push('EXPENSE BREAKDOWN');
      lines.push('--------------------------------------------------------------------------------');
      for (const [category, data] of Object.entries(analyticsData.detailedExpenses)) {
        // Skip grandTotal and netVesselCost as they're shown separately
        if (category === 'grandTotal' || category === 'netVesselCost') continue;
        // Handle both object format { total: X, count: Y } and plain numbers
        const amount = typeof data === 'object' ? (data.total || 0) : data;
        if (amount !== 0) {
          lines.push(`  ${category}: $${formatNumber(Math.abs(amount))} (${typeof data === 'object' && data.count ? data.count + ' entries' : ''})`);
        }
      }
      // Show grand total if available
      if (analyticsData.detailedExpenses.grandTotal) {
        lines.push(`  --- Grand Total: $${formatNumber(analyticsData.detailedExpenses.grandTotal)}`);
      }
      lines.push('');
    }

    // Game Log Breakdown
    if (lookupData?.breakdown && lookupData.breakdown.length > 0) {
      lines.push('--------------------------------------------------------------------------------');
      lines.push('GAME LOG BY TYPE');
      lines.push('--------------------------------------------------------------------------------');
      lookupData.breakdown.forEach(b => {
        const sign = b.total >= 0 ? '+' : '';
        lines.push(`  ${b.type} (${b.value}): ${b.count} entries, ${sign}$${formatNumber(b.total)}`);
      });
      lines.push('');
    }

    // ALL Vessels
    lines.push('================================================================================');
    lines.push(`VESSELS (${vessels?.length || 0} total)`);
    lines.push('================================================================================');
    if (vessels && vessels.length > 0) {
      vessels.forEach((v, i) => {
        const contribution = v.totalContribution >= 0 ? `+$${formatNumber(v.totalContribution)}` : `-$${formatNumber(Math.abs(v.totalContribution))}`;
        lines.push(`${String(i + 1).padStart(3)}. ${v.name}`);
        lines.push(`     Trips: ${v.trips}, Revenue: $${formatNumber(v.totalRevenue)}, Contribution: ${contribution}`);
        lines.push(`     Avg/Trip: $${formatNumber(Math.round(v.avgRevenuePerTrip || 0))}, Avg/h: $${formatNumber(Math.round(v.avgRevenuePerHour || 0))}, Avg/nm: $${formatNumber(Math.round(v.avgRevenuePerNm || 0))}`);
        lines.push(`     Utilization: ${(v.avgUtilization || 0).toFixed(1)}%`);
        if (v.primaryRoute) {
          lines.push(`     Primary Route: ${v.primaryRoute}`);
        }
      });
    } else {
      lines.push('  No vessel data available');
    }
    lines.push('');

    // ALL Routes
    lines.push('================================================================================');
    lines.push(`ROUTES (${routes?.length || 0} total)`);
    lines.push('================================================================================');
    if (routes && routes.length > 0) {
      routes.forEach((r, i) => {
        const contribution = r.totalContribution >= 0 ? `+$${formatNumber(r.totalContribution)}` : `-$${formatNumber(Math.abs(r.totalContribution))}`;
        lines.push(`${String(i + 1).padStart(3)}. ${r.displayRoute || r.route}`);
        lines.push(`     Vessels: ${r.vesselCount}, Trips: ${r.trips}, Revenue: $${formatNumber(r.totalRevenue)}`);
        lines.push(`     Contribution: ${contribution}, $/nm: $${Math.round(r.avgIncomePerNm || 0)}`);
        if (r.hijackingRisk !== null && r.hijackingRisk !== undefined) {
          let hijackInfo = `     Hijack Risk: ${r.hijackingRisk}%`;
          if (r.ransomIncidents) {
            hijackInfo += `, Incidents: ${r.ransomIncidents}, Total Ransom: $${formatNumber(r.totalRansomPaid || 0)}`;
          }
          lines.push(hijackInfo);
        }
      });
    } else {
      lines.push('  No route data available');
    }
    lines.push('');

    // Raw entries summary
    lines.push('================================================================================');
    lines.push(`RAW ENTRIES (${allLookupEntries.length} total)`);
    lines.push('================================================================================');
    if (allLookupEntries.length > 0) {
      // Group by type for summary
      const byType = {};
      allLookupEntries.forEach(e => {
        const key = e.type || 'Unknown';
        if (!byType[key]) {
          byType[key] = { count: 0, total: 0 };
        }
        byType[key].count++;
        byType[key].total += e.cash || 0;
      });
      for (const [type, data] of Object.entries(byType).sort((a, b) => b[1].count - a[1].count)) {
        const sign = data.total >= 0 ? '+' : '';
        lines.push(`  ${type}: ${data.count} entries, ${sign}$${formatNumber(data.total)}`);
      }
      lines.push('');
      lines.push('(Full raw entries included in JSON/CSV export)');
    } else {
      lines.push('  No raw entry data available');
    }

    blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    filename = `analytics-export-${date}.txt`;
  }

  // Download file
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const counts = `${vessels?.length || 0} vessels, ${routes?.length || 0} routes, ${allLookupEntries.length} entries`;
  showNotification(`Exported ${format.toUpperCase()}: ${counts}`, 'success');
}

// ============================================
// Raw Transaction Lazy Loading Functions
// ============================================

/**
 * Load raw transactions (lookup entries) with pagination
 * @param {boolean} reset - If true, reset offset and clear existing data
 */
async function loadRawTransactions(reset = true) {
  if (rawTransactionState.loading) return;

  rawTransactionState.loading = true;

  if (reset) {
    rawTransactionState.offset = 0;
    rawTransactionState.transactions = [];
    rawTransactionState.allFilteredTransactions = [];
  }

  const categoryValue = document.getElementById('game-log-category-filter')?.value || '';
  const typeValue = document.getElementById('game-log-type-filter')?.value || '';
  const hasFilter = categoryValue || typeValue;

  try {
    // When filter is active, load ALL entries to filter properly
    // Otherwise use pagination for performance
    const result = await getLookupEntries({
      days: currentDays,
      limit: hasFilter ? 50000 : rawTransactionState.limit,
      offset: hasFilter ? 0 : rawTransactionState.offset
    });

    // Handle missing or malformed response
    let entries = result?.entries || [];
    let total = result?.total || 0;

    // Filter by category (INCOME/EXPENSE) if selected
    if (categoryValue) {
      entries = entries.filter(e => e.value === categoryValue);
    }

    // Filter by type (Departure, Repair, Fuel, etc.) if selected
    if (typeValue) {
      entries = entries.filter(e => e.type === typeValue);
    }

    // Sort entries
    entries.sort((a, b) => {
      let cmp = 0;
      if (rawTransactionState.sortBy === 'time') {
        cmp = a.timestamp - b.timestamp;
      } else if (rawTransactionState.sortBy === 'type') {
        cmp = (a.type || '').localeCompare(b.type || '');
      } else if (rawTransactionState.sortBy === 'cash') {
        cmp = a.cash - b.cash;
      }
      return rawTransactionState.sortDir === 'desc' ? -cmp : cmp;
    });

    if (hasFilter) {
      // When filtering, store all filtered entries and paginate client-side
      rawTransactionState.allFilteredTransactions = entries;
      rawTransactionState.total = entries.length;
      // Show first batch
      rawTransactionState.transactions = entries.slice(0, rawTransactionState.limit);
      rawTransactionState.offset = rawTransactionState.transactions.length;
    } else {
      if (reset) {
        rawTransactionState.transactions = entries;
      } else {
        rawTransactionState.transactions = [...rawTransactionState.transactions, ...entries];
      }
      rawTransactionState.total = total;
      rawTransactionState.offset += entries.length;
    }

    const hasMore = rawTransactionState.offset < rawTransactionState.total;

    renderRawTransactionsTable();
    updateRawTransactionCounts();
    updateLoadMoreButton(hasMore);

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
  const categoryValue = document.getElementById('game-log-category-filter')?.value || '';
  const typeValue = document.getElementById('game-log-type-filter')?.value || '';
  const hasFilter = categoryValue || typeValue;

  if (hasFilter && rawTransactionState.allFilteredTransactions.length > 0) {
    // Client-side pagination for filtered data
    const nextBatch = rawTransactionState.allFilteredTransactions.slice(
      rawTransactionState.offset,
      rawTransactionState.offset + rawTransactionState.limit
    );
    rawTransactionState.transactions = [...rawTransactionState.transactions, ...nextBatch];
    rawTransactionState.offset += nextBatch.length;

    const hasMore = rawTransactionState.offset < rawTransactionState.total;
    renderRawTransactionsTable();
    updateRawTransactionCounts();
    updateLoadMoreButton(hasMore);
  } else {
    // Server-side pagination for unfiltered data
    await loadRawTransactions(false);
  }
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
 * Render the raw transactions table body (from lookup entries)
 */
function renderRawTransactionsTable() {
  const tbody = document.getElementById('game-log-raw-tbody');
  if (!tbody) return;

  if (rawTransactionState.transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="analytics-empty">No entries found</td></tr>';
    return;
  }

  tbody.innerHTML = rawTransactionState.transactions.map(entry => {
    const date = new Date(entry.timestamp);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const amountClass = entry.value === 'INCOME' ? 'positive' : entry.value === 'EXPENSE' ? 'negative' : '';
    const amountStr = entry.cash >= 0 ? '+' + formatCurrency(entry.cash) : '-' + formatCurrency(Math.abs(entry.cash));
    const categoryClass = entry.value === 'INFO' ? 'warning' : '';

    return `
      <tr class="clickable-row" data-lookup-id="${escapeHtml(entry.id)}">
        <td>${escapeHtml(dateStr)}</td>
        <td>${escapeHtml(entry.type)}</td>
        <td class="num ${amountClass}">${amountStr}</td>
        <td class="${categoryClass}">${entry.value}</td>
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

/**
 * Build POD2 HTML based on entry type - shows ALL relevant details
 * @param {Object} pod2 - POD2 audit log entry
 * @param {Object} lookup - Lookup entry with pod2_vessel
 * @param {Function} formatTs - Timestamp formatter
 * @param {Function} formatName - Name formatter (underscore to title case)
 * @param {Function} formatCash - Cash formatter with proper sign
 * @returns {string} HTML string
 */
function buildPod2Html(pod2, lookup, formatTs, formatName, formatCash) {
  const details = pod2.details || {};
  const autopilot = pod2.autopilot || '';
  let html = `<div class="lookup-pod-row"><span class="lookup-pod-label">Time:</span> ${formatTs(pod2.timestamp)}</div>`;
  html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Action:</span> ${escapeHtml(autopilot)}</div>`;

  // Departure entries - use pod2_vessel for matched vessel details
  if (autopilot === 'Auto-Depart' || autopilot === 'Manual Depart') {
    const vessel = lookup.pod2_vessel;
    if (vessel) {
      const gross = vessel.income + Math.abs(vessel.harborFee);
      // Detect vessel type by rates (cargo can be 0 for both types)
      const isTanker = vessel.fuelRate !== undefined || vessel.crudeRate !== undefined;

      html += `
        <div class="lookup-pod-row"><span class="lookup-pod-label">Vessel ID:</span> ${vessel.vesselId}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Name:</span> ${escapeHtml(vessel.name)}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Route:</span> ${formatName(vessel.origin)} - ${formatName(vessel.destination)}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Route Name:</span> ${escapeHtml(vessel.routeName || '-')}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Utilization:</span> ${(vessel.utilization * 100).toFixed(1)}%</div>
      `;

      if (isTanker) {
        // Tanker vessel - show fuel/crude cargo in bbl
        const cargoTotal = vessel.fuelCargo + vessel.crudeCargo;
        html += `
          <div class="lookup-pod-row"><span class="lookup-pod-label">Capacity:</span> ${formatNumber(vessel.capacity)} bbl</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Cargo Total:</span> ${formatNumber(cargoTotal)} bbl</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Cargo Fuel:</span> ${formatNumber(vessel.fuelCargo)} bbl</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Cargo Crude:</span> ${formatNumber(vessel.crudeCargo)} bbl</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Fuel Rate:</span> $${formatNumber(vessel.fuelRate)}</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Crude Rate:</span> $${formatNumber(vessel.crudeRate)}</div>
        `;
      } else {
        // Container vessel - show dry/refrigerated cargo in TEU
        const cargoTotal = vessel.teuDry + vessel.teuRefrigerated;
        html += `
          <div class="lookup-pod-row"><span class="lookup-pod-label">Capacity:</span> ${formatNumber(vessel.capacity)} TEU</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Cargo Total:</span> ${formatNumber(cargoTotal)} TEU</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Cargo Dry:</span> ${formatNumber(vessel.teuDry)} TEU</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Cargo Ref:</span> ${formatNumber(vessel.teuRefrigerated)} TEU</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Dry Rate:</span> $${formatNumber(vessel.dryRate)}</div>
          <div class="lookup-pod-row"><span class="lookup-pod-label">Ref Rate:</span> $${formatNumber(vessel.refRate)}</div>
        `;
      }

      html += `
        <div class="lookup-pod-row"><span class="lookup-pod-label">Speed:</span> ${vessel.speed} kn</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Guards:</span> ${vessel.guards}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Fuel Used:</span> ${formatNumber(vessel.fuelUsed)} t</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">CO2 Used:</span> ${formatNumber(vessel.co2Used)} t</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Contribution:</span> +${vessel.contributionGained}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Income:</span> ${formatCurrency(vessel.income, true)}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Harbor Fee:</span> -${formatCurrency(Math.abs(vessel.harborFee), true).replace('+', '')}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Gross:</span> ${formatCurrency(gross, true)}</div>
      `;
    }
    return html;
  }

  // Repair entries - show repairedVessels
  if (autopilot === 'Auto-Repair' || autopilot === 'Manual Bulk Repair') {
    const vessels = details.repairedVessels || [];
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    for (const v of vessels) {
      html += `
        <div class="lookup-pod-row"><span class="lookup-pod-label">Vessel ID:</span> ${v.id}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Name:</span> ${escapeHtml(v.name)}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Wear:</span> ${v.wear}%</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Cost:</span> ${formatCash(-v.cost)}</div>
      `;
    }
    return html;
  }

  // Drydock entries - show servicedVessels
  if (autopilot === 'Auto-Drydock' || autopilot === 'Manual Bulk Drydock') {
    const vessels = details.servicedVessels || [];
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    for (const v of vessels) {
      html += `
        <div class="lookup-pod-row"><span class="lookup-pod-label">Vessel ID:</span> ${v.id}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Name:</span> ${escapeHtml(v.name)}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Service:</span> ${escapeHtml(v.serviceType || 'Major')}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Cost:</span> ${formatCash(-v.cost)}</div>
      `;
    }
    return html;
  }

  // Fuel purchase
  if (autopilot === 'Auto-Fuel' || autopilot === 'Manual Fuel Purchase') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.amount) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Amount:</span> ${formatNumber(details.amount)} t</div>`;
    if (details.price) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Price:</span> $${formatNumber(details.price)}/t</div>`;
    if (details.totalCost) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Total Cost:</span> ${formatCash(-details.totalCost)}</div>`;
    if (details.port) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Port:</span> ${formatName(details.port)}</div>`;
    return html;
  }

  // CO2 purchase
  if (autopilot === 'Auto-CO2' || autopilot === 'Manual CO2 Purchase') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.amount) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Amount:</span> ${formatNumber(details.amount)} t</div>`;
    if (details.price) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Price:</span> $${formatNumber(details.price)}/t</div>`;
    if (details.totalCost) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Total Cost:</span> ${formatCash(-details.totalCost)}</div>`;
    return html;
  }

  // Campaign/Marketing
  if (autopilot === 'Auto-Campaign' || autopilot === 'Campaign Activation') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.campaignName) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Campaign:</span> ${escapeHtml(details.campaignName)}</div>`;
    if (details.cost) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Cost:</span> ${formatCash(-details.cost)}</div>`;
    return html;
  }

  // Anchor purchase
  if (autopilot === 'Auto-Anchor' || autopilot === 'Manual Anchor Purchase') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.amount) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Amount:</span> ${formatNumber(details.amount)}</div>`;
    if (details.cost) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Cost:</span> ${formatCash(-details.cost)}</div>`;
    return html;
  }

  // Vessel purchase/sale
  if (autopilot === 'Manual Vessel Purchase' || autopilot === 'Manual Vessel Sale') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.vessel_count) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Vessels:</span> ${details.vessel_count}</div>`;
    if (details.total_cost) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Total Cost:</span> ${formatCash(-details.total_cost)}</div>`;
    if (details.total_price) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Total Price:</span> ${formatCash(details.total_price)}</div>`;
    if (details.vessels && Array.isArray(details.vessels)) {
      details.vessels.forEach(v => {
        html += `<div class="lookup-pod-row"><span class="lookup-pod-label">${v.quantity}x ${escapeHtml(v.name)}:</span> ${formatCash(autopilot === 'Manual Vessel Sale' ? v.total_price : -v.total_price)}</div>`;
      });
    }
    return html;
  }

  // Vessel build
  if (autopilot === 'Manual Vessel Build') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.name) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Name:</span> ${escapeHtml(details.name)}</div>`;
    if (details.vessel_model) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Model:</span> ${formatName(details.vessel_model)}</div>`;
    if (details.capacity) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Capacity:</span> ${formatNumber(details.capacity)} ${details.vessel_model === 'container' ? 'TEU' : 'BBL'}</div>`;
    if (details.engine_type) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Engine:</span> ${formatName(details.engine_type)}</div>`;
    if (details.engine_kw) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Engine Power:</span> ${formatNumber(details.engine_kw)} kW</div>`;
    if (details.ship_yard) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Shipyard:</span> ${formatName(details.ship_yard)}</div>`;
    if (details.antifouling_model) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Antifouling:</span> ${formatName(details.antifouling_model)}</div>`;
    if (details.antifouling_model === null) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Antifouling:</span> None</div>`;
    if (details.bulbous !== undefined) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Bulbous Bow:</span> ${details.bulbous ? 'Yes' : 'No'}</div>`;
    if (details.enhanced_thrusters !== undefined) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Enhanced Thrusters:</span> ${details.enhanced_thrusters ? 'Yes' : 'No'}</div>`;
    if (details.propeller_types) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Propeller:</span> ${formatName(details.propeller_types)}</div>`;
    if (details.range) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Range:</span> ${formatNumber(details.range)} nm</div>`;
    if (details.build_cost) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Build Cost:</span> ${formatCash(-details.build_cost)}</div>`;
    return html;
  }

  // Stock purchase/sale
  if (autopilot === 'Manual Stock Purchase' || autopilot === 'Manual Stock Sale') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.stockName) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Stock:</span> ${escapeHtml(details.stockName)}</div>`;
    if (details.amount) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Amount:</span> ${formatNumber(details.amount)}</div>`;
    if (details.price) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Price:</span> ${formatCash(details.price)}</div>`;
    return html;
  }

  // Hijacking/Ransom
  if (autopilot === 'Auto-Blackbeard' || autopilot === 'Manual Ransom' || autopilot === 'Manual Pay Ransom') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.vesselName) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Vessel:</span> ${escapeHtml(details.vesselName)}</div>`;
    if (details.case_id) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Case ID:</span> ${details.case_id}</div>`;
    if (details.caseId) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Case ID:</span> ${details.caseId}</div>`;
    if (details.initialDemand) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Initial Demand:</span> ${formatCash(-details.initialDemand)}</div>`;
    if (details.expected_amount) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Expected:</span> ${formatCash(-details.expected_amount)}</div>`;
    if (details.finalPayment) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Final Payment:</span> ${formatCash(-details.finalPayment)}</div>`;
    if (details.amount_paid) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Amount Paid:</span> ${formatCash(-details.amount_paid)}</div>`;
    if (details.negotiationRounds) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Rounds:</span> ${details.negotiationRounds}</div>`;
    if (details.payment_verified !== undefined) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Verified:</span> ${details.payment_verified ? 'Yes' : 'No'}</div>`;
    return html;
  }

  // Route Planner
  if (autopilot === 'Manual Route Planner') {
    html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
    if (details.vessel_name) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Vessel:</span> ${escapeHtml(details.vessel_name)}</div>`;
    if (details.vessel_id) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Vessel ID:</span> ${details.vessel_id}</div>`;
    if (details.route_origin) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Origin:</span> ${formatName(details.route_origin)}</div>`;
    if (details.route_destination) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Destination:</span> ${formatName(details.route_destination)}</div>`;
    if (details.route_distance) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Distance:</span> ${formatNumber(details.route_distance)} nm</div>`;
    if (details.route_speed) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Speed:</span> ${details.route_speed} kn</div>`;
    if (details.route_guards) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Guards:</span> ${details.route_guards}</div>`;
    if (details.route_fee) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Route Fee:</span> ${formatCash(-details.route_fee)}</div>`;
    if (details.channel_cost) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Channel Cost:</span> ${formatCash(-details.channel_cost)}</div>`;
    if (details.total_fee) html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Total Fee:</span> ${formatCash(-details.total_fee)}</div>`;
    return html;
  }

  // Fallback: show summary and all details as key-value pairs
  html += `<div class="lookup-pod-row"><span class="lookup-pod-label">Summary:</span> ${escapeHtml(pod2.summary || '')}</div>`;
  for (const [key, value] of Object.entries(details)) {
    if (value !== null && value !== undefined && !Array.isArray(value) && typeof value !== 'object') {
      html += `<div class="lookup-pod-row"><span class="lookup-pod-label">${formatName(key)}:</span> ${escapeHtml(String(value))}</div>`;
    }
  }
  return html;
}

/**
 * Show details for a lookup entry from all PODs
 * @param {string} lookupId - Lookup entry ID
 */
async function showLookupEntryDetails(lookupId) {
  try {
    const details = await getLookupDetails(lookupId);
    if (!details) {
      showNotification('Entry not found', 'error');
      return;
    }

    const { lookup, pod1, pod2, pod3 } = details;

    // Format timestamp helper
    const formatTs = (ts) => {
      if (!ts) return '-';
      const d = new Date(ts);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    };

    // Helper to format underscore names (harbor_fee_on_depart -> Harbor Fee On Depart)
    const formatName = (name) => {
      if (!name) return '-';
      return toGameCode(name);
    };

    // Helper to format cash with proper sign placement (-$69.5K not $-69.5K)
    const formatCash = (amount) => {
      if (amount >= 0) {
        return formatCurrency(amount, true);
      }
      return `-${formatCurrency(Math.abs(amount), true).replace('+', '')}`;
    };

    // Build POD sections
    let pod1Html = '<div class="lookup-pod-empty">No game transaction data</div>';
    if (pod1) {
      let extraInfo = '';
      // Guard Fee: calculate number of guards ($1000 per guard)
      if (pod1.context === 'guard_payment_on_depart') {
        const guards = Math.abs(pod1.cash) / 1000;
        extraInfo = `<div class="lookup-pod-row"><span class="lookup-pod-label">Guards:</span> ${guards}</div>`;
      }
      pod1Html = `
        <div class="lookup-pod-row"><span class="lookup-pod-label">Time:</span> ${formatTs(pod1.time * 1000)}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Context:</span> ${formatName(pod1.context)}</div>
        ${extraInfo}
        <div class="lookup-pod-row"><span class="lookup-pod-label">Gross:</span> ${formatCash(pod1.cash)}</div>
      `;
    }

    let pod2Html = '<div class="lookup-pod-empty">No audit log match</div>';
    if (pod2) {
      pod2Html = buildPod2Html(pod2, lookup, formatTs, formatName, formatCash);
    } else if (details.messengerFallback && lookup.context === 'hijacking') {
      // Fallback for hijacking: show vessel info from messenger
      const mf = details.messengerFallback;
      pod2Html = `
        <div class="lookup-pod-row"><span class="lookup-pod-label">Source:</span> Messenger (no audit log)</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Vessel:</span> ${escapeHtml(mf.vessel_name)}</div>
        <div class="lookup-pod-row"><span class="lookup-pod-label">Case ID:</span> ${mf.case_id}</div>
      `;
    }

    // POD3 (Vessel History) only relevant for departure-related contexts
    const hasPod3 = ['vessels_departed', 'harbor_fee_on_depart', 'guard_payment_on_depart'].includes(lookup.context);

    // POD2 (Audit Log) not relevant for game-only transactions
    const hasPod2 = !['ad_video', 'daily_bonus', 'salary_payment'].includes(lookup.context);
    let pod3Html = '';
    if (hasPod3) {
      if (pod3) {
        const vessel = lookup.pod3_vessel;
        if (vessel) {
          // Show matched vessel details from history (game API only has income, no harborFee)
          pod3Html = `
            <div class="lookup-pod-row"><span class="lookup-pod-label">Time:</span> ${formatTs(pod3.timestamp)}</div>
            <div class="lookup-pod-row"><span class="lookup-pod-label">Vessel:</span> ${escapeHtml(vessel.name)}</div>
            <div class="lookup-pod-row"><span class="lookup-pod-label">Route:</span> ${formatName(vessel.origin)} - ${formatName(vessel.destination)}</div>
            <div class="lookup-pod-row"><span class="lookup-pod-label">Income:</span> ${formatCurrency(vessel.income, true)}</div>
          `;
        } else {
          // Fallback to entry-level data
          pod3Html = `
            <div class="lookup-pod-row"><span class="lookup-pod-label">Time:</span> ${formatTs(pod3.timestamp)}</div>
            <div class="lookup-pod-row"><span class="lookup-pod-label">Vessel:</span> ${escapeHtml(pod3.vesselName || '-')}</div>
            <div class="lookup-pod-row"><span class="lookup-pod-label">Route:</span> ${formatName(pod3.origin)} - ${formatName(pod3.destination)}</div>
            <div class="lookup-pod-row"><span class="lookup-pod-label">Income:</span> ${formatCurrency(pod3.revenue, true)}</div>
          `;
        }
      } else {
        pod3Html = '<div class="lookup-pod-empty">No vessel history match</div>';
      }
    }

    // Build layout based on which PODs are relevant
    let podsHtml = '';
    if (hasPod3) {
      // Departure: POD1 + POD3 side by side, POD2 below
      podsHtml = `
        <div class="lookup-details-pods-row">
          <div class="lookup-pod-section">
            <h4>POD1: Game Transaction</h4>
            ${pod1Html}
          </div>
          <div class="lookup-pod-section">
            <h4>POD3: Vessel History</h4>
            ${pod3Html}
          </div>
        </div>
        <div class="lookup-details-pods-full">
          <div class="lookup-pod-section lookup-pod-section-wide">
            <h4>POD2: Audit Log</h4>
            <div class="lookup-pod-two-columns">
              ${pod2Html}
            </div>
          </div>
        </div>
      `;
    } else if (hasPod2) {
      // Has POD2 but no POD3: POD1 + POD2 side by side
      podsHtml = `
        <div class="lookup-details-pods-row">
          <div class="lookup-pod-section">
            <h4>POD1: Game Transaction</h4>
            ${pod1Html}
          </div>
          <div class="lookup-pod-section">
            <h4>POD2: Audit Log</h4>
            ${pod2Html}
          </div>
        </div>
      `;
    } else {
      // POD1 only (Ad Bonus, Daily Bonus)
      podsHtml = `
        <div class="lookup-details-pods-full">
          <div class="lookup-pod-section">
            <h4>POD1: Game Transaction</h4>
            ${pod1Html}
          </div>
        </div>
      `;
    }

    // Create modal content
    const modalHtml = `
      <div class="lookup-details-modal">
        <div class="messenger-header">
          <h2>Entry Details</h2>
          <button class="lookup-details-close close-btn"><span>&times;</span></button>
        </div>
        <div class="lookup-details-summary">
          <div class="lookup-summary-row"><span class="lookup-pod-label">Type:</span> ${escapeHtml(lookup.type)}</div>
          <div class="lookup-summary-row"><span class="lookup-pod-label">Category:</span> ${lookup.value}</div>
          <div class="lookup-summary-row"><span class="lookup-pod-label">Amount:</span> ${formatCash(lookup.cash)}</div>
          <div class="lookup-summary-row"><span class="lookup-pod-label">Time:</span> ${formatTs(lookup.timestamp)}</div>
        </div>
        ${podsHtml}
      </div>
    `;

    // Show modal
    let overlay = document.getElementById('lookup-details-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'lookup-details-overlay';
      overlay.className = 'lookup-details-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = modalHtml;
    overlay.classList.remove('hidden');

    // Close handlers
    overlay.querySelector('.lookup-details-close').addEventListener('click', () => {
      overlay.classList.add('hidden');
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.add('hidden');
      }
    });

  } catch (error) {
    console.error('[Analytics] Failed to load entry details:', error);
    showNotification('Failed to load entry details', 'error');
  }
}

/**
 * Show info tooltip for route vessels column
 * @param {HTMLElement} iconElement - The info icon element
 */
function showRouteVesselsInfoTooltip(iconElement) {
  // Remove existing tooltip if any
  const existingTooltip = document.querySelector('.route-info-tooltip');
  if (existingTooltip) {
    existingTooltip.remove();
    return; // Toggle off
  }

  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'route-info-tooltip';
  tooltip.innerHTML = `
    <div class="route-info-content">
      <div class="route-info-title">Route Table Legend</div>
      <div class="route-info-section">
        <div class="route-info-row"><span class="route-status active">&#x1F7E2;</span> <strong>Active Route</strong> - Vessels currently sailing this route</div>
        <div class="route-info-row"><span class="route-status inactive">&#x1F578;&#xFE0F;</span> <strong>Inactive Route</strong> - Historical route, no vessels currently assigned</div>
      </div>
      <div class="route-info-section">
        <div class="route-info-row"><strong>Vessels:</strong> Total unique vessels that have sailed this route</div>
        <div class="route-info-row"><strong>(n):</strong> Number of vessels currently active on this route</div>
      </div>
      <div class="route-info-hint">Click anywhere to close</div>
    </div>
  `;

  // Position tooltip below icon
  const rect = iconElement.getBoundingClientRect();
  const analyticsContent = document.querySelector('.analytics-content');
  const contentRect = analyticsContent ? analyticsContent.getBoundingClientRect() : { left: 0, top: 0 };

  tooltip.style.position = 'absolute';
  tooltip.style.left = (rect.left - contentRect.left - 100) + 'px';
  tooltip.style.top = (rect.bottom - contentRect.top + 8) + 'px';
  tooltip.style.zIndex = '1000';

  // Append to analytics content for proper positioning
  if (analyticsContent) {
    analyticsContent.appendChild(tooltip);
  } else {
    document.body.appendChild(tooltip);
  }

  // Close on click anywhere
  const closeHandler = (e) => {
    if (!tooltip.contains(e.target) || e.target.closest('.route-info-hint')) {
      tooltip.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  // Delay adding listener to prevent immediate close
  setTimeout(() => document.addEventListener('click', closeHandler), 10);
}

// ============================================
// API STATS TAB (develMode only)
// ============================================

/**
 * Add API Stats tab button dynamically when develMode is enabled
 */
function addApiStatsTab() {
  const tabsContainer = document.querySelector('.analytics-tabs');
  if (!tabsContainer) return;

  // Check if tab already exists
  if (document.querySelector('[data-tab="api-stats"]')) return;

  // Find the controls div and insert button before it
  const controlsDiv = tabsContainer.querySelector('.analytics-controls');

  const tabBtn = document.createElement('button');
  tabBtn.className = 'analytics-tab-btn';
  tabBtn.dataset.tab = 'api-stats';
  tabBtn.textContent = 'API Stats';

  if (controlsDiv) {
    tabsContainer.insertBefore(tabBtn, controlsDiv);
  } else {
    tabsContainer.appendChild(tabBtn);
  }

  // Add click handler
  tabBtn.addEventListener('click', () => {
    switchTab('api-stats');
  });

  // Setup API Stats controls
  setupApiStatsControls();
}

/**
 * Setup API Stats tab controls
 */
function setupApiStatsControls() {
  const hoursSelect = document.getElementById('apiStatsHoursSelect');
  const refreshBtn = document.getElementById('apiStatsRefreshBtn');

  if (hoursSelect) {
    hoursSelect.addEventListener('change', () => {
      loadApiStats();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadApiStats();
    });
  }
}

/**
 * Load API stats data
 */
async function loadApiStats() {
  const loadingEl = document.getElementById('apiStatsLoading');
  const contentEl = document.getElementById('apiStatsContent');
  const hoursSelect = document.getElementById('apiStatsHoursSelect');

  if (!loadingEl || !contentEl) return;

  const hours = hoursSelect ? parseFloat(hoursSelect.value) : 24;

  loadingEl.classList.remove('hidden');
  contentEl.classList.add('hidden');

  try {
    const [stats, datesInfo] = await Promise.all([
      getApiStats(hours),
      getApiStatsDates()
    ]);

    renderApiStatsSummary(stats, hours, datesInfo.dates);
    renderApiStatsChart(stats);
    renderApiStatsTable(stats);

    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
  } catch (error) {
    console.error('[Analytics] Error loading API stats:', error);
    loadingEl.innerHTML = '<div class="error">Failed to load API stats</div>';
  }
}

/**
 * Render API stats summary metrics
 */
function renderApiStatsSummary(stats, hours, dates) {
  const totalCallsEl = document.getElementById('apiStatsTotalCalls');
  const totalErrorsEl = document.getElementById('apiStatsTotalErrors');
  const callsPerHourEl = document.getElementById('apiStatsCallsPerHour');
  const availableDaysEl = document.getElementById('apiStatsAvailableDays');

  if (totalCallsEl) {
    totalCallsEl.textContent = formatNumber(stats.totalCalls);
  }
  if (totalErrorsEl) {
    totalErrorsEl.textContent = formatNumber(stats.totalErrors);
    totalErrorsEl.classList.toggle('negative', stats.totalErrors > 0);
  }
  if (callsPerHourEl) {
    const callsPerHour = hours > 0 ? Math.round(stats.totalCalls / hours) : 0;
    callsPerHourEl.textContent = formatNumber(callsPerHour);
  }
  if (availableDaysEl) {
    availableDaysEl.textContent = dates ? dates.length : 0;
  }
}

/**
 * Render API stats chart using LightweightCharts (minute-level data)
 */
function renderApiStatsChart(stats) {
  const container = document.getElementById('apiStatsChartContainer');
  if (!container) return;

  // Destroy previous chart if exists
  if (apiStatsChart) {
    apiStatsChart.remove();
    apiStatsChart = null;
  }

  // Clear container
  container.innerHTML = '';

  if (!stats || !stats.timeSeries || stats.timeSeries.length === 0) {
    container.innerHTML = '<div class="no-data">No data available</div>';
    return;
  }

  // Check if LightweightCharts is available
  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="no-data">Chart library not available</div>';
    return;
  }

  // Prepare data for chart - convert to Unix timestamps
  // minute format is "2025-12-05 01:30" (YYYY-MM-DD HH:mm)
  const data = stats.timeSeries.map(m => {
    // Parse "2025-12-05 01:30" -> "2025-12-05T01:30:00"
    const isoString = m.minute.replace(' ', 'T') + ':00';
    const date = new Date(isoString);
    return {
      time: Math.floor(date.getTime() / 1000),
      value: m.total
    };
  }).filter(d => !isNaN(d.time)).sort((a, b) => a.time - b.time);

  console.log('[API Stats] Chart data:', data.length, 'points', data.slice(0, 3));
  console.log('[API Stats] Container size:', container.offsetWidth, 'x', container.offsetHeight);

  // If container not visible yet, wait a bit
  if (container.offsetWidth === 0) {
    setTimeout(() => renderApiStatsChart(stats), 100);
    return;
  }

  // Create chart
  apiStatsChart = LightweightCharts.createChart(container, {
    height: 180,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af',
      attributionLogo: false
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.05)' }
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false
    },
    rightPriceScale: {
      borderVisible: false
    },
    handleScroll: true,
    handleScale: true
  });

  // Add line series (version-compatible)
  const lineOptions = {
    color: 'rgba(59, 130, 246, 1)',
    lineWidth: 2,
    priceFormat: {
      type: 'volume'
    }
  };

  let series;
  if (typeof apiStatsChart.addLineSeries === 'function') {
    series = apiStatsChart.addLineSeries(lineOptions);
  } else {
    series = apiStatsChart.addSeries(LightweightCharts.LineSeries, lineOptions);
  }

  series.setData(data);
  apiStatsChart.timeScale().fitContent();
}

/**
 * Render API stats endpoint table
 */
function renderApiStatsTable(stats) {
  const tbody = document.getElementById('apiStatsEndpointsTbody');
  if (!tbody) return;

  if (!stats.byEndpoint || Object.keys(stats.byEndpoint).length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="no-data">No endpoint data</td></tr>';
    return;
  }

  // Sort endpoints by call count descending
  const endpoints = Object.entries(stats.byEndpoint)
    .sort((a, b) => b[1].count - a[1].count);

  const totalCalls = stats.totalCalls;

  tbody.innerHTML = endpoints.map(([endpoint, data]) => {
    const percent = totalCalls > 0 ? ((data.count / totalCalls) * 100).toFixed(1) : 0;
    const errorClass = data.errors > 0 ? 'negative' : '';

    return `
      <tr>
        <td class="endpoint-name">${escapeHtml(endpoint)}</td>
        <td class="num">${formatNumber(data.count)}</td>
        <td class="num ${errorClass}">${data.errors}</td>
        <td class="num">${data.avgDuration}ms</td>
        <td class="num">${percent}%</td>
      </tr>
    `;
  }).join('');
}

// Expose functions to window for onclick handlers
window.analytics = window.analytics || {};
window.analytics.closeSoldVesselPanel = closeSoldVesselPanel;

// Export for global access
export { loadAnalyticsData };
