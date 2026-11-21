// Central Control Plane authentication API configuration.
const { TENANT_SLUG, TENANT_API_KEY, MANAGEMENT_BASE_URL } = require('./app-config');

module.exports = {
  TENANT: TENANT_SLUG,
  TENANT_KEY: TENANT_API_KEY,
  DEFAULT_API_BASE_URL: MANAGEMENT_BASE_URL,
  API_TIMEOUT_MS: Number(process.env.MANAGEMENT_API_TIMEOUT_MS) || 15000,
  // Periodic device-authorization check interval (ms) — 60s
  DEVICE_CHECK_INTERVAL_MS: 60000
};
