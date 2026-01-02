# Changelog

All notable changes to Shipping Manager CoPilot will be documented in this file.

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
