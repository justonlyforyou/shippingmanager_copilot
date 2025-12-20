# Build Instructions

Complete guide for compiling ShippingManager CoPilot into a standalone Windows executable.

## Prerequisites

### Required Software

1. **Node.js 22+** (https://nodejs.org/)
   ```bash
   node --version  # Should be >= 22.0.0
   ```

2. **.NET 8.0 SDK** (https://dotnet.microsoft.com/download)
   ```bash
   dotnet --version  # Should be >= 8.0
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
1. Check all dependencies (Node.js, .NET SDK)
2. Install Node.js dependencies
3. Generate documentation
4. Compile Node.js application to .exe (ShippingManagerCoPilot-Server.exe)
5. Compile C# launcher (ShippingManagerCoPilot.exe)
6. Create deployment package with app-payload.zip
7. Build WPF installer executable

**Output:**
- `dist/ShippingManagerCoPilot-v0.1.0/` (portable folder with launcher + server)
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

```bash
npm run build:node
```

This creates:
- `dist/ShippingManagerCoPilot-Server.exe` (Node.js backend server)

#### Step 2: Compile C# Launcher

```bash
npm run build:launcher
```

This creates:
- `dist/ShippingManagerCoPilot.exe` (C# launcher that manages the server)

The launcher:
- Starts the Node.js server
- Extracts Steam session cookies (Windows only)
- Opens the browser automatically
- Provides system tray integration

#### Step 3: Package Everything

```bash
node build/build-package.js
```

This organizes all files into:
```
dist/ShippingManagerCoPilot-v0.1.0/
├── ShippingManagerCoPilot.exe      (C# launcher)
├── ShippingManagerCoPilot-Server.exe (Node.js server)
├── sysdata/
│   └── forecast/  (forecast cache, created at runtime)
├── userdata/  (user settings, created at runtime in AppData on first run)
├── public/
│   └── favicon.ico
├── README.md
├── LICENSE
└── START_HERE.txt
```

This also creates `helper/installer/Resources/app-payload.zip` which embeds the entire application into the installer.

#### Step 4: Build Installer

```bash
node build/build-installer.js
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

### pkg Issues

**Error: `Cannot find module`**
- pkg.assets is already configured in package.json
- Includes: public/, server/, sysdata/forecast/, all dependencies
- If adding new dependencies, add them to pkg.assets array
- If adding new folders, add them with glob pattern

**Error: `Native module not found`**
- Some modules (like `keytar`) need native binaries
- Solution: Bundle as external dependency or use alternative

### .NET Build Issues

**Error: `SDK not found`**
- Ensure .NET 8.0 SDK is installed (not just runtime)
- Verify with: `dotnet --list-sdks`

**Error: `Project file not found`**
- Check that `helper/launcher/` directory exists
- Ensure `.csproj` file is present

## File Size

Current estimated sizes:
- Node.js Server .exe: ~80-100 MB
- C# Launcher .exe: ~1-2 MB
- Total package: ~100 MB

## Distribution

### Portable ZIP

```bash
cd dist
powershell Compress-Archive -Path ShippingManagerCoPilot-v0.1.0 -DestinationPath ShippingManagerCoPilot-v0.1.0-Portable.zip
```

The ZIP file contains the executables and supporting files (README, LICENSE, data folder structure).

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

When you push a tag matching `v*`:

1. **GitHub Actions Triggers** (`.github/workflows/build-multiplatform.yml`)
2. **Builds for all platforms in parallel:**
   - Windows (full features with Steam integration)
   - macOS Intel (x64)
   - macOS Apple Silicon (arm64)
   - Linux (x64)
3. **Creates GitHub Release** with all platform builds
4. **Uploads Release Assets:**
   - `ShippingManagerCoPilot-Installer-*.exe` (Windows)
   - `ShippingManagerCoPilot-macos-x64.dmg` (macOS Intel)
   - `ShippingManagerCoPilot-macos-arm64.dmg` (macOS Apple Silicon)
   - `ShippingManagerCoPilot-linux-x64.tar.gz` (Linux)
   - Checksums for each platform

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

Downloads available per platform:

| Platform | File | Notes |
|----------|------|-------|
| Windows | `.exe` installer | Full features (Steam + Browser login) |
| macOS Intel | `.dmg` | Browser login only |
| macOS Apple Silicon | `.dmg` | Browser login only (M1/M2/M3) |
| Linux | `.tar.gz` | Browser login only |

SHA256 checksums are provided for verification.

### Version Management

Version is defined in `package.json` (single source of truth):
- Used by `build-package.js` for folder naming
- Used by `build-installer.js` for executable naming
- Synced to installer `.csproj` AssemblyVersion

### CI/CD Workflow

The GitHub Actions workflow (`.github/workflows/build-multiplatform.yml`) runs on:
- **Trigger:** Tag push matching `v*` or manual dispatch
- **Runners:** Windows, macOS (Intel + ARM64), Linux
- **Build Time:** ~15-20 minutes (parallel builds)
- **Output:** Multi-platform release with all builds attached

**Build Jobs:**
- `build-windows` - Windows installer with .NET SDK
- `build-macos` - macOS Intel DMG
- `build-macos-arm64` - macOS Apple Silicon DMG
- `build-linux` - Linux tarball
- `create-release` - Combines all artifacts into GitHub Release

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
- Accessible via the docs button in the UI (next to settings)

### What's Included

The documentation includes:
- All backend modules (server routes, utilities, middleware)
- All frontend modules (API, automation, bunker management, chat, coop, messenger, vessel management, etc.)
- Function signatures, parameters, return values, and examples
- This build guide and installation instructions (Tutorials section)

### View Documentation

1. Start the application (run `ShippingManagerCoPilot.exe`)
2. Click the docs button in the UI, or
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

- **Pre-commit Hooks**: Automated security gates block commits on errors
  - npm audit (HIGH/CRITICAL vulnerabilities)
  - ESLint errors (security issues)

---

*Last updated: 2025-12-20*
