/**
 * Vessel SVG Generator
 * Generates dynamic SVG images for custom-built vessels
 * Uses professional container ship template and scales it based on capacity
 */

const fs = require('fs');
const path = require('path');

let baseContainerSvg = null;
let baseTankerSvg = null;

/**
 * Load base container SVG template
 */
function loadBaseContainerSvg() {
  if (!baseContainerSvg) {
    const svgPath = path.join(__dirname, '../../public/images/vessels/custom_cargo_vessel.svg');
    baseContainerSvg = fs.readFileSync(svgPath, 'utf8');
  }
  return baseContainerSvg;
}

/**
 * Load base tanker SVG template
 */
function loadBaseTankerSvg() {
  if (!baseTankerSvg) {
    const svgPath = path.join(__dirname, '../../public/images/vessels/custom_tanker_vessel.svg');
    baseTankerSvg = fs.readFileSync(svgPath, 'utf8');
  }
  return baseTankerSvg;
}

/**
 * Generate vessel SVG based on vessel data
 * @param {Object} vessel - Vessel data object
 * @returns {string} SVG string
 */
function generateVesselSvg(vessel) {
  if (vessel.capacity_type === 'container' || vessel.vessel_model === 'container') {
    return generateContainerSvg(vessel);
  } else {
    return generateTankerSvg(vessel);
  }
}

/**
 * Generate container ship SVG
 * @param {Object} vessel - Vessel data
 * @returns {string} SVG string
 */
function generateContainerSvg(vessel) {
  let svg = loadBaseContainerSvg();

  const capacity = vessel.capacity || vessel.capacity_max?.dry || 2000;
  const minCapacity = 2000;
  const maxCapacity = 27000;
  const capacityRatio = (capacity - minCapacity) / (maxCapacity - minCapacity);

  const hullColor = vessel.hull_color || '#b30000';
  const deckColor = vessel.deck_color || '#272525';
  const bridgeColor = vessel.bridge_color || '#dbdbdb';
  const containerColor1 = vessel.container_color_1 || '#ff8000';
  const containerColor2 = vessel.container_color_2 || '#0000ff';
  const containerColor3 = vessel.container_color_3 || '#670000';
  const containerColor4 = vessel.container_color_4 || '#777777';
  const nameColor = vessel.name_color || '#ffffff';

  const vesselName = vessel.name || 'Custom Vessel';

  const originalShipWidth = 1019;
  const originalShipHeight = 202;

  // ViewBox tight around ship: 6px padding left/right
  const padding = 6;
  const viewBoxWidth = originalShipWidth + padding * 2;
  const viewBoxHeight = originalShipHeight * 1.5;

  // Ship fills the viewBox at scale 1.0
  const displayScale = 1.0;
  const scaledShipHeight = originalShipHeight * displayScale;

  const waterLevel = viewBoxHeight * 0.78;

  const targetShipCenterX = viewBoxWidth / 2;
  const targetShipBottomY = waterLevel + scaledShipHeight * 0.1;

  const originalShipMinY = 271.17;
  const originalShipCenterX = 56.779 + originalShipWidth / 2;

  const newTranslateX = targetShipCenterX - (originalShipCenterX * displayScale);
  const newTranslateY = targetShipBottomY - ((originalShipMinY + originalShipHeight) * displayScale);

  svg = svg.replace(
    /viewBox="0 0 1019 201\.92"/,
    `viewBox="0 0 ${viewBoxWidth} ${viewBoxHeight}" preserveAspectRatio="xMidYMid meet"`
  );

  svg = svg.replace(
    /transform="translate\(-56\.779 -271\.17\)"/,
    `transform="translate(${newTranslateX}, ${newTranslateY}) scale(${displayScale})"`
  );

  const backgroundSvg = `
    <defs>
      <linearGradient id="bgSkyGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#4a90d9;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#87ceeb;stop-opacity:1" />
      </linearGradient>
      <linearGradient id="bgWaterGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#1e5a8e;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#0d3a5f;stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="${viewBoxWidth}" height="${waterLevel}" fill="url(#bgSkyGradient)"/>
    <rect y="${waterLevel}" width="${viewBoxWidth}" height="${viewBoxHeight - waterLevel}" fill="url(#bgWaterGradient)"/>
    <path d="M 0 ${waterLevel} Q 30 ${waterLevel - 5} 60 ${waterLevel} T 120 ${waterLevel} T 180 ${waterLevel} T 240 ${waterLevel} T 300 ${waterLevel} T 360 ${waterLevel} T 420 ${waterLevel} T 480 ${waterLevel} T 540 ${waterLevel} T 600 ${waterLevel} T 660 ${waterLevel} T 720 ${waterLevel} T 780 ${waterLevel} T 840 ${waterLevel} T 900 ${waterLevel} T 960 ${waterLevel} T 1020 ${waterLevel} T 1080 ${waterLevel} T 1140 ${waterLevel} T 1200 ${waterLevel}" stroke="#5dade2" stroke-width="3" fill="none" opacity="0.6"/>
  `;

  svg = svg.replace(/<g\s+id="dp_group001"/, `${backgroundSvg}<g id="dp_group001"`);

  const containerPathIds = [];
  for (let i = 159; i >= 90; i--) {
    if (i === 96) continue;
    const id = i < 100 ? `dp_path0${i}` : `dp_path${i}`;
    containerPathIds.push(id);
  }

  const targetContainers = Math.floor(containerPathIds.length * (0.3 + capacityRatio * 0.7));
  const containersToHide = containerPathIds.slice(targetContainers);

  containersToHide.forEach(id => {
    // eslint-disable-next-line security/detect-non-literal-regexp -- id values are hardcoded path IDs, not user input
    const regex = new RegExp(`<path[^>]*id="${id}"[^>]*/>`, 'g');
    svg = svg.replace(regex, '');
  });

  // Remove the main container shadow path (dp_path002) when containers are removed
  if (containersToHide.length > 0) {
    svg = svg.replace(/<path[^>]*id="dp_path002"[^>]*>[^<]*<\/path>/g, '');
    svg = svg.replace(/<path[^>]*id="dp_path002"[^>]*\/>/g, '');
  }

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

  svg = svg.replace(/WSSARKADIA/g, vesselName.toUpperCase());

  // Name color - replace white text fill with custom name color
  svg = svg.replace(/fill="#ffffff"/gi, `fill="${nameColor}"`);
  svg = svg.replace(/fill="white"/gi, `fill="${nameColor}"`);

  return svg;
}

function shadeColor(color, percent) {
  const num = parseInt(color.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, Math.min(255, (num >> 16) + amt));
  const G = Math.max(0, Math.min(255, (num >> 8 & 0x00FF) + amt));
  const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
  return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

/**
 * Generate tanker ship SVG using template
 * @param {Object} vessel - Vessel data
 * @returns {string} SVG string
 */
function generateTankerSvg(vessel) {
  let svg = loadBaseTankerSvg();

  const capacity = vessel.capacity || vessel.capacity_max?.dry || 148000;
  const minCapacity = 148000;
  const maxCapacity = 1998000;
  const capacityRatio = Math.min(1, Math.max(0, (capacity - minCapacity) / (maxCapacity - minCapacity)));

  // Colors - use same naming as container for consistency
  const hullColor = vessel.hull_color || '#b30000';
  const deckColor = vessel.deck_color || '#272525';
  const bridgeColor = vessel.bridge_color || '#dbdbdb';
  const tankColor1 = vessel.container_color_1 || vessel.cargo_color || '#ff8000';
  const tankColor2 = vessel.container_color_2 || '#0000ff';
  const tankColor3 = vessel.container_color_3 || '#670000';
  const tankColor4 = vessel.container_color_4 || '#777777';
  const nameColor = vessel.name_color || '#ffffff';

  const originalShipWidth = 1019;
  const originalShipHeight = 202;

  // ViewBox tight around ship
  const padding = 6;
  const viewBoxWidth = originalShipWidth + padding * 2;
  const viewBoxHeight = originalShipHeight * 1.5;

  const displayScale = 1.0;
  const waterLevel = viewBoxHeight * 0.78;

  const targetShipCenterX = viewBoxWidth / 2;
  const targetShipBottomY = waterLevel + originalShipHeight * displayScale * 0.1;

  const originalShipMinY = 271.17;
  const originalShipCenterX = 56.779 + originalShipWidth / 2;

  const newTranslateX = targetShipCenterX - (originalShipCenterX * displayScale);
  const newTranslateY = targetShipBottomY - ((originalShipMinY + originalShipHeight) * displayScale);

  // Update viewBox
  svg = svg.replace(
    /viewBox="0 0 1019 201\.92"/,
    `viewBox="0 0 ${viewBoxWidth} ${viewBoxHeight}" preserveAspectRatio="xMidYMid meet"`
  );

  // Update transform
  svg = svg.replace(
    /transform="translate\(-56\.779 -271\.17\)"/,
    `transform="translate(${newTranslateX}, ${newTranslateY}) scale(${displayScale})"`
  );

  // Add background
  const backgroundSvg = `
    <defs>
      <linearGradient id="bgSkyGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#4a90d9;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#87ceeb;stop-opacity:1" />
      </linearGradient>
      <linearGradient id="bgWaterGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#1e5a8e;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#0d3a5f;stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="${viewBoxWidth}" height="${waterLevel}" fill="url(#bgSkyGradient)"/>
    <rect y="${waterLevel}" width="${viewBoxWidth}" height="${viewBoxHeight - waterLevel}" fill="url(#bgWaterGradient)"/>
    <path d="M 0 ${waterLevel} Q 30 ${waterLevel - 5} 60 ${waterLevel} T 120 ${waterLevel} T 180 ${waterLevel} T 240 ${waterLevel} T 300 ${waterLevel} T 360 ${waterLevel} T 420 ${waterLevel} T 480 ${waterLevel} T 540 ${waterLevel} T 600 ${waterLevel} T 660 ${waterLevel} T 720 ${waterLevel} T 780 ${waterLevel} T 840 ${waterLevel} T 900 ${waterLevel} T 960 ${waterLevel} T 1020 ${waterLevel} T 1080 ${waterLevel} T 1140 ${waterLevel} T 1200 ${waterLevel}" stroke="#5dade2" stroke-width="3" fill="none" opacity="0.6"/>
  `;

  svg = svg.replace(/<g\s+id="dp_group001"/, `${backgroundSvg}<g id="dp_group001"`);

  // Hide tanks based on capacity (7 tanks total, show 4-7 based on capacity)
  const minTanks = 4;
  const maxTanks = 7;
  const tanksToShow = Math.floor(minTanks + capacityRatio * (maxTanks - minTanks));

  // Hide tanks from the front (bow) - tank_07 is at bow, tank_01 is near bridge
  for (let i = 7; i > tanksToShow; i--) {
    const tankId = i < 10 ? `tank_0${i}` : `tank_${i}`;
    // eslint-disable-next-line security/detect-non-literal-regexp
    const regex = new RegExp(`<g id="${tankId}">[\\s\\S]*?<\\/g>`, 'g');
    svg = svg.replace(regex, '');
  }

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
}

module.exports = {
  generateVesselSvg,
  generateContainerSvg,
  generateTankerSvg
};
