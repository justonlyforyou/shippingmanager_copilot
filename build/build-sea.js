/**
 * @fileoverview Build script for Node.js Single Executable Application (SEA)
 *
 * This script:
 * 1. Bundles app.js and all dependencies into a single CJS file using esbuild
 * 2. Generates the SEA blob using Node.js
 * 3. Copies the Node binary and injects the blob using postject
 * 4. Copies required assets (public/, sysdata/, native modules)
 *
 * Usage: node build/build-sea.js [--platform=win|mac|linux]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Parse arguments
const args = process.argv.slice(2);
const platformArg = args.find(a => a.startsWith('--platform='));
const platform = platformArg ? platformArg.split('=')[1] : process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

const isWindows = platform === 'win';
const isMac = platform === 'mac';
const isLinux = platform === 'linux';

const OUTPUT_NAME = isWindows ? 'ShippingManagerCoPilot-Server.exe' : 'ShippingManagerCoPilot-Server';
const NODE_BINARY = isWindows ? 'node.exe' : 'node';

console.log(`[SEA Build] Platform: ${platform}`);
console.log(`[SEA Build] Output: ${OUTPUT_NAME}`);

// Ensure dist directory exists
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// Step 1: Bundle with esbuild
console.log('\n[SEA Build] Step 1: Bundling with esbuild...');

// External packages that shouldn't be bundled:
// - Native modules (keytar)
// - Browser automation (puppeteer, selenium-webdriver) - have their own binaries
// - Optional dependencies that may not be installed
const externals = [
  'keytar',
  'puppeteer',
  'selenium-webdriver',
  '@aws-sdk/client-s3',  // Optional dependency of unzipper
  'mock-aws-s3',         // Optional test dependency
  'aws-sdk',             // Optional AWS SDK
  'nock'                 // Optional test dependency
].map(e => `--external:${e}`).join(' ');

try {
  execSync(`npx esbuild app.js --bundle --platform=node --target=node22 --outfile=dist/bundle.cjs --format=cjs ${externals}`, {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });
} catch (err) {
  console.error('[SEA Build] esbuild failed:', err.message);
  process.exit(1);
}

// Step 2: Generate SEA blob
console.log('\n[SEA Build] Step 2: Generating SEA blob...');
try {
  execSync('node --experimental-sea-config sea-config.json', {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });
} catch (err) {
  console.error('[SEA Build] SEA blob generation failed:', err.message);
  process.exit(1);
}

// Step 3: Copy Node binary
console.log('\n[SEA Build] Step 3: Copying Node binary...');
const outputPath = path.join(DIST_DIR, OUTPUT_NAME);

// Find node binary
let nodePath;
if (isWindows) {
  nodePath = execSync('where node', { encoding: 'utf8' }).trim().split('\n')[0].trim();
} else {
  nodePath = execSync('which node', { encoding: 'utf8' }).trim();
}
console.log(`[SEA Build] Node binary: ${nodePath}`);

// Copy node binary
fs.copyFileSync(nodePath, outputPath);

// Make executable on Unix
if (!isWindows) {
  fs.chmodSync(outputPath, 0o755);
}

// Step 4: Remove signature (required before injection)
console.log('\n[SEA Build] Step 4: Removing signature...');
if (isWindows) {
  // On Windows, try to remove signature with signtool if available
  try {
    execSync(`signtool remove /s "${outputPath}"`, { stdio: 'pipe' });
    console.log('[SEA Build] Signature removed');
  } catch {
    console.log('[SEA Build] No signature to remove or signtool not available (OK)');
  }
} else if (isMac) {
  try {
    execSync(`codesign --remove-signature "${outputPath}"`, { stdio: 'inherit' });
    console.log('[SEA Build] macOS signature removed');
  } catch (err) {
    console.log('[SEA Build] codesign failed (may be OK):', err.message);
  }
}

// Step 5: Inject SEA blob with postject
console.log('\n[SEA Build] Step 5: Injecting SEA blob...');
const blobPath = path.join(DIST_DIR, 'sea-prep.blob');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

let postjectCmd = `npx postject "${outputPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${FUSE}`;

if (isMac) {
  postjectCmd += ' --macho-segment-name NODE_SEA';
}

try {
  execSync(postjectCmd, {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });
} catch (err) {
  console.error('[SEA Build] postject failed:', err.message);
  process.exit(1);
}

// Step 6: Copy assets
console.log('\n[SEA Build] Step 6: Copying assets...');

// Copy public directory
const publicSrc = path.join(ROOT_DIR, 'public');
const publicDest = path.join(DIST_DIR, 'public');
if (fs.existsSync(publicDest)) {
  fs.rmSync(publicDest, { recursive: true });
}
copyDir(publicSrc, publicDest);
console.log('[SEA Build] Copied public/');

// Copy sysdata directory
const sysdataSrc = path.join(ROOT_DIR, 'sysdata');
const sysdataDest = path.join(DIST_DIR, 'sysdata');
if (fs.existsSync(sysdataDest)) {
  fs.rmSync(sysdataDest, { recursive: true });
}
if (fs.existsSync(sysdataSrc)) {
  copyDir(sysdataSrc, sysdataDest);
  console.log('[SEA Build] Copied sysdata/');
}

// Copy package.json (for version info)
fs.copyFileSync(
  path.join(ROOT_DIR, 'package.json'),
  path.join(DIST_DIR, 'package.json')
);
console.log('[SEA Build] Copied package.json');

// Copy native modules (keytar)
const keytarSrc = path.join(ROOT_DIR, 'node_modules', 'keytar');
const keytarDest = path.join(DIST_DIR, 'node_modules', 'keytar');
if (fs.existsSync(keytarSrc)) {
  if (fs.existsSync(keytarDest)) {
    fs.rmSync(keytarDest, { recursive: true });
  }
  fs.mkdirSync(path.join(DIST_DIR, 'node_modules'), { recursive: true });
  copyDir(keytarSrc, keytarDest);
  console.log('[SEA Build] Copied node_modules/keytar/');
}

// Clean up temporary files
console.log('\n[SEA Build] Cleaning up...');
fs.unlinkSync(path.join(DIST_DIR, 'bundle.cjs'));
fs.unlinkSync(path.join(DIST_DIR, 'sea-prep.blob'));

console.log(`\n[SEA Build] SUCCESS! Output: ${outputPath}`);
console.log(`[SEA Build] Size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);

// Helper function to copy directory recursively
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
