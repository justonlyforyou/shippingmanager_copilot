# Changelog

All notable changes to Shipping Manager CoPilot will be documented in this file.

## [0.1.7.4] - 2026-01-01

### C# Launcher
- Port now read from accounts.db instead of calculated (basePort + index)
- Added IsPortAvailable() OS-level port check when finding next available port
- Server status now correctly shows "loading" vs "ready"
- Fixed session.Port being used consistently throughout

### Server
- `config.js`: Added getPortFromDatabase() to read port from accounts.db for SELECTED_USER_ID
- `alliance.js`: New endpoint `/api/alliance/exclude-user` for kicking alliance members
- `vessel.js`: Sale broadcast now filters invalid entries and recalculates totals from valid data

### Frontend
- `vessel-selling.js`: Fixed undefined `priceMap` reference (now uses `globalPriceMap`)

---

## [0.1.7.3] - 2025-12-31

### Autopilot
- Intelligent Rebuy now available as separate mode (not just emergency fallback)
- Depart Manager fixes for edge cases

### Route Planner
- Added filters for route planning

---

## Important Bugfix [0.1.7.2] - 2025-12-22

* Port no route filter fix - does now work correctly but keep in mind: we need a full scrape of the demand first (takes up to 30 minutes after first startup)
* Lookup problem for analytics data fixed


## Important Bugfix [0.1.7.1] - 2025-12-22

  C# Launcher:
  - Add credential migration from old format to keytar-compatible format
  - Read base port from settings.json instead of hardcoded 12345
  - Add debug logging for session and credential lookups

  CSS:
  - Add missing .unread-indicator styling (red dot for unread messages)
  - Fix deprecated word-break: break-word -> overflow-wrap: break-word
  - Replace hardcoded rgba() values with CSS variables
  - Add --gray-400-10 and --gray-400-20 variables

  Server:
  - Add cleanupOldCredentials() helper in encryption.js

  Docs:
  - **CHEATSHEET:** Add Race Condition exploit documentation (VIP purchase, vessel building)

## [0.1.7.0] - 2025-12-21

### Important: Background Data Sync

This version includes major performance improvements. Please be patient during initial setup - several background processes collect data gradually to avoid API rate limits:

| Process | Interval | Notes |
|---------|----------|-------|
| **Lookup/Analytics Build** | On-demand | Triggered when you open Business Analytics. Runs in worker thread (non-blocking). First build may take a few minutes for large accounts. |
| **Port Demand Sync** | ~30 min full cycle | 360 ports synced continuously (1 port every 5 seconds). Full demand data available after first complete cycle. |
| **Price Updates** | Every 30 min | Fetched at :01 and :31 (1 minute after game price changes at :00 and :30). |
| **Auto-Anchor Check** | Every 5 min | Checks if anchor points need purchasing. |
| **Stock/IPO Refresh** | Every 5 min | Game updates stock market every 15 minutes. |
| **Main Event Loop** | Every 60 sec | Checks vessel status, triggers autopilots. |

**First Run**: After starting the application, allow 30-60 minutes for all background data to fully populate. Analytics and port demand data will become more complete over time.

---

### Added
- **Changelog Popup System**: New version notifications on startup
  - Shows changelog when a new version is detected
  - Must scroll to bottom and click "Got it" to acknowledge
  - Acknowledgment syncs across all devices/tabs
  - No close button - ensures users see important updates

- **Worker Thread for Analytics**: Non-blocking SQLite operations
  - Lookup builds now run in a separate thread
  - UI stays responsive during heavy database operations
  - Multiple accounts no longer block each other
  - Full POD1/POD2/POD3 matching logic in worker

- **API Stats SQLite Migration**: Improved reliability
  - Migrated from JSON files to SQLite database
  - 7-day automatic retention with cleanup
  - Auto-migration from existing JSON files on startup

- **Port Code Display**: Game-style port codes
  - New `toGameCode()` function for port codes (e.g., US NYC, DE HAM)
  - Updated all frontend modules to use new format
  - Fixed `formatPortAbbreviation()` in harbor-map-aggregator

- **Analytics Filter Options**: More time range choices
  - Added 3-day and 14-day filter options
  - Changed default filter from 7 days to 24 hours

### Improved
- **Frontend Logging**: Centralized debug logging system
  - All console.log statements now go through the logger module
  - Debug messages only appear when Debug Mode is enabled in settings
  - Cleaner console output in production

- **Documentation**: Updated for Node.js-only launcher
  - Removed all Python references from installation guide
  - Updated START_HERE.txt with current launcher workflow
  - Added CLI options documentation (--enable-autostart, --disable-autostart, etc.)
  - Updated for multi-account support

- **Launcher**: Various improvements
  - C# and Node.js launcher enhancements
  - Server ready dialog updates
  - Tray icon manager improvements

- **Lookup Store v16**: Better transaction matching
  - Added guard_payment_on_depart POD3 matching
  - Improved matching accuracy for departure-related transactions

### Fixed
- Route planner improvements
- Messenger stability fixes
- Various frontend bug fixes

### Removed
- Python dependencies (launcher is now 100% Node.js)
- `requirements.txt` and `start.py` no longer needed
- Close button from changelog popup (force acknowledgment)
