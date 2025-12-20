/**
 * @fileoverview JSON File Repair Utility
 *
 * Automatically repairs corrupted JSON files before migration.
 * Handles common corruption patterns:
 * - Truncated files (incomplete writes)
 * - Garbage appended after valid JSON
 * - Bad control characters
 * - Incomplete array/object closures
 *
 * @module server/database/json-repair
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Remove bad control characters from JSON string
 * @param {string} str - JSON string
 * @returns {string} Cleaned string
 */
function removeBadControlChars(str) {
  // Remove control characters except \n (10), \r (13), \t (9)
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Keep printable chars and \n, \r, \t
    if (code >= 32 || code === 9 || code === 10 || code === 13) {
      result += str[i];
    }
  }
  return result;
}

/**
 * Try to find the last valid JSON position in a string
 * @param {string} data - JSON string
 * @param {number} startFrom - Start searching from this position
 * @returns {number} Last valid position or -1
 */
function findLastValidJsonEnd(data, startFrom) {
  // Try common closing patterns
  const patterns = [
    '\n}',      // End of object
    '\n  }',    // End of nested object
    '\n    }',  // End of deeply nested object
    '}',        // Simple object end
    ']',        // Array end
    ']\n}',     // Array then object end
    ']\r\n}'    // Windows line endings
  ];

  for (const pattern of patterns) {
    let pos = startFrom;
    while (pos > 0) {
      pos = data.lastIndexOf(pattern, pos - 1);
      if (pos === -1) break;

      const testStr = data.substring(0, pos + pattern.length);
      try {
        JSON.parse(testStr);
        return pos + pattern.length;
      } catch {
        // Try adding closing brackets
        for (const closer of ['', '}', ']}', '\n}', '\n  ]\n}', '\n    }\n  ]\n}']) {
          try {
            JSON.parse(testStr + closer);
            return pos + pattern.length; // Return position, closer will be added later
          } catch {}
        }
      }
    }
  }

  return -1;
}

/**
 * Attempt to repair a JSON string
 * @param {string} data - Corrupted JSON data
 * @param {string} fileName - File name for logging
 * @returns {{success: boolean, data: string, method: string}} Repair result
 */
function repairJsonString(data, fileName) {
  // Method 1: Try parsing as-is (maybe it's fine)
  try {
    JSON.parse(data);
    return { success: true, data, method: 'valid' };
  } catch (parseError) {
    logger.debug(`[JSONRepair] ${fileName}: ${parseError.message}`);
  }

  // Method 2: Remove bad control characters
  let cleaned = removeBadControlChars(data);
  try {
    JSON.parse(cleaned);
    logger.info(`[JSONRepair] ${fileName}: Fixed by removing control characters`);
    return { success: true, data: cleaned, method: 'control_chars' };
  } catch {}

  // Method 3: Find error position and truncate
  const posMatch = data.length.toString().match(/position (\d+)/);
  let errorPos = posMatch ? parseInt(posMatch[1], 10) : data.length;

  // Method 4: Find last valid JSON ending before error
  const lastValid = findLastValidJsonEnd(cleaned, Math.min(errorPos + 100, cleaned.length));

  if (lastValid > 0) {
    let truncated = cleaned.substring(0, lastValid);

    // Try to close incomplete structures
    const closers = ['', '}', ']}', '\n}', '\n  ]\n}', '\n    }\n  ]\n}'];

    for (const closer of closers) {
      try {
        const testData = truncated + closer;
        JSON.parse(testData);
        logger.info(`[JSONRepair] ${fileName}: Fixed by truncating at ${lastValid} and adding '${closer.replace(/\n/g, '\\n')}'`);
        return { success: true, data: testData, method: 'truncate' };
      } catch {}
    }
  }

  // Method 5: Try to salvage by finding structure boundaries
  // Look for the main object structure and close it properly
  const structures = [
    { start: '"departures":', arrayClose: '\n  ]\n}' },
    { start: '"entries":', arrayClose: '\n  ]\n}' },
    { start: '"transactions":', arrayClose: '\n  ]\n}' },
    { start: '"vessels":', objClose: '\n  }\n}' }
  ];

  for (const struct of structures) {
    const structStart = cleaned.indexOf(struct.start);
    if (structStart === -1) continue;

    // Find the array/object start after the key
    const bracketPos = cleaned.indexOf(struct.arrayClose ? '[' : '{', structStart);
    if (bracketPos === -1) continue;

    // Find last complete entry (ends with },)
    const lastEntry = cleaned.lastIndexOf('},', errorPos);
    if (lastEntry > bracketPos) {
      // Close the structure
      const closer = struct.arrayClose || struct.objClose;
      const truncated = cleaned.substring(0, lastEntry + 1) + closer;

      try {
        JSON.parse(truncated);
        logger.info(`[JSONRepair] ${fileName}: Fixed by closing ${struct.start} structure`);
        return { success: true, data: truncated, method: 'structure_close' };
      } catch {}
    }
  }

  // Method 6: Last resort - try to extract just the valid beginning
  for (let i = Math.min(errorPos, cleaned.length); i > 100; i -= 100) {
    const chunk = cleaned.substring(0, i);

    // Try common closers
    for (const closer of ['}', ']}', '\n  ]\n}', '\n    }\n  ]\n}', '\n}\n}']) {
      try {
        const testData = chunk + closer;
        JSON.parse(testData);
        logger.info(`[JSONRepair] ${fileName}: Fixed with aggressive truncation at ${i}`);
        return { success: true, data: testData, method: 'aggressive_truncate' };
      } catch {}
    }
  }

  logger.error(`[JSONRepair] ${fileName}: Could not repair`);
  return { success: false, data, method: 'failed' };
}

/**
 * Repair a JSON file in place
 * @param {string} filePath - Path to JSON file
 * @returns {{success: boolean, method: string, backup: string|null}} Result
 */
function repairJsonFile(filePath) {
  const fileName = path.basename(filePath);

  if (!fs.existsSync(filePath)) {
    return { success: false, method: 'not_found', backup: null };
  }

  try {
    const data = fs.readFileSync(filePath, 'utf8');

    // Quick validation first
    try {
      JSON.parse(data);
      return { success: true, method: 'already_valid', backup: null };
    } catch {}

    // Attempt repair
    const result = repairJsonString(data, fileName);

    if (result.success && result.method !== 'valid') {
      // Create backup
      const backupPath = filePath + '.corrupted';
      fs.writeFileSync(backupPath, data);

      // Write repaired data
      fs.writeFileSync(filePath, result.data);

      logger.info(`[JSONRepair] Repaired ${fileName} (backup: ${path.basename(backupPath)})`);
      return { success: true, method: result.method, backup: backupPath };
    }

    return { success: result.success, method: result.method, backup: null };
  } catch (err) {
    logger.error(`[JSONRepair] Error processing ${fileName}:`, err.message);
    return { success: false, method: 'error', backup: null };
  }
}

/**
 * Scan and repair all JSON files for a user
 * @param {string} userId - User ID
 * @param {string} userdataDir - Userdata directory path
 * @returns {Object} Repair summary
 */
function repairAllUserFiles(userId, userdataDir) {
  const results = {
    userId,
    files: [],
    repaired: 0,
    failed: 0,
    valid: 0
  };

  // Files to check
  const filesToCheck = [
    path.join(userdataDir, 'vessel-history', `${userId}-vessel-history.json`),
    path.join(userdataDir, 'transactions', `${userId}-transactions.json`),
    path.join(userdataDir, 'analytics', `${userId}-lookup.json`),
  ];

  // Also check logs directory for autopilot logs
  const logsDir = path.join(userdataDir, '..', 'logs', 'autopilot');
  const logFile = path.join(logsDir, `${userId}-autopilot-log.json`);
  if (fs.existsSync(logFile)) {
    filesToCheck.push(logFile);
  }

  for (const filePath of filesToCheck) {
    if (!fs.existsSync(filePath)) continue;

    const result = repairJsonFile(filePath);
    results.files.push({
      file: path.basename(filePath),
      ...result
    });

    if (result.method === 'already_valid') {
      results.valid++;
    } else if (result.success) {
      results.repaired++;
    } else {
      results.failed++;
    }
  }

  return results;
}

module.exports = {
  repairJsonFile,
  repairJsonString,
  repairAllUserFiles,
  removeBadControlChars
};
