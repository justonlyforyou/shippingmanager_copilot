/**
 * @fileoverview Vessel Building Module
 *
 * Provides UI for building custom vessels from scratch.
 * Users can select vessel type, capacity, engine, port, and perks.
 * Real-time preview of vessel stats and pricing.
 *
 * @module vessel-building
 */

import { showSideNotification, formatNumber, escapeHtml } from './utils.js';
import { showConfirmDialog } from './ui-dialogs.js';
import { getCurrentBunkerState } from './bunker-management.js';
import logger from './core/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Available engines for vessel building (from /game/index.json)
 * Speed is calculated using the universal game formula, not engine-specific values:
 *   baseSpeed = Math.max(5, Math.min(35, Math.ceil(5.7 * power/capacity + capacity/1000)))
 *   finalSpeed = Math.ceil(baseSpeed * (1 + propeller.speed))
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
    default: true
  },
  {
    type: 'wartsila_syk_6',
    name: 'Wartsila SYK-6',
    minKW: 5000,
    maxKW: 15000,
    pricePerKW: 833,
    basePrice: 4165000,
    sortOrder: 2,
    default: false
  },
  {
    type: 'man_p22l',
    name: 'MAN P22L',
    minKW: 8000,
    maxKW: 17500,
    pricePerKW: 833,
    basePrice: 6664000,
    sortOrder: 3,
    default: false
  },
  {
    type: 'mih_xp9',
    name: 'MIH XP9',
    minKW: 10000,
    maxKW: 20000,
    pricePerKW: 833,
    basePrice: 8330000,
    sortOrder: 4,
    default: false
  },
  {
    type: 'man_p22l_z',
    name: 'MAN P22L-Z',
    minKW: 15000,
    maxKW: 25000,
    pricePerKW: 833,
    basePrice: 12495000,
    sortOrder: 5,
    default: false
  },
  {
    type: 'mih_cp9',
    name: 'MIH CP9',
    minKW: 25000,
    maxKW: 60000,
    pricePerKW: 833,
    basePrice: 20825000,
    sortOrder: 6,
    default: false
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
  engine: 'mih_x1',
  engineKW: 2500,
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
  nameColor: '#ffffff',
  customImage: null
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
 * Calculate speed from engine power and capacity
 * Uses the actual game formula extracted from fleet_b.js and app_beautified.js:
 * - Base speed: Math.max(5, Math.min(35, Math.ceil(5.7 * power/capacity + capacity/1000)))
 * - With propeller: Math.ceil(baseSpeed * (1 + propeller.speed))
 *
 * @param {number} power - Engine power in kW
 * @param {number} capacity - Vessel capacity (TEU for container, BBL/74 for tanker)
 * @returns {number} Base speed in knots (before propeller)
 */
function calculateGameBaseSpeed(power, capacity) {
  // Exact formula from game JS: Math.max(5, Math.min(35, Math.ceil(5.7 * n + t / 1e3)))
  // where n = power/capacity and t = capacity
  const ratio = power / capacity;
  return Math.max(5, Math.min(35, Math.ceil(5.7 * ratio + capacity / 1000)));
}

/**
 * Calculate base range from capacity (Step 1 - before engine selection)
 * Range is inversely proportional to capacity
 * @param {string} vesselType - 'container' or 'tanker'
 * @param {number} capacity - Vessel capacity
 * @returns {number} Base range in nautical miles
 */
function calculateBaseRangeFromCapacity(vesselType, capacity) {
  if (vesselType === 'container') {
    // Container: range = ceil(20,000,000 / TEU)
    return Math.ceil(20000000 / capacity);
  } else {
    // Tanker: scale to same range pattern
    const config = CAPACITY_RANGES.tanker;
    const containerEquiv = 2000 + (capacity - config.min) / (config.max - config.min) * 25000;
    return Math.ceil(20000000 / containerEquiv);
  }
}

/**
 * Calculate base vessel stats based on type and capacity
 * @param {string} vesselType - 'container' or 'tanker'
 * @param {number} capacity - Vessel capacity
 * @returns {Object} Base stats (range, speed, fuel, co2, buildTime)
 */
function calculateBaseStats(vesselType, capacity) {
  const config = CAPACITY_RANGES[vesselType];

  // Range from capacity-based formula
  const range = calculateBaseRangeFromCapacity(vesselType, capacity);

  // Speed at default engine (MIH X1 @ 2500 kW) - uses game formula
  // For tankers, divide BBL by 74 to get equivalent TEU capacity
  const effectiveCapacity = vesselType === 'tanker' ? Math.round(capacity / 74) : capacity;
  const speed = calculateGameBaseSpeed(2500, effectiveCapacity);

  // Fuel formula: ceil(capacity * sqrt(speed) * 0.994 / 40)
  const fuel = Math.ceil(effectiveCapacity * Math.sqrt(speed) * 0.994 / 40);
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

  // Speed perk is applied BEFORE rounding in updateStatsPreview, not here
  // (propeller speed multiplier must be applied to raw speed before rounding)

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

  // Perk costs are calculated on vessel base price ONLY (excluding engine)
  const perkCosts = basePrice * perkFactor;
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
 * Calculate speed for a specific engine and kW
 * Used for displaying speed ranges on engine selection cards
 * Uses the actual game formula: Math.max(5, Math.min(35, Math.ceil(5.7 * power/capacity + capacity/1000)))
 */
function calculateSpeedForEngine(capacity, vesselType, engineKW) {
  // For tankers, divide BBL by 74 to get equivalent TEU capacity
  const effectiveCapacity = vesselType === 'tanker' ? Math.round(capacity / 74) : capacity;
  return calculateGameBaseSpeed(engineKW, effectiveCapacity);
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

  // Base stats from capacity
  const baseStats = calculateBaseStats(buildState.vesselType, buildState.capacity);
  fuel = baseStats.fuel;
  co2 = baseStats.co2;
  buildTime = baseStats.buildTime;

  // Speed and range from capacity (this IS the MIH X1 @ 2500 kW baseline)
  speed = baseStats.speed;
  range = baseStats.range;

  // Range formula: min(18000, ceil(8000 * engineKW / capacity))
  // Speed formula: Math.max(5, Math.min(35, Math.ceil(5.7 * power/capacity + capacity/1000)))
  // With propeller: Math.ceil(baseSpeed * (1 + propeller.speed))
  if (buildState.engine && buildState.engineKW) {
    // For tankers, divide BBL by 74 to get equivalent TEU capacity
    const effectiveCapacity = buildState.vesselType === 'tanker'
      ? Math.round(buildState.capacity / 74)
      : buildState.capacity;

    // Range: universal formula based on kW and capacity
    const maxRange = 18000;
    range = Math.min(maxRange, Math.ceil(8000 * buildState.engineKW / effectiveCapacity));

    // Speed: exact game formula
    const baseSpeed = calculateGameBaseSpeed(buildState.engineKW, effectiveCapacity);

    // Apply propeller multiplier (if in step 3+)
    // Game formula: Math.ceil(baseSpeed * (1 + propeller.speed))
    // Floating point precision: 25 * 1.12 = 28.000000000000004, ceil gives 29
    if (buildState.currentStep >= 3 && buildState.propellers) {
      const propellerPerk = PERKS.propellers[buildState.propellers];
      speed = Math.ceil(baseSpeed * (1 + propellerPerk.speed));
    } else {
      speed = baseSpeed;
    }

    // Cap at 35 (max game speed)
    speed = Math.min(35, speed);

    // Fuel formula: ceil(capacity * sqrt(speed) * 0.994 / 40)
    // Factor 0.994 verified against game data for 2000 TEU and 27000 TEU
    fuel = Math.ceil(effectiveCapacity * Math.sqrt(speed) * 0.994 / 40);
  }

  if (buildState.currentStep >= 3) {
    const perkStats = applyPerkEffects({ range, speed, fuel, co2, buildTime }, buildState);
    range = perkStats.range;
    speed = perkStats.speed;
    fuel = perkStats.fuel;
    co2 = perkStats.co2;
    buildTime = perkStats.buildTime;
  }

  const price = calculatePrice(buildState);

  const config = CAPACITY_RANGES[buildState.vesselType];
  const unit = config.unit === 'TEU' ? 'TEU' : 'BBL';
  const co2Unit = config.unit === 'TEU' ? 'kg/TEU/nm' : 'kg/100bbl/nm';

  document.getElementById('previewCapacity').textContent = `${formatNumber(buildState.capacity)} ${unit}`;
  document.getElementById('previewRange').textContent = `${Math.ceil(range)} nm`;
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
    radio.addEventListener('change', async (e) => {
      const selectedType = e.target.value;

      // Show bug warning when selecting tanker without tanker ops
      if (selectedType === 'tanker' && !window.USER_COMPANY_TYPE?.includes('tanker')) {
        const confirmed = await showConfirmDialog({
          title: 'Tanker Building - Bug Exploit',
          message: 'You have not unlocked Tanker Operations yet. However, due to a bug in the game, you can still build tankers without this achievement.',
          details: [
            { label: 'Status', value: 'Tanker Ops NOT unlocked' },
            { label: 'Bug', value: 'Build menu allows tanker construction' }
          ],
          infoPopup: 'This is an unintended game behavior. Normally, you would need to unlock "Tanker Operations" before building tankers. The game allows building but not buying tankers without this achievement. Use at your own discretion.',
          confirmText: 'Build Tanker Anyway',
          cancelText: 'Stay with Container'
        });

        if (!confirmed) {
          // User cancelled - revert to container
          e.target.checked = false;
          const containerRadio = content.querySelector('input[value="container"]');
          if (containerRadio) containerRadio.checked = true;
          return;
        }
      }

      buildState.vesselType = selectedType;

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
          const minSpeed = calculateSpeedForEngine(buildState.capacity, buildState.vesselType, engine.minKW);
          const maxSpeed = calculateSpeedForEngine(buildState.capacity, buildState.vesselType, engine.maxKW);

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
        <div class="svg-preview-container" id="previewContainer">
          ${buildState.customImage
            ? `<img src="${buildState.customImage}" alt="Custom vessel" class="custom-image-full-preview">`
            : '<div id="vesselSvgPreview"></div>'}
        </div>
        <div class="custom-image-upload">
          <div class="custom-image-preview" id="customImagePreview">
            ${buildState.customImage
              ? `<img src="${buildState.customImage}" alt="Custom">`
              : '<span class="upload-icon">+</span><span class="upload-text">Click to upload</span>'}
          </div>
          <input type="file" id="customImageInput" accept="image/*" style="display: none;">
          ${buildState.customImage ? '<button type="button" class="remove-custom-image-btn" id="removeCustomImage">Remove Image</button>' : ''}
        </div>
        <div class="color-controls-grid${buildState.customImage ? ' hidden' : ''}">
          <div class="color-control">
            <input type="color" id="hullColor" value="${buildState.hullColor}">
            <label for="hullColor">Hull</label>
          </div>
          <div class="color-control">
            <input type="color" id="deckColor" value="${buildState.deckColor}">
            <label for="deckColor">Deck</label>
          </div>
          <div class="color-control">
            <input type="color" id="bridgeColor" value="${buildState.bridgeColor}">
            <label for="bridgeColor">Bridge</label>
          </div>
          <div class="color-control">
            <input type="color" id="nameColor" value="${buildState.nameColor}">
            <label for="nameColor">Name</label>
          </div>
          <div class="color-control">
            <input type="color" id="containerColor1" value="${buildState.containerColor1}">
            <label for="containerColor1">C1</label>
          </div>
          <div class="color-control">
            <input type="color" id="containerColor2" value="${buildState.containerColor2}">
            <label for="containerColor2">C2</label>
          </div>
          <div class="color-control">
            <input type="color" id="containerColor3" value="${buildState.containerColor3}">
            <label for="containerColor3">C3</label>
          </div>
          <div class="color-control">
            <input type="color" id="containerColor4" value="${buildState.containerColor4}">
            <label for="containerColor4">C4</label>
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

  // Custom image upload handlers
  const imagePreview = content.querySelector('#customImagePreview');
  const imageInput = content.querySelector('#customImageInput');
  const removeBtn = content.querySelector('#removeCustomImage');

  imagePreview?.addEventListener('click', () => {
    imageInput?.click();
  });

  imageInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showSideNotification('Please select an image file', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Resize image
        const maxWidth = 400;
        const maxHeight = 240;
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round(height * (maxWidth / width));
          width = maxWidth;
        }
        if (height > maxHeight) {
          width = Math.round(width * (maxHeight / height));
          height = maxHeight;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        buildState.customImage = canvas.toDataURL('image/png');
        renderStep5(); // Re-render to show image
        showSideNotification('Image uploaded', 'success');
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });

  removeBtn?.addEventListener('click', () => {
    buildState.customImage = null;
    renderStep5(); // Re-render to remove image
  });

  // Only update SVG preview if no custom image
  if (!buildState.customImage) {
    updateSvgPreview();
  }
}

/**
 * Build preview URL from buildState
 */
function buildPreviewUrl(state) {
  const params = new URLSearchParams();
  params.set('capacity_type', state.vesselType || 'container');
  params.set('capacity', state.capacity || 2000);
  if (state.vesselName) params.set('name', state.vesselName);
  if (state.hullColor) params.set('hull_color', state.hullColor);
  if (state.deckColor) params.set('deck_color', state.deckColor);
  if (state.bridgeColor) params.set('bridge_color', state.bridgeColor);
  if (state.nameColor) params.set('name_color', state.nameColor);
  if (state.containerColor1) params.set('container_color_1', state.containerColor1);
  if (state.containerColor2) params.set('container_color_2', state.containerColor2);
  if (state.containerColor3) params.set('container_color_3', state.containerColor3);
  if (state.containerColor4) params.set('container_color_4', state.containerColor4);
  return `/api/vessel-svg/preview?${params.toString()}`;
}

/**
 * Update SVG preview using server endpoint
 */
function updateSvgPreview() {
  const container = document.getElementById('vesselSvgPreview');
  if (!container) return;

  const url = buildPreviewUrl(buildState);
  container.innerHTML = `<img src="${url}" alt="Vessel Preview" style="width:100%;height:100%;object-fit:contain;">`;
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
        name_color: buildState.nameColor,
        custom_image: buildState.customImage,
        build_price: Math.round(price)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to build vessel');
    }

    // NOTE: Success notification is shown via WebSocket (user_action_notification)
    // from server/routes/game/vessel.js - no duplicate notification here

    closeBuildShipModal();

    if (window.refreshVesselList) {
      window.refreshVesselList();
    }

    if (window.updateVesselCount) {
      await window.updateVesselCount();
    }

    // Refresh harbor map to include new vessel in rawVessels
    if (window.harborMap && window.harborMap.forceRefresh) {
      await window.harborMap.forceRefresh();
    }

    // Offer fast delivery via Bug-Using if we have the vessel ID
    logger.debug('[Build] Response data:', data);
    logger.debug('[Build] Vessel ID from response:', data.vessel_id);

    if (!data.vessel_id) {
      console.warn('[Build] No vessel_id returned - fast delivery check skipped');
    } else {
      try {
        // Show loading notification - backend already waited for vessel registration
        showSideNotification('Checking fast delivery options...', 'info');

        // Fetch real drydock price from API
        const drydockStatusResponse = await fetch('/api/maintenance/get-drydock-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vessel_ids: JSON.stringify([data.vessel_id]),
            speed: 'maximum',
            maintenance_type: 'major'
          })
        });

        logger.debug('[Build] Drydock status response:', drydockStatusResponse.status);

        if (drydockStatusResponse.ok) {
          const drydockStatus = await drydockStatusResponse.json();
          logger.debug('[Build] Drydock status:', drydockStatus);
          const vesselDrydock = drydockStatus.vessels?.[0];
          const drydockCost = vesselDrydock?.cost;
          logger.debug('[Build] Drydock cost:', drydockCost, 'Vessel data:', vesselDrydock);

          if (drydockCost > 0) {
            // Ask user if they want fast delivery
            const vesselType = vesselDrydock?.vessel_type || 'Vessel';
            const useFastDelivery = await showConfirmDialog({
              title: 'Fast Delivery Available',
              message: 'Use Bug for fast delivery?',
              infoPopup: 'By triggering drydock immediately after build, delivery time is reduced to 60 minutes (the drydock duration). This is a known game exploit. If you skip this now, you can activate it later via the vessels menu by sending the ship to drydock (wrench icon).',
              details: [
                { label: 'Vessel', value: vesselType },
                { label: 'Drydock Cost', value: `$${formatNumber(drydockCost)}` },
                { label: 'Delivery Time', value: '60 minutes instead of normal build time' }
              ],
              confirmText: 'Yes, use Fast Delivery',
              cancelText: 'No, normal delivery'
            });

            // useFastDelivery is boolean (no checkboxes used)
            const confirmed = useFastDelivery;

            if (confirmed) {
              const drydockResponse = await fetch('/api/maintenance/bulk-drydock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  vessel_ids: JSON.stringify([data.vessel_id]),
                  speed: 'maximum',
                  maintenance_type: 'major'
                })
              });

              if (drydockResponse.ok) {
                showSideNotification('Fast delivery activated - vessel will arrive in 60 minutes', 'success');
                // Notify vessel-management to refresh pending view if active
                window.dispatchEvent(new CustomEvent('drydock-completed'));
              } else {
                const drydockError = await drydockResponse.json();
                console.error('[Build] Drydock trigger failed:', drydockError);
                showSideNotification('Fast delivery failed - vessel will arrive normally', 'warning');
              }
            }
          }
        }
      } catch (fastDeliveryErr) {
        console.error('[Build] Fast delivery check error:', fastDeliveryErr);
        // Silent fail - vessel was built successfully, just fast delivery option failed
      }
    }

  } catch (error) {
    console.error('[Build] Error:', error);
    showSideNotification(`Error: ${escapeHtml(error.message)}`, 'error');
  }
}

// ============================================================================
// MODAL CONTROL
// ============================================================================

/**
 * Open build ship modal
 */
export async function openBuildShipModal() {
  const overlay = document.getElementById('buildShipOverlay');
  if (!overlay) {
    console.error('[Build] Modal overlay not found');
    return;
  }

  // Ensure company_type is loaded (needed for tanker bug warning dialog)
  if (!window.USER_COMPANY_TYPE) {
    try {
      const response = await fetch(window.apiUrl('/api/vessel/get-vessels'));
      if (response.ok) {
        const data = await response.json();
        if (data.company_type) {
          window.USER_COMPANY_TYPE = data.company_type;
          logger.debug('[Build] Loaded company_type:', data.company_type);
        }
      }
    } catch (err) {
      logger.warn('[Build] Failed to fetch company_type:', err.message);
    }
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

  logger.debug('[Build] Vessel building module initialized');
}
