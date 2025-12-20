#!/usr/bin/env node
/**
 * @fileoverview Complete Build Script
 *
 * Automated build process for ShippingManager CoPilot.
 * Builds Node.js SEA executable and C# installer.
 *
 * Usage: node build/build.js [options]
 * Options:
 *   --skip-deps     Skip dependency installation
 *   --skip-installer Skip installer creation
 *   --clean         Clean dist folder before build
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
    skipDeps: process.argv.includes('--skip-deps'),
    skipInstaller: process.argv.includes('--skip-installer'),
    clean: process.argv.includes('--clean'),
};

const ROOT_DIR = path.join(__dirname, '..');
const packageJson = require(path.join(ROOT_DIR, 'package.json'));
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
    console.log(colors.green + '  OK ' + text + colors.reset);
}

function error(text) {
    console.log(colors.red + '  ERROR ' + text + colors.reset);
}

function info(text) {
    console.log(colors.cyan + '  ' + text + colors.reset);
}

// Execute command with output
function exec(command, options = {}) {
    try {
        const output = execSync(command, {
            encoding: 'utf8',
            stdio: options.silent ? 'pipe' : 'inherit',
            cwd: ROOT_DIR,
            ...options
        });
        return { success: true, output };
    } catch (err) {
        return { success: false, error: err };
    }
}

// Build steps
const buildSteps = [];

// Step: Check dependencies
buildSteps.push({
    name: 'Checking dependencies',
    execute: () => {
        const checks = [];

        // Node.js version
        const nodeVersion = process.version;
        checks.push({ name: 'Node.js', version: nodeVersion, ok: true });

        // .NET SDK (for installer)
        try {
            const dotnetVersion = execSync('dotnet --version', { encoding: 'utf8', stdio: 'pipe' }).trim();
            checks.push({ name: '.NET SDK', version: dotnetVersion, ok: true });
        } catch {
            checks.push({ name: '.NET SDK', version: 'Not found', ok: false, optional: config.skipInstaller });
        }

        // Print results
        checks.forEach(check => {
            const status = check.ok ? 'OK' : (check.optional ? 'SKIP' : 'MISSING');
            const color = check.ok ? colors.green : (check.optional ? colors.yellow : colors.red);
            console.log(`  ${color}${status} ${check.name}: ${check.version}${colors.reset}`);
        });

        // Check for critical failures
        const criticalFailures = checks.filter(c => !c.ok && !c.optional);
        if (criticalFailures.length > 0) {
            console.log();
            error('Missing required dependencies');
            process.exit(1);
        }

        return { success: true };
    }
});

// Step: Clean dist folder (optional)
if (config.clean) {
    buildSteps.push({
        name: 'Cleaning dist folder',
        execute: () => {
            const distPath = path.join(ROOT_DIR, 'dist');
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

// Step: Install dependencies
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

// Step: Build Node.js SEA executable
buildSteps.push({
    name: 'Building Node.js SEA executable',
    execute: () => {
        info('Building with Single Executable Application (SEA)...');
        const result = exec('node build/build-sea.js');
        if (!result.success) {
            error('SEA build failed');
            return { success: false };
        }
        success('ShippingManagerCoPilot-Server.exe built');
        return { success: true };
    }
});

// Step: Create deployment package
buildSteps.push({
    name: 'Creating deployment package',
    execute: () => {
        info('Organizing files into deployment structure...');
        const result = exec('node build/build-package.js');
        if (!result.success) {
            error('Package creation failed');
            return { success: false };
        }
        success(`Package created: dist/ShippingManagerCoPilot-v${version}/`);
        return { success: true };
    }
});

// Step: Build installer (optional)
if (!config.skipInstaller) {
    buildSteps.push({
        name: 'Building installer',
        execute: () => {
            info('Building C# self-extracting installer...');
            const result = exec('node build/build-installer.js');
            if (!result.success) {
                error('Installer build failed');
                return { success: false };
            }
            success(`Installer created: dist/ShippingManagerCoPilot-Installer-v${version}.exe`);
            return { success: true };
        }
    });
}

// Main execution
async function main() {
    const startTime = Date.now();

    header(`ShippingManager CoPilot Build Script v${version}`);

    console.log('Build configuration:');
    console.log(`  Skip dependencies: ${config.skipDeps ? 'Yes' : 'No'}`);
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

        console.log();
    }

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);

    header('Build Complete!');

    console.log(colors.bright + colors.green + 'All build steps completed successfully' + colors.reset);
    console.log();
    console.log('Build artifacts:');
    console.log(`  Server: ${colors.cyan}dist/ShippingManagerCoPilot-Server.exe${colors.reset}`);
    console.log(`  Package: ${colors.cyan}dist/ShippingManagerCoPilot-v${version}/${colors.reset}`);
    if (!config.skipInstaller) {
        console.log(`  Installer: ${colors.cyan}dist/ShippingManagerCoPilot-Installer-v${version}.exe${colors.reset}`);
    }
    console.log();
    console.log(`Build time: ${colors.yellow}${duration}s${colors.reset}`);
    console.log();
}

// Run
main().catch(err => {
    console.error();
    error('Unexpected error:');
    console.error(err);
    process.exit(1);
});
