/**
 * @fileoverview Vessel Appearance Editor Module
 *
 * Handles editing vessel appearance for custom vessels.
 * Allows users to upload a custom image and configure SVG colors.
 *
 * Note: Fuel/Speed data is no longer needed here - all vessel data
 * (capacity, max_speed, fuel_factor) comes from the game API and
 * fuel consumption is calculated using the discovered game formula.
 *
 * @module vessel-appearance-editor
 */

import { showSideNotification } from './utils.js';

let currentVesselId = null;
let currentVesselName = null;
let originalVesselName = null;
let uploadedImageData = null;
let hasCustomImage = false;
let removeCustomImage = false;
let currentVesselData = null;

// Target aspect ratio for vessel images (16:9 like game images)
const TARGET_ASPECT_RATIO = 16 / 9;
const ASPECT_RATIO_TOLERANCE = 0.3;
// Game vessel images are 1440x810 pixels
const MAX_IMAGE_WIDTH = 1440;
const MAX_IMAGE_HEIGHT = 810;

/**
 * Initialize the vessel appearance editor
 */
export function initVesselAppearanceEditor() {
  const overlay = document.getElementById('vesselAppearanceOverlay');
  const closeBtn = document.getElementById('closeVesselAppearanceBtn');
  const cancelBtn = document.getElementById('cancelAppearanceBtn');
  const saveBtn = document.getElementById('saveAppearanceBtn');
  const imagePreview = document.getElementById('appearanceImagePreview');
  const imageInput = document.getElementById('appearanceImageInput');
  const removeImageBtn = document.getElementById('removeCustomImageBtn');

  if (!overlay) {
    console.warn('[Vessel Appearance] Modal elements not found');
    return;
  }

  // Close button handlers
  closeBtn?.addEventListener('click', closeAppearanceEditor);
  cancelBtn?.addEventListener('click', closeAppearanceEditor);

  // Save button handler
  saveBtn?.addEventListener('click', saveAppearance);

  // Image upload click handler
  imagePreview?.addEventListener('click', () => {
    // Reset input value so selecting the same file again triggers change event
    if (imageInput) imageInput.value = '';
    imageInput?.click();
  });

  // Image file selection handler
  imageInput?.addEventListener('change', handleImageSelection);

  // Remove custom image button handler
  removeImageBtn?.addEventListener('click', handleRemoveCustomImage);

  // Color picker change handlers - update SVG preview live
  const colorInputIds = [
    'appearanceHullColor',
    'appearanceDeckColor',
    'appearanceBridgeColor',
    'appearanceNameColor',
    'appearanceContainer1',
    'appearanceContainer2',
    'appearanceContainer3',
    'appearanceContainer4'
  ];

  colorInputIds.forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', updateSvgPreview);
    }
  });

  console.log('[Vessel Appearance] Editor initialized');
}

/**
 * Open the appearance editor for a specific vessel
 * @param {number} vesselId - The vessel ID
 * @param {string} vesselName - The vessel name
 */
export function openAppearanceEditor(vesselId, vesselName, vesselData = null) {
  currentVesselId = vesselId;
  currentVesselName = vesselName;
  originalVesselName = vesselName;
  currentVesselData = vesselData;
  uploadedImageData = null;
  hasCustomImage = false;
  removeCustomImage = false;

  const overlay = document.getElementById('vesselAppearanceOverlay');
  const vesselIdInput = document.getElementById('appearanceVesselId');
  const originalNameInput = document.getElementById('appearanceOriginalName');
  const vesselNameInput = document.getElementById('appearanceVesselName');
  const imagePreview = document.getElementById('appearanceImagePreview');
  const removeImageBtn = document.getElementById('removeCustomImageBtn');

  if (!overlay) return;

  // Set vessel ID and name
  if (vesselIdInput) vesselIdInput.value = vesselId;
  if (originalNameInput) originalNameInput.value = vesselName;
  if (vesselNameInput) vesselNameInput.value = vesselName;

  // Hide remove button initially
  if (removeImageBtn) removeImageBtn.classList.add('hidden');

  // Reset image preview
  if (imagePreview) {
    imagePreview.classList.remove('has-image');
    imagePreview.innerHTML = `
      <span class="appearance-upload-icon">+</span>
      <span class="appearance-upload-text">Click to upload image</span>
    `;
  }

  // Reset color values to defaults
  resetColorValues();

  // Check if vessel already has an image
  checkExistingImage(vesselId, currentVesselData);

  // Show overlay
  overlay.classList.remove('hidden');
  console.log('[Vessel Appearance] Opened editor for vessel', vesselId, vesselName);
}

/**
 * Check if vessel already has an image file and load it into preview
 * @param {number} vesselId - Vessel ID
 */

/**
 * Build SVG URL with query params from vessel data
 * @param {number} vesselId - Vessel ID
 * @param {Object} vesselData - Vessel data with capacity_type, capacity, name
 * @param {string} extra - Extra query params
 * @param {boolean} includeColors - Whether to include current color picker values
 */
function buildSvgUrl(vesselId, vesselData, extra = '', includeColors = false) {
  const params = new URLSearchParams();

  if (vesselData) {
    if (vesselData.capacity_type) params.set('capacity_type', vesselData.capacity_type);
    // Get capacity: container uses dry, tanker uses crude_oil
    let cap = vesselData.capacity;
    if (!cap && vesselData.capacity_max) {
      cap = vesselData.capacity_max.dry ?? vesselData.capacity_max.crude_oil;
    }
    if (cap) params.set('capacity', cap);
    if (vesselData.name) params.set('name', vesselData.name);
  }

  // Include current color picker values for live preview
  if (includeColors) {
    const hullColor = document.getElementById('appearanceHullColor')?.value;
    const deckColor = document.getElementById('appearanceDeckColor')?.value;
    const bridgeColor = document.getElementById('appearanceBridgeColor')?.value;
    const nameColor = document.getElementById('appearanceNameColor')?.value;
    const container1 = document.getElementById('appearanceContainer1')?.value;
    const container2 = document.getElementById('appearanceContainer2')?.value;
    const container3 = document.getElementById('appearanceContainer3')?.value;
    const container4 = document.getElementById('appearanceContainer4')?.value;

    if (hullColor) params.set('hull_color', hullColor);
    if (deckColor) params.set('deck_color', deckColor);
    if (bridgeColor) params.set('bridge_color', bridgeColor);
    if (nameColor) params.set('name_color', nameColor);
    if (container1) params.set('container_color_1', container1);
    if (container2) params.set('container_color_2', container2);
    if (container3) params.set('container_color_3', container3);
    if (container4) params.set('container_color_4', container4);
  }

  const queryStr = params.toString();
  return `/api/vessel-svg/preview?${queryStr}${extra ? '&' + extra : ''}`;
}

/**
 * Update SVG preview with current color values
 * Called when any color picker changes
 */
function updateSvgPreview() {
  // Don't update if custom image is uploaded or exists
  if (uploadedImageData || (hasCustomImage && !removeCustomImage)) {
    return;
  }

  const imagePreview = document.getElementById('appearanceImagePreview');
  if (!imagePreview) return;

  const previewUrl = buildSvgUrl(currentVesselId, currentVesselData, 't=' + Date.now(), true);
  imagePreview.innerHTML = `<img src="${previewUrl}" alt="Preview">`;
}

async function checkExistingImage(vesselId, vesselData) {
  const imagePreview = document.getElementById('appearanceImagePreview');
  const colorsSection = document.getElementById('appearanceColorsSection');
  const removeImageBtn = document.getElementById('removeCustomImageBtn');

  // Fetch appearance data to check if ownImage exists and get saved colors
  try {
    const response = await fetch(`/api/vessel/get-appearance/${vesselId}`);
    const appearance = await response.json();

    // Load saved colors into color pickers
    if (appearance.hull_color) {
      const el = document.getElementById('appearanceHullColor');
      if (el) el.value = appearance.hull_color;
    }
    if (appearance.deck_color) {
      const el = document.getElementById('appearanceDeckColor');
      if (el) el.value = appearance.deck_color;
    }
    if (appearance.bridge_color) {
      const el = document.getElementById('appearanceBridgeColor');
      if (el) el.value = appearance.bridge_color;
    }
    if (appearance.name_color) {
      const el = document.getElementById('appearanceNameColor');
      if (el) el.value = appearance.name_color;
    }
    if (appearance.container_color_1) {
      const el = document.getElementById('appearanceContainer1');
      if (el) el.value = appearance.container_color_1;
    }
    if (appearance.container_color_2) {
      const el = document.getElementById('appearanceContainer2');
      if (el) el.value = appearance.container_color_2;
    }
    if (appearance.container_color_3) {
      const el = document.getElementById('appearanceContainer3');
      if (el) el.value = appearance.container_color_3;
    }
    if (appearance.container_color_4) {
      const el = document.getElementById('appearanceContainer4');
      if (el) el.value = appearance.container_color_4;
    }

    if (appearance.ownImage) {
      // Has custom uploaded image
      hasCustomImage = true;
      if (imagePreview) {
        imagePreview.classList.add('has-image');
        imagePreview.innerHTML = `<img src="/api/vessel-image/ownimage/${vesselId}?t=${Date.now()}" alt="Current">`;
      }
      if (colorsSection) colorsSection.classList.add('hidden');
      if (removeImageBtn) removeImageBtn.classList.remove('hidden');
    } else {
      // No custom image - show SVG preview with current colors
      if (imagePreview) {
        imagePreview.classList.add('has-image');
        const previewUrl = buildSvgUrl(vesselId, vesselData, 't=' + Date.now(), true);
        imagePreview.innerHTML = `<img src="${previewUrl}" alt="Current">`;
      }
      if (colorsSection) colorsSection.classList.remove('hidden');
    }
  } catch {
    // No appearance file - show SVG with defaults
    if (imagePreview) {
      imagePreview.classList.add('has-image');
      const previewUrl = buildSvgUrl(vesselId, vesselData, 't=' + Date.now(), true);
      imagePreview.innerHTML = `<img src="${previewUrl}" alt="Current">`;
    }
    if (colorsSection) colorsSection.classList.remove('hidden');
  }
}

/**
 * Close the appearance editor
 */
function closeAppearanceEditor() {
  const overlay = document.getElementById('vesselAppearanceOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
  currentVesselId = null;
  currentVesselName = null;
  uploadedImageData = null;
}

/**
 * Handle image file selection
 * @param {Event} event - File input change event
 */
function handleImageSelection(event) {
  const file = event.target.files?.[0];
  console.log('[Vessel Appearance] handleImageSelection called, file:', file);
  if (!file) return;

  // Validate file type
  if (!file.type.startsWith('image/')) {
    showSideNotification('Please select an image file', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    console.log('[Vessel Appearance] FileReader onload, result length:', e.target.result?.length);
    const img = new Image();
    img.onload = () => {
      console.log('[Vessel Appearance] Image loaded, dimensions:', img.width, 'x', img.height);
      // Check aspect ratio
      const aspectRatio = img.width / img.height;
      const ratioDiff = Math.abs(aspectRatio - TARGET_ASPECT_RATIO);

      if (ratioDiff > ASPECT_RATIO_TOLERANCE) {
        showSideNotification(`Image aspect ratio should be close to 5:3. Current: ${aspectRatio.toFixed(2)}:1`, 'warning');
      }

      // Resize image if needed
      const resizedData = resizeImage(img, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT);
      uploadedImageData = resizedData;

      // Update preview
      const imagePreview = document.getElementById('appearanceImagePreview');
      if (imagePreview) {
        imagePreview.classList.add('has-image');
        imagePreview.innerHTML = `<img src="${resizedData}" alt="Preview">`;
      }

      // Hide colors section when custom image is uploaded (colors are for SVG only)
      const colorsSection = document.getElementById('appearanceColorsSection');
      if (colorsSection) {
        colorsSection.classList.add('hidden');
      }

      // Show remove button for uploaded image
      const removeImageBtn = document.getElementById('removeCustomImageBtn');
      if (removeImageBtn) {
        removeImageBtn.classList.remove('hidden');
      }

      showSideNotification('Image loaded successfully', 'success');
    };
    img.onerror = (err) => {
      console.error('[Vessel Appearance] Image load error:', err);
      showSideNotification('Failed to load image', 'error');
    };
    console.log('[Vessel Appearance] Setting img.src...');
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/**
 * Handle removing custom image - switch back to SVG
 * @param {Event} event - Click event
 */
function handleRemoveCustomImage(event) {
  event.stopPropagation();

  // Mark for deletion on save
  removeCustomImage = true;
  uploadedImageData = null;

  const imagePreview = document.getElementById('appearanceImagePreview');
  const colorsSection = document.getElementById('appearanceColorsSection');
  const removeImageBtn = document.getElementById('removeCustomImageBtn');

  // Show SVG preview instead - use force=svg to bypass own image check since file still exists
  if (imagePreview) {
    imagePreview.classList.add('has-image');
    imagePreview.innerHTML = `<img src="${buildSvgUrl(currentVesselId, currentVesselData, 'force=svg&t=' + Date.now())}" alt="SVG Preview">`;
  }

  // Show colors section for SVG
  if (colorsSection) {
    colorsSection.classList.remove('hidden');
  }

  // Hide remove button
  if (removeImageBtn) {
    removeImageBtn.classList.add('hidden');
  }

  showSideNotification('Custom image will be removed on save', 'info');
}

/**
 * Resize image maintaining aspect ratio
 * @param {HTMLImageElement} img - Source image
 * @param {number} maxWidth - Maximum width
 * @param {number} maxHeight - Maximum height
 * @returns {string} Base64 encoded resized image
 */
function resizeImage(img, maxWidth, maxHeight) {
  let width = img.width;
  let height = img.height;

  // Calculate new dimensions
  if (width > maxWidth) {
    height = Math.round(height * (maxWidth / width));
    width = maxWidth;
  }
  if (height > maxHeight) {
    width = Math.round(width * (maxHeight / height));
    height = maxHeight;
  }

  // Create canvas and draw resized image
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL('image/png');
}

/**
 * Reset color values to defaults
 */
function resetColorValues() {
  const hullColor = document.getElementById('appearanceHullColor');
  const deckColor = document.getElementById('appearanceDeckColor');
  const bridgeColor = document.getElementById('appearanceBridgeColor');
  const nameColor = document.getElementById('appearanceNameColor');
  const container1 = document.getElementById('appearanceContainer1');
  const container2 = document.getElementById('appearanceContainer2');
  const container3 = document.getElementById('appearanceContainer3');
  const container4 = document.getElementById('appearanceContainer4');

  if (hullColor) hullColor.value = '#b30000';
  if (deckColor) deckColor.value = '#272525';
  if (bridgeColor) bridgeColor.value = '#dbdbdb';
  if (nameColor) nameColor.value = '#ffffff';
  if (container1) container1.value = '#ff8000';
  if (container2) container2.value = '#0000ff';
  if (container3) container3.value = '#670000';
  if (container4) container4.value = '#777777';
}

/**
 * Gather form data
 * @returns {Object} Form data object
 */
function getFormData() {
  return {
    vesselId: currentVesselId,
    name: currentVesselName,
    hull_color: document.getElementById('appearanceHullColor')?.value || '#b30000',
    deck_color: document.getElementById('appearanceDeckColor')?.value || '#272525',
    bridge_color: document.getElementById('appearanceBridgeColor')?.value || '#dbdbdb',
    name_color: document.getElementById('appearanceNameColor')?.value || '#ffffff',
    container_color_1: document.getElementById('appearanceContainer1')?.value || '#ff8000',
    container_color_2: document.getElementById('appearanceContainer2')?.value || '#0000ff',
    container_color_3: document.getElementById('appearanceContainer3')?.value || '#670000',
    container_color_4: document.getElementById('appearanceContainer4')?.value || '#777777',
    imageData: uploadedImageData,
    removeOwnImage: removeCustomImage
  };
}

/**
 * Save appearance data to server
 */
async function saveAppearance() {
  if (!currentVesselId) {
    showSideNotification('No vessel selected', 'error');
    return;
  }

  const formData = getFormData();

  const saveBtn = document.getElementById('saveAppearanceBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    // Check if name changed
    const vesselNameInput = document.getElementById('appearanceVesselName');
    const newName = vesselNameInput?.value?.trim();
    const nameChanged = newName && newName !== originalVesselName;

    // If name changed, rename first
    if (nameChanged) {
      console.log('[Vessel Appearance] Name changed from', originalVesselName, 'to', newName);
      const renameResponse = await fetch('/api/vessel/rename-vessel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vessel_id: currentVesselId, name: newName })
      });

      if (!renameResponse.ok) {
        const error = await renameResponse.json();
        throw new Error(error.error || 'Failed to rename vessel');
      }

      const renameResult = await renameResponse.json();
      if (!renameResult.success && !renameResult.data?.success) {
        throw new Error('Failed to rename vessel');
      }
      console.log('[Vessel Appearance] Renamed vessel successfully');
    }

    // Remove custom image if requested
    if (removeCustomImage && hasCustomImage) {
      console.log('[Vessel Appearance] Removing custom image for vessel', currentVesselId);
      const deleteResponse = await fetch(window.apiUrl(`/api/vessel/delete-custom-image/${currentVesselId}`), {
        method: 'DELETE'
      });

      if (!deleteResponse.ok) {
        console.warn('[Vessel Appearance] Failed to delete custom image, continuing...');
      }
    }

    // Always save appearance data (colors are always sent)
    console.log('[Vessel Appearance] Saving appearance data for vessel', currentVesselId);

    {
      const response = await fetch(window.apiUrl('/api/vessel/save-appearance'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save appearance');
      }

      const result = await response.json();
      console.log('[Vessel Appearance] Save response:', result);
    }

    showSideNotification('Saved', 'success');

    const savedVesselId = currentVesselId;
    closeAppearanceEditor();

    // Refresh the harbor map to show updated data
    if (window.harborMap) {
      // Clear cache to force fresh data from server
      const { clearOverviewCache } = await import('./harbor-map/api-client.js');
      clearOverviewCache();

      const { loadOverview, selectVessel } = await import('./harbor-map/map-controller.js');
      await loadOverview();
      await selectVessel(savedVesselId);
    }

    // Trigger refresh of vessel displays if needed
    window.dispatchEvent(new CustomEvent('vesselAppearanceUpdated', {
      detail: { vesselId: savedVesselId }
    }));

  } catch (error) {
    console.error('[Vessel Appearance] Save error:', error);
    showSideNotification(error.message || 'Failed to save appearance', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }
}

/**
 * Handle image load error - show edit fallback for custom vessels
 * @param {HTMLImageElement} imgElement - The image element that failed to load
 * @param {number} vesselId - The vessel ID
 * @param {string} vesselName - The vessel name
 * @param {boolean} [isCustomVessel=true] - Whether this is a custom vessel
 */
export function handleVesselImageError(imgElement, vesselId, vesselName, isCustomVessel = true) {
  if (!imgElement || !vesselId) return;

  const container = imgElement.parentElement;
  if (!container) return;

  if (isCustomVessel) {
    // Create edit fallback for custom vessels
    const fallback = document.createElement('div');
    fallback.className = 'vessel-image-edit-fallback';
    fallback.innerHTML = '<span class="edit-icon">&#9998;</span>';
    fallback.title = 'Click to set vessel appearance';
    fallback.style.cursor = 'pointer';
    fallback.onclick = (e) => {
      e.stopPropagation();
      // Use harborMap function that fetches existing data
      if (window.harborMap && window.harborMap.openVesselAppearanceEditor) {
        window.harborMap.openVesselAppearanceEditor(vesselId, vesselName);
      } else {
        openAppearanceEditor(vesselId, vesselName);
      }
    };

    // Replace the image with the fallback
    imgElement.style.display = 'none';
    container.insertBefore(fallback, imgElement);
  } else {
    // For non-custom vessels, use default ship icon
    imgElement.src = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect fill=%22%23374151%22 width=%22400%22 height=%22300%22/><text x=%2250%%22 y=%2250%%22 fill=%22%239ca3af%22 text-anchor=%22middle%22 font-size=%2224%22>Ship</text></svg>';
  }
}

/**
 * Create an onerror handler string for inline use
 * @param {number} vesselId - The vessel ID
 * @param {string} vesselName - The vessel name
 * @param {boolean} [isCustom=false] - Whether this is a custom vessel
 * @returns {string} onerror handler string
 */
export function getVesselImageOnerror(vesselId, vesselName, isCustom = false) {
  if (isCustom) {
    const safeName = (vesselName || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return `if(window.handleVesselImageError){window.handleVesselImageError(this,${vesselId},'${safeName}',true)}else{this.style.display='none'}`;
  }
  return `this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect fill=%22%23374151%22 width=%22400%22 height=%22300%22/><text x=%2250%%22 y=%2250%%22 fill=%22%239ca3af%22 text-anchor=%22middle%22 font-size=%2224%22>Ship</text></svg>'`;
}

// Export for use elsewhere
export { openAppearanceEditor as openVesselAppearanceEditor };
