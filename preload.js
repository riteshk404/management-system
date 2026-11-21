const { contextBridge, ipcRenderer } = require('electron');
const config = require('./app-config');

// Synchronize renderer's app-config copy whenever main process broadcasts branding changes
ipcRenderer.on('auth:brandingChanged', (_, b) => {
  if (b) config.applyControlPlaneResponse(b);
});

// Fetch latest branding from main process immediately on load
ipcRenderer.invoke('auth:getBranding').then((b) => {
  if (b) config.applyControlPlaneResponse(b);
}).catch(() => {});

contextBridge.exposeInMainWorld('api', {
  get appVersion() {
    try {
      return require('./package.json').version;
    } catch (_) {
      return '1.0.0';
    }
  },
  get appName() { return config.APP_NAME; },
  get workshopPhone() { return config.WORKSHOP_PHONE; },
  get workshopAddress() { return config.WORKSHOP_ADDRESS; },
  get workshopTagline() { return config.WORKSHOP_TAGLINE; },
  getBranding: () => ipcRenderer.invoke('auth:getBranding'),
  onBrandingChanged: (callback) => {
    ipcRenderer.on('auth:brandingChanged', (_, b) => {
      if (typeof callback === 'function') callback(b);
    });
  },

  // Authentication & Security (Control Plane)
  getAuthStatus: () => ipcRenderer.invoke('auth:getSetupStatus'),
  getServerConfig: () => ipcRenderer.invoke('auth:getServerConfig'),
  setupInitialAdmin: (data) => ipcRenderer.invoke('auth:setupInitialAdmin', data),
  login: (credentials) => ipcRenderer.invoke('auth:centralLogin', credentials),
  getSession: () => ipcRenderer.invoke('auth:getSession'),
  validateSession: () => ipcRenderer.invoke('auth:validateSession'),
  checkDevice: () => ipcRenderer.invoke('auth:checkDevice'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  changePassword: (data) => ipcRenderer.invoke('auth:changePassword', data),
  resetPasswordWithRecoveryKey: (data) => ipcRenderer.invoke('auth:resetPasswordWithRecoveryKey', data),
  updateProfile: (data) => ipcRenderer.invoke('auth:updateProfile', data),

  // Dashboard
  getDashboardStats: () => ipcRenderer.invoke('dashboard:getStats'),
  getRevenueBreakdown: () => ipcRenderer.invoke('dashboard:getRevenueBreakdown'),

  // Customers
  getCustomers: (search) => ipcRenderer.invoke('customers:getAll', search),
  getCustomerById: (id) => ipcRenderer.invoke('customers:getById', id),
  saveCustomer: (data) => ipcRenderer.invoke('customers:save', data),
  deleteCustomer: (id) => ipcRenderer.invoke('customers:delete', id),

  // Inventory
  getInventory: (search) => ipcRenderer.invoke('inventory:getAll', search),
  getInventoryById: (id) => ipcRenderer.invoke('inventory:getById', id),
  saveInventoryItem: (data) => ipcRenderer.invoke('inventory:save', data),
  adjustStock: (id, delta, reason) => ipcRenderer.invoke('inventory:adjustStock', id, delta, reason),
  deleteInventoryItem: (id) => ipcRenderer.invoke('inventory:delete', id),

  // Billing
  getNextInvoiceNumber: () => ipcRenderer.invoke('billing:getNextInvoiceNo'),
  createInvoice: (billData) => ipcRenderer.invoke('billing:createInvoice', billData),
  getInvoices: (filter) => ipcRenderer.invoke('billing:getInvoices', filter),
  getInvoiceDetails: (invoiceId) => ipcRenderer.invoke('billing:getInvoiceDetails', invoiceId),

  // Payments
  recordPayment: (data) => ipcRenderer.invoke('payments:record', data),
  getAllPayments: (search) => ipcRenderer.invoke('payments:getAll', search),

  // Backup & Restore & App
  backupDatabase: () => ipcRenderer.invoke('system:backupDatabase'),
  restoreDatabase: () => ipcRenderer.invoke('system:restoreDatabase'),
  printInvoice: () => ipcRenderer.invoke('system:printInvoice'),
  saveInvoicePdf: (invoiceNo) => ipcRenderer.invoke('system:saveInvoicePdf', invoiceNo),
  getAppInfo: () => ipcRenderer.invoke('system:getAppInfo'),

  // Cloud Sync & Remote Backup
  syncCloudData: (forceAction) => ipcRenderer.invoke('system:syncCloudData', forceAction),
  backupCloudNow: () => ipcRenderer.invoke('system:backupCloudNow'),
  getCloudSyncStatus: () => ipcRenderer.invoke('system:getCloudSyncStatus'),

  // Software Updates
  checkForUpdates: () => ipcRenderer.invoke('system:checkForUpdates'),
  installUpdate: (downloadUrl) => ipcRenderer.invoke('system:installUpdate', downloadUrl),

  // Sync event listener (when background sync restores data)
  onDataRestored: (cb) => ipcRenderer.on('sync:dataRestored', (_, data) => cb(data)),

  // Listen for auto-backup completion (silent background sync feedback)
  onBackupCompleted: (cb) => ipcRenderer.on('sync:backupCompleted', (_, info) => cb(info)),

  // Listen for sync state changes (syncing/pending indicators)
  onSyncStateChanged: (cb) => ipcRenderer.on('sync:stateChanged', (_, state) => cb(state)),

  // Listen for unauthorized events
  onUnauthorized: (cb) => ipcRenderer.on('auth:unauthorized', cb)
});
