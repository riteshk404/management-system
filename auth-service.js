const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const authApi = require('./auth-api');
const { getDeviceId, getDeviceName } = require('./device');
const appConfig = require('./app-config');
const { TENANT_SLUG, TENANT_API_KEY, MANAGEMENT_BASE_URL } = appConfig;

let userDataDir = null;
let currentSession = null;
let onUnauthorizedCallback = null;
let onBrandingChangedCallback = null;
let lastHeartbeatTime = 0;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function safeLogPayload(label, payload) {
  if (!payload) {
    console.log(`[AuthService] ${label}: undefined`);
    return;
  }
  try {
    const sanitized = JSON.parse(JSON.stringify(payload, (key, value) => {
      if (/token|password|secret|key/i.test(key)) return '***';
      return value;
    }));
    console.log(`[AuthService] ${label}:`, JSON.stringify(sanitized));
  } catch (_) {
    console.log(`[AuthService] ${label}: (could not serialize)`);
  }
}

function setOnBrandingChanged(cb) {
  onBrandingChangedCallback = cb;
}

function notifyBrandingChanged(branding) {
  if (typeof onBrandingChangedCallback === 'function') {
    try { onBrandingChangedCallback(branding); } catch (_) {}
  }
}

function storagePath(dir) { return path.join(dir, 'control_plane_session.enc'); }
function tmpPath(dir) { return path.join(dir, 'control_plane_session.enc.tmp'); }
function configPath(dir) { return path.join(dir, 'control_plane_config.json'); }

function saveSession(dir, sess) {
  if (!dir) return;
  const json = JSON.stringify(sess);
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(tmpPath(dir), encrypted, { mode: 0o600 });
      try {
        fs.renameSync(tmpPath(dir), storagePath(dir));
      } catch (e) {
        fs.writeFileSync(storagePath(dir), encrypted, { mode: 0o600 });
        try { fs.unlinkSync(tmpPath(dir)); } catch (_) {}
      }
      return;
    }
  } catch (_) {}

  // Fallback: AES-256-GCM tied to physical machine fingerprint
  try {
    const crypto = require('crypto');
    const key = crypto.createHash('sha256').update(getDeviceId() + ':control_plane_vault').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(storagePath(dir), Buffer.concat([iv, tag, enc]).toString('base64'), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[AuthService] Error saving encrypted session:', err.message);
  }
}

function loadSession(dir) {
  if (!dir || !fs.existsSync(storagePath(dir))) return null;
  try {
    const raw = fs.readFileSync(storagePath(dir));
    let json = null;

    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      try { json = safeStorage.decryptString(raw); } catch (_) { json = null; }
    }

    if (!json) {
      try {
        const buf = Buffer.from(raw.toString('utf8'), 'base64');
        const iv = buf.slice(0, 12);
        const tag = buf.slice(12, 28);
        const enc = buf.slice(28);
        const crypto = require('crypto');
        const key = crypto.createHash('sha256').update(getDeviceId() + ':control_plane_vault').digest();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        json = decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
      } catch (_) { return null; }
    }

    if (!json) return null;
    const parsed = JSON.parse(json);

    // Verify session belongs to this physical machine
    if (!parsed || parsed.deviceId !== getDeviceId()) {
      clearSession(dir);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[AuthService] Failed to load session:', err.message);
    clearSession(dir);
    return null;
  }
}

function clearSession(dir) {
  if (dir) {
    try { fs.unlinkSync(storagePath(dir)); } catch (_) {}
    try { fs.unlinkSync(tmpPath(dir)); } catch (_) {}
  }
  currentSession = null;
  appConfig.resetBranding();
  notifyBrandingChanged(appConfig.getBranding());
}

function saveServerConfig(dir, cfg) {
  if (!dir) return;
  try {
    fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (_) {}
}

function loadServerConfig(dir) {
  if (!dir || !fs.existsSync(configPath(dir))) {
    return { serverUrl: MANAGEMENT_BASE_URL, tenant: TENANT_SLUG };
  }
  try {
    return JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
  } catch (_) {
    return { serverUrl: MANAGEMENT_BASE_URL, tenant: TENANT_SLUG };
  }
}

function sanitizeUser(sess) {
  if (!sess || !sess.user) return null;
  const appName = sess.appName || (sess.user && sess.user.appName) || sess.tenantName || (sess.user && sess.user.tenantName) || appConfig.APP_NAME || '';
  const branding = sess.branding || appConfig.getBranding();
  return {
    id: sess.user.id || sess.user._id || sess.user.email,
    name: sess.user.name || (sess.user.email ? String(sess.user.email).split('@')[0] : 'User'),
    email: sess.user.email,
    role: sess.user.role || 'User',
    tenant: sess.tenant || sess.user.tenant || '',
    tenantName: sess.tenantName || (sess.user && sess.user.tenantName) || '',
    appName,
    branding,
    avatar: sess.user.avatar || sess.avatar || null,
    // Fail closed if features is missing
    features: sess.features || { backups: false },
    systemType: sess.systemType || sess.user.systemType || null,
    serverUrl: sess.serverUrl || '',
    loggedInAt: sess.loggedInAt || new Date().toISOString()
  };
}

async function init(dir, onUnauthorized) {
  userDataDir = dir;
  onUnauthorizedCallback = onUnauthorized || null;
  currentSession = loadSession(dir);
  if (currentSession) {
    if (currentSession.branding || currentSession.appName) {
      appConfig.applyControlPlaneResponse(currentSession);
    }
  } else {
    appConfig.resetBranding();
  }
  return currentSession ? sanitizeUser(currentSession) : null;
}

async function getServerConfig() {
  return loadServerConfig(userDataDir);
}

/**
 * Sign in against the Control Plane.
 * Conforms to per-tenant authentication contract.
 */
async function login(credentials) {
  const dir = userDataDir;
  const deviceId = getDeviceId();
  const deviceName = getDeviceName();

  const email = (credentials && (credentials.email || credentials.username) || '').trim();
  const password = credentials && credentials.password;

  // Tenant: from credentials first, then fall back to app-config defaults
  const tenant = ((credentials && credentials.tenant) || TENANT_SLUG || '').trim();
  const tenantKey = ((credentials && credentials.tenantKey) || TENANT_API_KEY || '').trim();
  const serverUrl = ((credentials && credentials.serverUrl) || MANAGEMENT_BASE_URL || '').trim();

  if (!email || !password) {
    return { success: false, message: 'Please enter your email and password.' };
  }

  if (!serverUrl) {
    return {
      success: false,
      message: 'Management Base URL is not configured. Please set MANAGEMENT_BASE_URL.'
    };
  }

  // Always resolve the tenant with tenant + tenantKey. Without both, tenant users cannot authenticate.
  if (!tenant || !tenantKey) {
    return {
      success: false,
      message: 'Tenant slug and tenant API key are required to authenticate.'
    };
  }

  let res = null;
  try {
    res = await authApi.login({
      email,
      password,
      deviceId,
      deviceName,
      tenant,
      tenantKey,
      baseUrl: serverUrl
    });
  } catch (err) {
    if (err.status === 429) {
      return {
        success: false,
        status: 429,
        message: err.message || 'Too many requests. Please wait and try again later.'
      };
    }
    if (err.status === 503) {
      return {
        success: false,
        status: 503,
        message: 'Service temporarily unavailable'
      };
    }
    return {
      success: false,
      status: err.status || 500,
      message: err.message || 'Cannot reach Management Console. Please check your internet connection.'
    };
  }

  // Invalid credentials return HTTP 200 with { success: false, message: "..." }. Always check success flag.
  if (!res || res.success !== true) {
    return {
      success: false,
      message: (res && (res.message || res.error)) || 'Invalid credentials.'
    };
  }

  // The session token is user.token, NOT a top-level token. Treat as opaque string.
  const userObj = res.user;
  const token = userObj && typeof userObj.token === 'string' ? userObj.token : null;
  if (!token) {
    return {
      success: false,
      message: 'Invalid response from server: session token missing.'
    };
  }

  // Device Activation
  try {
    await authApi.registerDevice({ token, deviceId, deviceName, baseUrl: serverUrl });
  } catch (err) {
    if (err.status === 403) {
      clearSession(dir);
      return {
        success: false,
        status: 403,
        message: err.message || 'Device does not match session. Please log in again on this device.'
      };
    }
    if (err.status === 401) {
      clearSession(dir);
      return {
        success: false,
        status: 401,
        message: 'Session invalid. Please log in again.'
      };
    }
    if (err.status === 503) {
      clearSession(dir);
      return {
        success: false,
        status: 503,
        message: 'Service temporarily unavailable'
      };
    }
  }

  // Feature flags: default to disabled/closed if missing
  const features = (res.features && typeof res.features === 'object') ? res.features : { backups: false };
  appConfig.applyControlPlaneResponse(res);
  notifyBrandingChanged(appConfig.getBranding());
  const appName = appConfig.APP_NAME || res.appName || (userObj && userObj.appName) || 'Management System';

  currentSession = {
    token, // stored exclusively in secure OS storage
    user: {
      id: userObj.id || userObj._id || email,
      name: userObj.name || (email ? email.split('@')[0] : 'User'),
      email: userObj.email || email,
      role: userObj.role || 'User',
      tenant,
      appName
    },
    tenant,
    appName,
    branding: appConfig.getBranding(),
    serverUrl,
    deviceId,
    deviceName,
    features,
    license: res.license || null,
    loggedInAt: new Date().toISOString()
  };

  saveSession(dir, currentSession);
  saveServerConfig(dir, { serverUrl, tenant });

  const cleanUser = sanitizeUser(currentSession);
  return {
    success: true,
    user: cleanUser,
    features: cleanUser.features,
    appName: cleanUser.appName,
    branding: appConfig.getBranding()
  };
}

/**
 * 60-Second Device Authorization Check
 * GET /api/auth/device-status?deviceId=...
 */
async function checkDevice() {
  const dir = userDataDir;
  if (!currentSession) {
    currentSession = loadSession(dir);
  }
  if (!currentSession || !currentSession.token) {
    return { authorized: false, requiresLogout: true };
  }

  const { token, deviceId, serverUrl } = currentSession;
  const baseUrl = serverUrl || MANAGEMENT_BASE_URL;

  try {
    const status = await authApi.getDeviceStatus({ token, deviceId, baseUrl });

    // Validate authorization
    const isAuthorized = !!(
      status &&
      status.authorized !== false &&
      status.deviceAuthorized !== false &&
      status.active !== false
    );

    if (!isAuthorized) {
      console.warn('[AuthService] Device authorization revoked or inactive.');
      clearSession(dir);
      const msg = (status && (status.message || status.error)) || 'Device authorization revoked.';
      if (typeof onUnauthorizedCallback === 'function') onUnauthorizedCallback(msg);
      return { authorized: false, requiresLogout: true, message: msg };
    }

    let hasChanges = false;

    // Apply control plane branding updates
    appConfig.applyControlPlaneResponse(status);
    notifyBrandingChanged(appConfig.getBranding());

    // Feature flags: update or fail closed
    const incomingFeatures = (status && status.features && typeof status.features === 'object')
      ? status.features
      : { backups: false };
    if (JSON.stringify(currentSession.features) !== JSON.stringify(incomingFeatures)) {
      currentSession.features = incomingFeatures;
      hasChanges = true;
    }

    // License
    if (status && status.license && JSON.stringify(currentSession.license) !== JSON.stringify(status.license)) {
      currentSession.license = status.license;
      hasChanges = true;
    }

    // App name & branding
    if (currentSession.appName !== appConfig.APP_NAME) {
      currentSession.appName = appConfig.APP_NAME;
      if (currentSession.user) currentSession.user.appName = appConfig.APP_NAME;
      hasChanges = true;
    }
    const latestBranding = appConfig.getBranding();
    if (JSON.stringify(currentSession.branding) !== JSON.stringify(latestBranding)) {
      currentSession.branding = latestBranding;
      hasChanges = true;
    }

    // User updates
    if (status && status.user) {
      const u = status.user;
      const cur = currentSession.user || {};
      if (u.name !== cur.name || u.email !== cur.email || u.role !== cur.role) {
        currentSession.user = {
          ...cur,
          name: u.name || cur.name,
          email: u.email || cur.email,
          role: u.role || cur.role
        };
        hasChanges = true;
      }
    }

    if (hasChanges) {
      saveSession(dir, currentSession);
    }

    // Heartbeat: throttled to at most once every ~5 minutes
    const now = Date.now();
    if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatTime = now;
      try {
        await authApi.heartbeat({ token, deviceId, baseUrl });
      } catch (_) {}
    }

    return {
      authorized: true,
      features: currentSession.features,
      appName: currentSession.appName,
      branding: appConfig.getBranding(),
      user: sanitizeUser(currentSession)
    };
  } catch (err) {
    // HTTP 401 = invalid/expired session -> local logout
    if (err.status === 401) {
      console.warn('[AuthService] 401 Unauthorized: session expired.');
      clearSession(dir);
      if (typeof onUnauthorizedCallback === 'function') onUnauthorizedCallback('Session expired. Please log in again.');
      return { authorized: false, sessionExpired: true, requiresLogout: true, message: 'Session expired. Please log in again.' };
    }

    // HTTP 403 = unauthorized/suspended/another device active -> local logout
    if (err.status === 403) {
      console.warn('[AuthService] 403 Forbidden: device revoked or unauthorized.');
      clearSession(dir);
      const msg = err.message || (err.data && err.data.message) || 'Device unauthorized or suspended.';
      if (typeof onUnauthorizedCallback === 'function') onUnauthorizedCallback(msg);
      return { authorized: false, requiresLogout: true, message: msg };
    }

    // HTTP 503 = tenant DB unavailable -> fail closed, do NOT bypass local lock
    if (err.status === 503) {
      console.warn('[AuthService] 503 Service Unavailable: tenant DB unavailable.');
      return {
        authorized: false,
        serviceUnavailable: true,
        offline: true,
        message: 'Service temporarily unavailable'
      };
    }

    // Other network failures: fail closed
    return {
      authorized: false,
      networkError: true,
      offline: true,
      message: err.message || 'Network connection unavailable'
    };
  }
}

/**
 * Desktop Heartbeat
 * POST /api/auth/heartbeat
 * Send on meaningful activity, app resume, or at most every ~5 minutes.
 */
async function sendHeartbeat(force = false) {
  if (!currentSession || !currentSession.token) return;
  const now = Date.now();
  if (!force && (now - lastHeartbeatTime < HEARTBEAT_INTERVAL_MS)) {
    return;
  }
  lastHeartbeatTime = now;
  try {
    const { token, deviceId, serverUrl } = currentSession;
    await authApi.heartbeat({
      token,
      deviceId,
      baseUrl: serverUrl || MANAGEMENT_BASE_URL
    });
  } catch (_) {}
}

/**
 * Desktop Logout
 * POST /api/auth/logout
 * Clears local token and any cached data even if the request fails.
 */
async function logout() {
  const dir = userDataDir;
  if (currentSession && currentSession.token) {
    try {
      await authApi.logout({
        token: currentSession.token,
        baseUrl: currentSession.serverUrl || MANAGEMENT_BASE_URL
      });
    } catch (_) {}
  }
  clearSession(dir);
  return { success: true };
}

async function getSession() {
  const dir = userDataDir;
  if (!currentSession) {
    currentSession = loadSession(dir);
  }
  return currentSession ? sanitizeUser(currentSession) : null;
}

/**
 * Update user's name and/or avatar locally in encrypted session
 */
async function updateProfile({ name, avatar }) {
  const dir = userDataDir;
  if (!currentSession) {
    currentSession = loadSession(dir);
  }
  if (!currentSession || !currentSession.user) {
    return { success: false, message: 'No active session found.' };
  }

  const cleanName = name ? name.trim() : null;
  if (cleanName) {
    currentSession.user.name = cleanName;
  }
  if (avatar !== undefined) {
    currentSession.user.avatar = avatar;
  }

  saveSession(dir, currentSession);

  return {
    success: true,
    user: sanitizeUser(currentSession)
  };
}

function getBranding() {
  return appConfig.getBranding();
}

async function uploadBackup(snapshot) {
  const dir = userDataDir;
  if (!currentSession) {
    currentSession = loadSession(dir);
  }
  if (!currentSession || !currentSession.token) {
    return { success: false, reason: 'Please log in to upload backups.' };
  }
  const baseUrl = currentSession.serverUrl || MANAGEMENT_BASE_URL;
  try {
    const res = await authApi.uploadTenantBackup({
      token: currentSession.token,
      snapshot,
      baseUrl
    });
    return { success: true, records: snapshot ? snapshot.recordCount : 0, data: res };
  } catch (err) {
    return { success: false, reason: err.message || 'Failed to upload backup to Control Plane' };
  }
}

async function getBackup() {
  const dir = userDataDir;
  if (!currentSession) {
    currentSession = loadSession(dir);
  }
  if (!currentSession || !currentSession.token) {
    return { success: false, reason: 'Please log in to restore backups.' };
  }
  const baseUrl = currentSession.serverUrl || MANAGEMENT_BASE_URL;
  try {
    const res = await authApi.getTenantBackup({
      token: currentSession.token,
      baseUrl
    });
    return { success: true, backup: res };
  } catch (err) {
    return { success: false, reason: err.message || 'Failed to fetch backup from Control Plane' };
  }
}

module.exports = {
  init,
  login,
  checkDevice,
  sendHeartbeat,
  logout,
  getSession,
  getServerConfig,
  updateProfile,
  getBranding,
  setOnBrandingChanged,
  uploadBackup,
  getBackup
};
