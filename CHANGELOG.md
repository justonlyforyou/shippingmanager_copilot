# Changelog

All notable changes to Shipping Manager CoPilot will be documented in this file.

## [0.1.7.8] - 2026-01-03

### Launcher
- **C# Launcher**: Added migration for `host` column in EnsureDatabase()
  - Fixes "no such column: host" error for existing users upgrading

---

## [0.1.7.7] - 2026-01-03

### Database
- **Host/IP now stored per-account** instead of globally
  - Each account can have its own IP binding (useful for multi-account setups)
  - Added `host` column to `accounts` table with migration for existing DBs
  - Added `getAccountHost()`, `setAccountHost()` database functions
  - Server config GET/POST now use per-account host from accounts table

### Launcher
- **Both launchers now use accounts.db as single source of truth**
- **C# Launcher**: Reads sessions directly from SQLite
  - Session now includes Host property and computed Url
  - `SessionInfo.Url` builds correct URL with localhost fallback for 0.0.0.0/127.0.0.1
  - All hardcoded localhost URLs replaced with `session.Url`
- **NodeJS Launcher**: Uses session-manager.js which reads from DB
  - Only passes `SELECTED_USER_ID` to server process
  - Server reads its own PORT/HOST from DB based on user ID
  - Removed PORT/HOST environment variables

### Vessel Building
- **Fleet Builder** - Build multiple vessels at once (Step 5)
  - New "Fleet" tab allows adding multiple port/name combinations
  - Price preview shows total cost for all vessels
  - Sequential building with single notification
  - Fast delivery detection restored (drydock bug exploit)
  - Fixed state reset when reopening build modal

### Harbor Map
- **Demand filter UI simplified**
  - Radio buttons for Current/Max demand selection (instead of 4 separate inputs)
  - Min/Max input fields with thousand separators
  - Collapsible filter sections with smaller, centered buttons

### Stock Manager
- **Fixed horizontal scrollbar** appearing unnecessarily
  - Added overflow hidden to modal window and investments list

### UI Fixes
- **Settings dialog** fixed null reference error
  - Removed reference to obsolete `minVesselUtilization` element
  - Now correctly handles `minCargoUtilization` and `harborFeeWarningThreshold`

---

## [0.1.7.6] - 2026-01-02

### Autopilot
- **Intelligent Rebuy restructured** to work ON TOP of normal mode (not replace it)
  - Normal mode: Price <= threshold -> fill bunker completely
  - Intelligent mode: Price > threshold but <= max price AND vessels have shortfall -> buy shortfall only
  - Removed unwanted refill-when-not-full behavior
  - Added INTELLIGENT prefix in audit logs for clarity

### Depart Manager
- **Fixed vessel ID type mismatch** causing 0 departed/failed counts
  - Normalize vessel IDs with Number() for consistent comparison
  - Added detailed logging when vessels are filtered out
- **Fixed infinite loop** when server lock gets stuck
  - Max retry limit of 6 attempts (30 seconds total)
  - Fails gracefully with Server busy message instead of hanging forever
- Added reason code no_vessels_processed when vessels found but none departed

### UI Fixes
- **CEO level star badge** now uses correct XP progress formula
  - Was: current_xp / next_level_xp (wrong)
  - Now: (current_xp - level_start_xp) / (next_level_xp - level_start_xp)
- **Harbor fee warning** now respects not-set option (no warning when disabled)

### Messenger
- Formatted system messages for stock_loses_company_bankrupt (bankruptcy notification)
- Formatted system messages for alliance_top_contributor_message (with medal emojis)

---

## [0.1.7.5] - 2026-01-02

### Database Migration
- **All user settings now stored in SQLite database** instead of JSON files
- Settings, autopilot state, chatbot config all migrated to `accounts.db`
- One-time automatic migration from existing JSON files on startup

### Server
- `settings-schema.js`: initializeSettings()/saveSettings() now use database
- `autopilot.js`: Pause/resume state saved to database
- `automation.js`: Loads settings from database
- `chatbot/settings.js`: Load/save chatbot settings from database
- `chatbot/commands.js`: Welcome command reads from database
- `chatbot/parser.js`: Command permissions loaded from database
- `routes/server-config.js`: Host in accounts_metadata (global), port per-account
- `utils/logger.js`: Reads logLevel from database

### Hijack History
- Removed JSON fallback - all hijack data now in database only
- `aggregator.js`: Reads vessel_name from hijack_cases table
- `messenger.js`: Delete chat removes from database tables

### Database Extensions
- Added `getAccountPort()`, `setAccountPort()` functions
- Added `getGlobalSetting()`, `setGlobalSetting()` functions
- New `settings-migrator.js` utility for JSON-to-DB migration

### Launcher
- C# launcher: Simplified session management
- Node.js launcher: Updated config for database-backed settings

---

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
