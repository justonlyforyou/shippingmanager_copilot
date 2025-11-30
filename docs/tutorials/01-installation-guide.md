# Installation Guide
Complete guide for setting up ShippingManager CoPilot from source code on Windows, Linux, and macOS.

## Windows End-Users

**If you're a Windows user**, you don't need this guide! Use the portable .exe instead:
1. Download `ShippingManagerCoPilot-vX.Y.Z.exe` [Get latest version here](https://github.com/justonlyforyou/shippingmanager_copilot/releases/latest)
2. Run installer :)

This guide is for **developers** and **Linux/Mac users** who need to run from source.

## Prerequisites

### All Platforms

**Node.js 22.0+** (https://nodejs.org/)
```bash
node --version  # Should be >= 22.0.0
npm --version   # Should be >= 9.0.0
```

**Python 3.10+** (https://www.python.org/)
```bash
python --version   # Should be >= 3.10
pip --version      # Should be installed
```

**Git** (https://git-scm.com/)
```bash
git --version
```

**Steam Client** with Shipping Manager
- Must be logged in at least once
- Must have launched Shipping Manager at least once (to generate session cookie)

### Platform-Specific Requirements

**Windows:**
- No additional system requirements
- Python packages: `pywin32`, `cryptography`

**Linux (Debian/Ubuntu):**
```bash
sudo apt update
sudo apt install -y libsecret-1-dev build-essential
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf install -y libsecret-devel gcc-c++ make
```

**macOS:**
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install libsecret via Homebrew
brew install libsecret
```

## Installation Steps

### Step 1: Clone the Repository

```bash
git clone https://github.com/yourusername/shipping-manager-messenger.git
cd shipping-manager-messenger
```

### Step 2: Install Node.js Dependencies

```bash
npm install
```

This installs all required Node.js packages including:
- `express` - Web server framework
- `ws` - WebSocket server
- `axios` - HTTP client
- `helmet` - Security middleware
- `express-rate-limit` - Rate limiting
- `validator` - Input sanitization

### Step 3: Install Python Dependencies

**All platforms:**
```bash
pip install -r requirements.txt
```

This installs all required Python packages including:
- `pywin32` (Windows only) - Windows API access
- `cryptography` - Session encryption
- `keyring` - OS credential storage
- `pystray` - System tray icon
- `pillow` - Image processing
- `requests` - HTTP client
- `qrcode[pil]` - QR code generation
- `psutil` - Process management

**Optional (all platforms):**
```bash
# For demo recording and screenshot generation
pip install selenium opencv-python
```

### Step 4: Verify Installation

```bash
# Check Node.js dependencies
npm list --depth=0

# Check Python dependencies
pip list | grep -E "(pywin32|cryptography|keyring)"
```

## Session Cookie Extraction

The application needs your Steam session cookie to authenticate with the Shipping Manager API.

### Automated Extraction (All Platforms)

The `start.py` script automatically handles session management:

```bash
python start.py
```

**What it does:**
1. Checks for existing encrypted sessions
2. If no session: Extracts session cookie from Steam (Windows DPAPI) or browser login
3. Encrypts and stores session using OS keyring (DPAPI/Keychain/libsecret)
4. Shows session selection dialog if multiple accounts available
5. Starts the Express server with selected session
6. Runs as system tray icon with controls

### Manual Extraction (Linux/Mac/Debugging)

If automatic extraction fails, you can manually extract the cookie:

#### Method 1: Browser DevTools (All Platforms)

1. Open Steam client and launch Shipping Manager
2. Open browser DevTools (F12)
3. Go to **Application** > **Cookies** > `https://shippingmanager.cc`
4. Find `shipping_manager_session` cookie
5. Copy the value

#### Method 2: Steam Database (Advanced)

**Linux:**
```bash
# Steam database location
~/.local/share/Steam/config/cookies.sqlite

# Extract cookie using sqlite3
sqlite3 ~/.local/share/Steam/config/cookies.sqlite \
  "SELECT value FROM cookies WHERE name='shipping_manager_session';"
```

**macOS:**
```bash
# Steam database location
~/Library/Application Support/Steam/config/cookies.sqlite

# Extract cookie using sqlite3
sqlite3 ~/Library/Application\ Support/Steam/config/cookies.sqlite \
  "SELECT value FROM cookies WHERE name='shipping_manager_session';"
```

**Windows (Manual):**
```bash
# Database location
%LOCALAPPDATA%\Steam\htmlcache\Cookies

# Use DB Browser for SQLite to open and extract cookie
# Download: https://sqlitebrowser.org/
```

#### Using the Manual Cookie

Once you have the cookie value, you need to manually store it in the encrypted session storage using Node.js:

```bash
# Use the session-manager module to store the cookie securely
node -e "
const sm = require('./server/utils/session-manager');
(async () => {
  await sm.saveSession('YOUR_USER_ID', 'YOUR_COOKIE_VALUE_HERE', 'YourCompanyName', 'manual');
  console.log('Session saved successfully');
})();
"
```

Then start the app normally with `python start.py`

⚠️ **Warning:** Never store cookies in plain text files or commit them to git!

## Starting the Application

### Recommended Method (All Platforms)

```bash
python start.py
```

This handles everything automatically (session management, server start, system tray icon).

### Alternative: Direct Server Start (No Tray Icon)

For development or if you don't want the tray icon:

```bash
# Make sure you have a valid session stored first
node app.js
```

The server will start at `https://localhost:12345`.

**Note:** This method still requires an encrypted session to be available. Run `python start.py` at least once to set up your session.

### Accessing the Application

1. Open your browser to `https://localhost:12345`
2. Accept the self-signed certificate warning
3. You should see the ShippingManager CoPilot interface

### Network Access

The server binds to `0.0.0.0` (all network interfaces) by default, allowing access from other devices on your network.

**Find your network IP:**
```bash
# Linux
ip addr show | grep "inet "

# Mac
ifconfig | grep "inet "

# Windows
ipconfig | findstr "IPv4"
```

Access from other devices: `https://YOUR_IP:12345` (e.g., `https://192.168.1.100:12345`)

⚠️ **Security:** Accept the certificate warning on each device.

## Configuration

Configuration is stored in `server/config.js`:

```javascript
module.exports = {
  PORT: 12345,
  HOST: '0.0.0.0',  // Listens on all network interfaces
  SHIPPING_MANAGER_API: 'https://shippingmanager.cc/api',

  // Session cookie loaded from encrypted storage via session-manager
  get SESSION_COOKIE() {
    return getSessionCookie() || 'COOKIE_NOT_INITIALIZED';
  },

  // Rate limiting
  RATE_LIMIT: {
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 1000                   // Max requests per window
  },

  // Chat auto-refresh interval
  CHAT_REFRESH_INTERVAL: 25000  // 25 seconds
};
```

**Note:** These values are hardcoded in the .exe distribution. See the [User-Configurable Settings](../../development/for-claude/Planned_Features/user-configurable-settings.md) feature plan for future improvements.

## Development Workflow

### Running in Development Mode

```bash
# First-time setup: Create encrypted session
python start.py  # Follow prompts to set up session

# After session is set up, run server directly without tray icon
node app.js

# Or with auto-restart on file changes (requires nodemon)
npm install -g nodemon
nodemon app.js
```

**Note:** You must run `python start.py` at least once to create an encrypted session before using `node app.js` directly.

### Viewing Logs

All server activity is logged to the console. Look for:
- Server startup messages with network URLs
- API request logs (alliance chat, messages, game actions)
- WebSocket connection events
- Error messages and stack traces

### Debugging

**Enable verbose logging:**
```bash
# Set DEBUG environment variable
export DEBUG=express:*,ws:*
node app.js
```

**Check session status:**
```bash
# View encrypted sessions (requires session-manager access)
node -e "const sm = require('./server/utils/session-manager'); sm.getAvailableSessions().then(console.log);"
```

**Test API endpoints manually:**
```bash
# Get alliance chat (use -k to skip certificate verification)
curl -k https://localhost:12345/api/chat

# Get vessels in harbor
curl -k https://localhost:12345/api/vessel/get-vessels
```

### Hot Reload (Frontend Only)

The frontend auto-refreshes when you edit files in `public/`:
1. Open DevTools > Console
2. Edit `public/js/script.js` or `public/css/style.css`
3. Refresh the browser to see changes

For backend changes (`server/`, `app.js`), restart the server:
```bash
Ctrl+C
python start.py
```

## Troubleshooting

### "Session cookie not found"

**Cause:** No session available yet or Steam database doesn't contain the cookie.

**Solution:**
1. Launch Steam client
2. Open Shipping Manager in-game browser at least once
3. Log in to your account
4. Run `python start.py` - it will extract and encrypt the session automatically

### "Cannot find module 'pywin32'" (Windows)

**Cause:** Python package not installed or wrong Python version.

**Solution:**
```bash
# Verify Python version
python --version  # Must be 3.10+

# Reinstall pywin32
pip uninstall pywin32
pip install pywin32

# If using multiple Python versions, specify:
py -3.10 -m pip install pywin32
```

### "Error: EADDRINUSE: address already in use"

**Cause:** Port 12345 is already in use by another application.

**Solution:**
```bash
# Find process using port 12345
# Windows:
netstat -ano | findstr :12345

# Linux/Mac:
lsof -i :12345

# Kill the process or change PORT in server/config.js
```

### "Steam won't restart" (Windows)

**Cause:** Steam.exe path not found or process not terminating cleanly.

**Solution:**
1. Manually close Steam
2. Start `node app.js` (direct server start without tray icon)
3. Manually restart Steam after server starts

### "Certificate error" on mobile/other devices

**Cause:** Self-signed certificate not trusted by device.

**Solution:**
1. Navigate to `https://YOUR_IP:12345`
2. Click "Advanced" or "Show Details"
3. Click "Proceed to localhost (unsafe)" or "Accept Risk and Continue"
4. Each device must accept the certificate individually

### "WebSocket connection failed"

**Cause:** Browser blocking WSS connection due to certificate or CORS.

**Solution:**
1. Ensure you're using `https://` (not `http://`)
2. Accept the certificate warning in the main page first
3. Check browser console for specific error messages
4. Verify WebSocket connection in DevTools > Network > WS tab

### Session Cookie Expired

**Symptoms:**
- 401 Unauthorized errors
- "Session invalid" messages
- Forced logout

**Solution:**
1. Exit the application (right-click tray icon → Exit)
2. Open Shipping Manager in Steam and log in again
3. Run `python start.py` - it will detect expired session and prompt for re-login

**Session Lifetime:**
- Typically lasts several weeks to months
- Refreshed automatically when you play the game
- Encrypted sessions are automatically validated and refreshed by start.py

## Platform-Specific Notes

### Windows

- Automatic session extraction works out of the box
- Steam process management is handled automatically
- HTTPS certificates include all network IPs (LAN access)

### Linux

- Manual session extraction required (no DPAPI equivalent)
- Steam process management must be done manually
- Use `keyring` package for secure credential storage
- May need to run with `sudo` for Steam process access

### macOS

- Manual session extraction required
- Steam database location differs from Linux
- May need to grant Terminal.app "Full Disk Access" in System Preferences
- Use Homebrew for dependency management

## Next Steps

- **Build the Application:** See [Build Guide](./build-guide.md) for creating standalone executables
- **View Documentation:** Start the app and visit `https://localhost:12345/docs/`
- **Report Issues:** Check GitHub Issues for known problems or create a new one

## Security Considerations

⚠️ **Important Security Notes:**

1. **Session Cookie = Full Account Access**
   - The session cookie provides complete access to your Shipping Manager account
   - Never share your cookie with others
   - Never commit cookies to version control

2. **Terms of Service**
   - This tool likely violates Shipping Manager's Terms of Service
   - Use at your own risk
   - The developers assume no liability

3. **Network Access**
   - Server binds to `0.0.0.0` (all interfaces) by default
   - Other devices on your network can access the app
   - HTTPS provides encryption, but certificate is self-signed
   - Consider changing HOST to `127.0.0.1` in `server/config.js` for localhost-only access

4. **Input Validation**
   - Current implementation has limited input validation
   - See [Input Validation Security](../../development/for-claude/Planned_Features/input-validation-security.md) for planned improvements
   - Be cautious with user-generated content in chat

## Support

If you encounter issues not covered in this guide:
1. Check the [README.md](../../README.md) for general information
2. Review the [API Reference](../../development/for-claude/API-REFERENCE.md)
3. Check GitHub Issues for similar problems
4. Create a new issue with detailed error messages and system information
