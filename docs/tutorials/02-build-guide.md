# Build Instructions

Complete guide for compiling ShippingManager CoPilot into a standalone Windows executable.

## Prerequisites

### Required Software

1. **Node.js 22+** (https://nodejs.org/)
   ```bash
   node --version  # Should be >= 22.0.0
   ```

2. **Python 3.10+** (https://www.python.org/)
   ```bash
   python --version  # Should be >= 3.10
   ```

3. **.NET 8.0 SDK** (https://dotnet.microsoft.com/download)
   ```bash
   dotnet --version  # Should be >= 8.0
   ```

4. **PyInstaller** (for Python → .exe compilation)
   ```bash
   pip install pyinstaller
   ```

5. **pkg** (for Node.js → .exe compilation)
   ```bash
   npm install -g pkg
   ```

### Python Dependencies

**Windows:**
```bash
pip install pywin32 cryptography keyring pystray pillow requests urllib3
```

**Linux/Mac:**
```bash
pip install keyring cryptography pystray pillow requests urllib3
```

**Optional (for demo/screenshots):**
```bash
pip install selenium opencv-python
```

### Node.js Dependencies

```bash
npm install
```

## Build Process

### Quick Build (Recommended)

The easiest way to build everything is using the automated build script:

```bash
npm run build
```

This single command will:
1. Check all dependencies (Node.js, Python, PyInstaller, pkg, .NET SDK)
2. Install Node.js dependencies
3. Generate documentation
4. Compile Node.js application to .exe (ShippingManagerCoPilot-Server.exe)
5. Compile Python launcher with embedded Node.js server (ShippingManagerCoPilot.exe)
6. Create deployment package with app-payload.zip
7. Build WPF installer executable

**Output:**
- `dist/ShippingManagerCoPilot-v0.1.0/` (portable folder with single .exe)
- `dist/ShippingManagerCoPilot-Installer-v0.1.0.exe` (WPF installer)
- `dist/checksums.txt` (SHA256 hashes)
- `public/docs/` (documentation)

**Options:**
```bash
npm run build -- --skip-deps        # Skip npm install
npm run build -- --skip-docs        # Skip documentation generation
npm run build -- --clean            # Clean dist folder before build
```

**Example:**
```bash
# Fast rebuild without reinstalling dependencies
npm run build -- --skip-deps

# Clean build from scratch
npm run build -- --clean
```

### Step-by-Step Build (Advanced)

If you want to build components separately:

#### Step 1: Compile Node.js Server to .exe

**IMPORTANT:** This step MUST be done first, as the resulting .exe is embedded in the Python launcher.

```bash
npm run build:node
```

This creates:
- `dist/ShippingManagerCoPilot-Server.exe` (Node.js backend server)

This file will be embedded as a resource in the Python launcher in the next step.

#### Step 2: Compile Python Launcher with Embedded Server

```bash
npm run build:python
```

This creates:
- `dist/ShippingManagerCoPilot.exe` (Python launcher with embedded Node.js server)

The Node.js server exe from Step 1 is automatically embedded as a resource and extracted to temp folder at runtime.

#### Step 3: Package Everything

```bash
node build-package.js
```

This organizes all files into:
```
dist/ShippingManagerCoPilot-v0.1.0/
├── ShippingManagerCoPilot.exe  (single-file: Python launcher + embedded Node.js server)
├── sysdata/
│   └── forecast/  (forecast cache, created at runtime)
├── userdata/  (user settings, created at runtime in AppData on first run)
├── public/
│   └── favicon.ico
├── README.md
├── LICENSE
└── START_HERE.txt
```

This also creates `installer/Resources/app-payload.zip` which embeds the entire application into the installer.

**Note:** All helper scripts (get-session-windows, login-dialog, session-selector) are embedded in the main .exe file.

#### Step 4: Build Installer

```bash
node build-installer.js
```

This creates:
- `dist/ShippingManagerCoPilot-Installer-v0.1.0.exe` (WPF installer with embedded app-payload.zip)
- `dist/checksums.txt` (SHA256 hash for verification)

The installer is a self-contained Windows executable that:
- Guides users through installation with modern UI
- Allows custom installation path selection
- Creates Start Menu and Desktop shortcuts
- Registers with Windows Programs & Features for uninstallation
- Extracts app-payload.zip to the chosen location

## Testing the Build

1. Navigate to `dist/ShippingManagerCoPilot-v0.1.0/`
2. Double-click `ShippingManagerCoPilot.exe`
3. Verify:
   - Server starts at https://localhost:12345
   - Session extraction works
   - Browser opens automatically
   - All features functional

## Troubleshooting

### PyInstaller Issues

**Error: `Module not found`**
```bash
# Add missing modules to build-python.spec hiddenimports
hiddenimports=['win32crypt', 'win32api', 'cryptography', 'your_missing_module']
```

**Error: `Failed to execute script`**
- Check Python script runs standalone first: `python helper/get-session-windows.py`
- Enable debug mode: Edit .spec file and set `debug=True`

### pkg Issues

**Error: `Cannot find module`**
- pkg.assets is already configured in package.json (lines 19-38)
- Includes: public/, server/, sysdata/forecast/, all dependencies
- If adding new dependencies, add them to pkg.assets array
- If adding new folders, add them with glob pattern (folder + slash + two asterisks + slash + asterisk)

**Error: `Native module not found`**
- Some modules (like `keytar`) need native binaries
- Solution: Bundle as external dependency or use alternative

## File Size Optimization

Current estimated sizes:
- Node.js Server .exe: ~80-100 MB (embedded)
- Python Launcher .exe (with embedded Node.js server): ~100-120 MB
- Total single-file executable: ~100-120 MB

### Reduce Size (Optional)

1. **Enable UPX compression** (in build-python.spec):
   ```python
   upx=True,
   upx_exclude=[],
   ```

2. **Exclude unused modules** (in build-python.spec):
   ```python
   excludes=['tkinter', 'matplotlib', 'numpy'],
   ```

3. **pkg compression**:
   ```bash
   pkg . --compress GZip
   ```

## Distribution

### Portable ZIP

```bash
cd dist
powershell Compress-Archive -Path ShippingManagerCoPilot-v0.1.0 -DestinationPath ShippingManagerCoPilot-v0.1.0-Portable.zip
```

The ZIP file contains the single-file executable and supporting files (README, LICENSE, data folder structure).

## Version Updates

1. Update version in `package.json`
2. Rebuild: `npm run build`

## Clean Build

```bash
# Remove all build artifacts
rmdir /s /q dist
rmdir /s /q build

# Rebuild from scratch
npm run build -- --clean
```

## Creating Releases

### Release Process

Releases are automated via GitHub Actions when you push a version tag:

```bash
# 1. Update version in package.json
npm version 0.1.0 --no-git-tag-version

# 2. Commit version bump
git add package.json
git commit -m "Release v0.1.0"

# 3. Create and push tag
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

**Or push both together:**
```bash
git push origin main --tags
```

### What Happens Next

When you push a tag matching `v*.*.*`:

1. **GitHub Actions Triggers** (`.github/workflows/release.yml`)
2. **Installs Dependencies:**
   - Node.js 20
   - Python 3.11
   - .NET 8.0 SDK
   - PyInstaller, pkg
3. **Runs Build:** `npm run build:all`
4. **Creates GitHub Release** with the tag name
5. **Uploads Release Assets:**
   - `ShippingManagerCoPilot-Installer-v{version}.exe`
   - `checksums.txt` (SHA256 hash)

### Testing Before Release

Always test locally before creating a release tag:

```bash
# Full build
npm run build:all

# Test the installer
dist/ShippingManagerCoPilot-Installer-v0.1.0.exe

# Verify checksum
type dist\checksums.txt
```

### Release Asset Distribution

Users download **only the installer** from GitHub Releases:
- No ZIP files (installer handles extraction)
- SHA256 checksum included for verification
- Installer is self-contained (includes .NET runtime)

### Version Management

Version is defined in `package.json` (single source of truth):
- Used by `build-package.js` for folder naming
- Used by `build-installer.js` for executable naming
- Synced to installer `.csproj` AssemblyVersion

### CI/CD Workflow

The GitHub Actions workflow (`.github/workflows/release.yml`) runs on:
- **Trigger:** Tag push matching `v*.*.*`
- **Runner:** Windows (required for .NET builds)
- **Build Time:** ~10-15 minutes
- **Output:** Release with installer attached

**Workflow Steps:**
```yaml
- Checkout code
- Setup Node.js 20
- Setup Python 3.11
- Setup .NET 8.0 SDK
- Install dependencies (npm, pip)
- Run build:all
- Create GitHub Release
- Upload installer + checksums
```

## Support

If you encounter issues:
1. Check this file for troubleshooting steps
2. Verify all prerequisites are installed
3. Try a clean build
4. Check GitHub Issues for known problems

## Documentation

This project includes comprehensive JSDoc documentation for all modules and functions.

### Generate Documentation

```bash
# Generate HTML documentation
npm run docs
```

The documentation is automatically:
- Generated before every commit (via git pre-commit hook)
- Served by the application at `https://localhost:12345/docs/index.html`
- Accessible via the 📖 button in the UI (next to settings ⚙️)

### What's Included

The documentation includes:
- All backend modules (server routes, utilities, middleware)
- All frontend modules (API, automation, bunker management, chat, coop, messenger, vessel management, etc.)
- Function signatures, parameters, return values, and examples
- This build guide and installation instructions (Tutorials section)

### View Documentation

1. Start the application (`python start.py`)
2. Click the 📖 button in the UI, or
3. Navigate to `https://localhost:12345/docs/index.html`

### Documentation Structure

- **Home**: README with project overview
- **Tutorials**: Build guide and installation instructions
- **Classes**: ChatBot and other class documentation
- **Modules**: All code modules organized by functionality
- **Global**: Global functions and constants

### Rebuild Documentation

Documentation is automatically rebuilt when you commit changes. To manually rebuild:

```bash
npm run docs
```

Generated files are located in `public/docs/` and are included in git commits.

## Security Tooling

**All code is automatically scanned for security vulnerabilities before every commit:**

- **ESLint Security Plugin**: Scans JavaScript/Node.js code for security issues
  - Detects: unsafe regex (ReDoS), eval usage, command injection, hardcoded secrets
  - Run manually: `npm run lint`
  - Configuration: `eslint.config.js`

- **Bandit Python Linter**: Scans Python code for security vulnerabilities
  - Detects: SQL injection, command injection, insecure YAML, pickle usage
  - Run manually: `npm run bandit` or `python -m bandit -r helper/ -c .bandit`
  - Configuration: `.bandit` (YAML)

- **Pre-commit Hooks**: Automated security gates block commits on errors
  - npm audit (HIGH/CRITICAL vulnerabilities)
  - ESLint errors (security issues)
  - Bandit critical issues (Python security)
