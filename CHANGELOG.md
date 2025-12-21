# Changelog

All notable changes to Shipping Manager CoPilot will be documented in this file.

## [0.1.7.0] - 2024-12-21

### Added
- **Changelog Popup System**: New version notifications on startup
  - Shows changelog when a new version is detected
  - Scroll to bottom to enable acknowledgment button
  - Acknowledgment syncs across all devices/tabs

### Improved
- **Frontend Logging**: Centralized debug logging system
  - All console.log statements now go through the logger module
  - Debug messages only appear when Debug Mode is enabled in settings
  - Cleaner console output in production

### Fixed
- Various bug fixes and stability improvements
