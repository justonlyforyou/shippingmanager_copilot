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
5. Open browser to `https://localhost:12345`

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

**Python 3.10+** (required for system tray and session management)
```bash
python --version  # Must be >= 3.10
pip --version
```

**Git**
```bash
git --version
```

### Platform-Specific Dependencies

**Windows:**
```bash
pip install pywin32
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install libsecret-1-dev build-essential python3-tk
pip install SecretStorage
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf install libsecret-devel gcc-c++ make python3-tkinter
pip install SecretStorage
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

2. **Install Node.js dependencies**
   ```bash
   npm install
   ```

3. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Start the application**
   ```bash
   python start.py
   ```

The application starts as a system tray icon and automatically opens your browser to `https://localhost:12345`.

---

## Session Authentication

The application needs your Shipping Manager session cookie to authenticate with the game API.

### Windows (Steam + Browser)

- **Steam extraction**: Automatic - the app extracts session cookies from your local Steam client
- **Browser login**: Manual login via built-in browser window

### macOS / Linux (Browser only)

- **Browser login**: Click "Browser Login" in the app to authenticate through the game website

### Session Storage

All sessions are encrypted using your OS credential manager:
- **Windows**: Windows DPAPI + Credential Manager
- **macOS**: Keychain
- **Linux**: libsecret (GNOME Keyring / KWallet)

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

Change the port in settings or stop the conflicting process.

### Session Expired

If you see 401 errors:
1. Exit the application (right-click tray icon > Exit)
2. Launch Shipping Manager in Steam and log in
3. Restart the application

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

*Last updated: 2025-12-05*