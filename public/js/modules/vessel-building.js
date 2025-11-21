/**
 * @fileoverview Vessel Building Module
 *
 * Provides UI for building custom vessels from scratch.
 * Users can select vessel type, capacity, engine, port, and perks.
 * Real-time preview of vessel stats and pricing.
 *
 * @module vessel-building
 */

import { showSideNotification, formatNumber } from './utils.js';
import { showConfirmDialog } from './ui-dialogs.js';
import { getCurrentBunkerState } from './bunker-management.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Available engines for vessel building (from /game/index.json)
 * Stats are based on actual game data for Container vessels
 */
const ENGINES = [
  {
    type: 'mih_x1',
    name: 'MIH X1',
    minKW: 2500,
    maxKW: 11000,
    pricePerKW: 833,
    basePrice: 2082500,
    sortOrder: 1,
    default: true,
    stats: {
      minCapMinKW: { range: 10000, speed: 10 },
      minCapMaxKW: { range: 18000, speed: 34 },
      maxCapMinKW: { range: 741, speed: 28 },
      maxCapMaxKW: { range: 3260, speed: 30 }
    }
  },
  {
    type: 'wartsila_syk_6',
    name: 'Wärtsilä SYK-6',
    minKW: 5000,
    maxKW: 15000,
    pricePerKW: 833,
    basePrice: 4165000,
    sortOrder: 2,
    default: false,
    stats: {
      minCapMinKW: { range: 18000, speed: 17 },
      minCapMaxKW: { range: 18000, speed: 35 },
      maxCapMinKW: { range: 1482, speed: 29 },
      maxCapMaxKW: { range: 4445, speed: 31 }
    }
  },
  {
    type: 'man_p22l',
    name: 'MAN P22L',
    minKW: 8000,
    maxKW: 17500,
    pricePerKW: 833,
    basePrice: 6664000,
    sortOrder: 3,
    default: false,
    stats: {
      minCapMinKW: { range: 18000, speed: 25 },
      minCapMaxKW: { range: 18000, speed: 35 },
      maxCapMinKW: { range: 2371, speed: 29 },
      maxCapMaxKW: { range: 5186, speed: 31 }
    }
  },
  {
    type: 'mih_xp9',
    name: 'MIH XP9',
    minKW: 10000,
    maxKW: 20000,
    pricePerKW: 833,
    basePrice: 8330000,
    sortOrder: 4,
    default: false,
    stats: {
      minCapMinKW: { range: 18000, speed: 31 },
      minCapMaxKW: { range: 18000, speed: 35 },
      maxCapMinKW: { range: 2963, speed: 30 },
      maxCapMaxKW: { range: 5926, speed: 32 }
    }
  },
  {
    type: 'man_p22l_z',
    name: 'MAN P22L-Z',
    minKW: 15000,
    maxKW: 25000,
    pricePerKW: 833,
    basePrice: 12495000,
    sortOrder: 5,
    default: false,
    stats: {
      minCapMinKW: { range: 18000, speed: 35 },
      minCapMaxKW: { range: 18000, speed: 35 },
      maxCapMinKW: { range: 4445, speed: 31 },
      maxCapMaxKW: { range: 7408, speed: 33 }
    }
  },
  {
    type: 'mih_cp9',
    name: 'MIH CP9',
    minKW: 25000,
    maxKW: 60000,
    pricePerKW: 833,
    basePrice: 20825000,
    sortOrder: 6,
    default: false,
    stats: {
      minCapMinKW: { range: 18000, speed: 35 },
      minCapMaxKW: { range: 18000, speed: 35 },
      maxCapMinKW: { range: 7408, speed: 33 },
      maxCapMaxKW: { range: 17778, speed: 35 }
    }
  }
];

/**
 * Shipyard ports where vessels can be delivered
 */
const SHIPYARD_PORTS = [
  { value: 'port_of_botany_sydney', label: 'Australia, Port Of Botany Sydney' },
  { value: 'freeport_container_port', label: 'Bahamas, Freeport Container Port' },
  { value: 'antwerpen', label: 'Belgium, Antwerpen' },
  { value: 'rio_de_janeiro', label: 'Brazil, Rio De Janeiro' },
  { value: 'varna', label: 'Bulgaria, Varna' },
  { value: 'shanghai', label: 'China, Shanghai' },
  { value: 'tianjin_xin_gang', label: 'China, Tianjin Xin Gang' },
  { value: 'port_said', label: 'Egypt, Port Said' },
  { value: 'port_of_le_havre', label: 'France, Port Of Le Havre' },
  { value: 'rade_de_brest', label: 'France, Rade De Brest' },
  { value: 'port_of_piraeus', label: 'Greece, Port Of Piraeus' },
  { value: 'genova', label: 'Italy, Genova' },
  { value: 'napoli', label: 'Italy, Napoli' },
  { value: 'porto_di_lido_venezia', label: 'Italy, Porto Di Lido Venezia' },
  { value: 'nagasaki', label: 'Japan, Nagasaki' },
  { value: 'osaka', label: 'Japan, Osaka' },
  { value: 'bayrut', label: 'Lebanon, Bayrut' },
  { value: 'johor', label: 'Malaysia, Johor' },
  { value: 'veracruz', label: 'Mexico, Veracruz' },
  { value: 'auckland', label: 'New zealand, Auckland' },
  { value: 'gdansk', label: 'Poland, Gdansk' },
  { value: 'lisboa', label: 'Portugal, Lisboa' },
  { value: 'port_of_singapore', label: 'Singapore, Port Of Singapore' },
  { value: 'cape_town', label: 'South africa, Cape Town' },
  { value: 'durban', label: 'South africa, Durban' },
  { value: 'pusan', label: 'South Korea, Pusan' },
  { value: 'stockholm_norvik', label: 'Sweden, Stockholm Norvik' },
  { value: 'chi_lung', label: 'Taiwan, Chi Lung' },
  { value: 'belfast', label: 'United kingdom, Belfast' },
  { value: 'southampton', label: 'United kingdom, Southampton' },
  { value: 'baltimore', label: 'United states, Baltimore' },
  { value: 'boston_us', label: 'United states, Boston Us' },
  { value: 'mobile', label: 'United states, Mobile' },
  { value: 'oakland', label: 'United states, Oakland' },
  { value: 'philadelphia', label: 'United states, Philadelphia' }
];

/**
 * Capacity ranges for vessel types
 */
const CAPACITY_RANGES = {
  container: {
    min: 2000,
    max: 27000,
    unit: 'TEU',
    stats: {
      minRange: 10000,
      maxRange: 742,
      minSpeed: 10,
      maxSpeed: 28,
      minFuel: 158,
      maxFuel: 3562,
      minCO2: 1.87,
      maxCO2: 0.20
    },
    price: {
      min: 17800000,
      max: 240300000
    },
    buildTime: {
      min: 24000,
      max: 172800
    }
  },
  tanker: {
    min: 148000,
    max: 1998000,
    unit: 'BBL',
    stats: {
      minRange: 10000,
      maxRange: 742,
      minSpeed: 10,
      maxSpeed: 28,
      minFuel: 157,
      maxFuel: 3537,
      minCO2: 1.90,
      maxCO2: 0.67
    },
    price: {
      min: 17800000,
      max: 240300000
    },
    buildTime: {
      min: 24000,
      max: 172800
    }
  }
};

/**
 * Vessel perks and their effects (from /game/index.json)
 */
const PERKS = {
  antifouling: {
    type_a: {
      name: 'Type A',
      co2: -0.10,
      fuel: 0.01,
      priceFactor: 0.021,
      buildTime: 500
    },
    type_b: {
      name: 'Type B',
      co2: 0.10,
      fuel: -0.01,
      priceFactor: 0.021,
      buildTime: 500
    }
  },
  bulbous: {
    name: 'Bulbous Bow',
    co2: -0.03,
    fuel: -0.03,
    priceFactor: 0.082,
    buildTime: 800
  },
  propellers: {
    '4_blade_propeller': {
      name: '4 Blades',
      speed: 0,
      priceFactor: 0
    },
    '5_blade_propeller': {
      name: '5 Blades',
      speed: 0.08,
      priceFactor: 0.038
    },
    '6_blade_propeller': {
      name: '6 Blades',
      speed: 0.12,
      priceFactor: 0.076
    }
  },
  enhanced_thrusters: {
    name: 'Enhanced Thrusters',
    fuel: 0.01,
    price: 140,
    channelWait: 0.96,
    dockTime: 0.9
  }
};

// ============================================================================
// STATE
// ============================================================================

const buildState = {
  currentStep: 1,
  vesselType: 'container',
  capacity: 2000,
  port: null,
  engine: null,
  engineKW: null,
  antifouling: null,
  bulbous: false,
  propellers: '4_blade_propeller',
  enhancedThrusters: false,
  vesselName: '',
  hullColor: '#b30000',
  deckColor: '#272525',
  bridgeColor: '#dbdbdb',
  containerColor1: '#ff8000',
  containerColor2: '#0000ff',
  containerColor3: '#670000',
  containerColor4: '#777777',
  nameColor: '#ffffff'
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Linear interpolation between two values
 * @param {number} value - Current value
 * @param {number} minVal - Minimum input value
 * @param {number} maxVal - Maximum input value
 * @param {number} minResult - Minimum output value
 * @param {number} maxResult - Maximum output value
 * @returns {number} Interpolated result
 */
function interpolate(value, minVal, maxVal, minResult, maxResult) {
  if (maxVal === minVal) return minResult;
  const ratio = (value - minVal) / (maxVal - minVal);
  return minResult + ratio * (maxResult - minResult);
}

/**
 * Calculate base vessel stats based on type and capacity
 * @param {string} vesselType - 'container' or 'tanker'
 * @param {number} capacity - Vessel capacity
 * @returns {Object} Base stats (range, speed, fuel, co2, buildTime)
 */
function calculateBaseStats(vesselType, capacity) {
  const config = CAPACITY_RANGES[vesselType];

  const range = interpolate(capacity, config.min, config.max, config.stats.minRange, config.stats.maxRange);
  const speed = interpolate(capacity, config.min, config.max, config.stats.minSpeed, config.stats.maxSpeed);
  const fuel = interpolate(capacity, config.min, config.max, config.stats.minFuel, config.stats.maxFuel);
  const co2 = interpolate(capacity, config.min, config.max, config.stats.minCO2, config.stats.maxCO2);
  const buildTime = interpolate(capacity, config.min, config.max, config.buildTime.min, config.buildTime.max);

  return { range, speed, fuel, co2, buildTime };
}

/**
 * Apply perk multipliers to base stats
 * @param {Object} stats - Base stats
 * @param {Object} state - Current build state
 * @returns {Object} Modified stats
 */
function applyPerkEffects(stats, state) {
  let { range, speed, fuel, co2, buildTime } = { ...stats };

  if (state.antifouling) {
    const perk = PERKS.antifouling[state.antifouling];
    co2 *= (1 + perk.co2);
    fuel *= (1 + perk.fuel);
    buildTime += perk.buildTime;
  }

  if (state.bulbous) {
    co2 *= (1 + PERKS.bulbous.co2);
    fuel *= (1 + PERKS.bulbous.fuel);
    buildTime += PERKS.bulbous.buildTime;
  }

  const propellerPerk = PERKS.propellers[state.propellers];
  speed *= (1 + propellerPerk.speed);

  if (state.enhancedThrusters) {
    fuel *= (1 + PERKS.enhanced_thrusters.fuel);
  }

  return { range, speed, fuel, co2, buildTime };
}

/**
 * Calculate total vessel price
 * @param {Object} state - Current build state
 * @returns {number} Total price in dollars
 */
function calculatePrice(state) {
  if (!state.vesselType || !state.capacity) return 0;

  const config = CAPACITY_RANGES[state.vesselType];

  const basePrice = interpolate(
    state.capacity,
    config.min,
    config.max,
    config.price.min,
    config.price.max
  );

  let enginePrice = 0;

  if (state.currentStep >= 2 && state.engine && state.engineKW) {
    const selectedEngine = ENGINES.find(e => e.type === state.engine);
    const extraKW = state.engineKW - selectedEngine.minKW;
    enginePrice = selectedEngine.basePrice + (extraKW * selectedEngine.pricePerKW);
  }

  const vesselPrice = basePrice + enginePrice;

  if (state.currentStep < 3) {
    return vesselPrice;
  }

  let perkFactor = 0;

  if (state.antifouling) {
    perkFactor += PERKS.antifouling[state.antifouling].priceFactor;
  }

  if (state.bulbous) {
    perkFactor += PERKS.bulbous.priceFactor;
  }

  const propellerPerk = PERKS.propellers[state.propellers];
  perkFactor += propellerPerk.priceFactor;

  const perkCosts = vesselPrice * perkFactor;
  const totalPrice = vesselPrice + perkCosts;

  if (state.enhancedThrusters) {
    return totalPrice + (state.capacity * PERKS.enhanced_thrusters.price);
  }

  return totalPrice;
}

/**
 * Format build time from seconds to readable string
 * @param {number} seconds - Build time in seconds
 * @returns {string} Formatted time (e.g., "6h 40m")
 */
function formatBuildTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Bilinear interpolation for engine stats
 * @param {Object} engine - Engine object with stats
 * @param {number} capacity - Vessel capacity
 * @param {number} engineKW - Engine power in kW
 * @param {string} stat - 'speed' or 'range'
 * @returns {number} Interpolated stat value
 */
function bilinearInterpolate(engine, capacity, engineKW, stat, vesselType) {
  const containerConfig = CAPACITY_RANGES.container;
  const currentConfig = CAPACITY_RANGES[vesselType];

  const containerMinCap = containerConfig.min;
  const containerMaxCap = containerConfig.max;

  const normalizedCap = (capacity - currentConfig.min) / (currentConfig.max - currentConfig.min);
  const interpolatedCap = containerMinCap + normalizedCap * (containerMaxCap - containerMinCap);

  const minKW = engine.minKW;
  const maxKW = engine.maxKW;

  const v1 = engine.stats.minCapMinKW[stat];
  const v2 = engine.stats.minCapMaxKW[stat];
  const v3 = engine.stats.maxCapMinKW[stat];
  const v4 = engine.stats.maxCapMaxKW[stat];

  const capRatio = (interpolatedCap - containerMinCap) / (containerMaxCap - containerMinCap);
  const kwRatio = (engineKW - minKW) / (maxKW - minKW);

  const interpAtMinCap = v1 + (v2 - v1) * kwRatio;
  const interpAtMaxCap = v3 + (v4 - v3) * kwRatio;

  return interpAtMinCap + (interpAtMaxCap - interpAtMinCap) * capRatio;
}

/**
 * Calculate speed for a given engine KW
 * @param {number} capacity - Vessel capacity
 * @param {string} vesselType - 'container' or 'tanker'
 * @param {number} engineKW - Engine power in kW
 * @param {string} engineType - Engine type (e.g., 'mih_x1')
 * @returns {number} Speed in knots
 */
function calculateSpeedForEngine(capacity, vesselType, engineKW, engineType) {
  if (!engineType) return 0;
  const engine = ENGINES.find(e => e.type === engineType);
  if (!engine) return 0;
  return bilinearInterpolate(engine, capacity, engineKW, 'speed', vesselType);
}

/**
 * Calculate range for a given engine KW
 * @param {number} capacity - Vessel capacity
 * @param {string} vesselType - 'container' or 'tanker'
 * @param {number} engineKW - Engine power in kW
 * @param {string} engineType - Engine type (e.g., 'mih_x1')
 * @returns {number} Range in nautical miles
 */
function calculateRangeForEngine(capacity, vesselType, engineKW, engineType) {
  if (!engineType) return 0;
  const engine = ENGINES.find(e => e.type === engineType);
  if (!engine) return 0;
  return bilinearInterpolate(engine, capacity, engineKW, 'range', vesselType);
}

/**
 * Update stats preview panel
 */
function updateStatsPreview() {
  document.getElementById('previewType').textContent = buildState.vesselType ? (buildState.vesselType === 'container' ? 'Container' : 'Tanker') : '-';

  const portLabel = buildState.port ? SHIPYARD_PORTS.find(p => p.value === buildState.port)?.label || buildState.port : '-';
  document.getElementById('previewPort').textContent = portLabel;

  const engineLabel = buildState.engine ? ENGINES.find(e => e.type === buildState.engine)?.name || buildState.engine : '-';
  const engineKW = buildState.engineKW ? ` (${formatNumber(buildState.engineKW)} kW)` : '';
  document.getElementById('previewEngine').textContent = buildState.engine ? `${engineLabel}${engineKW}` : '-';

  const perksList = [];
  if (buildState.antifouling) {
    const perkName = buildState.antifouling === 'type_a' ? 'Antifouling A' : 'Antifouling B';
    perksList.push(perkName);
  }
  if (buildState.bulbous) {
    perksList.push('Bulbous Bow');
  }
  if (buildState.propellers && buildState.propellers !== '4_blade') {
    const propPerk = PERKS.propellers[buildState.propellers];
    perksList.push(propPerk.name);
  }
  document.getElementById('previewPerks').textContent = perksList.length > 0 ? perksList.join(', ') : 'None';

  if (!buildState.vesselType) {
    document.getElementById('previewCapacity').textContent = '-';
    document.getElementById('previewRange').textContent = '-';
    document.getElementById('previewSpeed').textContent = '-';
    document.getElementById('previewFuel').textContent = '-';
    document.getElementById('previewCO2').textContent = '-';
    document.getElementById('previewBuildTime').textContent = '-';
    document.getElementById('previewPrice').textContent = '$0';
    return;
  }

  if (!buildState.capacity) {
    const config = CAPACITY_RANGES[buildState.vesselType];
    buildState.capacity = config.min;
  }

  let range, speed, fuel, co2, buildTime;

  if (buildState.currentStep >= 2 && buildState.engine && buildState.engineKW) {
    range = calculateRangeForEngine(buildState.capacity, buildState.vesselType, buildState.engineKW, buildState.engine);
    speed = calculateSpeedForEngine(buildState.capacity, buildState.vesselType, buildState.engineKW, buildState.engine);
    const baseStats = calculateBaseStats(buildState.vesselType, buildState.capacity);
    fuel = baseStats.fuel;
    co2 = baseStats.co2;
    buildTime = baseStats.buildTime;

    if (buildState.currentStep >= 3) {
      const perkStats = applyPerkEffects({ range, speed, fuel, co2, buildTime }, buildState);
      range = perkStats.range;
      speed = perkStats.speed;
      fuel = perkStats.fuel;
      co2 = perkStats.co2;
      buildTime = perkStats.buildTime;
    }
  } else {
    const baseStats = calculateBaseStats(buildState.vesselType, buildState.capacity);
    const stats = applyPerkEffects(baseStats, buildState);
    range = stats.range;
    speed = stats.speed;
    fuel = stats.fuel;
    co2 = stats.co2;
    buildTime = stats.buildTime;
  }

  const price = calculatePrice(buildState);

  const config = CAPACITY_RANGES[buildState.vesselType];
  const unit = config.unit === 'TEU' ? 'TEU' : 'BBL';
  const co2Unit = config.unit === 'TEU' ? 'kg/TEU/nm' : 'kg/100bbl/nm';

  document.getElementById('previewCapacity').textContent = `${formatNumber(buildState.capacity)} ${unit}`;
  document.getElementById('previewRange').textContent = `${Math.round(range)} nm`;
  document.getElementById('previewSpeed').textContent = `${Math.round(speed)} kn`;
  document.getElementById('previewFuel').textContent = `${Math.round(fuel)} kg/nm`;
  document.getElementById('previewCO2').textContent = `${co2.toFixed(2)} ${co2Unit}`;
  document.getElementById('previewBuildTime').textContent = formatBuildTime(Math.round(buildTime));
  document.getElementById('previewPrice').textContent = `$${formatNumber(Math.round(price))}`;

  // Disable submit button if not enough cash
  const submitBtn = document.getElementById('buildSubmitBtn');
  if (submitBtn) {
    const bunkerState = getCurrentBunkerState();
    const currentCash = bunkerState?.currentCash || 0;
    const canAfford = currentCash >= Math.round(price);
    submitBtn.disabled = !canAfford;
    submitBtn.title = canAfford ? '' : `Not enough cash. Need $${formatNumber(Math.round(price))}, have $${formatNumber(currentCash)}`;
  }
}

// ============================================================================
// WIZARD STEP FUNCTIONS
// ============================================================================

/**
 * Render Step 1: Basics (Type, Port, Name)
 */
function renderStep1() {
  const config = buildState.vesselType ? CAPACITY_RANGES[buildState.vesselType] : CAPACITY_RANGES.container;
  if (!buildState.capacity && buildState.vesselType) {
    buildState.capacity = config.min;
  }

  const content = document.getElementById('buildStepContent');
  content.innerHTML = `
    <div class="build-step-container">
      <div class="basics-section">
        <label class="basics-label">Vessel Type</label>
        <div class="vessel-type-options">
          <label class="vessel-type-option ${buildState.vesselType === 'container' ? 'selected' : ''}">
            <input type="radio" name="vesselType" value="container" ${buildState.vesselType === 'container' ? 'checked' : ''}>
            <div class="type-card-horizontal">
              <div class="type-icon">📦</div>
              <div class="type-name">Container</div>
              <div class="type-info">2,000 - 27,000 TEU</div>
            </div>
          </label>
          <label class="vessel-type-option ${buildState.vesselType === 'tanker' ? 'selected' : ''}">
            <input type="radio" name="vesselType" value="tanker" ${buildState.vesselType === 'tanker' ? 'checked' : ''}>
            <div class="type-card-horizontal">
              <div class="type-icon">🛢️</div>
              <div class="type-name">Tanker</div>
              <div class="type-info">148,000 - 1,998,000 BBL</div>
            </div>
          </label>
        </div>
      </div>

      <div class="basics-section capacity-section">
        <div class="capacity-header">
          <label class="basics-label">Capacity</label>
        </div>
        <div class="capacity-slider-container">
          <input type="range" id="capacitySlider" min="${config.min}" max="${config.max}" value="${buildState.capacity || config.min}" step="${config.min < 10000 ? 100 : 1000}" ${!buildState.vesselType ? 'disabled' : ''}>
          <div class="slider-labels">
            <span>${formatNumber(config.min)} ${config.unit}</span>
            <span>${formatNumber(config.max)} ${config.unit}</span>
          </div>
        </div>
      </div>

      <div class="basics-section">
        <label class="basics-label" for="portSelect">Delivery Port</label>
        <select id="portSelect" class="build-select">
          <option value="" ${!buildState.port ? 'selected' : ''}>-- Select Port --</option>
          ${SHIPYARD_PORTS.map(port =>
            `<option value="${port.value}" ${buildState.port === port.value ? 'selected' : ''}>${port.label}</option>`
          ).join('')}
        </select>
      </div>

      <div class="basics-section">
        <label class="basics-label" for="vesselNameInput">Vessel Name</label>
        <input type="text" id="vesselNameInput" class="build-input" placeholder="Enter vessel name..." value="${buildState.vesselName || ''}" maxlength="50">
      </div>
    </div>
  `;

  const radios = content.querySelectorAll('input[name="vesselType"]');
  radios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      buildState.vesselType = e.target.value;

      const config = CAPACITY_RANGES[buildState.vesselType];
      buildState.capacity = config.min;

      content.querySelectorAll('.vessel-type-option').forEach(opt => opt.classList.remove('selected'));
      e.target.closest('.vessel-type-option').classList.add('selected');

      updateStatsPreview();
      renderStep1();
    });
  });

  const capacitySlider = content.querySelector('#capacitySlider');
  if (capacitySlider) {
    capacitySlider.addEventListener('input', (e) => {
      buildState.capacity = parseInt(e.target.value);
      updateStatsPreview();
    });
  }

  const portSelect = content.querySelector('#portSelect');
  portSelect.addEventListener('change', (e) => {
    buildState.port = e.target.value;
    updateStatsPreview();
  });

  const nameInput = content.querySelector('#vesselNameInput');
  nameInput.addEventListener('input', (e) => {
    buildState.vesselName = e.target.value;
  });

  updateStatsPreview();
}

/**
 * Render Step 3: Engine Selection
 */
function renderStep3() {
  if (!buildState.engine) {
    const defaultEngine = ENGINES.find(e => e.default);
    buildState.engine = defaultEngine.type;
    buildState.engineKW = defaultEngine.minKW;
  }

  const selectedEngine = ENGINES.find(e => e.type === buildState.engine);

  if (!buildState.engineKW || buildState.engineKW < selectedEngine.minKW) {
    buildState.engineKW = selectedEngine.minKW;
  }

  const content = document.getElementById('buildStepContent');
  content.innerHTML = `
    <div class="build-step-container">
      <div class="engine-selection">
        ${ENGINES.map(engine => {
          const minSpeed = calculateSpeedForEngine(buildState.capacity, buildState.vesselType, engine.minKW, engine.type);
          const maxSpeed = calculateSpeedForEngine(buildState.capacity, buildState.vesselType, engine.maxKW, engine.type);

          return `
          <div class="engine-card ${buildState.engine === engine.type ? 'selected' : ''}" data-engine="${engine.type}">
            <div class="engine-name">${engine.name}</div>
            <div class="engine-price">+$${formatNumber(engine.basePrice)}</div>
            <div class="engine-stat">Speed: ${minSpeed.toFixed(1)} - ${maxSpeed.toFixed(1)} kn</div>
            <div class="engine-specs">${engine.minKW.toLocaleString()} - ${engine.maxKW.toLocaleString()} kW</div>
          </div>
          `;
        }).join('')}
      </div>
      <div class="engine-kw-slider">
        <label for="engineKWSlider">Engine Power: <span id="kwValue">${formatNumber(buildState.engineKW)}</span> kW</label>
        <input type="range" id="engineKWSlider" min="${selectedEngine.minKW}" max="${selectedEngine.maxKW}" value="${buildState.engineKW}" step="100">
      </div>
    </div>
  `;

  const engineCards = content.querySelectorAll('.engine-card');
  engineCards.forEach(card => {
    card.addEventListener('click', () => {
      const engineType = card.dataset.engine;
      buildState.engine = engineType;
      const newEngine = ENGINES.find(eng => eng.type === engineType);
      buildState.engineKW = newEngine.minKW;

      content.querySelectorAll('.engine-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');

      const kwSlider = content.querySelector('#engineKWSlider');
      const kwValue = content.querySelector('#kwValue');
      kwSlider.min = newEngine.minKW;
      kwSlider.max = newEngine.maxKW;
      kwSlider.value = newEngine.minKW;
      kwValue.textContent = formatNumber(newEngine.minKW);

      updateStatsPreview();
    });
  });

  const kwSlider = content.querySelector('#engineKWSlider');
  const kwValue = content.querySelector('#kwValue');
  kwSlider.addEventListener('input', (e) => {
    buildState.engineKW = parseInt(e.target.value);
    kwValue.textContent = formatNumber(buildState.engineKW);
    updateStatsPreview();
  });

  updateStatsPreview();
}

/**
 * Render Step 4: Perks Selection
 */
function renderStep4() {
  const config = CAPACITY_RANGES[buildState.vesselType];
  const basePrice = interpolate(
    buildState.capacity,
    config.min,
    config.max,
    config.price.min,
    config.price.max
  );

  const content = document.getElementById('buildStepContent');
  content.innerHTML = `
    <div class="build-step-container">
      <div class="perk-list">
        <label class="perk-option ${!buildState.antifouling ? 'selected' : ''}">
          <input type="radio" name="antifouling" value="" ${!buildState.antifouling ? 'checked' : ''}>
          <div class="perk-card">
            <div class="perk-name">Antifouling: None</div>
            <div class="perk-price">$0</div>
            <div class="perk-effect">No effect</div>
          </div>
        </label>
        <label class="perk-option ${buildState.antifouling === 'type_a' ? 'selected' : ''}">
          <input type="radio" name="antifouling" value="type_a" ${buildState.antifouling === 'type_a' ? 'checked' : ''}>
          <div class="perk-card">
            <div class="perk-name">Antifouling: Type A</div>
            <div class="perk-price">+$${formatNumber(Math.round(basePrice * PERKS.antifouling.type_a.priceFactor))}</div>
            <div class="perk-effect">-10% CO2, +1% Fuel</div>
          </div>
        </label>
        <label class="perk-option ${buildState.antifouling === 'type_b' ? 'selected' : ''}">
          <input type="radio" name="antifouling" value="type_b" ${buildState.antifouling === 'type_b' ? 'checked' : ''}>
          <div class="perk-card">
            <div class="perk-name">Antifouling: Type B</div>
            <div class="perk-price">+$${formatNumber(Math.round(basePrice * PERKS.antifouling.type_b.priceFactor))}</div>
            <div class="perk-effect">+10% CO2, -1% Fuel</div>
          </div>
        </label>
        <label class="perk-checkbox ${buildState.bulbous ? 'selected' : ''}">
          <input type="checkbox" id="bulbousCheck" ${buildState.bulbous ? 'checked' : ''}>
          <div class="perk-card">
            <div class="perk-name">Bulbous Bow</div>
            <div class="perk-price">+$${formatNumber(Math.round(basePrice * PERKS.bulbous.priceFactor))}</div>
            <div class="perk-effect">-3% CO2, -3% Fuel</div>
          </div>
        </label>
        ${Object.entries(PERKS.propellers).map(([key, perk]) => {
          const perkPrice = Math.round(basePrice * perk.priceFactor);
          return `
          <label class="perk-option ${buildState.propellers === key ? 'selected' : ''}">
            <input type="radio" name="propellers" value="${key}" ${buildState.propellers === key ? 'checked' : ''}>
            <div class="perk-card">
              <div class="perk-name">Propellers: ${perk.name}</div>
              <div class="perk-price">${perkPrice > 0 ? '+$' + formatNumber(perkPrice) : '$0'}</div>
              <div class="perk-effect">${perk.speed > 0 ? '+' + Math.round(perk.speed * 100) + '% Speed' : 'Default'}</div>
            </div>
          </label>
          `;
        }).join('')}
      </div>
    </div>
  `;

  const antifoulingRadios = content.querySelectorAll('input[name="antifouling"]');
  antifoulingRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      buildState.antifouling = e.target.value || null;
      content.querySelectorAll('input[name="antifouling"]').forEach(r => {
        r.closest('.perk-option').classList.toggle('selected', r.checked);
      });
      updateStatsPreview();
    });
  });

  const bulbousCheck = content.querySelector('#bulbousCheck');
  bulbousCheck.addEventListener('change', (e) => {
    buildState.bulbous = e.target.checked;
    e.target.closest('.perk-checkbox').classList.toggle('selected', e.target.checked);
    updateStatsPreview();
  });

  const propellerRadios = content.querySelectorAll('input[name="propellers"]');
  propellerRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      buildState.propellers = e.target.value;
      content.querySelectorAll('input[name="propellers"]').forEach(r => {
        r.closest('.perk-option').classList.toggle('selected', r.checked);
      });
      updateStatsPreview();
    });
  });

  updateStatsPreview();
}

/**
 * Render Step 5: Appearance Customization
 */
function renderStep5() {
  const content = document.getElementById('buildStepContent');
  content.innerHTML = `
    <div class="build-step-container">
      <div class="appearance-section">
        <div class="svg-preview-container">
          <div id="vesselSvgPreview"></div>
        </div>
        <div class="color-controls-grid">
          <div class="color-control">
            <label>Hull</label>
            <input type="color" id="hullColor" value="${buildState.hullColor}">
          </div>
          <div class="color-control">
            <label>Deck</label>
            <input type="color" id="deckColor" value="${buildState.deckColor}">
          </div>
          <div class="color-control">
            <label>Bridge</label>
            <input type="color" id="bridgeColor" value="${buildState.bridgeColor}">
          </div>
          <div class="color-control">
            <label>Cargo 1</label>
            <input type="color" id="containerColor1" value="${buildState.containerColor1}">
          </div>
          <div class="color-control">
            <label>Cargo 2</label>
            <input type="color" id="containerColor2" value="${buildState.containerColor2}">
          </div>
          <div class="color-control">
            <label>Cargo 3</label>
            <input type="color" id="containerColor3" value="${buildState.containerColor3}">
          </div>
          <div class="color-control">
            <label>Cargo 4</label>
            <input type="color" id="containerColor4" value="${buildState.containerColor4}">
          </div>
          <div class="color-control">
            <label>Name</label>
            <input type="color" id="nameColor" value="${buildState.nameColor}">
          </div>
        </div>
      </div>
    </div>
  `;

  const colorInputs = {
    hullColor: content.querySelector('#hullColor'),
    deckColor: content.querySelector('#deckColor'),
    bridgeColor: content.querySelector('#bridgeColor'),
    containerColor1: content.querySelector('#containerColor1'),
    containerColor2: content.querySelector('#containerColor2'),
    containerColor3: content.querySelector('#containerColor3'),
    containerColor4: content.querySelector('#containerColor4'),
    nameColor: content.querySelector('#nameColor')
  };

  Object.entries(colorInputs).forEach(([key, input]) => {
    input.addEventListener('input', (e) => {
      buildState[key] = e.target.value;
      updateSvgPreview();
    });
  });

  updateSvgPreview();
}

/**
 * Update SVG preview
 */
async function updateSvgPreview() {
  const container = document.getElementById('vesselSvgPreview');
  if (!container) return;

  const svg = await generateVesselSvg(buildState);
  container.innerHTML = svg;
}

/**
 * Shade a color by a percentage
 */
function shadeColor(color, percent) {
  const num = parseInt(color.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, Math.min(255, (num >> 16) + amt));
  const G = Math.max(0, Math.min(255, (num >> 8 & 0x00FF) + amt));
  const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
  return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

/**
 * Generate vessel SVG based on current state
 */
async function generateVesselSvg(state) {
  if (state.vesselType === 'container') {
    return await generateContainerSvg(state);
  } else {
    return await generateTankerSvg(state);
  }
}

/**
 * Generate container ship SVG preview
 * Loads the professional SVG template and applies colors
 * Container count reflects capacity - ship size stays constant
 */
async function generateContainerSvg(state) {
  try {
    const response = await fetch('/images/vessels/custom_cargo_vessel.svg');
    let svg = await response.text();

    const capacity = state.capacity || 2000;
    const minCapacity = 2000;
    const maxCapacity = 27000;
    const capacityRatio = (capacity - minCapacity) / (maxCapacity - minCapacity);

    const hullColor = state.hullColor || '#b30000';
    const deckColor = state.deckColor || '#272525';
    const bridgeColor = state.bridgeColor || '#dbdbdb';
    const containerColor1 = state.containerColor1 || '#ff8000';
    const containerColor2 = state.containerColor2 || '#0000ff';
    const containerColor3 = state.containerColor3 || '#670000';
    const containerColor4 = state.containerColor4 || '#777777';
    const nameColor = state.nameColor || '#ffffff';
    const vesselName = state.vesselName || 'Custom Vessel';

    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
    const svgElement = svgDoc.documentElement;

    // Container stacks - each array is a column, ordered from TOP to BOTTOM (top first to remove)
    // Lower Y value = higher on screen = top of stack
    // Y coordinates verified from SVG source
    const containerStacks = [
      // Stack 1 (X~876, near bridge): 090-095
      ['dp_path095', 'dp_path094', 'dp_path093', 'dp_path092', 'dp_path091', 'dp_path090'],
      // Stack 2 (X~910): 097-102
      ['dp_path102', 'dp_path101', 'dp_path100', 'dp_path099', 'dp_path098', 'dp_path097'],
      // Stack 3 (X~945): 103-108
      ['dp_path108', 'dp_path107', 'dp_path106', 'dp_path105', 'dp_path104', 'dp_path103'],
      // Stack 4 (X~1014): 109-112
      ['dp_path112', 'dp_path111', 'dp_path110', 'dp_path109'],
      // Stack 5a (X~713): 113-115
      ['dp_path115', 'dp_path114', 'dp_path113'],
      // Stack 5b (X~747): 116-118
      ['dp_path118', 'dp_path117', 'dp_path116'],
      // Stack 6 (X~649): 119-124
      ['dp_path124', 'dp_path123', 'dp_path122', 'dp_path121', 'dp_path120', 'dp_path119'],
      // Stack 7 (X~578): 125-129
      ['dp_path129', 'dp_path128', 'dp_path127', 'dp_path126', 'dp_path125'],
      // Stack 8 (X~510): 130-134
      ['dp_path134', 'dp_path133', 'dp_path132', 'dp_path131', 'dp_path130'],
      // Stack 9 (X~437): 135-139 - NOTE: 135 is at TOP (Y=343), 136 is at BOTTOM (Y=397)
      ['dp_path135', 'dp_path139', 'dp_path138', 'dp_path137', 'dp_path136'],
      // Stack 10 (X~370): 140-144
      ['dp_path144', 'dp_path143', 'dp_path142', 'dp_path141', 'dp_path140'],
      // Stack 11 (X~297): 145-149
      ['dp_path149', 'dp_path148', 'dp_path147', 'dp_path146', 'dp_path145'],
      // Stack 12 (X~230): 150-153
      ['dp_path153', 'dp_path152', 'dp_path151', 'dp_path150'],
      // Stack 13a (X~158): 154-156
      ['dp_path156', 'dp_path155', 'dp_path154'],
      // Stack 13b (X~190): 157-159
      ['dp_path159', 'dp_path158', 'dp_path157']
    ];

    // Calculate how many containers to show based on capacity
    const totalContainers = containerStacks.flat().length;
    const containersToShow = Math.floor(totalContainers * (0.3 + capacityRatio * 0.7));
    const containersToRemove = totalContainers - containersToShow;

    // Remove containers from top of each stack, cycling through stacks
    let removed = 0;
    let stackIndex = 0;
    const stackPointers = containerStacks.map(() => 0);

    while (removed < containersToRemove) {
      const stack = containerStacks[stackIndex];
      const pointer = stackPointers[stackIndex];

      if (pointer < stack.length) {
        const id = stack[pointer];
        const element = svgDoc.getElementById(id);
        if (element) element.remove();
        stackPointers[stackIndex]++;
        removed++;
      }

      stackIndex = (stackIndex + 1) % containerStacks.length;
    }

    // Remove the main container shadow path when containers are removed
    if (containersToRemove > 0) {
      const shadowPath = svgDoc.getElementById('dp_path002');
      if (shadowPath) shadowPath.remove();
    }

    // Calculate display parameters
    const originalShipWidth = 1019;
    const originalShipHeight = 202;

    const viewBoxWidth = 750;
    const viewBoxHeight = 280;
    const waterLevel = viewBoxHeight * 0.75;

    // Scale to fit
    const displayScale = (viewBoxWidth - 60) / originalShipWidth;

    const originalShipMinY = 271.17;
    const originalShipMinX = 56.779;
    const shipCenterX = originalShipMinX + originalShipWidth / 2;

    const targetShipCenterX = viewBoxWidth / 2;
    const targetShipBottomY = waterLevel + (originalShipHeight * displayScale) * 0.15;

    const newTranslateX = targetShipCenterX - (shipCenterX * displayScale);
    const newTranslateY = targetShipBottomY - ((originalShipMinY + originalShipHeight) * displayScale);

    svgElement.setAttribute('viewBox', `0 0 ${viewBoxWidth} ${viewBoxHeight}`);
    svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Apply transform to main group
    const mainGroup = svgElement.querySelector('#dp_group001');
    if (mainGroup) {
      mainGroup.setAttribute('transform', `translate(${newTranslateX}, ${newTranslateY}) scale(${displayScale})`);
    }

    // Add background elements
    const bgDefs = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'defs');
    bgDefs.innerHTML = `
      <linearGradient id="bgSkyGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#4a90d9;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#87ceeb;stop-opacity:1" />
      </linearGradient>
      <linearGradient id="bgWaterGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#1e5a8e;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#0d3a5f;stop-opacity:1" />
      </linearGradient>
    `;
    svgElement.insertBefore(bgDefs, svgElement.firstChild);

    const sky = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    sky.setAttribute('x', '-5%');
    sky.setAttribute('width', '120%');
    sky.setAttribute('height', waterLevel);
    sky.setAttribute('fill', 'url(#bgSkyGradient)');

    const water = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    water.setAttribute('x', '-5%');
    water.setAttribute('y', waterLevel);
    water.setAttribute('width', '120%');
    water.setAttribute('height', viewBoxHeight - waterLevel);
    water.setAttribute('fill', 'url(#bgWaterGradient)');

    const waves = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'path');
    waves.setAttribute('d', `M 0 ${waterLevel} Q 30 ${waterLevel - 5} 60 ${waterLevel} T 120 ${waterLevel} T 180 ${waterLevel} T 240 ${waterLevel} T 300 ${waterLevel} T 360 ${waterLevel} T 420 ${waterLevel} T 480 ${waterLevel} T 540 ${waterLevel} T 600 ${waterLevel} T 660 ${waterLevel} T 720 ${waterLevel} T 780 ${waterLevel}`);
    waves.setAttribute('stroke', '#5dade2');
    waves.setAttribute('stroke-width', '3');
    waves.setAttribute('fill', 'none');
    waves.setAttribute('opacity', '0.6');

    if (mainGroup) {
      svgElement.insertBefore(waves, mainGroup);
      svgElement.insertBefore(water, waves);
      svgElement.insertBefore(sky, water);
    }

    // Remove the old ship name paths (dp_path177-186)
    for (let i = 177; i <= 186; i++) {
      const namePathElement = svgDoc.getElementById(`dp_path${i}`);
      if (namePathElement) namePathElement.remove();
    }

    // Add vessel name as text element
    if (vesselName && mainGroup) {
      const nameText = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'text');
      nameText.setAttribute('x', '120');
      nameText.setAttribute('y', '438');
      nameText.setAttribute('font-family', 'Arial, sans-serif');
      nameText.setAttribute('font-size', '12');
      nameText.setAttribute('font-weight', 'bold');
      nameText.setAttribute('fill', nameColor);
      nameText.setAttribute('letter-spacing', '1');
      nameText.textContent = vesselName.toUpperCase();
      mainGroup.appendChild(nameText);
    }

    svg = new XMLSerializer().serializeToString(svgElement);

    // Apply color replacements
    // Hull colors
    svg = svg.replace(/#b30000/g, hullColor);
    svg = svg.replace(/#a70000/g, shadeColor(hullColor, -5));
    svg = svg.replace(/#712121/g, shadeColor(hullColor, -15));
    svg = svg.replace(/#712626/g, shadeColor(hullColor, -12));
    svg = svg.replace(/#7e2929/g, shadeColor(hullColor, -10));

    // Deck colors
    svg = svg.replace(/#272525/g, deckColor);
    svg = svg.replace(/#5b5b5b/g, shadeColor(deckColor, 20));
    svg = svg.replace(/fill="black"/g, `fill="${shadeColor(deckColor, -30)}"`);
    svg = svg.replace(/stroke="black"/g, `stroke="${shadeColor(deckColor, -30)}"`);

    // Bridge colors
    svg = svg.replace(/#dbdbdb/g, bridgeColor);
    svg = svg.replace(/#bbbbbb/g, shadeColor(bridgeColor, -10));
    svg = svg.replace(/#cbcbcb/g, shadeColor(bridgeColor, -5));
    svg = svg.replace(/#a7a7a7/g, shadeColor(bridgeColor, -20));
    svg = svg.replace(/#b7b7b7/g, shadeColor(bridgeColor, -15));

    // Container colors
    svg = svg.replace(/#ff8000/g, containerColor1);
    svg = svg.replace(/fill="blue"/g, `fill="${containerColor2}"`);
    svg = svg.replace(/#670000/g, containerColor3);
    svg = svg.replace(/#777777/g, containerColor4);

    return svg;
  } catch (error) {
    console.error('Failed to load vessel SVG:', error);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
      <rect width="400" height="200" fill="#f0f0f0"/>
      <text x="200" y="100" text-anchor="middle" font-size="16" fill="#666">Loading vessel preview...</text>
    </svg>`;
  }
}

/**
 * Generate tanker ship SVG preview
 * Loads the professional SVG template and applies colors
 * Tank count reflects capacity - ship size stays constant
 */
async function generateTankerSvg(state) {
  try {
    const response = await fetch('/images/vessels/custom_tanker_vessel.svg');
    let svg = await response.text();

    const capacity = state.capacity || 148000;
    const minCapacity = 148000;
    const maxCapacity = 1998000;
    const capacityRatio = Math.min(1, Math.max(0, (capacity - minCapacity) / (maxCapacity - minCapacity)));

    const hullColor = state.hullColor || '#b30000';
    const deckColor = state.deckColor || '#272525';
    const bridgeColor = state.bridgeColor || '#dbdbdb';
    const tankColor1 = state.containerColor1 || '#ff8000';
    const tankColor2 = state.containerColor2 || '#0000ff';
    const tankColor3 = state.containerColor3 || '#670000';
    const tankColor4 = state.containerColor4 || '#777777';
    const nameColor = state.nameColor || '#ffffff';

    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
    const svgElement = svgDoc.documentElement;

    // Hide tanks based on capacity (7 tanks total, show 4-7 based on capacity)
    const minTanks = 4;
    const maxTanks = 7;
    const tanksToShow = Math.floor(minTanks + capacityRatio * (maxTanks - minTanks));

    // Hide tanks from the front (bow) - tank_07 is at bow, tank_01 is near bridge
    for (let i = 7; i > tanksToShow; i--) {
      const tankId = i < 10 ? `tank_0${i}` : `tank_${i}`;
      const tankElement = svgElement.getElementById(tankId);
      if (tankElement) {
        tankElement.remove();
      }
    }

    // Convert back to string for color replacements
    svg = new XMLSerializer().serializeToString(svgElement);

    // Hull colors
    svg = svg.replace(/#b30000/g, hullColor);
    svg = svg.replace(/#a70000/g, shadeColor(hullColor, -5));
    svg = svg.replace(/#712121/g, shadeColor(hullColor, -15));
    svg = svg.replace(/#712626/g, shadeColor(hullColor, -12));
    svg = svg.replace(/#7e2929/g, shadeColor(hullColor, -10));

    // Deck colors
    svg = svg.replace(/#272525/g, deckColor);
    svg = svg.replace(/#5b5b5b/g, shadeColor(deckColor, 20));
    svg = svg.replace(/fill="black"/g, `fill="${shadeColor(deckColor, -30)}"`);
    svg = svg.replace(/stroke="black"/g, `stroke="${shadeColor(deckColor, -30)}"`);

    // Bridge colors
    svg = svg.replace(/#dbdbdb/g, bridgeColor);
    svg = svg.replace(/#bbbbbb/g, shadeColor(bridgeColor, -10));
    svg = svg.replace(/#cbcbcb/g, shadeColor(bridgeColor, -5));
    svg = svg.replace(/#a7a7a7/g, shadeColor(bridgeColor, -20));
    svg = svg.replace(/#b7b7b7/g, shadeColor(bridgeColor, -15));

    // Tank colors - update gradients and fills
    svg = svg.replace(/#ff8000/g, tankColor1);
    svg = svg.replace(/#cc6600/g, shadeColor(tankColor1, -20));
    svg = svg.replace(/#994d00/g, shadeColor(tankColor1, -40));

    svg = svg.replace(/fill="blue"/g, `fill="${tankColor2}"`);
    svg = svg.replace(/#4d94ff/g, shadeColor(tankColor2, 30));
    svg = svg.replace(/#0000b3/g, shadeColor(tankColor2, -30));

    svg = svg.replace(/#670000/g, tankColor3);
    svg = svg.replace(/#8f0000/g, shadeColor(tankColor3, 20));
    svg = svg.replace(/#4d0000/g, shadeColor(tankColor3, -20));

    svg = svg.replace(/#777777/g, tankColor4);
    svg = svg.replace(/#999999/g, shadeColor(tankColor4, 20));
    svg = svg.replace(/#555555/g, shadeColor(tankColor4, -20));

    // Name color
    svg = svg.replace(/fill="#ffffff"/gi, `fill="${nameColor}"`);
    svg = svg.replace(/fill="white"/gi, `fill="${nameColor}"`);

    return svg;
  } catch (error) {
    console.error('Failed to load tanker SVG template:', error);
    return generateFallbackTankerSvg(state);
  }
}

/**
 * Fallback tanker SVG if template fails to load
 */
function generateFallbackTankerSvg(state) {
  const viewBoxWidth = 800;
  const viewBoxHeight = 400;
  const shipLength = 500;
  const shipHeight = 80;
  const shipX = (viewBoxWidth - shipLength) / 2;
  const shipY = viewBoxHeight - shipHeight - 100;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxWidth} ${viewBoxHeight}">
      <rect width="${viewBoxWidth}" height="${viewBoxHeight}" fill="#87ceeb"/>
      <rect x="0" y="${viewBoxHeight - 100}" width="${viewBoxWidth}" height="100" fill="#1e3a5f"/>
      <path d="M ${shipX} ${shipY + shipHeight} L ${shipX + shipLength} ${shipY + shipHeight} L ${shipX + shipLength + 20} ${shipY + shipHeight - 20} L ${shipX + shipLength} ${shipY + 10} L ${shipX + 30} ${shipY + 10} L ${shipX} ${shipY + shipHeight - 30} Z" fill="${state.hullColor || '#b30000'}" stroke="#000" stroke-width="2"/>
      <text x="${viewBoxWidth / 2}" y="${viewBoxHeight / 2}" text-anchor="middle" font-size="16" fill="#fff">Tanker Preview</text>
    </svg>
  `;
}

/**
 * Render current step
 */
function renderCurrentStep() {
  const stepFunctions = [null, renderStep1, renderStep3, renderStep4, renderStep5];
  stepFunctions[buildState.currentStep]();

  document.querySelectorAll('.build-step-dot').forEach((step, index) => {
    const stepNumber = index + 1;
    step.classList.toggle('active', stepNumber === buildState.currentStep);
    step.classList.toggle('completed', stepNumber < buildState.currentStep);
  });

  const prevBtn = document.getElementById('buildPrevBtn');
  const nextBtn = document.getElementById('buildNextBtn');
  const submitBtn = document.getElementById('buildSubmitBtn');

  prevBtn.classList.toggle('hidden', buildState.currentStep === 1);
  nextBtn.classList.toggle('hidden', buildState.currentStep === 4);
  submitBtn.classList.toggle('hidden', buildState.currentStep !== 4);
}

/**
 * Go to next step
 */
function nextStep() {
  if (buildState.currentStep === 1 && !buildState.vesselType) {
    showSideNotification('Please select a vessel type', 'error');
    return;
  }
  if (buildState.currentStep === 1 && !buildState.port) {
    showSideNotification('Please select a delivery port', 'error');
    return;
  }

  if (buildState.currentStep < 4) {
    buildState.currentStep++;
    renderCurrentStep();
  }
}

/**
 * Go to previous step
 */
function prevStep() {
  if (buildState.currentStep > 1) {
    buildState.currentStep--;
    renderCurrentStep();
  }
}

/**
 * Submit build request
 */
async function submitBuild() {
  if (!buildState.vesselName.trim()) {
    showSideNotification('Please enter a vessel name', 'error');
    return;
  }

  const baseStats = calculateBaseStats(buildState.vesselType, buildState.capacity);
  const stats = applyPerkEffects(baseStats, buildState);
  const price = calculatePrice(buildState);

  const confirmed = await showConfirmDialog({
    title: 'Confirm Vessel Build',
    message: `Build ${buildState.vesselName}?`,
    details: [
      { label: 'Type', value: buildState.vesselType === 'container' ? 'Container' : 'Tanker' },
      { label: 'Capacity', value: `${formatNumber(buildState.capacity)} ${CAPACITY_RANGES[buildState.vesselType].unit}` },
      { label: 'Engine', value: ENGINES.find(e => e.type === buildState.engine).name },
      { label: 'Total Price', value: `$${formatNumber(Math.round(price))}` },
      { label: 'Build Time', value: formatBuildTime(Math.round(stats.buildTime)) }
    ],
    confirmText: 'Build Vessel',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  try {
    const response = await fetch('/api/vessel/build-vessel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: buildState.vesselName,
        ship_yard: buildState.port,
        vessel_model: buildState.vesselType,
        engine_type: buildState.engine,
        engine_kw: buildState.engineKW,
        capacity: buildState.capacity,
        antifouling_model: buildState.antifouling,
        bulbous: buildState.bulbous ? 1 : 0,
        enhanced_thrusters: buildState.enhancedThrusters ? 1 : 0,
        range: Math.round(stats.range),
        speed: Math.round(stats.speed * 10) / 10,
        fuel_consumption: Math.round(stats.fuel),
        propeller_types: buildState.propellers,
        hull_color: buildState.hullColor,
        deck_color: buildState.deckColor,
        bridge_color: buildState.bridgeColor,
        container_color_1: buildState.containerColor1,
        container_color_2: buildState.containerColor2,
        container_color_3: buildState.containerColor3,
        container_color_4: buildState.containerColor4,
        name_color: buildState.nameColor
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to build vessel');
    }

    showSideNotification(
      `Vessel "${buildState.vesselName}" is being built!<br>Build time: ${formatBuildTime(Math.round(stats.buildTime))}`,
      'success',
      5000
    );

    closeBuildShipModal();

    if (window.refreshVesselList) {
      window.refreshVesselList();
    }

    if (window.updateVesselCount) {
      await window.updateVesselCount();
    }

  } catch (error) {
    console.error('[Build] Error:', error);
    showSideNotification(`Error: ${error.message}`, 'error');
  }
}

// ============================================================================
// MODAL CONTROL
// ============================================================================

/**
 * Open build ship modal
 */
export function openBuildShipModal() {
  const overlay = document.getElementById('buildShipOverlay');
  if (!overlay) {
    console.error('[Build] Modal overlay not found');
    return;
  }

  buildState.currentStep = 1;
  buildState.vesselType = 'container';
  buildState.capacity = 2000;
  buildState.port = null;
  buildState.engine = null;
  buildState.engineKW = null;
  buildState.antifouling = null;
  buildState.bulbous = false;
  buildState.propellers = '4_blade_propeller';
  buildState.enhancedThrusters = false;
  buildState.vesselName = '';
  buildState.hullColor = '#b30000';
  buildState.deckColor = '#272525';
  buildState.bridgeColor = '#dbdbdb';
  buildState.containerColor1 = '#ff8000';
  buildState.containerColor2 = '#0000ff';
  buildState.containerColor3 = '#670000';
  buildState.containerColor4 = '#777777';
  buildState.nameColor = '#ffffff';

  overlay.classList.remove('hidden');
  renderCurrentStep();
}

/**
 * Close build ship modal
 */
function closeBuildShipModal() {
  const overlay = document.getElementById('buildShipOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

/**
 * Initialize build ship modal
 */
export function initBuildShipModal() {
  const closeBtn = document.getElementById('closeBuildShipBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeBuildShipModal);
  }

  const prevBtn = document.getElementById('buildPrevBtn');
  if (prevBtn) {
    prevBtn.addEventListener('click', prevStep);
  }

  const nextBtn = document.getElementById('buildNextBtn');
  if (nextBtn) {
    nextBtn.addEventListener('click', nextStep);
  }

  const submitBtn = document.getElementById('buildSubmitBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', submitBuild);
  }

  console.log('[Build] Vessel building module initialized');
}
