# Installation Guide

Complete guide for installing and running ShippingManager CoPilot.

## Quick Start (Pre-built Downloads)

Download the latest release for your platform from [GitHub Releases](https://github.com/justonlyforyou/shippingmanager_copilot/releases/latest):

| Platform | Download | Login Method |
|----------|----------|--------------|
| Windows | `ShippingManagerCoPilot-Installer-*.exe` | Steam + Browser |
| macOS (Intel) | `ShippingManagerCoPilot-macos-x64.dmg` | Browser only |
| macOS (Apple Silicon) | `ShippingManagerCoPilot-macos-arm64.dmg` | Browser only |
| Linux | `ShippingManagerCoPilot-linux-x64.tar.gz` | Browser only |

### Windows Installation

1. Download `ShippingManagerCoPilot-Installer-*.exe`
2. Run the installer
3. Launch from Start Menu or Desktop shortcut
4. The application starts as a system tray icon
5. Add your account via Steam extraction or Browser login
6. Open browser to `https://localhost:12345`

### macOS Installation

1. Download the appropriate DMG for your Mac:
   - Intel Macs: `ShippingManagerCoPilot-macos-x64.dmg`
   - Apple Silicon (M1/M2/M3): `ShippingManagerCoPilot-macos-arm64.dmg`
2. Open the DMG file
3. Drag `ShippingManagerCoPilot.app` to Applications folder
4. First launch: Right-click > Open (to bypass Gatekeeper)
5. Open browser to `https://localhost:12345`

### Linux Installation

1. Download `ShippingManagerCoPilot-linux-x64.tar.gz`
2. Extract: `tar -xzf ShippingManagerCoPilot-linux-x64.tar.gz`
3. Run: `./ShippingManagerCoPilot`
4. Open browser to `https://localhost:12345`

**Linux Dependencies:**
```bash
# Debian/Ubuntu
sudo apt install libsecret-1-dev

# Fedora/RHEL
sudo dnf install libsecret-devel
```

---

## Running from Source (Developers)

### Prerequisites

**Node.js 22.0+** (required)
```bash
node --version  # Must be >= 22.0.0
npm --version   # Must be >= 9.0.0
```

**Git**
```bash
git --version
```

### Platform-Specific Dependencies

**Windows:**
No additional dependencies required.

**Linux (Debian/Ubuntu):**
```bash
sudo apt install libsecret-1-dev build-essential
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf install libsecret-devel gcc-c++ make
```

**macOS:**
```bash
brew install libsecret
```

### Installation Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/justonlyforyou/shippingmanager_copilot.git
   cd shippingmanager_copilot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the application**
   ```bash
   npm start
   ```

The application starts as a system tray icon. Add your account and open `https://localhost:12345` in your browser.

### Alternative Start Methods

```bash
# Start with GUI (default)
npm start

# Start in headless mode (no GUI, requires existing sessions)
npm run start:headless

# CLI session management
node helper/launcher/nodejs/cli.js --help
node helper/launcher/nodejs/cli.js --list-sessions
node helper/launcher/nodejs/cli.js --add-session-interactive
```

---

## Session Authentication

The application needs your Shipping Manager session cookie to authenticate with the game API.

### Windows (Steam + Browser)

- **Steam extraction**: Automatic - the app extracts session cookies from your local Steam client (Steam must be closed)
- **Browser login**: Manual login via built-in browser window

### macOS / Linux (Browser only)

- **Browser login**: Click "Add Account" > "Browser Login" in the tray menu

### Multiple Accounts

- Add multiple accounts via the tray icon menu
- Each account runs on a separate port (12345, 12346, ...)
- Enable/disable autostart per account
- Use `--list-sessions` to see all accounts

### Session Storage

All sessions are encrypted using your OS credential manager:
- **Windows**: Windows DPAPI + Credential Manager
- **macOS**: Keychain
- **Linux**: libsecret (GNOME Keyring / KWallet)

The `sessions.json` file only contains encrypted references - actual cookies are stored securely in your OS credential manager and can only be decrypted on the same machine by the same user.

---

## Configuration

Settings are stored in:
- **Windows (exe)**: `%LOCALAPPDATA%\ShippingManagerCoPilot\userdata\settings\settings.json`
- **Windows/Linux/Mac (source)**: `userdata/settings/settings.json`

**Key settings:**
```json
{
  "port": 12345,
  "host": "127.0.0.1"
}
```

- `port`: Server port (default: 12345)
- `host`: Bind address
  - `127.0.0.1` = localhost only (secure, default)
  - `0.0.0.0` = allow LAN access from other devices

### LAN Access

To access from mobile devices on your network:
1. Change `host` to `0.0.0.0` in settings
2. Find your IP: `ipconfig` (Windows) or `ip addr` (Linux) or `ifconfig` (Mac)
3. Access via `https://YOUR_IP:12345`
4. Accept the self-signed certificate warning on each device

---

## CLI Options

```bash
ShippingManagerCoPilot.exe [options]

Options:
  --help                          Show help
  --headless                      Start without GUI (requires existing sessions)
  --list-sessions                 List all saved accounts with autostart status
  --add-session-interactive       Add account via terminal (secure input)
  --remove-session=<userId>       Remove an account
  --enable-autostart=<userId>     Enable autostart for account
  --disable-autostart=<userId>    Disable autostart for account
```

---

## Troubleshooting

### Certificate Error on First Access

The app uses a self-signed HTTPS certificate. On first access:
1. Click "Advanced" or "Show Details"
2. Click "Proceed to localhost (unsafe)" or "Accept Risk"

### Port Already in Use

```bash
# Windows
netstat -ano | findstr :12345

# Linux/Mac
lsof -i :12345
```

Check `--list-sessions` for running instances, or change the port in settings.

### Steam Extraction Fails

1. Close Steam completely (check system tray)
2. Wait a few seconds
3. Try again via tray icon > Add Account > Steam

### Session Expired

If you see 401 errors:
1. Exit the application (right-click tray icon > Exit)
2. Launch Shipping Manager in Steam and log in
3. Restart the application and re-add your account

### WebSocket Connection Failed

1. Ensure you're using `https://` not `http://`
2. Accept the certificate warning first
3. Check browser console for errors

### Linux: libsecret Error

```bash
# Install the required library
sudo apt install libsecret-1-dev  # Debian/Ubuntu
sudo dnf install libsecret-devel  # Fedora
```

---

## Building from Source

See [Build Guide](./02-build-guide.md) for creating standalone executables.

## Security Notice

- The session cookie provides full access to your Shipping Manager account
- Never share your cookie or commit it to version control
- This tool likely violates Shipping Manager Terms of Service
- Use at your own risk

---

*Last updated: 2025-12-21*
