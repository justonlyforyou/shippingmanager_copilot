/**
 * @fileoverview Broadcast Templates Module
 * Manages broadcast message templates for sending to all alliance members via DM.
 *
 * @module broadcast
 */

import { showSideNotification, escapeHtml } from './utils.js';

let templates = {};

/**
 * Load broadcast templates from server
 */
async function loadTemplates() {
  try {
    const response = await fetch('/api/broadcast/templates');
    const data = await response.json();
    templates = data.templates || {};
    renderTemplateList();
  } catch (error) {
    console.error('[Broadcast] Failed to load templates:', error);
    templates = {};
    renderTemplateList();
  }
}

/**
 * Render the template list in the UI
 */
function renderTemplateList() {
  const container = document.getElementById('broadcastTemplateList');
  if (!container) return;

  const keys = Object.keys(templates);

  if (keys.length === 0) {
    container.innerHTML = `<div style="color: #6b7280; font-size: 13px; text-align: center; padding: 20px;">No templates yet. Create one below.</div>`;
    return;
  }

  let html = '';

  keys.forEach(key => {
    const template = templates[key];
    const isEnabled = template.enabled === true;
    const enabledStyle = isEnabled
      ? 'background: rgba(16, 185, 129, 0.2); border-color: rgba(16, 185, 129, 0.4); color: #10b981;'
      : 'background: rgba(107, 114, 128, 0.2); border-color: rgba(107, 114, 128, 0.4); color: #6b7280;';
    const enabledText = isEnabled ? 'ON' : 'OFF';

    html += `
      <div class="broadcast-template-item" data-key="${escapeHtml(key)}" style="background: rgba(31, 41, 55, 0.5); border-radius: 8px; padding: 12px; margin-bottom: 10px; ${!isEnabled ? 'opacity: 0.6;' : ''}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
          <div>
            <div style="color: #a78bfa; font-weight: 600; font-size: 14px;">!msg ${escapeHtml(key)} <span style="color: #6b7280; font-weight: normal;">[userID]</span></div>
            <div style="color: #9ca3af; font-size: 12px; margin-top: 2px;">Subject: ${escapeHtml(template.subject)}</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="broadcast-toggle-btn" data-key="${escapeHtml(key)}" style="
              padding: 6px 12px;
              ${enabledStyle}
              border: 1px solid;
              border-radius: 4px;
              cursor: pointer;
              font-size: 12px;
              font-weight: 600;
            ">${enabledText}</button>
            <button class="broadcast-edit-btn" data-key="${escapeHtml(key)}" style="
              padding: 6px 12px;
              background: rgba(59, 130, 246, 0.2);
              border: 1px solid rgba(59, 130, 246, 0.4);
              border-radius: 4px;
              color: #60a5fa;
              cursor: pointer;
              font-size: 12px;
              font-weight: 600;
            ">Edit</button>
            <button class="broadcast-delete-btn" data-key="${escapeHtml(key)}" style="
              padding: 6px 12px;
              background: rgba(239, 68, 68, 0.2);
              border: 1px solid rgba(239, 68, 68, 0.4);
              border-radius: 4px;
              color: #ef4444;
              cursor: pointer;
              font-size: 12px;
              font-weight: 600;
            ">X</button>
          </div>
        </div>
        <div style="color: #d1d5db; font-size: 13px; white-space: pre-wrap; max-height: 60px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(template.message)}</div>
      </div>
    `;
  });

  container.innerHTML = html;

  // Attach event listeners
  container.querySelectorAll('.broadcast-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleTemplate(btn.dataset.key));
  });

  container.querySelectorAll('.broadcast-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => editTemplate(btn.dataset.key));
  });

  container.querySelectorAll('.broadcast-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteTemplate(btn.dataset.key));
  });
}

/**
 * Toggle template enabled state
 * @param {string} key - Template key
 */
async function toggleTemplate(key) {
  try {
    const response = await fetch(`/api/broadcast/templates/${encodeURIComponent(key)}/toggle`, {
      method: 'POST'
    });

    const data = await response.json();

    if (data.error) {
      showSideNotification(data.error, 'error');
      return;
    }

    templates = data.templates;
    renderTemplateList();

    const isNowEnabled = templates[key]?.enabled !== false;
    showSideNotification(`Template "${key}" ${isNowEnabled ? 'enabled' : 'disabled'}`, 'success');
  } catch (error) {
    console.error('[Broadcast] Failed to toggle template:', error);
    showSideNotification('Failed to toggle template', 'error');
  }
}

/**
 * Save a new or updated template
 */
async function saveTemplate() {
  const keyInput = document.getElementById('broadcastTemplateKey');
  const subjectInput = document.getElementById('broadcastTemplateSubject');
  const messageInput = document.getElementById('broadcastTemplateMessage');

  const key = keyInput.value.trim().toLowerCase();
  const subject = subjectInput.value.trim();
  const message = messageInput.value.trim();

  if (!key) {
    showSideNotification('Template key is required', 'error');
    return;
  }

  if (!subject) {
    showSideNotification('Subject is required', 'error');
    return;
  }

  if (!message) {
    showSideNotification('Message is required', 'error');
    return;
  }

  try {
    const response = await fetch('/api/broadcast/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, subject, message })
    });

    const data = await response.json();

    if (data.error) {
      showSideNotification(data.error, 'error');
      return;
    }

    templates = data.templates;
    renderTemplateList();

    // Clear form
    keyInput.value = '';
    subjectInput.value = '';
    messageInput.value = '';

    showSideNotification(`Template "${key}" saved`, 'success');
  } catch (error) {
    console.error('[Broadcast] Failed to save template:', error);
    showSideNotification('Failed to save template', 'error');
  }
}

/**
 * Edit an existing template (load into form)
 * @param {string} key - Template key
 */
function editTemplate(key) {
  const template = templates[key];
  if (!template) return;

  document.getElementById('broadcastTemplateKey').value = key;
  document.getElementById('broadcastTemplateSubject').value = template.subject;
  document.getElementById('broadcastTemplateMessage').value = template.message;

  // Update counter
  updateMessageCounter();

  // Scroll to form
  document.getElementById('broadcastTemplateKey').focus();
}

/**
 * Delete a template
 * @param {string} key - Template key
 */
async function deleteTemplate(key) {
  if (!confirm(`Delete template "${key}"?`)) {
    return;
  }

  try {
    const response = await fetch(`/api/broadcast/templates/${encodeURIComponent(key)}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (data.error) {
      showSideNotification(data.error, 'error');
      return;
    }

    templates = data.templates;
    renderTemplateList();

    showSideNotification(`Template "${key}" deleted`, 'success');
  } catch (error) {
    console.error('[Broadcast] Failed to delete template:', error);
    showSideNotification('Failed to delete template', 'error');
  }
}

/**
 * Update the message character counter
 */
function updateMessageCounter() {
  const messageInput = document.getElementById('broadcastTemplateMessage');
  const counter = document.getElementById('broadcastMessageCounter');

  if (!messageInput || !counter) return;

  const length = messageInput.value.length;
  counter.textContent = `${length}/900`;

  // Change color when near/over limit
  if (length >= 900) {
    counter.style.color = '#ef4444';
  } else if (length >= 800) {
    counter.style.color = '#fbbf24';
  } else {
    counter.style.color = '#9ca3af';
  }
}

/**
 * Initialize the broadcast module (legacy, kept for compatibility)
 */
export function initBroadcast() {
  // No longer needed - broadcast templates moved to Management Tab
}

/**
 * Initialize broadcast templates for Management Tab
 * Called after the Management Tab HTML is rendered
 */
export async function initBroadcastForManagement() {
  // Set up save button
  const saveBtn = document.getElementById('broadcastSaveTemplateBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveTemplate);
  }

  // Set up message counter
  const messageInput = document.getElementById('broadcastTemplateMessage');
  if (messageInput) {
    messageInput.addEventListener('input', updateMessageCounter);
  }

  // Load templates
  await loadTemplates();
}

// Export for manual triggering
export { loadTemplates };
