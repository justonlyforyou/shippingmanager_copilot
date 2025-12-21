/**
 * @fileoverview Depart Manager Panel
 * Draggable panel for managing vessel departures
 *
 * @module depart-manager
 */

import { isDepartInProgress } from './vessel-management.js';
import { isLocalDepartInProgress } from './harbor-map/vessel-panel.js';
import { escapeHtml } from './utils.js';
import logger from './core/logger.js';

let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let currentStatus = 'port'; // Current active tab status filter
let searchQuery = ''; // Current search query (searches across all tabs)
let searchDebounceTimer = null; // Debounce timer for search input
let portsCache = null; // Cache for port data (including drydock info)

/**
 * Update the At Port tab button to show count of vessels ready to depart
 * @param {Array} vessels - All vessels from API
 */
function updateAtPortTabCount(vessels) {
  const tabBtn = document.querySelector('.depart-tab-btn[data-status="port"]');
  if (!tabBtn) return;

  const count = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
  tabBtn.textContent = count > 0 ? `At Port (${count})` : 'At Port';
}

/**
 * Update the At Sea tab button to show count of vessels enroute (excluding drydock trips)
 * @param {Array} vessels - All vessels from API
 */
function updateAtSeaTabCount(vessels) {
  const tabBtn = document.querySelector('.depart-tab-btn[data-status="enroute"]');
  if (!tabBtn) return;

  // Exclude drydock trips - they show in Drydock tab
  const count = vessels.filter(v => v.status === 'enroute' && v.route_dry_operation !== 1).length;
  tabBtn.textContent = count > 0 ? `At Sea (${count})` : 'At Sea';
}

/**
 * Update the Pending tab button to show count of pending vessels
 * @param {Array} vessels - All vessels from API
 */
function updatePendingTabCount(vessels) {
  const tabBtn = document.querySelector('.depart-tab-btn[data-status="pending"]');
  if (!tabBtn) return;

  const count = vessels.filter(v => v.status === 'pending' || v.status === 'delivery').length;
  tabBtn.textContent = count > 0 ? `Pending (${count})` : 'Pending';
}

/**
 * Update the Moor tab button to show count of moored vessels
 * @param {Array} [vessels] - All vessels from API. If not provided, counts from DOM.
 */
function updateMoorTabCount(vessels) {
  const moorTabBtn = document.querySelector('.depart-tab-btn[data-status="mass-moor"]');
  if (!moorTabBtn) return;

  let mooredCount;

  if (vessels) {
    // Count from API data - ALL moored vessels (any status)
    mooredCount = vessels.filter(v => v.is_parked).length;
  } else {
    // Count from DOM elements (used after moor/resume operations)
    const mooredItems = document.querySelectorAll('.mass-moor-item[data-is-parked="true"]');
    mooredCount = mooredItems.length;
  }

  if (mooredCount > 0) {
    moorTabBtn.textContent = `Moor (${mooredCount})`;
  } else {
    moorTabBtn.textContent = 'Moor';
  }
}

/**
 * Update the Anchored tab button to show count of anchored vessels
 * @param {Array} vessels - All vessels from API
 */
function updateAnchorTabCount(vessels) {
  const anchorTabBtn = document.querySelector('.depart-tab-btn[data-status="anchor"]');
  if (!anchorTabBtn) return;

  const anchoredCount = vessels.filter(v => v.status === 'anchor').length;

  if (anchoredCount > 0) {
    anchorTabBtn.textContent = `Anchored (${anchoredCount})`;
  } else {
    anchorTabBtn.textContent = 'Anchored';
  }
}

/**
 * Update the DryDock tab button to show count of vessels in maintenance + enroute to drydock
 * @param {Array} vessels - All vessels from API
 */
function updateDryDockTabCount(vessels) {
  const dryDockTabBtn = document.querySelector('.depart-tab-btn[data-status="maintenance"]');
  if (!dryDockTabBtn) return;

  const maintenanceCount = vessels.filter(v => v.status === 'maintenance').length;
  const enrouteDrydockCount = vessels.filter(v => v.status === 'enroute' && v.route_dry_operation === 1).length;
  const totalCount = maintenanceCount + enrouteDrydockCount;

  if (totalCount > 0) {
    dryDockTabBtn.textContent = `DryDock (${totalCount})`;
  } else {
    dryDockTabBtn.textContent = 'DryDock';
  }
}

/**
 * Load and cache port data (for drydock info)
 * @returns {Promise<Object>} Map of port_code -> port data
 */
async function loadPortsData() {
  if (portsCache) {
    return portsCache;
  }

  try {
    const response = await fetch('/api/port/get-assigned-ports');
    const data = await response.json();

    if (response.ok && data.data?.ports) {
      // Create a map by port code for quick lookup
      portsCache = {};
      for (const port of data.data.ports) {
        portsCache[port.code] = port;
      }
      return portsCache;
    }
  } catch (error) {
    console.error('[Depart Manager] Error loading ports data:', error);
  }

  return {};
}

/**
 * Get drydock info for a port
 * @param {string} portCode - The port code (e.g., "hamburg", "new_york_city")
 * @returns {string|null} Drydock size ("L", "M", "S") or null if no drydock
 */
function getPortDrydock(portCode) {
  if (!portsCache || !portCode) return null;
  const port = portsCache[portCode];
  return port?.drydock || null;
}

/**
 * Render the Drydock tab with two sections: In Maintenance and Enroute to Drydock
 * @param {HTMLElement} contentArea - Content container
 * @param {Array} vessels - All vessels
 */
async function renderDrydockTab(contentArea, vessels) {
  // Split vessels into two groups
  const inMaintenance = vessels.filter(v => v.status === 'maintenance');
  const enrouteToDrydock = vessels.filter(v => v.status === 'enroute' && v.route_dry_operation === 1);

  if (inMaintenance.length === 0 && enrouteToDrydock.length === 0) {
    contentArea.innerHTML = '<div class="depart-empty-state">No vessels in drydock or enroute to drydock</div>';
    updateDepartButtonCount();
    return;
  }

  let html = '';

  // Section 1: In Maintenance
  if (inMaintenance.length > 0) {
    html += '<div class="depart-section-header">In Maintenance</div>';
    html += '<div class="depart-vessel-list">';
    inMaintenance.forEach(vessel => {
      html += renderVesselItem(vessel, 'maintenance');
    });
    html += '</div>';
  }

  // Section 2: Enroute to Drydock
  if (enrouteToDrydock.length > 0) {
    html += '<div class="depart-section-header">Enroute to Drydock</div>';
    html += '<div class="depart-vessel-list">';
    enrouteToDrydock.forEach(vessel => {
      html += renderDrydockEnrouteItem(vessel);
    });
    html += '</div>';
  }

  contentArea.innerHTML = html;

  // Add event handlers
  addVesselItemEventHandlers(contentArea);

  // Update button count
  updateDepartButtonCount();
}

/**
 * Render a vessel item for enroute-to-drydock section
 * @param {Object} vessel - Vessel data
 * @returns {string} HTML string
 */
function renderDrydockEnrouteItem(vessel) {
  const routeName = vessel.route_name || 'No Route';

  // Calculate ETA
  const now = Math.floor(Date.now() / 1000);
  const eta = vessel.route_end_time;
  const secondsRemaining = eta - now;

  let etaDisplay = '';
  if (secondsRemaining > 0) {
    const hours = Math.floor(secondsRemaining / 3600);
    const minutes = Math.floor((secondsRemaining % 3600) / 60);
    etaDisplay = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  } else {
    etaDisplay = 'Arriving';
  }

  // Determine direction: to drydock (outbound) or returning (inbound)
  // If destination has a drydock facility, it's outbound. Otherwise it's returning.
  const destinationPort = vessel.route_destination?.replace(/_/g, ' ') || 'Unknown';

  // Check if destination port has drydock
  const destHasDrydock = getPortDrydock(vessel.route_destination);
  const isOutbound = destHasDrydock !== null;
  const directionLabel = isOutbound ? 'To Drydock' : 'Returning';
  const directionClass = isOutbound ? 'depart-status-drydock-outbound' : 'depart-status-drydock-returning';

  // Vessel type emoji
  const typeEmoji = vessel.capacity_type === 'tanker' ? '🛢️' : '📦';

  // Custom build badge
  const isCustomBuild = vessel.type_name === 'N/A';

  const detailsHtml = `
    <div>Status: <span class="${directionClass}">${directionLabel}</span></div>
    <div>Destination: <span class="depart-port-name">${destinationPort}</span></div>
    <div>ETA: <span class="depart-eta">${etaDisplay}</span></div>
  `;

  return `
    <div class="depart-vessel-item" data-vessel-id="${vessel.id}" data-is-parked="false">
      <span class="depart-route-link depart-route-corner" data-route-name="${routeName}" title="Click to filter map by this route">(${routeName})</span>
      <span class="depart-type-corner" title="${vessel.capacity_type === 'tanker' ? 'Tanker' : 'Container'}">${typeEmoji}</span>
      <div class="depart-vessel-info">
        <div class="depart-vessel-name">
          ${escapeHtml(vessel.name)}${isCustomBuild ? '<span class="custom-build-badge" title="Custom Build">CB</span>' : ''}
          <button class="vessel-locate-btn" data-vessel-id="${vessel.id}" title="Show on map">
            <span>📍</span>
          </button>
        </div>
        <div class="depart-vessel-details">
          ${detailsHtml}
        </div>
      </div>
    </div>
  `;
}

/**
 * Initialize the depart manager panel
 */
export function initializeDepartManager() {
  const panel = document.getElementById('departManagerPanel');
  if (!panel) {
    console.warn('[Depart Manager] Panel not found');
    return;
  }

  const header = panel.querySelector('.depart-manager-header');
  const closeBtn = panel.querySelector('.depart-manager-close');
  const departAllBtn = document.getElementById('departAllFromPanel');
  const selectAllBtn = document.getElementById('selectAllVesselsBtn');
  const unselectAllBtn = document.getElementById('unselectAllVesselsBtn');
  const moorBtn = document.getElementById('moorAllBtn');
  const resumeBtn = document.getElementById('resumeAllBtn');
  const refreshBtn = document.getElementById('refreshDepartListBtn');

  // Close button handler
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDepartManager);
  }

  // Depart all button handler
  if (departAllBtn) {
    departAllBtn.addEventListener('click', async () => {
      await departSelectedVessels();
    });
  }

  // Select all button handler
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', selectAllVessels);
  }

  // Unselect all button handler
  if (unselectAllBtn) {
    unselectAllBtn.addEventListener('click', unselectAllVessels);
  }

  // Moor button handler
  if (moorBtn) {
    moorBtn.addEventListener('click', moorSelectedVessels);
  }

  // Resume button handler
  if (resumeBtn) {
    resumeBtn.addEventListener('click', resumeSelectedVessels);
  }

  // Refresh button handler
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await loadVesselsByStatus(currentStatus);
    });
  }

  // Initialize tab buttons
  const tabBtns = panel.querySelectorAll('.depart-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = btn.dataset.status;
      if (status === currentStatus) return; // Already active

      // Update active state
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentStatus = status;

      // Load vessels for this status
      await loadVesselsByStatus(status);
    });
  });

  // Initialize drag functionality
  if (header) {
    header.addEventListener('mousedown', startDrag);
  }

  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', stopDrag);

  // Search functionality
  const searchInput = document.getElementById('departManagerSearchInput');
  const searchClearBtn = document.getElementById('departManagerSearchClear');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.trim().toLowerCase();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(async () => {
        searchQuery = query;
        await searchVesselsAcrossTabs(searchQuery);
      }, 300);
    });

    // Clear on Escape key
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        clearSearch();
      }
    });
  }

  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', clearSearch);
  }

  logger.debug('[Depart Manager] Initialized');
}

/**
 * Open the depart manager panel
 * @param {string} [initialStatus='port'] - Initial tab status to show (port, enroute, pending, maintenance, anchor, mass-moor)
 */
export async function openDepartManager(initialStatus = 'port') {
  const panel = document.getElementById('departManagerPanel');
  if (panel) {
    panel.classList.remove('hidden');
    // Reset position to center
    panel.style.top = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%, -50%)';

    // Clear search when opening
    const searchInput = document.getElementById('departManagerSearchInput');
    if (searchInput) {
      searchInput.value = '';
    }
    searchQuery = '';

    // Set to specified tab and update UI
    currentStatus = initialStatus;
    const tabBtns = panel.querySelectorAll('.depart-tab-btn');
    tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.status === initialStatus);
    });

    // Load vessels with specified status
    await loadVesselsByStatus(initialStatus);
  }
}

/**
 * Load vessels filtered by status
 * @param {string} status - Vessel status filter (port, enroute, pending, maintenance, anchor, parked, mass-moor)
 */
async function loadVesselsByStatus(status) {
  const contentArea = document.querySelector('.depart-manager-content');
  if (!contentArea) return;

  contentArea.innerHTML = '<div class="depart-loading">Loading vessels...</div>';

  try {
    // Load vessels and ports data in parallel
    const [vesselResponse, _] = await Promise.all([
      fetch('/api/vessel/get-vessels'),
      loadPortsData() // Cache ports data for drydock info
    ]);
    const data = await vesselResponse.json();

    if (!vesselResponse.ok) {
      throw new Error(data.error || 'Failed to fetch vessels');
    }

    // Always update the tab counts when vessels are loaded
    updateAtPortTabCount(data.vessels);
    updateAtSeaTabCount(data.vessels);
    updatePendingTabCount(data.vessels);
    updateMoorTabCount(data.vessels);
    updateAnchorTabCount(data.vessels);
    updateDryDockTabCount(data.vessels);

    // Handle mass-moor tab separately
    if (status === 'mass-moor') {
      await renderMassMoorTab(contentArea, data.vessels);
      return;
    }

    // Handle drydock/maintenance tab separately (shows both in-maintenance and enroute-to-drydock)
    if (status === 'maintenance') {
      await renderDrydockTab(contentArea, data.vessels);
      return;
    }

    // Filter vessels based on status
    let filteredVessels;
    if (status === 'port') {
      // At port (ready to depart) - exclude moored vessels
      filteredVessels = data.vessels.filter(v => v.status === 'port' && !v.is_parked);
    } else if (status === 'pending') {
      // Pending includes both 'pending' and 'delivery' status
      filteredVessels = data.vessels.filter(v => v.status === 'pending' || v.status === 'delivery');
    } else if (status === 'enroute') {
      // Enroute but NOT on drydock operation (those go to drydock tab)
      filteredVessels = data.vessels.filter(v => v.status === 'enroute' && v.route_dry_operation !== 1);
    } else {
      // Direct status match (anchor, etc.)
      filteredVessels = data.vessels.filter(v => v.status === status);
    }

    // Get status display info
    const statusInfo = getStatusInfo(status);

    if (filteredVessels.length === 0) {
      contentArea.innerHTML = `<div class="depart-empty-state">No vessels ${statusInfo.emptyText}</div>`;
      updateDepartButtonCount();
      return;
    }

    // Build vessel list
    let html = '<div class="depart-vessel-list">';
    filteredVessels.forEach(vessel => {
      html += renderVesselItem(vessel, status);
    });
    html += '</div>';

    contentArea.innerHTML = html;

    // Add event handlers
    addVesselItemEventHandlers(contentArea);

    // Update button count (only relevant for 'port' status)
    updateDepartButtonCount();

  } catch (error) {
    console.error('[Depart Manager] Error loading vessels:', error);
    contentArea.innerHTML = `<div class="depart-error">Error: ${error.message}</div>`;
  }
}

/**
 * Search vessels across all tabs and show matching results
 * Switches to the appropriate tab if a vessel is found
 * @param {string} query - Search query (lowercase)
 */
async function searchVesselsAcrossTabs(query) {
  const contentArea = document.querySelector('.depart-manager-content');
  if (!contentArea) return;

  // Empty query - reload current tab normally
  if (!query) {
    await loadVesselsByStatus(currentStatus);
    return;
  }

  contentArea.innerHTML = '<div class="depart-loading">Searching...</div>';

  try {
    const response = await fetch('/api/vessel/get-vessels');
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch vessels');
    }

    // Search across ALL vessels (case-insensitive name match)
    const matchingVessels = data.vessels.filter(v =>
      v.name.toLowerCase().includes(query)
    );

    if (matchingVessels.length === 0) {
      contentArea.innerHTML = `<div class="depart-empty-state">No vessels matching "${escapeHtml(query)}"</div>`;
      updateDepartButtonCount();
      return;
    }

    // Group vessels by their status for display
    const vesselsByStatus = {};
    matchingVessels.forEach(vessel => {
      let status = vessel.status;
      // Normalize status for display
      if (status === 'delivery') status = 'pending';
      if (vessel.is_parked && status === 'port') status = 'moored';

      if (!vesselsByStatus[status]) {
        vesselsByStatus[status] = [];
      }
      vesselsByStatus[status].push(vessel);
    });

    // If only one vessel found, switch to its tab
    if (matchingVessels.length === 1) {
      const vessel = matchingVessels[0];
      let targetStatus = vessel.status;
      if (targetStatus === 'delivery') targetStatus = 'pending';
      if (vessel.is_parked) targetStatus = 'mass-moor';

      // Update tab UI
      const tabBtns = document.querySelectorAll('.depart-tab-btn');
      tabBtns.forEach(b => b.classList.remove('active'));
      const targetTab = document.querySelector(`.depart-tab-btn[data-status="${targetStatus}"]`);
      if (targetTab) {
        targetTab.classList.add('active');
        currentStatus = targetStatus;
      }
    }

    // Build vessel list showing all matches with status badges
    let html = '<div class="depart-vessel-list">';
    matchingVessels.forEach(vessel => {
      html += renderVesselItem(vessel, vessel.status, true); // true = show status badge
    });
    html += '</div>';

    contentArea.innerHTML = html;

    // Add event handlers
    addVesselItemEventHandlers(contentArea);
    updateDepartButtonCount();

  } catch (error) {
    console.error('[Depart Manager] Search error:', error);
    contentArea.innerHTML = `<div class="depart-error">Error: ${error.message}</div>`;
  }
}

/**
 * Clear the search and reload current tab
 */
async function clearSearch() {
  const searchInput = document.getElementById('departManagerSearchInput');
  if (searchInput) {
    searchInput.value = '';
  }
  searchQuery = '';
  await loadVesselsByStatus(currentStatus);
}

/**
 * Render Mass Moor tab with moor/resume buttons and vessel list
 * @param {HTMLElement} contentArea - Content area element
 * @param {Array} allVessels - All vessels from API
 */
async function renderMassMoorTab(contentArea, allVessels) {
  // Filter vessels into two groups:
  // 1. Moored & at port (is_parked && status === 'port')
  // 2. Moored but not at port (is_parked && status !== 'port')
  const mooredAtPort = allVessels.filter(v => v.is_parked && v.status === 'port');
  const mooredNotAtPort = allVessels.filter(v => v.is_parked && v.status !== 'port');

  if (mooredAtPort.length === 0 && mooredNotAtPort.length === 0) {
    contentArea.innerHTML = '<div class="depart-empty-state">No moored vessels</div>';
    updateDepartButtonCount();
    return;
  }

  // Sort by name
  mooredAtPort.sort((a, b) => a.name.localeCompare(b.name));
  mooredNotAtPort.sort((a, b) => a.name.localeCompare(b.name));

  // Build HTML with two sections
  let html = '';

  // Section 1: At Port
  html += '<div class="moor-section-header">At Port</div>';
  if (mooredAtPort.length > 0) {
    html += '<div class="depart-vessel-list">';
    mooredAtPort.forEach(vessel => {
      html += renderMassMoorVesselItem(vessel);
    });
    html += '</div>';
  } else {
    html += '<div class="moor-section-empty">No moored vessels at port</div>';
  }

  // Section 2: Not At Port
  html += '<div class="moor-section-header">Not At Port</div>';
  if (mooredNotAtPort.length > 0) {
    html += '<div class="depart-vessel-list">';
    mooredNotAtPort.forEach(vessel => {
      html += renderMassMoorVesselItem(vessel);
    });
    html += '</div>';
  } else {
    html += '<div class="moor-section-empty">No moored vessels in transit</div>';
  }

  contentArea.innerHTML = html;

  // Add event handlers
  addMassMoorEventHandlers(contentArea);

  // Update button visibility and counts
  updateDepartButtonCount();
}

/**
 * Render a vessel item for Mass Moor tab
 * @param {Object} vessel - Vessel data
 * @returns {string} HTML string
 */
function renderMassMoorVesselItem(vessel) {
  const routeName = vessel.route_name || 'No route';
  const currentPort = vessel.current_port_code?.replace(/_/g, ' ') || 'Unknown';
  const destination = vessel.route_destination?.replace(/_/g, ' ') || 'Unknown';

  // Status indicator: chain for moored, green dot for active
  const statusIcon = vessel.is_parked ? '⛓️' : '🟢';
  const statusClass = vessel.is_parked ? 'moored' : 'active';
  const statusText = vessel.is_parked ? 'Moored' : getVesselStatusText(vessel.status);

  // Show ETA for vessels not at port (enroute)
  let etaLine = '';
  if (vessel.status !== 'port' && vessel.route_end_time) {
    const etaText = formatETA(vessel);
    etaLine = `<div>ETA: <span class="depart-eta">${etaText}</span></div>`;
  }

  // For vessels at port show Location, for enroute show Destination
  let locationLine;
  if (vessel.status === 'port') {
    locationLine = `<div>Location: <span class="depart-port-name">${currentPort}</span></div>`;
  } else {
    locationLine = `<div>Destination: <span class="depart-port-name">${destination}</span></div>`;
  }

  return `
    <div class="depart-vessel-item mass-moor-item ${statusClass}" data-vessel-id="${vessel.id}" data-is-parked="${vessel.is_parked}">
      <span class="depart-route-link depart-route-corner" data-route-name="${routeName}" title="Click to filter map by this route">(${routeName})</span>
      <div class="depart-vessel-info">
        <div class="depart-vessel-name">
          <span class="moor-status-icon">${statusIcon}</span>
          ${escapeHtml(vessel.name)}
          <button class="vessel-locate-btn" data-vessel-id="${vessel.id}" title="Show on map">
            <span>📍</span>
          </button>
        </div>
        <div class="depart-vessel-details">
          <div>Status: <span class="moor-status-text ${statusClass}">${statusText}</span></div>
          ${locationLine}
          ${etaLine}
        </div>
      </div>
      <div class="depart-vessel-actions">
        <input type="checkbox" class="moor-vessel-checkbox" data-vessel-id="${vessel.id}" data-is-parked="${vessel.is_parked}">
      </div>
    </div>
  `;
}

/**
 * Get human-readable status text
 * @param {string} status - Vessel status
 * @returns {string} Status text
 */
function getVesselStatusText(status) {
  const statusMap = {
    'port': 'At Port',
    'enroute': 'At Sea',
    'anchor': 'Anchored'
  };
  return statusMap[status] || status;
}

/**
 * Add event handlers for Mass Moor tab content
 * @param {HTMLElement} contentArea - Content area element
 */
function addMassMoorEventHandlers(contentArea) {
  // Route link click handlers - get vessel ID from parent element
  const routeLinks = contentArea.querySelectorAll('.depart-route-link');
  routeLinks.forEach(link => {
    link.addEventListener('click', () => {
      const vesselItem = link.closest('.depart-vessel-item, .mass-moor-item');
      const vesselId = vesselItem ? parseInt(vesselItem.dataset.vesselId) : null;
      if (vesselId) {
        selectVesselRouteOnMap(vesselId);
      }
    });
  });

  // Locate button click handlers
  const locateButtons = contentArea.querySelectorAll('.vessel-locate-btn');
  locateButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = parseInt(btn.dataset.vesselId);
      locateVesselOnMap(vesselId);
    });
    btn.addEventListener('mouseover', () => {
      btn.querySelector('span').style.animation = 'pulse-arrow 0.6s ease-in-out infinite';
    });
    btn.addEventListener('mouseout', () => {
      btn.querySelector('span').style.animation = 'none';
    });
  });

  // Checkbox change handlers - update both counts for consistency
  const checkboxes = contentArea.querySelectorAll('.moor-vessel-checkbox');
  checkboxes.forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      updateMassMoorButtonCounts();
      updateDepartButtonCount();
    });
  });
}

/**
 * Update moor/resume button counts (works on all tabs)
 * Checks both .moor-vessel-checkbox (mass-moor tab) and .depart-vessel-checkbox (other tabs)
 */
function updateMoorResumeButtonCounts() {
  let toMoorCount = 0;
  let toResumeCount = 0;

  // Check both checkbox types (moor tab and other tabs)
  const allCheckboxes = document.querySelectorAll('.moor-vessel-checkbox:checked, .depart-vessel-checkbox:checked');

  allCheckboxes.forEach(cb => {
    const isParked = cb.dataset.isParked === 'true';
    if (isParked) {
      toResumeCount++;
    } else {
      toMoorCount++;
    }
  });

  const moorBtn = document.getElementById('moorAllBtn');
  const resumeBtn = document.getElementById('resumeAllBtn');

  if (moorBtn) {
    moorBtn.textContent = `⛓️ Moor (${toMoorCount})`;
    moorBtn.disabled = toMoorCount === 0;
  }

  if (resumeBtn) {
    resumeBtn.textContent = `🟢 Resume (${toResumeCount})`;
    resumeBtn.disabled = toResumeCount === 0;
  }
}

/**
 * Legacy alias for updateMoorResumeButtonCounts
 */
function updateMassMoorButtonCounts() {
  updateMoorResumeButtonCounts();
}

/**
 * Moor selected vessels (skip already moored)
 */
async function moorSelectedVessels() {
  const { showSideNotification } = await import('./utils.js');
  // Check both checkbox types
  const checkboxes = document.querySelectorAll('.moor-vessel-checkbox:checked, .depart-vessel-checkbox:checked');
  const vesselIds = [];

  checkboxes.forEach(cb => {
    const isParked = cb.dataset.isParked === 'true';
    if (!isParked) {
      vesselIds.push(parseInt(cb.dataset.vesselId));
    }
  });

  if (vesselIds.length === 0) {
    showSideNotification('No active vessels selected to moor', 'warning');
    return;
  }

  const moorBtn = document.getElementById('moorAllBtn');
  if (moorBtn) {
    moorBtn.disabled = true;
    moorBtn.textContent = '⛓️ Mooring...';
  }

  let successCount = 0;
  let errorCount = 0;

  for (const vesselId of vesselIds) {
    try {
      const response = await fetch('/api/vessel/park-vessel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vessel_id: vesselId })
      });

      const data = await response.json();
      if (response.ok && !data.error) {
        successCount++;
        // Update UI for this vessel
        updateVesselMoorState(vesselId, true);
      } else {
        errorCount++;
        console.error(`[Mass Moor] Failed to moor vessel ${vesselId}:`, data.error);
      }
    } catch (error) {
      errorCount++;
      console.error(`[Mass Moor] Error mooring vessel ${vesselId}:`, error);
    }
  }

  if (successCount > 0) {
    showSideNotification(`Moored ${successCount} vessel${successCount > 1 ? 's' : ''} successfully`, 'success');
  }
  if (errorCount > 0) {
    showSideNotification(`Failed to moor ${errorCount} vessel${errorCount > 1 ? 's' : ''}`, 'error');
  }

  // Reload current tab to reflect changes
  await loadVesselsByStatus(currentStatus);
}

/**
 * Resume selected vessels (skip already active)
 */
async function resumeSelectedVessels() {
  const { showSideNotification } = await import('./utils.js');
  // Check both checkbox types
  const checkboxes = document.querySelectorAll('.moor-vessel-checkbox:checked, .depart-vessel-checkbox:checked');
  const vesselIds = [];

  checkboxes.forEach(cb => {
    const isParked = cb.dataset.isParked === 'true';
    if (isParked) {
      vesselIds.push(parseInt(cb.dataset.vesselId));
    }
  });

  if (vesselIds.length === 0) {
    showSideNotification('No moored vessels selected to resume', 'warning');
    return;
  }

  const resumeBtn = document.getElementById('resumeAllBtn');
  if (resumeBtn) {
    resumeBtn.disabled = true;
    resumeBtn.textContent = '🟢 Resuming...';
  }

  let successCount = 0;
  let errorCount = 0;

  for (const vesselId of vesselIds) {
    try {
      const response = await fetch('/api/vessel/resume-parked-vessel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vessel_id: vesselId })
      });

      const data = await response.json();
      if (response.ok && !data.error) {
        successCount++;
        // Update UI for this vessel
        updateVesselMoorState(vesselId, false);
      } else {
        errorCount++;
        console.error(`[Mass Moor] Failed to resume vessel ${vesselId}:`, data.error);
      }
    } catch (error) {
      errorCount++;
      console.error(`[Mass Moor] Error resuming vessel ${vesselId}:`, error);
    }
  }

  if (successCount > 0) {
    showSideNotification(`Resumed ${successCount} vessel${successCount > 1 ? 's' : ''} successfully`, 'success');
  }
  if (errorCount > 0) {
    showSideNotification(`Failed to resume ${errorCount} vessel${errorCount > 1 ? 's' : ''}`, 'error');
  }

  // Reload current tab to reflect changes
  await loadVesselsByStatus(currentStatus);
}

/**
 * Update vessel UI state after moor/resume
 * @param {number} vesselId - Vessel ID
 * @param {boolean} isParked - New parked state
 */
function updateVesselMoorState(vesselId, isParked) {
  const item = document.querySelector(`.mass-moor-item[data-vessel-id="${vesselId}"]`);
  if (!item) return;

  const checkbox = item.querySelector('.moor-vessel-checkbox');
  const statusIcon = item.querySelector('.moor-status-icon');
  const statusText = item.querySelector('.moor-status-text');

  // Update data attributes
  item.dataset.isParked = isParked ? 'true' : 'false';
  if (checkbox) {
    checkbox.dataset.isParked = isParked ? 'true' : 'false';
  }

  // Update visual state
  if (isParked) {
    item.classList.remove('active');
    item.classList.add('moored');
    if (statusIcon) statusIcon.textContent = '⛓️';
    if (statusText) {
      statusText.textContent = 'Moored';
      statusText.classList.remove('active');
      statusText.classList.add('moored');
    }
  } else {
    item.classList.remove('moored');
    item.classList.add('active');
    if (statusIcon) statusIcon.textContent = '🟢';
    if (statusText) {
      statusText.textContent = 'At Port';
      statusText.classList.remove('moored');
      statusText.classList.add('active');
    }
  }
}

/**
 * Get status display information
 * @param {string} status - Vessel status
 * @returns {Object} Status info with emptyText
 */
function getStatusInfo(status) {
  const statusMap = {
    'port': { emptyText: 'in port ready to depart' },
    'enroute': { emptyText: 'currently at sea' },
    'pending': { emptyText: 'pending delivery' },
    'maintenance': { emptyText: 'in drydock' },
    'anchor': { emptyText: 'at anchor' },
    'mass-moor': { emptyText: 'available to moor/resume' }
  };
  return statusMap[status] || { emptyText: 'with this status' };
}

/**
 * Get loading/unloading status for a vessel
 * @param {Object} vessel - Vessel data
 * @returns {Object|null} { status: 'loading'|'unloading', timeLeft: seconds } or null if not loading/unloading
 */
function getLoadingStatus(vessel) {
  const ar = vessel.active_route;
  if (!ar) return null;

  const loadingLeft = ar.loading_time_left || 0;
  const arrivalLeft = ar.arrival_time_left || 0;
  const unloadingLeft = ar.unloading_time_left || 0;

  // Loading: loading_time_left > 0
  if (loadingLeft > 0) {
    return { status: 'loading', timeLeft: loadingLeft };
  }

  // Unloading: arrived (arrival_time_left == 0) but still unloading (unloading_time_left > 0)
  if (arrivalLeft === 0 && unloadingLeft > 0) {
    return { status: 'unloading', timeLeft: unloadingLeft };
  }

  return null;
}

/**
 * Format loading/unloading status with timer
 * @param {Object} loadingStatus - From getLoadingStatus()
 * @returns {string} Formatted string like "Loading - 2h 15m" or "Unloading - 45m"
 */
function formatLoadingStatus(loadingStatus) {
  if (!loadingStatus) return '';

  const seconds = loadingStatus.timeLeft;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  let timeStr = '';
  if (hours > 0) {
    timeStr = `${hours}h ${minutes}m`;
  } else {
    timeStr = `${minutes}m`;
  }

  const label = loadingStatus.status === 'loading' ? 'Loading' : 'Unloading';
  return `${label} - ${timeStr}`;
}

/**
 * Render a single vessel item based on status
 * @param {Object} vessel - Vessel data
 * @param {string} status - Current tab status
 * @returns {string} HTML string
 */
function renderVesselItem(vessel, status, showStatusBadge = false) {
  const routeName = vessel.route_name || 'No route';
  const currentPort = vessel.current_port_code?.replace(/_/g, ' ') || 'Unknown';
  const routeOrigin = vessel.route_origin?.replace(/_/g, ' ') || '';
  const routeDestination = vessel.route_destination?.replace(/_/g, ' ') || '';
  const nextDestination = currentPort === routeDestination ? routeOrigin : routeDestination;

  // Status badge for search results
  let statusBadge = '';
  if (showStatusBadge) {
    const statusLabels = {
      port: 'At Port',
      enroute: 'At Sea',
      pending: 'Pending',
      delivery: 'Pending',
      maintenance: 'DryDock',
      anchor: 'Anchored'
    };
    const label = vessel.is_parked ? 'Moored' : (statusLabels[status] || status);
    statusBadge = `<span class="depart-status-badge depart-status-${vessel.is_parked ? 'moored' : status}">${label}</span>`;
  }

  // Build details based on status
  let detailsHtml = '';

  if (status === 'port') {
    // At port - show destination and duration
    const durationText = formatDuration(vessel);
    // Check if current port has drydock
    const drydock = getPortDrydock(vessel.current_port_code);
    const drydockText = drydock ? '(with Drydock)' : '(no Drydock)';
    // Check for loading/unloading status
    const loadingStatus = getLoadingStatus(vessel);
    const loadingStatusText = loadingStatus ? ` <span class="depart-loading-status">(${formatLoadingStatus(loadingStatus)})</span>` : '';
    detailsHtml = `
      <div>At port: <span class="depart-port-name">${currentPort}</span> ${drydockText}${loadingStatusText}</div>
      <div>Destination: <span class="depart-port-name">${nextDestination || 'No route'}</span></div>
      <div>Duration: <span class="depart-duration">${durationText}</span></div>
    `;
  } else if (status === 'enroute') {
    // At sea - show ETA and route
    const etaText = formatETA(vessel);
    // Check for loading/unloading status (can still be loading at origin or unloading at destination)
    const loadingStatus = getLoadingStatus(vessel);
    const loadingStatusText = loadingStatus ? `<div>Status: <span class="depart-loading-status">${formatLoadingStatus(loadingStatus)}</span></div>` : '';
    detailsHtml = `
      <div>Route: <span class="depart-port-name">${routeOrigin}</span> - <span class="depart-port-name">${routeDestination}</span></div>
      <div>ETA: <span class="depart-eta">${etaText}</span></div>
      ${loadingStatusText}
    `;
  } else if (status === 'pending') {
    // Pending delivery - time_arrival is SECONDS REMAINING (not timestamp!)
    const remaining = vessel.time_arrival || 0;
    let timeDisplay = '';

    if (remaining > 0) {
      const days = Math.floor(remaining / 86400);
      const hours = Math.floor((remaining % 86400) / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      if (days > 0) {
        timeDisplay = `${days}d ${hours}h`;
      } else if (hours > 0) {
        timeDisplay = `${hours}h ${minutes}m`;
      } else {
        timeDisplay = `${minutes}m`;
      }
    } else {
      timeDisplay = 'Ready';
    }

    const deliveryPort = vessel.current_port_code?.replace(/_/g, ' ') || 'Unknown';
    detailsHtml = `
      <div>Status: <span class="depart-status-pending">Pending</span></div>
      <div>Delivery to: <span class="depart-port-name">${deliveryPort}</span></div>
      <div>Delivery in: <span class="depart-eta">${timeDisplay}</span></div>
    `;
  } else if (status === 'maintenance') {
    // In drydock - calculate time remaining
    const maintenanceEnd = parseInt(vessel.maintenance_end_time, 10);
    const now = Math.floor(Date.now() / 1000);
    const secondsRemaining = maintenanceEnd - now;

    let timerHtml = '';
    if (secondsRemaining > 0) {
      const hours = Math.floor(secondsRemaining / 3600);
      const minutes = Math.floor((secondsRemaining % 3600) / 60);
      timerHtml = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    } else {
      timerHtml = 'Ready';
    }

    // Check if this is a Bug-Using vessel (maintenance + still pending delivery)
    const isBugUsing = vessel.time_arrival && vessel.time_arrival > 0;
    const statusLabel = isBugUsing ? 'Bug-Using' : 'In Drydock';
    const statusClass = isBugUsing ? 'depart-status-bug-using' : 'depart-status-maintenance';

    detailsHtml = `
      <div>Status: <span class="${statusClass}">${statusLabel}</span></div>
      <div>Ready in: <span class="depart-eta">${timerHtml}</span></div>
    `;
  } else if (status === 'anchor') {
    // Anchored
    detailsHtml = `
      <div>Location: <span class="depart-port-name">${currentPort}</span></div>
      <div>Status: <span class="depart-status-anchor">At Anchor</span></div>
    `;
  }

  // Check if custom-built vessel (type_name is "N/A")
  const isCustomBuild = vessel.type_name === 'N/A';

  // Vessel type emoji (container or tanker)
  const typeEmoji = vessel.capacity_type === 'tanker' ? '🛢️' : '📦';

  // Show checkbox only on tabs where moor/resume is possible (not maintenance/pending)
  const showCheckbox = status !== 'maintenance' && status !== 'pending';
  const checkboxHtml = showCheckbox
    ? `<input type="checkbox" class="depart-vessel-checkbox" data-vessel-id="${vessel.id}" data-is-parked="${vessel.is_parked || false}">`
    : '';

  return `
    <div class="depart-vessel-item" data-vessel-id="${vessel.id}" data-is-parked="${vessel.is_parked || false}">
      <span class="depart-route-link depart-route-corner" data-route-name="${routeName}" title="Click to filter map by this route">(${routeName})</span>
      <span class="depart-type-corner" title="${vessel.capacity_type === 'tanker' ? 'Tanker' : 'Container'}">${typeEmoji}</span>
      <div class="depart-vessel-info">
        <div class="depart-vessel-name">
          ${escapeHtml(vessel.name)}${isCustomBuild ? '<span class="custom-build-badge" title="Custom Build">CB</span>' : ''}${statusBadge}
          <button class="vessel-locate-btn" data-vessel-id="${vessel.id}" title="Show on map">
            <span>📍</span>
          </button>
        </div>
        <div class="depart-vessel-details">
          ${detailsHtml}
        </div>
      </div>
      <div class="depart-vessel-actions">
        ${checkboxHtml}
      </div>
    </div>
  `;
}

/**
 * Format duration for vessel
 * @param {Object} vessel - Vessel data
 * @returns {string} Duration text
 */
function formatDuration(vessel) {
  if (vessel.active_route?.duration) {
    const hours = Math.floor(vessel.active_route.duration / 3600);
    const minutes = Math.floor((vessel.active_route.duration % 3600) / 60);
    return `${hours}h ${minutes}m`;
  } else if (vessel.route_distance && vessel.route_speed) {
    const hours = Math.floor(vessel.route_distance / vessel.route_speed);
    const minutes = Math.floor(((vessel.route_distance / vessel.route_speed) % 1) * 60);
    return `${hours}h ${minutes}m`;
  }
  return 'N/A';
}

/**
 * Format ETA for enroute vessel
 * @param {Object} vessel - Vessel data
 * @returns {string} ETA text
 */
function formatETA(vessel) {
  if (vessel.route_end_time) {
    const eta = new Date(vessel.route_end_time * 1000);
    const now = new Date();
    const diffMs = eta - now;
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      return `${hours}h ${minutes}m`;
    }
    return 'Arriving...';
  }
  return 'N/A';
}

/**
 * Add event handlers to vessel items
 * @param {HTMLElement} contentArea - Content area element
 */
function addVesselItemEventHandlers(contentArea) {
  // Route link click handlers - get vessel ID from parent element
  const routeLinks = contentArea.querySelectorAll('.depart-route-link');
  routeLinks.forEach(link => {
    link.addEventListener('click', () => {
      const vesselItem = link.closest('.depart-vessel-item, .mass-moor-item');
      const vesselId = vesselItem ? parseInt(vesselItem.dataset.vesselId) : null;
      if (vesselId) {
        selectVesselRouteOnMap(vesselId);
      }
    });
  });

  // Locate button click handlers
  const locateButtons = contentArea.querySelectorAll('.vessel-locate-btn');
  locateButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = parseInt(btn.dataset.vesselId);
      locateVesselOnMap(vesselId);
    });
    btn.addEventListener('mouseover', () => {
      btn.querySelector('span').style.animation = 'pulse-arrow 0.6s ease-in-out infinite';
    });
    btn.addEventListener('mouseout', () => {
      btn.querySelector('span').style.animation = 'none';
    });
  });

  // Checkbox change handlers (only for port status)
  const checkboxes = contentArea.querySelectorAll('.depart-vessel-checkbox');
  checkboxes.forEach(checkbox => {
    checkbox.addEventListener('change', updateDepartButtonCount);
  });
}

/**
 * Update the depart button count based on selected checkboxes, lock state, and current tab
 */
function updateDepartButtonCount() {
  const departAllBtn = document.getElementById('departAllFromPanel');
  const moorBtn = document.getElementById('moorAllBtn');
  const resumeBtn = document.getElementById('resumeAllBtn');
  const selectAllBtn = document.getElementById('selectAllVesselsBtn');
  const unselectAllBtn = document.getElementById('unselectAllVesselsBtn');

  // Depart button only shown on 'port' tab
  const showDepartButton = currentStatus === 'port';
  // Moor/Resume buttons NOT shown on 'maintenance' (DryDock) or 'pending' tabs - game doesn't support it
  const showMoorResumeButtons = currentStatus !== 'maintenance' && currentStatus !== 'pending';

  // Depart button (only for 'port' tab)
  if (departAllBtn) {
    departAllBtn.style.display = showDepartButton ? '' : 'none';
    if (showDepartButton) {
      const checkboxes = document.querySelectorAll('.depart-vessel-checkbox:checked');
      const count = checkboxes.length;
      const isLocked = isDepartInProgress() || isLocalDepartInProgress();
      if (isLocked) {
        departAllBtn.textContent = '🚢 Departing...';
        departAllBtn.disabled = true;
      } else {
        departAllBtn.textContent = `🚢 Depart (${count})`;
        departAllBtn.disabled = count === 0;
      }
    }
  }

  // Moor/Resume buttons (hidden on DryDock tab)
  if (moorBtn) {
    moorBtn.style.display = showMoorResumeButtons ? '' : 'none';
  }
  if (resumeBtn) {
    resumeBtn.style.display = showMoorResumeButtons ? '' : 'none';
  }
  if (selectAllBtn) {
    selectAllBtn.style.display = showMoorResumeButtons ? '' : 'none';
  }
  if (unselectAllBtn) {
    unselectAllBtn.style.display = showMoorResumeButtons ? '' : 'none';
  }

  // Update moor/resume counts based on selected checkboxes (only if visible)
  if (showMoorResumeButtons) {
    updateMoorResumeButtonCounts();
  }
}

/**
 * Update depart button state when lock status changes
 * Called from vessel-management.js when server lock state updates
 */
export function updateDepartManagerLockState() {
  const panel = document.getElementById('departManagerPanel');
  // Only update if panel is visible
  if (panel && !panel.classList.contains('hidden')) {
    updateDepartButtonCount();
  }
}

// Expose to window for cross-module access
window.updateDepartManagerLockState = updateDepartManagerLockState;

/**
 * Select all vessel checkboxes
 */
function selectAllVessels() {
  const checkboxes = document.querySelectorAll('.depart-vessel-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = true;
  });
  updateDepartButtonCount();
}

/**
 * Unselect all vessel checkboxes
 */
function unselectAllVessels() {
  const checkboxes = document.querySelectorAll('.depart-vessel-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = false;
  });
  updateDepartButtonCount();
}

/**
 * Select a vessel's route on the map (opens route panel with vessel)
 * @param {number} vesselId - Vessel ID to show route for
 */
function selectVesselRouteOnMap(vesselId) {
  // Keep depart manager open - it's a floating panel that should stay visible

  // Select vessel on route panel (same as clicking route-vessel-item in harbor map)
  if (window.harborMap && window.harborMap.selectRouteVessel) {
    window.harborMap.selectRouteVessel(vesselId);
  } else {
    console.warn(`[Depart Manager] harborMap.selectRouteVessel not available`);
  }
}

/**
 * Locate vessel on map (same as vessel-locate-btn in sell vessels overlay)
 * @param {number} vesselId - Vessel ID to locate
 */
function locateVesselOnMap(vesselId) {
  // Keep depart manager open - it's a floating panel that should stay visible

  // Select vessel on map (opens vessel panel and zooms to it)
  if (window.harborMap && window.harborMap.selectVesselFromMap) {
    window.harborMap.selectVesselFromMap(vesselId);
  } else {
    console.warn(`[Depart Manager] Cannot locate vessel ${vesselId} - selectVesselFromMap not available`);
  }
}

/**
 * Depart selected vessels only
 */
async function departSelectedVessels() {
  const { showSideNotification, showNotification } = await import('./utils.js');
  const checkboxes = document.querySelectorAll('.depart-vessel-checkbox:checked');
  const vesselIds = Array.from(checkboxes).map(cb => parseInt(cb.dataset.vesselId));

  if (vesselIds.length === 0) {
    console.warn('[Depart Manager] No vessels selected');
    return;
  }

  const departAllBtn = document.getElementById('departAllFromPanel');
  if (departAllBtn) {
    departAllBtn.disabled = true;
    departAllBtn.textContent = `🚢 Departing...`;
  }

  try {
    // Call depart API with specific vessel IDs
    const response = await fetch('/api/route/depart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: vesselIds })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to depart vessels');
    }

    console.log(`[Depart Manager] Departed ${result.departedCount} vessels, failed ${result.failedCount || 0}`);

    // Get IDs of successfully departed vessels
    const departedIds = new Set();
    if (result.departedVessels && result.departedVessels.length > 0) {
      result.departedVessels.forEach(v => departedIds.add(v.vesselId));
    }

    // Only remove successfully departed vessels from list
    departedIds.forEach(id => {
      const item = document.querySelector(`.depart-vessel-item[data-vessel-id="${id}"]`);
      if (item) {
        item.remove();
      }
    });

    // Show notification for failed vessels
    if (result.failedCount > 0 && result.failedVessels && result.failedVessels.length > 0) {
      const failedList = result.failedVessels.map(v => `${v.name}: ${v.reason}`).join('\n');
      console.warn('[Depart Manager] Failed vessels:', failedList);

      // Build vessel list HTML - matching Cargo Marshal pattern
      const vesselListHtml = result.failedVessels.map(v => {
        const cleanName = v.name.replace(/^(MV|MS|MT|SS)\s+/i, '');
        return `<div style="font-size: 0.85em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
          <span style="color: #ef4444;">${cleanName}:</span> <span style="color: #9ca3af;">${v.reason}</span>
        </div>`;
      }).join('');

      // Side notification matching Cargo Marshal pattern
      showSideNotification(`
        <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
          <strong style="font-size: 1.1em;">Depart Manager: ${result.failedCount} vessel${result.failedCount > 1 ? 's' : ''} not departed</strong>
        </div>
        <div style="margin-top: 8px;">
          <strong>Failed to depart:</strong>
          <div class="notification-vessel-list" style="margin-top: 6px;">
            ${vesselListHtml}
          </div>
        </div>
      `, 'warning', 15000);

      // Desktop notification with details
      const failedText = result.failedVessels.map(v => `${v.name}: ${v.reason}`).join('\n');
      showNotification(
        'Depart Manager',
        { body: `${result.failedCount} vessel${result.failedCount > 1 ? 's' : ''} not departed\n\n${failedText}` }
      );

      // Uncheck failed vessels so user can see which ones failed
      result.failedVessels.forEach(v => {
        // Find vessel by name since we might not have vesselId in failed response
        const items = document.querySelectorAll('.depart-vessel-item');
        items.forEach(item => {
          const nameEl = item.querySelector('.depart-vessel-name');
          if (nameEl && nameEl.textContent.includes(v.name)) {
            const checkbox = item.querySelector('.depart-vessel-checkbox');
            if (checkbox) {
              checkbox.checked = false;
            }
            // Add visual indicator for failed vessel
            item.classList.add('depart-failed');
            // Add reason tooltip
            item.title = `Failed: ${v.reason}`;
            // Add reason text below vessel name
            const detailsEl = item.querySelector('.depart-vessel-details');
            if (detailsEl) {
              const reasonDiv = document.createElement('div');
              reasonDiv.className = 'depart-fail-reason';
              reasonDiv.textContent = v.reason;
              detailsEl.prepend(reasonDiv);
            }
          }
        });
      });
    }

    // NOTE: Success notification is shown via WebSocket (vessels_depart_complete event)
    // in chat.js handleVesselsDepartComplete() - no duplicate notification here

    // Update button count
    updateDepartButtonCount();

    // Check if list is empty
    const remainingItems = document.querySelectorAll('.depart-vessel-item');
    if (remainingItems.length === 0) {
      const contentArea = document.querySelector('.depart-manager-content');
      if (contentArea) {
        contentArea.innerHTML = '<div class="depart-empty-state">All vessels departed</div>';
      }
    }

  } catch (error) {
    console.error('[Depart Manager] Error departing vessels:', error);
    showSideNotification(`Depart failed: ${error.message}`, 'error');
    if (departAllBtn) {
      departAllBtn.disabled = false;
    }
    updateDepartButtonCount();
  }
}

/**
 * Close the depart manager panel
 * Triggers map reset to show cached data at default zoom
 */
export function closeDepartManager() {
  const panel = document.getElementById('departManagerPanel');
  if (panel) {
    panel.classList.add('hidden');
  }

  // Reset map to show cached data and center at default zoom
  if (window.harborMap && window.harborMap.deselectAll) {
    window.harborMap.deselectAll();
  }
}

/**
 * Toggle the depart manager panel
 */
export function toggleDepartManager() {
  const panel = document.getElementById('departManagerPanel');
  if (panel) {
    if (panel.classList.contains('hidden')) {
      openDepartManager();
    } else {
      closeDepartManager();
    }
  }
}

/**
 * Refresh the depart manager if it's currently open
 * Called after vessel departures or route assignments to update the list
 */
export async function refreshDepartManagerIfOpen() {
  const panel = document.getElementById('departManagerPanel');
  if (panel && !panel.classList.contains('hidden')) {
    await loadVesselsByStatus(currentStatus);
  }
}

/**
 * Start dragging the panel
 * @param {MouseEvent} e - Mouse event
 */
function startDrag(e) {
  const panel = document.getElementById('departManagerPanel');
  if (!panel) return;

  isDragging = true;
  panel.classList.add('dragging');

  // Get current visual position on screen
  const rect = panel.getBoundingClientRect();

  // Calculate offset from mouse to panel corner
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;

  // Set position to current visual position and remove transform in one go
  // This prevents the jump
  panel.style.left = rect.left + 'px';
  panel.style.top = rect.top + 'px';
  panel.style.transform = 'none';

  e.preventDefault();
}

/**
 * Drag the panel
 * @param {MouseEvent} e - Mouse event
 */
function drag(e) {
  if (!isDragging) return;

  const panel = document.getElementById('departManagerPanel');
  if (!panel) return;

  const newX = e.clientX - dragOffsetX;
  const newY = e.clientY - dragOffsetY;

  // Keep panel within viewport bounds
  const maxX = window.innerWidth - panel.offsetWidth;
  const maxY = window.innerHeight - panel.offsetHeight;

  panel.style.left = Math.max(0, Math.min(newX, maxX)) + 'px';
  panel.style.top = Math.max(0, Math.min(newY, maxY)) + 'px';

  e.preventDefault();
}

/**
 * Stop dragging the panel
 */
function stopDrag() {
  if (!isDragging) return;

  isDragging = false;
  const panel = document.getElementById('departManagerPanel');
  if (panel) {
    panel.classList.remove('dragging');
  }
}
