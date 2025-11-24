/**
 * @fileoverview Harbor Map API Client
 * Handles all communication with harbor-map backend endpoints
 * All responses are ready-to-render data (no processing in frontend)
 *
 * @module harbor-map/api-client
 */

// Client-side cache for instant loading
let cachedOverviewData = null;

/**
 * Invalidates the overview cache
 * Call this when switching to client-side filtering to ensure fresh data
 *
 * @returns {void}
 */
export function invalidateOverviewCache() {
  cachedOverviewData = null;
  console.log('[Harbor Map API] Cache invalidated');
}

/**
 * Pre-fetches harbor map data in background for instant loading
 * Call this on app initialization
 *
 * @param {string} filter - 'my_ports' or 'all_ports'
 * @returns {Promise<void>}
 */
export async function prefetchHarborMapData(filter = 'my_ports') {
  try {
    console.log('[Harbor Map API] Pre-fetching data...');
    const data = await fetchHarborMapOverview(filter);
    cachedOverviewData = data;
    console.log('[Harbor Map API] Pre-fetch complete:', {
      vessels: data.vessels.length,
      ports: data.ports.length,
      cached: true
    });
  } catch (error) {
    console.error('[Harbor Map API] Pre-fetch failed:', error);
  }
}

/**
 * Gets cached overview data if available
 *
 * @returns {Object|null} Cached data or null
 */
export function getCachedOverview() {
  return cachedOverviewData;
}

/**
 * Clears the cached overview data to force a fresh fetch
 */
export function clearOverviewCache() {
  cachedOverviewData = null;
}

/**
 * Fetches harbor map overview (vessels and ports)
 * Returns all vessels with positions and filtered ports
 *
 * @param {string} filter - 'my_ports' or 'all_ports'
 * @returns {Promise<Object>} { vessels: [], ports: [], filter: string }
 * @throws {Error} If API call fails
 * @example
 * const data = await fetchHarborMapOverview('my_ports');
 * // Returns: { vessels: [...], ports: [...], filter: 'my_ports' }
 */
export async function fetchHarborMapOverview(filter = 'my_ports') {
  const response = await fetch(window.apiUrl(`/api/harbor-map/overview?filter=${filter}`));

  if (!response.ok) {
    throw new Error(`Failed to fetch harbor map overview: ${response.statusText}`);
  }

  const data = await response.json();
  cachedOverviewData = data; // Update cache
  return data;
}

/**
 * Fetches reachable ports for a specific vessel
 * Returns vessel details, reachable ports with demand, and route path
 *
 * @param {number} vesselId - Vessel ID
 * @returns {Promise<Object>} { vessel: {...}, reachablePorts: [...], route: {...} }
 * @throws {Error} If API call fails
 * @example
 * const data = await fetchVesselReachablePorts(1234);
 * // Returns: { vessel: {...}, reachablePorts: [...], route: { path: [...], origin: 'AUBNE', destination: 'NZAKL' } }
 */
export async function fetchVesselReachablePorts(vesselId) {
  const response = await fetch(window.apiUrl(`/api/harbor-map/vessel/${vesselId}/reachable-ports`));

  if (!response.ok) {
    throw new Error(`Failed to fetch reachable ports for vessel ${vesselId}: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetches port details with categorized vessels
 * Returns port info and vessels (in port, heading to, coming from)
 *
 * @param {string} portCode - Port code (e.g., 'AUBNE')
 * @returns {Promise<Object>} { port: {...}, vessels: { inPort: [], toPort: [], fromPort: [] } }
 * @throws {Error} If API call fails
 * @example
 * const data = await fetchPortDetails('AUBNE');
 * // Returns: { port: {...}, vessels: { inPort: [...], toPort: [...], fromPort: [...] } }
 */
export async function fetchPortDetails(portCode) {
  const response = await fetch(window.apiUrl(`/api/harbor-map/port/${portCode}`));

  if (!response.ok) {
    throw new Error(`Failed to fetch port details for ${portCode}: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetches vessel trip history
 * Returns vessel details and trip history array
 *
 * @param {number} vesselId - Vessel ID
 * @returns {Promise<Object>} { vessel: {...}, history: [...] }
 * @throws {Error} If API call fails
 * @example
 * const data = await fetchVesselHistory(1234);
 * // Returns: { vessel: {...}, history: [...] }
 */
export async function fetchVesselHistory(vesselId) {
  const response = await fetch(window.apiUrl(`/api/harbor-map/vessel/${vesselId}/history`));

  if (!response.ok) {
    throw new Error(`Failed to fetch vessel history for ${vesselId}: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Clears backend cache for game/index data
 * Forces fresh data on next request
 *
 * @returns {Promise<Object>} { success: true, message: string }
 * @throws {Error} If API call fails
 * @example
 * await clearHarborMapCache();
 * // Returns: { success: true, message: 'Cache cleared' }
 */
export async function clearHarborMapCache() {
  const response = await fetch(window.apiUrl('/api/harbor-map/clear-cache'), {
    method: 'POST'
  });

  if (!response.ok) {
    throw new Error(`Failed to clear cache: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Exports vessel history in specified format (TXT, CSV, or JSON)
 * Returns file content as text for download
 *
 * @param {number} vesselId - Vessel ID
 * @param {string} format - Export format: 'txt', 'csv', or 'json'
 * @returns {Promise<string>} File content as text
 * @throws {Error} If API call fails
 * @example
 * const content = await exportVesselHistory(1234, 'txt');
 * // Returns file content as string
 */
export async function exportVesselHistory(vesselId, format) {
  const response = await fetch(window.apiUrl(`/api/harbor-map/vessel/${vesselId}/history/export`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format })
  });

  if (!response.ok) {
    throw new Error(`Failed to export vessel history: ${response.statusText}`);
  }

  return await response.text();
}
