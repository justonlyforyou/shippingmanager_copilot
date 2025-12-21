/**
 * @fileoverview Alliance Cooperation Management
 *
 * Handles alliance coop vessel management including:
 * - Fetching coop data and statistics
 * - Displaying member list with coop information
 * - Managing coop vessel sends (placeholder for future implementation)
 *
 * @module coop
 * @requires utils - Formatting and feedback functions
 */

import { formatNumber, escapeHtml, showSideNotification } from './utils.js';
import { updateBadge } from './badge-manager.js';
import logger from './core/logger.js';

/**
 * Fetches coop data from the backend API
 *
 * @async
 * @returns {Promise<Object>} Coop data object
 * @throws {Error} If fetch fails
 */
export async function fetchCoopData() {
  try {
    const response = await fetch(window.apiUrl('/api/coop/data'));
    if (!response.ok) throw new Error('Failed to fetch coop data');
    return await response.json();
  } catch (error) {
    console.error('[Coop] Error fetching data:', error);
    throw error;
  }
}

/**
 * Updates the coop badge display (shows available count only if > 0)
 * Also updates the header display with available/cap format
 *
 * @async
 * @returns {Promise<void>}
 */
export async function updateCoopBadge() {
  try {
    const data = await fetchCoopData();
    const coop = data.data?.coop;

    if (!coop) {
      console.error('[Coop] No coop data in response');
      return;
    }

    // Update button badge using badge-manager (red if available > 0, green if all slots used)
    const color = coop.available === 0 ? 'GREEN' : 'RED';
    updateBadge('coopBadge', coop.available, coop.available > 0, color);

    // Header display is handled by badge only - no separate display needed
  } catch (error) {
    console.error('[Coop] Error updating badge:', error);
  }
}

/**
 * Renders a single member card
 * @param {Object} member - Member data
 * @param {boolean} showButton - Whether to show the send button
 * @param {boolean} disabled - Whether the send button should be disabled
 * @param {string} buttonText - Optional custom button text
 * @returns {string} HTML string for member card
 */
function renderMemberCard(member, showButton = true, disabled = false, buttonText = 'Send max') {
  const fuelFormatted = formatNumber(member.fuel);

  // Determine card border color class (only based on disabled state)
  let borderClass = 'coop-card-neutral';
  if (disabled) {
    borderClass = 'coop-card-disabled';
  }

  // Build restrictions display (ALWAYS show if present)
  let restrictionsHtml = '';
  if (member.restrictions && member.restrictions.length > 0) {
    restrictionsHtml = '<div class="coop-restrictions">';
    member.restrictions.forEach(r => {
      let message = r.message;

      // Format time restriction with local timezone
      if ((r.type === 'time_setting' || r.type === 'time_restriction') && r.startHourUTC !== undefined) {
        // Convert UTC hours to local time
        const now = new Date();
        const startUTC = new Date(now);
        startUTC.setUTCHours(r.startHourUTC, 0, 0, 0);
        const endUTC = new Date(now);
        endUTC.setUTCHours(r.endHourUTC === 0 ? 24 : r.endHourUTC, 0, 0, 0);

        const startLocal = String(startUTC.getHours()).padStart(2, '0') + ':00';
        const endLocal = String(endUTC.getHours()).padStart(2, '0') + ':00';

        message = `Only accepts ${startLocal}-${endLocal}`;
      }

      if (message) {
        restrictionsHtml += `<span class="coop-restriction-item">${escapeHtml(message)}</span>`;
      }
    });
    restrictionsHtml += '</div>';
  }

  // Button HTML
  let buttonHtml = '';
  if (showButton) {
    if (!disabled) {
      buttonHtml = `<button onclick="window.sendCoopMax(${member.user_id})" class="coop-send-btn" data-permanently-disabled="false">${buttonText}</button>`;
    } else {
      buttonHtml = `<button disabled class="coop-send-btn" data-permanently-disabled="true">${buttonText}</button>`;
    }
  }

  // Format cargo load for last season (in tons)
  const cargoLastSeasonTons = member.sent_cargo_load_last_season ? formatNumber(member.sent_cargo_load_last_season) : '0';

  return `
    <div class="coop-member-card ${borderClass}">
      <div class="coop-card-content">
        <div class="coop-card-info">
          <div class="coop-member-name">${escapeHtml(member.company_name)}</div>
          <div class="coop-member-stats">
            <div class="coop-stat-row">
              <span class="coop-stat-icon">Co-ops:</span>
              <span class="coop-stat-detail">${member.sent_this_season || 0}/${member.received_this_season || 0} season | ${member.sent_historical || 0}/${member.received_historical || 0} total</span>
            </div>
            <div class="coop-stat-row">
              <span class="coop-stat-icon">Fleet:</span>
              <span class="coop-stat-detail">${member.total_vessels} vessels | ${fuelFormatted}t fuel</span>
            </div>
            ${member.donations_historical > 0 || member.donations_this_season > 0 ? `
            <div class="coop-stat-row">
              <span class="coop-stat-icon">Donations:</span>
              <span class="coop-stat-detail">${member.donations_this_season || 0} season | ${member.donations_historical || 0} total</span>
            </div>
            ` : ''}
            ${member.sent_cargo_load_last_season > 0 ? `
            <div class="coop-stat-row">
              <span class="coop-stat-icon">Last season:</span>
              <span class="coop-stat-detail">${member.sent_last_season || 0} co-ops | ${cargoLastSeasonTons}t cargo</span>
            </div>
            ` : ''}
          </div>
          ${restrictionsHtml}
        </div>
        ${buttonHtml}
      </div>
    </div>
  `;
}

/**
 * Shows the coop overlay with member list
 *
 * @async
 * @returns {Promise<void>}
 */
export async function showCoopOverlay() {
  const overlay = document.getElementById('coopOverlay');
  const content = document.getElementById('coopContent');

  if (!overlay || !content) {
    console.error('[Coop] Overlay elements not found');
    return;
  }

  try {
    const data = await fetchCoopData();
    const coop = data.data?.coop;
    const members = data.data?.members_coop || [];

    if (!coop) {
      content.innerHTML = '<p style="color: #ef4444;">Failed to load coop data</p>';
      overlay.classList.remove('hidden');
      return;
    }

    // Get own user ID from API response
    const myUserId = data.user?.id;

    // Separate members into categories
    const activeMembers = [];
    const disabledMembers = [];
    const outOfOrderMembers = [];
    let myUser = null;

    members.forEach(member => {
      // Save own user separately
      if (member.user_id === myUserId) {
        myUser = member;
        return;
      }

      if (!member.enabled) {
        // COOP disabled
        disabledMembers.push(member);
      } else {
        // COOP enabled - check if has BLOCKING restrictions
        // Only blocking restrictions move user to "Out of Order"
        // Settings like time/capacity are shown but don't block if currently OK
        const hasBlockingRestrictions = member.restrictions.some(r => {
          // Blocking types: no_vessels, low_fuel, time_restriction (when outside time range)
          // Non-blocking types: time_setting (inside range), capacity_setting (just a filter)
          if (r.blocking === true || r.type === 'low_fuel' || r.type === 'time_restriction' || r.type === 'no_vessels') {
            return true;
          }

          // Check if time_setting is currently blocking (outside acceptance window)
          if (r.type === 'time_setting' && r.startHourUTC !== undefined && r.endHourUTC !== undefined) {
            const now = new Date();
            const currentHourUTC = now.getUTCHours();

            // Check if current time is within acceptance window
            // Handle overnight ranges (e.g., 23:00-07:00 = 23,24,0,1,2,3,4,5,6)
            let isWithinWindow = false;
            if (r.startHourUTC <= r.endHourUTC) {
              // Normal range (e.g., 09:00-17:00)
              isWithinWindow = currentHourUTC >= r.startHourUTC && currentHourUTC < r.endHourUTC;
            } else {
              // Overnight range (e.g., 23:00-07:00)
              isWithinWindow = currentHourUTC >= r.startHourUTC || currentHourUTC < r.endHourUTC;
            }

            // If NOT within window, it's blocking
            return !isWithinWindow;
          }

          return false;
        });

        if (hasBlockingRestrictions) {
          // Has actual blocking restrictions - Out of Order
          outOfOrderMembers.push(member);
        } else {
          // Active (may have settings/filters but currently OK)
          activeMembers.push(member);
        }
      }
    });

    // Calculate top 5 by cargo load last season
    const top5CargoLastSeason = [...members]
      .filter(m => m.sent_cargo_load_last_season > 0)
      .sort((a, b) => b.sent_cargo_load_last_season - a.sent_cargo_load_last_season)
      .slice(0, 5);

    // Calculate top 5 by donations last season
    const top5DonationsLastSeason = [...members]
      .filter(m => m.donations_last_season > 0)
      .sort((a, b) => b.donations_last_season - a.donations_last_season)
      .slice(0, 5);

    let html = `
      <div class="coop-stats-box">
        <h3 class="coop-stats-title">Your Co-Op Stats</h3>
        <table class="coop-stats-table">
          <tr>
            <td class="coop-stat-label">Co-Op total:</td>
            <td class="coop-stat-value coop-stat-max">${coop.coop_boost || coop.cap}</td>
            <td class="coop-stat-label">Co-Op available:</td>
            <td class="coop-stat-value coop-stat-available">${coop.available}</td>
          </tr>
          <tr>
            <td class="coop-stat-label">Sent this season:</td>
            <td class="coop-stat-value coop-stat-sent">${coop.sent_this_season || 0}</td>
            <td class="coop-stat-label">Received this season:</td>
            <td class="coop-stat-value coop-stat-received">${coop.received_this_season || 0}</td>
          </tr>
          <tr>
            <td class="coop-stat-label">Sent historical:</td>
            <td class="coop-stat-value coop-stat-sent-hist">${coop.sent_historical || 0}</td>
            <td class="coop-stat-label">Received historical:</td>
            <td class="coop-stat-value coop-stat-received-hist">${coop.received_historical || 0}</td>
          </tr>
        </table>
      </div>
    `;

    // Top 5 Last Season section
    if (top5CargoLastSeason.length > 0 || top5DonationsLastSeason.length > 0) {
      html += `<div class="coop-top5-container">`;

      if (top5CargoLastSeason.length > 0) {
        html += `
          <div class="coop-top5-box">
            <h4 class="coop-top5-title">Top 5 Co-ops Last Season</h4>
            <ol class="coop-top5-list">
              ${top5CargoLastSeason.map((m, i) => `
                <li class="coop-top5-item">
                  <span class="coop-top5-rank">${i + 1}</span>
                  <span class="coop-top5-name">${escapeHtml(m.company_name)}</span>
                  <span class="coop-top5-value">${formatNumber(m.sent_cargo_load_last_season)}t</span>
                </li>
              `).join('')}
            </ol>
          </div>
        `;
      }

      if (top5DonationsLastSeason.length > 0) {
        html += `
          <div class="coop-top5-box">
            <h4 class="coop-top5-title">Top 5 Donations Last Season</h4>
            <ol class="coop-top5-list">
              ${top5DonationsLastSeason.map((m, i) => `
                <li class="coop-top5-item">
                  <span class="coop-top5-rank">${i + 1}</span>
                  <span class="coop-top5-name">${escapeHtml(m.company_name)}</span>
                  <span class="coop-top5-value">${formatNumber(m.donations_last_season)}</span>
                </li>
              `).join('')}
            </ol>
          </div>
        `;
      }

      html += `</div>`;
    }

    // Members header with count
    html += `<h3 class="coop-members-header">Members (${members.length})</h3>`;

    // Render active members
    if (activeMembers.length > 0) {
      html += `<h3 class="coop-section-header coop-section-active">✓ Active (${activeMembers.length})</h3>`;
      activeMembers.sort((a, b) => b.total_vessels - a.total_vessels);

      activeMembers.forEach(member => {
        // Check if member has blocking restrictions
        const hasBlockingRestriction = member.restrictions.some(r =>
          r.blocking === true || r.type === 'no_vessels'
        );

        // Disable button if no COOP available OR member has blocking restrictions
        const shouldDisableButton = coop.available === 0 || hasBlockingRestriction;

        // Custom button text if no COOP available
        const buttonText = coop.available === 0 ? 'No Coop Tickets<br>available' : 'Send max';

        html += renderMemberCard(member, true, shouldDisableButton, buttonText);
      });
    }

    // Render out of order members
    if (outOfOrderMembers.length > 0) {
      html += `<h3 class="coop-section-header coop-section-warning">⚠️ Out of Order (${outOfOrderMembers.length})</h3>`;
      outOfOrderMembers.sort((a, b) => b.total_vessels - a.total_vessels);

      outOfOrderMembers.forEach(member => {
        html += renderMemberCard(member, true, true);
      });
    }

    // Render disabled members
    if (disabledMembers.length > 0) {
      html += `<h3 class="coop-section-header coop-section-disabled">✕ COOP Disabled (${disabledMembers.length})</h3>`;
      disabledMembers.sort((a, b) => b.total_vessels - a.total_vessels);

      disabledMembers.forEach(member => {
        html += renderMemberCard(member, true, true);
      });
    }

    // Render own user at the bottom
    if (myUser) {
      html += `<h3 class="coop-section-header coop-section-you">👤 You</h3>`;
      html += renderMemberCard(myUser, false, false);
    }

    if (activeMembers.length === 0 && outOfOrderMembers.length === 0 && disabledMembers.length === 0) {
      html += '<p class="coop-empty-message">No members available for coop</p>';
    }

    content.innerHTML = html;
    overlay.classList.remove('hidden');

  } catch (error) {
    console.error('[Coop] Error showing overlay:', error);
    content.innerHTML = '<p style="color: #ef4444;">Failed to load coop data. Please try again.</p>';
    overlay.classList.remove('hidden');
  }
}

/**
 * Closes the coop overlay
 *
 * @returns {void}
 */
export function closeCoopOverlay() {
  const overlay = document.getElementById('coopOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

/**
 * Sends maximum available coop vessels to a specific user
 *
 * @async
 * @param {number} userId - Target user ID
 * @returns {Promise<void>}
 */
export async function sendCoopMax(userId) {
  try {
    const response = await fetch(window.apiUrl('/api/coop/send-max'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: userId })
    });

    const data = await response.json();

    if (!response.ok) {
      // Format error message with Alliance Coop header (use <br> for line breaks)
      const errorMsg = `🤝 Alliance Coop<br><br>ERROR!<br><br>${data.error || 'Unknown error'}<br>${data.target_user ? `COOP not available for ${data.target_user}` : 'COOP operation failed'}`;
      showSideNotification(errorMsg, 'error');

      // Refresh overlay to update button states (available may have changed)
      const coopOverlay = document.getElementById('coopOverlay');
      const isAllianceTabsOpen = coopOverlay && !coopOverlay.classList.contains('hidden');
      if (isAllianceTabsOpen && window.switchTab) {
        await window.switchTab('coop');
      } else {
        await showCoopOverlay();
      }
      return;
    }

    // Show success notification
    const departed = data.departed || 0;
    if (departed === 0) {
      showSideNotification(`No vessels sent - target user has no vessels ready to depart`, 'warning');
    } else {
      const partial = data.partial ? ` (requested ${data.requested})` : '';
      showSideNotification(`Successfully sent ${departed} coop vessel${departed !== 1 ? 's' : ''}${partial}`, 'success');
    }

    // Update badge immediately (don't wait for WebSocket)
    await updateCoopBadge();

    // Check if new alliance tabs overlay is open
    const coopOverlay = document.getElementById('coopOverlay');
    const isAllianceTabsOpen = coopOverlay && !coopOverlay.classList.contains('hidden');

    if (isAllianceTabsOpen && window.switchTab) {
      // Reload coop tab in new alliance tabs overlay
      await window.switchTab('coop');
    } else {
      // Refresh old overlay to show updated counts
      await showCoopOverlay();
    }

  } catch (error) {
    console.error('[Coop] Error sending max vessels:', error);
    showSideNotification(`Network error sending coop vessels`, 'error');
  }
}

/**
 * Locks all COOP send buttons when COOP send process starts.
 * Called by WebSocket handler when 'coop_send_start' is received.
 * @global
 */
export function lockCoopButtons() {
  const coopButtons = document.querySelectorAll('.coop-send-btn');
  coopButtons.forEach(btn => {
    btn.disabled = true;
  });
  logger.debug('[COOP Buttons] Locked - coop send in progress');
}

/**
 * Unlocks all COOP send buttons when COOP send process completes.
 * Called by WebSocket handler when 'coop_send_complete' is received.
 * @global
 */
export function unlockCoopButtons() {
  const coopButtons = document.querySelectorAll('.coop-send-btn');
  coopButtons.forEach(btn => {
    // Only re-enable buttons that are NOT permanently disabled
    // Permanently disabled = OUT OF ORDER, no vessels, not enabled, etc.
    const isPermanentlyDisabled = btn.getAttribute('data-permanently-disabled') === 'true';
    if (!isPermanentlyDisabled) {
      btn.disabled = false;
    }
  });
  logger.debug('[COOP Buttons] Unlocked - coop send complete');
}
