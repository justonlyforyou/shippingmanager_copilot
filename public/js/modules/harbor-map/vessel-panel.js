/**
 * @fileoverview Vessel Detail Panel Component
 * Renders vessel information panel with trip history and actions
 * ONLY renders data - NO data processing
 *
 * @module harbor-map/vessel-panel
 */

import { fetchVesselHistory, exportVesselHistory } from './api-client.js';
import { deselectAll } from './map-controller.js';

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

  // Format port name with capital first letter
  const formatPortName = (portCode) => {
    if (!portCode) return 'N/A';
    return portCode.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
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
    const maxCapacity = Math.max(fuel, crude);
    capacityDisplay = `${formatNumber(maxCapacity)} bbl (${formatNumber(fuel)} bbl fuel / ${formatNumber(crude)} bbl crude)`;
  }

  // Current cargo loaded (detailed breakdown)
  // API uses 'capacity' for current loaded cargo, 'capacity_max' for maximum capacity
  let loadedCargoDisplay = '<p><strong>Loaded Cargo:</strong> N/A</p>';
  if (vessel.capacity) {
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
  }

  // Vessel image URL
  const imageUrl = vessel.type ? `https://shippingmanager.cc/images/acquirevessels/${vessel.type}` : '';

  // Render vessel full info with collapsible sections
  panel.innerHTML = `
    <div class="panel-header">
      <h3>${vessel.name}</h3>
      <button class="close-btn" onclick="window.harborMap.closeVesselPanel()">×</button>
    </div>

    <div class="panel-body">
      ${imageUrl ? `
        <div class="vessel-image-container">
          <img src="${imageUrl}" alt="${vessel.type_name}" class="vessel-image" onerror="this.style.display='none'">
          ${vessel.status === 'port' || vessel.status === 'anchor' ? `
            <div class="vessel-action-emojis">
              ${vessel.status === 'port' ? `
                <span
                  class="action-emoji"
                  onclick="window.harborMap.departVessel(${vessel.id})"
                  title="Depart vessel from port"
                >🏁</span>
              ` : ''}
              <span
                class="action-emoji"
                onclick="window.harborMap.sellVesselFromPanel(${vessel.id}, '${vessel.name.replace(/'/g, "\\'")}')"
                title="Sell this vessel"
              >💵</span>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <div class="vessel-info-section collapsible">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Status & Current Cargo
        </h4>
        <div class="section-content">
          <p><strong>Status:</strong> ${vessel.status}</p>
          ${vessel.eta !== 'N/A' ? `<p><strong>ETA:</strong> ${vessel.eta}</p>` : ''}
          ${vessel.current_port_code ? `<p><strong>Current Port:</strong> ${formatPortName(vessel.current_port_code)}</p>` : ''}
          ${vessel.time_arrival && vessel.time_arrival > 0 ? `<p><strong>Last Arrival:</strong> ${new Date(vessel.time_arrival * 1000).toLocaleString()}</p>` : ''}
          ${loadedCargoDisplay}
          ${vessel.prices && (vessel.prices.dry || vessel.prices.refrigerated) ? `
            <p><strong>Dry Container Rate:</strong> $${vessel.prices.dry}/TEU</p>
            <p><strong>Refrigerated Rate:</strong> $${vessel.prices.refrigerated}/TEU</p>
          ` : ''}
          ${vessel.prices && (vessel.prices.fuel || vessel.prices.crude_oil) ? `
            <p><strong>Fuel Rate:</strong> $${vessel.prices.fuel}/bbl</p>
            <p><strong>Crude Oil Rate:</strong> $${vessel.prices.crude_oil}/bbl</p>
          ` : ''}
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
            ${vessel.route_origin ? `<p><strong>Origin Port:</strong> ${formatPortName(vessel.route_origin)}</p>` : ''}
            ${vessel.route_destination ? `<p><strong>Destination Port:</strong> ${formatPortName(vessel.route_destination)}</p>` : ''}
            ${vessel.route_distance ? `<p><strong>Distance:</strong> ${formatNumber(vessel.route_distance)} nm</p>` : ''}
            ${vessel.route_speed ? `<p><strong>Speed:</strong> ${vessel.route_speed} kn</p>` : ''}
            ${vessel.route_guards !== undefined && vessel.route_guards >= 0 ? `<p><strong>Guards:</strong> ${vessel.route_guards}</p>` : ''}
            ${vessel.route_end_time ? `<p><strong>Arrival Time:</strong> ${new Date(vessel.route_end_time * 1000).toLocaleString()}</p>` : ''}
            ${vessel.route_dry_operation !== undefined ? `<p><strong>Dry Operation:</strong> ${vessel.route_dry_operation ? 'Yes' : 'No'}</p>` : ''}
          </div>
        </div>
      ` : ''}

      <div class="vessel-info-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Vessel Specifications
        </h4>
        <div class="section-content">
          <div class="vessel-specs">
            <div class="vessel-spec"><strong>Type:</strong> ${vessel.type_name || 'N/A'}</div>
            <div class="vessel-spec"><strong>Capacity:</strong> ${capacityDisplay}</div>
            <div class="vessel-spec"><strong>Range:</strong> ${formatNumber(vessel.range)} nm</div>
            <div class="vessel-spec ${getCO2Class(vessel.co2_factor)}"><strong>CO2 Factor:</strong> ${vessel.co2_factor || 'N/A'}</div>
            <div class="vessel-spec ${getFuelClass(vessel.fuel_factor)}"><strong>Fuel Factor:</strong> ${vessel.fuel_factor || 'N/A'}</div>
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

  // Setup export menu close handler (like logbook)
  setTimeout(() => {
    document.addEventListener('click', closeExportMenuOnClickOutside);
  }, 100);

  // Setup infinite scroll for history
  setupInfiniteScroll(panel);

  // Load trip history
  await loadVesselHistory(vessel.id);
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

    // Store full history
    allHistoryData = data.history;
    displayedHistoryCount = 0;

    // Render first 3 trips
    renderHistoryPage();

    // Format cargo display
    const formatCargo = (cargo) => {
      if (!cargo) return 'N/A';
      if (typeof cargo === 'string') return cargo;

      // Container cargo
      if (cargo.dry !== undefined || cargo.refrigerated !== undefined) {
        const dry = cargo.dry;
        const ref = cargo.refrigerated;
        const total = dry + ref;
        return `${total} TEU (${dry} dry, ${ref} ref)`;
      }

      // Tanker cargo
      if (cargo.fuel !== undefined || cargo.crude_oil !== undefined) {
        const fuel = cargo.fuel;
        const crude = cargo.crude_oil;
        return `${fuel > 0 ? fuel + ' bbl fuel' : ''}${fuel > 0 && crude > 0 ? ', ' : ''}${crude > 0 ? crude + ' bbl crude' : ''}`;
      }

      return JSON.stringify(cargo);
    };

    // Format duration (seconds to human readable)
    const formatDuration = (seconds) => {
      if (!seconds) return 'N/A';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

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

  // Format cargo display
  const formatCargo = (cargo) => {
    if (!cargo) return 'N/A';
    if (typeof cargo === 'string') return cargo;

    // Container cargo
    if (cargo.dry !== undefined || cargo.refrigerated !== undefined) {
      const dry = cargo.dry;
      const ref = cargo.refrigerated;
      const total = dry + ref;
      return `${total} TEU (${dry} dry, ${ref} ref)`;
    }

    // Tanker cargo
    if (cargo.fuel !== undefined || cargo.crude_oil !== undefined) {
      const fuel = cargo.fuel;
      const crude = cargo.crude_oil;
      return `${fuel > 0 ? fuel + ' bbl fuel' : ''}${fuel > 0 && crude > 0 ? ', ' : ''}${crude > 0 ? crude + ' bbl crude' : ''}`;
    }

    return JSON.stringify(cargo);
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

  // Format port name with capital first letter
  const formatPortName = (portCode) => {
    if (!portCode) return 'N/A';
    return portCode.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  };

  // Render trips
  const historyHtml = nextTrips.map(trip => `
    <div class="history-entry">
      <div class="history-route">
        <strong>${formatPortName(trip.origin)}</strong> → <strong>${formatPortName(trip.destination)}</strong>
      </div>
      <div class="history-details">
        <div class="history-row">
          <span>📅 ${trip.date ? new Date(trip.date).toLocaleString() : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span>📦 Cargo: ${formatCargo(trip.cargo)}</span>
        </div>
        <div class="history-row">
          <span>💰 Income: $${trip.profit ? trip.profit.toLocaleString() : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span>⛽ Fuel: ${trip.fuel_used ? Math.round(trip.fuel_used / 1000).toLocaleString() + ' t' : 'N/A'}</span>
          <span>📏 Distance: ${trip.distance ? trip.distance.toLocaleString() + ' km' : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span>⏱️ Duration: ${formatDuration(trip.duration)}</span>
          <span>🔧 Wear: ${trip.wear ? trip.wear.toFixed(2) + '%' : 'N/A'}</span>
        </div>
      </div>
    </div>
  `).join('');

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
  await deselectAll();
}

/**
 * Departs vessel using existing depart API
 *
 * @param {number} vesselId - Vessel ID to depart
 * @returns {Promise<void>}
 * @example
 * await departVessel(1234);
 */
export async function departVessel(vesselId) {
  try {
    // Import departVessels from api module
    const { departVessels } = await import('../api.js');

    console.log(`[Vessel Panel] Departing vessel ${vesselId}...`);

    const result = await departVessels([vesselId]);

    if (result.success) {
      console.log('[Vessel Panel] Vessel departed successfully');

      // Update vessel count in header
      if (window.updateVesselCount) {
        await window.updateVesselCount();
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
          console.log('[Vessel Panel] Vessel data updated, final status:', updatedVessel.status);

          // Re-select the vessel to update both panel AND marker/tooltip on map
          if (window.harborMap && window.harborMap.selectVesselFromMap) {
            await window.harborMap.selectVesselFromMap(vesselId);
            console.log('[Vessel Panel] Panel and map marker updated with new status');
          }
        } else {
          console.warn('[Vessel Panel] Could not find vessel after departure:', vesselId);
        }
      }
    } else {
      console.error('[Vessel Panel] Departure failed:', result);
      alert(`Failed to depart vessel: ${result.message || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('[Vessel Panel] Departure error:', error);
    alert(`Error departing vessel: ${error.message}`);
  }
}


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
    const { showSideNotification, formatNumber } = await import('../utils.js');

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

    const data = await response.json();

    showSideNotification(`✅ Sold ${vesselName} for $${formatNumber(sellPrice)}`, 'success');

    // Close panel and reload overview
    await closeVesselPanel();

    // Update vessel count badge
    if (window.updateVesselCount) {
      await window.updateVesselCount();
    }
  } catch (error) {
    console.error('[Vessel Panel] Sell error:', error);
    const errorMsg = error.message || error.toString() || 'Unknown error';
    alert(`Error selling vessel: ${errorMsg}`);
  }
}

// Expose functions to window for onclick handlers
window.harborMap = window.harborMap || {};
window.harborMap.closeVesselPanel = closeVesselPanel;
window.harborMap.departVessel = departVessel;
window.harborMap.sellVesselFromPanel = sellVesselFromPanel;
window.harborMap.toggleExportMenu = toggleExportMenu;
window.harborMap.exportHistoryFormat = exportHistoryFormat;
