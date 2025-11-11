/**
 * @fileoverview Harbor Map Controller
 * Handles Leaflet.js map initialization, rendering, and user interactions
 * ONLY renders data - NO data processing (all logic in backend)
 *
 * @module harbor-map/map-controller
 */

import { fetchHarborMapOverview, fetchVesselReachablePorts, fetchPortDetails, getCachedOverview } from './api-client.js';
import { showVesselPanel, hideVesselPanel } from './vessel-panel.js';
import { showPortPanel, hidePortPanel } from './port-panel.js';
import { initializePanelDrag } from './panel-drag.js';
import { filterVessels, filterPorts, getVesselFilterOptions, getPortFilterOptions } from './filters.js';
import { showSideNotification } from '../utils.js';

// Map instance
let map = null;

// Layer groups
let vesselLayer = null;
let portLayer = null;
let routeLayer = null;
let weatherLayer = null;

// Marker cluster groups
let vesselClusterGroup = null;
let portClusterGroup = null;

// Current state
let currentPortFilter = localStorage.getItem('harborMapPortFilter') || 'my_ports'; // Port filter
let currentVesselFilter = localStorage.getItem('harborMapVesselFilter') || 'all_vessels'; // Vessel filter
let selectedVesselId = null;
let selectedPortCode = null;
let currentMapStyle = localStorage.getItem('harborMapStyle') || 'dark'; // 'standard', 'dark', or 'satellite'
let weatherEnabled = localStorage.getItem('harborMapWeather') === 'true' || false;
let weatherType = localStorage.getItem('harborMapWeatherType') || 'off'; // 'off', 'rain', 'cloud'

// Raw data (unfiltered - loaded once from API)
let rawVessels = [];
let rawPorts = [];

// Weather control reference
let weatherControl = null;

// Environmental Layer - Rotating button (off -> wind -> clouds -> temperature -> off)
let currentEnvLayer = localStorage.getItem('harborMapEnvLayer') || 'off'; // 'off', 'wind', 'clouds', 'temperature'
let envLayer = null;
let envLayerControl = null;

// Cloud animation
let cloudAnimationFrames = [];
let cloudAnimationInterval = null;
let currentCloudFrame = 0;

// POI Layer - Rotating button (off -> museums -> wrecks -> off)
let currentPOILayer = localStorage.getItem('harborMapPOILayer') || 'off'; // 'off', 'museums', 'wrecks'
let poiMarkerLayer = null;
let poiLayerControl = null;

// Current data (for route filtering)
let currentVessels = [];
let currentPorts = [];
let currentRouteFilter = localStorage.getItem('harborMapRouteFilter') || null; // null = show all, string = show specific route

// Tile layers
let currentTileLayer = null;
const tileLayers = {
  standard: {
    name: 'Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors'
  },
  dark: {
    name: 'Dark Mode',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO'
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri'
  }
};

/**
 * Gets vessel type from capacity_type field
 *
 * @param {string} capacityType - Capacity type ('container' or 'tanker')
 * @returns {string} - 'container', 'tanker', or 'unknown'
 */
function getVesselType(capacityType) {
  if (!capacityType) return 'unknown';
  const lower = capacityType.toLowerCase();
  if (lower === 'container') return 'container';
  if (lower === 'tanker') return 'tanker';
  return 'unknown';
}

/**
 * Creates vessel icon with type and status classes
 *
 * @param {string} status - Vessel status ('enroute', 'port', 'anchor')
 * @param {string} vesselType - Vessel type ('container', 'tanker', 'unknown')
 * @param {number} heading - Vessel heading in degrees (0-360), optional
 * @returns {L.DivIcon} Leaflet icon
 */
function createVesselIcon(status, vesselType, heading = 0) {
  const statusClass = status === 'enroute' ? 'sailing' : status;
  const typeClass = vesselType !== 'unknown' ? vesselType : '';
  const className = `vessel-marker ${statusClass} ${typeClass}`.trim();

  // Apply rotation to triangle
  const rotation = heading ? `transform: rotate(${heading}deg);` : '';

  return L.divIcon({
    className,
    html: `<div class="vessel-icon" style="${rotation}"></div>`,
    iconSize: [12, 16],
    iconAnchor: [6, 8]
  });
}

/**
 * Calculates heading from two coordinates
 *
 * @param {Object} from - {lat, lon}
 * @param {Object} to - {lat, lon}
 * @returns {number} Heading in degrees
 */
function calculateHeading(from, to) {
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const dLon = (to.lon - from.lon) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  let heading = Math.atan2(y, x) * 180 / Math.PI;
  heading = (heading + 360) % 360; // Normalize to 0-360

  return heading;
}

const portIcons = {
  default: L.divIcon({ className: 'port-marker', html: '<div class="port-icon">⚓</div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
  origin: L.divIcon({ className: 'port-marker origin', html: '<div class="port-icon">🔴</div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
  destination: L.divIcon({ className: 'port-marker destination', html: '<div class="port-icon">🟢</div>', iconSize: [12, 12], iconAnchor: [6, 6] })
};

/**
 * Initializes Leaflet map with OpenStreetMap tiles
 * Sets up layer groups and marker clusters
 *
 * @param {string} containerId - HTML element ID for map container
 * @returns {void}
 * @example
 * initMap('harbor-map-container');
 */
export function initMap(containerId) {
  // Initialize map centered on northern hemisphere
  map = L.map(containerId, {
    center: [20, 0], // Center on northern hemisphere (20° North, 0° longitude)
    zoom: 1.50,
    minZoom: 1.50, // Minimum zoom = initial zoom (can't zoom out further than world view)
    maxZoom: 18,
    attributionControl: false, // Disable attribution control
    worldCopyJump: true, // Enable world wrapping (jump to copy when panning)
    maxBounds: [[-90, -180], [90, 180]], // Restrict to valid lat/lon
    maxBoundsViscosity: 1.0 // Make bounds hard (can't drag outside)
  });

  // Add saved tile layer (or default to dark)
  currentTileLayer = L.tileLayer(tileLayers[currentMapStyle].url, {
    maxZoom: 19
  }).addTo(map);

  console.log(`[Harbor Map] Initialized with saved style: ${currentMapStyle}`);

  // Set map container background color based on theme
  const mapContainer = map.getContainer();
  const backgroundColor = currentMapStyle === 'standard' ? '#e0e0e0' : '#1f1f1f';
  mapContainer.style.backgroundColor = backgroundColor;

  // Initialize layer groups
  vesselLayer = L.layerGroup().addTo(map);
  portLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  // Initialize marker cluster groups with custom icons
  vesselClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 15,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    iconCreateFunction: function(cluster) {
      const markers = cluster.getAllChildMarkers();
      let containerCount = 0;
      let tankerCount = 0;
      let otherCount = 0;

      // Count vessel types in cluster
      markers.forEach(marker => {
        const className = marker.options.icon.options.className;
        if (className.includes('container')) {
          containerCount++;
        } else if (className.includes('tanker')) {
          tankerCount++;
        } else {
          otherCount++;
        }
      });

      const total = markers.length;

      // Calculate mixed color based on composition (pastel colors)
      let bgColor;
      if (containerCount === total) {
        bgColor = '#fde68a'; // Pastel yellow (all containers)
      } else if (tankerCount === total) {
        bgColor = '#fdba74'; // Pastel orange (all tankers)
      } else {
        // Mixed cluster - blend colors
        const containerRatio = containerCount / total;
        const tankerRatio = tankerCount / total;

        if (containerRatio > tankerRatio) {
          bgColor = '#fcd34d'; // Light yellow-orange (more containers)
        } else if (tankerRatio > containerRatio) {
          bgColor = '#fda874'; // Light orange-yellow (more tankers)
        } else {
          bgColor = '#fbbf72'; // Balanced pastel mix
        }
      }

      return L.divIcon({
        html: `<div style="background-color: ${bgColor}; opacity: 0.85; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #78350f; font-weight: 600; font-size: 10px; border: 1px solid rgba(255,255,255,0.4); box-shadow: 0 2px 8px rgba(0,0,0,0.15);">${total}</div>`,
        className: 'vessel-cluster-icon',
        iconSize: L.point(20, 20)
      });
    }
  });

  portClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 15,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    iconCreateFunction: function(cluster) {
      const count = cluster.getChildCount();
      return L.divIcon({
        html: `<div style="background-color: #bfdbfe; opacity: 0.85; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #1e3a8a; font-weight: 600; font-size: 10px; border: 1px solid rgba(255,255,255,0.4); box-shadow: 0 2px 8px rgba(0,0,0,0.15);">${count}</div>`,
        className: 'port-cluster-icon',
        iconSize: L.point(20, 20)
      });
    }
  });

  vesselLayer.addLayer(vesselClusterGroup);
  portLayer.addLayer(portClusterGroup);

  // Add custom controls
  addCustomControls();

  // Initialize weather layer and dblclick handler only if enableWeatherData is enabled
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.enableWeatherData === true) {
    // Initialize weather layer with saved type
    if (weatherType !== 'off') {
      toggleWeatherLayer(weatherType);
    }

    // Add long-press handler for weather info
    let pressTimer = null;
    let pressStartPos = null;
    const LONG_PRESS_DURATION = 700; // milliseconds
    const MAX_MOVE_DISTANCE = 10; // pixels

    const handlePressStart = (e) => {
      pressStartPos = e.latlng;
      pressTimer = setTimeout(async () => {
        await showWeatherInfo(e.latlng);
        pressTimer = null;
      }, LONG_PRESS_DURATION);
    };

    const handlePressEnd = (e) => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    const handlePressMove = (e) => {
      // Cancel if mouse/finger moved too much
      if (pressTimer && pressStartPos) {
        const distance = map.distance(pressStartPos, e.latlng);
        if (distance > MAX_MOVE_DISTANCE) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      }
    };

    map.on('mousedown', handlePressStart);
    map.on('mouseup', handlePressEnd);
    map.on('mousemove', handlePressMove);
    map.on('touchstart', handlePressStart);
    map.on('touchend', handlePressEnd);
    map.on('touchmove', handlePressMove);
  }

  // Initialize panel dragging
  initializePanelDrag();
  console.log('[Harbor Map] Panel drag initialized');
}

/**
 * Shows weather info popup for a location
 *
 * @param {L.LatLng} latlng - Location coordinates
 * @param {string} tooltipContent - Optional tooltip content to show above weather
 * @returns {Promise<void>}
 */
async function showWeatherInfo(latlng, tooltipContent = null) {
  try {
    // Check if weather data is enabled in settings
    const settings = window.getSettings ? window.getSettings() : {};
    if (settings.enableWeatherData === false) {
      return; // Weather data disabled, do nothing
    }

    // Show loading popup
    const loadingPopup = L.popup()
      .setLatLng(latlng)
      .setContent('<div style="padding: 8px; text-align: center;">🌤️ Loading weather...</div>')
      .openOn(map);

    // Fetch location name and weather data in parallel
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latlng.lat.toFixed(4)}&longitude=${latlng.lng.toFixed(4)}&current_weather=true`;
    const geocodeUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latlng.lat.toFixed(4)}&lon=${latlng.lng.toFixed(4)}&zoom=10`;

    const [weatherResponse, geocodeResponse] = await Promise.all([
      fetch(weatherUrl),
      fetch(geocodeUrl, { headers: { 'User-Agent': 'ShippingManager' } })
    ]);

    const data = await weatherResponse.json();

    if (!data.current_weather) {
      throw new Error('No weather data available');
    }

    const weather = data.current_weather;

    // Try to get location name from geocoding
    let locationName = null;
    try {
      const geocodeData = await geocodeResponse.json();
      // Try to get city, town, village, or fallback
      locationName = geocodeData.address?.city ||
                    geocodeData.address?.town ||
                    geocodeData.address?.village ||
                    geocodeData.address?.county ||
                    null;
    } catch (e) {
      // Geocoding failed, will show coordinates instead
    }

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

    // Theme-based colors - match tooltip styles exactly
    const isDark = currentMapStyle === 'dark' || currentMapStyle === 'satellite';
    const bgColor = isDark ? 'rgba(31, 31, 31, 0.95)' : 'rgba(255, 255, 255, 0.95)';
    const borderColor = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)';
    const boxShadow = isDark ? '0 2px 8px rgba(0, 0, 0, 0.3)' : '0 2px 8px rgba(0, 0, 0, 0.15)';
    const textColor = isDark ? '#e5e7eb' : '#1f2937';
    const tempColor = isDark ? '#60a5fa' : '#2563eb';

    // Display location name if available, otherwise coordinates
    const locationText = locationName
      ? `📍 ${locationName}`
      : `📍 ${latlng.lat.toFixed(2)}, ${latlng.lng.toFixed(2)}`;

    // Create combined popup with tooltip content and weather
    const tooltipSection = tooltipContent ? `
      <div style="padding: 6px 8px; font-size: 11px; line-height: 1.4; background: ${bgColor}; color: ${textColor}; border: 1px solid ${borderColor}; border-radius: 4px; box-shadow: ${boxShadow}; margin-bottom: 4px;">
        ${tooltipContent}
      </div>
    ` : '';

    const content = `
      <div>
        ${tooltipSection}
        <div style="padding: 4px 8px; font-size: 11px; line-height: 1.4; background: ${bgColor}; color: ${textColor}; border: 1px solid ${borderColor}; border-radius: 4px; box-shadow: ${boxShadow};">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 18px;">${icon}</span>
            <div>
              <div style="font-size: 14px; font-weight: 600; color: ${tempColor};">${temp}°C</div>
              <div style="font-size: 9px; opacity: 0.7;">💨 ${wind} km/h</div>
              <div style="font-size: 8px; opacity: 0.6; margin-top: 2px;">${locationText}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Update popup with weather data
    loadingPopup.setContent(content);
  } catch (error) {
    console.error('[Harbor Map] Failed to fetch weather:', error);
    L.popup()
      .setLatLng(latlng)
      .setContent('<div style="padding: 8px; text-align: center; color: #ef4444;">❌ Weather unavailable</div>')
      .openOn(map);
  }
}

/**
 * Toggles weather overlay (Rain Radar or Cloud Cover)
 *
 * @param {string} type - Weather layer type: 'off', 'rain', 'cloud'
 * @returns {void}
 */
function toggleWeatherLayer(type) {
  // Remove existing weather layer
  if (weatherLayer) {
    map.removeLayer(weatherLayer);
    weatherLayer = null;
  }

  weatherType = type;
  localStorage.setItem('harborMapWeatherType', type);

  if (type === 'rain') {
    // Rain Radar (RainViewer)
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000 / 600) * 600;

    weatherLayer = L.tileLayer(
      `https://tilecache.rainviewer.com/v2/radar/${timestamp}/512/{z}/{x}/{y}/2/1_1.png`,
      {
        opacity: 0.6,
        attribution: '© RainViewer',
        maxZoom: 18
      }
    );

    weatherLayer.addTo(map);
    weatherEnabled = true;
    localStorage.setItem('harborMapWeather', 'true');
    console.log('[Harbor Map] Rain radar enabled');
  } else {
    // Off
    weatherEnabled = false;
    localStorage.setItem('harborMapWeather', 'false');
    console.log('[Harbor Map] Weather overlay disabled');
  }
}

/**
 * Adds custom Leaflet controls (filter, refresh)
 * Positioned in top-right corner below zoom controls
 */
function addCustomControls() {
  // Vessel Filter Control
  const VesselFilterControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-filter');

      const options = getVesselFilterOptions();
      const optionsHTML = options.map(opt =>
        `<option value="${opt.value}" ${opt.value === currentVesselFilter ? 'selected' : ''}>${opt.label}</option>`
      ).join('');

      container.innerHTML = `
        <select id="vesselFilterSelect" title="Vessel Filter">
          ${optionsHTML}
        </select>
      `;

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add change listener
      container.querySelector('select').addEventListener('change', async (e) => {
        await setVesselFilter(e.target.value);
      });

      return container;
    }
  });

  // Port Filter Control
  const PortFilterControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-filter');

      const options = getPortFilterOptions();
      const optionsHTML = options.map(opt =>
        `<option value="${opt.value}" ${opt.value === currentPortFilter ? 'selected' : ''}>${opt.label}</option>`
      ).join('');

      container.innerHTML = `
        <select id="portFilterSelect" title="Port Filter">
          ${optionsHTML}
        </select>
      `;

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add change listener
      container.querySelector('select').addEventListener('change', async (e) => {
        await setPortFilter(e.target.value);
      });

      return container;
    }
  });

  // Refresh Control
  const RefreshControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-refresh');
      container.innerHTML = '<button title="Refresh">🔄</button>';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener
      container.querySelector('button').addEventListener('click', async () => {
        const { clearHarborMapCache } = await import('./api-client.js');
        await clearHarborMapCache();
        await loadOverview();
      });

      return container;
    }
  });

  // Map Style Toggle Control (cycles through: standard -> dark -> satellite -> standard)
  const MapStyleControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom map-style-toggle');

      // Emoji map for each style
      const styleEmojis = {
        'standard': '🗺️',
        'dark': '🌙',
        'satellite': '🛰️'
      };

      container.innerHTML = styleEmojis[currentMapStyle];
      container.title = 'Map Style';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener - cycle through styles
      container.addEventListener('click', () => {
        const styles = ['standard', 'dark', 'satellite'];
        const currentIndex = styles.indexOf(currentMapStyle);
        const nextIndex = (currentIndex + 1) % styles.length;
        const nextStyle = styles[nextIndex];

        changeTileLayer(nextStyle);
        container.innerHTML = styleEmojis[nextStyle];

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Map Style';
        }, 100);
      });

      return container;
    }
  });

  // Route Filter Control
  const RouteFilterControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-route-filter');
      container.innerHTML = `
        <select id="routeFilterSelect">
          <option value="">All Routes</option>
        </select>
      `;

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add change listener
      container.querySelector('select').addEventListener('change', async (e) => {
        await setRouteFilter(e.target.value);
      });

      return container;
    }
  });

  // Fullscreen Control
  const FullscreenControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-fullscreen');
      container.innerHTML = '<button title="Fullscreen">⛶</button>';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener
      container.querySelector('button').addEventListener('click', () => {
        const mapWrapper = document.querySelector('.chat-area-wrapper');
        const button = container.querySelector('button');

        if (!mapWrapper) {
          console.error('[Harbor Map] Cannot find map wrapper for fullscreen');
          return;
        }

        if (mapWrapper.classList.contains('fullscreen')) {
          // Exit fullscreen
          mapWrapper.classList.remove('fullscreen');
          button.innerHTML = '⛶';
          button.title = 'Fullscreen';
        } else {
          // Enter fullscreen
          mapWrapper.classList.add('fullscreen');
          button.innerHTML = '⛶';
          button.title = 'Exit Fullscreen';
        }

        // Invalidate map size after transition
        setTimeout(() => {
          map.invalidateSize();
        }, 300);
      });

      return container;
    }
  });

  // Weather Control (Rain Radar Toggle)
  const WeatherControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom weather-toggle');

      const updateWeatherButton = () => {
        container.style.position = 'relative';

        if (weatherEnabled) {
          container.innerHTML = '🌧️';
        } else {
          container.innerHTML = '🌧️';
        }

        // Add or update strike-through line
        let strikeLine = container.querySelector('.weather-strike');
        if (!strikeLine) {
          strikeLine = document.createElement('div');
          strikeLine.className = 'weather-strike';
          strikeLine.style.cssText = `
            position: absolute;
            top: 50%;
            left: 0;
            width: 100%;
            height: 3px;
            background-color: #ef4444;
            transform: translateY(-50%) rotate(-45deg);
            pointer-events: none;
          `;
          container.appendChild(strikeLine);
        }
        strikeLine.style.display = weatherEnabled ? 'none' : 'block';
      };

      updateWeatherButton();
      container.title = 'Rain Radar';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener
      container.addEventListener('click', () => {
        weatherEnabled = !weatherEnabled;

        if (weatherEnabled) {
          toggleWeatherLayer('rain');
        } else {
          toggleWeatherLayer('off');
        }

        updateWeatherButton();

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Rain Radar';
        }, 100);
      });

      return container;
    }
  });

  // Environmental Layer Control - Rotating button (off -> wind -> clouds -> temperature -> off)
  const EnvironmentalLayerControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom env-layer-toggle');

      // Function to update button appearance
      const updateButton = (resetTooltip = false) => {
        let tooltipText = '';

        switch(currentEnvLayer) {
          case 'wind':
            container.innerHTML = '💨';
            container.style.opacity = '1';
            break;
          case 'clouds':
            container.innerHTML = '☁️';
            container.style.opacity = '1';
            break;
          case 'temperature':
            container.innerHTML = '🌡️';
            container.style.opacity = '1';
            break;
          default: // 'off'
            container.innerHTML = '🌍';
            container.style.opacity = '0.5';
            tooltipText = 'Environmental Layers';
            break;
        }

        // Update tooltip: remove old one, then set new one after delay
        if (resetTooltip) {
          container.removeAttribute('title');
          setTimeout(() => {
            if (tooltipText) {
              container.title = tooltipText;
            }
          }, 100);
        } else {
          if (tooltipText) {
            container.title = tooltipText;
          } else {
            container.removeAttribute('title');
          }
        }
      };

      // Function to start cloud layer (static for now)
      const startCloudAnimation = () => {
        stopCloudAnimation(); // Clean up any existing animation

        console.log('[Environmental] Adding cloud layer...');

        // Use single OWM clouds layer with higher opacity for better visibility
        const opacity = currentMapStyle === 'standard' ? 0.7 : 0.5;
        envLayer = L.OWM.clouds({showLegend: false, opacity: opacity});
        envLayer.addTo(map);
      };

      // Function to stop cloud layer
      const stopCloudAnimation = () => {
        if (envLayer && map.hasLayer(envLayer)) {
          map.removeLayer(envLayer);
          envLayer = null;
        }

        console.log('[Environmental] Removed cloud layer');
      };

      // Function to switch to next layer
      const switchEnvLayer = (newLayer) => {
        // Stop cloud animation if switching away from clouds
        if (currentEnvLayer === 'clouds') {
          stopCloudAnimation();
        }

        // Remove old layer (non-animated)
        if (envLayer) {
          map.removeLayer(envLayer);
          envLayer = null;
        }

        // Add new layer
        if (newLayer !== 'off') {
          console.log(`[Environmental] Switching to ${newLayer} layer...`);
          switch(newLayer) {
            case 'wind':
              // Higher opacity in standard mode for better visibility
              const windOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
              envLayer = L.OWM.wind({opacity: windOpacity});
              envLayer.addTo(map);
              break;
            case 'clouds':
              // Use animated clouds
              startCloudAnimation();
              break;
            case 'temperature':
              // Higher opacity in standard mode for better visibility
              const tempOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
              envLayer = L.OWM.temperature({showLegend: true, opacity: tempOpacity});
              envLayer.addTo(map);
              break;
          }
        }

        currentEnvLayer = newLayer;
        localStorage.setItem('harborMapEnvLayer', newLayer);
        updateButton(true); // Reset tooltip after click
      };

      L.DomEvent.disableClickPropagation(container);

      container.addEventListener('click', () => {
        // Rotate through: off -> wind -> clouds -> temperature -> off
        const nextLayer = {
          'off': 'wind',
          'wind': 'clouds',
          'clouds': 'temperature',
          'temperature': 'off'
        }[currentEnvLayer] || 'wind';

        switchEnvLayer(nextLayer);
      });

      updateButton();
      return container;
    }
  });

  // Zoom Level Display Control
  const ZoomDisplayControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom zoom-display');
      container.style.cssText = `
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        pointer-events: none;
      `;

      const updateZoom = () => {
        const zoom = map.getZoom();
        container.innerHTML = `Zoom: ${zoom}`;
      };

      updateZoom();
      map.on('zoomend', updateZoom);

      return container;
    }
  });

  // Museums Layer Control - Simple toggle button (no zoom limit - not many museums)
  let museumsEnabled = localStorage.getItem('harborMapMuseumsEnabled') === 'true';
  let museumsMarkerLayer = null;

  const MuseumsLayerControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom museums-toggle');

      const updateButton = () => {
        container.style.position = 'relative';
        container.innerHTML = '🏛️';

        let strikeLine = container.querySelector('.museums-strike');
        if (!strikeLine) {
          strikeLine = document.createElement('div');
          strikeLine.className = 'museums-strike';
          strikeLine.style.cssText = `
            position: absolute;
            top: 50%;
            left: 0;
            width: 100%;
            height: 3px;
            background-color: #ef4444;
            transform: translateY(-50%) rotate(-45deg);
            pointer-events: none;
          `;
          container.appendChild(strikeLine);
        }
        strikeLine.style.display = museumsEnabled ? 'none' : 'block';
      };

      updateButton();
      container.title = 'Maritime Museums';

      L.DomEvent.disableClickPropagation(container);

      container.addEventListener('click', async () => {
        museumsEnabled = !museumsEnabled;
        localStorage.setItem('harborMapMuseumsEnabled', museumsEnabled);

        if (museumsEnabled) {
          try {
            // Load all museums (no bbox - there aren't many)
            const response = await fetch(window.apiUrl(`/api/poi/museums`));
            if (!response.ok) return;

            const data = await response.json();
            const museums = data.museums || [];

            if (museums.length > 0) {
              museumsMarkerLayer = L.layerGroup();

              museums.forEach(poi => {
                if (!poi.lat || !poi.lon) return;

                const name = poi.tags?.name || 'Unknown Museum';
                const openingHours = poi.tags?.opening_hours || '';
                const website = poi.tags?.website || '';
                const wikipedia = poi.tags?.wikipedia || '';

                const icon = L.divIcon({
                  className: 'poi-marker',
                  html: `<div style="font-size: 20px;">🏛️</div>`,
                  iconSize: [30, 30],
                  iconAnchor: [15, 15]
                });

                const marker = L.marker([poi.lat, poi.lon], { icon });

                let tooltipContent = `<strong>${name}</strong>`;
                if (openingHours) tooltipContent += `<br>🕒 ${openingHours}`;

                marker.bindTooltip(tooltipContent, {
                  direction: 'auto',
                  offset: [0, -10]
                });

                marker.on('click', async (e) => {
                  marker.closeTooltip();
                  let popupContent = `<strong>${name}</strong><br>Museum`;
                  if (openingHours) popupContent += `<br>🕒 ${openingHours}`;
                  if (website) popupContent += `<br>🌐 <a href="${website}" target="_blank" style="color: #4a9eff;">Website</a>`;
                  if (wikipedia) {
                    const wikiUrl = wikipedia.startsWith('http') ? wikipedia : `https://en.wikipedia.org/wiki/${wikipedia}`;
                    popupContent += `<br>📖 <a href="${wikiUrl}" target="_blank" style="color: #4a9eff;">Wikipedia</a>`;
                  }
                  await showWeatherInfo(e.latlng, popupContent);
                });

                museumsMarkerLayer.addLayer(marker);
              });

              museumsMarkerLayer.addTo(map);
            }
          } catch (error) {
            console.error('[Museums] Load error:', error);
          }
        } else {
          if (museumsMarkerLayer && map.hasLayer(museumsMarkerLayer)) {
            map.removeLayer(museumsMarkerLayer);
            museumsMarkerLayer = null;
          }
        }

        updateButton();

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Maritime Museums';
        }, 100);
      });

      if (museumsEnabled) {
        container.click();
      }

      return container;
    }
  });

  // Wrecks Layer Control - Simple toggle button
  let wrecksEnabled = localStorage.getItem('harborMapWrecksEnabled') === 'true';
  let wrecksMarkerLayer = null;
  let wrecksZoomNotification = null; // Store notification to prevent stacking
  let wrecksLoadTimeout = null; // Debounce timer for loading wrecks
  let lastWrecksBounds = null; // Track last loaded bounds to avoid duplicate loads

  // Function to load wrecks for current map view
  const loadWrecksForCurrentView = async () => {
    const currentZoom = map.getZoom();

    // Only load if enabled and zoom >= 5
    if (!wrecksEnabled || currentZoom < 5) {
      return;
    }

    try {
      // Get current map bounds
      const bounds = map.getBounds();

      // Check if bounds changed significantly (more than 10% movement)
      if (lastWrecksBounds) {
        const lastSouth = lastWrecksBounds.getSouth();
        const lastWest = lastWrecksBounds.getWest();
        const lastNorth = lastWrecksBounds.getNorth();
        const lastEast = lastWrecksBounds.getEast();

        const currentSouth = bounds.getSouth();
        const currentWest = bounds.getWest();
        const currentNorth = bounds.getNorth();
        const currentEast = bounds.getEast();

        // Calculate how much the view has moved (as percentage of view size)
        const latDiff = lastNorth - lastSouth;
        const lngDiff = lastEast - lastWest;

        const southMove = Math.abs(currentSouth - lastSouth) / latDiff;
        const westMove = Math.abs(currentWest - lastWest) / lngDiff;
        const northMove = Math.abs(currentNorth - lastNorth) / latDiff;
        const eastMove = Math.abs(currentEast - lastEast) / lngDiff;

        const maxMove = Math.max(southMove, westMove, northMove, eastMove);

        // If view moved less than 10%, skip reload
        if (maxMove < 0.1) {
          console.log(`[Wrecks] Skipping reload - view moved only ${(maxMove * 100).toFixed(1)}%`);
          return;
        }
      }

      // Remove old markers
      if (wrecksMarkerLayer && map.hasLayer(wrecksMarkerLayer)) {
        map.removeLayer(wrecksMarkerLayer);
        wrecksMarkerLayer = null;
      }

      const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
      console.log(`[Wrecks] Loading with bbox: ${bbox}`);

      const response = await fetch(window.apiUrl(`/api/poi/wrecks?bbox=${encodeURIComponent(bbox)}`));
      if (!response.ok) return;

      const data = await response.json();
      const wrecks = data.wrecks || [];
      console.log(`[Wrecks] API returned ${wrecks.length} wrecks for bbox`);

      if (wrecks.length > 0) {
        wrecksMarkerLayer = L.layerGroup();

        wrecks.forEach(poi => {
          if (!poi.lat || !poi.lon) return;

          const name = poi.tags?.name || 'Unknown Wreck';
          const dateSunk = poi.tags?.['wreck:date_sunk'] || poi.tags?.['wreck:year_sunk'] || '';
          const depthMetres = poi.tags?.['wreck:depth_metres'] || '';
          const cargo = poi.tags?.['wreck:cargo'] || '';
          const wreckType = poi.tags?.['wreck:type'] || '';
          const visibleAtLowTide = poi.tags?.['wreck:visible_at_low_tide'] || '';
          const description = poi.tags?.description || '';
          const website = poi.tags?.website || '';
          const wikipedia = poi.tags?.wikipedia || '';

          const icon = L.divIcon({
            className: 'poi-marker',
            html: `<div style="font-size: 20px;">🪦</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          });

          const marker = L.marker([poi.lat, poi.lon], { icon });

          let tooltipContent = `<strong>${name}</strong><br>Shipwreck`;
          if (dateSunk) tooltipContent += `<br>⚓ Sunk: ${dateSunk}`;
          if (depthMetres) tooltipContent += `<br>🌊 Depth: ${depthMetres}m`;

          marker.bindTooltip(tooltipContent, {
            direction: 'auto',
            offset: [0, -10]
          });

          marker.on('click', async (e) => {
            marker.closeTooltip();
            let popupContent = `<strong>${name}</strong>`;
            if (wreckType) popupContent += ` (${wreckType})`;
            if (!wreckType) popupContent += `<br>Shipwreck`;

            if (description) popupContent += `<br><br>${description}`;
            if (dateSunk) popupContent += `<br><br>⚓ Sunk: ${dateSunk}`;
            if (cargo) popupContent += `<br>📦 Cargo: ${cargo}`;
            if (depthMetres) popupContent += `<br>🌊 Depth: ${depthMetres} metres`;
            if (visibleAtLowTide) popupContent += `<br>🌅 Visible at low tide: ${visibleAtLowTide}`;

            if (website) popupContent += `<br><br>🌐 <a href="${website}" target="_blank" style="color: #4a9eff;">Website</a>`;
            if (wikipedia) {
              const wikiUrl = wikipedia.startsWith('http') ? wikipedia : `https://en.wikipedia.org/wiki/${wikipedia}`;
              popupContent += `<br>📖 <a href="${wikiUrl}" target="_blank" style="color: #4a9eff;">Wikipedia</a>`;
            }
            await showWeatherInfo(e.latlng, popupContent);
          });

          wrecksMarkerLayer.addLayer(marker);
        });

        wrecksMarkerLayer.addTo(map);
        console.log(`[Wrecks] Loaded ${wrecks.length} wrecks for current view`);
      }

      // Store the bounds we just loaded to prevent duplicate loads
      lastWrecksBounds = bounds;
    } catch (error) {
      console.error('[Wrecks] Load error:', error);
    }
  };

  const WrecksLayerControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom wrecks-toggle');

      const updateButton = () => {
        container.style.position = 'relative';
        container.innerHTML = '🪦';

        let strikeLine = container.querySelector('.wrecks-strike');
        if (!strikeLine) {
          strikeLine = document.createElement('div');
          strikeLine.className = 'wrecks-strike';
          strikeLine.style.cssText = `
            position: absolute;
            top: 50%;
            left: 0;
            width: 100%;
            height: 3px;
            background-color: #ef4444;
            transform: translateY(-50%) rotate(-45deg);
            pointer-events: none;
          `;
          container.appendChild(strikeLine);
        }
        strikeLine.style.display = wrecksEnabled ? 'none' : 'block';
      };

      updateButton();
      container.title = 'Shipwrecks';

      L.DomEvent.disableClickPropagation(container);

      container.addEventListener('click', async () => {
        const currentZoom = map.getZoom();

        // If trying to enable but zoom is too low, show warning and don't enable
        if (!wrecksEnabled && currentZoom < 5) {
          showSideNotification(
            `⚠️ <strong>Zoom in to see Wrecks</strong><br><br>Wrecks are only visible at zoom level 5 or higher. They will appear when you zoom in.`,
            'warning',
            4000
          );
          return; // Don't toggle the state
        }

        wrecksEnabled = !wrecksEnabled;
        localStorage.setItem('harborMapWrecksEnabled', wrecksEnabled);

        if (wrecksEnabled) {
          // Zoom is OK, load wrecks immediately
          await loadWrecksForCurrentView();
        } else {
          // Disabled - remove markers and reset bbox tracking
          if (wrecksMarkerLayer && map.hasLayer(wrecksMarkerLayer)) {
            map.removeLayer(wrecksMarkerLayer);
            wrecksMarkerLayer = null;
          }
          lastWrecksBounds = null; // Reset bounds tracking when disabled
        }

        updateButton();

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Shipwrecks';
        }, 100);
      });

      if (wrecksEnabled) {
        container.click();
      }

      return container;
    }
  });

  // Add controls to map (order matters - top to bottom for topleft, top to bottom for topright)

  // Top left controls (icon buttons - after +/- zoom which Leaflet adds automatically)
  map.addControl(new FullscreenControl());
  map.addControl(new MapStyleControl());

  // Only add Weather Control if enableWeatherData is enabled
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.enableWeatherData === true) {
    weatherControl = new WeatherControl();
    map.addControl(weatherControl);
  }

  // Add Environmental Layer Control (rotating button: off -> wind -> clouds -> temperature)
  envLayerControl = new EnvironmentalLayerControl();
  map.addControl(envLayerControl);

  // Add Museums and Wrecks Layer Controls (two separate toggle buttons)
  map.addControl(new MuseumsLayerControl());
  map.addControl(new WrecksLayerControl());

  // Add Refresh Control last (at bottom)
  map.addControl(new RefreshControl());

  // Add Zoom Display Control (bottom left)
  map.addControl(new ZoomDisplayControl());

  // Top right controls (filter dropdowns)
  map.addControl(new RouteFilterControl());
  map.addControl(new VesselFilterControl());
  map.addControl(new PortFilterControl());

  // Auto-reload wrecks when zooming or moving map (with debouncing)
  map.on('zoomend', () => {
    const currentZoom = map.getZoom();

    // Clear any pending load timeout
    if (wrecksLoadTimeout) {
      clearTimeout(wrecksLoadTimeout);
      wrecksLoadTimeout = null;
    }

    if (wrecksEnabled) {
      if (currentZoom < 5) {
        // Hide wrecks if zoom too low
        if (wrecksMarkerLayer && map.hasLayer(wrecksMarkerLayer)) {
          map.removeLayer(wrecksMarkerLayer);
          wrecksMarkerLayer = null;
          lastWrecksBounds = null; // Reset bounds tracking
          console.log(`[Wrecks] Auto-hidden at zoom level ${currentZoom}`);
        }
      } else {
        // Zoom is OK, reload wrecks after 500ms delay (debounce)
        wrecksLoadTimeout = setTimeout(() => {
          loadWrecksForCurrentView();
        }, 500);
      }
    }
  });

  // Reload wrecks when map is moved (panned/dragged) with debouncing
  map.on('moveend', () => {
    // Clear any pending load timeout
    if (wrecksLoadTimeout) {
      clearTimeout(wrecksLoadTimeout);
      wrecksLoadTimeout = null;
    }

    if (wrecksEnabled && map.getZoom() >= 5) {
      // Wait 500ms after movement stops before loading (debounce)
      wrecksLoadTimeout = setTimeout(() => {
        loadWrecksForCurrentView();
      }, 500);
    }
  });

  // Set saved values in dropdowns
  const vesselFilterSelect = document.getElementById('vesselFilterSelect');
  const portFilterSelect = document.getElementById('portFilterSelect');

  if (vesselFilterSelect) {
    vesselFilterSelect.value = currentVesselFilter;
  }

  if (portFilterSelect) {
    portFilterSelect.value = currentPortFilter;
  }

  console.log(`[Harbor Map] Restored saved settings - Style: ${currentMapStyle}, Vessel Filter: ${currentVesselFilter}, Port Filter: ${currentPortFilter}, Route Filter: ${currentRouteFilter || 'All Routes'}`);

  // Initialize Environmental Layer if enabled (restore from localStorage)
  if (currentEnvLayer && currentEnvLayer !== 'off') {
    console.log(`[Environmental] Restoring ${currentEnvLayer} layer from saved state...`);
    switch(currentEnvLayer) {
      case 'wind':
        // Higher opacity in standard mode for better visibility
        const windOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
        envLayer = L.OWM.wind({opacity: windOpacity});
        if (envLayer) {
          envLayer.addTo(map);
        }
        break;
      case 'clouds':
        // Add cloud layer (static) with higher opacity in standard mode
        const cloudsOpacity = currentMapStyle === 'standard' ? 0.7 : 0.5;
        envLayer = L.OWM.clouds({showLegend: false, opacity: cloudsOpacity});
        envLayer.addTo(map);
        break;
      case 'temperature':
        // Higher opacity in standard mode for better visibility
        const tempOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
        envLayer = L.OWM.temperature({showLegend: true, opacity: tempOpacity});
        if (envLayer) {
          envLayer.addTo(map);
        }
        break;
    }
  }

  // Apply theme class for control styling
  applyMapTheme(currentMapStyle);
}

/**
 * Applies theme class to map container for control styling
 *
 * @param {string} style - Map style key ('standard', 'dark', 'satellite')
 * @returns {void}
 */
function applyMapTheme(style) {
  const mapCanvas = document.getElementById('harborMapCanvas');
  if (!mapCanvas) return;

  // Remove all theme classes
  mapCanvas.classList.remove('theme-light', 'theme-dark', 'theme-satellite');

  // Add appropriate theme class
  if (style === 'standard') {
    mapCanvas.classList.add('theme-light');
  } else if (style === 'satellite') {
    mapCanvas.classList.add('theme-satellite');
  } else {
    // dark uses dark controls
    mapCanvas.classList.add('theme-dark');
  }

  console.log(`[Harbor Map] Applied theme class for style: ${style}`);
}

/**
 * Changes the map tile layer (theme)
 *
 * @param {string} layerKey - Key from tileLayers object
 * @returns {void}
 */
function changeTileLayer(layerKey) {
  if (!tileLayers[layerKey]) return;

  // Remove current layer
  if (currentTileLayer) {
    map.removeLayer(currentTileLayer);
  }

  // Add new layer
  currentTileLayer = L.tileLayer(tileLayers[layerKey].url, {
    maxZoom: 19
  }).addTo(map);

  // Save to localStorage
  currentMapStyle = layerKey;
  localStorage.setItem('harborMapStyle', layerKey);

  // Apply theme class for control styling
  applyMapTheme(layerKey);

  // Update map container background color
  const mapContainer = map.getContainer();
  const backgroundColor = layerKey === 'standard' ? '#e0e0e0' : '#1f1f1f';
  mapContainer.style.backgroundColor = backgroundColor;

  // Re-add environmental layer if active (to keep it on top of the new tile layer)
  if (envLayer && currentEnvLayer !== 'off') {
    envLayer.bringToFront();
  }

  console.log(`[Harbor Map] Changed map style to: ${tileLayers[layerKey].name} (saved)`);
}

/**
 * Renders vessels as markers on the map
 * Uses color-coded icons based on vessel status
 *
 * @param {Array<Object>} vessels - Vessels with position data from backend
 * @returns {void}
 * @example
 * renderVessels([{ id: 1234, position: { lat: -27.38, lon: 153.12 }, status: 'enroute', ... }]);
 */
export function renderVessels(vessels) {
  vesselClusterGroup.clearLayers();

  console.log(`[Harbor Map] Rendering ${vessels.length} vessels`);

  let skipped = 0;
  vessels.forEach(vessel => {
    if (!vessel.position) {
      skipped++;
      return;
    }

    // Get vessel type from capacity_type field
    const vesselType = getVesselType(vessel.capacity_type);

    // Calculate heading if vessel has route
    let heading = 0;
    if (vessel.routes && vessel.routes.length > 0 && vessel.routes[0].path && vessel.routes[0].path.length >= 2) {
      const path = vessel.routes[0].path;
      // Find current position in path and calculate heading to next point
      for (let i = 0; i < path.length - 1; i++) {
        const point = path[i];
        if (Math.abs(point.lat - vessel.position.lat) < 0.01 && Math.abs(point.lon - vessel.position.lon) < 0.01) {
          heading = calculateHeading(point, path[i + 1]);
          break;
        }
      }
      // If not found in path, use first two points
      if (heading === 0 && path.length >= 2) {
        heading = calculateHeading(path[0], path[1]);
      }
    }

    // Create icon with type, status, and heading
    const icon = createVesselIcon(vessel.status, vesselType, heading);

    // Add offset for vessels in port to prevent overlap with port marker
    // Shift slightly northeast to make both clickable
    let vesselLat = vessel.position.lat;
    let vesselLon = vessel.position.lon;
    if (vessel.status === 'port' || vessel.status === 'anchor') {
      vesselLat += 0.003; // ~300m north
      vesselLon += 0.003; // ~300m east
    }

    // Create marker
    const marker = L.marker([vesselLat, vesselLon], { icon });

    // Prepare tooltip content with detailed cargo info
    let cargoDisplay = 'N/A';
    if (vessel.capacity && vessel.capacity_max) {
      if (vessel.capacity_type === 'container') {
        const dry = vessel.capacity.dry;
        const ref = vessel.capacity.refrigerated;
        const dryMax = vessel.capacity_max.dry;
        const refMax = vessel.capacity_max.refrigerated;
        cargoDisplay = `Dry: ${dry}/${dryMax} TEU, Ref: ${ref}/${refMax} TEU`;
      } else if (vessel.capacity_type === 'tanker') {
        const fuel = vessel.capacity.fuel;
        const crude = vessel.capacity.crude_oil;
        const fuelMax = vessel.capacity_max.fuel;
        const crudeMax = vessel.capacity_max.crude_oil;
        cargoDisplay = `Fuel: ${fuel}/${fuelMax} bbl, Crude: ${crude}/${crudeMax} bbl`;
      }
    }

    const vesselTooltipContent = `
      <strong>${vessel.name}</strong><br>
      Status: ${vessel.status}${vessel.eta !== 'N/A' ? ` | ETA: ${vessel.eta}` : ''}<br>
      Cargo: ${cargoDisplay}
    `;

    // Bind tooltip (hover) with vessel info
    marker.bindTooltip(vesselTooltipContent, {
      direction: 'auto',
      offset: [0, -10]
    });

    // Click handler - close tooltip, open vessel panel and show combined weather popup
    marker.on('click', async (e) => {
      marker.closeTooltip();
      window.harborMap.selectVesselFromMap(vessel.id);
      await showWeatherInfo(e.latlng, vesselTooltipContent);
    });

    vesselClusterGroup.addLayer(marker);
  });

  console.log(`[Harbor Map] Rendered ${vessels.length - skipped} vessels, skipped ${skipped} without position`);
}

/**
 * Renders ports as markers on the map
 * Uses color-coded markers for demand levels
 *
 * @param {Array<Object>} ports - Ports with demand data from backend
 * @returns {void}
 * @example
 * renderPorts([{ code: 'AUBNE', lat: -27.38, lon: 153.12, demandLevel: 'high', ... }]);
 */
export function renderPorts(ports) {
  portClusterGroup.clearLayers();

  console.log(`[Harbor Map] Rendering ${ports.length} ports`);
  if (ports.length > 0) {
    console.log('[Harbor Map] First port sample:', {
      code: ports[0].code,
      hasDemand: !!ports[0].demand,
      demand: ports[0].demand
    });
  }

  ports.forEach(port => {
    if (!port.lat || !port.lon) return;

    // Format demand for tooltip
    let demandText = 'No active route / Demand unknown';
    if (port.demand) {
      const parts = [];
      if (port.demand.container) {
        const dry = port.demand.container.dry || 0;
        const ref = port.demand.container.refrigerated || 0;
        parts.push(`Container: Dry ${dry.toLocaleString()} TEU / Ref ${ref.toLocaleString()} TEU`);
      }
      if (port.demand.tanker) {
        const fuel = port.demand.tanker.fuel || 0;
        const crude = port.demand.tanker.crude_oil || 0;
        parts.push(`Tanker: Fuel: ${fuel.toLocaleString()} bbl / Crude: ${crude.toLocaleString()} bbl`);
      }
      if (parts.length > 0) {
        demandText = parts.join('<br>');
      }
    }

    // Format port name
    const portName = port.code.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

    // Prepare tooltip content
    const portTooltipContent = `
      <strong>${portName}</strong><br>
      ${demandText}
    `;

    // Create marker
    const marker = L.marker([parseFloat(port.lat), parseFloat(port.lon)], {
      icon: portIcons.default
    });

    // Bind tooltip (hover) with port info
    marker.bindTooltip(portTooltipContent, {
      direction: 'auto',
      offset: [0, -10]
    });

    // Click handler - close tooltip, select port and show combined weather popup
    marker.on('click', async (e) => {
      marker.closeTooltip();
      selectPort(port.code);
      await showWeatherInfo(e.latlng, portTooltipContent);
    });

    portClusterGroup.addLayer(marker);
  });
}

/**
 * Draws route path on map with blue polyline
 * Highlights origin (red) and destination (green) ports
 *
 * @param {Object} route - Route data from backend
 * @param {Array<Object>} ports - Array of port objects with demand data
 * @param {boolean} autoZoom - Whether to auto-zoom to route bounds (default: true)
 * @returns {void}
 * @example
 * drawRoute({ path: [{lat: -27.38, lon: 153.12}, ...], origin: 'AUBNE', destination: 'NZAKL' }, ports);
 */
export function drawRoute(route, ports = [], autoZoom = true) {
  routeLayer.clearLayers();

  if (!route || !route.path || route.path.length === 0) {
    console.log('[Harbor Map] No route to draw');
    return;
  }

  // Support both field names for backwards compatibility
  const originPort = route.origin || route.origin_port_code;
  const destinationPort = route.destination || route.destination_port_code;

  console.log('[Harbor Map] Drawing route:', {
    origin: originPort,
    destination: destinationPort,
    pathLength: route.path.length
  });

  // Draw route path as blue polyline
  const latLngs = route.path.map(p => [p.lat, p.lon]);
  const polyline = L.polyline(latLngs, {
    color: '#3388ff',
    weight: 3,
    opacity: 0.7
  });

  routeLayer.addLayer(polyline);

  // Highlight origin port (red)
  if (originPort) {
    const originName = originPort.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    const originMarker = L.marker(latLngs[0], { icon: portIcons.origin });

    // Find port data for demand info
    const originPortData = ports.find(p => p.code === originPort);
    let demandText = 'N/A';

    if (originPortData && originPortData.demand) {
      const parts = [];
      if (originPortData.demand.container) {
        const dry = originPortData.demand.container.dry || 0;
        const ref = originPortData.demand.container.refrigerated || 0;
        parts.push(`Container: Dry ${dry.toLocaleString()} TEU / Ref ${ref.toLocaleString()} TEU`);
      }
      if (originPortData.demand.tanker) {
        const fuel = originPortData.demand.tanker.fuel || 0;
        const crude = originPortData.demand.tanker.crude_oil || 0;
        parts.push(`Tanker: Fuel: ${fuel.toLocaleString()} bbl / Crude: ${crude.toLocaleString()} bbl`);
      }
      if (parts.length > 0) {
        demandText = parts.join('<br>');
      }
    }

    // Bind tooltip - same format as normal ports (mouseover only)
    originMarker.bindTooltip(`
      <strong>${originName}</strong><br>
      <strong>Demand</strong><br>
      ${demandText}
    `, {
      direction: 'auto',
      offset: [0, -10],
      className: 'route-port-tooltip'
    });

    // Click handler - open port panel
    originMarker.on('click', () => selectPort(originPort));

    routeLayer.addLayer(originMarker);
    console.log('[Harbor Map] Added origin port marker:', originName, latLngs[0]);
  } else {
    console.warn('[Harbor Map] No origin port in route data');
  }

  // Highlight destination port (green)
  if (destinationPort) {
    const destName = destinationPort.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    const destMarker = L.marker(latLngs[latLngs.length - 1], { icon: portIcons.destination });

    // Find port data for demand info
    const destPortData = ports.find(p => p.code === destinationPort);
    let demandText = 'N/A';

    if (destPortData && destPortData.demand) {
      const parts = [];
      if (destPortData.demand.container) {
        const dry = destPortData.demand.container.dry || 0;
        const ref = destPortData.demand.container.refrigerated || 0;
        parts.push(`Container: Dry ${dry.toLocaleString()} TEU / Ref ${ref.toLocaleString()} TEU`);
      }
      if (destPortData.demand.tanker) {
        const fuel = destPortData.demand.tanker.fuel || 0;
        const crude = destPortData.demand.tanker.crude_oil || 0;
        parts.push(`Tanker: Fuel: ${fuel.toLocaleString()} bbl / Crude: ${crude.toLocaleString()} bbl`);
      }
      if (parts.length > 0) {
        demandText = parts.join('<br>');
      }
    }

    // Bind tooltip - same format as normal ports (mouseover only)
    destMarker.bindTooltip(`
      <strong>${destName}</strong><br>
      <strong>Demand</strong><br>
      ${demandText}
    `, {
      direction: 'auto',
      offset: [0, -10],
      className: 'route-port-tooltip'
    });

    // Click handler - open port panel
    destMarker.on('click', () => selectPort(destinationPort));

    routeLayer.addLayer(destMarker);
    console.log('[Harbor Map] Added destination port marker:', destName, latLngs[latLngs.length - 1]);
  } else {
    console.warn('[Harbor Map] No destination port in route data');
  }

  // Fit map to route bounds (only if autoZoom is true)
  if (autoZoom) {
    map.fitBounds(polyline.getBounds(), {
      paddingTopLeft: [50, 50],
      paddingBottomRight: [325, 50] // 275px panel + 50px extra padding
    });
  }
}

/**
 * Clears route layer (removes blue line and port highlights)
 *
 * @returns {void}
 * @example
 * clearRoute();
 */
export function clearRoute() {
  routeLayer.clearLayers();
}

/**
 * Sets port filter to specific value (client-side only - no API calls)
 *
 * @param {string} filter - Port filter type
 * @returns {Promise<void>}
 * @example
 * await setPortFilter('my_ports');
 */
export async function setPortFilter(filter) {
  currentPortFilter = filter;
  localStorage.setItem('harborMapPortFilter', filter);
  console.log(`[Harbor Map] Port filter changed to: ${filter} (client-side)`);

  // Apply filter client-side (no API call)
  await applyFiltersAndRender();
}

/**
 * Sets vessel filter to specific value (client-side only - no API calls)
 *
 * @param {string} filter - Vessel filter type
 * @returns {Promise<void>}
 * @example
 * await setVesselFilter('tanker_only');
 */
export async function setVesselFilter(filter) {
  currentVesselFilter = filter;
  localStorage.setItem('harborMapVesselFilter', filter);
  console.log(`[Harbor Map] Vessel filter changed to: ${filter} (client-side)`);

  // Apply filter client-side (no API call)
  await applyFiltersAndRender();
}

/**
 * Applies current filters to raw data and renders the result
 * NO API calls - pure client-side filtering
 *
 * @returns {Promise<void>}
 */
async function applyFiltersAndRender() {
  // Debug: Check raw data
  const assignedPortsCount = rawPorts.filter(p => p.isAssigned === true).length;
  console.log(`[Harbor Map] Raw data - Total Ports: ${rawPorts.length}, Assigned Ports: ${assignedPortsCount}, Total Vessels: ${rawVessels.length}`);

  // Debug: Show first port structure
  if (rawPorts.length > 0) {
    console.log(`[Harbor Map] Sample port:`, rawPorts[0]);
  }

  // Apply vessel filter
  let filteredVessels = filterVessels(rawVessels, currentVesselFilter);

  // Apply port filter (ports need vessel data for some filters)
  let filteredPorts = filterPorts(rawPorts, rawVessels, currentPortFilter);

  console.log(`[Harbor Map] Applied filters - Vessel Filter: ${currentVesselFilter}, Port Filter: ${currentPortFilter}`);
  console.log(`[Harbor Map] Filtered results - Vessels: ${filteredVessels.length}/${rawVessels.length}, Ports: ${filteredPorts.length}/${rawPorts.length}`);

  // Store filtered data for route filtering
  currentVessels = filteredVessels;
  currentPorts = filteredPorts;

  // Update route dropdown
  updateRouteDropdown();

  // Apply route filter if active
  const vesselsToRender = currentRouteFilter
    ? currentVessels.filter(v => v.route_name === currentRouteFilter)
    : currentVessels;

  // If route filter is active, restore full route visualization
  if (currentRouteFilter && vesselsToRender.length > 0) {
    const firstVessel = vesselsToRender[0];

    // Build route from vessel.active_route
    if (firstVessel.status === 'enroute' && firstVessel.active_route?.path) {
      // Handle reversed routes
      const isReversed = firstVessel.active_route.reversed === true;
      const actualOrigin = isReversed
        ? (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination)
        : (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin);
      const actualDestination = isReversed
        ? (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin)
        : (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination);

      const route = {
        path: firstVessel.active_route.path,
        origin: actualOrigin,
        destination: actualDestination
      };

      // Filter ports to show only origin and destination
      const routePorts = filteredPorts.filter(p =>
        p.code === route.origin || p.code === route.destination
      );

      // Render vessels and route ports
      renderVessels(vesselsToRender);
      renderPorts(routePorts);

      // Draw route path (WITHOUT auto-zoom during refresh)
      drawRoute(route, currentPorts, false);

      console.log(`[Harbor Map] Route filter restored during refresh: ${route.origin} → ${route.destination}`);
    } else {
      // No active route available, render normally
      renderVessels(vesselsToRender);
      renderPorts(filteredPorts);
      clearRoute();
    }
  } else {
    // No route filter active
    renderVessels(vesselsToRender);
    renderPorts(filteredPorts);
    clearRoute();
  }

  // Reset selection state
  selectedVesselId = null;
  selectedPortCode = null;

  hideVesselPanel();
  hidePortPanel();
}

/**
 * Loads and renders harbor map overview
 * Fetches ALL data once, then applies filters client-side
 *
 * @returns {Promise<void>}
 * @example
 * await loadOverview();
 */
export async function loadOverview() {
  try {
    // Always use cached data only
    const cachedData = getCachedOverview();

    if (cachedData) {
      console.log('[Harbor Map] Loading from cache (no API call)');

      // Store RAW data (unfiltered)
      rawVessels = cachedData.vessels;
      rawPorts = cachedData.ports;

      // Apply filters client-side
      await applyFiltersAndRender();
      return;
    }

    // No cache available - fetch ALL data once (no filter parameter)
    console.log('[Harbor Map] No cache available, fetching ALL data...');
    const data = await fetchHarborMapOverview('all_ports');

    console.log('[Harbor Map] Overview data:', {
      vessels: data.vessels.length,
      ports: data.ports.length,
      sampleVessel: data.vessels[0]
    });

    // Store RAW data (unfiltered)
    rawVessels = data.vessels;
    rawPorts = data.ports;

    // Apply filters client-side
    await applyFiltersAndRender();
  } catch (error) {
    console.error('Error loading harbor map overview:', error);
  }
}

/**
 * Closes all open panels (vessel, port, route)
 * Ensures only one panel is open at a time
 * @returns {Promise<void>}
 */
export async function closeAllPanels() {
  await closeVesselPanel();
  await closePortPanel();
  await closeRoutePanel();
}

/**
 * Selects a vessel and shows reachable ports
 * Hides other vessels, draws route, shows vessel panel
 *
 * @param {number} vesselId - Vessel ID to select
 * @returns {Promise<void>}
 * @example
 * await selectVessel(1234);
 */
export async function selectVessel(vesselId) {
  try {
    selectedVesselId = vesselId;
    selectedPortCode = null;

    const data = await fetchVesselReachablePorts(vesselId);

    console.log(`[Harbor Map] Vessel ${vesselId} selected:`, {
      reachablePorts: data.reachablePorts.length,
      hasRoute: !!data.route
    });

    // Clear vessel markers (hide all vessels)
    vesselClusterGroup.clearLayers();

    // Render the selected vessel on the map
    if (data.vessel && data.vessel.position) {
      // Get vessel type and create icon (NO rotation for selected vessel)
      const vesselType = getVesselType(data.vessel.capacity_type);
      const icon = createVesselIcon(data.vessel.status, vesselType, 0); // heading = 0 (no rotation)

      // Add offset for vessels in port to prevent overlap with port marker
      let vesselLat = data.vessel.position.lat;
      let vesselLon = data.vessel.position.lon;
      if (data.vessel.status === 'port' || data.vessel.status === 'anchor') {
        vesselLat += 0.003; // ~300m north
        vesselLon += 0.003; // ~300m east
      }

      // Create marker for selected vessel
      const vesselMarker = L.marker([vesselLat, vesselLon], { icon });

      // Bind tooltip
      vesselMarker.bindTooltip(`
        <strong>${data.vessel.name}</strong><br>
        Status: ${data.vessel.status}<br>
        ${data.vessel.eta !== 'N/A' ? `ETA: ${data.vessel.eta}<br>` : ''}
        Cargo: ${data.vessel.formattedCargo || 'N/A'}
      `, {
        direction: 'top',
        offset: [0, -10]
      });

      vesselClusterGroup.addLayer(vesselMarker);
    }

    // If vessel is in port, highlight the current port
    if ((data.vessel.status === 'port' || data.vessel.status === 'anchor') && data.vessel.port_code) {
      console.log('[Harbor Map] Vessel in port, highlighting port:', data.vessel.port_code);

      // Find the port in reachable ports or current ports
      let currentPort = data.reachablePorts.find(p => p.code === data.vessel.port_code);
      if (!currentPort) {
        // Try to find in current ports
        currentPort = currentPorts.find(p => p.code === data.vessel.port_code);
      }

      // If we found the port, make sure it's rendered
      if (currentPort) {
        // Add current port to reachable ports if not already there
        const portExists = data.reachablePorts.some(p => p.code === data.vessel.port_code);
        if (!portExists) {
          data.reachablePorts.unshift(currentPort); // Add at beginning
        }
      }
    }

    // Render only reachable ports (including current port if vessel is in port)
    renderPorts(data.reachablePorts);

    // Draw route if vessel is sailing (without auto-zoom)
    if (data.route) {
      // Prefer assignedPorts (correct demand) over allPorts (no demand for non-assigned)
      const portsForDemand = data.assignedPorts || data.allPorts;
      drawRoute(data.route, portsForDemand, false);
    }

    // Zoom to show route (prioritize route over all ports)
    if (data.route && data.route.path) {
      const bounds = L.latLngBounds();
      data.route.path.forEach(p => bounds.extend([p.lat, p.lon]));

      // Padding: top, right (account for 275px panel), bottom, left
      map.fitBounds(bounds, {
        paddingTopLeft: [50, 50],
        paddingBottomRight: [325, 50] // 275px panel + 50px extra padding
      });
    } else if (data.reachablePorts.length > 0) {
      // Fallback: fit all reachable ports if no route
      const bounds = L.latLngBounds();
      data.reachablePorts.forEach(port => {
        if (port.lat && port.lon) {
          bounds.extend([parseFloat(port.lat), parseFloat(port.lon)]);
        }
      });
      map.fitBounds(bounds, {
        paddingTopLeft: [50, 50],
        paddingBottomRight: [325, 50]
      });
    } else if (data.vessel && data.vessel.position) {
      // Fallback: center on vessel if no route or ports
      map.setView([data.vessel.position.lat, data.vessel.position.lon], map.getZoom(), {
        animate: true,
        duration: 0.5,
        paddingTopLeft: [50, 50],
        paddingBottomRight: [325, 50] // 275px panel + 50px padding
      });
    }

    // Close all panels first, then show vessel panel
    await closeAllPanels();
    showVesselPanel(data.vessel);
  } catch (error) {
    console.error(`Error selecting vessel ${vesselId}:`, error);
  }
}

/**
 * Selects a port and shows categorized vessels
 * Shows port panel with vessels in/to/from port
 *
 * @param {string} portCode - Port code to select
 * @returns {Promise<void>}
 * @example
 * await selectPort('AUBNE');
 */
export async function selectPort(portCode) {
  try {
    console.log(`[Harbor Map] Port ${portCode} clicked`);
    selectedPortCode = portCode;
    selectedVesselId = null;

    const data = await fetchPortDetails(portCode);

    console.log(`[Harbor Map] Port data received:`, {
      port: data.port.code,
      hasDemand: !!data.port.demand,
      vessels: {
        inPort: data.vessels.inPort.length,
        toPort: data.vessels.toPort.length,
        fromPort: data.vessels.fromPort.length
      }
    });

    // Center port in the middle of visible area (left 2/3 not covered by panel)
    if (data.port.lat && data.port.lon) {
      // First zoom to port with panel padding (like routes do)
      map.setView([data.port.lat, data.port.lon], map.getZoom(), {
        animate: true,
        duration: 0.5,
        paddingTopLeft: [50, 50],
        paddingBottomRight: [325, 50] // 275px panel + 50px padding
      });
    }

    // Close all panels first, then show port panel
    await closeAllPanels();
    showPortPanel(data.port, data.vessels);
  } catch (error) {
    console.error(`Error selecting port ${portCode}:`, error);
  }
}

/**
 * Deselects current selection and returns to overview
 *
 * @returns {Promise<void>}
 * @example
 * await deselectAll();
 */
export async function deselectAll() {
  await loadOverview();
}

/**
 * Gets the currently selected port code
 *
 * @returns {string|null} Port code or null if no port selected
 * @example
 * const portCode = getSelectedPortCode();
 */
export function getSelectedPortCode() {
  return selectedPortCode;
}

/**
 * Updates weather data setting and applies changes immediately to the map
 * WITHOUT reloading the entire map
 *
 * @param {boolean} enabled - Whether weather data should be enabled
 * @returns {void}
 */
export function updateWeatherDataSetting(enabled) {
  // This function is called when settings change
  // Weather controls are only initialized/removed on page load (not dynamically)
  // User must reload page for changes to take effect
  console.log('[Harbor Map] Weather data setting updated to:', enabled, '(reload required)');
}

/**
 * Gets a vessel by ID from current vessels cache
 *
 * @param {number} vesselId - Vessel ID to find
 * @returns {Promise<Object|null>} Vessel object or null if not found
 * @example
 * const vessel = await getVesselById(1234);
 */
export async function getVesselById(vesselId, skipCache = false) {
  // If skipCache is false, try to find in current cache first
  if (!skipCache) {
    const cachedVessel = currentVessels.find(v => v.id === vesselId);
    if (cachedVessel) {
      return cachedVessel;
    }
  }

  // Refresh overview from server with cache-busting timestamp
  try {
    const timestamp = Date.now();
    const response = await fetch(window.apiUrl(`/api/harbor-map/overview?filter=${currentFilter}&_=${timestamp}`));

    if (!response.ok) {
      throw new Error(`Failed to fetch harbor map overview: ${response.statusText}`);
    }

    const overview = await response.json();
    currentVessels = overview.vessels || [];
    currentPorts = overview.ports || [];

    console.log(`[Harbor Map] Fetched fresh data from server, found ${currentVessels.length} vessels`);

    return currentVessels.find(v => v.id === vesselId) || null;
  } catch (error) {
    console.error('[Harbor Map] Failed to get vessel by ID:', error);
    return null;
  }
}

/**
 * Updates a single vessel marker on the map without full refresh
 *
 * @param {number} vesselId - Vessel ID to update
 * @returns {Promise<void>}
 * @example
 * await updateVesselMarker(1234);
 */
export async function updateVesselMarker(vesselId) {
  const vessel = await getVesselById(vesselId);
  if (!vessel) {
    console.warn('[Harbor Map] Vessel not found for marker update:', vesselId);
    return;
  }

  // Re-render all vessels to update the marker
  // This keeps the vessel visible on the map with updated status
  renderVessels(currentVessels);
  console.log('[Harbor Map] Vessel marker updated:', vesselId);
}

/**
 * Updates the route dropdown with all unique routes from current vessels
 * Populates the dropdown with route names from vessels with status 'enroute'
 *
 * @returns {void}
 * @example
 * updateRouteDropdown();
 */
function updateRouteDropdown() {
  const routeSelect = document.getElementById('routeFilterSelect');
  if (!routeSelect) {
    console.warn('[Harbor Map] Route filter select not found');
    return;
  }

  // Extract unique route names from vessels with status 'enroute'
  const routes = new Set();
  currentVessels.forEach(vessel => {
    if (vessel.status === 'enroute' && vessel.route_name) {
      routes.add(vessel.route_name);
    }
  });

  // Sort routes alphabetically
  const sortedRoutes = Array.from(routes).sort();

  console.log(`[Harbor Map] Found ${sortedRoutes.length} unique routes`);

  // Clear existing options (except "All Routes")
  routeSelect.innerHTML = '<option value="">All Routes</option>';

  // Add route options
  sortedRoutes.forEach(routeName => {
    const option = document.createElement('option');
    option.value = routeName;
    option.textContent = routeName;
    routeSelect.appendChild(option);
  });

  // Restore selected route if it exists
  if (currentRouteFilter && sortedRoutes.includes(currentRouteFilter)) {
    routeSelect.value = currentRouteFilter;
  } else {
    currentRouteFilter = null;
    routeSelect.value = '';
  }
}

/**
 * Sets the route filter and re-renders map with filtered vessels
 * Also opens the route vessels panel if a route is selected
 * When a route is selected, draws the route path and shows only origin/destination ports
 *
 * @param {string} routeName - Route name to filter by (empty string = all routes)
 * @returns {Promise<void>}
 * @example
 * await setRouteFilter('Hamburg - New York');
 */
async function setRouteFilter(routeName) {
  currentRouteFilter = routeName || null;

  // Save to localStorage
  if (currentRouteFilter) {
    localStorage.setItem('harborMapRouteFilter', currentRouteFilter);
  } else {
    localStorage.removeItem('harborMapRouteFilter');
  }

  console.log(`[Harbor Map] Route filter changed to: ${currentRouteFilter || 'All Routes'}`);

  // Filter vessels
  const vesselsToRender = currentRouteFilter
    ? currentVessels.filter(v => v.route_name === currentRouteFilter)
    : currentVessels;

  console.log(`[Harbor Map] Rendering ${vesselsToRender.length} vessels (filtered by route)`);

  if (currentRouteFilter && vesselsToRender.length > 0) {
    // Close all other panels before showing route panel
    await closeAllPanels();

    // Route selected - extract route from first vessel
    const firstVessel = vesselsToRender[0];

    // Build route from vessel.active_route (same as in vessel click handler)
    if (firstVessel.status === 'enroute' && firstVessel.active_route?.path) {
      // Handle reversed routes
      const isReversed = firstVessel.active_route.reversed === true;
      const actualOrigin = isReversed
        ? (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination)
        : (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin);
      const actualDestination = isReversed
        ? (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin)
        : (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination);

      const route = {
        path: firstVessel.active_route.path,
        origin: actualOrigin,
        destination: actualDestination
      };

      // Filter ports to show only origin and destination
      const routePorts = currentPorts.filter(p =>
        p.code === route.origin || p.code === route.destination
      );

      // Render vessels and route ports
      renderVessels(vesselsToRender);
      renderPorts(routePorts);

      // Draw route path (with auto-zoom)
      drawRoute(route, currentPorts, true);

      console.log(`[Harbor Map] Route drawn: ${route.origin} → ${route.destination}, ${route.path.length} points`);
    } else {
      console.warn('[Harbor Map] No active route available for vessel');
      renderVessels(vesselsToRender);
      renderPorts(currentPorts);
      clearRoute();
    }

    // Show route vessels panel
    showRouteVesselsPanel(currentRouteFilter, vesselsToRender);
  } else {
    // No route selected - show all vessels and ports
    renderVessels(vesselsToRender);
    renderPorts(currentPorts);
    clearRoute();
    hideRouteVesselsPanel();
  }
}

/**
 * Shows the route vessels panel with a list of all vessels on the selected route
 *
 * @param {string} routeName - Name of the route
 * @param {Array<Object>} vessels - Vessels on this route
 * @returns {void}
 */
async function showRouteVesselsPanel(routeName, vessels) {
  const { showRoutePanel } = await import('./route-vessels-panel.js');
  showRoutePanel(routeName, vessels);
}

/**
 * Hides the route vessels panel
 *
 * @returns {void}
 */
async function hideRouteVesselsPanel() {
  const { hideRoutePanel } = await import('./route-vessels-panel.js');
  hideRoutePanel();
}
