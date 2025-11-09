/**
 * @fileoverview Panel Drag & Drop Component
 * Makes detail panels draggable on the map
 * Panels can be freely repositioned after sliding in from the right
 *
 * @module harbor-map/panel-drag
 */

/**
 * Makes all detail panels draggable
 * Adds drag handles to panel headers and enables drag & drop
 *
 * @returns {void}
 * @example
 * initializePanelDrag();
 */
export function initializePanelDrag() {
  const panels = document.querySelectorAll('.detail-panel');

  panels.forEach(panel => {
    // Skip if already initialized
    if (panel.classList.contains('draggable-initialized')) {
      return;
    }

    panel.classList.add('draggable-initialized');

    let isDragging = false;
    let currentX = 0;
    let currentY = 0;
    let initialX = 0;
    let initialY = 0;
    let panelWidth = 0;
    let panelHeight = 0;
    let panelOffsetTop = 0;

    // Make entire panel draggable
    panel.classList.add('drag-handle');
    panel.style.cursor = 'move';

    // Mouse events
    panel.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    // Double-click to reset position (anywhere on panel)
    panel.addEventListener('dblclick', resetPosition);

    // Touch events (passive where possible for better scroll performance)
    panel.addEventListener('touchstart', dragStart, { passive: true });
    document.addEventListener('touchmove', drag, { passive: false }); // Not passive - we need preventDefault()
    document.addEventListener('touchend', dragEnd, { passive: true });

    function dragStart(e) {
      // Don't drag if clicking on interactive elements
      const target = e.target;
      const tagName = target.tagName.toLowerCase();

      // Skip dragging for interactive elements
      if (
        target.classList.contains('close-btn') ||
        tagName === 'button' ||
        tagName === 'a' ||
        tagName === 'input' ||
        tagName === 'select' ||
        tagName === 'textarea' ||
        target.closest('button') ||
        target.closest('a')
      ) {
        return;
      }

      // Store panel dimensions (without transform influence)
      panelWidth = panel.offsetWidth;
      panelHeight = panel.offsetHeight;
      panelOffsetTop = parseInt(window.getComputedStyle(panel).top) || 30;

      // Disable panel transition during drag
      panel.style.transition = 'none';

      if (e.type === 'touchstart') {
        initialX = e.touches[0].clientX - currentX;
        initialY = e.touches[0].clientY - currentY;
      } else {
        initialX = e.clientX - currentX;
        initialY = e.clientY - currentY;
      }

      isDragging = true;
      panel.style.zIndex = 1000; // Bring to front
    }

    function drag(e) {
      if (!isDragging) return;

      e.preventDefault();

      let clientX, clientY;
      if (e.type === 'touchmove') {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }

      currentX = clientX - initialX;
      currentY = clientY - initialY;

      // Get viewport dimensions
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Calculate minimum visible size (20% of panel)
      const minVisibleWidth = panelWidth * 0.2;
      const minVisibleHeight = panelHeight * 0.2;

      // X-axis bounds (panel starts at right: 0)
      // minX: can move left until only 20% visible on right side
      // Right edge position with transform: viewportWidth + currentX
      // Must be: viewportWidth + currentX >= minVisibleWidth
      // So: currentX >= minVisibleWidth - viewportWidth
      const minX = -(viewportWidth - minVisibleWidth);

      // maxX: can move right until only 20% visible on left side
      // Left edge position without transform: viewportWidth - panelWidth
      // Left edge with transform: viewportWidth - panelWidth + currentX
      // Must be: viewportWidth - panelWidth + currentX <= viewportWidth - minVisibleWidth
      // So: currentX <= panelWidth - minVisibleWidth
      const maxX = panelWidth - minVisibleWidth;

      // Y-axis bounds (panel starts at top: 30px or panelOffsetTop)
      // minY: can move up until only 20% visible at bottom
      // Bottom edge position: panelOffsetTop + panelHeight + currentY
      // Must be: panelOffsetTop + panelHeight + currentY >= minVisibleHeight
      // So: currentY >= minVisibleHeight - panelOffsetTop - panelHeight
      const minY = minVisibleHeight - panelOffsetTop - panelHeight;

      // maxY: can move down until only 20% visible at top
      // Top edge position: panelOffsetTop + currentY
      // Must be: panelOffsetTop + currentY <= viewportHeight - minVisibleHeight
      // So: currentY <= viewportHeight - minVisibleHeight - panelOffsetTop
      const maxY = viewportHeight - minVisibleHeight - panelOffsetTop;

      currentX = Math.max(minX, Math.min(currentX, maxX));
      currentY = Math.max(minY, Math.min(currentY, maxY));

      panel.style.transform = `translate(${currentX}px, ${currentY}px)`;
    }

    function dragEnd() {
      if (!isDragging) return;

      isDragging = false;
      panel.style.transition = ''; // Re-enable transitions
    }

    function resetPosition(e) {
      // Don't reset if clicking on interactive elements
      const target = e.target;
      const tagName = target.tagName.toLowerCase();

      if (
        target.classList.contains('close-btn') ||
        tagName === 'button' ||
        tagName === 'a' ||
        tagName === 'input' ||
        tagName === 'select' ||
        tagName === 'textarea' ||
        target.closest('button') ||
        target.closest('a')
      ) {
        return;
      }

      // Reset to original position with smooth transition
      panel.style.transition = 'transform 0.3s ease';
      panel.style.transform = 'translate(0px, 0px)';
      currentX = 0;
      currentY = 0;

      // Re-enable default transition after animation
      setTimeout(() => {
        panel.style.transition = '';
      }, 300);

      console.log('[Panel Drag] Reset to original position');
    }
  });
}
