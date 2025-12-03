/**
 * @fileoverview Stock Manager Module
 *
 * Provides stock market functionality with TradingView charts including:
 * - My Portfolio: Own company stock with chart
 * - Market: Browse all listed companies
 * - Investments: Companies user has invested in
 * - Investors: Who holds user's stock
 *
 * Chart Features:
 * - Timeframe selection (1D, 1W, 1M, 3M, 1Y, ALL)
 * - Moving Averages (MA7, MA25, MA99)
 * - Line/Area chart toggle
 * - Price statistics (ATH, ATL, Change)
 *
 * @module stock-manager
 */

import { getStockFinanceOverview, getStockMarket, purchaseStock, getRecentIpos, increaseStockForSale, getStockPurchaseTimes } from './api.js';
import { showNotification, formatNumber } from './utils.js';
import { showPurchaseDialog } from './ui-dialogs.js';

// State
let currentChart = null;
let currentUserId = null;
let userHasIPO = false;
let financeData = null;

// Lazy loading state for market list
let marketState = {
  currentPage: 1,
  currentFilter: 'top',
  currentSearch: '',
  isLoading: false,
  hasMore: true,
  scrollContainer: null,
  scrollHandler: null
};

// Chart state
let chartState = {
  data: [],
  filteredData: [],
  timeframe: 'ALL',
  chartType: 'area',
  showMA7: false,
  showMA25: true,
  showMA99: false,
  maSeries: {}
};

// Chart color constants
export const CHART_COLORS = {
  up: '#10b981',
  down: '#ef4444',
  same: '#6b7280',
  ma7: '#fbbf24',
  ma25: '#3b82f6',
  ma99: '#a855f7'
};

// Global tooltip element
let globalTooltip = null;

/**
 * Initialize global tooltip system
 */
function initTooltipSystem() {
  if (globalTooltip) return;

  globalTooltip = document.createElement('div');
  globalTooltip.id = 'stockGlobalTooltip';
  globalTooltip.style.cssText = `
    position: fixed;
    padding: 4px 8px;
    background: var(--color-bg-primary);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-primary);
    white-space: nowrap;
    pointer-events: none;
    z-index: 999999;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.15s ease;
  `;
  document.body.appendChild(globalTooltip);
}

/**
 * Setup tooltip handlers for elements with data-tooltip
 */
function setupTooltips(container) {
  initTooltipSystem();

  const elements = container.querySelectorAll('[data-tooltip]');
  elements.forEach(el => {
    el.addEventListener('mouseenter', () => {
      const text = el.getAttribute('data-tooltip');
      if (!text || !globalTooltip) return;

      globalTooltip.textContent = text;
      globalTooltip.style.opacity = '1';
      globalTooltip.style.visibility = 'visible';

      const rect = el.getBoundingClientRect();
      globalTooltip.style.left = rect.left + rect.width / 2 - globalTooltip.offsetWidth / 2 + 'px';
      globalTooltip.style.top = rect.top - globalTooltip.offsetHeight - 6 + 'px';
    });

    el.addEventListener('mouseleave', () => {
      if (globalTooltip) {
        globalTooltip.style.opacity = '0';
        globalTooltip.style.visibility = 'hidden';
      }
    });
  });
}

// Timeframe options in seconds
const TIMEFRAMES = {
  '1D': 86400,
  '1W': 604800,
  '1M': 2592000,
  '3M': 7776000,
  '1Y': 31536000,
  'ALL': Infinity
};

/**
 * Initialize the stock manager module
 * @param {number} userId - Current user's ID
 * @param {boolean} hasIPO - Whether user has completed IPO
 */
export function initStockManager(userId, hasIPO) {
  currentUserId = userId;
  userHasIPO = hasIPO;

  // Setup close button
  const closeBtn = document.getElementById('closeStockManagerBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeStockManager);
  }

  // Setup tab buttons
  const tabBtns = document.querySelectorAll('.stock-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });

  // Setup company detail back button
  const backBtn = document.getElementById('stockCompanyBackBtn');
  if (backBtn) {
    backBtn.addEventListener('click', closeCompanyDetail);
  }

  const closeCompanyBtn = document.getElementById('closeStockCompanyBtn');
  if (closeCompanyBtn) {
    closeCompanyBtn.addEventListener('click', closeCompanyDetail);
  }

  console.log('[Stock Manager] Initialized');
}

/**
 * Show the stock manager overlay
 */
export async function showStockManager() {
  const overlay = document.getElementById('stockManagerOverlay');
  if (!overlay) {
    console.error('[Stock Manager] Overlay not found');
    return;
  }

  overlay.classList.remove('hidden');

  // Load initial data and show portfolio tab
  await switchTab('portfolio');
}

/**
 * Close the stock manager overlay
 */
export function closeStockManager() {
  const overlay = document.getElementById('stockManagerOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }

  // Cleanup chart
  destroyChart();
}

/**
 * Switch between tabs
 * @param {string} tab - Tab name (portfolio, market, investments, investors)
 */
async function switchTab(tab) {
  // Update tab button states
  const tabBtns = document.querySelectorAll('.stock-tab-btn');
  tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Load content for the selected tab
  const content = document.getElementById('stockManagerContent');
  if (!content) return;

  content.innerHTML = '<div class="stock-loading">Loading...</div>';

  try {
    switch (tab) {
      case 'portfolio':
        await loadPortfolio(content);
        break;
      case 'market':
        await loadMarket(content);
        break;
      case 'investments':
        await loadInvestments(content);
        break;
      case 'investors':
        await loadInvestors(content);
        break;
      case 'ipo-alerts':
        await loadIpoAlerts(content);
        break;
    }
  } catch (error) {
    console.error(`[Stock Manager] Error loading ${tab}:`, error);
    content.innerHTML = '<div class="stock-error">Failed to load data</div>';
  }
}

/**
 * Calculate the price tier for stock increase based on total shares issued
 * IPO starts with 25k shares, so first purchase is 25k->50k
 * Price doubles with each 25k tranche:
 * - 25k-50k: 6.25M
 * - 50k-75k: 12.5M
 * - 75k-100k: 25M
 * - 100k-125k: 50M
 * - 125k-150k: 100M
 * - etc. (doubles each tier, no upper limit)
 *
 * @param {number} totalShares - Total shares currently issued
 * @returns {Object} Price info with tier, price, and next tier info
 */
function calculateSharePriceTier(totalShares) {
  const SHARES_PER_TRANCHE = 25000;
  const BASE_PRICE = 6250000; // 6.25M for first increase (25k->50k)

  // IPO gives 25k shares, so tier 0 = 25k-50k, tier 1 = 50k-75k, etc.
  // Calculate which tier we're at based on total shares (0-indexed from 25k)
  const currentTier = Math.max(0, Math.floor((totalShares - SHARES_PER_TRANCHE) / SHARES_PER_TRANCHE));

  // Price doubles each tier
  const currentPrice = BASE_PRICE * Math.pow(2, currentTier);

  // Build tier history for display (starts at 25k since IPO gives first 25k)
  const tiers = [];
  for (let i = 0; i <= currentTier; i++) {
    const tierPrice = BASE_PRICE * Math.pow(2, i);
    const tierStart = (i + 1) * SHARES_PER_TRANCHE; // +1 because IPO is 0-25k
    const tierEnd = (i + 2) * SHARES_PER_TRANCHE;
    tiers.push({
      tier: i + 1,
      range: `${formatNumber(tierStart)}-${formatNumber(tierEnd)}`,
      price: tierPrice,
      isCurrent: i === currentTier
    });
  }

  // Add next tier for reference
  const nextTierPrice = BASE_PRICE * Math.pow(2, currentTier + 1);
  const nextTierStart = (currentTier + 2) * SHARES_PER_TRANCHE;
  const nextTierEnd = (currentTier + 3) * SHARES_PER_TRANCHE;

  return {
    currentTier: currentTier + 1,
    currentPrice,
    sharesPerPurchase: SHARES_PER_TRANCHE,
    tiers,
    nextTier: {
      tier: currentTier + 2,
      range: `${formatNumber(nextTierStart)}-${formatNumber(nextTierEnd)}`,
      price: nextTierPrice
    }
  };
}

/**
 * Handle click on increase shares for sale button
 * Opens modal dialog with price tier info
 */
async function handleIncreaseSharesClick() {
  const stock = financeData?.data?.stock;

  if (!stock) {
    showNotification('Unable to get stock info', 'error');
    return;
  }

  // Calculate shares in circulation (total - for sale = in circulation with other players)
  // Actually, total shares = shares that exist, for_sale = available to buy
  // The pricing is based on total shares issued, not circulation
  const totalShares = stock.stock_total || 0;
  const forSale = stock.stock_for_sale || 0;

  // Calculate price based on total shares issued
  const priceInfo = calculateSharePriceTier(totalShares);

  // Create modal
  showIncreaseSharesModal(priceInfo, totalShares, forSale);
}

/**
 * Create a tier row element for the modal
 * @param {Object} tier - Tier data
 * @param {boolean} isNext - Whether this is the next tier (not current)
 * @returns {HTMLElement} Tier row element
 */
function createTierRow(tier, isNext = false) {
  const row = document.createElement('div');
  row.className = `stock-tier-row${tier.isCurrent ? ' current' : ''}${isNext ? ' next' : ''}`;

  const rangeSpan = document.createElement('span');
  rangeSpan.className = 'stock-tier-range';
  rangeSpan.textContent = tier.range;
  row.appendChild(rangeSpan);

  const priceSpan = document.createElement('span');
  priceSpan.className = 'stock-tier-price';
  priceSpan.textContent = `$${formatNumber(tier.price)}`;
  row.appendChild(priceSpan);

  if (tier.isCurrent || isNext) {
    const badge = document.createElement('span');
    badge.className = `stock-tier-badge${isNext ? ' next' : ''}`;
    badge.textContent = isNext ? 'NEXT' : 'CURRENT';
    row.appendChild(badge);
  }

  return row;
}

/**
 * Show the increase shares modal with price tier information
 * @param {Object} priceInfo - Price tier calculation result
 * @param {number} totalShares - Total shares issued
 * @param {number} forSale - Shares currently for sale
 */
function showIncreaseSharesModal(priceInfo, totalShares, forSale) {
  // Remove existing modal if any
  const existingModal = document.getElementById('increaseSharesModal');
  if (existingModal) {
    existingModal.remove();
  }

  // Create modal overlay
  const modal = document.createElement('div');
  modal.id = 'increaseSharesModal';
  modal.className = 'stock-increase-modal-overlay';

  // Create modal container
  const modalContainer = document.createElement('div');
  modalContainer.className = 'stock-increase-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'stock-increase-modal-header';

  const title = document.createElement('h3');
  title.textContent = 'Issue New Shares';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  const closeBtnSpan = document.createElement('span');
  closeBtnSpan.textContent = 'x';
  closeBtn.appendChild(closeBtnSpan);
  closeBtn.onmouseover = () => { closeBtnSpan.style.animation = 'wobble 0.5s ease-in-out'; };
  closeBtn.onmouseout = () => { closeBtnSpan.style.animation = 'none'; };
  header.appendChild(closeBtn);

  modalContainer.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'stock-increase-modal-body';

  // Stats info
  const infoDiv = document.createElement('div');
  infoDiv.className = 'stock-increase-info';

  const stat1 = document.createElement('div');
  stat1.className = 'stock-increase-stat';
  const stat1Label = document.createElement('span');
  stat1Label.className = 'label';
  stat1Label.textContent = 'Total Shares Issued';
  const stat1Value = document.createElement('span');
  stat1Value.className = 'value';
  stat1Value.textContent = formatNumber(totalShares);
  stat1.appendChild(stat1Label);
  stat1.appendChild(stat1Value);
  infoDiv.appendChild(stat1);

  const stat2 = document.createElement('div');
  stat2.className = 'stock-increase-stat';
  const stat2Label = document.createElement('span');
  stat2Label.className = 'label';
  stat2Label.textContent = 'Currently For Sale';
  const stat2Value = document.createElement('span');
  stat2Value.className = 'value';
  stat2Value.textContent = formatNumber(forSale);
  stat2.appendChild(stat2Label);
  stat2.appendChild(stat2Value);
  infoDiv.appendChild(stat2);

  body.appendChild(infoDiv);

  // Tier section
  const tierSection = document.createElement('div');
  tierSection.className = 'stock-tier-section';

  const tierTitle = document.createElement('h4');
  tierTitle.textContent = 'Price Tiers (25,000 shares each)';
  tierSection.appendChild(tierTitle);

  const tierList = document.createElement('div');
  tierList.className = 'stock-tier-list';

  // Add last 3 tiers
  const recentTiers = priceInfo.tiers.slice(-3);
  recentTiers.forEach(tier => {
    tierList.appendChild(createTierRow(tier));
  });

  // Add next tier
  tierList.appendChild(createTierRow(priceInfo.nextTier, true));

  tierSection.appendChild(tierList);
  body.appendChild(tierSection);

  // Purchase section
  const purchaseDiv = document.createElement('div');
  purchaseDiv.className = 'stock-increase-purchase';

  const purchaseInfo = document.createElement('div');
  purchaseInfo.className = 'stock-increase-purchase-info';

  const amountSpan = document.createElement('span');
  amountSpan.className = 'stock-increase-amount';
  amountSpan.textContent = `+${formatNumber(priceInfo.sharesPerPurchase)} shares`;
  purchaseInfo.appendChild(amountSpan);

  const priceSpan = document.createElement('span');
  priceSpan.className = 'stock-increase-price';
  priceSpan.textContent = 'Cost: ';
  const priceStrong = document.createElement('strong');
  priceStrong.textContent = `$${formatNumber(priceInfo.currentPrice)}`;
  priceSpan.appendChild(priceStrong);
  purchaseInfo.appendChild(priceSpan);

  purchaseDiv.appendChild(purchaseInfo);

  const confirmBtn = document.createElement('button');
  confirmBtn.id = 'confirmIncreaseShares';
  confirmBtn.className = 'text-btn';
  confirmBtn.textContent = 'Issue Shares';
  purchaseDiv.appendChild(confirmBtn);

  body.appendChild(purchaseDiv);

  modalContainer.appendChild(body);
  modal.appendChild(modalContainer);
  document.body.appendChild(modal);

  // Close handlers
  closeBtn.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  // Confirm handler
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing...';

    try {
      const result = await increaseStockForSale();

      if (result.error) {
        showNotification(`Failed: ${result.error}`, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Issue Shares';
        return;
      }

      showNotification(`Successfully issued ${formatNumber(priceInfo.sharesPerPurchase)} new shares!`, 'success');
      modal.remove();

      // Reload portfolio to show updated values
      switchTab('portfolio');
    } catch (error) {
      console.error('[Stock Manager] Error increasing shares:', error);
      showNotification('Failed to issue shares', 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Issue Shares';
    }
  });
}

/**
 * Load portfolio tab content
 * @param {HTMLElement} container - Content container
 */
async function loadPortfolio(container) {
  // Fetch own finance data
  financeData = await getStockFinanceOverview(currentUserId);

  if (!financeData || !financeData.data) {
    container.innerHTML = '<div class="stock-error">Failed to load portfolio data</div>';
    return;
  }

  const stock = financeData.data.stock;

  if (!userHasIPO || !stock) {
    container.innerHTML = `
      <div class="stock-no-ipo">
        <div class="stock-no-ipo-icon">&#x1F4CA;</div>
        <h3>IPO Required</h3>
        <p>Complete your IPO to list your company on the stock market and view your portfolio.</p>
      </div>
    `;
    return;
  }

  const trend = stock.stock_trend || 'same';

  // Calculate statistics
  const stats = calculatePriceStats(stock.history || []);

  container.innerHTML = `
    <div class="stock-portfolio">
      ${renderChartSection('portfolioChart', stock, stats, { stockForSale: stock.stock_for_sale, stockTotal: stock.stock_total || 0, showIncreaseButton: userHasIPO })}
    </div>
  `;

  // Setup increase shares button click handler
  const increaseBtn = container.querySelector('[data-action="increase"]');
  if (increaseBtn) {
    increaseBtn.addEventListener('click', handleIncreaseSharesClick);
  }

  // Create chart
  if (stock.history && stock.history.length > 0) {
    initializeChart('portfolioChart', stock.history, CHART_COLORS[trend]);
  }
}

/**
 * Render the chart section with toolbar and stats
 * @param {string} containerId - The container element ID for the chart
 * @param {Object} stock - Stock data object
 * @param {Object} stats - Calculated price statistics
 * @param {Object} [options] - Optional extra data (stockForSale, stockTotal, ourShares)
 */
export function renderChartSection(containerId, stock, stats, options = {}) {
  const trend = stock.stock_trend || 'same';
  const trendIcon = trend === 'up' ? '&#x25B2;' : trend === 'down' ? '&#x25BC;' : '&#x25CF;';
  const changeClass = stats.change >= 0 ? 'positive' : 'negative';
  const changeSign = stats.change >= 0 ? '+' : '';

  // Build shares legend item if stock data provided
  let sharesLegendItem = '';
  let increaseLegendItem = '';
  if (options.stockForSale !== undefined && options.stockTotal !== undefined) {
    sharesLegendItem = `
        <div class="stock-legend-item stock-legend-shares">
          <span class="stock-legend-label">Shares (Sale/Total)</span>
          <span class="stock-legend-value">${formatNumber(options.stockForSale)} / ${formatNumber(options.stockTotal)}</span>
        </div>`;
    // Show increase button as separate column if user can increase shares for sale
    if (options.showIncreaseButton) {
      increaseLegendItem = `
        <div class="stock-legend-item stock-legend-increase">
          <span class="stock-legend-label">Increase</span>
          <span class="stock-increase-emoji" data-action="increase" title="Issue 25,000 new shares">&#10133;</span>
        </div>`;
    }
  }

  // Build our shares legend item if provided
  let ourSharesLegendItem = '';
  if (options.ourShares > 0) {
    ourSharesLegendItem = `
        <div class="stock-legend-item">
          <span class="stock-legend-label">Yours</span>
          <span class="stock-legend-value">${formatNumber(options.ourShares)}</span>
        </div>`;
  }

  return `
    <div class="stock-chart-wrapper">
      <div class="stock-chart-toolbar">
        <div class="stock-chart-toolbar-left">
          <button class="text-btn" data-action="timeframe" data-tf="1D">1D</button>
          <button class="text-btn" data-action="timeframe" data-tf="1W">1W</button>
          <button class="text-btn" data-action="timeframe" data-tf="1M">1M</button>
          <button class="text-btn" data-action="timeframe" data-tf="3M">3M</button>
          <button class="text-btn" data-action="timeframe" data-tf="1Y">1Y</button>
          <button class="text-btn active" data-action="timeframe" data-tf="ALL">ALL</button>
        </div>
        <div class="stock-chart-toolbar-right">
          <button class="text-btn" data-action="ma" data-ma="7" data-tooltip="7-period MA">MA7</button>
          <button class="text-btn active" data-action="ma" data-ma="25" data-tooltip="25-period MA">MA25</button>
          <button class="text-btn" data-action="ma" data-ma="99" data-tooltip="99-period MA">MA99</button>
          <span style="color: var(--color-text-muted); margin: 0 4px;">|</span>
          <button class="text-btn active" data-action="chart-type" data-type="area" data-tooltip="Area Chart">&#x1F4C8;</button>
          <button class="text-btn" data-action="chart-type" data-type="line" data-tooltip="Line Chart">&#x1F4C9;</button>
        </div>
      </div>
      <div class="stock-chart-container" id="${containerId}"></div>
      <div class="stock-price-legend">
        <div class="stock-legend-item">
          <span class="stock-legend-label">Current</span>
          <span class="stock-legend-value">$${formatNumber(stock.stock)} <span class="trend-${trend}">${trendIcon}</span></span>
        </div>
        <div class="stock-legend-item">
          <span class="stock-legend-label">Change</span>
          <span class="stock-legend-value ${changeClass}">${changeSign}${stats.changePercent.toFixed(2)}%</span>
        </div>
        <div class="stock-legend-item">
          <span class="stock-legend-label">ATH</span>
          <span class="stock-legend-value">$${formatNumber(stats.ath)}</span>
        </div>
        <div class="stock-legend-item">
          <span class="stock-legend-label">ATL</span>
          <span class="stock-legend-value">$${formatNumber(stats.atl)}</span>
        </div>
        <div class="stock-legend-item">
          <span class="stock-legend-label">Avg</span>
          <span class="stock-legend-value">$${formatNumber(stats.avg)}</span>
        </div>${sharesLegendItem}${ourSharesLegendItem}${increaseLegendItem}
      </div>
    </div>
  `;
}

/**
 * Calculate price statistics from history data
 */
export function calculatePriceStats(history) {
  if (!history || history.length === 0) {
    return { ath: 0, atl: 0, avg: 0, change: 0, changePercent: 0 };
  }

  const values = history.map(h => parseFloat(h.value));
  const sortedByTime = [...history].sort((a, b) => a.time - b.time);

  const ath = Math.max(...values);
  const atl = Math.min(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;

  const firstValue = parseFloat(sortedByTime[0].value);
  const lastValue = parseFloat(sortedByTime[sortedByTime.length - 1].value);
  const change = lastValue - firstValue;
  const changePercent = firstValue > 0 ? (change / firstValue) * 100 : 0;

  return { ath, atl, avg, change, changePercent };
}

/**
 * Initialize chart with toolbar handlers
 */
export function initializeChart(containerId, historyData, trendColor) {
  // Parse and validate data
  const parsedData = historyData.map(item => ({
    time: item.time,
    value: parseFloat(item.value)
  }));

  // Check for invalid values and log them (don't silently hide)
  const invalidEntries = parsedData.filter(d => isNaN(d.value) || d.value === null);
  if (invalidEntries.length > 0) {
    console.warn('[Stock Manager] Chart data contains invalid values:', invalidEntries);
  }

  // Sort by time
  const sortedData = parsedData
    .filter(d => !isNaN(d.value) && d.value !== null)
    .sort((a, b) => a.time - b.time);

  // LightweightCharts requires unique timestamps - deduplicate
  // API sometimes returns duplicate timestamps which crashes the chart
  const seenTimes = new Set();
  chartState.data = sortedData.filter(d => {
    if (seenTimes.has(d.time)) {
      return false;
    }
    seenTimes.add(d.time);
    return true;
  });

  if (sortedData.length !== chartState.data.length) {
    console.debug(`[Stock Manager] Removed ${sortedData.length - chartState.data.length} duplicate timestamps from chart data`);
  }

  chartState.filteredData = [...chartState.data];
  chartState.timeframe = 'ALL';
  chartState.showMA25 = true;

  // Create the chart
  createEnhancedChart(containerId, trendColor);

  // Setup toolbar event handlers
  setupChartToolbar(containerId, trendColor);
}

/**
 * Setup chart toolbar event handlers
 */
function setupChartToolbar(containerId, trendColor) {
  // Timeframe buttons
  document.querySelectorAll('[data-action="timeframe"]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-action="timeframe"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartState.timeframe = btn.dataset.tf;
      filterDataByTimeframe();
      updateChart(containerId, trendColor);
    });
  });

  // MA toggle buttons
  document.querySelectorAll('[data-action="ma"]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const ma = btn.dataset.ma;
      if (ma === '7') chartState.showMA7 = btn.classList.contains('active');
      if (ma === '25') chartState.showMA25 = btn.classList.contains('active');
      if (ma === '99') chartState.showMA99 = btn.classList.contains('active');
      updateMovingAverages();
    });
  });

  // Chart type buttons
  document.querySelectorAll('[data-action="chart-type"]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-action="chart-type"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartState.chartType = btn.dataset.type;
      updateChart(containerId, trendColor);
    });
  });

  // Setup tooltips for buttons with data-tooltip attribute
  const chartWrapper = document.getElementById(containerId)?.closest('.stock-chart-wrapper');
  if (chartWrapper) {
    setupTooltips(chartWrapper);
  }
}

/**
 * Filter data by selected timeframe
 */
function filterDataByTimeframe() {
  const now = Math.floor(Date.now() / 1000);
  const seconds = TIMEFRAMES[chartState.timeframe];

  if (seconds === Infinity) {
    chartState.filteredData = [...chartState.data];
  } else {
    const cutoff = now - seconds;
    chartState.filteredData = chartState.data.filter(d => d.time >= cutoff);
  }

  // Ensure we have at least 2 data points
  if (chartState.filteredData.length < 2 && chartState.data.length >= 2) {
    chartState.filteredData = chartState.data.slice(-2);
  }
}

/**
 * Create enhanced chart with all features
 */
function createEnhancedChart(containerId, trendColor) {
  destroyChart();

  const container = document.getElementById(containerId);
  if (!container || !window.LightweightCharts) {
    console.error('[Stock Manager] Chart container or library not found');
    return;
  }

  const chart = window.LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 350,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#9ca3af',
      attributionLogo: false
    },
    grid: {
      vertLines: { color: 'rgba(55, 65, 81, 0.5)' },
      horzLines: { color: 'rgba(55, 65, 81, 0.5)' }
    },
    rightPriceScale: {
      borderColor: '#374151',
      scaleMargins: { top: 0.1, bottom: 0.1 }
    },
    timeScale: {
      borderColor: '#374151',
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time) => {
        const date = new Date(time * 1000);
        return `${date.getMonth() + 1}/${date.getDate()}`;
      }
    },
    crosshair: {
      mode: window.LightweightCharts.CrosshairMode.Normal,
      vertLine: {
        color: 'rgba(255, 255, 255, 0.4)',
        width: 1,
        style: 2,
        labelBackgroundColor: '#374151'
      },
      horzLine: {
        color: 'rgba(255, 255, 255, 0.4)',
        width: 1,
        style: 2,
        labelBackgroundColor: '#374151'
      }
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
  });

  // Create main series based on chart type
  let mainSeries;
  const seriesOptions = chartState.chartType === 'area' ? {
    lineColor: trendColor,
    topColor: trendColor + '60',
    bottomColor: trendColor + '05',
    lineWidth: 2,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    crosshairMarkerBackgroundColor: trendColor
  } : {
    color: trendColor,
    lineWidth: 2,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    crosshairMarkerBackgroundColor: trendColor
  };

  // v4+ vs v3 API compatibility
  if (chartState.chartType === 'area') {
    if (typeof chart.addAreaSeries === 'function') {
      mainSeries = chart.addAreaSeries(seriesOptions);
    } else {
      mainSeries = chart.addSeries(window.LightweightCharts.AreaSeries, seriesOptions);
    }
  } else {
    if (typeof chart.addLineSeries === 'function') {
      mainSeries = chart.addLineSeries(seriesOptions);
    } else {
      mainSeries = chart.addSeries(window.LightweightCharts.LineSeries, seriesOptions);
    }
  }

  mainSeries.setData(chartState.filteredData);

  // Create MA series
  chartState.maSeries = {};
  createMASeries(chart, 7, CHART_COLORS.ma7, chartState.showMA7);
  createMASeries(chart, 25, CHART_COLORS.ma25, chartState.showMA25);
  createMASeries(chart, 99, CHART_COLORS.ma99, chartState.showMA99);

  chart.timeScale().fitContent();

  // Handle resize
  const resizeObserver = new ResizeObserver(entries => {
    const { width } = entries[0].contentRect;
    chart.applyOptions({ width });
  });
  resizeObserver.observe(container);

  currentChart = { chart, mainSeries, resizeObserver, containerId, trendColor };
}

/**
 * Create a Moving Average series
 */
function createMASeries(chart, period, color, visible) {
  const maData = calculateMA(chartState.filteredData, period);

  let maSeries;
  const options = {
    color: color,
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false
  };

  if (typeof chart.addLineSeries === 'function') {
    maSeries = chart.addLineSeries(options);
  } else {
    maSeries = chart.addSeries(window.LightweightCharts.LineSeries, options);
  }

  if (visible && maData.length > 0) {
    maSeries.setData(maData);
  }

  chartState.maSeries[`ma${period}`] = { series: maSeries, visible };
}

/**
 * Calculate Moving Average
 */
function calculateMA(data, period) {
  if (data.length < period) return [];

  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].value;
    }
    result.push({
      time: data[i].time,
      value: sum / period
    });
  }
  return result;
}

/**
 * Update Moving Averages visibility
 */
function updateMovingAverages() {
  if (!currentChart) return;

  const periods = [
    { key: 'ma7', period: 7, show: chartState.showMA7 },
    { key: 'ma25', period: 25, show: chartState.showMA25 },
    { key: 'ma99', period: 99, show: chartState.showMA99 }
  ];

  periods.forEach(({ key, period, show }) => {
    const ma = chartState.maSeries[key];
    if (ma) {
      if (show) {
        const maData = calculateMA(chartState.filteredData, period);
        ma.series.setData(maData);
      } else {
        ma.series.setData([]);
      }
      ma.visible = show;
    }
  });
}

/**
 * Update chart with new data/settings
 */
function updateChart(containerId, trendColor) {
  if (currentChart) {
    createEnhancedChart(containerId, trendColor);
  }
}

/**
 * Reset market state for new filter/search
 */
function resetMarketState() {
  marketState.currentPage = 1;
  marketState.isLoading = false;
  marketState.hasMore = true;
}

/**
 * Setup scroll handler for infinite scroll
 * @param {HTMLElement} scrollContainer - The scrollable container
 */
function setupMarketScrollHandler(scrollContainer) {
  // Remove existing handler if any
  if (marketState.scrollHandler && marketState.scrollContainer) {
    marketState.scrollContainer.removeEventListener('scroll', marketState.scrollHandler);
  }

  marketState.scrollContainer = scrollContainer;

  marketState.scrollHandler = () => {
    if (marketState.isLoading || !marketState.hasMore) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const scrollThreshold = 100; // pixels from bottom to trigger load

    if (scrollTop + clientHeight >= scrollHeight - scrollThreshold) {
      loadMoreMarketItems();
    }
  };

  scrollContainer.addEventListener('scroll', marketState.scrollHandler);
}

/**
 * Load more market items (next page)
 */
async function loadMoreMarketItems() {
  if (marketState.isLoading || !marketState.hasMore) return;

  marketState.currentPage++;
  await loadMarketList(marketState.currentFilter, marketState.currentPage, marketState.currentSearch, true);
}

/**
 * Load market tab content
 * @param {HTMLElement} container - Content container
 */
async function loadMarket(container) {
  // Reset market state when loading tab
  resetMarketState();
  marketState.currentFilter = 'top';
  marketState.currentSearch = '';

  container.innerHTML = `
    <div class="stock-market">
      <div class="stock-market-filters">
        <button class="text-btn active" data-action="filter" data-filter="top">Top</button>
        <button class="text-btn" data-action="filter" data-filter="low">Low</button>
        <button class="text-btn" data-action="filter" data-filter="activity">Activity</button>
        <button class="text-btn" data-action="filter" data-filter="recent-ipo">Recent IPO</button>
        <input type="text" class="stock-search-input" placeholder="Search company..." id="stockSearchInput">
      </div>
      <div class="stock-market-list" id="stockMarketList">
        <div class="stock-loading">Loading...</div>
      </div>
    </div>
  `;

  // Setup filter buttons
  const filterBtns = container.querySelectorAll('[data-action="filter"]');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      resetMarketState();
      marketState.currentFilter = btn.dataset.filter;
      loadMarketList(btn.dataset.filter, 1, marketState.currentSearch);
    });
  });

  // Setup search
  const searchInput = document.getElementById('stockSearchInput');
  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        resetMarketState();
        marketState.currentSearch = searchInput.value;
        loadMarketList(marketState.currentFilter, 1, searchInput.value);
      }, 300);
    });
  }

  // Setup scroll handler on the main content container
  const stockManagerContent = document.getElementById('stockManagerContent');
  if (stockManagerContent) {
    setupMarketScrollHandler(stockManagerContent);
  }

  // Load initial market list
  await loadMarketList('top', 1);
}

/**
 * Generate table row HTML for a company
 * @param {Object} company - Company data
 * @returns {string} HTML string for table row
 */
function generateMarketRowHtml(company) {
  const trend = company.stock_trend || 'same';
  const trendIcon = trend === 'up' ? '&#x25B2;' : trend === 'down' ? '&#x25BC;' : '&#x25CF;';
  return `
    <tr class="stock-table-row" data-user-id="${company.id}">
      <td class="stock-company-name stock-clickable" data-user-id="${company.id}" data-company-name="${escapeHtml(company.company_name)}">${escapeHtml(company.company_name)}</td>
      <td>$${formatNumber(company.stock)}</td>
      <td class="trend-${trend}">${trendIcon}</td>
      <td>${formatNumber(company.stock_for_sale)}</td>
    </tr>
  `;
}

/**
 * Create a table row element for a company
 * @param {Object} company - Company data
 * @returns {HTMLTableRowElement} Table row element
 */
function createMarketRow(company) {
  const trend = company.stock_trend || 'same';
  const trendIcon = trend === 'up' ? '\u25B2' : trend === 'down' ? '\u25BC' : '\u25CF';

  const tr = document.createElement('tr');
  tr.className = 'stock-table-row';
  tr.dataset.userId = company.id;

  const tdName = document.createElement('td');
  tdName.className = 'stock-company-name stock-clickable';
  tdName.dataset.userId = company.id;
  tdName.dataset.companyName = company.company_name;
  tdName.textContent = company.company_name;
  tr.appendChild(tdName);

  const tdPrice = document.createElement('td');
  tdPrice.textContent = '$' + formatNumber(company.stock);
  tr.appendChild(tdPrice);

  const tdTrend = document.createElement('td');
  tdTrend.className = 'trend-' + trend;
  tdTrend.textContent = trendIcon;
  tr.appendChild(tdTrend);

  const tdForSale = document.createElement('td');
  tdForSale.textContent = formatNumber(company.stock_for_sale);
  tr.appendChild(tdForSale);

  return tr;
}

/**
 * Setup click handlers for market table rows
 * @param {NodeList} rows - Table rows to setup
 */
function setupMarketRowClickHandlers(rows) {
  rows.forEach(row => {
    if (row.dataset.clickBound) return; // Prevent double-binding
    row.dataset.clickBound = 'true';
    row.style.cursor = 'pointer';
    row.addEventListener('click', async () => {
      const { openPlayerProfile } = await import('./company-profile.js');
      openPlayerProfile(parseInt(row.dataset.userId));
    });
  });
}

/**
 * Load market list with filter and lazy loading
 * @param {string} filter - Filter type (top, low, activity, recent-ipo)
 * @param {number} page - Page number
 * @param {string} search - Search query
 * @param {boolean} append - Whether to append to existing list
 */
async function loadMarketList(filter, page, search = '', append = false) {
  const listContainer = document.getElementById('stockMarketList');

  if (!listContainer) return;

  // Prevent concurrent loads
  if (marketState.isLoading) return;
  marketState.isLoading = true;

  // Show loading indicator
  if (append) {
    // Add loading spinner at bottom
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'stock-lazy-loading';
    loadingIndicator.id = 'stockLazyLoading';
    loadingIndicator.innerHTML = '<span class="stock-lazy-spinner"></span> Loading more...';
    listContainer.appendChild(loadingIndicator);
  } else {
    listContainer.innerHTML = '<div class="stock-loading">Loading...</div>';
  }

  try {
    // Use filter=search when search term is provided, otherwise use selected filter
    const effectiveFilter = search.trim() ? 'search' : filter;
    const result = await getStockMarket(effectiveFilter, page, 40, search);

    // Remove loading indicator
    const loadingIndicator = document.getElementById('stockLazyLoading');
    if (loadingIndicator) {
      loadingIndicator.remove();
    }

    if (!result || !result.data || !result.data.market) {
      if (!append) {
        listContainer.innerHTML = '<div class="stock-error">No companies found</div>';
      }
      marketState.hasMore = false;
      marketState.isLoading = false;
      return;
    }

    const market = result.data.market;
    marketState.hasMore = result.data.has_next;

    if (market.length === 0) {
      if (!append) {
        listContainer.innerHTML = '<div class="stock-empty">No companies found</div>';
      }
      marketState.hasMore = false;
      marketState.isLoading = false;
      return;
    }

    if (append) {
      // Append rows to existing table using DOM methods
      const tbody = listContainer.querySelector('tbody');
      if (tbody) {
        market.forEach(company => {
          const row = createMarketRow(company);
          tbody.appendChild(row);
          setupMarketRowClickHandlers([row]);
        });
      }
    } else {
      // Create new table
      listContainer.innerHTML = `
        <table class="stock-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Price</th>
              <th>Trend</th>
              <th>For Sale</th>
            </tr>
          </thead>
          <tbody>
            ${market.map(company => generateMarketRowHtml(company)).join('')}
          </tbody>
        </table>
      `;

      // Setup row click handlers
      const rows = listContainer.querySelectorAll('.stock-table-row[data-user-id]');
      setupMarketRowClickHandlers(rows);
    }
  } catch (error) {
    console.error('[Stock Manager] Error loading market:', error);
    if (!append) {
      listContainer.innerHTML = '<div class="stock-error">Failed to load market data</div>';
    }
    // Remove loading indicator on error
    const loadingIndicator = document.getElementById('stockLazyLoading');
    if (loadingIndicator) {
      loadingIndicator.remove();
    }
  } finally {
    marketState.isLoading = false;
  }
}

// 48 hours in milliseconds and seconds
const STOCK_LOCK_PERIOD_MS = 48 * 60 * 60 * 1000;
const STOCK_LOCK_PERIOD_SEC = 48 * 60 * 60;

/**
 * Format a Unix timestamp as a short date (e.g., "Jan 15" or "Jan 15 '24")
 * @param {number} timestampSec - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
function formatPurchaseDate(timestampSec) {
  if (!timestampSec) return '-';
  const date = new Date(timestampSec * 1000);
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate();

  // If same year, just show "Jan 15", otherwise "Jan 15 '24"
  if (date.getFullYear() === now.getFullYear()) {
    return `${month} ${day}`;
  }
  const yearShort = String(date.getFullYear()).slice(-2);
  return `${month} ${day} '${yearShort}`;
}

/**
 * Load investments tab content
 */
async function loadInvestments(container) {
  // Fetch finance data and purchase times in parallel
  const [financeResult, purchaseTimesResult] = await Promise.all([
    getStockFinanceOverview(currentUserId),
    getStockPurchaseTimes().catch(() => ({ purchaseTimes: {}, gameStockPurchases: [] }))
  ]);

  financeData = financeResult;
  const purchaseTimes = purchaseTimesResult.purchaseTimes || {};
  const gameStockPurchases = purchaseTimesResult.gameStockPurchases || [];

  if (!financeData || !financeData.data) {
    container.innerHTML = '<div class="stock-error">Failed to load investments</div>';
    return;
  }

  // API returns investments as object with company names as keys - convert to array
  const investmentsObj = financeData.data.investments || {};
  const investments = Object.entries(investmentsObj).map(([companyName, inv]) => ({
    company_name: companyName,
    ...inv
  }));

  if (investments.length === 0) {
    container.innerHTML = `
      <div class="stock-empty-state">
        <div class="stock-empty-icon">&#x1F4BC;</div>
        <h3>No Investments Yet</h3>
        <p>Browse the market to find companies to invest in.</p>
      </div>
    `;
    return;
  }

  // Calculate totals
  const totalInvested = investments.reduce((sum, inv) => sum + parseFloat(inv.invested || 0), 0);
  const totalReturn = investments.reduce((sum, inv) => sum + parseFloat(inv.return || 0), 0);
  const returnClass = totalReturn >= 0 ? 'trend-up' : 'trend-down';

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  container.innerHTML = `
    <div class="stock-investments">
      <div class="stock-summary-row">
        <span class="stock-summary-item"><span class="stock-summary-label">Invested:</span> <span class="trend-down">-$${formatNumber(totalInvested)}</span></span>
        <span class="stock-summary-item"><span class="stock-summary-label">Return:</span> <span class="${returnClass}">$${formatNumber(totalReturn)}</span></span>
      </div>
      <table class="stock-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Shares</th>
            <th>Buy Price</th>
            <th>Current</th>
            <th>P/L</th>
            <th>Purchased</th>
            <th>Sell</th>
          </tr>
        </thead>
        <tbody>
          ${investments.map(inv => {
            const buyPrice = parseFloat(inv.bought_at || 0);
            const currentPrice = parseFloat(inv.current_value || 0);
            const shares = parseInt(inv.total_shares || 0);
            const pl = (currentPrice - buyPrice) * shares;
            const plPercent = buyPrice > 0 ? ((currentPrice - buyPrice) / buyPrice * 100).toFixed(1) : 0;
            const plClass = pl >= 0 ? 'trend-up' : 'trend-down';
            const plSign = pl >= 0 ? '+' : '';

            // Sell availability from API
            const availableToSell = parseInt(inv.available_to_sell, 10) || 0;

            // Calculate purchase time - try multiple sources:
            // 1. API next_available_sale_time (purchase_time + 48h) - only set if still locked
            // 2. Logbook entry for this company
            // 3. POD1 transaction matching by amount
            const apiNextSaleTime = parseInt(inv.next_available_sale_time, 10) || 0;
            let purchaseTimeSec = apiNextSaleTime > 0 ? apiNextSaleTime - STOCK_LOCK_PERIOD_SEC : 0;

            // Calculate unlock time from logbook or game transactions
            let nextSaleTime = 0;
            let purchaseTimeMs = purchaseTimes[inv.id];

            // If not in logbook, try to match from game transactions
            if (!purchaseTimeMs && gameStockPurchases.length > 0) {
              // If we have next_available_sale_time from API, find transaction near that time - 48h
              if (apiNextSaleTime > 0) {
                const expectedPurchaseTime = (apiNextSaleTime - STOCK_LOCK_PERIOD_SEC) * 1000;
                // Find transaction within 1 hour of expected purchase time
                const matchingTx = gameStockPurchases.find(tx => {
                  const timeDiff = Math.abs(tx.time - expectedPurchaseTime);
                  return timeDiff <= 3600000; // 1 hour tolerance
                });
                if (matchingTx) {
                  purchaseTimeMs = matchingTx.time;
                }
              }
              // Fallback: try to match by invested amount (for older purchases)
              if (!purchaseTimeMs && inv.invested) {
                const investedAmount = Math.round(parseFloat(inv.invested));
                // Game transaction includes 5% brokerage fee
                const expectedTxAmount = Math.round(investedAmount * 1.05);
                // Find matching transaction (within 5% tolerance for multiple purchases)
                const matchingTx = gameStockPurchases.find(tx => {
                  const diff = Math.abs(tx.amount - expectedTxAmount);
                  return diff <= expectedTxAmount * 0.05;
                });
                if (matchingTx) {
                  purchaseTimeMs = matchingTx.time;
                }
              }
            }

            if (purchaseTimeMs) {
              // Unlock time = purchase time + 48h (convert to seconds)
              nextSaleTime = Math.floor((purchaseTimeMs + STOCK_LOCK_PERIOD_MS) / 1000);
            }

            // If we still don't have a purchase time, use the logbook/transaction time
            if (!purchaseTimeSec && purchaseTimeMs) {
              purchaseTimeSec = Math.floor(purchaseTimeMs / 1000);
            }

            const hasLockedShares = nextSaleTime > nowSec;
            const lockedAmount = shares - availableToSell;

            // Debug: log investment data to understand sell availability
            if (window.DEBUG_MODE) {
              console.log('[Stock Manager] Investment:', inv.company_name, {
                shares,
                availableToSell,
                nextSaleTime,
                nowSec,
                hasLockedShares,
                lockedAmount,
                purchaseTimeFromLogbook: purchaseTimes[inv.id],
                raw: { available_to_sell: inv.available_to_sell, next_available_sale_time: inv.next_available_sale_time }
              });
            }

            let sellCell = '';
            if (availableToSell > 0 && hasLockedShares && lockedAmount > 0) {
              // Some shares available, some still locked - show button + timer
              sellCell = `
                <button class="text-btn" data-action="sell" data-user-id="${inv.id}" data-company="${escapeHtml(inv.company_name || '')}" data-max="${availableToSell}" data-price="${currentPrice}">Sell (${formatNumber(availableToSell)})</button>
                <span class="stock-sell-timer stock-sell-timer-small" data-unlock-time="${nextSaleTime}" title="+${formatNumber(lockedAmount)} more">+${formatNumber(lockedAmount)}</span>
              `;
            } else if (availableToSell > 0) {
              // All shares available
              sellCell = `<button class="text-btn" data-action="sell" data-user-id="${inv.id}" data-company="${escapeHtml(inv.company_name || '')}" data-max="${availableToSell}" data-price="${currentPrice}">Sell (${formatNumber(availableToSell)})</button>`;
            } else if (hasLockedShares) {
              // No shares available yet - show countdown timer with all shares locked
              sellCell = `<span class="stock-sell-timer" data-unlock-time="${nextSaleTime}">${formatNumber(shares)} locked</span>`;
            } else if (lockedAmount > 0) {
              // Shares locked but no purchase time in logbook (bought before logging)
              sellCell = `<span class="stock-sell-locked">${formatNumber(lockedAmount)} locked</span>`;
            } else {
              sellCell = '<span class="stock-sell-unavailable">-</span>';
            }

            return `
              <tr class="stock-table-row" data-user-id="${inv.id}">
                <td class="stock-company-name clickable" data-user-id="${inv.id}">${escapeHtml(inv.company_name || 'Unknown')}</td>
                <td>${formatNumber(shares)}</td>
                <td>$${formatNumber(buyPrice)}</td>
                <td>$${formatNumber(currentPrice)}</td>
                <td class="${plClass}">${plSign}$${formatNumber(Math.abs(pl))} (${plSign}${plPercent}%)</td>
                <td class="stock-purchased-cell">${formatPurchaseDate(purchaseTimeSec)}</td>
                <td class="stock-sell-cell">${sellCell}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Setup click handlers for company names
  setupCompanyNameClickHandlers(container);

  // Setup sell button handlers
  setupInvestmentSellButtons(container);

  // Start countdown timers
  startSellTimers(container);
}

/**
 * Estimate purchase date by finding when stock price matched bought_at price
 * @param {number} boughtAt - Price per share when bought
 * @param {Array} history - Stock price history array
 * @returns {number} Estimated timestamp in seconds, or 0 if not found
 */
function estimatePurchaseDateFromPrice(boughtAt, history) {
  if (!history || history.length === 0 || !boughtAt) return 0;

  // Sort history by time (oldest first)
  const sortedHistory = [...history].sort((a, b) => a.time - b.time);

  // Find the first time the stock price was close to bought_at (within 1%)
  const tolerance = boughtAt * 0.01;
  for (const entry of sortedHistory) {
    const price = parseFloat(entry.value);
    if (Math.abs(price - boughtAt) <= tolerance) {
      return entry.time;
    }
  }

  // If no exact match, find closest price
  let closestEntry = null;
  let closestDiff = Infinity;
  for (const entry of sortedHistory) {
    const price = parseFloat(entry.value);
    const diff = Math.abs(price - boughtAt);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestEntry = entry;
    }
  }

  return closestEntry ? closestEntry.time : 0;
}

/**
 * Load investors tab content
 */
async function loadInvestors(container) {
  if (!userHasIPO) {
    container.innerHTML = `
      <div class="stock-no-ipo">
        <div class="stock-no-ipo-icon">&#x1F465;</div>
        <h3>IPO Required</h3>
        <p>Complete your IPO to see who invests in your company.</p>
      </div>
    `;
    return;
  }

  if (!financeData) {
    financeData = await getStockFinanceOverview(currentUserId);
  }

  if (!financeData || !financeData.data) {
    container.innerHTML = '<div class="stock-error">Failed to load investors</div>';
    return;
  }

  // API returns investors as object with company names as keys - convert to array
  const investorsObj = financeData.data.investors || {};
  const investors = Object.entries(investorsObj).map(([companyName, inv]) => ({
    company_name: companyName,
    ...inv
  }));

  if (investors.length === 0) {
    container.innerHTML = `
      <div class="stock-empty-state">
        <div class="stock-empty-icon">&#x1F465;</div>
        <h3>No Investors Yet</h3>
        <p>No one has invested in your company yet.</p>
      </div>
    `;
    return;
  }

  // Get stock history to estimate purchase dates
  const stockHistory = financeData.data.stock?.history || [];

  container.innerHTML = `
    <div class="stock-investors">
      <table class="stock-table">
        <thead>
          <tr>
            <th>Investor</th>
            <th>Shares</th>
            <th>Bought At</th>
            <th>Purchased</th>
          </tr>
        </thead>
        <tbody>
          ${investors.map(inv => {
            const boughtAt = parseFloat(inv.bought_at);
            const estimatedTime = estimatePurchaseDateFromPrice(boughtAt, stockHistory);
            return `
            <tr class="stock-table-row" data-user-id="${inv.id}">
              <td class="stock-company-name clickable" data-user-id="${inv.id}">${escapeHtml(inv.company_name)}</td>
              <td>${formatNumber(inv.total_shares)}</td>
              <td>$${formatNumber(boughtAt)}</td>
              <td class="stock-purchased-cell">${formatPurchaseDate(estimatedTime)}</td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Setup click handlers for company names
  setupCompanyNameClickHandlers(container);
}

/**
 * Setup click handlers for clickable table rows
 */
function setupCompanyNameClickHandlers(container) {
  const rows = container.querySelectorAll('.stock-table-row[data-user-id]');
  rows.forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', async () => {
      const userId = parseInt(row.dataset.userId);
      if (userId) {
        const { openPlayerProfile } = await import('./company-profile.js');
        openPlayerProfile(userId);
      }
    });
  });
}

/**
 * Open company detail overlay
 */
export async function openCompanyDetail(userId, companyName) {
  const overlay = document.getElementById('stockCompanyDetailOverlay');
  const titleEl = document.getElementById('stockCompanyTitle');
  const contentEl = document.getElementById('stockCompanyContent');

  if (!overlay || !contentEl) return;

  overlay.classList.remove('hidden');
  if (titleEl) titleEl.textContent = companyName;
  contentEl.innerHTML = '<div class="stock-loading">Loading...</div>';

  try {
    const data = await getStockFinanceOverview(userId);

    if (!data || !data.data || !data.data.stock) {
      contentEl.innerHTML = '<div class="stock-error">Failed to load company data</div>';
      return;
    }

    const stock = data.data.stock;
    const trend = stock.stock_trend || 'same';
    const stats = calculatePriceStats(stock.history || []);
    const forSale = stock.stock_for_sale || 0;
    const totalShares = stock.stock_total || 0;
    const isOwnCompany = userId === currentUserId;

    contentEl.innerHTML = `
      <div class="stock-company-detail">
        ${renderChartSection('companyDetailChart', stock, stats, { stockForSale: forSale, stockTotal: totalShares, showIncreaseButton: isOwnCompany && userHasIPO })}
        <div class="stock-buy-section">
          <div class="stock-buy-info">
            <span class="stock-buy-label">Available:</span>
            <span class="stock-buy-value">${formatNumber(forSale)} / ${formatNumber(totalShares)}</span>
          </div>
          <button id="stockBuyBtn" class="text-btn" data-action="buy" ${!userHasIPO ? 'disabled title="IPO required to purchase stocks"' : ''} ${forSale < 1 ? 'disabled title="No shares available"' : ''}>
            Buy Shares
          </button>
        </div>
      </div>
    `;

    // Setup increase shares button click handler (if own company)
    const increaseBtnEl = contentEl.querySelector('[data-action="increase"]');
    if (increaseBtnEl) {
      increaseBtnEl.addEventListener('click', handleIncreaseSharesClick);
    }

    // Initialize chart
    if (stock.history && stock.history.length > 0) {
      initializeChart('companyDetailChart', stock.history, CHART_COLORS[trend]);
    }

    // Setup buy button
    const buyBtn = document.getElementById('stockBuyBtn');
    if (buyBtn && userHasIPO && forSale > 0) {
      const currentPrice = stock.value || stats.current || 0;
      buyBtn.addEventListener('click', async () => {
        // Get current cash
        let userCash = 0;
        try {
          const response = await fetch(window.apiUrl('/api/user/get-company'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const cashData = await response.json();
          userCash = cashData.user?.cash || 0;
        } catch (err) {
          console.error('[Stock Manager] Failed to get user cash:', err);
        }

        // Show buy dialog
        const amount = await showBuyDialog(companyName, forSale, currentPrice, userCash);
        if (!amount) return;

        buyBtn.disabled = true;
        buyBtn.textContent = 'Purchasing...';

        try {
          const result = await purchaseStock(userId, amount, companyName, currentPrice);
          if (result.error) {
            showNotification(result.error, 'error');
          } else {
            showNotification(`Successfully purchased ${amount} shares!`, 'success');
            financeData = null;
            closeCompanyDetail();
          }
        } catch (error) {
          console.error('[Stock Manager] Purchase error:', error);
          showNotification('Failed to purchase shares', 'error');
        } finally {
          buyBtn.disabled = false;
          buyBtn.textContent = 'Buy Shares';
        }
      });
    }
  } catch (error) {
    console.error('[Stock Manager] Error loading company detail:', error);
    contentEl.innerHTML = '<div class="stock-error">Failed to load company data</div>';
  }
}

/**
 * Close company detail overlay
 */
function closeCompanyDetail() {
  const overlay = document.getElementById('stockCompanyDetailOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
  destroyChart();
}

/**
 * Destroy current chart instance
 */
function destroyChart() {
  if (currentChart) {
    currentChart.resizeObserver?.disconnect();
    currentChart.chart?.remove();
    currentChart = null;
  }
  chartState.maSeries = {};
}

/**
 * Render IPO alerts table with given data
 * Backend provides fully filtered data - frontend just displays it
 * @param {HTMLElement} container - Content container
 * @param {Array} ipos - Array of IPO data (already filtered by backend)
 * @param {number} maxAgeDays - Max age setting in days
 */
function renderIpoAlertsTable(container, ipos, maxAgeDays) {
  const maxAgeLabel = maxAgeDays === 1 ? '1 day' : maxAgeDays === 7 ? '1 week' : maxAgeDays === 30 ? '1 month' : '6 months';

  container.innerHTML = `
    <div class="stock-ipo-alerts">
      <div class="stock-ipo-header" id="stockIpoHeader">
        <span class="stock-ipo-header-text">Fresh IPOs - accounts younger than ${maxAgeLabel}<br>Updates automatically every 5 minutes</span>
        <span class="stock-ipo-header-close" id="stockIpoHeaderClose">&#x2715;</span>
      </div>
      <table class="stock-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Price</th>
            <th>For Sale</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          ${ipos.map(company => {
            const trend = company.stock_trend || 'same';
            const trendIcon = trend === 'up' ? '&#x25B2;' : trend === 'down' ? '&#x25BC;' : '&#x25CF;';
            return `
              <tr class="stock-table-row stock-ipo-fresh" data-user-id="${company.id}">
                <td class="stock-company-name stock-clickable" data-user-id="${company.id}">${escapeHtml(company.company_name)} <span class="stock-user-id">(${company.id})</span></td>
                <td>$${formatNumber(company.stock)} <span class="trend-${trend}">${trendIcon}</span></td>
                <td>${formatNumber(company.stock_for_sale)}</td>
                <td>${company.age_days}d</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Setup close button for header
  const closeBtn = container.querySelector('#stockIpoHeaderClose');
  const header = container.querySelector('#stockIpoHeader');
  if (closeBtn && header) {
    closeBtn.addEventListener('click', () => {
      header.style.display = 'none';
    });
  }

  // Setup row click handlers - open company profile modal
  const rows = container.querySelectorAll('.stock-table-row[data-user-id]');
  rows.forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', async () => {
      const { openPlayerProfile } = await import('./company-profile.js');
      openPlayerProfile(parseInt(row.dataset.userId));
    });
  });
}

/**
 * Load IPO Alerts tab content
 * @param {HTMLElement} container - Content container
 */
async function loadIpoAlerts(container) {
  try {
    const maxAgeDays = window.settings?.ipoAlertMaxAgeDays || 7;
    const maxAgeLabel = maxAgeDays === 1 ? '1 day' : maxAgeDays === 7 ? '1 week' : maxAgeDays === 30 ? '1 month' : '6 months';
    const result = await getRecentIpos();

    if (!result || !result.ipos || result.ipos.length === 0) {
      container.innerHTML = `
        <div class="stock-empty-state">
          <div class="stock-empty-icon">&#x1F4C8;</div>
          <h3>No Fresh IPOs</h3>
          <p>No companies with accounts younger than ${maxAgeLabel}.</p>
        </div>
      `;
      return;
    }

    renderIpoAlertsTable(container, result.ipos, maxAgeDays);
  } catch (error) {
    console.error('[Stock Manager] Error loading IPO alerts:', error);
    container.innerHTML = '<div class="stock-error">Failed to load IPO data</div>';
  }
}

/**
 * Refresh IPO Alert tab with new data from WebSocket
 * @param {Array} freshIpos - Array of fresh IPOs from backend
 * @param {number} maxAgeDays - Max age setting in days
 */
function refreshIpoAlertTab(freshIpos, maxAgeDays) {
  const container = document.querySelector('.stock-content');
  if (!container) return;

  const maxAgeLabel = maxAgeDays === 1 ? '1 day' : maxAgeDays === 7 ? '1 week' : maxAgeDays === 30 ? '1 month' : '6 months';

  if (!freshIpos || freshIpos.length === 0) {
    container.innerHTML = `
      <div class="stock-empty-state">
        <div class="stock-empty-icon">&#x1F4C8;</div>
        <h3>No Fresh IPOs</h3>
        <p>No companies with accounts younger than ${maxAgeLabel}.</p>
      </div>
    `;
    return;
  }

  renderIpoAlertsTable(container, freshIpos, maxAgeDays);
}

// Export to window for WebSocket handler
window.refreshIpoAlertTab = refreshIpoAlertTab;

/**
 * Open stock manager and switch to IPO Alerts tab
 */
export async function showStockManagerIpoAlerts() {
  const overlay = document.getElementById('stockManagerOverlay');
  if (!overlay) {
    console.error('[Stock Manager] Overlay not found');
    return;
  }

  overlay.classList.remove('hidden');
  await switchTab('ipo-alerts');
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Setup sell button handlers for investments tab
 */
function setupInvestmentSellButtons(container) {
  const sellButtons = container.querySelectorAll('[data-action="sell"]');

  sellButtons.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // Prevent row click

      const userId = parseInt(btn.dataset.userId, 10);
      const companyName = btn.dataset.company;
      const maxShares = parseInt(btn.dataset.max, 10);
      const price = parseFloat(btn.dataset.price);

      // Get current cash
      let userCash = 0;
      try {
        const response = await fetch(window.apiUrl('/api/user/get-company'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const cashData = await response.json();
        userCash = cashData.user?.cash || 0;
      } catch (err) {
        console.error('[Stock Manager] Failed to get user cash:', err);
      }

      // Show sell dialog
      const amount = await showSellDialog(companyName, maxShares, price, userCash);
      if (!amount) return;

      btn.disabled = true;
      btn.textContent = 'Selling...';

      try {
        const { sellStock } = await import('./api.js');
        const result = await sellStock(userId, amount, companyName, price);

        if (result.error) {
          showNotification(`Failed: ${result.error}`, 'error');
        } else {
          showNotification(`Sold ${formatNumber(amount)} shares of ${companyName}!`, 'success');
          // Reload investments tab
          financeData = null; // Clear cache
          switchTab('investments');
        }
      } catch (error) {
        console.error('[Stock Manager] Sell error:', error);
        showNotification('Failed to sell shares', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = `Sell (${formatNumber(maxShares)})`;
      }
    });
  });
}

/**
 * Show buy dialog and return amount to buy
 */
export async function showBuyDialog(companyName, maxShares, price, cash) {
  return showPurchaseDialog({
    title: 'Buy Shares',
    maxAmount: maxShares,
    price: price,
    cash: cash,
    unit: ' shares',
    priceLabel: 'Price per Share',
    confirmText: 'Buy Shares',
    feePercent: 0.05
  });
}

/**
 * Show sell dialog and return amount to sell
 */
export async function showSellDialog(companyName, maxShares, price, cash) {
  return showPurchaseDialog({
    title: 'Sell Shares',
    maxAmount: maxShares,
    price: price,
    cash: cash,
    unit: ' shares',
    priceLabel: 'Price per Share',
    confirmText: 'Sell Shares',
    feePercent: 0.05,
    isSell: true
  });
}

/**
 * Start countdown timers for locked shares
 */
let sellTimerInterval = null;

function startSellTimers(container) {
  // Clear any existing interval
  if (sellTimerInterval) {
    clearInterval(sellTimerInterval);
  }

  const updateTimers = () => {
    const timers = container.querySelectorAll('.stock-sell-timer');
    const now = Math.floor(Date.now() / 1000);

    timers.forEach(timer => {
      const unlockTime = parseInt(timer.dataset.unlockTime, 10);
      const remaining = unlockTime - now;

      if (remaining <= 0) {
        // Time's up - reload to show sell button
        timer.textContent = 'Ready!';
        timer.classList.add('stock-sell-ready');
      } else {
        // Format countdown
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = remaining % 60;

        if (hours > 0) {
          timer.textContent = `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
          timer.textContent = `${minutes}m ${seconds}s`;
        } else {
          timer.textContent = `${seconds}s`;
        }
      }
    });

    // Stop interval if no more timers
    if (timers.length === 0 && sellTimerInterval) {
      clearInterval(sellTimerInterval);
      sellTimerInterval = null;
    }
  };

  // Initial update
  updateTimers();

  // Update every second
  sellTimerInterval = setInterval(updateTimers, 1000);
}
