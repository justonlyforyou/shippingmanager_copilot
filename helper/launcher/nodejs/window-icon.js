/**
 * @fileoverview Window Icon Helper for Win32
 * @module launcher/window-icon
 *
 * Sets window icon using Win32 API via koffi
 */

const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

let koffi = null;
let user32 = null;

// Win32 constants
const WM_SETICON = 0x0080;
const ICON_SMALL = 0;
const ICON_BIG = 1;

/**
 * Check if running as packaged SEA
 */
function isPackaged() {
  try {
    const sea = require('node:sea');
    return sea.isSea();
  } catch {
    return false;
  }
}

/**
 * Initialize Win32 API bindings
 * @returns {boolean} True if successful
 */
function init() {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    // Load koffi from correct path (bundled vs packaged)
    if (isPackaged()) {
      const exeDir = path.dirname(process.execPath);
      const moduleRequire = createRequire(path.join(exeDir, 'node_modules', 'package.json'));
      koffi = moduleRequire('koffi');
    } else {
      koffi = require('koffi');
    }

    user32 = koffi.load('user32.dll');

    return true;
  } catch (err) {
    console.error('[WindowIcon] Failed to load koffi:', err.message);
    return false;
  }
}

/**
 * Set window icon by window title
 * @param {string} windowTitle - Window title to find
 * @param {string} iconPath - Path to .ico file
 * @returns {boolean} True if successful
 */
function setIconByTitle(windowTitle, iconPath) {
  if (!koffi) {
    if (!init()) {
      return false;
    }
  }

  if (!windowTitle) {
    console.error('[WindowIcon] No window title provided');
    return false;
  }

  if (!fs.existsSync(iconPath)) {
    console.error('[WindowIcon] Icon file not found:', iconPath);
    return false;
  }

  try {
    // Constants for LoadImageW
    const IMAGE_ICON = 1;
    const LR_LOADFROMFILE = 0x0010;

    // FindWindowW to find window by title
    const FindWindowW = user32.func('void* __stdcall FindWindowW(const char16* lpClassName, const char16* lpWindowName)');

    // LoadImageW to load icon from file
    const LoadImageW = user32.func('void* __stdcall LoadImageW(void* hInstance, const char16* name, uint32 type, int cx, int cy, uint32 flags)');

    // SendMessageW to set icon
    const SendMessageW = user32.func('intptr __stdcall SendMessageW(void* hWnd, uint32 Msg, uintptr wParam, intptr lParam)');

    // Find the window
    const hwnd = FindWindowW(null, windowTitle);
    if (!hwnd) {
      console.error('[WindowIcon] Window not found:', windowTitle);
      return false;
    }

    // Load icons - small (16x16) and large (32x32)
    const smallIcon = LoadImageW(null, iconPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
    const largeIcon = LoadImageW(null, iconPath, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);

    if (!smallIcon && !largeIcon) {
      console.error('[WindowIcon] Failed to load icon from file');
      return false;
    }

    // Set both small and large icons
    if (smallIcon) {
      SendMessageW(hwnd, WM_SETICON, ICON_SMALL, koffi.address(smallIcon));
    }
    if (largeIcon) {
      SendMessageW(hwnd, WM_SETICON, ICON_BIG, koffi.address(largeIcon));
    }

    return true;
  } catch (err) {
    console.error('[WindowIcon] Failed to set icon:', err.message);
    return false;
  }
}

/**
 * Center window on screen by window title
 * @param {string} windowTitle - Window title to find
 * @returns {boolean} True if successful
 */
function centerWindowByTitle(windowTitle) {
  if (!koffi) {
    if (!init()) {
      return false;
    }
  }

  if (!windowTitle) {
    return false;
  }

  try {
    const FindWindowW = user32.func('void* __stdcall FindWindowW(const char16* lpClassName, const char16* lpWindowName)');
    const GetWindowRect = user32.func('int __stdcall GetWindowRect(void* hWnd, void* lpRect)');
    const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
    const SetWindowPos = user32.func('int __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)');

    // Constants
    const SM_CXSCREEN = 0;
    const SM_CYSCREEN = 1;
    const SWP_NOSIZE = 0x0001;
    const SWP_NOZORDER = 0x0004;

    // Find window
    const hwnd = FindWindowW(null, windowTitle);
    if (!hwnd) {
      return false;
    }

    // Get screen size
    const screenWidth = GetSystemMetrics(SM_CXSCREEN);
    const screenHeight = GetSystemMetrics(SM_CYSCREEN);

    // Get window size via GetWindowRect
    const rect = Buffer.alloc(16); // RECT: 4 ints (left, top, right, bottom)
    GetWindowRect(hwnd, rect);
    const left = rect.readInt32LE(0);
    const top = rect.readInt32LE(4);
    const right = rect.readInt32LE(8);
    const bottom = rect.readInt32LE(12);
    const windowWidth = right - left;
    const windowHeight = bottom - top;

    // Calculate centered position
    const x = Math.floor((screenWidth - windowWidth) / 2);
    const y = Math.floor((screenHeight - windowHeight) / 2);

    // Move window
    SetWindowPos(hwnd, null, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);

    return true;
  } catch (err) {
    console.error('[WindowIcon] Failed to center window:', err.message);
    return false;
  }
}

/**
 * Get default icon path
 * @returns {string} Path to favicon.ico
 */
function getDefaultIconPath() {
  // Try multiple locations
  const locations = [];

  if (isPackaged()) {
    // Packaged mode: look relative to executable
    locations.push(path.join(path.dirname(process.execPath), 'public', 'favicon.ico'));
  }

  // Development mode locations (helper/launcher/nodejs -> project root)
  locations.push(
    path.join(__dirname, '..', '..', '..', 'public', 'favicon.ico'),
    path.join(__dirname, 'favicon.ico'),
    path.join(process.cwd(), 'public', 'favicon.ico')
  );

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  return locations[0];
}

/**
 * Hide a window by title using Win32 API (hiding is safer than destroying)
 * @param {string} windowTitle - Window title to find and hide
 * @returns {boolean} True if successful
 */
function closeWindowByTitle(windowTitle) {
  if (!koffi) {
    if (!init()) {
      return false;
    }
  }

  if (!windowTitle) {
    return false;
  }

  try {
    const FindWindowW = user32.func('void* __stdcall FindWindowW(const char16* lpClassName, const char16* lpWindowName)');
    const ShowWindow = user32.func('int __stdcall ShowWindow(void* hWnd, int nCmdShow)');

    // Constants
    const SW_HIDE = 0;

    // Find window
    const hwnd = FindWindowW(null, windowTitle);
    if (!hwnd) {
      return false;
    }

    // Hide the window - this is safe and immediate
    ShowWindow(hwnd, SW_HIDE);

    return true;
  } catch (err) {
    console.error('[WindowIcon] Failed to hide window:', err.message);
    return false;
  }
}

/**
 * Get screen height using Win32 API
 * @returns {number} Screen height in pixels, or 900 as fallback
 */
function getScreenHeight() {
  if (!koffi) {
    if (!init()) {
      return 900;
    }
  }

  try {
    const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
    const SM_CYSCREEN = 1;
    return GetSystemMetrics(SM_CYSCREEN);
  } catch (err) {
    console.error('[WindowIcon] Failed to get screen height:', err.message);
    return 900;
  }
}

module.exports = {
  init,
  setIconByTitle,
  centerWindowByTitle,
  closeWindowByTitle,
  getDefaultIconPath,
  getScreenHeight
};
