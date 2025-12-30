/**
 * @fileoverview Hijacking Management - Blackbeard's Phone Booth
 *
 * Manages the hijacking inbox system, separate from messenger.
 * Shows all hijacking cases (open + closed) in dedicated overlay.
 *
 * Key Features:
 * - Dedicated hijacking inbox overlay
 * - Badge count for open cases only
 * - Case list format: [CASE_ID] [OPEN|CLOSED] Vessel Name - $Amount
 * - Delete functionality for closed cases
 * - Click to view full case details
 *
 * @module public/js/modules/hijacking
 */

import { openExistingChat } from './messenger.js';
import { showConfirmDialog } from './ui-dialogs.js';
import { updateBadge, updateButtonTooltip } from './badge-manager.js';
import { showSideNotification } from './utils.js';

let allCases = [];
let ownUserId = null;

/**
 * Opens the hijacking inbox overlay.
 * Fetches all cases and displays them in a list.
 */
export async function openHijackingInbox() {
  try {
    const response = await fetch('/api/hijacking/get-cases');
    const data = await response.json();

    allCases = data.cases || [];
    ownUserId = data.own_user_id;

    // Show overlay
    document.getElementById('hijackingOverlay').classList.remove('hidden');

    // Render case list
    renderCaseList(allCases);
  } catch (error) {
    console.error('[Hijacking] Error fetching cases:', error);
    document.getElementById('hijackingFeed').innerHTML =
      '<div class="empty-message" style="color: #ef4444;">Failed to load hijacking cases</div>';
  }
}

/**
 * Closes the hijacking inbox overlay.
 */
export function closeHijackingInbox() {
  document.getElementById('hijackingOverlay').classList.add('hidden');
}

/**
 * Renders the hijacking case list.
 *
 * @param {Array} cases - Array of hijacking cases with details
 */
function renderCaseList(cases) {
  const feed = document.getElementById('hijackingFeed');

  if (cases.length === 0) {
    feed.innerHTML = `
      <div class="empty-message" style="padding: 50px; text-align: center; color: #9ca3af;">
        <div style="font-size: 48px; margin-bottom: 20px;">☠️</div>
        <div style="font-size: 16px;">Blackbeard's Chest is empty today.</div>
      </div>
    `;
    return;
  }

  feed.innerHTML = cases.map((caseData, index) => {
    const caseId = caseData.values.case_id;
    const vesselName = caseData.values.vessel_name;
    const originalDemand = caseData.values.requested_amount; // Original demand from first pirate offer
    const paidAmount = caseData.caseDetails.paid_amount;
    const finalAmount = caseData.caseDetails.requested_amount; // Final amount (what was actually paid)
    const isOpen = caseData.isOpen;

    // Status emoji and label
    const statusEmoji = isOpen ? '⌛' : '✅';
    const amountLabel = isOpen ? 'Ransom Demand:' : 'Settled:';

    // Amount to display
    // For open cases: show original demand
    // For closed cases: show paid_amount if available, otherwise final requested_amount
    const displayAmount = isOpen ? originalDemand : (paidAmount || finalAmount);
    const amountColor = isOpen ? '#fbbf24' : '#4ade80';

    return `
      <div class="chat-selection-item ${isOpen ? 'hijacking-case-open' : 'hijacking-case-closed'}"
           data-case-index="${index}"
           style="position: relative; padding-right: 40px; cursor: pointer;">
        <div style="flex: 1;" class="case-clickable">
          <h3 style="margin: 0 0 3px 0; font-size: 14px; line-height: 1.4;">
            ${escapeHtml(vesselName)} <span style="color: #9ca3af;">[${caseId}]</span> ${statusEmoji}
          </h3>
          <p style="margin: 0 0 3px 0; font-size: 12px; color: ${amountColor}; font-weight: 500;">
            ${amountLabel} $${displayAmount.toLocaleString()}
          </p>
          <p style="margin: 0; font-size: 11px; opacity: 0.7; color: #9ca3af;">
            ${formatTimestamp(caseData.time_last_message)}
          </p>
        </div>
        ${!isOpen ? `
          <button class="delete-case-btn" data-case-index="${index}"
                  style="position: absolute; right: 10px; top: 50%;
                         transform: translateY(-50%); background: transparent;
                         border: none; color: #ef4444; padding: 4px;
                         cursor: pointer; font-size: 20px;"
                  title="Delete case">🗑️</button>
        ` : ''}
      </div>
    `;
  }).join('');

  // Add click handlers for opening case details
  feed.querySelectorAll('.case-clickable').forEach((element) => {
    element.addEventListener('click', () => {
      const item = element.closest('.chat-selection-item');
      const caseIndex = parseInt(item.dataset.caseIndex);
      openCaseDetails(cases[caseIndex]);
    });
  });

  // Add delete handlers for CLOSED cases
  feed.querySelectorAll('.delete-case-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const caseIndex = parseInt(btn.dataset.caseIndex);
      await deleteCase(cases[caseIndex]);
    });
  });
}

/**
 * Opens full case details in messenger overlay.
 * Reuses existing hijacking message display logic.
 *
 * @param {Object} caseData - Case data with values and caseDetails
 */
function openCaseDetails(caseData) {
  // Set flag so back button returns to hijacking inbox
  window.cameFromHijackingInbox = true;

  // Close hijacking overlay
  closeHijackingInbox();

  // Ensure caseData has required fields for displaySystemMessage
  const chatData = {
    ...caseData,
    system_chat: true,
    body: 'vessel_got_hijacked',
    subject: `Hijacking Case #${caseData.values.case_id}`
  };

  // Open in messenger overlay using existing display logic
  openExistingChat('Gameplay', null, chatData, ownUserId);

  // Add class to make window narrower for hijacking cases
  const messengerOverlay = document.getElementById('messengerOverlay');
  if (messengerOverlay) {
    messengerOverlay.classList.add('hijacking-case-view');
  }
}

/**
 * Deletes a CLOSED hijacking case.
 * Shows confirmation dialog before deletion.
 *
 * @param {Object} caseData - Case data to delete
 */
async function deleteCase(caseData) {
  const confirmed = await showConfirmDialog({
    title: '☠️ Delete Hijacking Case',
    message: `Delete case ${caseData.values.case_id} for <strong>${escapeHtml(caseData.values.vessel_name)}</strong>?<br><br>This cannot be undone.`,
    confirmText: 'Delete',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  try {
    const response = await fetch('/api/messenger/delete-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_ids: [],
        system_message_ids: [caseData.id],
        case_id: caseData.values.case_id
      })
    });

    if (!response.ok) {
      throw new Error('Failed to delete case');
    }

    console.log(`[Hijacking] Deleted case ${caseData.values.case_id}`);
    showSideNotification(`Case ${caseData.values.case_id} deleted`, 'success');

    // Refresh the list
    await openHijackingInbox();

    // Update badge
    await refreshHijackingBadge();
  } catch (error) {
    console.error('[Hijacking] Error deleting case:', error);
    showSideNotification('Failed to delete hijacking case', 'error');
  }
}

/**
 * Updates the hijacking badge count.
 * Called by WebSocket updates and after deletions.
 *
 * @param {Object} data - Optional data with openCases and totalCases counts
 */
export function updateHijackingBadge(data) {
  if (data) {
    const openCases = data.openCases || 0;

    // Update badge using badge-manager
    updateBadge('hijackingBadge', openCases, openCases > 0, 'RED');

    // Update tooltip
    const tooltip = openCases > 0
      ? `Blackbeard's Phone Booth (${openCases} open case${openCases === 1 ? '' : 's'})`
      : 'Blackbeard\'s Phone Booth';
    updateButtonTooltip('hijacking', tooltip);
  }
}

/**
 * Refreshes the hijacking badge by fetching current case counts.
 * Used after manual deletions.
 */
async function refreshHijackingBadge() {
  try {
    const response = await fetch('/api/hijacking/get-cases');
    const data = await response.json();

    const cases = data.cases || [];
    const openCases = cases.filter(c => c.isOpen).length;

    updateHijackingBadge({
      openCases: openCases,
      totalCases: cases.length
    });
  } catch (error) {
    console.error('[Hijacking] Error refreshing badge:', error);
  }
}

/**
 * Updates the header hijacked vessels display.
 * Shows pirate emoji with count and glow effect.
 *
 * @param {Object} data - Data with hijackedCount
 */
export function updateHijackedVesselsDisplay(data) {
  const display = document.getElementById('hijackedVesselsDisplay');
  const icon = document.getElementById('hijackedIcon');
  const count = document.getElementById('hijackedCount');

  if (!display || !icon || !count) return;

  const hijackedCount = data.hijackedCount || 0;

  if (hijackedCount > 0) {
    display.classList.remove('hidden');
    count.textContent = hijackedCount;
    icon.className = 'hijacked-glow';
  } else {
    display.classList.add('hidden');
    icon.className = '';
  }
}

/**
 * Escapes HTML to prevent XSS.
 *
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Formats Unix timestamp to readable date/time.
 *
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Formatted date string
 */
function formatTimestamp(timestamp) {
  if (!timestamp || timestamp === 0) {
    return 'Unknown';
  }
  const date = new Date(timestamp * 1000);
  if (isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}
