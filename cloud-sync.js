const db = require('./db');
const authService = require('./auth-service');
const pkg = require('./package.json');

let debouncedTimer = null;
let lastBackupInfo = { success: false, records: 0, updatedAt: null, action: null };
let onBackupCompletedCallback = null;
let onSyncStateChangedCallback = null;

// Tracks whether local data has changed since the last successful backup
let hasPendingChanges = false;
// Tracks whether an upload is actively in progress
let isSyncing = false;
// Record count at last successful backup (to compute new records delta)
let recordsAtLastBackup = 0;

function setOnBackupCompleted(cb) {
  onBackupCompletedCallback = cb;
}

function setOnSyncStateChanged(cb) {
  onSyncStateChangedCallback = cb;
}

function notifySyncState() {
  if (typeof onSyncStateChangedCallback === 'function') {
    try {
      onSyncStateChangedCallback({ isSyncing, hasPendingChanges });
    } catch (_) {}
  }
}

/** Mark that local data has been mutated and needs backup. */
function markDirty() {
  if (!hasPendingChanges) {
    hasPendingChanges = true;
    notifySyncState();
  }
}

/**
 * PUSH-ONLY: Uploads local SQLite snapshot to Control Plane HTTP API under tenant.
 * The Control Plane then persists it to the tenant's MongoDB cluster.
 */
async function uploadBackup(tenantSlug, userEmail = '') {
  isSyncing = true;
  notifySyncState();
  try {
    const snapshot = db.getTenantDataSnapshot();
    if (!snapshot) {
      isSyncing = false;
      notifySyncState();
      return { success: false, reason: 'No local database snapshot available.' };
    }

    const res = await authService.uploadBackup(snapshot);
    if (res && res.success) {
      hasPendingChanges = false;
      recordsAtLastBackup = snapshot.recordCount;
      lastBackupInfo = {
        success: true,
        records: snapshot.recordCount,
        updatedAt: new Date().toISOString(),
        action: 'uploaded'
      };
      isSyncing = false;
      notifySyncState();
      if (typeof onBackupCompletedCallback === 'function') {
        try { onBackupCompletedCallback(lastBackupInfo); } catch (_) {}
      }
      return { success: true, records: snapshot.recordCount };
    }
    isSyncing = false;
    notifySyncState();
    return {
      success: false,
      reason: res && res.reason ? res.reason : 'Failed to upload backup to Control Plane.'
    };
  } catch (err) {
    console.warn('[CloudSync] Upload backup error:', err.message);
    isSyncing = false;
    notifySyncState();
    return { success: false, error: err.message, reason: err.message };
  }
}

/**
 * Restore from cloud backup if local database is completely empty.
 */
async function pullIfEmpty(tenantSlug, userEmail = '') {
  try {
    const localSnapshot = db.getTenantDataSnapshot();
    const localCount = localSnapshot ? localSnapshot.recordCount : 0;
    if (localCount > 0) return { success: true, action: 'in_sync', records: localCount };

    const res = await authService.getBackup();
    if (res && res.success && res.backup) {
      const b = res.backup;
      const snapshot = b.snapshot || b.data || b;
      if (snapshot && (snapshot.customers || snapshot.invoices || snapshot.inventory)) {
        db.restoreTenantDataSnapshot(snapshot);
        const count = snapshot.recordCount || (
          (snapshot.customers ? snapshot.customers.length : 0) +
          (snapshot.inventory ? snapshot.inventory.length : 0) +
          (snapshot.invoices ? snapshot.invoices.length : 0)
        );
        lastBackupInfo = {
          success: true,
          records: count,
          updatedAt: b.updatedAt || new Date().toISOString(),
          action: 'restored_from_cloud'
        };
        return {
          success: true,
          action: 'restored_from_cloud',
          records: count,
          lastUpdatedBy: b.lastUpdatedBy || ''
        };
      }
    }

    return { success: true, action: 'in_sync', records: 0 };
  } catch (err) {
    console.warn('[CloudSync] Pull if empty error:', err.message);
    return { success: false, error: err.message };
  }
}

async function manualSync(tenantSlug, userEmail = '') {
  const localSnapshot = db.getTenantDataSnapshot();
  const localCount = localSnapshot ? localSnapshot.recordCount : 0;

  if (localCount === 0) {
    return await pullIfEmpty(tenantSlug, userEmail);
  }
  return await uploadBackup(tenantSlug, userEmail);
}

function getSyncStatus() {
  const localSnapshot = db.getTenantDataSnapshot();
  const localRecords = localSnapshot ? localSnapshot.recordCount : 0;
  const newRecords = Math.max(0, localRecords - recordsAtLastBackup);
  return {
    connected: true,
    configured: true,
    localRecords,
    lastBackup: lastBackupInfo,
    isSyncing,
    hasPendingChanges,
    newRecords
  };
}

async function checkForUpdates(currentVersion = pkg.version) {
  return { updateAvailable: false, currentVersion };
}

function scheduleBackgroundBackup(tenantSlug, userEmail = '') {
  if (debouncedTimer) clearTimeout(debouncedTimer);
  debouncedTimer = setTimeout(async () => {
    try {
      await uploadBackup(tenantSlug, userEmail);
    } catch (_) {}
  }, 5000);
}

module.exports = {
  uploadBackup,
  pullIfEmpty,
  manualSync,
  getSyncStatus,
  checkForUpdates,
  scheduleBackgroundBackup,
  setOnBackupCompleted,
  setOnSyncStateChanged,
  markDirty
};
