/**
 * @fileoverview Vessel Detail Panel Component
 * Renders vessel information panel with trip history and actions
 * ONLY renders data - NO data processing
 *
 * @module harbor-map/vessel-panel
 */

import { fetchVesselHistory, exportVesselHistory } from './api-client.js';
import { deselectAll, getMap, getVesselById } from './map-controller.js';
import { isMobileDevice, escapeHtml, showSideNotification, toGameCode } from '../utils.js';
import { isDepartInProgress } from '../vessel-management.js';

/**
 * Converts country code to flag emoji
 * @param {string} countryCode - Two-letter country code (e.g., 'US', 'ES')
 * @returns {string} Flag emoji or empty string
 */
function getCountryFlag(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}

/**
 * Gets country code for a port from map controller's current ports
 * @param {string} portCode - Port code (e.g., 'hamburg', 'tarragona')
 * @returns {string} Country code or empty string
 */
function getPortCountryCode(portCode) {
  if (!portCode || !window.harborMap) return '';
  try {
    const ports = window.harborMap.getCurrentPorts();
    const port = ports.find(p => p.code === portCode);
    return port?.country || '';
  } catch {
    return '';
  }
}

/**
 * Formats time from seconds to human-readable string
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time like "2h 15m" or "45m"
 */
function formatTimeRemaining(seconds) {
  if (!seconds || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Gets loading/unloading status for a vessel
 * @param {Object} vessel - Vessel object
 * @returns {Object|null} { status: 'loading'|'unloading', timeLeft: seconds } or null
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
 * Formats loading/unloading status with timer
 * @param {Object} loadingStatus - From getLoadingStatus()
 * @returns {string} Formatted string like "Loading - 2h 15m" or "Unloading - 45m"
 */
function formatLoadingStatusText(loadingStatus) {
  if (!loadingStatus) return '';
  const timeStr = formatTimeRemaining(loadingStatus.timeLeft);
  const label = loadingStatus.status === 'loading' ? 'Loading' : 'Unloading';
  return `${label} - ${timeStr}`;
}

/**
 * Formats vessel status for display, including Bug-Using detection
 * @param {Object} vessel - Vessel object
 * @returns {string} Formatted status HTML
 */
function formatVesselStatus(vessel) {
  // Bug-Using: vessel is in maintenance but still has pending delivery time
  if (vessel.status === 'maintenance' && vessel.time_arrival && vessel.time_arrival > 0) {
    // Calculate original delivery time (crossed out)
    const deliveryRemaining = vessel.time_arrival;
    const deliveryDays = Math.floor(deliveryRemaining / 86400);
    const deliveryHours = Math.floor((deliveryRemaining % 86400) / 3600);
    const deliveryMinutes = Math.floor((deliveryRemaining % 3600) / 60);
    let deliveryDisplay = '';
    if (deliveryDays > 0) {
      deliveryDisplay = `${deliveryDays}d ${deliveryHours}h`;
    } else if (deliveryHours > 0) {
      deliveryDisplay = `${deliveryHours}h ${deliveryMinutes}m`;
    } else {
      deliveryDisplay = `${deliveryMinutes}m`;
    }

    // Calculate actual drydock end time
    const maintenanceEnd = parseInt(vessel.maintenance_end_time, 10);
    const now = Math.floor(Date.now() / 1000);
    const drydockRemaining = Math.max(0, maintenanceEnd - now);
    const drydockHours = Math.floor(drydockRemaining / 3600);
    const drydockMinutes = Math.floor((drydockRemaining % 3600) / 60);
    let drydockDisplay = '';
    if (drydockRemaining <= 0) {
      drydockDisplay = 'Ready';
    } else if (drydockHours > 0) {
      drydockDisplay = `${drydockHours}h ${drydockMinutes}m`;
    } else {
      drydockDisplay = `${drydockMinutes}m`;
    }

    return `<span style="color: var(--color-success); font-weight: bold;">Bug-Using</span> (<s style="color: var(--color-text-tertiary);">${deliveryDisplay}</s> <span style="color: var(--color-success);">${drydockDisplay}</span>)`;
  }

  if (vessel.status === 'pending' && vessel.time_arrival && vessel.time_arrival > 0) {
    const remaining = vessel.time_arrival;
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    let timeDisplay = '';
    if (days > 0) {
      timeDisplay = `${days}d ${hours}h`;
    } else if (hours > 0) {
      timeDisplay = `${hours}h ${minutes}m`;
    } else {
      timeDisplay = `${minutes}m`;
    }
    return `${vessel.status} (Delivery in: ${timeDisplay})`;
  }

  // Check for drydock trip (enroute to/from drydock)
  if (vessel.status === 'enroute' && vessel.route_dry_operation === 1) {
    return `<span style="color: var(--color-purple); font-weight: 600;">Drydock Trip</span>`;
  }

  // Check for loading/unloading status
  const loadingStatus = getLoadingStatus(vessel);
  if (loadingStatus) {
    const loadingText = formatLoadingStatusText(loadingStatus);
    return `${vessel.status} <span style="color: var(--color-warning); font-weight: 600;">(${loadingText})</span>`;
  }

  return vessel.status;
}

/**
 * Shows vessel detail panel with vessel information
 * Displays status, cargo, ETA, and loads trip history
 *
 * @param {Object} vessel - Vessel object from backend
 * @returns {Promise<void>}
 * @example
 * await showVesselPanel({ id: 1234, name: 'SS Example', status: 'enroute', ... });
 */
export async function showVesselPanel(vessel) {
  const panel = document.getElementById('vessel-detail-panel');
  if (!panel) return;

  // Fetch sell price for this vessel (non-blocking)
  let sellPrice = null;

  // Fetch fresh vessel data in background and update status display
  // This ensures Bug-Using status and timers are accurate
  getVesselById(vessel.id, true).then(freshVessel => {
    if (!freshVessel) return;

    // Check if status changed
    if (freshVessel.status !== vessel.status ||
        freshVessel.time_arrival !== vessel.time_arrival ||
        freshVessel.maintenance_end_time !== vessel.maintenance_end_time) {
      // Update the status paragraph
      const statusSection = panel.querySelector('.vessel-info-section .section-content p:first-child');
      if (statusSection) {
        statusSection.innerHTML = `<strong>Status:</strong> ${formatVesselStatus(freshVessel)}`;
      }
    }
  }).catch(error => {
    console.error('[Vessel Panel] Error fetching fresh vessel data:', error);
  });

  // Start fetching sell price but don't block panel display
  fetch(window.apiUrl('/api/vessel/get-sell-price'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vessel_id: vessel.id })
  }).then(response => {
    if (response.ok) {
      return response.json();
    }
    return null;
  }).then(data => {
    if (data && data.data && data.data.selling_price !== undefined) {
      sellPrice = data.data.selling_price;
      // Update the sell price display if panel is still open
      const sellPriceElement = panel.querySelector('.vessel-sell-price');
      if (sellPriceElement) {
        sellPriceElement.innerHTML = `<strong>Sell Price:</strong> $${formatNumber(sellPrice)}`;
      }
    }
  }).catch(error => {
    console.error('[Vessel Panel] Error fetching sell price:', error);
  });

  // Helper functions for efficiency classes
  const getCO2Class = (factor) => {
    if (factor < 1.0) return 'vessel-spec-co2-efficient';
    if (factor === 1.0) return 'vessel-spec-co2-standard';
    return 'vessel-spec-co2-inefficient';
  };

  const getFuelClass = (factor) => {
    if (factor < 1.0) return 'vessel-spec-fuel-efficient';
    if (factor === 1.0) return 'vessel-spec-fuel-standard';
    return 'vessel-spec-fuel-inefficient';
  };

  const formatNumber = (num) => Math.floor(num).toLocaleString();

  // Format port name - uses game display codes (e.g., "US NYC")
  const formatPortName = (portCode) => {
    if (!portCode) return 'N/A';
    return escapeHtml(toGameCode(portCode));
  };

  // Capacity display (max capacity)
  let capacityDisplay = vessel.formattedCargo || 'N/A';
  if (vessel.capacity_type === 'container' && vessel.capacity_max) {
    const dry = vessel.capacity_max.dry;
    const ref = vessel.capacity_max.refrigerated;
    const total = dry + ref;
    capacityDisplay = `${formatNumber(total)} TEU (${formatNumber(dry)} dry / ${formatNumber(ref)} ref)`;
  } else if (vessel.capacity_type === 'tanker' && vessel.capacity_max) {
    const fuel = vessel.capacity_max.fuel;
    const crude = vessel.capacity_max.crude_oil;
    const total = fuel + crude;
    capacityDisplay = `${formatNumber(total)} bbl (${formatNumber(fuel)} fuel / ${formatNumber(crude)} crude)`;
  }

  // Check if vessel is on drydock trip (cargo data is stale/irrelevant)
  const isDrydockTrip = vessel.status === 'enroute' && vessel.route_dry_operation === 1;

  // Current cargo loaded (detailed breakdown)
  // API uses 'capacity' for current loaded cargo, 'capacity_max' for maximum capacity
  // Don't show cargo for drydock trips - data is from previous trip
  let loadedCargoDisplay = '';
  if (isDrydockTrip) {
    loadedCargoDisplay = '<p style="color: var(--color-text-tertiary); font-style: italic;">No cargo on drydock trip</p>';
  } else if (vessel.capacity) {
    if (vessel.capacity_type === 'container') {
      const dryLoaded = vessel.capacity.dry;
      const refLoaded = vessel.capacity.refrigerated;
      const dryMax = vessel.capacity_max?.dry;
      const refMax = vessel.capacity_max?.refrigerated;
      const totalLoaded = dryLoaded + refLoaded;
      const totalMax = dryMax + refMax;
      const utilization = totalMax > 0 ? Math.round((totalLoaded / totalMax) * 100) : 0;
      loadedCargoDisplay = `
        <p><strong>Loaded Cargo:</strong></p>
        <p style="margin-left: 10px;">Total: ${formatNumber(totalLoaded)}/${formatNumber(totalMax)} TEU (${utilization}%)</p>
        <p style="margin-left: 10px;">Dry: ${formatNumber(dryLoaded)}/${formatNumber(dryMax)} TEU</p>
        <p style="margin-left: 10px;">Refrigerated: ${formatNumber(refLoaded)}/${formatNumber(refMax)} TEU</p>
      `;
    } else if (vessel.capacity_type === 'tanker') {
      const fuelLoaded = vessel.capacity.fuel;
      const crudeLoaded = vessel.capacity.crude_oil;
      const fuelMax = vessel.capacity_max?.fuel;
      const crudeMax = vessel.capacity_max?.crude_oil;
      const totalLoaded = fuelLoaded + crudeLoaded;
      const totalMax = fuelMax + crudeMax;
      const utilization = totalMax > 0 ? Math.round((totalLoaded / totalMax) * 100) : 0;

      loadedCargoDisplay = `
        <p><strong>Loaded Cargo:</strong></p>
        <p style="margin-left: 10px;">Total: ${formatNumber(totalLoaded)}/${formatNumber(totalMax)} bbl (${utilization}%)</p>
        <p style="margin-left: 10px;">Fuel: ${formatNumber(fuelLoaded)}/${formatNumber(fuelMax)} bbl</p>
        <p style="margin-left: 10px;">Crude Oil: ${formatNumber(crudeLoaded)}/${formatNumber(crudeMax)} bbl</p>
      `;
    }
  } else {
    loadedCargoDisplay = '<p><strong>Loaded Cargo:</strong> N/A</p>';
  }

  // Vessel image URL logic:
  // 1. ownImage = true -> user uploaded image from /api/vessel-image/ownimage/{id}
  // 2. Custom vessel (type_name "N/A") -> SVG from /api/vessel-image/custom/{id}
  // 3. Shop vessel -> shop image from /api/vessel-image/{type}
  let imageUrl = '';
  const isCustomVessel = vessel.type_name === 'N/A';
  if (vessel.ownImage) {
    // Cache buster for own images - ensures fresh image after upload
    imageUrl = `/api/vessel-image/ownimage/${vessel.id}?t=${Date.now()}`;
  } else if (isCustomVessel) {
    imageUrl = `/api/vessel-image/custom/${vessel.id}?capacity_type=${vessel.capacity_type}&capacity=${typeof vessel.capacity === 'number' ? vessel.capacity : (vessel.capacity_max?.dry ?? vessel.capacity_max?.crude_oil ?? 0)}&name=${encodeURIComponent(vessel.name)}&t=${Date.now()}`;
  } else if (vessel.type) {
    imageUrl = `/api/vessel-image/${vessel.type}`;
  }
  const safeVesselName = (vessel.name || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const imageOnerror = isCustomVessel
    ? `if(window.handleVesselImageError){window.handleVesselImageError(this,${vessel.id},'${safeVesselName}',true)}else{this.style.display='none'}`
    : `this.style.display='none'`;

  // Render vessel full info with collapsible sections
  panel.innerHTML = `
    <div class="panel-header">
      <h3>
        <span id="vessel-name-display-${vessel.id}" class="vessel-name-display">${escapeHtml(vessel.name)}</span>
        <input
          type="text"
          id="vessel-name-input-${vessel.id}"
          class="vessel-name-input hidden"
          value="${vessel.name.replace(/"/g, '&quot;')}"
          maxlength="30"
          data-vessel-id="${vessel.id}"
        />
        <button
          class="rename-vessel-btn"
          onclick="${isCustomVessel
            ? `window.harborMap.openVesselAppearanceEditor(${vessel.id}, '${safeVesselName}')`
            : `window.harborMap.startRenameVessel(${vessel.id})`}"
          title="${isCustomVessel ? 'Edit vessel appearance' : 'Rename vessel'}"
        >✏️</button>
      </h3>
      <button class="close-btn" onclick="window.harborMap.closeVesselPanel()">×</button>
    </div>

    <div class="panel-body">
      ${imageUrl ? `
        <div class="vessel-image-container">
          <img src="${imageUrl}" alt="${vessel.type_name}" class="vessel-image" onerror="${imageOnerror}">
          <div id="vessel-weather-overlay" style="position: absolute; top: 1px; left: 1px; background: rgba(0, 0, 0, 0.185); padding: 3px 5px; border-radius: 3px; font-size: 11px; color: #fff; backdrop-filter: blur(2px);">
            <div style="color: #94a3b8; font-size: 9px;">Loading...</div>
          </div>
        </div>
      ` : ''}

      <div class="vessel-action-emojis">
        <span
          class="action-emoji${vessel.status !== 'port' && vessel.status !== 'enroute' && vessel.status !== 'anchor' ? ' disabled' : ''}"
          onclick="${vessel.status === 'port' || vessel.status === 'enroute' || vessel.status === 'anchor' ? `window.harborMap.openRoutePlanner(${vessel.id}, '${vessel.name.replace(/'/g, "\\'")}')` : 'return false'}"
          title="Plan route for this vessel"
        >&#x1F9ED;</span>
        <span
          class="action-emoji park-toggle-btn${vessel.is_parked ? ' parked' : ' not-parked'}${vessel.status === 'maintenance' || vessel.status === 'pending' || vessel.status === 'delivery' ? ' disabled' : ''}"
          data-vessel-id="${vessel.id}"
          data-is-parked="${vessel.is_parked ? 'true' : 'false'}"
          title="${vessel.status === 'maintenance' ? 'Cannot moor/resume vessel in drydock' : vessel.status === 'pending' || vessel.status === 'delivery' ? 'Cannot moor/resume pending vessel' : (vessel.is_parked ? 'Resume vessel' : 'Moor vessel')}"
          onclick="${vessel.status === 'maintenance' || vessel.status === 'pending' || vessel.status === 'delivery' ? 'return false' : 'window.harborMap.toggleParkVessel(this)'}"
        >${vessel.is_parked ? '&#x26D3;&#xFE0F;' : '&#x1F7E2;'}</span>
        <span
          class="action-emoji depart-vessel-btn${vessel.status !== 'port' ? ' disabled' : ''}"
          data-vessel-id="${vessel.id}"
          data-vessel-name="${escapeHtml(vessel.name)}"
          onclick="${vessel.status === 'port' ? `window.harborMap.departVessel(${vessel.id}, '${vessel.name.replace(/'/g, "\\'")}')` : 'return false'}"
          title="${vessel.status === 'port' ? 'Depart vessel from port' : 'Vessel must be in port to depart'}"
        >&#x1F3C1;</span>
        <span
          class="action-emoji"
          onclick="window.harborMap.openRepairDialog(${vessel.id})"
          title="Repair & Drydock - Wear: ${vessel.wear ? parseFloat(vessel.wear).toFixed(1) : 'N/A'}% | Until Drydock: ${formatNumber(vessel.hours_until_check)}h"
        >🔧</span>
        <span
          class="action-emoji${vessel.status !== 'port' && vessel.status !== 'anchor' ? ' disabled' : ''}"
          onclick="${vessel.status === 'port' || vessel.status === 'anchor' ? `window.harborMap.sellVesselFromPanel(${vessel.id}, '${vessel.name.replace(/'/g, "\\'")}')` : 'return false'}"
          title="${vessel.status === 'port' || vessel.status === 'anchor' ? 'Sell this vessel' : 'Vessel must be in port or anchored to sell'}"
        >💵</span>
      </div>

      <div class="vessel-info-section collapsible">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Status & Current Cargo
        </h4>
        <div class="section-content">
          <p><strong>Status:</strong> ${formatVesselStatus(vessel)}</p>
          ${vessel.eta !== 'N/A' ? `<p><strong>ETA:</strong> ${vessel.eta}</p>` : ''}
          ${vessel.current_port_code ? `<p><strong>Current Port:</strong> ${getCountryFlag(getPortCountryCode(vessel.current_port_code))} ${formatPortName(vessel.current_port_code)}</p>` : ''}
          ${(() => {
            if (!vessel.time_arrival || vessel.time_arrival <= 0) return '';
            const arrivalDate = new Date(vessel.time_arrival * 1000);
            // If year is 1970, it's invalid (unix epoch default)
            if (arrivalDate.getFullYear() === 1970) {
              return '<p><strong>Last Arrival:</strong> None</p>';
            }
            return `<p><strong>Last Arrival:</strong> ${arrivalDate.toLocaleString()}</p>`;
          })()}
          ${loadedCargoDisplay}
          ${!isDrydockTrip && vessel.prices && (vessel.prices.dry || vessel.prices.refrigerated) ? `
            <p><strong>Dry Container Rate:</strong> $${vessel.prices.dry}/TEU</p>
            <p><strong>Refrigerated Rate:</strong> $${vessel.prices.refrigerated}/TEU</p>
          ` : ''}
          ${!isDrydockTrip && vessel.prices && (vessel.prices.fuel || vessel.prices.crude_oil) ? `
            <p><strong>Fuel Rate:</strong> $${vessel.prices.fuel}/bbl</p>
            <p><strong>Crude Oil Rate:</strong> $${vessel.prices.crude_oil}/bbl</p>
          ` : ''}
          <p class="vessel-sell-price">${sellPrice !== null ? `<strong>Sell Price:</strong> $${formatNumber(sellPrice)}` : '<strong>Sell Price:</strong> <span style="color: var(--color-text-secondary)">Loading...</span>'}</p>
          ${(() => {
            // Don't show revenue for drydock trips
            if (isDrydockTrip) return '';
            if (vessel.status !== 'enroute' || !vessel.route_distance || !vessel.capacity) return '';

            let hasLoadedCargo = false;

            if (vessel.capacity_type === 'container' && vessel.capacity) {
              const dryLoaded = vessel.capacity.dry;
              const refLoaded = vessel.capacity.refrigerated;
              if (dryLoaded > 0 || refLoaded > 0) {
                hasLoadedCargo = true;
              }
            } else if (vessel.capacity_type === 'tanker' && vessel.capacity) {
              const fuelLoaded = vessel.capacity.fuel;
              const crudeLoaded = vessel.capacity.crude_oil;
              if (fuelLoaded > 0 || crudeLoaded > 0) {
                hasLoadedCargo = true;
              }
            }

            if (!hasLoadedCargo) return '';

            // Revenue per nm will be filled from history data (actual API value, not calculated)
            return `<p id="current-trip-revenue-per-nm"><strong>Revenue per nm:</strong> <span class="loading">Loading...</span></p>`;
          })()}
        </div>
      </div>

      <div class="vessel-info-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Operations & Maintenance
        </h4>
        <div class="section-content">
          <p><strong>Wear:</strong> ${vessel.wear ? parseFloat(vessel.wear).toFixed(2) : 'N/A'}%</p>
          <p><strong>Travelled Hours:</strong> ${formatNumber(vessel.travelled_hours)}h</p>
          <p><strong>Hours Until Maintenance:</strong> ${formatNumber(vessel.hours_until_check)}h</p>
          <p><strong>Service Interval:</strong> ${formatNumber(vessel.hours_between_service)}h</p>
          ${vessel.total_distance_traveled ? `<p><strong>Total Distance:</strong> ${formatNumber(vessel.total_distance_traveled)} nm</p>` : ''}
          ${vessel.time_acquired ? `<p><strong>Acquired:</strong> ${new Date(vessel.time_acquired * 1000).toLocaleDateString()}</p>` : ''}
          ${vessel.maintenance_start_time ? `<p><strong>Maintenance Start:</strong> ${new Date(vessel.maintenance_start_time * 1000).toLocaleString()}</p>` : ''}
          ${vessel.maintenance_end_time ? `<p><strong>Maintenance End:</strong> ${new Date(parseInt(vessel.maintenance_end_time) * 1000).toLocaleString()}</p>` : ''}
          ${vessel.next_route_is_maintenance !== null ? `<p><strong>Next Route Maintenance:</strong> ${vessel.next_route_is_maintenance ? 'Yes' : 'No'}</p>` : ''}
        </div>
      </div>

      ${vessel.status === 'enroute' && (vessel.route_origin || vessel.route_destination || vessel.route_name) ? `
        <div class="vessel-info-section collapsible collapsed">
          <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="toggle-icon">▼</span> Route Details
          </h4>
          <div class="section-content">
            ${vessel.route_name ? `<p><strong>Route Name:</strong> ${vessel.route_name}</p>` : ''}
            ${vessel.route_origin ? `<p><strong>Origin Port:</strong> ${getCountryFlag(getPortCountryCode(vessel.route_origin))} ${formatPortName(vessel.route_origin)}</p>` : ''}
            ${vessel.route_destination ? `<p><strong>Destination Port:</strong> ${getCountryFlag(getPortCountryCode(vessel.route_destination))} ${formatPortName(vessel.route_destination)}</p>` : ''}
            ${vessel.route_distance ? `<p><strong>Distance:</strong> ${formatNumber(vessel.route_distance)} nm</p>` : ''}
            ${vessel.route_speed ? `<p><strong>Speed:</strong> ${vessel.route_speed} kn</p>` : ''}
            ${vessel.route_guards !== undefined && vessel.route_guards >= 0 ? `<p><strong>Guards:</strong> ${vessel.route_guards}</p>` : ''}
            ${vessel.active_route?.canal_fee !== undefined && vessel.active_route.canal_fee !== null ? `<p><strong>Canal Fee:</strong> $${formatNumber(vessel.active_route.canal_fee)}</p>` : ''}
            ${vessel.route_end_time ? `<p><strong>Arrival Time:</strong> ${new Date(vessel.route_end_time * 1000).toLocaleString()}</p>` : ''}
            ${vessel.route_dry_operation !== undefined ? `<p><strong>Dry Operation:</strong> ${vessel.route_dry_operation ? 'Yes' : 'No'}</p>` : ''}
            ${vessel.active_route?.loading_time !== undefined ? `<p><strong>Loading Time:</strong> ${vessel.active_route.loading_time}h</p>` : ''}
            ${vessel.active_route?.unloading_time !== undefined ? `<p><strong>Unloading Time:</strong> ${vessel.active_route.unloading_time}h</p>` : ''}
            ${vessel.active_route?.duration !== undefined && vessel.active_route.duration !== null ? `<p><strong>Route Duration:</strong> ${formatNumber(vessel.active_route.duration)}h</p>` : ''}
            ${vessel.routes && vessel.routes[0]?.hijacking_risk !== undefined ? `<p><strong>Hijacking Risk:</strong> ${vessel.routes[0].hijacking_risk}%</p>` : ''}

            <div class="route-port-demands">
              ${vessel.route_origin ? `
                <div class="route-port-demand" data-port="${vessel.route_origin}">
                  <p class="port-demand-header"><strong>Origin Demand (${formatPortName(vessel.route_origin)}):</strong></p>
                  <div class="port-demand-content" id="origin-demand-${vessel.id}">Loading...</div>
                </div>
              ` : ''}
              ${vessel.route_destination ? `
                <div class="route-port-demand" data-port="${vessel.route_destination}">
                  <p class="port-demand-header"><strong>Destination Demand (${formatPortName(vessel.route_destination)}):</strong></p>
                  <div class="port-demand-content" id="dest-demand-${vessel.id}">Loading...</div>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      ` : ''}

      <div class="vessel-info-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Vessel Specifications
        </h4>
        <div class="section-content">
          <div class="vessel-specs">
            <div class="vessel-spec"><strong>Type:</strong> ${vessel.type_name === 'N/A' ? 'Custom' : (vessel.type_name || 'N/A')}</div>
            <div class="vessel-spec"><strong>Capacity:</strong> ${capacityDisplay}</div>
            <div class="vessel-spec"><strong>Range:</strong> ${formatNumber(vessel.range)} nm</div>
            <div class="vessel-spec ${getCO2Class(vessel.co2_factor)}"><strong>CO2 Factor:</strong> ${vessel.co2_factor || 'N/A'}</div>
            <div class="vessel-spec ${getFuelClass(vessel.fuel_factor)}"><strong>Fuel Factor:</strong> ${vessel.fuel_factor || 'N/A'}</div>
            ${vessel.fuel_consumption_display ? `<div class="vessel-spec"><strong>Fuel Cons.:</strong> ${vessel.fuel_consumption_display}</div>` : ''}
            <div class="vessel-spec"><strong>Fuel Cap.:</strong> ${formatNumber(vessel.fuel_capacity)} t</div>
            <div class="vessel-spec"><strong>Service:</strong> ${vessel.hours_between_service || 'N/A'}h</div>
            <div class="vessel-spec"><strong>Engine:</strong> ${vessel.engine_type || 'N/A'} (${formatNumber(vessel.kw)} kW)</div>
            <div class="vessel-spec"><strong>Speed:</strong> ${vessel.max_speed || 'N/A'} kn</div>
            <div class="vessel-spec"><strong>Year:</strong> ${vessel.year || 'N/A'}</div>
            <div class="vessel-spec"><strong>Length:</strong> ${vessel.length || 'N/A'} m</div>
            ${vessel.width && vessel.width !== 0 ? `<div class="vessel-spec"><strong>Width:</strong> ${vessel.width} m</div>` : ''}
            <div class="vessel-spec"><strong>IMO:</strong> ${vessel.imo || 'N/A'}</div>
            <div class="vessel-spec"><strong>MMSI:</strong> ${vessel.mmsi || 'N/A'}</div>
            ${vessel.gearless ? '<div class="vessel-spec vessel-spec-fullwidth vessel-spec-gearless"><strong>⚙️ Gearless:</strong> own cranes</div>' : ''}
            ${vessel.antifouling ? `<div class="vessel-spec vessel-spec-fullwidth vessel-spec-antifouling"><strong>🛡️ Antifouling:</strong> ${vessel.antifouling}</div>` : ''}
            ${vessel.bulbous_bow ? '<div class="vessel-spec vessel-spec-fullwidth"><strong>🌊 Bulbous Bow:</strong> equipped</div>' : ''}
            ${vessel.enhanced_thrusters ? '<div class="vessel-spec vessel-spec-fullwidth"><strong>🔧 Enhanced Thrusters:</strong> equipped</div>' : ''}
            ${vessel.is_parked ? '<div class="vessel-spec vessel-spec-fullwidth"><strong>🅿️ Parked:</strong> vessel is parked</div>' : ''}
            ${vessel.perks ? `<div class="vessel-spec vessel-spec-fullwidth"><strong>Perks:</strong> ${vessel.perks}</div>` : ''}
          </div>
        </div>
      </div>


      <div class="vessel-info-section vessel-history-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Trip History
          <div class="history-export-dropdown" style="margin-left: auto; position: relative;">
            <button class="history-export-btn" onclick="event.stopPropagation(); window.harborMap.toggleExportMenu()" title="Export History">💾</button>
            <div id="historyExportMenu" class="history-export-menu hidden">
              <button class="history-export-menu-item" onclick="event.stopPropagation(); window.harborMap.exportHistoryFormat('txt')">📄 TXT</button>
              <button class="history-export-menu-item" onclick="event.stopPropagation(); window.harborMap.exportHistoryFormat('csv')">📊 CSV</button>
              <button class="history-export-menu-item" onclick="event.stopPropagation(); window.harborMap.exportHistoryFormat('json')">🗂️ JSON</button>
            </div>
          </div>
        </h4>
        <div class="section-content">
          <div id="vessel-history-loading">Loading history...</div>
          <div id="vessel-history-content"></div>
        </div>
      </div>
    </div>
  `;

  // Show panel
  panel.classList.add('active');

  // Load weather data for vessel location (if vessel has location)
  if (vessel.position && vessel.position.lat && vessel.position.lon && imageUrl) {
    loadVesselWeather(parseFloat(vessel.position.lat), parseFloat(vessel.position.lon));
  }

  // Enable fullscreen on mobile when panel opens
  const isMobile = isMobileDevice();
  console.log('[Vessel Panel] isMobile:', isMobile, 'window.innerWidth:', window.innerWidth);
  if (isMobile) {
    document.body.classList.add('map-fullscreen');
    console.log('[Vessel Panel] Added map-fullscreen class to body. Classes:', document.body.classList.toString());
  }

  // Setup export menu close handler (like logbook)
  setTimeout(() => {
    document.addEventListener('click', closeExportMenuOnClickOutside);
  }, 100);

  // Setup infinite scroll for history
  setupInfiniteScroll(panel);

  // Load trip history - skip for vessels that cannot have history yet
  // - pending/delivery: vessel not yet delivered, no trips possible
  // - total_distance_traveled === 0 AND not enroute: never made a trip and not currently on first trip
  const skipHistory = vessel.status === 'pending' || vessel.status === 'delivery' ||
    (vessel.total_distance_traveled === 0 && vessel.status !== 'enroute');

  if (skipHistory) {
    const contentEl = document.getElementById('vessel-history-content');
    const loadingEl = document.getElementById('vessel-history-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.innerHTML = '<p class="no-data">No trip history available</p>';
  } else {
    await loadVesselHistory(vessel.id);
  }

  // Load port demands for route details (if vessel is enroute)
  if (vessel.status === 'enroute' && (vessel.route_origin || vessel.route_destination)) {
    loadRoutePortDemands(vessel.id, vessel.route_origin, vessel.route_destination);
  }
}

/**
 * Closes export menu when clicking outside
 * @param {Event} e - Click event
 */
function closeExportMenuOnClickOutside(e) {
  const menu = document.getElementById('historyExportMenu');
  const exportBtn = document.querySelector('.history-export-btn');

  if (menu && !menu.classList.contains('hidden') && exportBtn && !exportBtn.contains(e.target) && !menu.contains(e.target)) {
    menu.classList.add('hidden');
  }
}

/**
 * Load and display port demands for route details
 * Fetches demand data for origin and destination ports
 * @param {number} vesselId - Vessel ID for element IDs
 * @param {string} originPort - Origin port code
 * @param {string} destPort - Destination port code
 */
async function loadRoutePortDemands(vesselId, originPort, destPort) {
  const fetchPortDemand = async (portCode) => {
    try {
      const response = await fetch('/api/route/get-port-demand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port_code: portCode })
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data.port;
    } catch (error) {
      console.warn(`[Vessel Panel] Failed to fetch demand for ${portCode}:`, error);
      return null;
    }
  };

  const formatDemandHtml = (port) => {
    if (!port || !port.demand) {
      return '<span class="no-demand">No demand data</span>';
    }

    const demand = port.demand;
    const consumed = port.consumed || {};
    const lines = [];

    if (demand.container) {
      const dryDemand = demand.container.dry || 0;
      const dryConsumed = consumed.container?.dry || 0;
      const dryRemaining = Math.max(0, dryDemand - dryConsumed);

      const refDemand = demand.container.refrigerated || 0;
      const refConsumed = consumed.container?.refrigerated || 0;
      const refRemaining = Math.max(0, refDemand - refConsumed);

      lines.push('<b>Container:</b>');
      lines.push(`Dry: ${dryRemaining.toLocaleString()} / ${dryDemand.toLocaleString()} TEU`);
      lines.push(`Ref: ${refRemaining.toLocaleString()} / ${refDemand.toLocaleString()} TEU`);
    }

    if (demand.tanker) {
      const fuelDemand = demand.tanker.fuel || 0;
      const fuelConsumed = consumed.tanker?.fuel || 0;
      const fuelRemaining = Math.max(0, fuelDemand - fuelConsumed);

      const crudeDemand = demand.tanker.crude_oil || 0;
      const crudeConsumed = consumed.tanker?.crude_oil || 0;
      const crudeRemaining = Math.max(0, crudeDemand - crudeConsumed);

      lines.push('<b>Tanker:</b>');
      lines.push(`Fuel: ${fuelRemaining.toLocaleString()} / ${fuelDemand.toLocaleString()} bbl`);
      lines.push(`Crude: ${crudeRemaining.toLocaleString()} / ${crudeDemand.toLocaleString()} bbl`);
    }

    if (lines.length === 0) {
      return '<span class="no-demand">No demand data</span>';
    }

    return `<small>Remaining / Total</small><br>${lines.join('<br>')}`;
  };

  // Fetch both ports in parallel
  const [originData, destData] = await Promise.all([
    originPort ? fetchPortDemand(originPort) : null,
    destPort ? fetchPortDemand(destPort) : null
  ]);

  // Update origin demand
  if (originPort) {
    const originEl = document.getElementById(`origin-demand-${vesselId}`);
    if (originEl) {
      originEl.innerHTML = formatDemandHtml(originData);
    }
  }

  // Update destination demand
  if (destPort) {
    const destEl = document.getElementById(`dest-demand-${vesselId}`);
    if (destEl) {
      destEl.innerHTML = formatDemandHtml(destData);
    }
  }
}

/**
 * Sets up infinite scroll for vessel history
 * Automatically loads more trips when scrolling near bottom
 * @param {HTMLElement} panel - The vessel detail panel
 */
function setupInfiniteScroll(panel) {
  // Wait for history section to be rendered
  setTimeout(() => {
    const historySection = panel.querySelector('.vessel-history-section .section-content');
    if (!historySection) {
      console.warn('[Vessel Panel] History section not found for infinite scroll');
      return;
    }

    historySection.addEventListener('scroll', () => {
      // Check if user scrolled near bottom (within 100px)
      const scrolledToBottom = historySection.scrollHeight - historySection.scrollTop - historySection.clientHeight < 100;

      if (scrolledToBottom && displayedHistoryCount < allHistoryData.length) {
        console.log(`[Vessel Panel] Loading more history... (${displayedHistoryCount}/${allHistoryData.length})`);
        renderHistoryPage();
      }
    });
  }, 100);
}

/**
 * Hides vessel detail panel
 *
 * @returns {void}
 * @example
 * hideVesselPanel();
 */
export function hideVesselPanel() {
  const panel = document.getElementById('vessel-detail-panel');
  if (!panel) return;

  panel.classList.remove('active');

  // Reset transform if panel was dragged
  panel.style.transform = '';
  panel.style.transition = '';

  // Close weather popup
  const map = getMap();
  if (map) {
    map.closePopup();
  }

  // DON'T remove fullscreen here - only in closeVesselPanel()
  // This allows seamless transitions between panels on mobile
}

// Store current vessel ID and history data for pagination
let currentVesselId = null;
let allHistoryData = [];
let displayedHistoryCount = 0;
const HISTORY_PAGE_SIZE = 3;

/**
 * Loads and renders vessel trip history
 * Displays past trips with origin, destination, cargo, profit
 *
 * @param {number} vesselId - Vessel ID
 * @returns {Promise<void>}
 * @example
 * await loadVesselHistory(1234);
 */
async function loadVesselHistory(vesselId) {
  const loadingEl = document.getElementById('vessel-history-loading');
  const contentEl = document.getElementById('vessel-history-content');

  if (!loadingEl || !contentEl) return;

  // Store vessel ID for export
  currentVesselId = vesselId;

  try {
    const data = await fetchVesselHistory(vesselId);

    // Hide loading
    loadingEl.style.display = 'none';

    // Render history
    if (!data.history || data.history.length === 0) {
      contentEl.innerHTML = '<p class="no-data">No trip history available</p>';
      return;
    }

    // Store full history (backend already returns newest first - no reverse needed)
    allHistoryData = data.history;
    displayedHistoryCount = 0;

    // Update current trip revenue per nm from newest history entry
    const revenuePerNmElement = document.getElementById('current-trip-revenue-per-nm');
    if (revenuePerNmElement && allHistoryData.length > 0) {
      const newestTrip = allHistoryData[0];
      if (newestTrip.profit && newestTrip.distance) {
        // Check if cargo was loaded
        let hasLoadedCargo = false;
        if (newestTrip.cargo) {
          if (newestTrip.cargo.dry > 0 || newestTrip.cargo.refrigerated > 0 ||
              newestTrip.cargo.fuel > 0 || newestTrip.cargo.crude_oil > 0) {
            hasLoadedCargo = true;
          }
        }
        if (hasLoadedCargo) {
          const revenuePerNm = (newestTrip.profit / newestTrip.distance).toFixed(2);
          revenuePerNmElement.innerHTML = `<strong>Revenue per nm:</strong> $${parseFloat(revenuePerNm).toLocaleString()}/nm`;
        } else {
          revenuePerNmElement.remove();
        }
      } else {
        revenuePerNmElement.remove();
      }
    }

    // Render first 3 trips
    renderHistoryPage();

  } catch (error) {
    loadingEl.style.display = 'none';
    contentEl.innerHTML = '<p class="error">Failed to load trip history</p>';
    console.error('Error loading vessel history:', error);
  }
}

/**
 * Renders a page of history entries
 * Shows HISTORY_PAGE_SIZE trips at a time
 */
function renderHistoryPage() {
  const contentEl = document.getElementById('vessel-history-content');

  if (!contentEl) return;

  // Format cargo display - returns { total: "X TEU (Y%)", list: "<ul>...</ul>" }
  const formatCargo = (cargo, capacity, utilization, dryRate, refRate, fuelRate, crudeRate) => {
    if (!cargo) return { total: 'N/A', list: '' };
    if (typeof cargo === 'string') return { total: escapeHtml(cargo), list: '' };

    // Tanker cargo - check FIRST because old data may have dry:0, refrigerated:0 for tankers
    // Tanker cargo has fuel and/or crude_oil fields
    if (cargo.fuel !== undefined || cargo.crude_oil !== undefined) {
      const fuel = cargo.fuel || 0;
      const crude = cargo.crude_oil || 0;
      const total = fuel + crude;

      // Build utilization string
      let utilizationStr = '';
      if (utilization !== null && utilization !== undefined) {
        utilizationStr = ` (${Math.round(utilization * 100)}%)`;
      }

      // Total string (no HTML wrapper)
      const totalStr = `${total.toLocaleString()} bbl${utilizationStr}`;

      // Detail items
      const items = [];
      if (fuel > 0) {
        const rateStr = fuelRate ? ` | $${fuelRate}/bbl` : '';
        items.push(`<li>Fuel: ${fuel.toLocaleString()} bbl${rateStr}</li>`);
      }
      if (crude > 0) {
        const rateStr = crudeRate ? ` | $${crudeRate}/bbl` : '';
        items.push(`<li>Crude: ${crude.toLocaleString()} bbl${rateStr}</li>`);
      }
      const listHtml = items.length > 0 ? `<ul class="cargo-list">${items.join('')}</ul>` : '';
      return { total: totalStr, list: listHtml };
    }

    // Container cargo
    if (cargo.dry !== undefined || cargo.refrigerated !== undefined) {
      const dry = cargo.dry || 0;
      const ref = cargo.refrigerated || 0;
      const total = dry + ref;

      // Build utilization string
      let utilizationStr = '';
      if (utilization !== null && utilization !== undefined) {
        utilizationStr = ` (${Math.round(utilization * 100)}%)`;
      }

      // Total string (no HTML wrapper)
      const totalStr = `${total.toLocaleString()} TEU${utilizationStr}`;

      // Detail items
      const items = [];
      if (dry > 0) {
        const rateStr = dryRate ? ` | $${dryRate}/TEU` : '';
        items.push(`<li>Dry: ${dry.toLocaleString()} TEU${rateStr}</li>`);
      }
      if (ref > 0) {
        const rateStr = refRate ? ` | $${refRate}/TEU` : '';
        items.push(`<li>Ref: ${ref.toLocaleString()} TEU${rateStr}</li>`);
      }
      const listHtml = items.length > 0 ? `<ul class="cargo-list">${items.join('')}</ul>` : '';
      return { total: totalStr, list: listHtml };
    }

    return { total: escapeHtml(JSON.stringify(cargo)), list: '' };
  };

  // Format duration (seconds to human readable)
  const formatDuration = (seconds) => {
    if (!seconds) return 'N/A';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  // Get next page of trips
  const nextTrips = allHistoryData.slice(displayedHistoryCount, displayedHistoryCount + HISTORY_PAGE_SIZE);
  displayedHistoryCount += nextTrips.length;

  // Format port name - uses game display codes (e.g., "US NYC")
  const formatPortName = (portCode) => {
    if (!portCode) return 'N/A';
    return escapeHtml(toGameCode(portCode));
  };

  // Render trips
  const historyHtml = nextTrips.map(trip => {
    // Calculate revenue per nautical mile if we have cargo and profit
    let revenuePerNm = null;
    if (trip.profit && trip.distance && trip.cargo) {
      // Check if cargo was actually loaded (not empty)
      let hasLoadedCargo = false;
      if (typeof trip.cargo === 'object' && trip.cargo !== null) {
        if (trip.cargo.dry > 0 || trip.cargo.refrigerated > 0 || trip.cargo.fuel > 0 || trip.cargo.crude_oil > 0) {
          hasLoadedCargo = true;
        }
      }

      if (hasLoadedCargo) {
        revenuePerNm = (trip.profit / trip.distance).toFixed(2);
      }
    }

    // Check if it's a drydock operation
    const isDrydockOperation = trip.is_drydock_operation === true;

    // Check if it's a service trip (no cargo loaded and not drydock)
    const isServiceTrip = !isDrydockOperation && !trip.profit && trip.cargo &&
      (trip.cargo.dry === 0 && trip.cargo.refrigerated === 0 &&
       trip.cargo.fuel === 0 && trip.cargo.crude_oil === 0);

    // Check if harbor fee is high (using user's percentage threshold)
    const settings = window.getSettings ? window.getSettings() : {};
    const harborFeeThreshold = settings.harborFeeWarningThreshold || 50; // Default 50%
    const feePercentage = trip.profit > 0 && trip.harbor_fee ? (trip.harbor_fee / trip.profit) * 100 : 0;
    const isHighHarborFee = feePercentage > harborFeeThreshold;
    const entryClass = isHighHarborFee ? 'history-entry high-harbor-fee' : 'history-entry';
    const cargoData = formatCargo(trip.cargo, trip.capacity, trip.utilization, trip.dry_rate, trip.ref_rate, trip.fuel_rate, trip.crude_rate);

    return `
    <div class="${entryClass}">
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
          <span class="cargo-label">Cargo: ${cargoData.total}</span>
        </div>
        ${cargoData.list ? `
        <div class="history-row cargo-row">
          ${cargoData.list}
        </div>` : ''}
        <div class="history-row">
          <span>Income: ${isServiceTrip ? 'Service Trip' : '$' + (trip.profit !== null && trip.profit !== undefined ? trip.profit.toLocaleString() : '?')}</span>
        </div>
        ${trip.harbor_fee !== null && trip.harbor_fee !== undefined ? `
        <div class="history-row${isHighHarborFee ? ' high-fee-text' : ''}">
          <span>Harbor Fee: $${trip.harbor_fee.toLocaleString()} (${Math.round(feePercentage)}%)${isHighHarborFee ? ` (>${harborFeeThreshold}%)` : ''}</span>
        </div>
        ` : ''}
        ${trip.contribution !== null && trip.contribution !== undefined ? `
        <div class="history-row">
          <span>Contribution: +${trip.contribution.toFixed(2)}</span>
        </div>
        ` : ''}
        ${trip.speed !== null && trip.speed !== undefined ? `
        <div class="history-row">
          <span>Speed: ${trip.speed} kn</span>
        </div>
        ` : ''}
        ${trip.guards !== null && trip.guards !== undefined ? `
        <div class="history-row">
          <span>Guards: ${trip.guards}</span>
        </div>
        ` : ''}`}
        <div class="history-row">
          <span>Fuel used: ${(trip.fuel_used !== null && trip.fuel_used !== undefined) ? (trip.fuel_used / 1000).toLocaleString(undefined, {maximumFractionDigits: 0}) + ' t' : '0 t'}</span>
        </div>
        ${trip.co2_used !== null && trip.co2_used !== undefined ? `
        <div class="history-row">
          <span>CO2 used: ${trip.co2_used.toLocaleString(undefined, {maximumFractionDigits: 0})} t</span>
        </div>
        ` : ''}
        <div class="history-row">
          <span>Distance: ${trip.distance ? trip.distance.toLocaleString(undefined, {maximumFractionDigits: 0}) + ' nm' : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span>Duration: ${formatDuration(trip.duration)}</span>
        </div>
        <div class="history-row">
          <span>Wear: ${trip.wear ? trip.wear.toFixed(2) + '%' : 'N/A'}</span>
        </div>
        ${revenuePerNm ? `
        <div class="history-row">
          <span>Revenue/nm: $${parseFloat(revenuePerNm).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}/nm</span>
        </div>
        ` : ''}
      </div>
    </div>
    `;
  }).join('');

  // Append to existing content (infinite scroll)
  contentEl.innerHTML += historyHtml;
}

/**
 * Closes vessel panel and returns to overview
 *
 * @returns {Promise<void>}
 * @example
 * await closeVesselPanel();
 */
export async function closeVesselPanel() {
  hideVesselPanel();

  // Check if route planner is open - if so, just clear the route but keep planner open
  const isPlanning = window.harborMap && window.harborMap.isPlanningMode && window.harborMap.isPlanningMode();

  // Check if we came from analytics and should return there
  const returnToAnalytics = localStorage.getItem('returnToAnalytics');
  console.log('[Vessel Panel] closeVesselPanel - returnToAnalytics:', returnToAnalytics);
  if (returnToAnalytics === 'true') {
    localStorage.removeItem('returnToAnalytics');

    // Close harbor map and reopen analytics
    const harborMapOverlay = document.getElementById('harborMapOverlay');
    if (harborMapOverlay) {
      harborMapOverlay.classList.add('hidden');
    }

    const analyticsOverlay = document.getElementById('analyticsOverlay');
    if (analyticsOverlay) {
      analyticsOverlay.classList.remove('hidden');
    }

    // Remove fullscreen on mobile
    if (isMobileDevice()) {
      document.body.classList.remove('map-fullscreen');
    }

    console.log('[Vessel Panel] Returning to analytics');
    return;
  }

  // Remove fullscreen on mobile when explicitly closing panel
  if (isMobileDevice()) {
    document.body.classList.remove('map-fullscreen');

    // Force map invalidate size after fullscreen change
    const { getMap } = await import('./map-controller.js');
    const map = getMap();
    if (map) {
      setTimeout(() => {
        map.invalidateSize();
      }, 100);
    }
  }

  // If route planner is open, just clear route and refresh map but keep planner open
  if (isPlanning) {
    // Clear the route line from the map
    if (window.harborMap && window.harborMap.clearRoute) {
      window.harborMap.clearRoute();
    }
    // Refresh map with current filters (loadOverview will use cached filters)
    if (window.harborMap && window.harborMap.loadOverview) {
      await window.harborMap.loadOverview();
    }
    return;
  }

  await deselectAll();

  // Reopen route panel if route filter is still active
  const routeSelect = document.getElementById('routeFilterSelect');
  if (routeSelect && routeSelect.value && routeSelect.value !== 'all') {
    routeSelect.dispatchEvent(new Event('change'));
  }
}

// Queue for individual vessel departures
const departureQueue = []; // Items: { vesselId, vesselName, resolve, reject }
let isProcessingQueue = false;
let autopilotWaitNotificationShown = false;

/**
 * Checks if a local departure is in progress (queue not empty or processing)
 * @returns {boolean} True if local departure is in progress
 */
export function isLocalDepartInProgress() {
  return isProcessingQueue || departureQueue.length > 0;
}

/**
 * Processes the departure queue one vessel at a time
 */
async function processDepartureQueue() {
  if (isProcessingQueue || departureQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  const { showSideNotification } = await import('../utils.js');

  // Track failures for summary notification
  const failuresByReason = {}; // { reason: count }

  while (departureQueue.length > 0) {
    const { vesselId, vesselName, resolve, reject } = departureQueue.shift();

    try {
      const { departVessels } = await import('../api.js');
      console.log(`[Vessel Panel] Processing departure for ${vesselName} (${departureQueue.length} more in queue)`);

      const result = await departVessels([vesselId]);

      // Handle special case: autopilot is currently departing vessels
      if (result.reason === 'depart_in_progress') {
        console.log(`[Vessel Panel] ${vesselName} queued - autopilot departure in progress`);

        // Only show notification once per queue processing session
        if (!autopilotWaitNotificationShown) {
          showSideNotification('Queued - waiting for autopilot to finish departing vessels', 'info');
          autopilotWaitNotificationShown = true;
        }

        // Wait 5 seconds before retry (don't spam the server)
        await new Promise(r => setTimeout(r, 5000));
        departureQueue.unshift({ vesselId, vesselName, resolve, reject }); // Add back to front of queue
        continue;
      }

      // Handle global insufficient fuel - track for summary
      if (result.reason === 'insufficient_fuel') {
        console.log(`[Vessel Panel] ${vesselName} blocked - insufficient fuel`);
        failuresByReason['insufficient fuel'] = (failuresByReason['insufficient fuel'] || 0) + 1;
        reject(new Error('Insufficient fuel'));
        continue;
      }

      // Check if vessel was successfully departed (API returns departedCount/failedCount)
      if (result.departedCount > 0) {
        console.log(`[Vessel Panel] ${vesselName} departed successfully`);
        resolve(result);
      } else {
        // Vessel failed to depart - extract error info and track
        let reason = 'Unknown error';

        if (result.failedCount > 0 && result.failedVessels && result.failedVessels.length > 0) {
          reason = result.failedVessels[0].reason || reason;
        } else {
          reason = result.message || result.reason || reason;
        }

        // Log full result object if reason is still unknown (debug API response structure)
        if (reason === 'Unknown error') {
          console.error(`[Vessel Panel] Failed to depart ${vesselName} - Full API response:`, JSON.stringify(result, null, 2));
        } else {
          console.error(`[Vessel Panel] Failed to depart ${vesselName}:`, reason);
        }

        failuresByReason[reason] = (failuresByReason[reason] || 0) + 1;
        reject(new Error(reason));
      }
    } catch (error) {
      console.error(`[Vessel Panel] Error departing vessel ${vesselId}:`, error);
      failuresByReason[error.message] = (failuresByReason[error.message] || 0) + 1;
      reject(error);
    }

    // Small delay between departures to avoid overwhelming the server
    if (departureQueue.length > 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Show summary notification for failures
  const failureReasons = Object.keys(failuresByReason);
  if (failureReasons.length > 0) {
    const totalFailed = Object.values(failuresByReason).reduce((a, b) => a + b, 0);
    let summaryHtml = `<div style="margin-bottom: 8px;"><strong>${totalFailed} vessel${totalFailed > 1 ? 's' : ''} could not depart</strong></div>`;

    // Group by reason
    failureReasons.forEach(reason => {
      const count = failuresByReason[reason];
      summaryHtml += `<div style="font-size: 0.9em; color: #9ca3af;">${count}x ${escapeHtml(reason)}</div>`;
    });

    showSideNotification(summaryHtml, 'error', 10000);
  }

  isProcessingQueue = false;
  autopilotWaitNotificationShown = false; // Reset for next queue session
}

/**
 * Departs vessel using queue system
 *
 * @param {number} vesselId - Vessel ID to depart
 * @returns {Promise<void>}
 * @example
 * await departVessel(1234, 'MV Atlantic Star');
 */
export async function departVessel(vesselId, vesselName) {
  // Check if departure is already in progress (server lock active)
  // BUT: If local queue is empty, allow departure anyway (fallback for stuck server lock)
  if (isDepartInProgress() && isLocalDepartInProgress()) {
    showSideNotification('Departure in progress - please wait', 'warning');
    return;
  }

  // Log warning if server lock is stuck but queue is empty
  if (isDepartInProgress() && !isLocalDepartInProgress()) {
    console.warn('[Vessel Panel] Server lock is active but local queue is empty - proceeding anyway (stuck lock fallback)');
    showSideNotification('Departure lock appears stuck - proceeding anyway', 'warning', 3000);
  }

  // Immediately disable depart button in vessel panel
  const departBtn = document.querySelector(`.depart-vessel-btn[data-vessel-id="${vesselId}"]`);
  if (departBtn) {
    departBtn.classList.add('disabled');
    departBtn.onclick = null;
    departBtn.title = 'Departure in progress...';
  }

  // Update Depart Manager button state immediately
  if (window.updateDepartManagerLockState) {
    window.updateDepartManagerLockState();
  }

  return new Promise((resolve, reject) => {
    // Add to queue with name
    departureQueue.push({ vesselId, vesselName, resolve, reject });
    console.log(`[Vessel Panel] Added ${vesselName} to departure queue (position: ${departureQueue.length})`);

    // Process queue
    processDepartureQueue();
  }).then(async (result) => {
    // Success callback
    console.log('[Vessel Panel] Vessel departed successfully');

    // NOTE: Detailed notification is shown via WebSocket event 'vessels_depart_complete'
    // which includes income, fuel used, CO2 used, harbor fees, etc.
    // No simple notification here - let the WebSocket handler in chat.js show the detailed one

    // Update vessel count in header
    if (window.updateVesselCount) {
      await window.updateVesselCount();
    }

    // Refresh all badges (anchor count, harbor master, etc.)
    if (window.badgeCache && window.badgeCache.refreshAll) {
      window.badgeCache.refreshAll();
    }

    // Wait longer for server to process the departure and update status
    console.log('[Vessel Panel] Waiting for server to process departure...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get updated vessel data with retry logic (fetches fresh data from server)
    if (window.harborMap && window.harborMap.getVesselById) {
      let updatedVessel = null;
      let attempts = 0;
      const maxAttempts = 3;

      // Retry getting vessel data until status changes or max attempts reached
      while (attempts < maxAttempts) {
        updatedVessel = await window.harborMap.getVesselById(vesselId, true); // skipCache = true

        if (updatedVessel && updatedVessel.status !== 'port') {
          console.log('[Vessel Panel] Vessel status updated to:', updatedVessel.status);
          break;
        }

        attempts++;
        if (attempts < maxAttempts) {
          console.log(`[Vessel Panel] Status still 'port', retrying (${attempts}/${maxAttempts})...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Next iteration will fetch fresh data from server
        }
      }

      if (updatedVessel) {
        console.log('[Vessel Panel] Vessel departed successfully, status:', updatedVessel.status);
        // Re-render the vessel panel with updated data
        await showVesselPanel(updatedVessel);
      } else {
        console.warn('[Vessel Panel] Could not find vessel after departure:', vesselId);
      }
    }

    return result;
  }).catch(() => {
    // Error already handled and shown as side notification in processDepartureQueue
    // No additional logging needed here
  });
}

/**
 * Update all vessel panel depart buttons based on server lock state
 * Called from vessel-management.js when lock state changes
 */
export function updateVesselPanelDepartButtons() {
  const isLocked = isDepartInProgress();
  const departButtons = document.querySelectorAll('.depart-vessel-btn');

  departButtons.forEach(btn => {
    const vesselId = btn.dataset.vesselId;
    const vesselName = btn.dataset.vesselName;
    if (isLocked) {
      btn.classList.add('disabled');
      btn.onclick = null;
      btn.title = 'Depart in progress - please wait';
    } else {
      // Re-enable if vessel is at port - status will be checked on click
      btn.classList.remove('disabled');
      btn.title = 'Depart vessel from port';
      btn.onclick = () => window.harborMap.departVessel(parseInt(vesselId), vesselName);
    }
  });
}

// Expose to window for cross-module access
window.updateVesselPanelDepartButtons = updateVesselPanelDepartButtons;

/**
 * Refreshes the open vessel panel with fresh data from the API.
 * Called when vessels are departed (autopilot or manual) to update status display.
 * Only refreshes if a vessel panel is currently open.
 *
 * @returns {Promise<void>}
 */
export async function refreshOpenVesselPanel() {
  const panel = document.getElementById('vessel-detail-panel');
  if (!panel || !panel.classList.contains('active')) {
    return; // No panel open
  }

  if (!currentVesselId) {
    return; // No vessel ID stored
  }

  console.log(`[Vessel Panel] Refreshing open panel for vessel ${currentVesselId}`);

  try {
    // Fetch fresh vessel data
    const freshVessel = await getVesselById(currentVesselId, true);
    if (freshVessel) {
      // Re-render the entire panel with fresh data
      await showVesselPanel(freshVessel);
      console.log(`[Vessel Panel] Panel refreshed - status: ${freshVessel.status}`);
    }
  } catch (error) {
    console.error('[Vessel Panel] Error refreshing panel:', error);
  }
}

// Expose refresh function to window for cross-module access
window.refreshOpenVesselPanel = refreshOpenVesselPanel;

/**
 * Returns the currently displayed vessel ID, or null if no panel is open.
 * @returns {number|null}
 */
export function getCurrentVesselId() {
  return currentVesselId;
}
window.getCurrentVesselId = getCurrentVesselId;

/**
 * Toggle export menu visibility
 */
export function toggleExportMenu() {
  const menu = document.getElementById('historyExportMenu');
  if (menu) {
    menu.classList.toggle('hidden');
  }
}

/**
 * Export vessel history in specified format
 * Uses backend export endpoint (like autopilot logbook)
 *
 * @param {string} format - 'txt', 'csv', or 'json'
 */
export async function exportHistoryFormat(format) {
  const menu = document.getElementById('historyExportMenu');
  if (menu) {
    menu.classList.add('hidden');
  }

  if (!currentVesselId) {
    alert('No vessel selected');
    return;
  }

  if (!allHistoryData || allHistoryData.length === 0) {
    alert('No history data to export');
    return;
  }

  try {
    console.log(`[Vessel Panel] Exporting history for vessel ${currentVesselId} as ${format}`);

    // Fetch export from backend
    const content = await exportVesselHistory(currentVesselId, format);

    // Determine file extension and MIME type
    let mimeType, extension;
    if (format === 'txt') {
      mimeType = 'text/plain';
      extension = 'txt';
    } else if (format === 'csv') {
      mimeType = 'text/csv';
      extension = 'csv';
    } else if (format === 'json') {
      mimeType = 'application/json';
      extension = 'json';
    }

    // Trigger download
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vessel-history-${currentVesselId}-${Date.now()}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`[Vessel Panel] Export successful: ${allHistoryData.length} entries as ${format.toUpperCase()}`);
  } catch (error) {
    console.error('[Vessel Panel] Export failed:', error);
    alert('Export failed. Please try again.');
  }
}

/**
 * Sells a vessel from the vessel panel with confirmation dialog
 * Fetches actual sell price from API before showing confirmation
 *
 * @param {number} vesselId - Vessel ID to sell
 * @param {string} vesselName - Vessel name for display
 * @returns {Promise<void>}
 */
export async function sellVesselFromPanel(vesselId, vesselName) {
  try {
    // Import dialog and utils
    const { showConfirmDialog } = await import('../ui-dialogs.js');
    const { formatNumber } = await import('../utils.js');

    // Get actual sell price from API
    const priceResponse = await fetch(window.apiUrl('/api/vessel/get-sell-price'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_id: vesselId })
    });

    if (!priceResponse.ok) {
      const errorText = await priceResponse.text();
      console.error('[Vessel Panel] Sell price API error:', errorText);
      throw new Error(`Failed to get sell price: ${priceResponse.status} ${priceResponse.statusText}`);
    }

    const priceData = await priceResponse.json();
    console.log('[Vessel Panel] Sell price response:', priceData);

    if (!priceData.data?.selling_price && priceData.data?.selling_price !== 0) {
      throw new Error(`API did not return selling_price. Response: ${JSON.stringify(priceData)}`);
    }

    const sellPrice = priceData.data.selling_price;
    const originalPrice = priceData.data.original_price;

    // Show confirmation dialog with custom formatting
    const confirmed = await showConfirmDialog({
      title: `Vessel ${vesselName}`,
      message: `
        <div style="text-align: center; line-height: 1.8;">
          <div style="color: #9ca3af; font-size: 14px; margin-bottom: 8px;">
            Original Price: $${formatNumber(originalPrice)}
          </div>
          <div style="color: #6b7280; margin-bottom: 8px;">
            ━━━━━━━━━━━━━━━━━━━━━━
          </div>
          <div style="color: #10b981; font-size: 16px; font-weight: 600;">
            Sell Price: $${formatNumber(sellPrice)}
          </div>
        </div>
      `,
      confirmText: 'Sell'
    });

    if (!confirmed) return;

    // Sell vessel via API
    const response = await fetch(window.apiUrl('/api/vessel/sell-vessels'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: [vesselId] })
    });

    if (!response.ok) throw new Error('Failed to sell vessel');

    await response.json();

    // Send summary notification to backend (same as bulkSellVessels)
    // This triggers WebSocket broadcast with header_data_update
    try {
      await fetch(window.apiUrl('/api/vessel/broadcast-sale-summary'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vessels: [{
            name: vesselName,
            quantity: 1,
            price: sellPrice,
            totalPrice: sellPrice
          }],
          totalPrice: sellPrice,
          totalVessels: 1
        })
      });
    } catch (err) {
      console.error('[Vessel Panel] Error broadcasting sale summary:', err);
    }

    // Close panel and reload overview
    await closeVesselPanel();

    // Update vessel count badge
    if (window.updateVesselCount) {
      await window.updateVesselCount();
    }

    // Refresh harbor map to remove sold vessel from rawVessels
    if (window.harborMap && window.harborMap.forceRefresh) {
      await window.harborMap.forceRefresh();
    }

    // NOTE: Success notification is shown via WebSocket (user_action_notification)
    // from server/routes/game/vessel.js - no duplicate notification here
  } catch (error) {
    console.error('[Vessel Panel] Sell error:', error);
    const errorMsg = error.message || error.toString() || 'Unknown error';
    alert(`Error selling vessel: ${errorMsg}`);
  }
}

/**
 * Opens repair & drydock dialog for a specific vessel
 * @param {number} vesselId - Vessel ID
 */
async function openRepairDialog(vesselId) {
  const settings = window.settings || {};

  // Import openRepairAndDrydockDialog from vessel-management
  if (window.openRepairAndDrydockDialog) {
    await window.openRepairAndDrydockDialog(settings, vesselId);
  } else {
    showSideNotification('Repair dialog not available', 'error');
  }
}

/**
 * Start editing vessel name - switches to input mode
 * @param {number} vesselId - Vessel ID to rename
 */
export function startRenameVessel(vesselId) {
  const displaySpan = document.getElementById(`vessel-name-display-${vesselId}`);
  const inputField = document.getElementById(`vessel-name-input-${vesselId}`);

  if (!displaySpan || !inputField) return;

  // Hide display, show input
  displaySpan.classList.add('hidden');
  inputField.classList.remove('hidden');
  inputField.focus();
  inputField.select();

  // Save on Enter key
  inputField.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await saveVesselRename(vesselId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelVesselRename(vesselId);
    }
  });

  // Save on blur (clicking outside)
  inputField.addEventListener('blur', async () => {
    await saveVesselRename(vesselId);
  }, { once: true });
}

/**
 * Cancel vessel rename - restore display mode
 * @param {number} vesselId - Vessel ID
 */
function cancelVesselRename(vesselId) {
  const displaySpan = document.getElementById(`vessel-name-display-${vesselId}`);
  const inputField = document.getElementById(`vessel-name-input-${vesselId}`);

  if (!displaySpan || !inputField) return;

  // Restore original value
  inputField.value = displaySpan.textContent;

  // Show display, hide input
  displaySpan.classList.remove('hidden');
  inputField.classList.add('hidden');
}

/**
 * Update vessel name in ships menu (vessel-management overlay)
 * @param {number} vesselId - Vessel ID
 * @param {string} newName - New vessel name
 */
function updateVesselNameInShipsMenu(vesselId, newName) {
  // Find vessel cards by locate button data-vessel-id
  const locateButtons = document.querySelectorAll(`.vessel-locate-btn[data-vessel-id="${vesselId}"]`);
  locateButtons.forEach(btn => {
    const card = btn.closest('.vessel-card');
    if (card) {
      updateVesselCardName(card, newName);
    }
  });

  // Also check for vessel cards without locate button (standard vessels)
  const selectButtons = document.querySelectorAll(`.vessel-select-btn[data-vessel-id="${vesselId}"]`);
  selectButtons.forEach(btn => {
    const card = btn.closest('.vessel-card');
    if (card) {
      updateVesselCardName(card, newName);
    }
  });

  // Update vessel image in the vessel panel itself (for custom vessels)
  const panelImage = document.querySelector('#vessel-panel-image img');
  if (panelImage && panelImage.src.includes(`/api/vessel-svg/${vesselId}`) ||
      panelImage && panelImage.src.includes(`/api/vessel-image/custom/${vesselId}`)) {
    const url = new URL(panelImage.src, window.location.origin);
    url.searchParams.set('name', newName);
    panelImage.src = url.toString();
  }
}

/**
 * Update vessel card name and image (for custom vessels with name in URL)
 * @param {HTMLElement} card - Vessel card element
 * @param {string} newName - New vessel name
 */
function updateVesselCardName(card, newName) {
  // Update text name
  const nameEl = card.querySelector('.vessel-name');
  if (nameEl) {
    nameEl.textContent = newName;
  }

  // Update image URL if it's a custom vessel (name is in URL)
  const img = card.querySelector('.vessel-image');
  if (img && img.src.includes('/api/vessel-image/custom/')) {
    const url = new URL(img.src, window.location.origin);
    url.searchParams.set('name', newName);
    img.src = url.toString();
  }
}

/**
 * Save vessel rename - call API and update display
 * @param {number} vesselId - Vessel ID to rename
 */
async function saveVesselRename(vesselId) {
  const displaySpan = document.getElementById(`vessel-name-display-${vesselId}`);
  const inputField = document.getElementById(`vessel-name-input-${vesselId}`);

  if (!displaySpan || !inputField) return;

  const currentName = displaySpan.textContent;
  const newName = inputField.value.trim();

  // Validate length
  if (newName.length < 2 || newName.length > 30) {
    const { showSideNotification } = await import('../utils.js');
    showSideNotification('Vessel name must be between 2 and 30 characters', 'error', 4000);
    // Restore original value
    inputField.value = currentName;
    cancelVesselRename(vesselId);
    return;
  }

  // Same name - no change needed
  if (newName === currentName) {
    cancelVesselRename(vesselId);
    return;
  }

  try {
    // Call backend API
    const response = await fetch('/api/vessel/rename-vessel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_id: vesselId, name: newName })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to rename vessel');
    }

    // Check if API returned success
    if (data.success === true || data.data?.success === true) {
      const { showSideNotification } = await import('../utils.js');
      showSideNotification('Saved', 'success', 2000);

      // Update display span with new name
      displaySpan.textContent = newName;
      displaySpan.classList.remove('hidden');
      inputField.classList.add('hidden');

      // Update vessel name in ships menu if open
      updateVesselNameInShipsMenu(vesselId, newName);
    } else {
      throw new Error('Rename failed');
    }
  } catch (error) {
    console.error('[Vessel Rename] Error:', error);
    const { showSideNotification } = await import('../utils.js');
    showSideNotification(error.message || 'Failed to rename vessel', 'error', 4000);
    // Restore original value on error
    inputField.value = currentName;
    cancelVesselRename(vesselId);
  }
}

/**
 * Loads and displays weather data for vessel location
 * Fetches weather from Open-Meteo API and renders in overlay on vessel image
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<void>}
 */
async function loadVesselWeather(lat, lon) {
  const weatherOverlay = document.getElementById('vessel-weather-overlay');
  if (!weatherOverlay) return;

  try {
    // Check if weather data is enabled in settings
    const settings = window.getSettings ? window.getSettings() : {};
    if (settings.enableWeatherData === false) {
      weatherOverlay.style.display = 'none';
      return;
    }

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current_weather=true`;
    const response = await fetch(weatherUrl);
    const data = await response.json();

    if (!data.current_weather) {
      throw new Error('No weather data available');
    }

    const weather = data.current_weather;

    // Weather code to emoji mapping
    const weatherEmoji = {
      0: '☀️',    // Clear sky
      1: '🌤️',   // Mainly clear
      2: '⛅',    // Partly cloudy
      3: '☁️',    // Overcast
      45: '🌫️',  // Fog
      48: '🌫️',  // Depositing rime fog
      51: '🌧️',  // Drizzle light
      53: '🌧️',  // Drizzle moderate
      55: '🌧️',  // Drizzle dense
      61: '🌧️',  // Rain slight
      63: '🌧️',  // Rain moderate
      65: '🌧️',  // Rain heavy
      71: '🌨️',  // Snow fall slight
      73: '🌨️',  // Snow fall moderate
      75: '🌨️',  // Snow fall heavy
      77: '❄️',   // Snow grains
      80: '🌦️',  // Rain showers slight
      81: '🌦️',  // Rain showers moderate
      82: '🌦️',  // Rain showers violent
      85: '🌨️',  // Snow showers slight
      86: '🌨️',  // Snow showers heavy
      95: '⛈️',   // Thunderstorm
      96: '⛈️',   // Thunderstorm with hail
      99: '⛈️'    // Thunderstorm with heavy hail
    };

    const icon = weatherEmoji[weather.weathercode] || '🌤️';
    const temp = weather.temperature.toFixed(1);
    const wind = weather.windspeed.toFixed(0);

    // Render compact weather display
    weatherOverlay.innerHTML = `
      <div style="display: flex; align-items: center; gap: 4px;">
        <span style="font-size: 16px;">${icon}</span>
        <div style="line-height: 1.1;">
          <div style="font-weight: 600; font-size: 10px;">${temp}°C</div>
          <div style="font-size: 8px; opacity: 0.8;">💨 ${wind} km/h</div>
        </div>
      </div>
    `;
  } catch (error) {
    console.error('[Vessel Panel] Failed to fetch weather:', error);
    weatherOverlay.innerHTML = '<div style="color: #ef4444; font-size: 10px;">Weather unavailable</div>';
  }
}

/**
 * Toggles vessel parking status (park or resume)
 * @param {HTMLElement} buttonElement - The button element that was clicked
 */
async function toggleParkVessel(buttonElement) {
  const { showSideNotification } = await import('../utils.js');

  const vesselId = parseInt(buttonElement.dataset.vesselId);
  const isParked = buttonElement.dataset.isParked === 'true';

  try {
    const endpoint = isParked ? '/api/vessel/resume-parked-vessel' : '/api/vessel/park-vessel';
    const action = isParked ? 'resumed' : 'parked';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_id: vesselId })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const errorMsg = data.error || data.message || `Failed to ${action} vessel`;
      throw new Error(errorMsg);
    }

    showSideNotification(`Vessel ${action} successfully`, 'success');

    // Update button state immediately
    const newIsParked = !isParked;
    buttonElement.dataset.isParked = newIsParked ? 'true' : 'false';
    buttonElement.textContent = newIsParked ? '⛓️' : '🟢';

    // Update CSS classes
    if (newIsParked) {
      buttonElement.classList.remove('not-parked');
      buttonElement.classList.add('parked');
    } else {
      buttonElement.classList.remove('parked');
      buttonElement.classList.add('not-parked');
    }
  } catch (error) {
    console.error(`[Toggle Park Vessel] Error:`, error);
    showSideNotification(`Failed to ${isParked ? 'resume' : 'park'} vessel: ${escapeHtml(error.message)}`, 'error');
  }
}

// Expose functions to window for onclick handlers
window.harborMap = window.harborMap || {};
window.harborMap.closeVesselPanel = closeVesselPanel;
window.harborMap.departVessel = departVessel;
window.harborMap.sellVesselFromPanel = sellVesselFromPanel;
window.harborMap.openRepairDialog = openRepairDialog;
window.harborMap.toggleExportMenu = toggleExportMenu;
window.harborMap.exportHistoryFormat = exportHistoryFormat;
window.harborMap.startRenameVessel = startRenameVessel;
window.harborMap.toggleParkVessel = toggleParkVessel;
window.harborMap.openVesselAppearanceEditor = openVesselAppearanceEditor;
window.harborMap.getVesselById = getVesselById;

/**
 * Opens the vessel appearance editor for a custom vessel
 * @param {number} vesselId - Vessel ID
 * @param {string} vesselName - Vessel name
 */
async function openVesselAppearanceEditor(vesselId, vesselName) {
  const { openAppearanceEditor } = await import('../vessel-appearance-editor.js');

  // Get vessel data to pass existing values
  const vesselData = await getVesselById(vesselId);

  // Build existing data object from vessel
  // Use fuel_ref_speed_kn (from custom data) or fall back to max_speed (from game API)
  const existingData = vesselData ? {
    capacity_type: vesselData.capacity_type,
    capacity: vesselData.capacity,
    capacity_max: vesselData.capacity_max,
    name: vesselData.name,
    vessel_model: vesselData.capacity_type,
    speed: vesselData.fuel_ref_speed_kn || vesselData.max_speed,
    speed_kn: vesselData.fuel_ref_speed_kn || vesselData.max_speed,
    fuel_consumption: vesselData.fuel_consumption_kg_per_nm,
    kg_per_nm: vesselData.fuel_consumption_kg_per_nm
  } : {};

  openAppearanceEditor(vesselId, vesselName, existingData);
}
