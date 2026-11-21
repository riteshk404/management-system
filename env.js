const fs = require('fs');
const path = require('path');

/**
 * Lightweight, zero-dependency .env loader.
 * Checks multiple candidate locations:
 * 1. Project directory (development)
 * 2. Next to the running executable (production distribution)
 * 3. Electron resources directory (packaged app resources)
 * 4. Current working directory
 */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) continue;

      const cleanLine = line.startsWith('export ') ? line.slice(7).trim() : line;
      const eqIdx = cleanLine.indexOf('=');
      if (eqIdx === -1) continue;

      const key = cleanLine.slice(0, eqIdx).trim();
      let val = cleanLine.slice(eqIdx + 1).trim();

      // Handle quotes & trim
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      val = val.trim();

      // Do not overwrite if already provided by environment
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.warn(`[Env] Warning: Could not read .env from ${filePath}:`, err.message);
  }
}

function loadEnv() {
  const candidateDirs = [];

  // 1. Current source directory
  candidateDirs.push(__dirname);

  // 2. Next to the running executable (production install directory)
  if (process.execPath) {
    candidateDirs.push(path.dirname(process.execPath));
  }

  // 3. Electron resources directory
  if (process.resourcesPath) {
    candidateDirs.push(process.resourcesPath);
  }

  // 4. Current working directory
  candidateDirs.push(process.cwd());

  const checked = new Set();
  for (const dir of candidateDirs) {
    if (!dir) continue;
    const envPath = path.resolve(dir, '.env');
    if (!checked.has(envPath)) {
      checked.add(envPath);
      parseEnvFile(envPath);
    }
  }
}

// Auto-run on require
loadEnv();

module.exports = loadEnv;
