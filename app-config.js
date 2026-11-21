require('./env');

/**
 * ============================================================================
 * CENTRAL APPLICATION & TENANT CONFIGURATION
 * ============================================================================
 * 
 * Required client configuration:
 * 1. MANAGEMENT_BASE_URL - the console origin
 * 2. TENANT_SLUG - the tenant slug configured in the console
 * 3. TENANT_API_KEY - the tenant secret key
 * A stable local deviceId fingerprint is generated automatically by device.js.
 */

// 1. Management Console Base URL (origin) - fallback default for client builds
const MANAGEMENT_BASE_URL = (
  process.env.MANAGEMENT_BASE_URL ||
  process.env.GARAGE_AUTH_API_URL ||
  'https://myclientmanager.vercel.app'
).trim();

// 2. Organization Slug (e.g. "the-puma-2-wheeler-service")
const TENANT_SLUG = (
  process.env.TENANT_SLUG ||
  process.env.GARAGE_TENANT ||
  'test-system'
).trim();

// 3. Secret API key from the Control Plane
const TENANT_API_KEY = (
  process.env.TENANT_API_KEY ||
  process.env.GARAGE_TENANT_KEY ||
  'ace93bc3c3639de6653aa9870b154896c258ca8d529b386a870cb43d700e2c27'
).trim();

// 4. Local Branding Fallbacks (used if not supplied by control plane)
const LOCAL_BRANDING = Object.freeze({
  APP_NAME: 'The Puma 2 Wheeler',
  WORKSHOP_PHONE: '+977 9749224460',
  WORKSHOP_ADDRESS: 'Mechinagar 1, Gadagali Bazar, Jhapa',
  WORKSHOP_TAGLINE: 'Ride Smooth Ride Safe'
});

let currentBranding = {
  APP_NAME: LOCAL_BRANDING.APP_NAME,
  WORKSHOP_PHONE: LOCAL_BRANDING.WORKSHOP_PHONE,
  WORKSHOP_ADDRESS: LOCAL_BRANDING.WORKSHOP_ADDRESS,
  WORKSHOP_TAGLINE: LOCAL_BRANDING.WORKSHOP_TAGLINE
};

function getNonEmptyString(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function getBranding() {
  return {
    appName: currentBranding.APP_NAME,
    phone: currentBranding.WORKSHOP_PHONE,
    address: currentBranding.WORKSHOP_ADDRESS,
    tagline: currentBranding.WORKSHOP_TAGLINE,
    APP_NAME: currentBranding.APP_NAME,
    WORKSHOP_PHONE: currentBranding.WORKSHOP_PHONE,
    WORKSHOP_ADDRESS: currentBranding.WORKSHOP_ADDRESS,
    WORKSHOP_TAGLINE: currentBranding.WORKSHOP_TAGLINE,
    workshopPhone: currentBranding.WORKSHOP_PHONE,
    workshopAddress: currentBranding.WORKSHOP_ADDRESS,
    workshopTagline: currentBranding.WORKSHOP_TAGLINE
  };
}

function resetBranding() {
  currentBranding = {
    APP_NAME: LOCAL_BRANDING.APP_NAME,
    WORKSHOP_PHONE: LOCAL_BRANDING.WORKSHOP_PHONE,
    WORKSHOP_ADDRESS: LOCAL_BRANDING.WORKSHOP_ADDRESS,
    WORKSHOP_TAGLINE: LOCAL_BRANDING.WORKSHOP_TAGLINE
  };
  return getBranding();
}

function applyControlPlaneResponse(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return getBranding();
  }

  const remote = payload.branding || payload.tenant?.branding || payload.user?.branding || payload.data?.branding || {};
  const tenant = (payload.tenant && typeof payload.tenant === 'object') ? payload.tenant : {};
  const user = (payload.user && typeof payload.user === 'object') ? payload.user : {};
  const data = (payload.data && typeof payload.data === 'object') ? payload.data : {};

  const apply = (candidates, key) => {
    for (const val of candidates) {
      if (val !== null && val !== undefined) {
        const trimmed = String(val).trim();
        if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') {
          currentBranding[key] = trimmed;
          return;
        }
      }
    }
  };

  // APP_NAME: exactly like names across all levels
  apply([
    payload.appName,
    payload.app_name,
    payload.tenantName,
    payload.tenant_name,
    payload.name,
    remote.appName,
    remote.name,
    tenant.appName,
    tenant.name,
    tenant.tenantName,
    user.appName,
    user.tenantName,
    data.appName,
    data.name
  ], "APP_NAME");

  // WORKSHOP_PHONE: exactly like names across all levels
  apply([
    remote.phone,
    remote.workshopPhone,
    remote.workshop_phone,
    remote.phoneNumber,
    remote.phone_number,
    remote.contact,
    remote.contactNumber,
    payload.phone,
    payload.workshopPhone,
    payload.workshop_phone,
    payload.phoneNumber,
    payload.phone_number,
    payload.contact,
    payload.contactNumber,
    tenant.phone,
    tenant.workshopPhone,
    tenant.workshop_phone,
    tenant.phoneNumber,
    tenant.contact,
    user.phone,
    user.workshopPhone,
    user.phoneNumber,
    data.phone,
    data.workshopPhone
  ], "WORKSHOP_PHONE");

  // WORKSHOP_ADDRESS: exactly like names across all levels
  apply([
    remote.address,
    remote.workshopAddress,
    remote.workshop_address,
    remote.location,
    payload.address,
    payload.workshopAddress,
    payload.workshop_address,
    payload.location,
    tenant.address,
    tenant.workshopAddress,
    tenant.workshop_address,
    tenant.location,
    user.address,
    user.workshopAddress,
    data.address,
    data.workshopAddress
  ], "WORKSHOP_ADDRESS");

  // WORKSHOP_TAGLINE: exactly like names across all levels
  apply([
    remote.tagline,
    remote.tagLine,
    remote.tag_line,
    remote.workshopTagline,
    remote.workshop_tagline,
    remote.slogan,
    payload.tagline,
    payload.tagLine,
    payload.tag_line,
    payload.workshopTagline,
    payload.workshop_tagline,
    payload.slogan,
    tenant.tagline,
    tenant.tagLine,
    tenant.tag_line,
    tenant.workshopTagline,
    tenant.workshop_tagline,
    tenant.slogan,
    user.tagline,
    user.tagLine,
    user.workshopTagline,
    data.tagline,
    data.tagLine,
    data.workshopTagline
  ], "WORKSHOP_TAGLINE");

  return getBranding();
}

const config = {
  MANAGEMENT_BASE_URL,
  TENANT_SLUG,
  TENANT_API_KEY,

  // Aliases for backward compatibility
  apiBase: MANAGEMENT_BASE_URL,
  tenant: TENANT_SLUG,
  tenantKey: TENANT_API_KEY,
  TENANT: TENANT_SLUG,
  TENANT_KEY: TENANT_API_KEY,
  AUTH_API_URL: MANAGEMENT_BASE_URL,

  LOCAL_BRANDING,

  // Dynamic branding properties via getters and setters
  get APP_NAME() { return currentBranding.APP_NAME; },
  set APP_NAME(val) { const s = getNonEmptyString(val); if (s) currentBranding.APP_NAME = s; },

  get WORKSHOP_PHONE() { return currentBranding.WORKSHOP_PHONE; },
  set WORKSHOP_PHONE(val) { const s = getNonEmptyString(val); if (s) currentBranding.WORKSHOP_PHONE = s; },

  get WORKSHOP_ADDRESS() { return currentBranding.WORKSHOP_ADDRESS; },
  set WORKSHOP_ADDRESS(val) { const s = getNonEmptyString(val); if (s) currentBranding.WORKSHOP_ADDRESS = s; },

  get WORKSHOP_TAGLINE() { return currentBranding.WORKSHOP_TAGLINE; },
  set WORKSHOP_TAGLINE(val) { const s = getNonEmptyString(val); if (s) currentBranding.WORKSHOP_TAGLINE = s; },

  // Flat aliases as getters
  get appName() { return currentBranding.APP_NAME; },
  get workshopPhone() { return currentBranding.WORKSHOP_PHONE; },
  get workshopAddress() { return currentBranding.WORKSHOP_ADDRESS; },
  get workshopTagline() { return currentBranding.WORKSHOP_TAGLINE; },

  applyControlPlaneResponse,
  resetBranding,
  getBranding
};

module.exports = config;
