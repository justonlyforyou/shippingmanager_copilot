#!/usr/bin/env node
/**
 * @fileoverview Complete Build Script
 *
 * Automated build process for ShippingManager CoPilot.
 * Handles dependency checks, compilation, and packaging.
 *
 * Usage: node build.js [options]
 * Options:
 *   --skip-deps     Skip dependency installation
 *   --skip-docs     Skip documentation generation
 *   --skip-installer Skip installer creation
 *   --clean         Clean dist folder before build
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
    skipDeps: process.argv.includes('--skip-deps'),
    skipDocs: process.argv.includes('--skip-docs'),
    skipInstaller: process.argv.includes('--skip-installer'),
    clean: process.argv.includes('--clean'),
};

const packageJson = require('./package.json');
const version = packageJson.version;

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

// Formatting helpers
function header(text) {
    console.log();
    console.log(colors.bright + colors.cyan + '='.repeat(70) + colors.reset);
    console.log(colors.bright + colors.cyan + text + colors.reset);
    console.log(colors.bright + colors.cyan + '='.repeat(70) + colors.reset);
    console.log();
}

function step(number, total, text) {
    console.log(colors.bright + colors.blue + `[${number}/${total}] ${text}` + colors.reset);
}

function success(text) {
    console.log(colors.green + '  ✓ ' + text + colors.reset);
}

function warning(text) {
    console.log(colors.yellow + '  ⚠ ' + text + colors.reset);
}

function error(text) {
    console.log(colors.red + '  ✗ ' + text + colors.reset);
}

function info(text) {
    console.log(colors.cyan + '  ℹ ' + text + colors.reset);
}

// Execute command with output
function exec(command, options = {}) {
    try {
        const output = execSync(command, {
            encoding: 'utf8',
            stdio: options.silent ? 'pipe' : 'inherit',
            ...options
        });
        return { success: true, output };
    } catch (err) {
        return { success: false, error: err };
    }
}

// Check if command exists
function commandExists(command) {
    try {
        if (process.platform === 'win32') {
            execSync(`where ${command}`, { stdio: 'pipe' });
        } else {
            execSync(`which ${command}`, { stdio: 'pipe' });
        }
        return true;
    } catch {
        return false;
    }
}

// Build steps
const buildSteps = [];

// Step 1: Check dependencies
buildSteps.push({
    name: 'Checking dependencies',
    execute: () => {
        const checks = [];

        // Node.js version
        const nodeVersion = process.version;
        const requiredNode = packageJson.engines.node;
        checks.push({ name: 'Node.js', version: nodeVersion, required: requiredNode, ok: true });

        // Python
        const pythonCmd = commandExists('python') ? 'python' : (commandExists('python3') ? 'python3' : null);
        if (pythonCmd) {
            const result = exec(`${pythonCmd} --version`, { silent: true });
            if (result.success) {
                checks.push({ name: 'Python', version: result.output.trim(), ok: true });
            }
        } else {
            checks.push({ name: 'Python', version: 'Not found', ok: false });
        }

        // PyInstaller (check both direct command and python module)
        let pyinstallerCheck = exec('pyinstaller --version', { silent: true });
        if (!pyinstallerCheck.success && pythonCmd) {
            pyinstallerCheck = exec(`${pythonCmd} -m PyInstaller --version`, { silent: true });
        }
        if (pyinstallerCheck.success) {
            checks.push({ name: 'PyInstaller', version: pyinstallerCheck.output.trim(), ok: true });
        } else {
            checks.push({ name: 'PyInstaller', version: 'Not found', ok: false });
        }

        // Print results
        checks.forEach(check => {
            const status = check.ok ? '✓' : '✗';
            const color = check.ok ? colors.green : colors.red;
            console.log(`  ${color}${status} ${check.name}: ${check.version}${colors.reset}`);
        });

        // Check for critical failures
        const criticalFailures = checks.filter(c => !c.ok && !c.optional);
        if (criticalFailures.length > 0) {
            console.log();
            error('Missing required dependencies:');
            criticalFailures.forEach(c => {
                error(`  - ${c.name}`);
            });
            console.log();
            info('Install missing dependencies:');
            if (criticalFailures.some(c => c.name === 'Python')) {
                info('  Python: https://www.python.org/downloads/');
            }
            if (criticalFailures.some(c => c.name === 'PyInstaller')) {
                info('  PyInstaller: pip install pyinstaller');
            }
            process.exit(1);
        }

        return { success: true };
    }
});

// Step 2: Clean dist folder (optional)
if (config.clean) {
    buildSteps.push({
        name: 'Cleaning dist folder',
        execute: () => {
            const distPath = path.join(__dirname, 'dist');
            if (fs.existsSync(distPath)) {
                fs.rmSync(distPath, { recursive: true, force: true });
                success('dist/ folder cleaned');
            } else {
                info('dist/ folder does not exist, skipping');
            }
            return { success: true };
        }
    });
}

// Step 3: Install dependencies
if (!config.skipDeps) {
    buildSteps.push({
        name: 'Installing dependencies',
        execute: () => {
            info('Running npm install...');
            const result = exec('npm install');
            if (!result.success) {
                error('npm install failed');
                return { success: false };
            }
            success('Dependencies installed');
            return { success: true };
        }
    });
}

// Step 4: Generate documentation
if (!config.skipDocs) {
    buildSteps.push({
        name: 'Generating documentation',
        execute: () => {
            info('Running JSDoc...');
            const result = exec('npm run docs');
            if (!result.success) {
                error('Documentation generation failed');
                return { success: false };
            }
            success('Documentation generated');
            return { success: true };
        }
    });
}

// Step 5: Build Node.js executable (MUST BE FIRST - embedded in Python exe)
buildSteps.push({
    name: 'Building Node.js executable',
    execute: () => {
        info('Building Node.js app with SEA (Single Executable Application)...');
        const result = exec('npm run build:node');
        if (!result.success) {
            error('Node.js build failed');
            return { success: false };
        }
        success('Server executable built:');
        success('  - ShippingManagerCoPilot-Server.exe (Node.js)');
        return { success: true };
    }
});

// Step 6: Build Python main executable (embeds Server.exe as resource)
buildSteps.push({
    name: 'Building Python main executable with embedded server',
    execute: () => {
        info('Compiling start.py with embedded Node.js server...');
        info('This may take several minutes...');
        const result = exec('npm run build:python');
        if (!result.success) {
            error('Python build failed');
            return { success: false };
        }
        success('Single-file executable built:');
        success('  - ShippingManagerCoPilot.exe (Python + embedded Node.js server)');
        return { success: true };
    }
});

// Step 7: Create package
buildSteps.push({
    name: 'Creating deployment package',
    execute: () => {
        info('Organizing files into deployment structure...');
        const result = exec('node build-package.js');
        if (!result.success) {
            error('Package creation failed');
            return { success: false };
        }
        success(`Package created: dist/ShippingManagerCoPilot-v${version}/`);
        return { success: true };
    }
});

// Main execution
async function main() {
    const startTime = Date.now();

    header(`ShippingManager CoPilot Build Script v${version}`);

    console.log('Build configuration:');
    console.log(`  Skip dependencies: ${config.skipDeps ? 'Yes' : 'No'}`);
    console.log(`  Skip documentation: ${config.skipDocs ? 'Yes' : 'No'}`);
    console.log(`  Skip installer: ${config.skipInstaller ? 'Yes' : 'No'}`);
    console.log(`  Clean build: ${config.clean ? 'Yes' : 'No'}`);
    console.log();

    const totalSteps = buildSteps.length;
    let currentStep = 0;

    for (const buildStep of buildSteps) {
        currentStep++;
        step(currentStep, totalSteps, buildStep.name);

        const result = buildStep.execute();

        if (!result.success) {
            console.log();
            error('Build failed!');
            process.exit(1);
        }

        if (result.skipped) {
            console.log();
            continue;
        }

        console.log();
    }

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);

    header('Build Complete!');

    console.log(colors.bright + colors.green + '✓ All build steps completed successfully' + colors.reset);
    console.log();
    console.log('Build artifacts:');
    console.log(`  📦 Package: ${colors.cyan}dist/ShippingManagerCoPilot-v${version}/${colors.reset}`);

    if (!config.skipDocs) {
        console.log(`  📖 Documentation: ${colors.cyan}public/docs/index.html${colors.reset}`);
    }

    console.log();
    console.log(`Build time: ${colors.yellow}${duration}s${colors.reset}`);
    console.log();
    console.log('Next steps:');
    console.log('  1. Test the executable:');
    console.log(`     ${colors.cyan}cd dist/ShippingManagerCoPilot-v${version}${colors.reset}`);
    console.log(`     ${colors.cyan}.\\ShippingManagerCoPilot.exe${colors.reset}`);
    console.log('  2. Create installer using MSIX Packaging Tool or Advanced Installer');
    console.log();
}

// Run
main().catch(err => {
    console.error();
    error('Unexpected error:');
    console.error(err);
    process.exit(1);
});
