const os = require('os');
const crypto = require('crypto');

// Generate a stable, unique device identifier (fingerprint) for this computer.
function getDeviceId() {
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus().length,
    os.totalmem(),
    os.homedir()
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getDeviceName() {
  return os.hostname() || 'Desktop';
}

module.exports = { getDeviceId, getDeviceName };