/**
 * @fileoverview Build Package Script
 *
 * Organizes compiled executables and assets into deployment folder structure.
 * Run after: npm run build:sea
 *
 * Creates:
 * - dist/ShippingManagerCoPilot-v{version}/
 *   - ShippingManagerCoPilot-Server.exe (Node.js SEA - Server with tray icon)
 *   - ShippingManagerCoPilot-Launcher.exe (C# launcher - starts server without console)
 *   - public/ (web assets)
 *   - sysdata/ (system data)
 *   - LICENSE
 *   - README.md
 *   - START_HERE.txt
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const packageJson = require('../package.json');
const version = packageJson.version;

const distFolder = path.join(__dirname, '..', 'dist');
const outputFolder = path.join(distFolder, `ShippingManagerCoPilot-v${version}`);

console.log('='.repeat(60));
console.log('Building ShippingManager CoPilot Package');
console.log('='.repeat(60));
console.log(`Version: ${version}`);
console.log(`Output: ${outputFolder}`);
console.log();

// Create folder structure
console.log('[1/6] Creating folder structure...');
if (fs.existsSync(outputFolder)) {
    fs.rmSync(outputFolder, { recursive: true, force: true });
}
fs.mkdirSync(outputFolder, { recursive: true });

// Create userdata directory structure (will be created in AppData on first run, but include for portable mode)
const userdataFolder = path.join(outputFolder, 'userdata');
const userdataSubfolders = ['settings', 'certs', 'logs'];
for (const subfolder of userdataSubfolders) {
    const subfolderPath = path.join(userdataFolder, subfolder);
    fs.mkdirSync(subfolderPath, { recursive: true });
    fs.writeFileSync(path.join(subfolderPath, '.gitkeep'), '');
}
console.log('  [OK] Folders created');

// Copy sysdata
const sysdataSrc = path.join(__dirname, '..', 'sysdata');
const sysdataDest = path.join(outputFolder, 'sysdata');
if (fs.existsSync(sysdataSrc)) {
    copyDir(sysdataSrc, sysdataDest);
    console.log('  [OK] sysdata/ copied');
}

// Copy executables
console.log('[2/6] Copying executables...');

// Main executable (from build:sea)
const mainExe = path.join(distFolder, 'ShippingManagerCoPilot-Server.exe');
if (!fs.existsSync(mainExe)) {
    console.error('  [ERROR] ShippingManagerCoPilot-Server.exe not found!');
    console.error('  Run: npm run build:sea');
    process.exit(1);
}
fs.copyFileSync(mainExe, path.join(outputFolder, 'ShippingManagerCoPilot-Server.exe'));
console.log('  [OK] ShippingManagerCoPilot-Server.exe copied');

// C# Launcher executable (Windows only)
const launcherExe = path.join(distFolder, 'ShippingManagerCoPilot-Launcher.exe');
if (fs.existsSync(launcherExe)) {
    fs.copyFileSync(launcherExe, path.join(outputFolder, 'ShippingManagerCoPilot-Launcher.exe'));
    console.log('  [OK] ShippingManagerCoPilot-Launcher.exe copied');
} else {
    console.warn('  [WARN] ShippingManagerCoPilot-Launcher.exe not found - Windows GUI launcher will not be included');
}

// Copy public folder
console.log('[3/6] Copying public assets...');
const publicSrc = path.join(distFolder, 'public');
const publicDest = path.join(outputFolder, 'public');
if (fs.existsSync(publicSrc)) {
    copyDir(publicSrc, publicDest);
    console.log('  [OK] public/ copied');
} else {
    console.error('  [ERROR] public/ not found in dist/');
    console.error('  Run: npm run build:sea');
    process.exit(1);
}

// Copy node_modules (for native modules like keytar)
console.log('[4/6] Copying native modules...');
const nodeModulesSrc = path.join(distFolder, 'node_modules');
if (fs.existsSync(nodeModulesSrc)) {
    const nodeModulesDest = path.join(outputFolder, 'node_modules');
    copyDir(nodeModulesSrc, nodeModulesDest);
    console.log('  [OK] node_modules/ copied (native modules)');
}

// Copy helper/launcher/nodejs/dialogs (HTML files for GUI dialogs)
const dialogsSrc = path.join(distFolder, 'helper', 'launcher', 'nodejs', 'dialogs');
if (fs.existsSync(dialogsSrc)) {
    const dialogsDest = path.join(outputFolder, 'helper', 'launcher', 'nodejs', 'dialogs');
    copyDir(dialogsSrc, dialogsDest);
    console.log('  [OK] helper/launcher/nodejs/dialogs/ copied');
}

// Copy package.json (for version info)
const packageJsonSrc = path.join(distFolder, 'package.json');
if (fs.existsSync(packageJsonSrc)) {
    fs.copyFileSync(packageJsonSrc, path.join(outputFolder, 'package.json'));
    console.log('  [OK] package.json copied');
}

// Copy documentation
console.log('[5/6] Copying documentation...');
const docs = [
    { src: 'README.md', required: false },
    { src: 'LICENSE', required: false }
];

for (const doc of docs) {
    const srcPath = path.join(__dirname, '..', doc.src);
    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(outputFolder, doc.src));
        console.log(`  [OK] ${doc.src} copied`);
    } else if (doc.required) {
        console.error(`  [ERROR] ${doc.src} not found!`);
        process.exit(1);
    }
}

// Create startup instructions
const startupGuide = `ShippingManager CoPilot v${version}
${'='.repeat(60)}

QUICK START:
1. Run the installer or extract this folder
2. Double-click ShippingManagerCoPilot-Server.exe to start
3. Open https://localhost:12345 in your browser

FIRST RUN:
- Accept the self-signed certificate warning in your browser
- Log in via Steam extraction or browser login when prompted

HEADLESS MODE (no GUI):
  ShippingManagerCoPilot-Server.exe

  Or with npm (development):
  npm run start:headless

CLI OPTIONS:
  --list-sessions           List all saved sessions
  --add-session-interactive Add a new session via CLI
  --remove-session=<id>     Remove a session

DATA STORAGE:
- Windows: %LOCALAPPDATA%/ShippingManagerCoPilot/userdata/
- Portable: ./userdata/ (if exists)

TROUBLESHOOTING:
- Steam session fails: Close Steam completely, restart app
- Port in use: Set PORT environment variable

For full documentation, see README.md
`;

fs.writeFileSync(path.join(outputFolder, 'START_HERE.txt'), startupGuide);
console.log('  [OK] START_HERE.txt created');

console.log();
console.log('='.repeat(60));
console.log('[OK] Package created!');
console.log('='.repeat(60));
console.log(`Location: ${outputFolder}`);
console.log();

// Create app-payload.zip for installer
console.log('[6/6] Creating installer payload...');
const installerResourcesFolder = path.join(__dirname, '..', 'helper', 'installer', 'Resources');
const payloadZipPath = path.join(installerResourcesFolder, 'app-payload.zip');

if (!fs.existsSync(installerResourcesFolder)) {
    fs.mkdirSync(installerResourcesFolder, { recursive: true });
}

if (fs.existsSync(payloadZipPath)) {
    fs.unlinkSync(payloadZipPath);
}

const output = fs.createWriteStream(payloadZipPath);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.on('error', (err) => {
    console.error('  [ERROR] Failed to create installer payload:', err.message);
    process.exit(1);
});

output.on('close', () => {
    const sizeInMB = (archive.pointer() / 1024 / 1024).toFixed(2);
    console.log(`  [OK] Installer payload created (${sizeInMB} MB)`);
    console.log(`  Location: ${payloadZipPath}`);
    console.log();
    console.log('Next steps:');
    console.log('  1. Test: Run ShippingManagerCoPilot-Server.exe');
    console.log('  2. Build installer: npm run build:installer');
    console.log();
});

archive.pipe(output);
archive.directory(outputFolder, false);
archive.finalize();

/**
 * Copy directory recursively
 */
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
