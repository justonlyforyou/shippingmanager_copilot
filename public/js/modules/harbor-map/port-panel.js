/**
 * @fileoverview Port Detail Panel Component
 * Renders port information panel with demand analytics and vessel lists
 * ONLY renders data - NO data processing
 *
 * @module harbor-map/port-panel
 */

import { deselectAll, selectVessel } from './map-controller.js';

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

  // Format port name from code (e.g., 'sankt_peterburg' -> 'Sankt Peterburg')
  const formatPortName = (code) => {
    return code
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const displayName = formatPortName(port.code);

  // Render port info
  panel.innerHTML = `
    <div class="panel-header">
      <h3>${displayName}</h3>
      <button class="close-btn" onclick="window.harborMap.closePortPanel()">✕</button>
    </div>

    <div class="panel-body">
      <div class="port-info-section">
        <h4>Port Information</h4>
        <p><strong>Code:</strong> ${port.code.toUpperCase()}</p>
        <p><strong>Country:</strong> ${port.full_country || 'Unknown'}</p>
        <p><strong>Location:</strong><br><span style="padding-left: 12px;">Lat ${port.lat}</span><br><span style="padding-left: 12px;">Lon ${port.lon}</span></p>
        <p><strong>Size:</strong> ${port.size || 'N/A'}</p>
      </div>

      ${renderDemandSection(port)}

      <div class="port-info-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Vessels
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
}

/**
 * Renders demand analytics section for port
 * Shows container and tanker demand if available
 *
 * @param {Object} port - Port object with demand data
 * @returns {string} HTML string for demand section
 * @example
 * const html = renderDemandSection({ demand: { dry: 12000, refrigerated: 3000, ... } });
 */
function renderDemandSection(port) {
  if (!port.demand) {
    return '<div class="port-info-section"><h4>Demand Analytics</h4><p>No demand data available</p></div>';
  }

  const demand = port.demand;

  return `
    <div class="port-info-section">
      <h4>Demand Analytics</h4>
      ${demand.container ? `
        <p style="margin-bottom: 2px;"><strong>Container:</strong><br>
        Dry ${demand.container.dry !== undefined ? demand.container.dry.toLocaleString() : '0'} TEU<br>
        Ref ${demand.container.refrigerated !== undefined ? demand.container.refrigerated.toLocaleString() : '0'} TEU</p>
      ` : ''}
      ${demand.tanker ? `
        <p style="margin-bottom: 2px;"><strong>Tanker:</strong><br>
        Fuel: ${demand.tanker.fuel !== undefined ? demand.tanker.fuel.toLocaleString() : '0'} bbl<br>
        Crude: ${demand.tanker.crude_oil !== undefined ? demand.tanker.crude_oil.toLocaleString() : '0'} bbl</p>
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
            <div class="vessel-name">${vessel.name}</div>
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
  await deselectAll();
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
  hidePortPanel();
  await selectVessel(vesselId);
}

// Expose functions to window for onclick handlers
window.harborMap = window.harborMap || {};
window.harborMap.closePortPanel = closePortPanel;
window.harborMap.selectVesselFromPort = selectVesselFromPort;
