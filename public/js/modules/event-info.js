/**
 * @fileoverview Event Information Module
 *
 * Displays complete event information in a modal window.
 * Shows all event details including ports, discounts, timing, and demand multipliers.
 *
 * @module event-info
 */

import { escapeHtml , toGameCode } from './utils.js';
import logger from './core/logger.js';

let currentEventData = null;
let timerInterval = null;

/**
 * Updates stored event data
 * @param {Object|null} eventData - Complete event object from /game/index
 */
export function updateEventData(eventData) {
    currentEventData = eventData;

    // Get banner container
    const container = document.getElementById('eventBannerContainer');

    if (!container) {
        console.warn('[Event] Event banner container not found');
        return;
    }

    // Check if event has ended (private sales never end, so no time_end check for them)
    const now = Math.floor(Date.now() / 1000);
    const isPrivateSale = eventData && eventData.isPrivateSale === true;
    const eventEnded = !isPrivateSale && eventData && eventData.time_end && (eventData.time_end <= now);

    // Only create banner if we have event data AND a valid, non-empty event name AND event hasn't ended
    if (eventData && eventData.name && eventData.name.trim() !== '' && !eventEnded) {
        // Format event name (replace underscores, capitalize)
        const formattedName = eventData.name
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        // Create banner dynamically
        container.innerHTML = `
            <button id="eventBannerBtn" class="event-banner-btn">
                <div class="event-banner-content">
                    <span class="event-banner-label">Event</span>
                    <span id="eventBannerText" class="event-banner-name">${escapeHtml(formattedName)}</span>
                </div>
            </button>
        `;

        // Attach click handler to newly created banner
        const banner = document.getElementById('eventBannerBtn');
        if (banner) {
            banner.addEventListener('click', openEventModal);
        }
    } else {
        // Remove banner if no event, no event name, or event has ended
        container.innerHTML = '';
    }
}

/**
 * Opens the event information modal
 */
export function openEventModal() {
    const overlay = document.getElementById('eventOverlay');
    const content = document.getElementById('eventInfoContent');

    if (!overlay || !content) return;

    overlay.classList.remove('hidden');

    // Clear any existing timer
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    if (!currentEventData) {
        content.innerHTML = '<p style="text-align: center; color: #999;">No active event</p>';
        return;
    }

    // Parse ports from JSON string
    let ports = [];
    try {
        ports = JSON.parse(currentEventData.ports || '[]');
    } catch (e) {
        console.error('[Event] Failed to parse ports:', e);
    }

    // Capitalize port names
    const capitalizedPorts = ports.map(port => {
        return toGameCode(port);
    });

    // Calculate time remaining from time_end (live calculation, not cached ends_in)
    const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
    const endsIn = Math.max(0, currentEventData.time_end - now);

    // Debug logging
    const nowDate = new Date(now * 1000);
    const endDateObj = new Date(currentEventData.time_end * 1000);
    console.log(`[Event] Current time: ${nowDate.toISOString()} (${now})`);
    console.log(`[Event] Event ends: ${endDateObj.toISOString()} (${currentEventData.time_end})`);
    console.log(`[Event] Seconds remaining: ${endsIn}`);

    const days = Math.floor(endsIn / 86400);
    const hours = Math.floor((endsIn % 86400) / 3600);
    const minutes = Math.floor((endsIn % 3600) / 60);
    const seconds = endsIn % 60;
    const timeRemaining = `${days} (d) ${hours} (h) ${minutes} (m) ${seconds} (s)`;

    // Format dates
    const startDate = new Date(currentEventData.time_start * 1000).toLocaleString('de-DE');
    const endDate = new Date(currentEventData.time_end * 1000).toLocaleString('de-DE');

    // Format name and type (replace underscores, capitalize)
    const formatName = (str) => {
        return toGameCode(str);
    };

    // Capitalize first letter
    const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

    // Build HTML - single content area with styled sections
    let html = `
        <div class="event-info-container">
    `;

    // Title - only show if name exists
    if (currentEventData.name) {
        html += `<h3 class="event-info-title"><strong>${escapeHtml(formatName(currentEventData.name))}</strong></h3>`;
    }

    html += `<div class="event-info-grid">`;

    // Type
    if (currentEventData.type) {
        html += `
                <span class="event-info-label">Type:</span>
                <span class="event-info-value">${escapeHtml(formatName(currentEventData.type))}</span>
        `;
    }

    // Discount Type
    if (currentEventData.discount_type) {
        html += `
                <span class="event-info-label">Discount Type:</span>
                <span class="event-info-value-highlight">${escapeHtml(capitalize(currentEventData.discount_type))}</span>
        `;
    }

    // Discount Amount
    if (currentEventData.discount_percentage) {
        html += `
                <span class="event-info-label">Discount Amount:</span>
                <span class="event-info-value-highlight">${currentEventData.discount_percentage}%</span>
        `;
    }

    // Demand Type (capacity_type)
    if (currentEventData.capacity_type) {
        html += `
                <span class="event-info-label">Demand Type:</span>
                <span class="event-info-value">${escapeHtml(capitalize(currentEventData.capacity_type))}</span>
        `;
    }

    // Daily Demand Multiplier
    if (currentEventData.daily_demand_multiplier) {
        html += `
                <span class="event-info-label">Daily Demand Multiplier:</span>
                <span class="event-info-value-highlight">${currentEventData.daily_demand_multiplier}x</span>
        `;
    }

    // Started
    html += `
                <span class="event-info-label">Started:</span>
                <span class="event-info-value">${startDate}</span>
    `;

    // Ends
    html += `
                <span class="event-info-label">Ends:</span>
                <span class="event-info-value">${endDate}</span>
    `;

    // Ends In
    html += `
                <span class="event-info-label">Ends In:</span>
                <span id="eventTimer" class="event-timer">${timeRemaining}</span>
            </div>
        </div>
    `;

    // Only show ports section if there are ports
    if (ports.length > 0) {
        html += `
        <div class="event-ports-container">
            <h4 class="event-ports-title">Participating Ports (${ports.length})</h4>
            <div class="event-ports-grid">
        `;

        capitalizedPorts.forEach((port, index) => {
            // If this is the last port and the total count is odd, span both columns
            const isLastAndOdd = (index === capitalizedPorts.length - 1) && (capitalizedPorts.length % 2 !== 0);
            const fullClass = isLastAndOdd ? ' event-port-item-full' : '';
            html += `<div class="event-port-item${fullClass}">${port}</div>`;
        });

        html += `
            </div>
        </div>
        `;
    }

    content.innerHTML = html;

    // Start countdown timer (calculate live from time_end)
    startEventTimer();
}

/**
 * Starts the event countdown timer
 * Calculates remaining time live from time_end (not cached ends_in)
 */
function startEventTimer() {
    const updateTimer = () => {
        if (!currentEventData || !currentEventData.time_end) return;

        // Calculate remaining time live
        const now = Math.floor(Date.now() / 1000);
        const remainingSeconds = Math.max(0, currentEventData.time_end - now);

        const days = Math.floor(remainingSeconds / 86400);
        const hours = Math.floor((remainingSeconds % 86400) / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = remainingSeconds % 60;

        const timerElement = document.getElementById('eventTimer');
        if (timerElement) {
            if (remainingSeconds > 0) {
                timerElement.textContent = `${days} (d) ${hours} (h) ${minutes} (m) ${seconds} (s)`;
            } else {
                timerElement.textContent = 'Event Ended';
                clearInterval(timerInterval);
            }
        }
    };

    // Clear any existing timer
    if (timerInterval) {
        clearInterval(timerInterval);
    }

    // Update immediately and then every second
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

/**
 * Initialize event info module
 */
export function initEventInfo() {
    // Banner click handler is now attached dynamically when banner is created
    // (see updateEventData function)

    // Close button
    const closeBtn = document.getElementById('closeEventBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            const overlay = document.getElementById('eventOverlay');
            overlay.classList.add('hidden');
        });
    }

    // Make openEventModal available globally
    window.openEventModal = openEventModal;

    logger.debug('[Event Info] Module initialized');
}
