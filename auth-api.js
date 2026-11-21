const { DEFAULT_API_BASE_URL, API_TIMEOUT_MS } = require('./auth-config');

/**
 * Normalizes and builds the target endpoint URL.
 * Builds URLs from MANAGEMENT_BASE_URL.
 * Normalizes trailing and leading slashes.
 */
function buildUrl(baseUrl, endpoint) {
  let cleanBase = (baseUrl || DEFAULT_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!cleanBase) {
    throw new Error('Management Base URL is not configured.');
  }
  let cleanEndpoint = (endpoint || '').trim().replace(/^\/+/, '');

  if (cleanBase.endsWith('/api') && cleanEndpoint.startsWith('api/')) {
    cleanEndpoint = cleanEndpoint.slice(4);
  } else if (!cleanBase.endsWith('/api') && !cleanEndpoint.startsWith('api/')) {
    cleanEndpoint = 'api/' + cleanEndpoint;
  }
  return `${cleanBase}/${cleanEndpoint}`;
}

async function request(endpoint, options = {}, baseUrl) {
  const url = buildUrl(baseUrl, endpoint);
  const controller = new AbortController();
  const timeoutMs = Number(process.env.MANAGEMENT_API_TIMEOUT_MS) || API_TIMEOUT_MS || 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(options.headers || {})
      }
    });
    clearTimeout(timer);

    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { raw: text };
    }

    if (!res.ok) {
      let msg = (data && (data.message || data.error)) || `HTTP ${res.status}: ${res.statusText}`;
      if (res.status === 503) {
        msg = 'Service temporarily unavailable';
      } else if (res.status === 429) {
        msg = (data && data.message) || 'Too many requests. Please wait and try again.';
      }
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error('Connection timed out. Please check your internet connection.');
      err.code = 'TIMEOUT';
      err.status = 408;
      throw err;
    }
    if (!e.status) {
      const err = new Error('Unable to connect to the cloud service. Please check your internet connection.');
      err.code = 'NETWORK';
      throw err;
    }
    throw e;
  }
}

/**
 * 1. Tenant Isolation & Desktop Login
 * POST {baseUrl}/api/auth/login
 * Content-Type: application/json
 * Body: { email, password, deviceId, deviceName, tenant, tenantKey }
 */
async function login({ email, password, deviceId, deviceName, tenant, tenantKey, baseUrl }) {
  const payload = {
    email: (email || '').trim(),
    password: password || '',
    deviceId: (deviceId || '').trim(),
    deviceName: (deviceName || '').trim(),
    tenant: (tenant || '').trim(),
    tenantKey: (tenantKey || '').trim()
  };
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload)
  }, baseUrl);
}

/**
 * 2. Device Activation
 * POST {baseUrl}/api/auth/activate
 * Authorization: Bearer <session-token>
 * Content-Type: application/json
 * Body: { deviceId, deviceName }
 */
async function registerDevice({ token, deviceId, deviceName, baseUrl }) {
  return request('/api/auth/activate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId, deviceName })
  }, baseUrl);
}

/**
 * 3. Device Status / Authorization Check
 * GET {baseUrl}/api/auth/device-status?deviceId=...
 * Authorization: Bearer <session-token>
 */
async function getDeviceStatus({ token, deviceId, baseUrl }) {
  const qs = `?deviceId=${encodeURIComponent(deviceId)}`;
  return request(`/api/auth/device-status${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  }, baseUrl);
}

/**
 * 4. Heartbeat
 * POST {baseUrl}/api/auth/heartbeat
 * Authorization: Bearer <session-token>
 * Content-Type: application/json
 * Body: { deviceId }
 */
async function heartbeat({ token, deviceId, baseUrl }) {
  return request('/api/auth/heartbeat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId })
  }, baseUrl);
}

/**
 * 5. Logout
 * POST {baseUrl}/api/auth/logout
 * Authorization: Bearer <session-token>
 */
async function logout({ token, baseUrl }) {
  try {
    return await request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }, baseUrl);
  } catch (e) {
    return { success: true };
  }
}

/**
 * 6. Upload Tenant Backup to Control Plane
 * PUT {baseUrl}/api/tenants/backup
 * Authorization: Bearer <session-token>
 */
async function uploadTenantBackup({ token, snapshot, baseUrl }) {
  return request('/api/tenants/backup', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      snapshot,
      recordCount: snapshot ? snapshot.recordCount : 0,
      updatedAt: new Date().toISOString()
    })
  }, baseUrl);
}

/**
 * 7. Get Tenant Backup from Control Plane
 * GET {baseUrl}/api/tenants/backup
 * Authorization: Bearer <session-token>
 */
async function getTenantBackup({ token, baseUrl }) {
  return request('/api/tenants/backup', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  }, baseUrl);
}

module.exports = {
  buildUrl,
  login,
  registerDevice,
  getDeviceStatus,
  heartbeat,
  logout,
  uploadTenantBackup,
  getTenantBackup
};
