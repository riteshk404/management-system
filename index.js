require('./env');
const { app, BrowserWindow, ipcMain, dialog, session, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('fs');
const db = require('./db.js');
const config = require('./app-config');
const authService = require('./auth-service');
const cloudSync = require('./cloud-sync');

let mainWindow = null;

// Enforce single instance lock (Professional desktop standard: prevents multiple instances corrupting SQLite)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ----------------------------------------------------
// Global Uncaught Exception Handling & Crash Logging
// ----------------------------------------------------
function logErrorToFile(type, err) {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    const time = new Date().toISOString();
    const message = `[${time}] ${type}: ${err && err.stack ? err.stack : err}\n`;
    fs.appendFileSync(logPath, message, 'utf8');
  } catch (_) { }
}

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught Exception:', err);
  logErrorToFile('UncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled Promise Rejection:', reason);
  logErrorToFile('UnhandledRejection', reason);
});

// ----------------------------------------------------
// Register All IPC Handlers immediately
// ----------------------------------------------------
// Authentication/session channels must stay reachable before the user signs
// in. Everything else is only available once a local session exists, so a
// renderer cannot read or mutate workshop data from the login screen.
const AUTH_EXEMPT_CHANNELS = new Set([
  'auth:getSetupStatus',
  'auth:setupInitialAdmin',
  'auth:getServerConfig',
  'auth:centralLogin',
  'auth:getSession',
  'auth:validateSession',
  'auth:checkDevice',
  'auth:logout',
  'auth:changePassword',
  'auth:resetPasswordWithRecoveryKey',
  'auth:updateProfile',
  'auth:getBranding',
  'system:getAppInfo'
]);

function registerHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!AUTH_EXEMPT_CHANNELS.has(channel)) {
      let session = null;
      try { session = await authService.getSession(); } catch (_) {}
      if (!session) {
        const err = new Error('Authentication required. Please sign in again.');
        err.code = 'NOT_AUTHENTICATED';
        throw err;
      }
    }
    return handler(event, ...args);
  });
}

function registerIpcHandlers() {
  // Authentication & Control Plane integration
  registerHandler('auth:getSetupStatus', async () => {
    return { hasUsers: true, mode: 'control-plane' };
  });

  registerHandler('auth:setupInitialAdmin', async (_, data) => {
    return db.createInitialUser(data);
  });

  registerHandler('auth:getServerConfig', async () => {
    const dir = app.getPath('userData');
    await authService.init(dir, () => {
      if (mainWindow) mainWindow.webContents.send('auth:unauthorized');
    });
    return authService.getServerConfig();
  });

  // Central (control-plane) authentication & device binding
  registerHandler('auth:centralLogin', async (_, credentials) => {
    const dir = app.getPath('userData');
    await authService.init(dir, () => {
      if (mainWindow) mainWindow.webContents.send('auth:unauthorized');
    });
    const res = await authService.login(credentials);
    if (res && res.success && res.user && res.user.tenant) {
      // Re-scope the local database strictly to this tenant
      await db.initDatabase(dir, res.user.tenant);

      // Push-only: if local has data → push to cloud. If local empty → one-time pull.
      setTimeout(async () => {
        try {
          const pullRes = await cloudSync.pullIfEmpty(res.user.tenant, res.user.email);
          if (pullRes && pullRes.action && pullRes.action.startsWith('restored') && mainWindow) {
            mainWindow.webContents.send('sync:dataRestored', pullRes);
          }
        } catch (_) {}
      }, 500);
    }
    return res;
  });

  registerHandler('auth:getSession', async () => {
    const dir = app.getPath('userData');
    await authService.init(dir, () => {
      if (mainWindow) mainWindow.webContents.send('auth:unauthorized');
    });
    const sess = await authService.getSession();
    if (sess && sess.tenant) {
      // Ensure database is attached to the authenticated tenant
      await db.initDatabase(dir, sess.tenant);
    }
    return sess;
  });

  registerHandler('auth:validateSession', async () => {
    const dir = app.getPath('userData');
    await authService.init(dir, () => {
      if (mainWindow) mainWindow.webContents.send('auth:unauthorized');
    });
    const session = await authService.getSession();
    if (!session) return null;
    const dev = await authService.checkDevice();
    if (!dev || !dev.authorized) return null;
    if (session.tenant) {
      await db.initDatabase(dir, session.tenant);

      // Push-only on session resume: upload if local has data, pull only if empty
      setTimeout(async () => {
        try {
          const email = (session.user && session.user.email) || '';
          const pullRes = await cloudSync.pullIfEmpty(session.tenant, email);
          if (pullRes && pullRes.action && pullRes.action.startsWith('restored') && mainWindow) {
            mainWindow.webContents.send('sync:dataRestored', pullRes);
          }
        } catch (_) {}
      }, 1000);
    }
    return session;
  });

  registerHandler('auth:checkDevice', async () => {
    const dir = app.getPath('userData');
    await authService.init(dir, () => {
      if (mainWindow) mainWindow.webContents.send('auth:unauthorized');
    });
    const status = await authService.checkDevice();
    const session = await authService.getSession();
    if (session && session.tenant) {
      await db.initDatabase(dir, session.tenant);
    }
    return status;
  });

  registerHandler('auth:logout', async () => {
    const dir = app.getPath('userData');
    await authService.init(dir, () => {
      if (mainWindow) mainWindow.webContents.send('auth:unauthorized');
    });
    const res = await authService.logout();
    try {
      db.closeDatabase();
    } catch (_) { }
    return res;
  });

  registerHandler('auth:getBranding', async () => {
    return authService.getBranding();
  });

  registerHandler('auth:changePassword', async (_, data) => {
    return db.changePassword(data);
  });

  registerHandler('auth:resetPasswordWithRecoveryKey', async (_, data) => {
    return db.resetPasswordWithRecoveryKey(data);
  });

  registerHandler('auth:updateProfile', async (_, data) => {
    const res = await authService.updateProfile(data);
    try {
      if (data && data.name) {
        db.updateUserProfile(data);
      }
    } catch (_) { }
    return res;
  });

  // Wire up auto-backup completion callback → push status to renderer
  cloudSync.setOnBackupCompleted((info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:backupCompleted', info);
    }
  });

  // Wire up sync state changes → push syncing/pending indicators to renderer
  cloudSync.setOnSyncStateChanged((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:stateChanged', state);
    }
  });

  // Helper: Trigger debounced background cloud backup after data mutations
  async function triggerAutoBackup() {
    try {
      cloudSync.markDirty(); // Immediately flag unsaved changes for the UI
      const sess = await authService.getSession();
      const slug = (sess && sess.tenant) || require('./app-config').TENANT || 'default';
      const email = (sess && sess.user && sess.user.email) || '';
      cloudSync.scheduleBackgroundBackup(slug, email);
    } catch (_) {}
  }

  // Dashboard
  registerHandler('dashboard:getStats', async () => {
    return db.getDashboardStats();
  });

  registerHandler('dashboard:getRevenueBreakdown', async () => {
    return db.getRevenueBreakdown();
  });

  // Customers
  registerHandler('customers:getAll', async (_, search) => {
    return db.getCustomers(search);
  });

  registerHandler('customers:getById', async (_, id) => {
    return db.getCustomerById(id);
  });

  registerHandler('customers:save', async (_, data) => {
    const res = db.saveCustomer(data);
    triggerAutoBackup();
    return res;
  });

  registerHandler('customers:delete', async (_, id) => {
    const res = db.deleteCustomer(id);
    triggerAutoBackup();
    return res;
  });

  // Inventory
  registerHandler('inventory:getAll', async (_, search) => {
    return db.getInventory(search);
  });

  registerHandler('inventory:getById', async (_, id) => {
    return db.getInventoryById(id);
  });

  registerHandler('inventory:save', async (_, data) => {
    const res = db.saveInventoryItem(data);
    triggerAutoBackup();
    return res;
  });

  registerHandler('inventory:adjustStock', async (_, id, delta, reason) => {
    const res = db.adjustStock(id, delta, reason);
    triggerAutoBackup();
    return res;
  });

  registerHandler('inventory:delete', async (_, id) => {
    const res = db.deleteInventoryItem(id);
    triggerAutoBackup();
    return res;
  });

  // Billing
  registerHandler('billing:getNextInvoiceNo', async () => {
    return db.generateNextInvoiceNumber();
  });

  registerHandler('billing:createInvoice', async (_, billData) => {
    const res = db.createInvoice(billData);
    triggerAutoBackup();
    return res;
  });

  registerHandler('billing:getInvoices', async (_, filter) => {
    return db.getInvoices(filter);
  });

  registerHandler('billing:getInvoiceDetails', async (_, invoiceId) => {
    return db.getInvoiceDetails(invoiceId);
  });

  // Payments
  registerHandler('payments:record', async (_, data) => {
    const res = db.recordPayment(data);
    triggerAutoBackup();
    return res;
  });

  registerHandler('payments:getAll', async (_, search) => {
    return db.getAllPayments(search);
  });

  // System (Export Data to Excel by default / SQLite optional, Restore, Print & PDF)
  registerHandler('system:backupDatabase', async () => {
    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultFilename = `garage-workshop-data-${dateStr}.xls`;
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Workshop Data',
      defaultPath: defaultFilename,
      filters: [
        { name: 'Excel Spreadsheet (*.xls, *.xml)', extensions: ['xls', 'xml'] },
        { name: 'SQLite Database (*.sqlite, *.db)', extensions: ['sqlite', 'db'] }
      ]
    });

    if (canceled || !filePath) return { canceled: true };

    if (filePath.endsWith('.sqlite') || filePath.endsWith('.db')) {
      return await db.backupDatabase(filePath);
    } else {
      return db.exportToExcel(filePath);
    }
  });

  registerHandler('system:restoreDatabase', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
      title: 'Restore Garage Database Backup',
      filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }],
      properties: ['openFile']
    });

    if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };

    const res = db.restoreDatabase(filePaths[0]);
    return {
      success: !!(res && res.success),
      restarted: false,
      safetyBackup: res && res.safetyBackup
    };
  });

  registerHandler('system:printInvoice', async () => {
    if (mainWindow) {
      mainWindow.webContents.print({ silent: false, printBackground: true });
      return { success: true };
    }
    return { success: false };
  });

  registerHandler('system:saveInvoicePdf', async (_, invoiceNo) => {
    if (!mainWindow) return { canceled: true };

    const defaultName = `${invoiceNo || 'Invoice'}.pdf`;
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Invoice as PDF',
      defaultPath: defaultName,
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
    });

    if (canceled || !filePath) return { canceled: true };

    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      marginsType: 1, // Minimum margins
      pageSize: 'A4'
    });

    fs.writeFileSync(filePath, pdfData);
    return { success: true, filePath };
  });

  // Cloud Sync & Remote Backup (PUSH-ONLY by default)
  registerHandler('system:syncCloudData', async (_, forceAction) => {
    const session = await authService.getSession();
    const tenantSlug = (session && session.tenant) || require('./app-config').TENANT || 'default';
    const userEmail = (session && session.user && session.user.email) || '';
    // Manual "Sync Now" button — the only user-initiated read
    const result = await cloudSync.manualSync(tenantSlug, userEmail);
    if (result && result.action && result.action.startsWith('restored') && mainWindow) {
      mainWindow.webContents.send('sync:dataRestored', result);
    }
    return result;
  });

  registerHandler('system:backupCloudNow', async () => {
    const session = await authService.getSession();
    const tenantSlug = (session && session.tenant) || require('./app-config').TENANT || 'default';
    const userEmail = (session && session.user && session.user.email) || '';
    return await cloudSync.uploadBackup(tenantSlug, userEmail);
  });

  registerHandler('system:getCloudSyncStatus', async () => {
    return cloudSync.getSyncStatus();
  });

  // Remote Software Updates
  registerHandler('system:checkForUpdates', async () => {
    const curVer = app.getVersion() || '1.0.0';
    return await cloudSync.checkForUpdates(curVer);
  });

  registerHandler('system:installUpdate', async (_, downloadUrl) => {
    if (!downloadUrl) {
      return { success: false, message: 'No download link is configured for this update.' };
    }

    let parsed;
    try {
      parsed = new URL(String(downloadUrl));
    } catch (_) {
      return { success: false, message: 'The update download link is invalid.' };
    }

    // Only hand http(s) links to the operating system. This prevents a
    // poisoned update document from launching file://, javascript:, or other
    // dangerous handlers.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { success: false, message: 'Only web links can be opened for updates.' };
    }

    const { shell } = require('electron');
    await shell.openExternal(parsed.toString());
    return { success: true, openedUrl: true };
  });

  registerHandler('system:getAppInfo', async () => {
    return {
      version: app.getVersion(),
      userDataPath: app.getPath('userData'),
      platform: process.platform
    };
  });
}

// Register IPC handlers immediately
registerIpcHandlers();

async function createWindow() {
  const userDataPath = app.getPath('userData');
  console.log('[Main] User data directory:', userDataPath);

  // Initialize secure auth service first to check for existing active session
  authService.setOnBrandingChanged((branding) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:brandingChanged', branding);
    }
  });

  const activeUser = await authService.init(userDataPath, () => {
    if (mainWindow) mainWindow.webContents.send('auth:unauthorized');
  });

  // Fetch device status & branding from control plane immediately on startup
  (async () => {
    try {
      const dev = await authService.checkDevice();
      if (mainWindow && !mainWindow.isDestroyed() && dev && dev.branding) {
        mainWindow.webContents.send('auth:brandingChanged', dev.branding);
      }
    } catch (err) {
      console.warn('[Startup] Failed to check device branding:', err.message);
    }
  })();

  // Scope the database to the active session tenant, or fallback to the baked-in TENANT
  const { TENANT } = require('./app-config');
  const targetTenant = (activeUser && activeUser.tenant) ? activeUser.tenant : (TENANT || 'default');
  await db.initDatabase(userDataPath, targetTenant);

  // Security: Restrict permissions to desktop essentials
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['fullscreen'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['fullscreen'].includes(permission);
  });

  // Register Application ID for Windows taskbar & notifications
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.workshop.management');
  }

  // Load application icon (ICO on Windows, optimized PNG on Linux)
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'garage.ico')
    : (fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png') : path.join(__dirname, 'garage.png'));

  let appIcon = null;
  try {
    if (fs.existsSync(iconPath)) {
      appIcon = nativeImage.createFromPath(iconPath);
    }
  } catch (_) {}

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 650,
    title: `${config.APP_NAME} — Management System`,
    icon: (appIcon && !appIcon.isEmpty()) ? appIcon : iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#F8F9FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (appIcon && !appIcon.isEmpty()) {
    try {
      mainWindow.setIcon(appIcon);
    } catch (_) {}
  }

  mainWindow.loadFile('index.html');

  // Prevent opening uncontrolled new browser windows
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Keep the app on its own page. If injected content tries to navigate the
  // window to an external site, block it.
  const appPageUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (String(url).split('#')[0] !== appPageUrl) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // In production/client builds, lock down developer tools and inspect shortcuts
  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
    mainWindow.webContents.on('before-input-event', (event, input) => {
      // Block Ctrl+Shift+I / Cmd+Option+I and F12
      if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') {
        event.preventDefault();
      }
      if (input.key === 'F12') {
        event.preventDefault();
      }
    });
  } else {
    // Forward renderer console to stdout in dev mode without deprecation warnings
    mainWindow.webContents.on('console-message', (event, ...args) => {
      const msg = (event && typeof event.message === 'string') ? event.message : (args[1] || args[0] || '');
      console.log(`[Renderer] ${msg}`);
    });
  }

  // Remove default menu bar for clean modern look
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});