/**
 * @fileoverview Route Vessels Panel Component
 * Shows a list of all vessels on a selected route
 * Clicking a vessel opens the vessel detail panel
 *
 * @module harbor-map/route-vessels-panel
 */

import { showVesselPanel } from './vessel-panel.js';
import { closeAllPanels } from './map-controller.js';

/**
 * Shows the route vessels panel with a list of vessels
 * Displays vessel name, status, ETA, and cargo summary
 *
 * @param {string} routeName - Name of the route
 * @param {Array<Object>} vessels - Vessels on this route
 * @returns {void}
 * @example
 * showRoutePanel('Hamburg - New York', vessels);
 */
export function showRoutePanel(routeName, vessels) {
  const panel = document.getElementById('route-vessels-panel');
  if (!panel) {
    console.error('[Route Panel] Panel element not found');
    return;
  }

  console.log(`[Route Panel] Showing panel for route: ${routeName} with ${vessels.length} vessels`);

  // Store vessels for selection
  storeVessels(vessels);

  // Format vessel list
  const vesselListHtml = vessels.length > 0
    ? vessels.map(vessel => `
        <div class="route-vessel-item" data-vessel-id="${vessel.id}" onclick="window.harborMap.selectRouteVessel(${vessel.id})">
          <div class="route-vessel-header">
            <span class="route-vessel-name">${vessel.name}</span>
            <span class="route-vessel-status status-${vessel.status}">${vessel.status}</span>
          </div>
          <div class="route-vessel-details">
            ${vessel.eta !== 'N/A' ? `<div class="route-vessel-eta">⏱️ ETA: ${vessel.eta}</div>` : ''}
            ${vessel.formattedCargo ? `<div class="route-vessel-cargo">📦 ${vessel.formattedCargo}</div>` : ''}
          </div>
        </div>
      `).join('')
    : '<p class="no-data">No vessels found on this route</p>';

  // Render panel content
  panel.innerHTML = `
    <div class="panel-header">
      <h3>🚢 ${routeName}</h3>
      <button class="close-btn" onclick="window.harborMap.closeRoutePanel()">×</button>
    </div>
    <div class="panel-body">
      <div class="route-vessels-count">
        ${vessels.length} vessel${vessels.length !== 1 ? 's' : ''} on route
      </div>
      <div class="route-vessels-list">
        ${vesselListHtml}
      </div>
    </div>
  `;

  // Show panel
  panel.classList.add('active');
}

/**
 * Hides the route vessels panel
 *
 * @returns {void}
 * @example
 * hideRoutePanel();
 */
export function hideRoutePanel() {
  const panel = document.getElementById('route-vessels-panel');
  if (!panel) return;

  panel.classList.remove('active');
  console.log('[Route Panel] Panel hidden');
}

// Store vessels for selection
let currentRouteVessels = [];

/**
 * Stores vessels for later selection
 * Called internally by showRoutePanel
 *
 * @param {Array<Object>} vessels - Vessels to store
 * @returns {void}
 */
function storeVessels(vessels) {
  currentRouteVessels = vessels;
}

/**
 * Selects a vessel from the route panel and opens its detail panel
 *
 * @param {number} vesselId - Vessel ID to select
 * @returns {Promise<void>}
 * @example
 * await selectRouteVessel(1234);
 */
export async function selectRouteVessel(vesselId) {
  console.log(`[Route Panel] Selecting vessel ${vesselId} from route panel`);

  // Find vessel in stored vessels
  const vessel = currentRouteVessels.find(v => v.id === vesselId);

  if (!vessel) {
    console.error(`[Route Panel] Vessel ${vesselId} not found in route vessels`);
    return;
  }

  // Close all panels first, then show vessel panel
  await closeAllPanels();

  // Show vessel detail panel
  await showVesselPanel(vessel);
}

/**
 * Closes the route panel and clears the route filter
 *
 * @returns {void}
 * @example
 * closeRoutePanel();
 */
export async function closeRoutePanel() {
  hideRoutePanel();

  // Clear route filter by setting dropdown to "All Routes"
  const routeSelect = document.getElementById('routeFilterSelect');
  if (routeSelect) {
    routeSelect.value = '';
    // Trigger change event to clear filter
    routeSelect.dispatchEvent(new Event('change'));
  }
}

// Expose functions to window for onclick handlers
window.harborMap = window.harborMap || {};
window.harborMap.selectRouteVessel = selectRouteVessel;
window.harborMap.closeRoutePanel = closeRoutePanel;
