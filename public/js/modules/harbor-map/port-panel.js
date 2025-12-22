/**
 * @fileoverview Port Detail Panel Component
 * Renders port information panel with demand analytics and vessel lists
 * ONLY renders data - NO data processing
 *
 * @module harbor-map/port-panel
 */

import { deselectAll, selectVessel, closeAllPanels, getMap } from './map-controller.js';
import { isMobileDevice, escapeHtml, formatNumber, toGameCode } from '../utils.js';
import logger from '../core/logger.js';

/**
 * Format port code to full name (Title Case)
 * e.g., "new_york" -> "New York", "taicang" -> "Taicang"
 */
function formatPortFullName(code) {
  if (!code) return 'Unknown';
  return code.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Shows port detail panel with port information and vessel lists
 * Displays demand analytics and categorized vessels (in/to/from port + pending)
 *
 * @param {Object} port - Port object from backend
 * @param {Object} vessels - Categorized vessels { inPort: [], toPort: [], fromPort: [], pending: [] }
 * @returns {void}
 * @example
 * showPortPanel(
 *   { code: 'AUBNE', name: 'Brisbane', demand: {...}, demandLevel: 'high' },
 *   { inPort: [...], toPort: [...], fromPort: [...], pending: [...] }
 * );
 */
export function showPortPanel(port, vessels) {
  const panel = document.getElementById('port-detail-panel');
  if (!panel) return;

  // Format port name - uses game display codes (e.g., "US NYC")
  const formatPortName = (code, country) => {
    return toGameCode(code, country);
  };

  const displayName = formatPortName(port.code, port.country);

  // Port image URL (local images)
  const imageUrl = `/images/ports/${port.code}.jpg`;

  // Render port info
  panel.innerHTML = `
    <div class="panel-header">
      <h3>${displayName}</h3>
      <button class="close-btn" onclick="window.harborMap.closePortPanel()">×</button>
    </div>

    <div class="panel-body">
      <div class="vessel-image-container">
        <img src="${imageUrl}" alt="${displayName}" class="vessel-image" onerror="this.style.display='none'">
        <div id="port-weather-overlay" style="position: absolute; top: 1px; left: 1px; background: rgba(0, 0, 0, 0.185); padding: 3px 5px; border-radius: 3px; font-size: 11px; color: #fff; backdrop-filter: blur(2px);">
          <div style="color: #94a3b8; font-size: 9px;">Loading...</div>
        </div>
      </div>

      <div class="port-info-section">
        <h4>Port Information</h4>
        <p><strong>Name:</strong> ${formatPortFullName(port.code)}</p>
        <p><strong>Code:</strong> ${toGameCode(port.code, port.country)}</p>
        <p><strong>Country:</strong> ${port.full_country || 'Unknown'}</p>
        <p><strong>Location:</strong><br><span class="port-location-indent">Lat ${port.lat}</span><br><span class="port-location-indent">Lon ${port.lon}</span></p>
        <p><strong>Size:</strong> ${port.size || 'N/A'}</p>
        <p><strong>Drydock:</strong> ${port.drydock ? 'Yes (' + port.drydock + ')' : 'No'}</p>
        <p><strong>Market Price:</strong> ${port.market_price ? port.market_price + '%' : 'N/A'}</p>
      </div>

      ${renderVesselsOverview(vessels)}

      ${renderTypicalDemandSection(port)}

      ${renderDemandSection(port)}

      <div class="port-info-section collapsible collapsed" id="top-alliances-section">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Top 3 Alliances
        </h4>
        <div class="section-content">
          <div class="loading-placeholder">Loading alliance statistics...</div>
        </div>
      </div>

      <div class="port-info-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Vessels (${(vessels.inPort?.length || 0) + (vessels.toPort?.length || 0) + (vessels.fromPort?.length || 0) + (vessels.pending?.length || 0)})
        </h4>
        <div class="section-content">
          ${vessels.pending && vessels.pending.length > 0 ? `
            <div class="vessel-category">
              <h5>Pending Delivery (${vessels.pending.length})</h5>
              ${renderVesselList(vessels.pending)}
            </div>
          ` : ''}

          <div class="vessel-category">
            <h5>In Port (${vessels.inPort.length})</h5>
            ${renderVesselList(vessels.inPort)}
          </div>

          <div class="vessel-category">
            <h5>Heading To Port (${vessels.toPort.length})</h5>
            ${renderVesselList(vessels.toPort)}
          </div>

          <div class="vessel-category">
            <h5>Coming From Port (${vessels.fromPort.length})</h5>
            ${renderVesselList(vessels.fromPort)}
          </div>
        </div>
      </div>
    </div>
  `;

  // Show panel
  panel.classList.add('active');

  // Load weather data for port location
  loadPortWeather(parseFloat(port.lat), parseFloat(port.lon));

  // Load alliance statistics for port
  loadPortAllianceData(port.code);

  // Enable fullscreen on mobile when panel opens
  const isMobile = isMobileDevice();
  logger.debug('[Port Panel] isMobile:', isMobile, 'window.innerWidth:', window.innerWidth);
  if (isMobile) {
    document.body.classList.add('map-fullscreen');
    logger.debug('[Port Panel] Added map-fullscreen class to body. Classes:', document.body.classList.toString());
  }
}

/**
 * Renders vessels overview section showing active vessels and capacity
 *
 * @param {Object} vessels - Categorized vessels { inPort: [], toPort: [], fromPort: [], pending: [] }
 * @returns {string} HTML string for vessels overview section
 */
function renderVesselsOverview(vessels) {
  // Combine all vessel categories
  const allVessels = [
    ...(vessels.inPort || []),
    ...(vessels.toPort || []),
    ...(vessels.fromPort || []),
    ...(vessels.pending || [])
  ];

  const activeCount = allVessels.length;

  // Calculate max TEU and max BBL
  let totalTEU = 0;
  let totalBBL = 0;

  for (const vessel of allVessels) {
    if (vessel.capacity_type === 'container' && vessel.capacity_max) {
      const dry = vessel.capacity_max.dry || 0;
      const ref = vessel.capacity_max.refrigerated || 0;
      totalTEU += dry + ref;
    } else if (vessel.capacity_type === 'tanker' && vessel.capacity_max) {
      const fuel = vessel.capacity_max.fuel || 0;
      const crude = vessel.capacity_max.crude_oil || 0;
      totalBBL += fuel + crude;
    }
  }

  // Always show BBL if available (tanker building works without tanker ops due to game bug)
  const bblLine = totalBBL > 0
    ? `<p><strong>Vessels Max BBL:</strong> ${formatNumber(totalBBL)}</p>`
    : '';

  return `
    <div class="port-info-section">
      <h4>Vessels Overview</h4>
      <p><strong>Active Vessels:</strong> ${formatNumber(activeCount)}</p>
      ${totalTEU > 0 ? `<p><strong>Vessels Max TEU:</strong> ${formatNumber(totalTEU)}</p>` : ''}
      ${bblLine}
    </div>
  `;
}

/**
 * Renders typical demand section showing Container vs Tanker percentages
 * Uses demand_policy data from port
 *
 * @param {Object} port - Port object with demand_policy data
 * @returns {string} HTML string for typical demand section
 */
function renderTypicalDemandSection(port) {
  if (!port.demand_policy) {
    return '';
  }

  const containerPct = port.demand_policy.container || 0;
  const tankerPct = port.demand_policy.tanker || 0;

  return `
    <div class="port-info-section">
      <h4>Typical Demand</h4>
      <div class="typical-demand-bar">
        <div class="typical-demand-container" style="width: ${containerPct}%">
          <span class="typical-demand-label">Container</span>
        </div>
        <div class="typical-demand-tanker" style="width: ${tankerPct}%">
          <span class="typical-demand-label">Tanker</span>
        </div>
      </div>
      <div class="typical-demand-values">
        <span class="typical-demand-value demand-container">${containerPct}%</span>
        <span class="typical-demand-value demand-tanker">${tankerPct}%</span>
      </div>
    </div>
  `;
}

/**
 * Renders demand analytics section for port
 * Shows REMAINING demand (demand - consumed) for container and tanker
 *
 * @param {Object} port - Port object with demand and consumed data
 * @returns {string} HTML string for demand section
 * @example
 * const html = renderDemandSection({ demand: { container: { dry: 12000 } }, consumed: { container: { dry: 5000 } } });
 */
function renderDemandSection(port) {
  if (!port.demand) {
    return '<div class="port-info-section"><h4>Demand Analytics</h4><p>No demand data available</p></div>';
  }

  const demand = port.demand;
  const consumed = port.consumed || {};

  // Calculate remaining demand (demand - consumed)
  const dryDemand = demand.container?.dry || 0;
  const dryConsumed = consumed.container?.dry || 0;
  const dryRemaining = Math.max(0, dryDemand - dryConsumed);

  const refDemand = demand.container?.refrigerated || 0;
  const refConsumed = consumed.container?.refrigerated || 0;
  const refRemaining = Math.max(0, refDemand - refConsumed);

  const fuelDemand = demand.tanker?.fuel || 0;
  const fuelConsumed = consumed.tanker?.fuel || 0;
  const fuelRemaining = Math.max(0, fuelDemand - fuelConsumed);

  const crudeDemand = demand.tanker?.crude_oil || 0;
  const crudeConsumed = consumed.tanker?.crude_oil || 0;
  const crudeRemaining = Math.max(0, crudeDemand - crudeConsumed);

  // Check if any demand is fully consumed (remaining = 0)
  const containerFullyConsumed = dryRemaining === 0 && refRemaining === 0 && (dryDemand > 0 || refDemand > 0);
  const tankerFullyConsumed = fuelRemaining === 0 && crudeRemaining === 0 && (fuelDemand > 0 || crudeDemand > 0);

  return `
    <div class="port-info-section">
      <h4>Remaining Demand</h4>
      ${demand.container ? `
        <p style="margin-bottom: 2px;"${containerFullyConsumed ? ' class="no-demand-warning"' : ''}><strong>Container:</strong><br>
        Dry: ${dryRemaining.toLocaleString()} / ${dryDemand.toLocaleString()} TEU${dryRemaining === 0 && dryDemand > 0 ? ' (FULL)' : ''}<br>
        Ref: ${refRemaining.toLocaleString()} / ${refDemand.toLocaleString()} TEU${refRemaining === 0 && refDemand > 0 ? ' (FULL)' : ''}</p>
      ` : ''}
      ${demand.tanker ? `
        <p style="margin-bottom: 2px;"${tankerFullyConsumed ? ' class="no-demand-warning"' : ''}><strong>Tanker:</strong><br>
        Fuel: ${fuelRemaining.toLocaleString()} / ${fuelDemand.toLocaleString()} bbl${fuelRemaining === 0 && fuelDemand > 0 ? ' (FULL)' : ''}<br>
        Crude: ${crudeRemaining.toLocaleString()} / ${crudeDemand.toLocaleString()} bbl${crudeRemaining === 0 && crudeDemand > 0 ? ' (FULL)' : ''}</p>
      ` : ''}
    </div>
  `;
}

/**
 * Renders vessel list for a category (in/to/from port)
 * Each vessel is clickable to select it
 *
 * @param {Array<Object>} vessels - Array of vessel objects
 * @returns {string} HTML string for vessel list
 * @example
 * const html = renderVesselList([{ id: 1234, name: 'SS Example', eta: '2h 45m', ... }]);
 */
function renderVesselList(vessels) {
  if (vessels.length === 0) {
    return '<p class="no-data">No vessels</p>';
  }

  return `
    <ul class="vessel-list">
      ${vessels.map(vessel => {
        // Format detailed cargo info
        let cargoDetails = '';
        if (vessel.cargo_current) {
          if (vessel.capacity_type === 'container') {
            const dry = vessel.cargo_current.dry || 0;
            const ref = vessel.cargo_current.refrigerated || 0;
            const dryMax = vessel.capacity_max?.dry || 0;
            const refMax = vessel.capacity_max?.refrigerated || 0;
            cargoDetails = `Dry: ${dry}/${dryMax} | Ref: ${ref}/${refMax} TEU`;
          } else if (vessel.capacity_type === 'tanker') {
            const fuel = vessel.cargo_current.fuel || 0;
            const crude = vessel.cargo_current.crude_oil || 0;
            const fuelMax = vessel.capacity_max?.fuel || 0;
            const crudeMax = vessel.capacity_max?.crude_oil || 0;
            if (fuel > 0) {
              cargoDetails = `Fuel: ${fuel.toLocaleString()}/${fuelMax.toLocaleString()} bbl`;
            } else if (crude > 0) {
              cargoDetails = `Crude: ${crude.toLocaleString()}/${crudeMax.toLocaleString()} bbl`;
            }
          }
        }

        return `
          <li class="vessel-list-item" onclick="window.harborMap.selectVesselFromPort(${vessel.id})">
            <div class="vessel-name">${escapeHtml(vessel.name)}</div>
            <div class="vessel-details">
              ${vessel.eta !== 'N/A' ? `<span>⏱️ ${vessel.eta}</span>` : ''}
              ${cargoDetails ? `<span>📦 ${cargoDetails}</span>` : (vessel.formattedCargo ? `<span>📦 ${vessel.formattedCargo}</span>` : '')}
              ${vessel.cargoUtilization ? `<span>📊 ${vessel.cargoUtilization}%</span>` : ''}
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

/**
 * Hides port detail panel
 *
 * @returns {void}
 * @example
 * hidePortPanel();
 */
export function hidePortPanel() {
  const panel = document.getElementById('port-detail-panel');
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

  // DON'T remove fullscreen here - only in closePortPanel()
  // This allows seamless transitions between panels on mobile
}

/**
 * Closes port panel and returns to overview
 *
 * @returns {Promise<void>}
 * @example
 * await closePortPanel();
 */
export async function closePortPanel() {
  hidePortPanel();

  // Remove fullscreen on mobile when explicitly closing panel
  if (isMobileDevice()) {
    document.body.classList.remove('map-fullscreen');

    // Force map invalidate size after fullscreen change
    const map = getMap();
    if (map) {
      setTimeout(() => {
        map.invalidateSize();
      }, 100);
    }
  }

  // If planning mode is active, clear route and refresh map but keep planner open
  if (window.harborMap && window.harborMap.isPlanningMode && window.harborMap.isPlanningMode()) {
    // Clear the route line from the map
    if (window.harborMap.clearRoute) {
      window.harborMap.clearRoute();
    }
    // Refresh map with current filters
    if (window.harborMap.loadOverview) {
      await window.harborMap.loadOverview();
    }
  } else {
    await deselectAll();
  }
}

/**
 * Selects a vessel from port panel vessel list
 * Closes port panel and shows vessel panel
 *
 * @param {number} vesselId - Vessel ID to select
 * @returns {Promise<void>}
 * @example
 * await selectVesselFromPort(1234);
 */
export async function selectVesselFromPort(vesselId) {
  // Close all panels first, then show vessel panel
  await closeAllPanels();
  await selectVessel(vesselId);
}

/**
 * Loads and displays weather data for port location
 * Fetches weather from Open-Meteo API and renders in overlay on port image
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<void>}
 */
async function loadPortWeather(lat, lon) {
  const weatherOverlay = document.getElementById('port-weather-overlay');
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

    // Render compact weather display (like vessel panel)
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
    console.error('[Port Panel] Failed to fetch weather:', error);
    weatherOverlay.innerHTML = '<div style="color: #ef4444; font-size: 10px;">Weather unavailable</div>';
  }
}

/**
 * Fetches and updates demand data for a port
 * Called after showPortPanel to load demand asynchronously
 *
 * @param {string} portCode - Port code
 * @returns {Promise<void>}
 */
export async function fetchAndUpdatePortDemand(portCode) {
  try {
    const response = await fetch('/api/route/get-port-demand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port_code: portCode })
    });

    if (!response.ok) {
      console.warn(`[Port Panel] Failed to fetch demand for ${portCode}`);
      return;
    }

    const data = await response.json();
    const port = data.port;

    if (!port || !port.demand) {
      console.log(`[Port Panel] No demand data available for ${portCode}`);
      return;
    }

    // Get demand and consumed data
    const demand = port.demand;
    const consumed = port.consumed || {};

    // Calculate remaining demand (demand - consumed)
    const dryDemand = demand.container?.dry || 0;
    const dryConsumed = consumed.container?.dry || 0;
    const dryRemaining = Math.max(0, dryDemand - dryConsumed);

    const refDemand = demand.container?.refrigerated || 0;
    const refConsumed = consumed.container?.refrigerated || 0;
    const refRemaining = Math.max(0, refDemand - refConsumed);

    const fuelDemand = demand.tanker?.fuel || 0;
    const fuelConsumed = consumed.tanker?.fuel || 0;
    const fuelRemaining = Math.max(0, fuelDemand - fuelConsumed);

    const crudeDemand = demand.tanker?.crude_oil || 0;
    const crudeConsumed = consumed.tanker?.crude_oil || 0;
    const crudeRemaining = Math.max(0, crudeDemand - crudeConsumed);

    // Check if any demand is fully consumed
    const containerFullyConsumed = dryRemaining === 0 && refRemaining === 0 && (dryDemand > 0 || refDemand > 0);
    const tankerFullyConsumed = fuelRemaining === 0 && crudeRemaining === 0 && (fuelDemand > 0 || crudeDemand > 0);

    // Find existing demand section and update it
    const allSections = document.querySelectorAll('#port-detail-panel .port-info-section');
    let demandSectionFound = false;

    for (const section of allSections) {
      const header = section.querySelector('h4');
      if (header && (header.textContent === 'Remaining Demand' || header.textContent === 'Demand Analytics')) {
        // Update existing section content
        section.innerHTML = `
          <h4>Remaining Demand</h4>
          ${demand.container ? `
            <p${containerFullyConsumed ? ' class="no-demand-warning"' : ''}><strong>Container:</strong><br>
            Dry: ${dryRemaining.toLocaleString()} / ${dryDemand.toLocaleString()} TEU${dryRemaining === 0 && dryDemand > 0 ? ' (FULL)' : ''}<br>
            Ref: ${refRemaining.toLocaleString()} / ${refDemand.toLocaleString()} TEU${refRemaining === 0 && refDemand > 0 ? ' (FULL)' : ''}</p>
          ` : ''}
          ${demand.tanker ? `
            <p${tankerFullyConsumed ? ' class="no-demand-warning"' : ''}><strong>Tanker:</strong><br>
            Fuel: ${fuelRemaining.toLocaleString()} / ${fuelDemand.toLocaleString()} bbl${fuelRemaining === 0 && fuelDemand > 0 ? ' (FULL)' : ''}<br>
            Crude: ${crudeRemaining.toLocaleString()} / ${crudeDemand.toLocaleString()} bbl${crudeRemaining === 0 && crudeDemand > 0 ? ' (FULL)' : ''}</p>
          ` : ''}
        `;
        demandSectionFound = true;
        break;
      }
    }

    // If no demand section exists, create one after first port-info-section
    if (!demandSectionFound && allSections.length > 0) {
      const newSection = document.createElement('div');
      newSection.className = 'port-info-section';
      newSection.innerHTML = `
        <h4>Remaining Demand</h4>
        ${demand.container ? `
          <p${containerFullyConsumed ? ' class="no-demand-warning"' : ''}><strong>Container:</strong><br>
          Dry: ${dryRemaining.toLocaleString()} / ${dryDemand.toLocaleString()} TEU${dryRemaining === 0 && dryDemand > 0 ? ' (FULL)' : ''}<br>
          Ref: ${refRemaining.toLocaleString()} / ${refDemand.toLocaleString()} TEU${refRemaining === 0 && refDemand > 0 ? ' (FULL)' : ''}</p>
        ` : ''}
        ${demand.tanker ? `
          <p${tankerFullyConsumed ? ' class="no-demand-warning"' : ''}><strong>Tanker:</strong><br>
          Fuel: ${fuelRemaining.toLocaleString()} / ${fuelDemand.toLocaleString()} bbl${fuelRemaining === 0 && fuelDemand > 0 ? ' (FULL)' : ''}<br>
          Crude: ${crudeRemaining.toLocaleString()} / ${crudeDemand.toLocaleString()} bbl${crudeRemaining === 0 && crudeDemand > 0 ? ' (FULL)' : ''}</p>
        ` : ''}
      `;
      allSections[0].after(newSection);
    }

    console.log(`[Port Panel] Updated demand for ${portCode}:`, demand);
  } catch (error) {
    console.error(`[Port Panel] Error fetching demand for ${portCode}:`, error);
  }
}

/**
 * Loads alliance statistics for a port
 * Fetches top 3 alliances and user's alliance rank
 *
 * @param {string} portCode - Port code
 * @example
 * loadPortAllianceData('murmansk');
 */
async function loadPortAllianceData(portCode, attempt = 1) {
  try {
    const response = await fetch('/api/alliance/get-alliance-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port_code: portCode })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    logger.debug('[Port Panel] Alliance data response:', result);
    const { top_alliances, my_alliance } = result.data || {};
    logger.debug('[Port Panel] top_alliances:', top_alliances, 'my_alliance:', my_alliance);

    const section = document.getElementById('top-alliances-section');
    if (!section) return;

    const content = section.querySelector('.section-content');
    if (!content) return;

    let html = '';

    if (top_alliances && top_alliances.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];

      html += '<table class="port-alliance-table">';

      top_alliances.forEach((alliance, index) => {
        html += `
          <tr class="alliance-row rank-${index + 1}">
            <td class="alliance-medal">${medals[index]}</td>
            <td class="alliance-name-cell">
              <a href="#" class="alliance-link" onclick="window.harborMap.openAllianceModal(${alliance.id}); return false;">
                ${alliance.name}
              </a>
            </td>
            <td class="alliance-stats-cell">
              <div>${formatNumber(alliance.teu)} TEU</div>
              <div>${formatNumber(alliance.bbl)} bbl</div>
            </td>
          </tr>
        `;
      });

      html += '</table>';
    } else {
      html = '<p>No alliance data available for this port.</p>';
    }

    content.innerHTML = html;
  } catch (error) {
    // Retry on network errors
    if (attempt < 3 && error.message?.includes('Failed to fetch')) {
      await new Promise(r => setTimeout(r, 1000));
      return loadPortAllianceData(portCode, attempt + 1);
    }
    console.error(`[Port Panel] Error fetching alliance data for ${portCode}:`, error);
    const section = document.getElementById('top-alliances-section');
    if (section) {
      const content = section.querySelector('.section-content');
      if (content) {
        content.innerHTML = '<p class="error-message">Failed to load alliance statistics.</p>';
      }
    }
  }
}

/**
 * Opens alliance details modal
 * @param {number} allianceId - Alliance ID
 */
async function openAllianceModal(allianceId) {
  const { showAllianceDetailsModal } = await import('../alliance-tabs.js');
  await showAllianceDetailsModal(allianceId);
}

// Expose functions to window for onclick handlers
window.harborMap = window.harborMap || {};
window.harborMap.closePortPanel = closePortPanel;
window.harborMap.selectVesselFromPort = selectVesselFromPort;
window.harborMap.fetchAndUpdatePortDemand = fetchAndUpdatePortDemand;
window.harborMap.openAllianceModal = openAllianceModal;
