/**
 * @fileoverview CLI Parameter Handler for ShippingManager CoPilot Launcher
 *
 * Handles command-line arguments for headless operation and session management.
 *
 * Options:
 *   --headless                  Start without GUI (requires existing sessions)
 *   --add-session-interactive   Add session via terminal (secure cookie input)
 *   --list-sessions             List all saved sessions
 *   --remove-session=<userId>   Remove a session
 *   -h, --help                  Show help
 *
 * @module launcher/cli
 */

const readline = require('readline');
const sessionManager = require('../../../server/utils/session-manager');

/**
 * Parse command line arguments
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);

  // Parse --remove-session=<userId> or --remove-session <userId>
  let removeSessionId = null;
  const removeIndex = args.findIndex(a => a === '--remove-session' || a.startsWith('--remove-session='));
  if (removeIndex !== -1) {
    const arg = args[removeIndex];
    if (arg.includes('=')) {
      removeSessionId = arg.split('=')[1];
    } else if (args[removeIndex + 1] && !args[removeIndex + 1].startsWith('-')) {
      removeSessionId = args[removeIndex + 1];
    }
  }

  // Parse --enable-autostart=<userId> or --enable-autostart <userId>
  let enableAutostartId = null;
  const enableIndex = args.findIndex(a => a === '--enable-autostart' || a.startsWith('--enable-autostart='));
  if (enableIndex !== -1) {
    const arg = args[enableIndex];
    if (arg.includes('=')) {
      enableAutostartId = arg.split('=')[1];
    } else if (args[enableIndex + 1] && !args[enableIndex + 1].startsWith('-')) {
      enableAutostartId = args[enableIndex + 1];
    }
  }

  // Parse --disable-autostart=<userId> or --disable-autostart <userId>
  let disableAutostartId = null;
  const disableIndex = args.findIndex(a => a === '--disable-autostart' || a.startsWith('--disable-autostart='));
  if (disableIndex !== -1) {
    const arg = args[disableIndex];
    if (arg.includes('=')) {
      disableAutostartId = arg.split('=')[1];
    } else if (args[disableIndex + 1] && !args[disableIndex + 1].startsWith('-')) {
      disableAutostartId = args[disableIndex + 1];
    }
  }

  return {
    headless: args.includes('--headless'),
    addSession: args.includes('--add-session-interactive'),
    listSessions: args.includes('--list-sessions'),
    removeSession: removeSessionId,
    enableAutostart: enableAutostartId,
    disableAutostart: disableAutostartId,
    help: args.includes('--help') || args.includes('-h')
  };
}

/**
 * Display help message
 */
function showHelp() {
  console.log(`
ShippingManager CoPilot Launcher

Usage: ShippingManagerCoPilot [options]

Options:
  --headless                    Start without GUI (requires existing sessions)
  --add-session-interactive     Add session via terminal (secure cookie input)
  --list-sessions               List all saved sessions with autostart status
  --remove-session=<userId>     Remove a session by user ID
  --enable-autostart=<userId>   Enable autostart for a session
  --disable-autostart=<userId>  Disable autostart for a session
  -h, --help                    Show this help

Examples:
  ShippingManagerCoPilot                             # Normal GUI start
  ShippingManagerCoPilot --headless                  # Headless server mode
  ShippingManagerCoPilot --add-session-interactive   # Add account via terminal
  ShippingManagerCoPilot --list-sessions             # Show saved sessions
  ShippingManagerCoPilot --remove-session=123456     # Remove session for user 123456
  ShippingManagerCoPilot --enable-autostart=123456   # Enable autostart for user
  ShippingManagerCoPilot --disable-autostart=123456  # Disable autostart for user

Security Note:
  The --add-session-interactive option reads the cookie from stdin with hidden
  input. NEVER pass cookies as command line arguments - they would be visible
  in process lists and shell history.
`);
}

// Use centralized session validation from session-manager
const { validateSessionCookie } = sessionManager;

/**
 * Read cookie from stdin with hidden input
 * @returns {Promise<string>} The entered cookie
 */
function readHiddenInput() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    // Disable echo for hidden input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let cookie = '';

    console.log('Paste your shipping_manager_session cookie (input hidden):');

    process.stdin.on('data', (char) => {
      const charStr = char.toString();

      // Handle Enter key
      if (charStr === '\n' || charStr === '\r' || charStr === '\r\n') {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdout.write('\n');
        rl.close();
        resolve(cookie);
        return;
      }

      // Handle backspace
      if (charStr === '\x7f' || charStr === '\b') {
        if (cookie.length > 0) {
          cookie = cookie.slice(0, -1);
        }
        return;
      }

      // Handle Ctrl+C
      if (charStr === '\x03') {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        console.log('\nCancelled.');
        process.exit(0);
      }

      // Add character to cookie (no echo)
      cookie += charStr;
    });
  });
}

/**
 * Add a session interactively via terminal
 * @returns {Promise<void>}
 */
async function addSessionInteractive() {
  console.log('\n=== Add Session ===\n');
  console.log('To get your session cookie:');
  console.log('1. Open your browser and go to shippingmanager.cc');
  console.log('2. Log in to your account');
  console.log('3. Open Developer Tools (F12)');
  console.log('4. Go to Application/Storage > Cookies > shippingmanager.cc');
  console.log('5. Copy the value of "shipping_manager_session"\n');

  const cookie = await readHiddenInput();

  if (!cookie || cookie.trim().length === 0) {
    console.error('Error: No cookie provided');
    process.exit(1);
  }

  console.log('Validating cookie...');

  const userData = await validateSessionCookie(cookie.trim());

  if (!userData) {
    console.error('Error: Invalid cookie - could not authenticate with shippingmanager.cc');
    process.exit(1);
  }

  console.log(`Cookie valid! User: ${userData.companyName} (ID: ${userData.userId})`);

  // Save session
  await sessionManager.saveSession(
    userData.userId,
    cookie.trim(),
    userData.companyName,
    'manual'
  );

  console.log(`Session saved for ${userData.companyName}`);
  console.log('\nYou can now start the launcher to use this session.');
}

/**
 * List all saved sessions
 * @returns {Promise<void>}
 */
async function listSessions() {
  const sessions = await sessionManager.getAvailableSessions();

  if (sessions.length === 0) {
    console.log('No sessions found.');
    console.log('\nUse --add-session-interactive to add a session.');
    return;
  }

  console.log('\n=== Saved Sessions ===\n');

  for (const session of sessions) {
    const date = session.timestamp ? new Date(session.timestamp * 1000).toLocaleString() : 'Unknown';
    const method = session.loginMethod || 'unknown';
    const autostartStatus = session.autostart ? 'Yes' : 'No';

    console.log(`  User ID: ${session.userId}`);
    console.log(`  Company: ${session.companyName}`);
    console.log(`  Login Method: ${method}`);
    console.log(`  Autostart: ${autostartStatus}`);
    console.log(`  Last Updated: ${date}`);
    console.log('');
  }

  const autostartCount = sessions.filter(s => s.autostart).length;
  console.log(`Total: ${sessions.length} session(s), ${autostartCount} with autostart enabled`);
}

/**
 * Enable or disable autostart for a session
 * @param {string} userId - User ID
 * @param {boolean} enable - True to enable, false to disable
 * @returns {Promise<void>}
 */
async function setAutostartCli(userId, enable) {
  if (!userId) {
    console.error('Error: No user ID provided');
    console.error('Usage: --enable-autostart=<userId> or --disable-autostart=<userId>');
    process.exit(1);
  }

  // Get session info first
  const sessions = await sessionManager.getAvailableSessions();
  const session = sessions.find(s => String(s.userId) === String(userId));

  if (!session) {
    console.error(`Error: No session found for user ${userId}`);
    process.exit(1);
  }

  const success = await sessionManager.setAutostart(userId, enable);

  if (success) {
    const status = enable ? 'enabled' : 'disabled';
    console.log(`Autostart ${status} for ${session.companyName} (${userId})`);
  } else {
    console.error('Error: Failed to update autostart setting');
    process.exit(1);
  }
}

/**
 * Ask yes/no question
 * @param {string} question - Question to ask
 * @returns {Promise<boolean>} True if yes
 */
function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(`${question} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Get all userdata directories that contain user-specific data
 * @returns {string[]} Array of directory names
 */
function getUserDataDirs() {
  return [
    'analytics',
    'api-stats',
    'broadcast-templates',
    'cache',
    'chatbot',
    'contributions',
    'departure-data',
    'harbor-fees',
    'hijack_history',
    'messenger',
    'settings',
    'transactions',
    'trip-data',
    'vessel-appearances',
    'vessel-history',
    'vessel-images'
  ];
}

/**
 * Delete all user data for a specific user ID
 * @param {string} userId - User ID
 * @returns {Promise<{deleted: number, errors: number}>} Stats
 */
async function deleteUserData(userId) {
  const fs = require('fs').promises;
  const path = require('path');
  const { getAppBaseDir, isPackaged } = require('./config');

  const baseDir = isPackaged()
    ? path.join(getAppBaseDir(), 'userdata')
    : path.join(__dirname, '..', 'userdata');

  const dirs = getUserDataDirs();
  let deleted = 0;
  let errors = 0;

  for (const dir of dirs) {
    const dirPath = path.join(baseDir, dir);

    try {
      const files = await fs.readdir(dirPath).catch(() => []);

      for (const file of files) {
        // Check if file belongs to this user (starts with userId or contains -userId)
        if (file.startsWith(`${userId}-`) || file.startsWith(`${userId}.`) || file === `${userId}`) {
          const filePath = path.join(dirPath, file);
          const stat = await fs.stat(filePath);

          if (stat.isDirectory()) {
            await fs.rm(filePath, { recursive: true });
          } else {
            await fs.unlink(filePath);
          }

          console.log(`  Deleted: ${dir}/${file}`);
          deleted++;
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`  Error in ${dir}: ${err.message}`);
        errors++;
      }
    }
  }

  return { deleted, errors };
}

/**
 * Remove a session by user ID
 * @param {string} userId - User ID to remove
 * @returns {Promise<void>}
 */
async function removeSession(userId) {
  if (!userId) {
    console.error('Error: No user ID provided');
    console.error('Usage: --remove-session=<userId>');
    process.exit(1);
  }

  // Get session info first
  const sessions = await sessionManager.getAvailableSessions();
  const session = sessions.find(s => String(s.userId) === String(userId));

  if (!session) {
    console.error(`Error: No session found for user ${userId}`);
    process.exit(1);
  }

  console.log(`\nRemoving session for: ${session.companyName} (${userId})\n`);

  // Ask about deleting user data
  const deleteData = await askYesNo('Do you also want to delete all user data (settings, analytics, history, etc.)?');

  if (deleteData) {
    console.log('\nDeleting user data...');
    const stats = await deleteUserData(userId);

    if (stats.deleted > 0) {
      console.log(`\nDeleted ${stats.deleted} file(s)/folder(s)`);
    } else {
      console.log('\nNo user data found to delete');
    }

    if (stats.errors > 0) {
      console.log(`${stats.errors} error(s) occurred`);
    }
  }

  // Delete session
  const deleted = await sessionManager.deleteSession(userId);

  if (deleted) {
    console.log(`\nSession removed successfully.`);
  } else {
    console.error(`\nError: Failed to remove session`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  showHelp,
  addSessionInteractive,
  listSessions,
  removeSession,
  setAutostartCli,
  deleteUserData,
  validateSessionCookie
};
