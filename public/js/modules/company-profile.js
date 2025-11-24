/**
 * @fileoverview Company Profile Overlay Module
 * Reusable overlay for viewing company profiles (own and other players)
 * Can be accessed from: XP star, alliance menu, search results
 *
 * @module company-profile
 */

import { showSideNotification, formatNumber, escapeHtml } from './utils.js';

let navigationHistory = [];
let currentView = 'own'; // 'own', 'search', 'profile'
let searchResults = [];
let currentUserId = null;

/**
 * Opens the company profile overlay
 * Shows own company by default
 */
export async function openCompanyProfile() {
  const overlay = document.getElementById('companyProfileOverlay');
  if (!overlay) {
    console.error('[Company Profile] Overlay not found');
    return;
  }

  overlay.classList.remove('hidden');
  navigationHistory = [];
  currentView = 'own';

  // Load own company (null = load own profile)
  await loadCompanyProfile(null, true);
}

/**
 * Closes the company profile overlay
 */
export function closeCompanyProfile() {
  const overlay = document.getElementById('companyProfileOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
  navigationHistory = [];
  searchResults = [];
  currentView = 'own';
}

/**
 * Loads and displays a company profile
 * @param {number|null} userId - User ID to load (null for own profile)
 * @param {boolean} isOwn - Whether this is the own profile
 */
async function loadCompanyProfile(userId, isOwn = false) {
  const content = document.getElementById('companyProfileContent');
  const title = document.getElementById('companyProfileTitle');

  if (!content) return;

  content.innerHTML = '<div class="company-profile-loading">Loading...</div>';

  try {
    const requestBody = userId ? { user_id: userId } : {};
    const response = await fetch(window.apiUrl('/api/user/get-company'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) throw new Error('Failed to load company');

    const data = await response.json();
    console.log('[Company Profile] Loaded data:', data);

    currentUserId = userId;

    // Update title
    title.textContent = isOwn ? 'My Company' : data.company_name || 'Company Profile';

    // Render company data
    renderCompanyProfile(data, isOwn);

    // Load alliance details asynchronously and attach click listeners
    loadAllianceDetails();
    attachAllianceClickListener();

    // If own profile, also load staff data
    if (isOwn) {
      loadStaffData();
    }

  } catch (error) {
    console.error('[Company Profile] Error loading company:', error);
    content.innerHTML = '<div class="company-profile-error">Failed to load company profile</div>';
  }
}

/**
 * Loads staff data and appends it to the profile (only for own company)
 */
async function loadStaffData() {
  try {
    const response = await fetch(window.apiUrl('/api/user/staff/get-user-staff'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) throw new Error('Failed to load staff data');

    const staffData = await response.json();
    console.log('[Company Profile] Staff data:', staffData);

    // Append staff section to content
    const content = document.getElementById('companyProfileContent');
    const card = content.querySelector('.company-profile-card');
    if (card && staffData.data) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = buildStaffSection(staffData.data, staffData.user);
      while (tempDiv.firstChild) {
        card.appendChild(tempDiv.firstChild);
      }

      // Add achievements section after staff (if available)
      if (window.pendingAchievements && window.pendingAchievements.achievements && window.pendingAchievements.achievements.length > 0) {
        const tempDiv2 = document.createElement('div');
        tempDiv2.innerHTML = buildAchievementsSection(window.pendingAchievements);
        while (tempDiv2.firstChild) {
          card.appendChild(tempDiv2.firstChild);
        }
        window.pendingAchievements = null;
      }

      // Add event listeners to salary buttons
      attachSalaryButtonListeners();
    }

  } catch (error) {
    console.error('[Company Profile] Error loading staff data:', error);
  }
}

/**
 * Attaches event listeners to salary increase/decrease buttons and training buttons
 */
function attachSalaryButtonListeners() {
  const increaseButtons = document.querySelectorAll('.staff-salary-increase');
  const decreaseButtons = document.querySelectorAll('.staff-salary-decrease');
  const trainingButtons = document.querySelectorAll('.training-level-btn:not(.disabled)');

  increaseButtons.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const staffType = btn.dataset.type;
      await adjustSalary(staffType, 'increase');
    });
  });

  decreaseButtons.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const staffType = btn.dataset.type;
      await adjustSalary(staffType, 'decrease');
    });
  });

  trainingButtons.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const staffType = btn.dataset.staffType;
      const perkType = btn.dataset.perkType;
      await trainPerk(staffType, perkType);
    });
  });
}

/**
 * Attaches click listeners to alliance items
 */
function attachAllianceClickListener() {
  const allianceItems = document.querySelectorAll('.alliance-result-item');

  allianceItems.forEach(item => {
    item.addEventListener('click', async (e) => {
      e.preventDefault();
      const allianceId = parseInt(item.dataset.allianceId, 10);

      if (allianceId) {
        // Close company profile overlay
        closeCompanyProfile();

        // Open alliance overlay
        const { showAllianceCoopOverlay } = await import('./alliance-tabs.js');
        await showAllianceCoopOverlay();
      }
    });
  });
}

/**
 * Normalizes a color string to hex format
 * @param {string} color - Color string (hex with or without #)
 * @returns {string} Normalized hex color with #
 */
function normalizeColor(color) {
  if (!color) return '#FFFFFF';
  return color.startsWith('#') ? color : `#${color}`;
}

/**
 * Loads and displays alliance details in the company profile
 */
async function loadAllianceDetails() {
  const container = document.getElementById('companyProfileAllianceRow');
  if (!container) return;

  const allianceId = container.dataset.allianceId;
  const allianceName = container.dataset.allianceName;
  if (!allianceId) return;

  try {
    const response = await fetch(window.apiUrl(`/api/alliance-info/${allianceId}`));
    if (!response.ok) return;

    const data = await response.json();
    const alliance = data.alliance || data;

    const primaryColor = normalizeColor(alliance.image_colors?.primary);
    const secondaryColors = alliance.image_colors?.secondary || ['FFFFFF', 'FFFFFF'];
    const gradientColor1 = normalizeColor(secondaryColors[0]);
    const gradientColor2 = normalizeColor(secondaryColors[1] || secondaryColors[0]);
    const gradient = `linear-gradient(${gradientColor1} 0%, ${gradientColor2} 100%)`;

    const logoInitials = allianceName.substring(0, 2).toUpperCase();
    const languageFlag = alliance.language ? alliance.language.substring(3, 5).toUpperCase() : '';

    const { formatNumber } = await import('./utils.js');

    container.innerHTML = `
      <div class="league-alliance-row alliance-result-item" data-alliance-id="${allianceId}">
        <div class="league-alliance-logo">
          <div class="alliance-logo-wrapper" style="background: ${gradient};">
            <img src="/api/alliance-logo/${alliance.image}?color=${encodeURIComponent(primaryColor)}" alt="${allianceName}" class="alliance-logo-svg" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
            <span class="alliance-logo-text" style="color: ${primaryColor}; display: none;">${logoInitials}</span>
          </div>
        </div>
        <div class="league-alliance-info">
          <div class="league-alliance-name clickable" data-alliance-id="${allianceId}">
            ${allianceName}
            ${languageFlag ? `<span class="league-language-flag">${languageFlag}</span>` : ''}
          </div>
          <div class="league-alliance-meta">
            <span>Level ${alliance.benefit_level || 0}</span>
            <span>${alliance.members || 0}/50</span>
            <span>$${formatNumber(alliance.total_share_value || 0)}</span>
            <span>League ${alliance.league_level || 0}</span>
          </div>
        </div>
      </div>
    `;

    // Re-attach click listener
    attachAllianceClickListener();
  } catch (error) {
    console.error('[Company Profile] Failed to load alliance details:', error);
  }
}

/**
 * Adjusts staff salary and refreshes the profile
 * @param {string} staffType - Type of staff (cfo, coo, etc.)
 * @param {string} action - 'increase' or 'decrease'
 */
async function adjustSalary(staffType, action) {
  try {
    const endpoint = action === 'increase' ? '/api/staff/raise-salary' : '/api/staff/reduce-salary';

    const response = await fetch(window.apiUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: staffType })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || `Failed to ${action} salary`);
    }

    const result = await response.json();
    console.log(`[Salary Adjust] ${action} successful:`, result);

    // Show success notification
    const actionText = action === 'increase' ? 'Salary raise' : 'Salary cut';
    const newSalary = result.data?.staff?.salary;

    if (newSalary && showSideNotification) {
      showSideNotification(`${actionText} successful<br>New salary: $${formatNumber(newSalary)}`, 'success');
    }

    // Update salary value directly in DOM (no full reload)
    const salaryValueElement = document.querySelector(`[data-staff-type="${staffType}"] .staff-salary-value`);
    if (salaryValueElement && newSalary) {
      salaryValueElement.textContent = `$${formatNumber(newSalary)}`;
    }

    // Update staff morale (the individual staff percentage)
    const staffData = result.data?.staff;
    if (staffData?.morale !== undefined) {
      // Update in staff detail section (73.00% format)
      const staffCard = document.querySelector(`[data-staff-type="${staffType}"]`);
      if (staffCard) {
        const detailValues = staffCard.querySelectorAll('.staff-detail-value');
        detailValues.forEach(el => {
          // Find the morale detail by checking if previous label says "Morale"
          const label = el.previousElementSibling;
          if (label && label.textContent.includes('Morale')) {
            el.textContent = `${staffData.morale.toFixed(2)}%`;
          }
        });
      }

      // Update morale percentage (if exists elsewhere)
      const moraleElement = document.querySelector(`[data-staff-type="${staffType}"] .morale-percentage`);
      if (moraleElement) {
        moraleElement.textContent = `${staffData.morale}%`;
      }
    }

    // Update crew morale in summary section
    if (staffData?.crew_morale) {
      const moraleStats = document.querySelectorAll('.morale-stat');
      moraleStats.forEach(stat => {
        const label = stat.querySelector('.company-stat-label');
        if (label && label.textContent === 'Crew Morale') {
          const valueElement = stat.querySelector('.company-stat-value');
          if (valueElement) {
            const formattedLabel = formatMoraleLabel(staffData.crew_morale.label);
            valueElement.textContent = `${staffData.crew_morale.percentage}% (${formattedLabel})`;
          }

          // Update morale smiley color dynamically
          const smileyContainer = stat.querySelector('.morale-smiley-container');
          if (smileyContainer) {
            smileyContainer.innerHTML = generateMoraleSmiley(staffData.crew_morale.percentage);
          }
        }
      });
    }

    // Update management morale in summary section
    if (staffData?.management_morale) {
      const moraleStats = document.querySelectorAll('.morale-stat');
      moraleStats.forEach(stat => {
        const label = stat.querySelector('.company-stat-label');
        if (label && label.textContent === 'Management Morale') {
          const valueElement = stat.querySelector('.company-stat-value');
          if (valueElement) {
            const formattedLabel = formatMoraleLabel(staffData.management_morale.label);
            valueElement.textContent = `${staffData.management_morale.percentage}% (${formattedLabel})`;
          }

          // Update morale smiley color dynamically
          const smileyContainer = stat.querySelector('.morale-smiley-container');
          if (smileyContainer) {
            smileyContainer.innerHTML = generateMoraleSmiley(staffData.management_morale.percentage);
          }
        }
      });
    }

    // Enable/disable buttons based on morale limits
    const increaseBtn = document.querySelector(`[data-staff-type="${staffType}"].staff-salary-increase`);
    const decreaseBtn = document.querySelector(`[data-staff-type="${staffType}"].staff-salary-decrease`);

    if (increaseBtn && staffData?.morale >= 100) {
      increaseBtn.disabled = true;
      increaseBtn.style.opacity = '0.5';
    } else if (increaseBtn) {
      increaseBtn.disabled = false;
      increaseBtn.style.opacity = '1';
    }

    if (decreaseBtn && staffData?.morale <= 0) {
      decreaseBtn.disabled = true;
      decreaseBtn.style.opacity = '0.5';
    } else if (decreaseBtn) {
      decreaseBtn.disabled = false;
      decreaseBtn.style.opacity = '1';
    }

  } catch (error) {
    console.error(`[Salary Adjust] Error ${action}ing salary:`, error);
    if (showSideNotification) {
      showSideNotification(`Failed to adjust salary: ${escapeHtml(error.message)}`, 'error');
    }
  }
}

/**
 * Trains a perk and updates the profile live
 * @param {string} staffType - Type of staff (cfo, coo, cmo, cto, captain, first_officer, boatswain, technical_officer)
 * @param {string} perkType - Perk type name
 *
 * Available perk types by staff:
 * - CFO: shop_cash, lower_channel_fees, cheap_anchor_points, cheap_fuel, cheap_co2, cheap_harbor_fees, cheap_route_creation_fee
 * - COO: happier_staff, less_crew, improved_staff_negotiations, lower_hijacking_chance, cheap_guards
 * - CMO: higher_demand, cheap_marketing
 * - CTO: reduce_co2_consumption, reduce_fuel_consumption, travel_speed_increase, slower_wear, cheaper_maintenance
 * - Captain: lower_crew_unhappiness
 * - First Officer: less_crew_needed
 * - Boatswain: slower_wear_boatswain
 * - Technical Officer: less_fuel_consumption
 */
async function trainPerk(staffType, perkType) {
  try {
    const response = await fetch(window.apiUrl('/api/staff/spend-training-point'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: staffType,
        perk_type: perkType
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to train perk');
    }

    const result = await response.json();
    console.log('[Train Perk] Training successful:', result);

    // Get perk info for notification
    const staffData = result.data?.staff;
    const training = staffData?.training;
    const perkInfo = training?.find(t => t.perk === perkType);
    const perkName = perkInfo?.perk || perkType;
    const newLevel = perkInfo?.level || '?';

    // Show success notification
    if (showSideNotification) {
      showSideNotification(`Training successful<br>Perk: ${formatPerkName(perkName)} Level ${newLevel}`, 'success');
    }

    // Update training points display
    const trainingPoints = result.user?.staff_training_points;
    if (trainingPoints !== undefined) {
      const trainingPointsValue = document.querySelector('.staff-points-value');
      if (trainingPointsValue) {
        trainingPointsValue.textContent = trainingPoints;
      }
    }

    // Update the specific perk level and effect in the DOM
    const perkButton = document.querySelector(`[data-staff-type="${staffType}"][data-perk-type="${perkType}"]`);
    if (perkButton) {
      const trainingItem = perkButton.closest('.training-item');
      if (trainingItem) {
        // Update level display
        const levelElement = trainingItem.querySelector('.training-level');
        if (levelElement && perkInfo) {
          levelElement.textContent = `${perkInfo.level}/${perkInfo.max_level}`;
        }

        // Update effect display
        const effectElement = trainingItem.querySelector('.training-effect');
        if (effectElement && perkInfo?.current_effect !== undefined) {
          effectElement.textContent = perkInfo.current_effect;
        }
      }

      // Disable button if max level reached
      if (perkInfo?.level >= perkInfo?.max_level) {
        perkButton.classList.add('disabled');
        perkButton.disabled = true;
      }
    }

    // If no more training points, disable ALL training buttons
    if (trainingPoints === 0) {
      const allTrainingButtons = document.querySelectorAll('.training-level-btn:not(.disabled)');
      allTrainingButtons.forEach(btn => {
        btn.classList.add('disabled');
        btn.disabled = true;
      });
    }

  } catch (error) {
    console.error('[Train Perk] Error training perk:', error);
    if (showSideNotification) {
      showSideNotification(`Training failed: ${escapeHtml(error.message)}`, 'error');
    }
  }
}

/**
 * Formats perk name for display
 */
function formatPerkName(perkName) {
  return perkName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Formats morale label for display
 */
function formatMoraleLabel(label) {
  const labelMap = {
    'very_happy': 'Very Happy',
    'happy': 'Happy',
    'satisfied': 'Satisfied',
    'unhappy': 'Unhappy',
    'very_unhappy': 'Very Unhappy'
  };
  return labelMap[label] || label;
}

/**
 * Renders the company profile HTML - displays ALL available data from API
 * @param {Object} responseData - Company data from API
 * @param {boolean} isOwn - Whether this is own profile
 */
function renderCompanyProfile(responseData, isOwn) {
  const content = document.getElementById('companyProfileContent');

  // Log full response for debugging
  console.log('[Company Profile] Full API response:', JSON.stringify(responseData, null, 2));

  // Extract all sections from the nested structure
  // Structure: { data: { achievements, company, alliance }, user: {...} }
  const data = responseData.data || {};
  const company = data.company || {};
  const alliance = data.alliance || {};
  const achievements = data.achievements || {};
  const user = responseData.user || {};

  // Get company name, ID, level, and difficulty for header
  // For own profile: user contains YOUR data
  // For other profiles: company contains THEIR data, user contains YOUR data
  const companyName = isOwn ? (user.company_name || 'Unknown Company') : (company.company_name || 'Unknown Company');
  const companyId = isOwn ? user.id : (company.id || currentUserId);
  const level = isOwn ? user.ceo_level : company.level;
  const difficulty = isOwn ? user.difficulty : company.difficulty;
  const companyType = isOwn ? user.company_type : company.company_type;
  const madePurchase = isOwn ? user.made_purchase : company.made_purchase;
  const isAdmin = isOwn ? user.is_admin : company.is_admin;
  const isGuest = isOwn ? user.is_guest : company.is_guest;
  const ipo = isOwn ? user.ipo : company.ipo;

  // Get XP data for progress fill and tacho (only available for own profile)
  const experiencePoints = isOwn ? user.experience_points : undefined;
  const levelupXp = isOwn ? user.levelup_experience_points : undefined;
  const currentLevelXp = isOwn ? user.current_level_experience_points : undefined;

  // Calculate XP fill percentage for star (0-100)
  let xpFillPercent = 0;
  if (experiencePoints !== undefined && levelupXp !== undefined && currentLevelXp !== undefined) {
    const xpRange = levelupXp - currentLevelXp;
    const xpProgress = experiencePoints - currentLevelXp;
    if (xpRange > 0) {
      xpFillPercent = Math.min(100, Math.max(0, (xpProgress / xpRange) * 100));
    }
  }

  // Build sections (excluding achievements - they go after staff)
  let sectionsHtml = '';

  // Merge user and company data into one section
  // For own profile: merge user + company. For other profiles: only company data
  const mergedData = isOwn ? { ...user, ...company } : { ...company };
  if (Object.keys(mergedData).length > 0) {
    sectionsHtml += buildSection('', mergedData);
  }

  // Alliance row - integrated into stats section (no title/divider)
  if (alliance && alliance.name) {
    const allianceId = alliance.id;
    const allianceName = escapeHtml(alliance.name);

    // Create placeholder for alliance row that will be populated async
    sectionsHtml += `
      <div id="companyProfileAllianceRow" class="league-standings" data-alliance-id="${allianceId}" data-alliance-name="${allianceName}">
        <div class="league-alliance-row alliance-result-item" data-alliance-id="${allianceId}">
          <div class="league-alliance-logo">
            <div class="alliance-logo-wrapper" style="background: var(--color-bg-tertiary);">
              <span class="alliance-logo-text">${allianceName.substring(0, 2).toUpperCase()}</span>
            </div>
          </div>
          <div class="league-alliance-info">
            <div class="league-alliance-name clickable">${allianceName}</div>
            <div class="league-alliance-meta"><span>Loading...</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // For own profile: Store achievements for later (will be added after staff by loadStaffData)
  // For other profiles: Add achievements now (no staff section)
  if (isOwn) {
    window.pendingAchievements = achievements;
  } else {
    // Add achievements section directly for other players
    if (achievements && achievements.achievements && achievements.achievements.length > 0) {
      sectionsHtml += buildAchievementsSection(achievements);
    }
  }

  // Generate CEO level badge (same structure as header badge)
  const xpFillWidth = (xpFillPercent / 100) * 24;
  const ceoBadgeHtml = level ? `
    <span class="ceo-level-badge company-profile-ceo-badge">
      <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" class="ceo-level-badge__svg">
        <defs>
          <clipPath id="starClipProfile">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
          </clipPath>
        </defs>
        <!-- Background star (empty/outline) -->
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="rgba(251, 191, 36, 0.2)" stroke="#f59e0b" stroke-width="0.5"/>
        <!-- XP Progress fill (grows from left to right using clip-path) -->
        <rect id="ceoLevelFillProfile" x="0" y="0" width="${xpFillWidth}" height="24" fill="#fbbf24" clip-path="url(#starClipProfile)" class="ceo-level-badge__fill"/>
        <!-- Star outline on top -->
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="none" stroke="#f59e0b" stroke-width="0.5"/>
      </svg>
      <span class="ceo-level-badge__number">${level}</span>
    </span>
  ` : '';

  // Generate XP Progress Bar if XP data is available (only for own profile)
  let xpProgressHtml = '';
  if (experiencePoints !== undefined && levelupXp !== undefined && currentLevelXp !== undefined) {
    const nextLevel = level + 1;

    xpProgressHtml = `
      <div class="xp-progress-container">
        <div class="xp-progress-labels">
          <span class="xp-progress-label-left">XP Level ${level} (${currentLevelXp.toLocaleString('en-US')})</span>
          <span class="xp-progress-label-center">${experiencePoints.toLocaleString('en-US')}</span>
          <span class="xp-progress-label-right">Next XP Level ${nextLevel} (${levelupXp.toLocaleString('en-US')})</span>
        </div>
        <div class="xp-progress-bar">
          <div class="xp-progress-fill" style="width: ${xpFillPercent}%"></div>
        </div>
      </div>
    `;
  }

  // Generate admin prefix
  const adminPrefix = isAdmin ? '<span class="admin-warning emoji-tooltip" data-tooltip="Game Admin">⚠️ ADMIN - </span>' : '';

  // Generate company type emojis
  let companyTypeHtml = '';
  if (companyType && Array.isArray(companyType)) {
    const typeEmojis = companyType.map(type => {
      if (type === 'container') return '<span class="emoji-tooltip" data-tooltip="Container">📦</span>';
      if (type === 'tanker') return '<span class="emoji-tooltip" data-tooltip="Tanker">🛢️</span>';
      return '';
    }).join('');
    companyTypeHtml = typeEmojis;
  }

  // Generate difficulty emoji
  let difficultyHtml = '';
  if (difficulty === 'easy') {
    difficultyHtml = '<span class="emoji-tooltip" data-tooltip="Easy Mode">✌️</span>';
  } else if (difficulty === 'hard') {
    difficultyHtml = '<span class="emoji-tooltip" data-tooltip="Hard Mode">🤟</span>';
  }

  // Generate made purchase emoji
  const purchaseHtml = madePurchase ? '<span class="emoji-tooltip" data-tooltip="Made Purchase">💸</span>' : '';

  // Generate IPO emoji (diagonal strikethrough if 0)
  const ipoHtml = ipo ? '<span class="emoji-tooltip" data-tooltip="IPO Active">📈</span>' : '<span class="emoji-strikethrough" data-tooltip="No IPO">📈</span>';

  // Generate guest emoji (diagonal strikethrough if not guest)
  const guestHtml = isGuest ? '<span class="emoji-tooltip" data-tooltip="Guest Account">👋</span>' : '<span class="emoji-strikethrough" data-tooltip="Not a Guest">👋</span>';

  content.innerHTML = `
    <div class="company-profile-card">
      <div class="company-profile-header">
        <h3 class="company-profile-name">${adminPrefix}${escapeHtml(companyName)} ${companyId ? `(ID ${companyId})` : ''}${companyTypeHtml}${difficultyHtml}${purchaseHtml}${ipoHtml}${guestHtml}</h3>
        ${ceoBadgeHtml}
      </div>

      ${xpProgressHtml}

      ${sectionsHtml}
    </div>
  `;
}

/**
 * Builds a section with title and all key-value pairs from an object
 * @param {string} title - Section title
 * @param {Object} data - Data object to display
 * @returns {string} HTML string for the section
 */
function buildSection(title, data) {
  // Skip fields shown elsewhere
  const skipFields = [
    'staff_training_points',
    'id', 'company_name', 'ceo_level', 'difficulty', 'company_type', 'made_purchase', 'is_admin',
    'experience_points', 'levelup_experience_points', 'current_level_experience_points',
    'level', // shown in star badge and XP bar
    'ipo', 'is_guest' // shown as emojis in header
  ];

  // Define field order for grouping related fields together
  const fieldOrder = [
    // Row 1
    'cash', 'status', 'points',
    // Row 2
    'checklist_done', 'language', 'hub',
    // Row 3
    'reputation', 'stock_value', 'stock_trend',
    // Row 4
    'stock_for_sale', 'stock_total', 'fuel',
    // Row 5
    'fuel_capacity', 'co2', 'co2_capacity',
    // Row 6
    'total_vessels', 'total_routes', 'total_departures',
    // Row 7
    'total_teus', 'total_barrels', 'created_at'
  ];

  // Stock fields that should be grayed out when IPO is null/0
  const stockFields = ['stock_value', 'stock_trend', 'stock_for_sale', 'stock_total'];
  const hasIpo = data.ipo && data.ipo !== 0;

  // Collect all stats
  const statsMap = new Map();

  for (const key of Object.keys(data)) {
    if (skipFields.includes(key)) continue;

    const value = data[key];
    const label = formatLabel(key);
    const formattedValue = formatValue(value);

    if (formattedValue !== null) {
      const isStockField = stockFields.includes(key);
      const isGrayed = isStockField && !hasIpo;

      statsMap.set(key, {
        label,
        formattedValue,
        isGrayed
      });
    }
  }

  // Sort stats by field order, unknown fields go at the end
  const sortedKeys = Array.from(statsMap.keys()).sort((a, b) => {
    const indexA = fieldOrder.indexOf(a);
    const indexB = fieldOrder.indexOf(b);
    if (indexA === -1 && indexB === -1) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  const stats = sortedKeys.map(key => {
    const stat = statsMap.get(key);
    const grayedClass = stat.isGrayed ? ' company-stat-grayed' : '';
    return `
      <div class="company-stat${grayedClass}">
        <span class="company-stat-label">${stat.label}</span>
        <span class="company-stat-value">${stat.formattedValue}</span>
      </div>
    `;
  });

  return `
    <div class="company-profile-section">
      ${title ? `<h4 class="company-profile-section-title">${title}</h4>` : ''}
      <div class="company-profile-stats">
        ${stats.join('')}
      </div>
    </div>
  `;
}

/**
 * Formats a key name into a readable label
 * @param {string} key - Object key
 * @returns {string} Formatted label
 */
function formatLabel(key) {
  // Keep CFO, COO, CMO, CTO in uppercase
  const upperCaseKeys = ['cfo', 'coo', 'cmo', 'cto'];
  if (upperCaseKeys.includes(key.toLowerCase())) {
    return key.toUpperCase();
  }

  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

/**
 * Formats a value for display
 * @param {any} value - Value to format
 * @returns {string|null} Formatted value or null if should be skipped
 */
function formatValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // Simple arrays (strings, numbers)
    if (typeof value[0] !== 'object') {
      return value.join(', ');
    }
    // Complex arrays - show count
    return `[${value.length} items]`;
  }

  // Objects
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  // Booleans
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  // Numbers
  if (typeof value === 'number') {
    return formatNumber(value);
  }

  // Strings - check if it's a date
  if (typeof value === 'string') {
    // ISO date format
    if (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      const date = new Date(value);
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    }
    return value;
  }

  return String(value);
}

/**
 * Builds the achievements section with detailed info
 * @param {Object} achievementsData - Achievements data from API
 * @returns {string} HTML string for achievements section
 */
function buildAchievementsSection(achievementsData) {
  const stats = [];

  // Summary stats
  if (achievementsData.total_points !== undefined) {
    stats.push(`
      <div class="achievement-card">
        <span class="achievement-card-label">Total Points</span>
        <span class="achievement-card-value">${formatNumber(achievementsData.total_points)}</span>
      </div>
    `);
  }

  if (achievementsData.total_points_user !== undefined) {
    stats.push(`
      <div class="achievement-card">
        <span class="achievement-card-label">User Points</span>
        <span class="achievement-card-value">${formatNumber(achievementsData.total_points_user)}</span>
      </div>
    `);
  }

  if (achievementsData.achievements_done !== undefined) {
    stats.push(`
      <div class="achievement-card">
        <span class="achievement-card-label">Achievements Done</span>
        <span class="achievement-card-value">${achievementsData.achievements_done}</span>
      </div>
    `);
  }

  // Individual achievements
  const achievementsList = achievementsData.achievements || [];
  const achievementsHtml = achievementsList.map(ach => {
    const completed = ach.time_completed ? 'completed' : 'incomplete';
    const completedDate = ach.time_completed
      ? new Date(ach.time_completed * 1000).toLocaleDateString()
      : '';
    const emoji = ach.time_completed ? '🏆' : '';

    const targetDisplay = ach.target ? `(${formatNumber(ach.target)})` : '';
    const progressText = ach.progress !== null ? `${ach.progress}/${ach.goal}` : `0/${ach.goal}`;

    return `
      <div class="achievement-item ${completed}">
        <span class="achievement-emoji">${emoji}</span>
        <span class="achievement-type">${formatLabel(ach.type)}</span>
        <span class="achievement-target">${targetDisplay}</span>
        <span class="achievement-progress">${progressText}</span>
        <span class="achievement-date">${completedDate}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="company-profile-section">
      <h4 class="company-profile-section-title">Achievements Summary</h4>
      <div class="achievement-summary-cards">
        ${stats.join('')}
      </div>
    </div>
    <div class="company-profile-section">
      <h4 class="company-profile-section-title collapsible-title" onclick="toggleAchievementsList(this)">
        All Achievements (${achievementsList.length})
        <span class="collapse-arrow">▼</span>
      </h4>
      <div class="achievements-list collapsible-content">
        ${achievementsHtml}
      </div>
    </div>
  `;
}

/**
 * Generates a morale smiley based on percentage
 * @param {number} percentage - Morale percentage (0-100)
 * @returns {string} HTML string for smiley
 */
function generateMoraleSmiley(percentage) {
  let faceClass = '';
  let mouthStyle = '';

  // Face color and glow based on percentage
  if (percentage >= 75) {
    faceClass = 'morale-smiley-happy';
  } else if (percentage >= 50) {
    faceClass = 'morale-smiley-neutral';
  } else if (percentage >= 35) {
    faceClass = 'morale-smiley-sad';
  } else if (percentage >= 25) {
    faceClass = 'morale-smiley-bad';
  } else {
    faceClass = 'morale-smiley-critical';
  }

  // Calculate mouth curve based on percentage (0-100)
  // At 100%: strong smile (large border-radius for happy curve)
  // At 50%: straight line
  // At 0%: strong frown (large border-radius for sad curve)

  let mouthClass = '';
  let borderRadius = 0;

  if (percentage >= 50) {
    // Happy mouth - curved down
    mouthClass = 'morale-mouth-happy';
    // Scale from 50% (flat, radius 0) to 100% (max smile, radius 15px)
    borderRadius = Math.round((percentage - 50) / 50 * 15);
    mouthStyle = `style="border-radius: 0 0 ${borderRadius}px ${borderRadius}px"`;
  } else {
    // Sad mouth - curved up
    mouthClass = 'morale-mouth-sad';
    // Scale from 0% (max frown, radius 15px) to 50% (flat, radius 0)
    borderRadius = Math.round((50 - percentage) / 50 * 15);
    mouthStyle = `style="border-radius: ${borderRadius}px ${borderRadius}px 0 0"`;
  }

  return `
    <span class="morale-smiley ${faceClass}">
      <span class="morale-eye morale-eye-left"></span>
      <span class="morale-eye morale-eye-right"></span>
      <span class="morale-mouth ${mouthClass}" ${mouthStyle}></span>
    </span>
  `;
}

/**
 * Builds the staff section with morale info and all staff details
 * @param {Object} staffData - Staff data from API (data.info and data.staff)
 * @param {Object} userData - User data from API (user object)
 * @returns {string} HTML string for staff section
 */
function buildStaffSection(staffData, userData) {
  const info = staffData.info || {};
  const staffList = staffData.staff || [];

  // Get training points from user data
  const trainingPoints = userData?.staff_training_points !== undefined ? userData.staff_training_points : 0;

  // Morale summary (exclude staff_training_points)
  const moraleSummary = [];
  if (info.crew) {
    const crewSmiley = generateMoraleSmiley(info.crew.percentage);
    moraleSummary.push(`
      <div class="company-stat morale-stat">
        <span class="company-stat-label">Crew Morale</span>
        <div class="morale-smiley-container">${crewSmiley}</div>
        <span class="company-stat-value">${info.crew.percentage}% (${formatLabel(info.crew.label)})</span>
      </div>
    `);
  }
  if (info.management) {
    const managementSmiley = generateMoraleSmiley(info.management.percentage);
    moraleSummary.push(`
      <div class="company-stat morale-stat">
        <span class="company-stat-label">Management Morale</span>
        <div class="morale-smiley-container">${managementSmiley}</div>
        <span class="company-stat-value">${info.management.percentage}% (${formatLabel(info.management.label)})</span>
      </div>
    `);
  }

  // Define staff order
  const staffOrder = ['cfo', 'coo', 'cmo', 'cto', 'captain', 'first_officer', 'boatswain', 'technical_officer'];

  // Sort staff by defined order
  const sortedStaff = [...staffList].sort((a, b) => {
    const indexA = staffOrder.indexOf(a.type);
    const indexB = staffOrder.indexOf(b.type);
    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
  });

  // Staff details
  const staffHtml = sortedStaff.map(staff => {
    const trainings = staff.training || [];

    // Check if staff has any trainable perks
    const hasTrainablePerks = trainings.some(t => t.can_train === true);

    // If no trainable perks, staff is locked
    if (!hasTrainablePerks) {
      return `
        <div class="staff-member staff-member-locked" data-staff-type="${staff.type}">
          <div class="staff-header">
            <span class="staff-type">${formatLabel(staff.type)}</span>
          </div>
          <div class="staff-locked-message">
            Unlock for 150 points in game
          </div>
        </div>
      `;
    }

    // Check if staff needs to be hired (morale is undefined)
    if (staff.morale === undefined) {
      return `
        <div class="staff-member staff-member-locked" data-staff-type="${staff.type}">
          <div class="staff-header">
            <span class="staff-type">${formatLabel(staff.type)}</span>
          </div>
          <div class="staff-locked-message">
            You have to hire the ${formatLabel(staff.type)} ingame
          </div>
        </div>
      `;
    }

    // Build training HTML with + button for trainable perks
    const trainingHtml = trainings.map(t => {
      const canTrain = t.can_train ? 'can-train' : 'locked';
      const hasPoints = trainingPoints > 0;
      const isMaxLevel = t.level >= t.max_level;

      let plusButton = '';
      if (!isMaxLevel && t.can_train) {
        plusButton = `<button class="training-level-btn ${hasPoints ? '' : 'disabled'}" data-staff-type="${staff.type}" data-perk-type="${t.perk}" ${!hasPoints ? 'disabled' : ''}>+</button>`;
      }

      return `
        <div class="training-item ${canTrain}">
          <span class="training-perk">${formatLabel(t.perk)}</span>
          <span class="training-plus">${plusButton}</span>
          <span class="training-level">${t.level}/${t.max_level}</span>
          <span class="training-effect">${t.current_effect}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="staff-member" data-staff-type="${staff.type}">
        <div class="staff-header">
          <span class="staff-type">${formatLabel(staff.type)}</span>
          ${staff.amount ? `<span class="staff-amount">${formatNumber(staff.amount)} staff</span>` : ''}
        </div>
        <div class="staff-details">
          <div class="staff-detail-item">
            <span class="staff-detail-label">Salary</span>
            <span class="staff-salary-controls">
              <button class="staff-salary-btn staff-salary-decrease" data-type="${staff.type}" title="Reduce salary">➖</button>
              <span class="staff-salary-value">$${formatNumber(staff.salary)}</span>
              <button class="staff-salary-btn staff-salary-increase" data-type="${staff.type}" title="Raise salary">➕</button>
            </span>
          </div>
          <div class="staff-detail-item">
            <span class="staff-detail-label">Morale</span>
            <span class="staff-detail-value">${staff.morale}%</span>
          </div>
          <div class="staff-detail-item">
            <span class="staff-detail-label">Training</span>
            <span class="staff-detail-value">${staff.training_current_level !== undefined ? `${staff.training_current_level}/${staff.training_max_level}` : 'N/A'}</span>
          </div>
        </div>
        ${trainings.length > 0 ? `
          <div class="staff-trainings">
            ${trainingHtml}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="company-profile-section">
      <h4 class="company-profile-section-title" style="text-align: center; padding-top: 10px;">Staff Morale</h4>
      <div class="company-profile-stats morale-stats-grid">
        ${moraleSummary.join('')}
      </div>
    </div>
    <div class="company-profile-section">
      <h4 class="company-profile-section-title collapsible-title" onclick="toggleStaffDetails(this)">
        Staff Details
        <span class="staff-points-display">Staff Points 💪 <span class="staff-points-value">${trainingPoints}</span></span>
        <span class="collapse-arrow">▼</span>
      </h4>
      <div class="staff-list collapsible-content">
        ${staffHtml}
      </div>
    </div>
  `;
}

/**
 * Toggles the Staff Details section
 * @param {HTMLElement} titleElement - The title element that was clicked
 */
function toggleStaffDetails(titleElement) {
  const content = titleElement.nextElementSibling;
  const arrow = titleElement.querySelector('.collapse-arrow');

  if (content.classList.contains('collapsed')) {
    content.classList.remove('collapsed');
    arrow.textContent = '▼';
  } else {
    content.classList.add('collapsed');
    arrow.textContent = '▶';
  }
}

/**
 * Toggles the Achievements List section
 * @param {HTMLElement} titleElement - The title element that was clicked
 */
function toggleAchievementsList(titleElement) {
  const content = titleElement.nextElementSibling;
  const arrow = titleElement.querySelector('.collapse-arrow');

  if (content.classList.contains('collapsed')) {
    content.classList.remove('collapsed');
    arrow.textContent = '▼';
  } else {
    content.classList.add('collapsed');
    arrow.textContent = '▶';
  }
}

// Make functions globally available
window.toggleStaffDetails = toggleStaffDetails;
window.toggleAchievementsList = toggleAchievementsList;

/**
 * Searches for players by name
 * @param {string} searchTerm - Search term
 */
async function searchPlayers(searchTerm) {
  const content = document.getElementById('companyProfileContent');
  const title = document.getElementById('companyProfileTitle');

  if (!searchTerm || searchTerm.trim().length < 2) {
    showSideNotification('Please enter at least 2 characters', 'error');
    return;
  }

  content.innerHTML = '<div class="company-profile-loading">Searching...</div>';
  title.textContent = 'Search Results';

  // Save current state to history
  if (currentView !== 'search') {
    navigationHistory.push({ view: currentView, userId: currentUserId });
  }
  currentView = 'search';

  try {
    const response = await fetch(window.apiUrl('/api/user/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: searchTerm.trim() })
    });

    if (!response.ok) throw new Error('Search failed');

    const data = await response.json();
    console.log('[Company Profile] Search results:', data);

    // Extract companies from nested structure
    searchResults = data.data?.companies || data.companies || data.users || data.results || [];

    renderSearchResults(searchResults);

  } catch (error) {
    console.error('[Company Profile] Search error:', error);
    content.innerHTML = '<div class="company-profile-error">Search failed</div>';
  }
}

/**
 * Renders search results
 * @param {Array} results - Search results (companies from API)
 */
function renderSearchResults(results) {
  const content = document.getElementById('companyProfileContent');

  if (!results || results.length === 0) {
    content.innerHTML = '<div class="company-profile-empty">No players found</div>';
    return;
  }

  const html = results.map(company => `
    <div class="search-result-item" data-user-id="${company.user_id || company.id}">
      <span class="search-result-name">${company.name || company.company_name || 'Unknown'}</span>
      ${company.ceo_level ? `<span class="search-result-level">Level ${company.ceo_level}</span>` : ''}
    </div>
  `).join('');

  content.innerHTML = `<div class="search-results-list">${html}</div>`;

  // Add click handlers
  content.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const userId = parseInt(item.dataset.userId);
      navigationHistory.push({ view: 'search', results: searchResults });
      currentView = 'profile';
      loadCompanyProfile(userId, false);
    });
  });
}

/**
 * Initializes the company profile module
 * Sets up event listeners
 */
export function initCompanyProfile() {
  // XP Star click handler
  const ceoLevelBadge = document.getElementById('ceoLevelBadge');
  if (ceoLevelBadge) {
    ceoLevelBadge.style.cursor = 'pointer';
    ceoLevelBadge.addEventListener('click', openCompanyProfile);
  }

  // Close button
  const closeBtn = document.getElementById('companyProfileCloseBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeCompanyProfile);
  }

  // Search input
  const searchInput = document.getElementById('companyProfileSearchInput');
  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        searchPlayers(searchInput.value);
      }
    });
  }

  // Search button
  const searchBtn = document.getElementById('companyProfileSearchBtn');
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      const searchInput = document.getElementById('companyProfileSearchInput');
      if (searchInput) {
        searchPlayers(searchInput.value);
      }
    });
  }

  // Close on overlay click (outside dialog)
  const overlay = document.getElementById('companyProfileOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeCompanyProfile();
      }
    });
  }

  console.log('[Company Profile] Module initialized');
}

/**
 * Opens the company profile overlay directly to a specific player
 * @param {number} userId - User ID to show
 */
export async function openPlayerProfile(userId) {
  const overlay = document.getElementById('companyProfileOverlay');
  if (!overlay) {
    console.error('[Company Profile] Overlay not found');
    return;
  }

  overlay.classList.remove('hidden');
  navigationHistory = [];
  currentView = 'profile';

  // Load the specific player's profile
  await loadCompanyProfile(userId, false);
}

// Export for global access
window.openCompanyProfile = openCompanyProfile;
window.closeCompanyProfile = closeCompanyProfile;
window.openPlayerProfile = openPlayerProfile;
