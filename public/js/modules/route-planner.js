/**
 * @fileoverview Route Planner Panel
 * Draggable panel for planning vessel routes
 *
 * @module route-planner
 */

import { showSideNotification } from './utils.js';

// Drag state
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

// Current state
let currentVesselId = null;
let currentVesselName = null;
let currentOriginPort = null;
let selectedPort = null;
let selectedRoute = null;
let vesselPorts = null;
let currentHighlightedPorts = null; // Currently filtered/highlighted ports
let currentVesselData = null; // Vessel data for formula calculations

// Planning mode state (exported for map-controller)
let planningMode = false;

// ============================================
// GAME FORMULA CALCULATIONS
// Source: DISCOVERED_FORMULAS.md
// ============================================

/**
 * Calculate Route Creation Fee
 * Formula: routeFee = 40 * capacity + 10 * distance
 * @param {number} capacity - Total vessel capacity (TEU)
 * @param {number} distance - Route distance (nm)
 * @param {string} capacityType - 'container' or 'tanker'
 * @returns {number} Route creation fee in $
 */
function calculateRouteCreationFee(capacity, distance, capacityType = 'container') {
  let effectiveCapacity = capacity;
  if (capacityType === 'tanker') {
    effectiveCapacity = capacity / 74;
  }
  return Math.round(40 * effectiveCapacity + 10 * distance);
}

/**
 * Calculate Travel Time
 * Formula: base_time = 600 + 6 * min(200, distance)
 *          if distance > 200: time = base_time + ((distance - 200) / speed) * 75
 * @param {number} distance - Route distance (nm)
 * @param {number} speed - Vessel speed (kn)
 * @returns {number} Travel time in seconds
 */
function calculateTravelTime(distance, speed) {
  const baseTime = 600 + 6 * Math.min(200, distance);
  if (distance <= 200) {
    return baseTime;
  }
  return Math.floor(baseTime + ((distance - 200) / speed) * 75);
}

/**
 * Format seconds to HH:MM:SS
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
function formatTravelTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Calculate Harbor Fee MIN/MAX per TEU
 * Formula: MIN = 17000 / distance
 *          MAX = (17000 / distance) * 27000^0.2 = (17000 / distance) * 7.697
 * @param {number} distance - Route distance (nm)
 * @returns {{min: number, max: number}} Harbor fee range per TEU
 */
function calculateHarborFeeRange(distance) {
  if (!distance || distance <= 0) {
    return { min: 0, max: 0 };
  }
  const base = 17000 / distance;
  const maxMultiplier = Math.pow(27000, 0.2); // ~7.697
  return {
    min: base,
    max: base * maxMultiplier
  };
}

/**
 * Calculate Fuel Consumption
 * Formula: fuel = (capacity / 2000) * distance * sqrt(speed) / 20 * fuel_factor
 * @param {number} capacity - Vessel capacity (TEU)
 * @param {number} distance - Route distance (nm)
 * @param {number} speed - Vessel speed (kn)
 * @param {number} fuelFactor - Vessel fuel factor (default 1)
 * @param {string} capacityType - 'container' or 'tanker'
 * @returns {number} Fuel consumption in tonnes
 */
function calculateFuelConsumption(capacity, distance, speed, fuelFactor = 1, capacityType = 'container') {
  let effectiveCapacity = capacity;
  if (capacityType === 'tanker') {
    effectiveCapacity = capacity / 74;
  }
  return (effectiveCapacity / 2000) * distance * Math.sqrt(speed) / 20 * fuelFactor;
}

/**
 * Calculate Guards Cost
 * Formula: guardsCost = guards * 700
 * @param {number} guards - Number of guards
 * @returns {number} Guards cost in $
 */
function calculateGuardsCost(guards) {
  return guards * 700;
}

/**
 * Danger zone name mapping
 */
const DANGER_ZONE_NAMES = {
  'west_african_coast': 'West African Coast',
  'caribbean_sea': 'Caribbean Sea',
  'gulf_of_aden': 'Gulf of Aden',
  'strait_of_malacca': 'Strait of Malacca',
  'south_china_sea': 'South China Sea'
};

/**
 * Initialize the route planner panel
 */
export function initializeRoutePlanner() {
  const panel = document.getElementById('routePlannerPanel');
  if (!panel) {
    console.warn('[Route Planner] Panel not found');
    return;
  }

  const header = panel.querySelector('.route-planner-header');
  const closeBtn = panel.querySelector('.route-planner-close');

  // Close button handler
  if (closeBtn) {
    closeBtn.addEventListener('click', closeRoutePlanner);
  }

  // Tab buttons
  const tabBtns = panel.querySelectorAll('.route-planner-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });

  // Port filter buttons
  const filterBtns = panel.querySelectorAll('.route-planner-filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.filter;
      applyPortFilter(filter);
    });
  });

  // Create route button
  const createBtn = document.getElementById('routePlannerCreateBtn');
  if (createBtn) {
    createBtn.addEventListener('click', createRoute);
  }

  // Clear route selection button
  const clearRouteBtn = document.getElementById('routePlannerClearRoute');
  if (clearRouteBtn) {
    clearRouteBtn.addEventListener('click', clearRouteSelection);
  }

  // Route tab buttons
  const cancelBtn = document.getElementById('routePlannerCancelBtn');
  const saveBtn = document.getElementById('routePlannerSaveBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeRoutePlanner);
  }
  if (saveBtn) {
    saveBtn.addEventListener('click', saveRouteChanges);
  }

  // Sliders (Route Tab)
  const speedSlider = document.getElementById('routePlannerSpeedSlider');
  const guardsSlider = document.getElementById('routePlannerGuardsSlider');
  if (speedSlider) {
    speedSlider.addEventListener('input', updateSliderDisplays);
  }
  if (guardsSlider) {
    guardsSlider.addEventListener('input', updateSliderDisplays);
  }

  // Speed slider in Ports Tab (for formula preview)
  const portsSpeedSlider = document.getElementById('routePlannerPortsSpeedSlider');
  if (portsSpeedSlider) {
    portsSpeedSlider.addEventListener('input', updatePortsSpeedDisplay);
  }

  // Guards slider in Ports Tab (for piracy zones)
  const portsGuardsSlider = document.getElementById('routePlannerPortsGuardsSlider');
  if (portsGuardsSlider) {
    portsGuardsSlider.addEventListener('input', updatePortsGuardsDisplay);
  }

  // Initialize drag functionality
  if (header) {
    header.addEventListener('mousedown', startDrag);
  }

  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', stopDrag);

  console.log('[Route Planner] Initialized');
}

/**
 * Open the route planner panel for a vessel
 * @param {number} vesselId - Vessel ID
 * @param {string} vesselName - Vessel name
 */
export async function openRoutePlanner(vesselId, vesselName) {
  const panel = document.getElementById('routePlannerPanel');
  if (!panel) return;

  // Set current vessel
  currentVesselId = vesselId;
  currentVesselName = vesselName;

  // Get vessel data to find origin port and store vessel info for calculations
  let originPort = null;
  currentVesselData = null;

  if (window.harborMap && window.harborMap.getVesselById) {
    const vessel = await window.harborMap.getVesselById(vesselId);
    if (vessel) {
      originPort = vessel.current_port_code || vessel.origin_port || null;

      // Calculate total capacity from capacity_max
      let totalCapacity = 0;
      if (vessel.capacity_max) {
        totalCapacity = (vessel.capacity_max.dry || 0) + (vessel.capacity_max.refrigerated || 0);
      }

      // Store vessel data for formula calculations
      currentVesselData = {
        capacity: totalCapacity,
        maxSpeed: vessel.max_speed || 20,
        fuelFactor: vessel.fuel_factor || 1,
        co2Factor: vessel.co2_factor || 1,
        capacityType: vessel.capacity_type || 'container',
        status: vessel.status
      };

      console.log(`[Route Planner] Vessel data:`, currentVesselData);
      console.log(`[Route Planner] Vessel origin port: ${originPort}`);

      // Update speed slider max based on vessel
      const portsSpeedSlider = document.getElementById('routePlannerPortsSpeedSlider');
      if (portsSpeedSlider && currentVesselData.maxSpeed) {
        portsSpeedSlider.max = currentVesselData.maxSpeed;
        portsSpeedSlider.value = Math.min(6, currentVesselData.maxSpeed);
        const speedValue = document.getElementById('routePlannerPortsSpeedValue');
        if (speedValue) {
          speedValue.textContent = `${portsSpeedSlider.value} kn`;
        }
      }
    }
  }
  currentOriginPort = originPort;

  // Update header
  const nameSpan = panel.querySelector('.route-planner-vessel-name');
  if (nameSpan) {
    nameSpan.textContent = vesselName;
  }

  // Reset state
  selectedPort = null;
  selectedRoute = null;
  vesselPorts = null;

  // Enable planning mode
  planningMode = true;

  // Show panel
  panel.classList.remove('hidden');
  panel.style.top = '50%';
  panel.style.left = '50%';
  panel.style.transform = 'translate(-50%, -50%)';

  // Hide selected info initially
  const selectedInfo = panel.querySelector('.route-planner-selected-info');
  if (selectedInfo) {
    selectedInfo.classList.add('hidden');
  }

  // Disable create button
  const createBtn = document.getElementById('routePlannerCreateBtn');
  if (createBtn) {
    createBtn.disabled = true;
  }

  // Load vessel ports data
  await loadVesselPorts();

  // Check if vessel has an active route and update Route tab
  let hasActiveRoute = false;
  if (window.harborMap && window.harborMap.getVesselById) {
    const vessel = await window.harborMap.getVesselById(vesselId, true);
    if (vessel && vessel.route_destination && vessel.status !== 'anchor') {
      hasActiveRoute = true;
      updateRouteTabWithCurrentRoute(vessel);
    }
  }

  // Update Route tab visibility based on active route (populates in background)
  updateRouteTabVisibility(hasActiveRoute);

  // Always start on Ports tab - user can manually switch to Route tab if needed
  switchTab('ports');

  console.log(`[Route Planner] Opened for vessel ${vesselId} (${vesselName}), origin: ${originPort}, hasActiveRoute: ${hasActiveRoute}`);
}

/**
 * Close the route planner panel
 * @param {boolean} keepRouteVisible - If true, don't clear the route (for after route creation)
 */
export function closeRoutePlanner(keepRouteVisible = false) {
  const panel = document.getElementById('routePlannerPanel');
  if (panel) {
    panel.classList.add('hidden');
    panel.classList.remove('dragging');
  }

  // Reset drag state
  isDragging = false;

  // Disable planning mode
  planningMode = false;

  // Reset map state: clear route, restore zoom, and re-render with filters
  // (unless we want to keep route visible briefly after creation)
  if (!keepRouteVisible && window.harborMap && window.harborMap.deselectAll) {
    window.harborMap.deselectAll();
  } else if (!keepRouteVisible) {
    // Fallback if deselectAll not available
    if (window.harborMap && window.harborMap.clearRoute) {
      window.harborMap.clearRoute();
    }
    if (window.harborMap && window.harborMap.resetPortDisplay) {
      window.harborMap.resetPortDisplay();
    }
  }

  // Close vessel panel
  const vesselPanel = document.getElementById('vessel-detail-panel');
  if (vesselPanel) {
    vesselPanel.classList.remove('active');
  }

  // Clean up dynamically added route info section
  const routeInfoSection = document.querySelector('.route-planner-current-route-info');
  if (routeInfoSection) {
    routeInfoSection.remove();
  }

  // Reset Route tab visibility to default (no route)
  updateRouteTabVisibility(false);

  // Reset state
  currentVesselId = null;
  currentVesselName = null;
  currentOriginPort = null;
  selectedPort = null;
  selectedRoute = null;
  vesselPorts = null;
  currentHighlightedPorts = null;
  currentVesselData = null;

  console.log('[Route Planner] Closed');
}

/**
 * Check if planning mode is active
 * @returns {boolean}
 */
export function isPlanningMode() {
  return planningMode;
}

/**
 * Get current planning vessel ID
 * @returns {number|null}
 */
export function getPlanningVesselId() {
  return currentVesselId;
}

/**
 * Restore planning state after port panel is closed
 * Re-highlights ports and shows vessel panel
 */
export async function restorePlanningState() {
  if (!planningMode || !currentVesselId) {
    console.log('[Route Planner] No planning state to restore');
    return;
  }

  console.log(`[Route Planner] Restoring planning state for vessel ${currentVesselId}`);

  // Re-draw route if we had one selected
  if (selectedRoute && selectedRoute.path && currentOriginPort && selectedPort) {
    if (window.harborMap && window.harborMap.drawRoute) {
      const routeForMap = {
        path: selectedRoute.path,
        origin: currentOriginPort,
        destination: selectedPort.code
      };
      const portsForRoute = vesselPorts?.all?.ports || [];
      window.harborMap.drawRoute(routeForMap, portsForRoute, false);
      console.log(`[Route Planner] Restored route: ${currentOriginPort} -> ${selectedPort.code}`);
    }
  }

  // Re-highlight ports if we had a filter active
  if (currentHighlightedPorts && currentHighlightedPorts.length > 0) {
    if (window.harborMap && window.harborMap.highlightPorts) {
      window.harborMap.highlightPorts(currentHighlightedPorts, currentVesselId);
    }
  }

  // Re-select the vessel to show vessel panel
  if (window.harborMap && window.harborMap.selectVesselFromMap) {
    await window.harborMap.selectVesselFromMap(currentVesselId);
  }
}

/**
 * Switch between tabs
 * @param {string} tab - Tab name ('ports' or 'route')
 */
function switchTab(tab) {
  const panel = document.getElementById('routePlannerPanel');
  if (!panel) return;

  // Update tab buttons
  const tabBtns = panel.querySelectorAll('.route-planner-tab-btn');
  tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Update tab content
  const tabContents = panel.querySelectorAll('.route-planner-tab-content');
  tabContents.forEach(content => {
    content.classList.toggle('active', content.dataset.tab === tab);
  });
}

/**
 * Update Route tab visibility based on whether vessel has active route
 * @param {boolean} hasActiveRoute - Whether vessel has an active route
 */
function updateRouteTabVisibility(hasActiveRoute) {
  const noRouteSection = document.querySelector('.route-planner-no-route');
  const routeSettingsSection = document.querySelector('.route-planner-route-settings');

  if (noRouteSection) {
    noRouteSection.classList.toggle('hidden', hasActiveRoute);
  }

  if (routeSettingsSection) {
    routeSettingsSection.classList.toggle('hidden', !hasActiveRoute);
  }
}

/**
 * Populate Route tab with current vessel route info
 * @param {Object} vessel - Vessel object with route data
 */
function updateRouteTabWithCurrentRoute(vessel) {
  if (!vessel) return;

  // Get route settings section and add route info display
  const routeSettingsSection = document.querySelector('.route-planner-route-settings');
  if (!routeSettingsSection) return;

  // Check if route info section already exists, if not create it
  let routeInfoSection = routeSettingsSection.querySelector('.route-planner-current-route-info');
  if (!routeInfoSection) {
    routeInfoSection = document.createElement('div');
    routeInfoSection.className = 'route-planner-current-route-info';
    // Insert at the beginning of route settings
    routeSettingsSection.insertBefore(routeInfoSection, routeSettingsSection.firstChild);
  }

  // Build route info display
  const originName = formatPortName(vessel.route_origin);
  const destName = formatPortName(vessel.route_destination);
  const distance = vessel.route_distance ? Math.floor(vessel.route_distance).toLocaleString() : 'N/A';
  const speed = vessel.route_speed || 'N/A';

  // Calculate ETA as remaining time (only for enroute vessels)
  let etaHtml = '';
  if (vessel.status === 'enroute' && vessel.route_end_time) {
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = vessel.route_end_time - now;
    if (remainingSeconds > 0) {
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.floor((remainingSeconds % 3600) / 60);
      etaHtml = `
      <div class="route-detail-row">
        <span class="route-detail-label">ETA:</span>
        <span class="route-detail-value">${hours}h ${minutes}m</span>
      </div>`;
    }
  }

  // Build guards info (only show if defined)
  let guardsHtml = '';
  if (vessel.route_guards !== undefined && vessel.route_guards !== null) {
    guardsHtml = `
      <div class="route-detail-row">
        <span class="route-detail-label">Guards:</span>
        <span class="route-detail-value">${vessel.route_guards}</span>
      </div>`;
  }

  routeInfoSection.innerHTML = `
    <div class="route-planner-current-route-header">Current Route</div>
    <div class="route-planner-current-route-ports">
      <span class="route-origin">${originName}</span>
      <span class="route-arrow">-></span>
      <span class="route-destination">${destName}</span>
    </div>
    <div class="route-planner-current-route-details">
      <div class="route-detail-row">
        <span class="route-detail-label">Distance:</span>
        <span class="route-detail-value">${distance} nm</span>
      </div>
      <div class="route-detail-row">
        <span class="route-detail-label">Speed:</span>
        <span class="route-detail-value">${speed} kn</span>
      </div>
      ${guardsHtml}
      ${etaHtml}
      <div class="route-detail-row">
        <span class="route-detail-label">Status:</span>
        <span class="route-detail-value route-status-${vessel.status}">${vessel.status}</span>
      </div>
    </div>
  `;

  // Update speed slider with current route speed
  const speedSlider = document.getElementById('routePlannerSpeedSlider');
  const speedValue = document.getElementById('routePlannerSpeedValue');
  if (speedSlider) {
    // Set max to vessel's max speed
    if (vessel.max_speed) {
      speedSlider.max = vessel.max_speed;
    }
    // Set value to current route speed (use !== undefined to allow 0)
    if (vessel.route_speed !== undefined && vessel.route_speed !== null) {
      speedSlider.value = vessel.route_speed;
      if (speedValue) {
        speedValue.textContent = `${vessel.route_speed} kn`;
      }
    }
  }

  // Update guards slider with current route guards
  const guardsSlider = document.getElementById('routePlannerGuardsSlider');
  const guardsValue = document.getElementById('routePlannerGuardsValue');
  const guardsCost = document.getElementById('routePlannerGuardsCost');
  if (guardsSlider && vessel.route_guards !== undefined) {
    guardsSlider.value = vessel.route_guards;
    if (guardsValue) {
      guardsValue.textContent = vessel.route_guards;
    }
    if (guardsCost) {
      guardsCost.textContent = `$${calculateGuardsCost(vessel.route_guards).toLocaleString()}`;
    }
  }

  console.log(`[Route Planner] Updated Route tab with current route: ${originName} -> ${destName}`);
}

/**
 * Load vessel ports from API
 */
async function loadVesselPorts() {
  if (!currentVesselId) return;

  const content = document.querySelector('#routePlannerPanel .route-planner-content');
  if (!content) return;

  try {
    const response = await fetch('/api/route/get-vessel-ports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_vessel_id: currentVesselId })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch vessel ports');
    }

    const data = await response.json();
    vesselPorts = data.data;

    console.log('[Route Planner] Loaded ports:', {
      local: vesselPorts?.local?.ports?.length,
      all: vesselPorts?.all?.ports?.length,
      metropolis: vesselPorts?.metropolis?.ports?.length
    });

  } catch (error) {
    console.error('[Route Planner] Failed to load ports:', error);
    showError('Failed to load port data');
  }
}

/**
 * Apply port filter on map
 * @param {string} filter - Filter type ('local', 'suggested', 'metropol', 'all')
 */
async function applyPortFilter(filter) {
  if (!vesselPorts) {
    console.warn('[Route Planner] No port data loaded - vesselPorts is null/undefined');
    console.log('[Route Planner] Attempting to reload ports...');
    await loadVesselPorts();
    if (!vesselPorts) {
      console.error('[Route Planner] Still no port data after reload');
      return;
    }
  }

  // Update button states
  const filterBtns = document.querySelectorAll('.route-planner-filter-btn');
  filterBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  let ports = [];

  switch (filter) {
    case 'local':
      ports = vesselPorts.local?.ports || [];
      console.log(`[Route Planner] Local ports raw:`, vesselPorts.local);
      break;
    case 'suggested':
      await loadSuggestedRoute();
      return;
    case 'metropol':
      ports = vesselPorts.metropolis?.ports || [];
      console.log(`[Route Planner] Metropolis ports raw:`, vesselPorts.metropolis);
      break;
    case 'all':
      ports = vesselPorts.all?.ports || [];
      console.log(`[Route Planner] All ports raw:`, vesselPorts.all);
      break;
  }

  console.log(`[Route Planner] Applying filter '${filter}' with ${ports.length} ports`);

  // Save current state for restore
  currentHighlightedPorts = ports;

  // Tell map-controller to highlight these ports
  if (window.harborMap && window.harborMap.highlightPorts) {
    window.harborMap.highlightPorts(ports, currentVesselId);
  }
}

/**
 * Load suggested route from API
 * Response structure: data.suggested.routes[0] contains the route with destination port
 */
async function loadSuggestedRoute() {
  if (!currentVesselId) {
    showSideNotification('No vessel selected', 'warning');
    return;
  }

  try {
    console.log(`[Route Planner] Loading suggested route for vessel ${currentVesselId}...`);

    const response = await fetch('/api/route/get-suggested-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_vessel_id: currentVesselId })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch suggested route');
    }

    const data = await response.json();
    console.log('[Route Planner] Suggested route response:', data);

    // API returns data.suggested.routes[0] structure (based on game code analysis)
    const suggestedRoutes = data.data?.suggested?.routes;

    if (suggestedRoutes && suggestedRoutes.length > 0) {
      const suggestedRoute = suggestedRoutes[0];
      // The route object should have destination port info
      // Try different property names the API might use
      const suggestedPort = suggestedRoute.destination ||
                            suggestedRoute.destination_port ||
                            suggestedRoute.port2 ||
                            suggestedRoute.to;

      if (suggestedPort) {
        console.log(`[Route Planner] Suggested port: ${suggestedPort}`);

        // Store the suggested route directly so we can use it
        selectedRoute = suggestedRoute;
        selectedPort = { code: suggestedPort, name: formatPortName(suggestedPort) };

        // Draw route on map if path exists
        if (suggestedRoute.path && window.harborMap && window.harborMap.drawRoute) {
          const routeForMap = {
            path: suggestedRoute.path,
            origin: currentOriginPort,
            destination: suggestedPort
          };
          const portsForRoute = vesselPorts?.all?.ports || [];
          window.harborMap.drawRoute(routeForMap, portsForRoute, false);
        }

        // Update display
        await updateSelectedPortDisplay();
        showSideNotification(`Suggested: ${formatPortName(suggestedPort)}`, 'info');
        return;
      }
    }

    // Fallback: check other possible response structures
    const suggestedPort = data.data?.port ||
                          data.data?.destination ||
                          data.data?.suggested_port ||
                          data.port ||
                          data.destination;

    if (suggestedPort) {
      console.log(`[Route Planner] Suggested port (fallback): ${suggestedPort}`);
      await selectPortForRoute(suggestedPort);
      showSideNotification(`Suggested: ${formatPortName(suggestedPort)}`, 'info');
    } else {
      console.log('[Route Planner] No suggested port in response:', data);
      showSideNotification('No route suggestion available for this vessel', 'warning');
    }

  } catch (error) {
    console.error('[Route Planner] Failed to load suggested route:', error);
    showSideNotification(`Suggested route failed: ${error.message}`, 'error');
  }
}

/**
 * Select a port for route planning (called from map click)
 * @param {string} portCode - Port code
 */
export async function selectPortForRoute(portCode) {
  if (!planningMode || !currentVesselId) return;

  console.log(`[Route Planner] Selecting port: ${portCode}`);

  // Find port in our data or from map's current ports
  let port = null;

  // First try vessel ports (from API)
  if (vesselPorts?.all?.ports) {
    port = vesselPorts.all.ports.find(p => p.code === portCode);
  }

  // Fallback to map's current ports
  if (!port && window.harborMap && window.harborMap.getCurrentPorts) {
    const mapPorts = window.harborMap.getCurrentPorts();
    port = mapPorts.find(p => p.code === portCode);
  }

  // Create minimal port object if still not found
  if (!port) {
    port = { code: portCode, name: portCode };
    console.log('[Route Planner] Using minimal port object for:', portCode);
  }

  selectedPort = port;

  // Fetch route data
  await fetchRouteData(portCode);
}

/**
 * Clear the current route selection and reset to vessel-only view
 */
async function clearRouteSelection() {
  // Reset selected port and route
  selectedPort = null;
  selectedRoute = null;

  // Hide the selected info section
  const infoSection = document.querySelector('.route-planner-selected-info');
  if (infoSection) {
    infoSection.classList.add('hidden');
  }

  // Disable create button
  const createBtn = document.getElementById('routePlannerCreateBtn');
  if (createBtn) {
    createBtn.disabled = true;
  }

  // Clear the route from the map
  if (window.harborMap && window.harborMap.clearRoute) {
    window.harborMap.clearRoute();
  }

  // Close port panel if open and re-select the vessel to show vessel panel
  if (currentVesselId && window.harborMap && window.harborMap.selectVesselFromMap) {
    await window.harborMap.selectVesselFromMap(currentVesselId);
  }

  // Re-highlight available ports if we have port data
  if (currentHighlightedPorts && currentHighlightedPorts.length > 0) {
    if (window.harborMap && window.harborMap.highlightPorts) {
      window.harborMap.highlightPorts(currentHighlightedPorts, currentVesselId);
    }
  }

  console.log('[Route Planner] Route selection cleared');
}

/**
 * Fetch route data between current vessel location and destination
 * @param {string} destinationCode - Destination port code
 */
async function fetchRouteData(destinationCode) {
  // Use currentOriginPort (from vessel data) or fallback to vesselPorts.origin
  const originCode = currentOriginPort || vesselPorts?.origin;

  if (!originCode) {
    console.warn('[Route Planner] No origin port data');
    return;
  }

  try {
    const response = await fetch('/api/route/get-routes-by-ports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port1: originCode, port2: destinationCode })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch route data');
    }

    const data = await response.json();
    console.log('[Route Planner] Route data:', data);

    if (data.routes && data.routes.length > 0) {
      selectedRoute = data.routes[0];

      // Draw route on the map
      if (window.harborMap && window.harborMap.drawRoute && selectedRoute.path) {
        // Build route object with origin/destination for drawRoute
        const routeForMap = {
          path: selectedRoute.path,
          origin: originCode,
          destination: destinationCode
        };
        // Get port data for demand display on markers
        const portsForRoute = vesselPorts?.all?.ports || [];
        // Draw route and zoom to fit the entire route
        window.harborMap.drawRoute(routeForMap, portsForRoute, true);
        console.log(`[Route Planner] Drew route: ${originCode} -> ${destinationCode}`);
      }

      await updateSelectedPortDisplay();
    } else {
      console.warn('[Route Planner] API returned no routes');
    }

  } catch (error) {
    console.error('[Route Planner] Failed to fetch route:', error);
    showError('Failed to load route data');
  }
}

/**
 * Update the selected port info display
 */
async function updateSelectedPortDisplay() {
  const infoSection = document.querySelector('.route-planner-selected-info');
  if (!infoSection || !selectedPort || !selectedRoute) return;

  // Show section
  infoSection.classList.remove('hidden');

  // Port name - show "Origin -> Destination"
  const portNameEl = infoSection.querySelector('.route-planner-port-name');
  if (portNameEl) {
    const originName = currentOriginPort ? formatPortName(currentOriginPort) : 'Unknown';
    const destName = selectedPort.name || formatPortName(selectedPort.code);
    portNameEl.textContent = `${originName} -> ${destName}`;
  }

  const distance = selectedRoute.total_distance || 0;

  // Distance
  const distanceValue = infoSection.querySelector('[data-info="distance"]');
  if (distanceValue) {
    distanceValue.textContent = `${Math.floor(distance).toLocaleString()} nm`;
  }

  // Creation fee - CALCULATED using formula
  const creationValue = infoSection.querySelector('[data-info="creation-fee"]');
  if (creationValue && currentVesselData) {
    const creationFee = calculateRouteCreationFee(
      currentVesselData.capacity,
      distance,
      currentVesselData.capacityType
    );
    creationValue.textContent = `$${creationFee.toLocaleString()}`;
  }

  // Channel fee (from API, not calculated)
  const channelValue = infoSection.querySelector('[data-info="channel-fee"]');
  if (channelValue) {
    channelValue.textContent = `$${(selectedRoute.channel_cost || 0).toLocaleString()}`;
  }

  // Travel Time - CALCULATED using formula
  const travelTimeValue = infoSection.querySelector('[data-info="travel-time"]');
  if (travelTimeValue) {
    const speedSlider = document.getElementById('routePlannerPortsSpeedSlider');
    const speed = speedSlider ? parseInt(speedSlider.value, 10) : 6;
    const travelTime = calculateTravelTime(distance, speed);
    travelTimeValue.textContent = formatTravelTime(travelTime);
  }

  // Harbor Fee MIN/MAX - CALCULATED using formula
  const harborFeeValue = infoSection.querySelector('[data-info="harbor-fee"]');
  if (harborFeeValue) {
    const harborFee = calculateHarborFeeRange(distance);
    harborFeeValue.textContent = `$${harborFee.min.toFixed(2)} - $${harborFee.max.toFixed(2)}`;
  }

  // Fuel Consumption - CALCULATED using formula
  const fuelValue = infoSection.querySelector('[data-info="fuel-consumption"]');
  if (fuelValue && currentVesselData) {
    const speedSlider = document.getElementById('routePlannerPortsSpeedSlider');
    const speed = speedSlider ? parseInt(speedSlider.value, 10) : 6;
    const fuel = calculateFuelConsumption(
      currentVesselData.capacity,
      distance,
      speed,
      currentVesselData.fuelFactor,
      currentVesselData.capacityType
    );
    fuelValue.textContent = `${fuel.toFixed(2)} t`;
  }

  // Piracy warning and Guards slider
  const piracySection = infoSection.querySelector('.route-planner-piracy-warning');
  const guardsSelector = document.querySelector('.route-planner-guards-selector');
  const guardsCostRow = document.querySelector('.route-planner-guards-cost-row');

  if (selectedRoute.hijacking_risk > 0) {
    // Show piracy warning
    if (piracySection) {
      piracySection.classList.remove('hidden');

      const zoneEl = piracySection.querySelector('.route-planner-piracy-zone');
      const riskEl = piracySection.querySelector('.route-planner-piracy-risk');

      if (zoneEl && selectedRoute.danger_zones_ids) {
        const zoneId = Array.isArray(selectedRoute.danger_zones_ids)
          ? selectedRoute.danger_zones_ids[0]
          : selectedRoute.danger_zones_ids;
        zoneEl.textContent = `Zone: ${DANGER_ZONE_NAMES[zoneId] || zoneId}`;
      }

      if (riskEl) {
        riskEl.textContent = `Risk: ${selectedRoute.hijacking_risk}%`;
      }
    }

    // Show guards slider when there is hijacking risk
    if (guardsSelector) {
      guardsSelector.classList.remove('hidden');
    }
    if (guardsCostRow) {
      guardsCostRow.classList.remove('hidden');
    }

    // Reset guards slider to 0 and update display
    const guardsSlider = document.getElementById('routePlannerPortsGuardsSlider');
    if (guardsSlider) {
      guardsSlider.value = 0;
      updatePortsGuardsDisplay();
    }
  } else {
    // Hide piracy warning and guards slider when no risk
    if (piracySection) {
      piracySection.classList.add('hidden');
    }
    if (guardsSelector) {
      guardsSelector.classList.add('hidden');
    }
    if (guardsCostRow) {
      guardsCostRow.classList.add('hidden');
    }
  }

  // Enable create button only if vessel is at port or anchored
  const createBtn = document.getElementById('routePlannerCreateBtn');
  if (createBtn) {
    const canCreateRoute = currentVesselData && (currentVesselData.status === 'port' || currentVesselData.status === 'anchor');
    createBtn.disabled = !canCreateRoute;
  }

  // Fetch and display port demand data
  await fetchAndDisplayDemand(selectedPort.code);
}

/**
 * Fetch port demand data and update display
 * Uses /api/route/get-port-demand which works for ALL ports (not just assigned)
 * @param {string} portCode - Port code
 */
async function fetchAndDisplayDemand(portCode) {
  try {
    // Use the route planner endpoint that calls /api/port/get-ports
    // This works for ALL ports, not just assigned ones
    const response = await fetch('/api/route/get-port-demand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port_code: portCode })
    });

    if (!response.ok) {
      console.warn(`[Route Planner] Failed to fetch port demand for ${portCode}`);
      return;
    }

    const data = await response.json();
    const port = data.port;

    if (!port || !port.demand) {
      console.log('[Route Planner] No demand data for port');
      return;
    }

    const demand = port.demand;

    // Update container demand
    const dryValue = document.querySelector('[data-demand="dry"]');
    const refValue = document.querySelector('[data-demand="refrigerated"]');
    if (dryValue && demand.container) {
      const dry = demand.container.dry;
      dryValue.textContent = dry ? `${dry.toLocaleString()} TEU` : '- TEU';
      dryValue.classList.toggle('zero', !dry);
    }
    if (refValue && demand.container) {
      const ref = demand.container.refrigerated;
      refValue.textContent = ref ? `${ref.toLocaleString()} TEU` : '- TEU';
      refValue.classList.toggle('zero', !ref);
    }

    // Update tanker demand
    const fuelValue = document.querySelector('[data-demand="fuel"]');
    const crudeValue = document.querySelector('[data-demand="crude_oil"]');
    if (fuelValue && demand.tanker) {
      const fuel = demand.tanker.fuel;
      fuelValue.textContent = fuel ? `${fuel.toLocaleString()} bbl` : '- bbl';
      fuelValue.classList.toggle('zero', !fuel);
    }
    if (crudeValue && demand.tanker) {
      const crude = demand.tanker.crude_oil;
      crudeValue.textContent = crude ? `${crude.toLocaleString()} bbl` : '- bbl';
      crudeValue.classList.toggle('zero', !crude);
    }

    console.log(`[Route Planner] Updated demand display for ${portCode}`);

  } catch (error) {
    console.error('[Route Planner] Error fetching port demand:', error);
  }
}

/**
 * Create route via API
 */
async function createRoute() {
  if (!currentVesselId || !selectedRoute) {
    console.warn('[Route Planner] Cannot create route: missing data');
    return;
  }

  const createBtn = document.getElementById('routePlannerCreateBtn');
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
  }

  // Get speed from Ports Tab slider
  const portsSpeedSlider = document.getElementById('routePlannerPortsSpeedSlider');
  const speed = portsSpeedSlider ? parseInt(portsSpeedSlider.value, 10) : 6;

  // Calculate fees for logging
  const distance = selectedRoute.total_distance || 0;
  const routeFee = currentVesselData
    ? calculateRouteCreationFee(currentVesselData.capacity, distance, currentVesselData.capacityType)
    : 0;
  const channelCost = selectedRoute.channel_cost || 0;
  const totalFee = routeFee + channelCost;

  try {
    const response = await fetch('/api/route/create-user-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        route_id: selectedRoute.id,
        user_vessel_id: currentVesselId,
        speed: speed,
        guards: 0,
        dry_operation: 0,
        price_dry: 655,
        price_refrigerated: 655,
        // Calculated fees for logging
        calculated_route_fee: routeFee,
        calculated_channel_cost: channelCost,
        calculated_total_fee: totalFee
      })
    });

    const data = await response.json();
    console.log('[Route Planner] API response:', data);

    // Check for error response
    if (data.error) {
      throw new Error(data.error);
    }

    // Verify we got the expected data
    if (!data.success && !data.data?.user_vessel) {
      throw new Error('Invalid API response: missing vessel data');
    }

    // Get actual route info from response
    const vessel = data.data?.user_vessel;
    const origin = vessel?.route_origin;
    const destination = vessel?.route_destination;
    const distance = vessel?.route_distance;

    // Build notification message from actual API response
    const vesselName = vessel?.name || currentVesselName;
    let message;
    if (origin && destination) {
      const originName = formatPortName(origin);
      const destName = formatPortName(destination);
      message = `${vesselName}: ${originName} -> ${destName} (${distance} nm)`;
    } else {
      message = `Route assigned to ${vesselName}`;
    }

    showSideNotification(`Route Created: ${message}`, 'success');

    // Store vessel ID before closing (we need it for selection)
    const vesselIdToSelect = currentVesselId;

    // Close panel (keep route visible briefly for visual feedback)
    closeRoutePlanner(true);

    // Small delay to let API process the route
    await new Promise(resolve => setTimeout(resolve, 500));

    // Force refresh map data (bypasses cooldown) - this updates rawVessels
    if (window.harborMap && window.harborMap.forceRefresh) {
      await window.harborMap.forceRefresh();
    }

    // Get fresh vessel data with skipCache=true to ensure we have the new route
    if (vesselIdToSelect && window.harborMap && window.harborMap.getVesselById) {
      await window.harborMap.getVesselById(vesselIdToSelect, true);
    }

    // Select the vessel to show it with new route and zoom
    if (vesselIdToSelect && window.harborMap && window.harborMap.selectVesselFromMap) {
      await window.harborMap.selectVesselFromMap(vesselIdToSelect);
    }

    // Update all badges (anchor count changed) - must await to ensure UI updates
    if (window.updateVesselCount) {
      await window.updateVesselCount();
    }
    if (window.badgeCache && window.badgeCache.refreshAll) {
      await window.badgeCache.refreshAll();
    }

  } catch (error) {
    console.error('[Route Planner] Failed to create route:', error);

    // Show actual error message from API
    showSideNotification(`Route Failed: ${error.message}`, 'error');

    if (createBtn) {
      createBtn.disabled = false;
      createBtn.textContent = 'Create Route';
    }
  }
}

/**
 * Update slider value displays (Route Tab)
 */
function updateSliderDisplays() {
  const speedSlider = document.getElementById('routePlannerSpeedSlider');
  const guardsSlider = document.getElementById('routePlannerGuardsSlider');
  const speedValue = document.getElementById('routePlannerSpeedValue');
  const guardsValue = document.getElementById('routePlannerGuardsValue');
  const guardsCost = document.getElementById('routePlannerGuardsCost');

  if (speedSlider && speedValue) {
    speedValue.textContent = `${speedSlider.value} kn`;
  }

  if (guardsSlider && guardsValue && guardsCost) {
    const guards = parseInt(guardsSlider.value, 10);
    guardsValue.textContent = guards;
    guardsCost.textContent = `$${calculateGuardsCost(guards).toLocaleString()}`;
  }
}

/**
 * Update speed display and recalculate formulas (Ports Tab)
 */
function updatePortsSpeedDisplay() {
  const speedSlider = document.getElementById('routePlannerPortsSpeedSlider');
  const speedValue = document.getElementById('routePlannerPortsSpeedValue');

  if (speedSlider && speedValue) {
    speedValue.textContent = `${speedSlider.value} kn`;
  }

  // Recalculate travel time and fuel if we have route data
  if (!selectedRoute || !currentVesselData) return;

  const speed = speedSlider ? parseInt(speedSlider.value, 10) : 6;
  const distance = selectedRoute.total_distance || 0;

  // Update Travel Time
  const travelTimeValue = document.querySelector('[data-info="travel-time"]');
  if (travelTimeValue) {
    const travelTime = calculateTravelTime(distance, speed);
    travelTimeValue.textContent = formatTravelTime(travelTime);
  }

  // Update Fuel Consumption
  const fuelValue = document.querySelector('[data-info="fuel-consumption"]');
  if (fuelValue) {
    const fuel = calculateFuelConsumption(
      currentVesselData.capacity,
      distance,
      speed,
      currentVesselData.fuelFactor,
      currentVesselData.capacityType
    );
    fuelValue.textContent = `${fuel.toFixed(2)} t`;
  }
}

/**
 * Update guards display and cost (Ports Tab)
 */
function updatePortsGuardsDisplay() {
  const guardsSlider = document.getElementById('routePlannerPortsGuardsSlider');
  const guardsValue = document.getElementById('routePlannerPortsGuardsValue');
  const guardsCost = document.getElementById('routePlannerPortsGuardsCost');

  if (guardsSlider && guardsValue) {
    guardsValue.textContent = guardsSlider.value;
  }

  if (guardsSlider && guardsCost) {
    const guards = parseInt(guardsSlider.value, 10);
    const cost = calculateGuardsCost(guards);
    guardsCost.textContent = `$${cost.toLocaleString()}`;
  }
}

/**
 * Save route changes (speed/guards)
 */
async function saveRouteChanges() {
  // TODO: Implement route update API call
  console.log('[Route Planner] Save route changes - not yet implemented');
  closeRoutePlanner();
}

/**
 * Show error message
 * @param {string} message - Error message
 */
function showError(message) {
  const content = document.querySelector('#routePlannerPanel .route-planner-content');
  if (!content) return;

  // Could show a toast notification instead
  console.error('[Route Planner]', message);
}

/**
 * Format port name
 * @param {string} portCode - Port code
 * @returns {string} Formatted name
 */
function formatPortName(portCode) {
  if (!portCode) return 'Unknown';
  return portCode.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ============================================
// DRAG FUNCTIONALITY
// ============================================

function startDrag(e) {
  // Don't start drag if clicking on close button or other interactive elements
  if (e.target.closest('.route-planner-close') ||
      e.target.closest('button') ||
      e.target.closest('input') ||
      e.target.closest('select')) {
    return;
  }

  const panel = document.getElementById('routePlannerPanel');
  if (!panel) return;

  isDragging = true;
  panel.classList.add('dragging');

  const rect = panel.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;

  // Remove transform to allow free positioning
  panel.style.transform = 'none';
}

function drag(e) {
  if (!isDragging) return;

  const panel = document.getElementById('routePlannerPanel');
  if (!panel) return;

  e.preventDefault();

  const newX = e.clientX - dragOffsetX;
  const newY = e.clientY - dragOffsetY;

  panel.style.left = `${newX}px`;
  panel.style.top = `${newY}px`;
}

function stopDrag() {
  if (!isDragging) return;

  isDragging = false;

  const panel = document.getElementById('routePlannerPanel');
  if (panel) {
    panel.classList.remove('dragging');
  }
}
