/**
 * @fileoverview Build Installer Script
 *
 * Compiles the WPF installer and creates final release artifacts.
 * Run after: npm run build:all (which creates app-payload.zip)
 *
 * Creates:
 * - dist/ShippingManagerCoPilot-Installer-v{version}.exe
 * - dist/checksums.txt (SHA256 hashes)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const packageJson = require('../package.json');
const version = packageJson.version;

const distFolder = path.join(__dirname, '..', 'dist');
const installerProject = path.join(__dirname, '..', 'helper', 'installer');
const payloadZipPath = path.join(installerProject, 'Resources', 'app-payload.zip');

console.log('='.repeat(60));
console.log('Building ShippingManager CoPilot Installer');
console.log('='.repeat(60));
console.log(`Version: ${version}`);
console.log();

// Check prerequisites
console.log('[1/5] Checking prerequisites...');

// Check for app-payload.zip
if (!fs.existsSync(payloadZipPath)) {
    console.error('  [ERROR] app-payload.zip not found!');
    console.error('  Location: installer/Resources/app-payload.zip');
    console.error('  Run: node build-package.js first');
    process.exit(1);
}
const payloadSizeInMB = (fs.statSync(payloadZipPath).size / 1024 / 1024).toFixed(2);
console.log(`  [OK] app-payload.zip found (${payloadSizeInMB} MB)`);

// Check for .NET SDK
try {
    const dotnetVersion = execSync('dotnet --version', { encoding: 'utf8' }).trim();
    console.log(`  [OK] .NET SDK found (${dotnetVersion})`);
} catch {
    console.error('  [ERROR] .NET SDK not found!');
    console.error('  Install from: https://dotnet.microsoft.com/download');
    console.error('  Required: .NET 8.0 SDK or later');
    process.exit(1);
}

// Clean previous build artifacts to prevent stale cache
console.log('[2/6] Cleaning previous build artifacts...');
try {
    execSync('dotnet clean helper/installer -c Release', { stdio: 'inherit' });
    console.log('  [OK] Build artifacts cleaned');
} catch {
    console.error('  [ERROR] Failed to clean build');
    process.exit(1);
}

// Restore dependencies
console.log('[3/6] Restoring .NET dependencies...');
try {
    execSync('dotnet restore helper/installer', { stdio: 'inherit' });
    console.log('  [OK] Dependencies restored');
} catch {
    console.error('  [ERROR] Failed to restore dependencies');
    process.exit(1);
}

// Build installer with PublishSingleFile (C# self-extracting)
console.log('[4/6] Building self-extracting installer...');
try {
    // Pass version from package.json to MSBuild properties (no calculation, use as-is)
    const buildCommand = `dotnet publish helper/installer -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:FileVersion=${version} -p:AssemblyVersion=${version}`;
    console.log(`  Running: ${buildCommand}`);
    execSync(buildCommand, { stdio: 'inherit' });
    console.log('  [OK] Installer built successfully');
} catch {
    console.error('  [ERROR] Failed to build installer');
    process.exit(1);
}

// Copy installer to dist folder
console.log('[5/6] Copying installer...');
const publishFolder = path.join(installerProject, 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'win-x64', 'publish');
const setupExePath = path.join(publishFolder, 'Setup.exe');

if (!fs.existsSync(setupExePath)) {
    console.error('  [ERROR] Setup.exe not found!');
    console.error(`  Expected location: ${setupExePath}`);
    process.exit(1);
}

// Create dist folder if needed
if (!fs.existsSync(distFolder)) {
    fs.mkdirSync(distFolder, { recursive: true });
}

// Copy and rename to final installer
const installerOutputPath = path.join(distFolder, `ShippingManagerCoPilot-Installer-v${version}.exe`);
fs.copyFileSync(setupExePath, installerOutputPath);

const installerSize = fs.statSync(installerOutputPath).size;
const installerSizeInMB = (installerSize / 1024 / 1024).toFixed(2);
console.log(`  [OK] Single-file installer: ${installerSizeInMB} MB`);
console.log(`  Location: ${installerOutputPath}`);

// Generate checksums
console.log('[6/6] Generating checksums...');

function generateSHA256(filePath) {
    const hash = crypto.createHash('sha256');
    const fileBuffer = fs.readFileSync(filePath);
    hash.update(fileBuffer);
    return hash.digest('hex');
}

const installerHash = generateSHA256(installerOutputPath);
const checksumFile = path.join(distFolder, 'checksums.txt');

const checksumContent = `SHA256 Checksums - ShippingManager CoPilot v${version}
${'='.repeat(60)}

ShippingManagerCoPilot-Installer-v${version}.exe
${installerHash}

Generated: ${new Date().toISOString()}
`;

fs.writeFileSync(checksumFile, checksumContent);
console.log('  [OK] Checksums generated');
console.log(`  Location: ${checksumFile}`);

console.log();
console.log('='.repeat(60));
console.log('[SUCCESS] Self-Extracting Installer Created!');
console.log('='.repeat(60));
console.log(`Installer: dist/ShippingManagerCoPilot-Installer-v${version}.exe`);
console.log(`Size: ${installerSizeInMB} MB (C# self-extracting single file)`);
console.log(`SHA256: ${installerHash}`);
console.log();
console.log('✅ SINGLE-FILE INSTALLER (C# Native):');
console.log('   • .NET self-extracting with embedded resources');
console.log('   • Automatically extracts WPF DLLs on first run');
console.log('   • All native DLLs included and working');
console.log('   • Can be distributed as a single .exe file');
console.log();
console.log('📝 How it works:');
console.log('   1. First run: Extracts DLLs to same directory');
console.log('   2. Restarts itself automatically');
console.log('   3. Second run: WPF starts with all DLLs present');
console.log('   4. No temporary folders, no external tools needed');
console.log();
console.log('Next steps:');
console.log('  1. Test installer: dist\\ShippingManagerCoPilot-Installer-v' + version + '.exe');
console.log('  2. Create git tag: git tag v' + version);
console.log('  3. Push tag: git push origin v' + version);
console.log('  4. GitHub Actions will create release automatically');
console.log();
