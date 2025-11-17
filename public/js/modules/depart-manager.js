/**
 * @fileoverview Depart Manager Panel
 * Draggable panel for managing vessel departures
 *
 * @module depart-manager
 */

let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

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

  // Refresh button handler
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await loadDepartableVessels();
    });
  }

  // Initialize drag functionality
  if (header) {
    header.addEventListener('mousedown', startDrag);
  }

  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', stopDrag);

  console.log('[Depart Manager] Initialized');
}

/**
 * Open the depart manager panel
 */
export async function openDepartManager() {
  const panel = document.getElementById('departManagerPanel');
  if (panel) {
    panel.classList.remove('hidden');
    // Reset position to center
    panel.style.top = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%, -50%)';

    // Load vessels with status 'port'
    await loadDepartableVessels();
  }
}

/**
 * Load vessels that can be departed (status = 'port')
 */
async function loadDepartableVessels() {
  const contentArea = document.querySelector('.depart-manager-content');
  if (!contentArea) return;

  contentArea.innerHTML = '<div style="text-align: center; padding: 20px;">Loading vessels...</div>';

  try {
    const response = await fetch('/api/vessel/get-vessels');
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch vessels');
    }

    // Filter vessels with status 'port'
    const departableVessels = data.vessels.filter(v => v.status === 'port');

    if (departableVessels.length === 0) {
      contentArea.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--color-text-tertiary);">No vessels in port ready to depart</div>';
      updateDepartButtonCount();
      return;
    }

    // Build vessel list
    let html = '<div class="depart-vessel-list">';
    departableVessels.forEach(vessel => {
      const routeName = vessel.route_name || 'No route';
      const currentPort = vessel.current_port_code?.replace(/_/g, ' ') || 'Unknown port';
      // Destination is the OTHER port on the route (not current port)
      const routeOrigin = vessel.route_origin?.replace(/_/g, ' ') || '';
      const routeDestination = vessel.route_destination?.replace(/_/g, ' ') || '';
      // If current port matches destination, then next destination is origin (and vice versa)
      const nextDestination = currentPort === routeDestination ? routeOrigin : routeDestination;

      // Calculate duration from route distance and speed (in hours)
      let durationText = 'N/A';
      if (vessel.active_route?.duration) {
        const hours = Math.floor(vessel.active_route.duration / 3600);
        const minutes = Math.floor((vessel.active_route.duration % 3600) / 60);
        durationText = `${hours}h ${minutes}m`;
      } else if (vessel.route_distance && vessel.route_speed) {
        const hours = Math.floor(vessel.route_distance / vessel.route_speed);
        const minutes = Math.floor(((vessel.route_distance / vessel.route_speed) % 1) * 60);
        durationText = `${hours}h ${minutes}m`;
      }

      html += `
        <div class="depart-vessel-item" data-vessel-id="${vessel.id}">
          <span class="depart-route-link depart-route-corner" data-route-name="${routeName}" title="Click to filter map by this route">(${routeName})</span>
          <div class="depart-vessel-info">
            <div class="depart-vessel-name">
              ${vessel.name}
              <button class="vessel-locate-btn" data-vessel-id="${vessel.id}" title="Show on map">
                <span>📍</span>
              </button>
            </div>
            <div class="depart-vessel-details">
              <div>At port: <span class="depart-port-name">${currentPort}</span></div>
              <div>Destination: <span class="depart-port-name">${nextDestination || 'No route'}</span></div>
              <div>Duration: <span class="depart-duration">${durationText}</span></div>
            </div>
          </div>
          <div class="depart-vessel-actions">
            <input type="checkbox" class="depart-vessel-checkbox" data-vessel-id="${vessel.id}" checked>
          </div>
        </div>
      `;
    });
    html += '</div>';

    contentArea.innerHTML = html;

    // Add click handlers for route links
    const routeLinks = contentArea.querySelectorAll('.depart-route-link');
    routeLinks.forEach(link => {
      link.addEventListener('click', () => {
        const routeName = link.dataset.routeName;
        if (routeName && routeName !== 'No route') {
          selectRouteInMapFilter(routeName);
        }
      });
    });

    // Add click handlers for locate buttons (using global vessel-locate-btn class)
    const locateButtons = contentArea.querySelectorAll('.vessel-locate-btn');
    locateButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const vesselId = parseInt(btn.dataset.vesselId);
        locateVesselOnMap(vesselId);
      });
      // Add hover animation (same as other vessel-locate-btn)
      btn.addEventListener('mouseover', () => {
        btn.querySelector('span').style.animation = 'pulse-arrow 0.6s ease-in-out infinite';
      });
      btn.addEventListener('mouseout', () => {
        btn.querySelector('span').style.animation = 'none';
      });
    });

    // Add change handlers for checkboxes to update button count
    const checkboxes = contentArea.querySelectorAll('.depart-vessel-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', updateDepartButtonCount);
    });

    // Update button count
    updateDepartButtonCount();

  } catch (error) {
    console.error('[Depart Manager] Error loading vessels:', error);
    contentArea.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--color-danger);">Error: ${error.message}</div>`;
  }
}

/**
 * Update the depart button count based on selected checkboxes
 */
function updateDepartButtonCount() {
  const checkboxes = document.querySelectorAll('.depart-vessel-checkbox:checked');
  const count = checkboxes.length;
  const departAllBtn = document.getElementById('departAllFromPanel');

  if (departAllBtn) {
    departAllBtn.textContent = `🚢 Depart Selected (${count})`;
    departAllBtn.disabled = count === 0;
  }
}

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
 * Select a route in the map filter (same as clicking in filter panel)
 * @param {string} routeName - Route name to select
 */
function selectRouteInMapFilter(routeName) {
  // Close depart manager first
  closeDepartManager();

  // Trigger route selection in map filter
  if (window.harborMap && window.harborMap.selectRoute) {
    window.harborMap.selectRoute(routeName);
  } else {
    // Fallback: try to find and click the route in filter
    const routeItem = document.querySelector(`.route-filter-item[data-route-name="${routeName}"]`);
    if (routeItem) {
      routeItem.click();
    } else {
      console.warn(`[Depart Manager] Route ${routeName} not found in filter`);
    }
  }
}

/**
 * Locate vessel on map (same as vessel-locate-btn in sell vessels overlay)
 * @param {number} vesselId - Vessel ID to locate
 */
function locateVesselOnMap(vesselId) {
  // Close depart manager first
  closeDepartManager();

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

    console.log(`[Depart Manager] Departed ${result.departedCount} vessels`);

    // Remove departed vessels from list
    vesselIds.forEach(id => {
      const item = document.querySelector(`.depart-vessel-item[data-vessel-id="${id}"]`);
      if (item) {
        item.remove();
      }
    });

    // Update button count
    updateDepartButtonCount();

    // Check if list is empty
    const remainingItems = document.querySelectorAll('.depart-vessel-item');
    if (remainingItems.length === 0) {
      const contentArea = document.querySelector('.depart-manager-content');
      if (contentArea) {
        contentArea.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--color-text-tertiary);">All vessels departed</div>';
      }
    }

  } catch (error) {
    console.error('[Depart Manager] Error departing vessels:', error);
    if (departAllBtn) {
      departAllBtn.disabled = false;
    }
    updateDepartButtonCount();
  }
}

/**
 * Close the depart manager panel
 */
export function closeDepartManager() {
  const panel = document.getElementById('departManagerPanel');
  if (panel) {
    panel.classList.add('hidden');
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
