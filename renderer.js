// Main Application Renderer Controller
const APP_NAME = (window.api && window.api.appName) ? window.api.appName : 'My Garage';

const app = {
  activeTab: 'dashboard',
  features: { backups: false },
  currentCustomers: [],
  currentInventory: [],
  billItems: [],
  nextInvoiceNo: '',
  salesRange: '7d',

  currentUser: null,

  async init() {
    document.title = 'Sign In — Management System';
    const authTitleEl = document.querySelector('.auth-title');
    if (authTitleEl) authTitleEl.textContent = 'Sign In';

    // Synchronize branding from main process immediately
    if (window.api && typeof window.api.onBrandingChanged === 'function') {
      window.api.onBrandingChanged((b) => {
        this.applyBranding(b);
      });
    }
    if (window.api && typeof window.api.getBranding === 'function') {
      try {
        const b = await window.api.getBranding();
        if (b) this.applyBranding(b);
      } catch (_) {
        this.applyBranding();
      }
    } else {
      this.applyBranding();
    }

    this.initAppVersion();
    this.applyAvatar();
    this.initTheme();
    await this.initAuth();
    this.bindEvents();
    this.setupGlobalSearch();

    // Do not touch workshop data until a session exists. The main process now
    // rejects data IPC calls without a session, so loading before login would
    // only produce errors (and would expose data behind the login screen).
    if (this.currentUser) {
      await this.loadDashboard();
      await this.prepareBilling();
      this.startDeviceCheckTimer();
    }

    // Restore last active tab on page load/refresh
    const savedTab = localStorage.getItem('garage_active_tab') || 'dashboard';
    this.switchTab(savedTab);

    // Automatic multi-computer sync listener
    if (window.api && window.api.onDataRestored) {
      window.api.onDataRestored(async (result) => {
        console.log('[Renderer] Remote data restored:', result);
        this.showToast(`Cloud sync: Restored ${result.records || ''} records from remote backup!`, 'success');
        await this.loadCustomers();
        await this.loadInventory();
        await this.loadInvoices();
        await this.loadDashboard();
        this.updateCloudSyncDisplay();
      });
    }

    // Silent auto-backup completion feedback — update cloud sync UI without intrusive toasts
    if (window.api && window.api.onBackupCompleted) {
      window.api.onBackupCompleted((info) => {
        console.log('[Renderer] Auto-backup completed:', info);
        this.updateCloudSyncDisplay();
      });
    }

    // Live sync state indicator (syncing spinner / pending changes badge)
    if (window.api && window.api.onSyncStateChanged) {
      window.api.onSyncStateChanged((state) => {
        this.updateSyncActivityIndicator(state);
      });
    }
  },

  // ----------------------------------------------------
  // Theme / Dark Mode
  // ----------------------------------------------------
  initTheme() {
    const saved = localStorage.getItem('garage_theme') || 'system';
    this.applyTheme(saved);
    // Listen for OS theme changes (for 'system' mode)
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if ((localStorage.getItem('garage_theme') || 'system') === 'system') {
          this.applyTheme('system');
        }
      });
    } catch (_) {}
  },

  applyTheme(mode) {
    localStorage.setItem('garage_theme', mode);
    let resolved = mode;
    if (mode === 'system') {
      resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    this.updateThemeUI(resolved, mode);
  },

  updateThemeUI(resolved, preference) {
    // Top-bar toggle switch — sync checkbox state
    const topCheckbox = document.getElementById('theme-switch-checkbox');
    if (topCheckbox) topCheckbox.checked = (resolved === 'dark');

    // Login screen toggle switch
    const loginCheckbox = document.getElementById('login-theme-switch-checkbox');
    if (loginCheckbox) loginCheckbox.checked = (resolved === 'dark');

    // Settings theme choice buttons — highlight the active preference
    document.querySelectorAll('.theme-choice-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeChoice === preference);
    });
  },

  // ----------------------------------------------------
  // Dynamic Branding
  // ----------------------------------------------------
  applyBranding(branding) {
    const b = branding || (this.currentUser && this.currentUser.branding) || null;
    const phone = (b && (b.phone || b.workshopPhone || b.workshop_phone || b.phoneNumber || b.contact || b.WORKSHOP_PHONE || (b.tenant && (b.tenant.phone || b.tenant.workshopPhone)) || (b.user && (b.user.phone || b.user.workshopPhone)))) || (window.api && window.api.workshopPhone);
    const address = (b && (b.address || b.workshopAddress || b.workshop_address || b.location || b.WORKSHOP_ADDRESS || (b.tenant && (b.tenant.address || b.tenant.workshopAddress)) || (b.user && (b.user.address || b.user.workshopAddress)))) || (window.api && window.api.workshopAddress);
    const tagline = (b && (b.tagline || b.tagLine || b.tag_line || b.workshopTagline || b.workshop_tagline || b.WORKSHOP_TAGLINE || b.slogan || (b.tenant && (b.tenant.tagline || b.tenant.tagLine || b.tenant.workshopTagline)) || (b.user && (b.user.tagline || b.user.workshopTagline)))) || (window.api && window.api.workshopTagline);
    const appName = (b && (b.appName || b.app_name || b.APP_NAME || b.tenantName || b.name || (b.tenant && (b.tenant.name || b.tenant.appName)) || (b.user && (b.user.appName || b.user.tenantName)))) || (window.api && window.api.appName);

    if (tagline) {
      document.querySelectorAll('.invoice-workshop-tagline').forEach(el => { el.textContent = tagline; });
    }
    const parts = [];
    if (phone) parts.push(`Phone: ${phone}`);
    if (address) parts.push(address);
    if (parts.length > 0) {
      const contactStr = parts.join(' | ');
      document.querySelectorAll('.invoice-workshop-contact').forEach(el => { el.textContent = contactStr; });
    }
    if (appName) {
      document.querySelectorAll('.invoice-company-name').forEach(el => { el.textContent = appName; });
    }
  },

  initAppVersion(v) {
    if (v) this.appVersion = v;
    if (!this.appVersion) {
      this.appVersion = (window.api && window.api.appVersion) || '1.0.0';
    }
    const verStr = this.appVersion;
    document.querySelectorAll('.app-version-pill, #app-current-version-pill, #about-app-version-pill').forEach(el => {
      el.textContent = `v${verStr}`;
    });
    const desc = document.getElementById('update-status-desc');
    if (desc && !this._availableUpdate) {
      desc.textContent = `Version ${verStr} is currently the latest version.`;
    }
    const profVer = document.getElementById('profile-app-version');
    if (profVer) {
      profVer.textContent = verStr;
    }
  },

  // ----------------------------------------------------
  // Navigation & Tabs
  // ----------------------------------------------------
  switchTab(tabName) {
    const previousTab = this.activeTab;
    this.activeTab = tabName;
    try {
      localStorage.setItem('garage_active_tab', tabName);
    } catch (e) { }

    if (previousTab !== tabName) {
      document.querySelector('.content-area').scrollTop = 0;
    }

    // Update sidebar navigation
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab visibility
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
    });

    const activeEl = document.getElementById(`tab-${tabName}`);
    if (activeEl) activeEl.classList.add('active');

    // Update title
    const titles = {
      dashboard: 'Dashboard',
      customers: 'Customers',
      inventory: 'Inventory & Stock',
      billing: 'Billing & Invoicing',
      payments: 'Payment Management',
      revenue: 'Revenue',
      profile: 'My Profile',
      settings: 'Settings'
    };
    document.getElementById('page-title').textContent = titles[tabName] || 'Garage Management';

    // Auto close sidebar on mobile navigation
    this.closeSidebar();

    // No session means the auth screen is visible; skip data loading.
    if (!this.currentUser) return;

    // Refresh content for current tab
    if (tabName === 'dashboard') this.loadDashboard();
    if (tabName === 'customers') this.loadCustomers();
    if (tabName === 'inventory') this.loadInventory();
    if (tabName === 'billing') this.prepareBilling();
    if (tabName === 'payments') this.loadPayments();
    if (tabName === 'revenue') this.loadRevenue();
    if (tabName === 'profile') this.loadProfile();
    if (tabName === 'settings') {
      this.renderSettingsQrList();
      this.updateCloudSyncDisplay();
    }
  },

  toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('active', isOpen);
  },

  closeSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  },

  bindEvents() {
    // Responsive Mobile Sidebar Toggle
    document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
      this.toggleSidebar();
    });
    document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
      this.closeSidebar();
    });

    document.querySelectorAll('.sales-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sales-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.salesRange = btn.dataset.range;
        this.renderSalesChart();
      });
    });

    // Sidebar user section opens profile
    document.getElementById('sidebar-user-section')?.addEventListener('click', (e) => {
      if (e.target.closest('#btn-settings-backup')) return;
      if (e.target.closest('#btn-change-avatar')) return;
      this.switchTab('profile');
    });

    // Avatar upload & change picture triggers
    const triggerAvatarUpload = (e) => {
      if (e) e.stopPropagation();
      document.getElementById('profile-avatar-file')?.click();
    };

    document.getElementById('btn-upload-avatar-card')?.addEventListener('click', triggerAvatarUpload);
    document.getElementById('profile-avatar')?.addEventListener('click', () => {
      this.openAvatarView();
    });

    // Toggle Edit Profile Modal
    const toggleEditProfile = (show) => {
      const willShow = (typeof show === 'boolean') ? show : true;
      if (willShow) {
        if (this.currentUser) {
          const input = document.getElementById('profile-name-input');
          if (input) input.value = this.currentUser.name || '';
        }
        this.openModal('modal-edit-profile');
        setTimeout(() => document.getElementById('profile-name-input')?.focus(), 150);
      } else {
        this.closeModal('modal-edit-profile');
      }
    };

    document.getElementById('btn-toggle-edit-profile')?.addEventListener('click', () => toggleEditProfile(true));
    document.getElementById('btn-close-edit-profile')?.addEventListener('click', () => toggleEditProfile(false));
    document.getElementById('btn-cancel-edit-profile')?.addEventListener('click', () => toggleEditProfile(false));

    // License Agreement (EULA) Modal trigger
    document.getElementById('btn-view-eula')?.addEventListener('click', () => {
      this.openModal('modal-eula');
    });

    // Remove avatar button
    document.getElementById('btn-remove-avatar')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const storageKey = this.getAvatarStorageKey();
      if (storageKey) localStorage.removeItem(storageKey);
      if (this.currentUser) this.currentUser.avatar = null;
      this.applyAvatar();
      try {
        if (window.api && window.api.updateProfile) {
          await window.api.updateProfile({ avatar: null });
        }
      } catch (_) {}
      this.showToast('Profile picture removed.', 'info');
    });

    document.getElementById('sidebar-user-avatar')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.switchTab('profile');
    });

    // Helper: compress image file to standard avatar dimensions & reasonable base64 size
    const compressImage = (file, maxWidth = 256, maxHeight = 256, quality = 0.82) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (readerEvent) => {
          const img = new Image();
          img.onload = () => {
            let width = img.width;
            let height = img.height;
            if (width > height) {
              if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
              }
            } else {
              if (height > maxHeight) {
                width = Math.round((width * maxHeight) / height);
                height = maxHeight;
              }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', quality));
          };
          img.onerror = reject;
          img.src = readerEvent.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    };

    document.getElementById('profile-avatar-file')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        this.showToast('Please select a valid image file (PNG, JPG, WebP).', 'error');
        e.target.value = '';
        return;
      }

      if (file.size > 8 * 1024 * 1024) {
        this.showToast('Image size must be less than 8MB.', 'error');
        e.target.value = '';
        return;
      }

      try {
        // Compress before storing and backing up
        const compressedData = await compressImage(file, 256, 256, 0.82);
        const storageKey = this.getAvatarStorageKey();
        if (storageKey) {
          localStorage.setItem(storageKey, compressedData);
        }
        if (this.currentUser) {
          this.currentUser.avatar = compressedData;
        }
        this.applyAvatar();

        // Backup avatar with user profile to backend & cloud
        if (window.api && window.api.updateProfile) {
          await window.api.updateProfile({ avatar: compressedData });
        }

        this.showToast('Profile picture compressed and saved!', 'success');
      } catch (err) {
        console.warn('Avatar compression or upload failed:', err);
        this.showToast('Could not process image. Please try another.', 'error');
      } finally {
        e.target.value = '';
      }
    });

    // Navigation buttons
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab) this.switchTab(tab);
      });
    });

    // Any element with data-goto opens its page (profile stat cards, header
    // shortcuts on the revenue page). Keyboard activation mirrors a click.
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-goto]');
      if (!trigger) return;
      const target = trigger.dataset.goto;
      if (target) this.switchTab(target);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const trigger = e.target.closest('[data-goto]');
      if (!trigger) return;
      e.preventDefault();
      this.switchTab(trigger.dataset.goto);
    });

    // Top Bar Quick Actions
    document.getElementById('btn-top-bill')?.addEventListener('click', () => {
      this.switchTab('billing');
    });

    // Quick Action Buttons on Dashboard (matching image reference)
    document.getElementById('btn-quick-customer')?.addEventListener('click', () => {
      this.openAddCustomerModal();
    });
    document.getElementById('btn-quick-bill')?.addEventListener('click', () => {
      this.switchTab('billing');
    });
    document.getElementById('btn-quick-stock')?.addEventListener('click', () => {
      this.openAddInventoryModal();
    });
    document.getElementById('btn-quick-payments')?.addEventListener('click', () => {
      this.switchTab('payments');
    });

    // Customer events
    document.getElementById('btn-add-customer')?.addEventListener('click', () => {
      this.openAddCustomerModal();
    });
    document.getElementById('cust-search')?.addEventListener('input', (e) => {
      this.loadCustomers(e.target.value);
    });
    document.getElementById('form-customer')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleCustomerSubmit();
    });

    // Inventory events
    document.getElementById('btn-add-inventory')?.addEventListener('click', () => {
      this.openAddInventoryModal();
    });
    document.getElementById('inv-search')?.addEventListener('input', (e) => {
      this.loadInventory(e.target.value);
    });
    document.getElementById('form-inventory')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleInventorySubmit();
    });
    document.getElementById('form-stock-adjust')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleStockAdjustSubmit();
    });

    // Billing events & unified item entry
    document.getElementById('btn-add-item')?.addEventListener('click', () => {
      this.addUnifiedItemToBill();
    });
    document.getElementById('bill-labour')?.addEventListener('input', () => this.updateBillCalculations());
    document.getElementById('bill-discount')?.addEventListener('input', () => this.updateBillCalculations());
    document.getElementById('bill-initial-pay')?.addEventListener('input', () => this.updateBillCalculations());
    document.getElementById('btn-bill-reset')?.addEventListener('click', () => this.resetBillForm());
    document.getElementById('btn-bill-submit')?.addEventListener('click', () => this.handleGenerateBill());
    document.getElementById('btn-print-bill')?.addEventListener('click', () => window.api.printInvoice());
    document.getElementById('btn-pdf-bill')?.addEventListener('click', () => window.api.saveInvoicePdf(this.nextInvoiceNo));

    // Payment method toggle (Cash vs Online)
    document.querySelectorAll('input[name="bill-payment-type"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.onPaymentMethodChanged(e.target.value);
      });
    });

    // Enter key progressive navigation
    this.setupEnterKeyNavigation();

    // Payments events
    document.getElementById('pay-search')?.addEventListener('input', () => this.loadPayments());
    document.getElementById('pay-status-filter')?.addEventListener('change', () => this.loadPayments());
    document.getElementById('btn-pay-full-balance')?.addEventListener('click', () => {
      const dueText = document.getElementById('pay-modal-due')?.textContent || '0';
      const due = parseFloat(dueText.replace(/[^\d.]/g, '')) || 0;
      if (due > 0) {
        document.getElementById('pay-amount-input').value = due.toFixed(2);
      }
    });
    document.getElementById('form-record-payment')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleRecordPaymentSubmit();
    });
    document.getElementById('btn-modal-preview-pay-full')?.addEventListener('click', async () => {
      if (this.currentPreviewInvoiceId) {
        this.closeModal('modal-invoice-preview');
        await this.openRecordPayment(this.currentPreviewInvoiceId);
        // Leave amount empty so user can enter partial/full; use "Pay All" to fill due.
        const amountInput = document.getElementById('pay-amount-input');
        if (amountInput) amountInput.value = '';
      }
    });

    // Settings & Backup
    document.getElementById('btn-settings-backup')?.addEventListener('click', () => {
      this.switchTab('settings');
    });
    document.getElementById('btn-trigger-upload-qr')?.addEventListener('click', () => {
      document.getElementById('setting-qr-file')?.click();
    });
    const dropzone = document.getElementById('qr-dropzone');
    dropzone?.addEventListener('click', () => {
      document.getElementById('setting-qr-file')?.click();
    });
    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent-primary)';
      dropzone.style.background = 'var(--accent-primary-subtle)';
    });
    dropzone?.addEventListener('dragleave', () => {
      dropzone.style.borderColor = 'var(--border-subtle)';
      dropzone.style.background = 'transparent';
    });
    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border-subtle)';
      dropzone.style.background = 'transparent';
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        const input = document.getElementById('setting-qr-file');
        // Simulate file input by reading directly
        const reader = new FileReader();
        reader.onload = (ev) => {
          const list = this.getQrCodes();
          if (list.length >= 5) {
            this.showToast('Maximum 5 QR images allowed.', 'error');
            return;
          }
          const nameInput = document.getElementById('setting-qr-name');
          let qrName = nameInput ? nameInput.value.trim() : '';
          if (!qrName) qrName = String(list.length + 1);
          list.push({ id: Date.now(), name: qrName, data: ev.target.result });
          this.saveQrCodes(list);
          this.showToast(`QR "${qrName}" added`, 'success');
          if (nameInput) nameInput.value = '';
          this.renderSettingsQrList();
        };
        reader.readAsDataURL(file);
      }
    });
    document.getElementById('setting-qr-file')?.addEventListener('change', (e) => {
      this.handleQrFileUpload(e);
    });
    document.getElementById('btn-export-backup')?.addEventListener('click', async () => {
      try {
        const res = await window.api.backupDatabase();
        if (res && res.success) {
          const isExcel = (res.path || '').endsWith('.xls') || (res.path || '').endsWith('.xml');
          this.showToast(`Workshop data exported to ${isExcel ? 'Excel' : 'SQLite'} successfully!`, 'success');
        }
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });
    document.getElementById('btn-import-restore')?.addEventListener('click', async () => {
      if (confirm('Restoring will replace current workshop data. Proceed?')) {
        try {
          const res = await window.api.restoreDatabase();
          if (res && res.success) {
            this.showToast('Database restored! Refreshing data...', 'success');
            await this.loadCustomers();
            await this.loadInventory();
            await this.loadInvoices();
            await this.loadPayments();
            await this.loadDashboard();
            this.closeModal('modal-settings');
          } else {
            this.showToast((res && res.message) || 'Restore was cancelled.', 'info');
          }
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      }
    });

    // Software Updates event listeners
    document.getElementById('btn-check-updates')?.addEventListener('click', () => {
      this.handleCheckUpdates();
    });

    document.getElementById('btn-install-update')?.addEventListener('click', () => {
      this.handleInstallUpdate();
    });

    // Cloud Backup & Sync event listeners
    document.getElementById('btn-sync-cloud-data')?.addEventListener('click', () => {
      this.handleSyncCloudData();
    });

    document.getElementById('btn-backup-cloud-now')?.addEventListener('click', () => {
      this.handleBackupCloudNow();
    });

    // Close modal when clicking on the outside overlay backdrop
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('open');
        }
      });
    });

    // Close modal on Escape key press
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const openModal = document.querySelector('.modal-overlay.open');
        if (openModal) {
          openModal.classList.remove('open');
        }
      }
      // Ctrl/Cmd+K opens global search
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const topInput = document.getElementById('global-search-input');
        if (topInput) topInput.focus();
      }
    });

    // Network connectivity changes update status dot
    window.addEventListener('online', () => {
      this.checkDbConnection();
    });
    window.addEventListener('offline', () => {
      this.updateDbConnectionStatus(false);
    });

    // Theme toggle — top-bar toggle switch
    document.getElementById('theme-switch-checkbox')?.addEventListener('change', (e) => {
      this.applyTheme(e.target.checked ? 'dark' : 'light');
    });

    // Theme toggle — login screen toggle switch
    document.getElementById('login-theme-switch-checkbox')?.addEventListener('change', (e) => {
      this.applyTheme(e.target.checked ? 'dark' : 'light');
    });

    // Theme choice buttons in Settings
    document.querySelectorAll('.theme-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.themeChoice;
        if (mode) this.applyTheme(mode);
      });
    });
  },

  // ----------------------------------------------------
  // 1. Dashboard
  // ----------------------------------------------------
  async loadDashboard() {
    try {
      const stats = await window.api.getDashboardStats();
      document.getElementById('stat-revenue').textContent = `Rs. ${stats.todayRevenue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      document.getElementById('stat-outstanding').textContent = `Rs. ${stats.outstandingPayments.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      document.getElementById('stat-customers').textContent = stats.totalCustomers;
      document.getElementById('stat-low-stock').textContent = stats.lowStockCount;

      const tbody = document.getElementById('dash-recent-table-body');
      if (!tbody) return;

      if (!stats.recentPayments || stats.recentPayments.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: 24px;">No recent transactions</td></tr>`;
      } else {
        tbody.innerHTML = stats.recentPayments.map(p => `
          <tr style="cursor: pointer;" onclick="app.showInvoicePreviewModal(${p.invoice_id})" title="Click to view bill">
            <td>
              <span class="table-inv-no">${this.escapeHtml(p.invoice_no)}</span>
            </td>
            <td>
              <div style="font-weight: 600; color: var(--text-main); text-transform: capitalize;">${this.escapeHtml(p.customer_name)}</div>
              <div class="table-entity-sub">${this.formatDateTime(p.payment_date)}</div>
            </td>
            <td style="text-align: right;">
              <strong class="table-num" style="color: var(--text-main);">Rs. ${Number(p.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
            </td>
            <td style="text-align: center;">
              <span class="status-pill success"><span class="status-dot"></span>Paid</span>
            </td>
          </tr>
        `).join('');
      }

      const custBody = document.getElementById('dash-customers-table-body');
      if (custBody) {
        try {
          const customers = await window.api.getCustomers();
          const list = (customers || []).slice(0, 6);
          if (list.length === 0) {
            custBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-dim); padding: 24px;">No customers</td></tr>`;
          } else {
            custBody.innerHTML = list.map(c => {
              const due = Number(c.outstanding_balance || 0);

              return `
                <tr style="cursor: pointer;" onclick="app.viewCustomer(${c.id})" title="Click to view customer">
                  <td>
                    <div style="font-weight: 600; color: var(--text-main); font-size: 13px; text-transform: capitalize;">
                      ${this.escapeHtml(c.name)}
                    </div>
                    ${c.vehicle_model || c.notes ? `<div class="table-entity-sub">${this.escapeHtml(c.vehicle_model || c.notes)}</div>` : ''}
                  </td>
                  <td>
                    <div style="font-size: 12.5px; color: var(--text-secondary);">${this.escapeHtml(c.phone || '--')}</div>
                  </td>
                  <td style="text-align: center;">
                    ${due > 0
                  ? `<span class="status-pill warning"><span class="status-dot"></span>Rs. ${due.toLocaleString('en-IN', { minimumFractionDigits: 0 })}</span>`
                  : `<span class="status-pill success"><span class="status-dot"></span>Clear</span>`
                }
                  </td>
                </tr>
              `;
            }).join('');
          }
        } catch (e) {
          custBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-dim); padding: 24px;">No customers</td></tr>`;
        }
      }

      this.renderSalesChart();
    } catch (err) {
      console.error('Failed to load dashboard:', err);
    }
  },

  async renderSalesChart() {
    const range = this.salesRange || '7d';
    const label = document.getElementById('sales-range-label');
    if (label) {
      if (range === '7d') label.textContent = 'Revenue by day (last 7 days)';
      else if (range === '30d') label.textContent = 'Revenue by day (last 30 days)';
      else label.textContent = 'Revenue by day (this month)';
    }

    try {
      const payments = await window.api.getAllPayments();
      const map = {};
      (payments || []).forEach(p => {
        const d = (p.payment_date || '').slice(0, 10);
        if (!d) return;
        map[d] = (map[d] || 0) + (Number(p.amount) || 0);
      });

      const days = [];
      const today = new Date();
      if (range === 'month') {
        const y = today.getFullYear();
        const m = today.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        for (let d = 1; d <= last; d++) {
          const dt = new Date(y, m, d);
          days.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
        }
      } else {
        const n = range === '30d' ? 30 : 7;
        for (let i = n - 1; i >= 0; i--) {
          const dt = new Date();
          dt.setDate(dt.getDate() - i);
          days.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
        }
      }

      const vals = days.map(d => map[d] || 0);
      const max = Math.max(...vals, 1);
      const W = 700, H = 200, padL = 44, padR = 12, padT = 20, padB = 30;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const stepX = days.length > 1 ? plotW / (days.length - 1) : 0;
      const pts = vals.map((v, i) => {
        const x = padL + i * stepX;
        const y = padT + (1 - (v / (max || 1))) * plotH;
        return { x, y, v, d: days[i] };
      });
      const pathD = pts.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ');
      const areaD = `${pathD} L ${pts[pts.length - 1].x} ${padT + plotH} L ${pts[0].x} ${padT + plotH} Z`;

      const chart = document.getElementById('dash-sales-chart');
      if (chart) {
        chart.innerHTML = `
          <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="overflow: visible;">
            <defs>
              <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--accent-primary)" stop-opacity="0.22"/>
                <stop offset="100%" stop-color="var(--accent-primary)" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--border-subtle)" />
            <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--border-subtle)" />
            <path d="${areaD}" fill="url(#areaGrad)" />
            <path d="${pathD}" fill="none" stroke="var(--accent-primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            ${pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="var(--accent-primary)" stroke="var(--bg-surface)" stroke-width="2" />`).join('')}
            ${pts.filter((p, i) => i === 0 || i === pts.length - 1 || i % Math.ceil(pts.length / 6) === 0).map(p => `<text x="${p.x}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${p.d.slice(5)}</text>`).join('')}
            ${pts.map(p => p.v > 0 ? `<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" font-size="9" font-weight="600" fill="var(--text-main)">Rs.${Math.round(p.v)}</text>` : '').join('')}
          </svg>
        `;
      }
    } catch (e) {
      const chart = document.getElementById('dash-sales-chart');
      if (chart) chart.innerHTML = `<div style="width:100%; text-align:center; color: var(--text-dim); padding-top: 60px;">No sales data yet</div>`;
    }
  },

  // ----------------------------------------------------
  // 2. Customers Section
  // ----------------------------------------------------
  async loadCustomers(search = '') {
    try {
      const customers = await window.api.getCustomers(search);
      this.currentCustomers = customers;
      const tbody = document.getElementById('customers-table-body');
      if (!tbody) return;

      if (customers.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5">
              <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <p>No customers found. Click <strong>+ Add New Customer</strong> to add your first customer record.</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = customers.map(c => {
        const totalPurchases = Number(c.total_purchases || 0);
        const dueAmount = Number(c.outstanding_balance || 0);
        const hasDue = dueAmount > 0;

        return `
          <tr style="cursor: pointer;" onclick="app.viewCustomer(${c.id})" title="Click row to view customer details">
            <td>
              <div style="font-size: 13.5px; font-weight: 600; color: var(--text-main); text-transform: capitalize;">
                ${this.escapeHtml(c.name)}
              </div>
              ${c.notes || c.email ? `<div class="table-entity-sub">${this.escapeHtml(c.notes || c.email)}</div>` : ''}
            </td>
            <td>
              <div style="font-weight: 500; color: var(--text-main); font-size: 13px;">${this.escapeHtml(c.phone || '--')}</div>
              ${c.address ? `<div class="table-entity-sub">${this.escapeHtml(c.address)}</div>` : ''}
            </td>
            <td>
              ${c.vehicle_no
            ? `<div style="font-weight: 600; color: var(--text-main); font-size: 13px;">${this.escapeHtml(c.vehicle_no)}</div>
                   ${c.vehicle_model ? `<div class="table-entity-sub">${this.escapeHtml(c.vehicle_model)}</div>` : ''}`
            : `<span style="color: var(--text-dim);">No vehicle</span>`
          }
            </td>
            <td style="text-align: right;">
              <div class="table-num" style="font-weight: 600; color: var(--text-main); font-size: 13.5px;">
                Rs. ${totalPurchases.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div class="table-entity-sub">${c.total_invoices || 0} bills</div>
            </td>
            <td style="text-align: center;">
              ${hasDue
            ? `<span class="status-pill warning"><span class="status-dot"></span>Rs. ${dueAmount.toLocaleString('en-IN', { minimumFractionDigits: 0 })} Due</span>`
            : `<span class="status-pill success"><span class="status-dot"></span>Clear</span>`
          }
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      this.showToast('Failed to load customers: ' + err.message, 'error');
    }
  },

  openAddCustomerModal() {
    document.getElementById('modal-customer-title').textContent = 'Add Customer';
    document.getElementById('form-customer').reset();
    document.getElementById('cust-form-id').value = '';
    this.openModal('modal-customer');
  },

  async editCustomer(id) {
    const cust = this.currentCustomers.find(c => c.id === id);
    if (!cust) return;

    document.getElementById('modal-customer-title').textContent = 'Edit Customer';
    document.getElementById('cust-form-id').value = cust.id;
    document.getElementById('cust-form-name').value = cust.name;
    document.getElementById('cust-form-phone').value = cust.phone;
    document.getElementById('cust-form-email').value = cust.email || '';
    document.getElementById('cust-form-veh-no').value = cust.vehicle_no || '';
    document.getElementById('cust-form-veh-model').value = cust.vehicle_model || '';
    document.getElementById('cust-form-notes').value = cust.notes || '';

    this.openModal('modal-customer');
  },

  editCustomerFromView() {
    if (!this.activeViewingCustomerId) return;
    const id = this.activeViewingCustomerId;
    this.closeModal('modal-customer-view');
    this.editCustomer(id);
  },

  async deleteCustomerFromView() {
    if (!this.activeViewingCustomerId) return;
    const id = this.activeViewingCustomerId;
    this.closeModal('modal-customer-view');
    await this.deleteCustomer(id);
  },

  async handleCustomerSubmit() {
    const data = {
      id: document.getElementById('cust-form-id').value ? parseInt(document.getElementById('cust-form-id').value) : null,
      name: document.getElementById('cust-form-name').value.trim(),
      phone: document.getElementById('cust-form-phone').value.trim(),
      email: document.getElementById('cust-form-email').value.trim(),
      vehicle_no: document.getElementById('cust-form-veh-no').value.trim(),
      vehicle_model: document.getElementById('cust-form-veh-model').value.trim(),
      notes: document.getElementById('cust-form-notes').value.trim()
    };

    if (!data.name) {
      this.showToast('Please provide a customer name', 'error');
      return;
    }

    try {
      await window.api.saveCustomer(data);
      this.showToast(data.id ? 'Customer updated' : 'Customer added successfully', 'success');
      this.closeModal('modal-customer');
      await this.loadCustomers();
      await this.loadDashboard();
      this.prepareBilling();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async viewCustomer(id) {
    try {
      const details = await window.api.getCustomerById(id);
      if (!details) return;

      this.activeViewingCustomerId = id;

      document.getElementById('cust-view-name').textContent = details.name;
      document.getElementById('cust-view-meta').innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div><strong>Phone:</strong> ${this.escapeHtml(details.phone)}</div>
          <div><strong>Email:</strong> ${this.escapeHtml(details.email || 'N/A')}</div>
          <div><strong>Vehicle:</strong> ${this.escapeHtml(details.vehicle_no || 'N/A')} (${this.escapeHtml(details.vehicle_model || 'N/A')})</div>
          <div><strong>Lifetime Spent:</strong> Rs. ${Number(details.totalSpent || 0).toFixed(2)}</div>
          <div><strong>Outstanding Due:</strong> <span style="color: ${details.outstandingBalance > 0 ? '#DC2626' : '#059669'}; font-weight:600;">Rs. ${Number(details.outstandingBalance || 0).toFixed(2)}</span></div>
        </div>
      `;

      const tbody = document.getElementById('cust-view-invoices-body');
      if (details.invoices.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 20px;">No invoices generated yet</td></tr>`;
      } else {
        tbody.innerHTML = details.invoices.map(inv => {
          const invStatus = (inv.status || 'Unpaid').toLowerCase();
          const pillClass = invStatus === 'paid' ? 'success' : (invStatus === 'partial' ? 'info' : 'warning');

          return `
            <tr style="cursor: pointer;" onclick="app.showInvoicePreviewModal(${inv.id})" title="Click to view invoice preview">
              <td><span class="table-inv-no">${this.escapeHtml(inv.invoice_no)}</span></td>
              <td>${this.formatDateTime(inv.created_at)}</td>
              <td style="text-align: right;"><strong class="table-num">Rs. ${Number(inv.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></td>
              <td style="text-align: right;" class="table-num" style="color: var(--accent-success);">Rs. ${Number(inv.paid_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td style="text-align: right;" class="table-num" style="color: ${(inv.balance_amount || 0) > 0 ? 'var(--accent-danger)' : 'var(--text-muted)'}; font-weight: 600;">Rs. ${Number(inv.balance_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td style="text-align: center;"><span class="status-pill ${pillClass}"><span class="status-dot"></span>${inv.status}</span></td>
            </tr>
          `;
        }).join('');
      }

      this.openModal('modal-customer-view');
    } catch (err) {
      this.showToast('Error loading customer history: ' + err.message, 'error');
    }
  },

  async deleteCustomer(id) {
    if (!confirm('Are you sure you want to delete this customer?')) return;
    try {
      await window.api.deleteCustomer(id);
      this.showToast('Customer deleted', 'success');
      await this.loadCustomers();
      await this.loadDashboard();
      this.prepareBilling();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // ----------------------------------------------------
  // 3. Inventory Section
  // ----------------------------------------------------
  async loadInventory(search = '') {
    try {
      const items = await window.api.getInventory(search);
      this.currentInventory = items;
      const tbody = document.getElementById('inventory-table-body');

      // Update Top Summary Stats (Total Stock, Total Value)
      const totalStock = items.reduce((acc, it) => acc + (Number(it.quantity) || 0), 0);
      const totalVal = items.reduce((acc, it) => acc + ((Number(it.quantity) || 0) * (Number(it.purchase_price) || Number(it.selling_price) || 0)), 0);

      const elStock = document.getElementById('inv-total-stock');
      const elValue = document.getElementById('inv-total-value');
      if (elStock) elStock.textContent = totalStock.toLocaleString();
      if (elValue) elValue.textContent = 'Rs. ' + totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      if (!tbody) return;

      if (items.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5">
              <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <p>No inventory items found. Click <strong>Add Stock Item</strong> to create parts.</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = items.map(item => {
        const qty = Number(item.quantity) || 0;
        const minQty = Number(item.min_quantity) || 5;
        const isLow = qty <= minQty;
        const purchasePrice = Number(item.purchase_price || 0);
        const sellingPrice = Number(item.selling_price || 0);

        return `
          <tr style="cursor: pointer;" onclick="app.editInventory(${item.id})" title="Click row to edit item">
            <td>
              <div style="font-size: 13.5px; font-weight: 600; color: var(--text-main);">
                ${this.escapeHtml(item.name)}
              </div>
              <div class="table-entity-sub">
                ${item.code ? `<span style="font-family: monospace; font-weight: 600; color: var(--accent-primary);">${this.escapeHtml(item.code)}</span> • ` : ''}
                ${item.category ? this.escapeHtml(item.category) : 'General Part'}
              </div>
            </td>
            <td>
              <div style="font-size: 13px; color: var(--text-secondary);">
                ${item.vehicle_compatibility ? this.escapeHtml(item.vehicle_compatibility) : '<span style="color: var(--text-dim);">Universal</span>'}
              </div>
            </td>
            <td style="text-align: center;">
              ${isLow
            ? `<span class="status-pill danger"><span class="status-dot"></span>${qty} Low Stock</span>`
            : `<span class="status-pill success"><span class="status-dot"></span>${qty} In Stock</span>`
          }
            </td>
            <td style="text-align: right;">
              <div class="table-num" style="color: var(--text-muted); font-size: 13px;">Rs. ${purchasePrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </td>
            <td style="text-align: right;">
              <div class="table-num" style="font-weight: 700; color: var(--text-main); font-size: 14px;">Rs. ${sellingPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      this.showToast('Failed to load inventory: ' + err.message, 'error');
    }
  },

  openAddInventoryModal() {
    document.getElementById('modal-inv-title').textContent = 'Add Spare Part';
    document.getElementById('form-inventory').reset();
    document.getElementById('inv-form-id').value = '';
    document.getElementById('inv-form-code').value = '';
    const delBtn = document.getElementById('btn-delete-inv-modal');
    if (delBtn) delBtn.style.display = 'none';
    this.openModal('modal-inventory');
  },

  editInventory(id) {
    const item = this.currentInventory.find(i => i.id === id);
    if (!item) return;

    document.getElementById('modal-inv-title').textContent = 'Edit Spare Part';
    document.getElementById('inv-form-id').value = item.id;
    document.getElementById('inv-form-name').value = item.name;
    document.getElementById('inv-form-code').value = item.code || '';
    document.getElementById('inv-form-qty').value = item.quantity;
    document.getElementById('inv-form-min-qty').value = item.min_quantity;
    document.getElementById('inv-form-purchase').value = item.purchase_price;
    document.getElementById('inv-form-selling').value = item.selling_price;

    const delBtn = document.getElementById('btn-delete-inv-modal');
    if (delBtn) {
      delBtn.style.display = 'inline-flex';
      delBtn.onclick = () => {
        this.closeModal('modal-inventory');
        this.deleteInventory(item.id);
      };
    }

    this.openModal('modal-inventory');
  },

  async handleInventorySubmit() {
    const existingCode = document.getElementById('inv-form-code').value.trim();
    // Auto-generate code if none exists so SQLite unique constraint is satisfied seamlessly
    const autoCode = existingCode || ('PART-' + Date.now().toString(36).toUpperCase());

    const data = {
      id: document.getElementById('inv-form-id').value ? parseInt(document.getElementById('inv-form-id').value) : null,
      code: autoCode,
      category: document.getElementById('inv-form-category').value.trim(),
      name: document.getElementById('inv-form-name').value.trim(),
      quantity: parseInt(document.getElementById('inv-form-qty').value) || 0,
      min_quantity: parseInt(document.getElementById('inv-form-min-qty').value) || 5,
      purchase_price: parseFloat(document.getElementById('inv-form-purchase').value) || 0,
      selling_price: parseFloat(document.getElementById('inv-form-selling').value) || 0,
      location: document.getElementById('inv-form-location').value.trim()
    };

    if (!data.name) {
      this.showToast('Please enter part name', 'error');
      return;
    }

    try {
      await window.api.saveInventoryItem(data);
      this.showToast(data.id ? 'Part updated' : 'Part added to inventory', 'success');
      this.closeModal('modal-inventory');
      await this.loadInventory();
      await this.loadDashboard();
      this.prepareBilling();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  openStockAdjust(id) {
    const item = this.currentInventory.find(i => i.id === id);
    if (!item) return;

    document.getElementById('adjust-part-id').value = item.id;
    document.getElementById('adjust-part-name').textContent = `${item.name} (${item.code})`;
    document.getElementById('adjust-current-stock').textContent = `${item.quantity} units`;
    document.getElementById('adjust-delta').value = '';
    this.openModal('modal-stock-adjust');
  },

  async handleStockAdjustSubmit() {
    const id = parseInt(document.getElementById('adjust-part-id').value);
    const delta = parseInt(document.getElementById('adjust-delta').value);
    if (isNaN(delta) || delta === 0) {
      this.showToast('Please enter a valid stock difference', 'error');
      return;
    }

    try {
      await window.api.adjustStock(id, delta);
      this.showToast('Stock adjusted successfully', 'success');
      this.closeModal('modal-stock-adjust');
      await this.loadInventory();
      await this.loadDashboard();
      this.prepareBilling();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async deleteInventory(id) {
    if (!confirm('Are you sure you want to delete this inventory item?')) return;
    try {
      await window.api.deleteInventoryItem(id);
      this.showToast('Inventory item deleted', 'success');
      await this.loadInventory();
      await this.loadDashboard();
      this.prepareBilling();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // ----------------------------------------------------
  // 4. Billing & Invoicing Section
  // ----------------------------------------------------
  // ----------------------------------------------------
  // 4. Billing & Invoicing Section
  // ----------------------------------------------------
  async prepareBilling() {
    this.applyBranding();
    // 1. Fetch next invoice number
    try {
      this.nextInvoiceNo = await window.api.getNextInvoiceNumber();
      document.getElementById('bill-inv-number').textContent = this.nextInvoiceNo;
      document.getElementById('prev-inv-num').textContent = this.nextInvoiceNo;
      document.getElementById('prev-inv-date').textContent = `Date: ${new Date().toISOString().slice(0, 10)}`;
    } catch (e) {
      console.warn('Could not fetch next invoice no:', e);
    }

    // 2. Fetch customers and inventory records
    try {
      this.currentCustomers = await window.api.getCustomers();
      this.currentInventory = await window.api.getInventory();
    } catch (e) { }

    this.setupCustomerCombobox();
    this.setupUnifiedCombobox();
    this.renderBillItems();
    this.updateBillCalculations();
  },

  setupCustomerCombobox() {
    const input = document.getElementById('bill-customer-input');
    const idInput = document.getElementById('bill-customer-id');
    const dropdown = document.getElementById('cust-combobox-dropdown');
    if (!input || !dropdown) return;

    const renderList = (filter = '') => {
      const q = filter.trim().toLowerCase();
      const matched = this.currentCustomers.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        (c.vehicle_no && c.vehicle_no.toLowerCase().includes(q))
      );

      let html = '';
      if (matched.length > 0) {
        html = matched.map(c => `
          <div class="combobox-item" data-id="${Number(c.id) || 0}" data-name="${this.escapeHtml(c.name)}" data-phone="${this.escapeHtml(c.phone)}" data-veh="${this.escapeHtml([c.vehicle_no, c.vehicle_model].filter(Boolean).join(' - '))}">
            <div>
              <div class="combobox-item-primary">${this.escapeHtml(c.name)}</div>
              <div class="combobox-item-sub">${this.escapeHtml(c.phone)} ${c.vehicle_no ? '• ' + this.escapeHtml(c.vehicle_no) : ''}</div>
            </div>
            ${c.outstanding_balance > 0 ? `<span class="badge badge-unpaid" style="font-size:10px;">Due: Rs. ${Number(c.outstanding_balance || 0).toFixed(0)}</span>` : ''}
          </div>
        `).join('');
      }

      if (q.length > 0) {
        html += `
          <div class="combobox-hint">
            ${matched.length ? 'Press Enter to use the first match, or leave the name as entered.' : 'This customer will be added when you generate the invoice.'}
          </div>
        `;
      } else if (matched.length === 0) {
        html = `<div style="padding:14px; text-align:center; color:var(--text-muted); font-size:12px;">Type to search or add customer...</div>`;
      }

      dropdown.innerHTML = html;
      dropdown.classList.add('open');

      // Bind selection clicks
      dropdown.querySelectorAll('.combobox-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.id;
          const name = item.dataset.name;
          const phone = item.dataset.phone;
          const veh = item.dataset.veh;

          input.value = name;
          idInput.value = id;
          this.onBillCustomerChanged(id);
          dropdown.classList.remove('open');
          // Focus to next field: item input
          document.getElementById('bill-unified-input')?.focus();
        });
      });

    };

    input.onfocus = () => renderList(input.value);
    input.oninput = (e) => {
      idInput.value = ''; // Reset selected ID on typing until chosen
      this.onBillCustomerChanged('');
      document.getElementById('prev-cust-name').textContent = input.value.trim() || '--';
      renderList(e.target.value);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const firstMatch = !idInput.value && dropdown.querySelector('.combobox-item');
        if (firstMatch) {
          firstMatch.click();
          return;
        }
        dropdown.classList.remove('open');
        document.getElementById('bill-unified-input')?.focus();
      }
    };

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });
  },

  setupUnifiedCombobox() {
    const input = document.getElementById('bill-unified-input');
    const idInput = document.getElementById('bill-unified-id');
    const typeInput = document.getElementById('bill-unified-type');
    const rateInput = document.getElementById('bill-unified-rate');
    const dropdown = document.getElementById('unified-combobox-dropdown');
    if (!input || !dropdown) return;

    const renderList = (filter = '') => {
      const q = filter.trim().toLowerCase();
      const matched = this.currentInventory.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        (p.category && p.category.toLowerCase().includes(q))
      );

      let html = '';
      if (matched.length > 0) {
        html = matched.map(p => `
          <div class="combobox-item" data-id="${Number(p.id) || 0}" data-name="${this.escapeHtml(p.name)}" data-price="${Number(p.selling_price) || 0}" data-stock="${Number(p.quantity) || 0}">
            <span style="font-weight: 500; font-size: 13.5px; color: var(--text-main);">${this.escapeHtml(p.name)}</span>
          </div>
        `).join('');
      }

      if (q.length > 0) {
        html += `
          <div class="combobox-hint">
            ${matched.length ? 'Click a stock match, or press Enter to use your description as a custom item or service.' : 'Press Enter to use this description as a custom item or service.'}
          </div>
        `;
      } else if (matched.length === 0) {
        html = `<div style="padding:14px; text-align:center; color:var(--text-muted); font-size:12px;">Type to search stock part or write custom service...</div>`;
      }

      dropdown.innerHTML = html;
      dropdown.classList.add('open');

      // Bind item click (stock item)
      dropdown.querySelectorAll('.combobox-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.id;
          const name = item.dataset.name;
          const price = item.dataset.price;
          input.value = name;
          idInput.value = id;
          typeInput.value = 'part';
          if (rateInput) rateInput.value = price;
          dropdown.classList.remove('open');
          document.getElementById('bill-unified-qty')?.focus();
        });
      });

    };

    input.onfocus = () => renderList(input.value);
    input.oninput = (e) => {
      idInput.value = '';
      typeInput.value = 'custom';
      renderList(e.target.value);
    };

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });
  },

  onBillCustomerChanged(customerId) {
    if (!customerId) {
      document.getElementById('prev-cust-name').textContent = '--';
      document.getElementById('prev-cust-phone').textContent = '--';
      document.getElementById('prev-cust-veh').textContent = '--';
      return;
    }

    const cust = this.currentCustomers.find(c => c.id === parseInt(customerId));
    if (cust) {
      const veh = [cust.vehicle_no, cust.vehicle_model].filter(Boolean).join(' - ');
      document.getElementById('prev-cust-name').textContent = cust.name;
      document.getElementById('prev-cust-phone').textContent = cust.phone;
      document.getElementById('prev-cust-veh').textContent = veh || 'Walk-in / None';
    }
  },

  addUnifiedItemToBill(forcedType) {
    const input = document.getElementById('bill-unified-input');
    const idInput = document.getElementById('bill-unified-id');
    const qtyInput = document.getElementById('bill-unified-qty');
    const rateInput = document.getElementById('bill-unified-rate');

    const desc = input.value.trim();
    const qty = parseInt(qtyInput.value) || 1;
    let rate = parseFloat(rateInput.value) || 0;
    const partId = idInput.value ? parseInt(idInput.value) : null;

    if (!desc) {
      this.showToast('Please type part name or service description', 'error');
      input.focus();
      return;
    }

    // If forcedType === 'part' and item is selected from inventory
    if (partId && (forcedType === 'part' || !forcedType)) {
      const part = this.currentInventory.find(p => p.id === partId);
      if (part) {
        if (qty > part.quantity) {
          this.showToast(`Cannot add ${qty} units. Only ${part.quantity} in stock.`, 'error');
          return;
        }

        const existing = this.billItems.find(item => item.inventoryId === part.id);
        if (existing) {
          if (existing.quantity + qty > part.quantity) {
            this.showToast(`Total quantity exceeds stock of ${part.quantity}`, 'error');
            return;
          }
          existing.quantity += qty;
          existing.unitPrice = rate || part.selling_price;
          existing.totalPrice = existing.quantity * existing.unitPrice;
        } else {
          this.billItems.push({
            inventoryId: part.id,
            itemCode: part.code,
            description: part.name,
            quantity: qty,
            unitPrice: rate || part.selling_price,
            totalPrice: qty * (rate || part.selling_price)
          });
        }

        input.value = '';
        idInput.value = '';
        qtyInput.value = '1';
        rateInput.value = '';
        this.renderBillItems();
        this.updateBillCalculations();
        document.getElementById('bill-labour')?.focus();
        return;
      }
    }

    // Custom Item or Service
    if (rate <= 0) {
      this.showToast('Please enter a valid rate/price for the item or service', 'error');
      rateInput.focus();
      return;
    }

    this.billItems.push({
      inventoryId: null,
      itemCode: forcedType === 'service' ? 'SERVICE' : 'CUSTOM',
      description: desc,
      quantity: qty,
      unitPrice: rate,
      totalPrice: qty * rate
    });

    input.value = '';
    idInput.value = '';
    qtyInput.value = '1';
    rateInput.value = '';
    this.renderBillItems();
    this.updateBillCalculations();
    document.getElementById('bill-labour')?.focus();
  },

  onPaymentMethodChanged(method) {
    const cashOpt = document.getElementById('pay-opt-cash');
    const onlineOpt = document.getElementById('pay-opt-online');

    if (method === 'Cash') {
      cashOpt?.classList.add('active');
      onlineOpt?.classList.remove('active');
      const radio = document.querySelector('input[name="bill-payment-type"][value="Cash"]');
      if (radio) radio.checked = true;
    } else if (method === 'Online') {
      onlineOpt?.classList.add('active');
      cashOpt?.classList.remove('active');
      const radio = document.querySelector('input[name="bill-payment-type"][value="Online"]');
      if (radio) radio.checked = true;

      // Calculate current total and display in QR modal
      const subtotal = this.billItems.reduce((sum, item) => sum + item.totalPrice, 0);
      const labour = parseFloat(document.getElementById('bill-labour')?.value) || 0;
      const discount = parseFloat(document.getElementById('bill-discount')?.value) || 0;
      const initialPayment = parseFloat(document.getElementById('bill-initial-pay')?.value) || 0;
      const totalPayable = Math.max(0, subtotal + labour - discount);
      const amountToPay = initialPayment > 0 ? initialPayment : totalPayable;

      document.getElementById('qr-modal-amount').textContent = `Rs. ${amountToPay.toFixed(2)}`;

      // Render QR code switcher buttons if uploaded QRs exist
      const qrList = this.getQrCodes();
      const switcher = document.getElementById('qr-modal-switcher');
      const img = document.getElementById('qr-code-img');
      const svg = document.getElementById('qr-code-svg');
      const instruction = document.getElementById('qr-modal-instruction');

      if (switcher) {
        if (qrList.length > 0) {
          switcher.innerHTML = qrList.map((q, idx) => `
            <button type="button" class="btn btn-sm qr-switch-btn ${idx === 0 ? 'active' : ''}" 
                    data-id="${Number(q.id) || 0}" onclick="app.selectQrCode(${Number(q.id) || 0})"
                    style="padding: 4px 12px; font-size: 12px;">
              ${this.escapeHtml(q.name)}
            </button>
          `).join('');
          switcher.style.display = 'flex';

          // Select first QR by default
          this.selectQrCode(qrList[0].id);
        } else {
          switcher.innerHTML = '';
          switcher.style.display = 'none';
          if (img) img.style.display = 'none';
          if (svg) svg.style.display = 'block';
          if (instruction) instruction.textContent = 'Scan using Fonepay / eSewa / Khalti / ConnectIPS / Mobile Banking';
        }
      }

      this.openModal('modal-online-qr');
    }
  },

  confirmOnlinePayment() {
    this.closeModal('modal-online-qr');
    // If initial payment field is empty or 0, set it to total payable
    const initialPayInput = document.getElementById('bill-initial-pay');
    const subtotal = this.billItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const labour = parseFloat(document.getElementById('bill-labour')?.value) || 0;
    const discount = parseFloat(document.getElementById('bill-discount')?.value) || 0;
    const totalPayable = Math.max(0, subtotal + labour - discount);

    if (initialPayInput && (parseFloat(initialPayInput.value) <= 0 || !initialPayInput.value)) {
      initialPayInput.value = totalPayable.toFixed(2);
    }
    this.updateBillCalculations();
    this.showToast('Online QR payment confirmed!', 'success');
    document.getElementById('bill-notes')?.focus();
  },

  cancelOnlinePayment() {
    this.closeModal('modal-online-qr');
    // Revert to Cash option
    this.onPaymentMethodChanged('Cash');
  },

  setupEnterKeyNavigation() {
    // Flow: Customer -> Item -> Qty -> Rate -> Labour Charge -> Discount -> Initial Pay -> Remarks -> Generate Invoice
    const fieldSequence = [
      { id: 'bill-customer-input', next: 'bill-unified-input' },
      {
        id: 'bill-unified-input',
        action: () => {
          document.getElementById('unified-combobox-dropdown')?.classList.remove('open');
          document.getElementById('bill-unified-qty')?.focus();
        }
      },
      { id: 'bill-unified-qty', next: 'bill-unified-rate' },
      {
        id: 'bill-unified-rate',
        action: () => {
          // If item is filled, add it; otherwise advance to labour
          const desc = document.getElementById('bill-unified-input')?.value.trim();
          if (desc) {
            this.addUnifiedItemToBill();
          } else {
            document.getElementById('bill-labour')?.focus();
          }
        }
      },
      { id: 'bill-labour', next: 'bill-discount' },
      { id: 'bill-discount', next: 'bill-initial-pay' },
      { id: 'bill-initial-pay', next: 'bill-notes' },
      { id: 'bill-notes', next: 'btn-bill-submit' }
    ];

    fieldSequence.forEach(item => {
      const el = document.getElementById(item.id);
      if (!el) return;

      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (item.action) {
            item.action();
          } else if (item.next) {
            const nextEl = document.getElementById(item.next);
            if (nextEl) {
              nextEl.focus();
              if (nextEl.select) nextEl.select();
            }
          }
        }
      });
    });
  },

  removeBillItem(index) {
    this.billItems.splice(index, 1);
    this.renderBillItems();
    this.updateBillCalculations();
  },

  renderBillItems() {
    const tbody = document.getElementById('bill-items-body');
    const prevTbody = document.getElementById('prev-items-list');

    if (this.billItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:16px;">No items added yet. Type part name or service above to add.</td></tr>`;
      prevTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #94A3B8; padding: 20px 0;">No items added yet</td></tr>`;
      return;
    }

    tbody.innerHTML = this.billItems.map((item, idx) => `
      <tr>
        <td>
          <strong>${this.escapeHtml(item.description)}</strong>
          ${item.itemCode !== 'CUSTOM' ? `<div style="font-size:11px; color:var(--text-muted);">${this.escapeHtml(item.itemCode)}</div>` : ''}
        </td>
        <td style="text-align: center;">${Number(item.quantity) || 0}</td>
        <td style="text-align: right;">Rs. ${Number(item.unitPrice || 0).toFixed(2)}</td>
        <td style="text-align: right;"><strong>Rs. ${Number(item.totalPrice || 0).toFixed(2)}</strong></td>
        <td style="text-align: center;">
          <button class="btn btn-sm btn-danger-ghost" style="padding:2px 6px;" onclick="app.removeBillItem(${idx})">&times;</button>
        </td>
      </tr>
    `).join('');

    prevTbody.innerHTML = this.billItems.map(item => `
      <tr>
        <td>${this.escapeHtml(item.description)}</td>
        <td style="text-align: center;">${Number(item.quantity) || 0}</td>
        <td style="text-align: right;">Rs. ${Number(item.unitPrice || 0).toFixed(2)}</td>
        <td style="text-align: right;">Rs. ${Number(item.totalPrice || 0).toFixed(2)}</td>
      </tr>
    `).join('');
  },

  updateBillCalculations() {
    const subtotal = this.billItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const labour = parseFloat(document.getElementById('bill-labour')?.value) || 0;
    const discount = parseFloat(document.getElementById('bill-discount')?.value) || 0;
    const initialPayment = parseFloat(document.getElementById('bill-initial-pay')?.value) || 0;

    const totalPayable = Math.max(0, subtotal + labour - discount);
    const balanceDue = Math.max(0, totalPayable - initialPayment);

    // Update preview
    document.getElementById('prev-subtotal').textContent = `Rs. ${subtotal.toFixed(2)}`;
    document.getElementById('prev-labour').textContent = `Rs. ${labour.toFixed(2)}`;
    document.getElementById('prev-discount').textContent = `-Rs. ${discount.toFixed(2)}`;
    document.getElementById('prev-discount-row').style.display = discount > 0 ? 'flex' : 'none';
    document.getElementById('prev-total').textContent = `Rs. ${totalPayable.toFixed(2)}`;
    document.getElementById('prev-paid').textContent = `Rs. ${initialPayment.toFixed(2)}`;
    document.getElementById('prev-balance').textContent = `Rs. ${balanceDue.toFixed(2)}`;

    let statusText = 'Unpaid';
    if (balanceDue <= 0.001 && totalPayable > 0) statusText = 'Paid';
    else if (initialPayment > 0) statusText = 'Partial';
    document.getElementById('prev-inv-status').textContent = `Status: ${statusText}`;
  },

  resetBillForm() {
    this.billItems = [];
    const custInput = document.getElementById('bill-customer-input');
    const custId = document.getElementById('bill-customer-id');
    const partInput = document.getElementById('bill-unified-input');
    const partId = document.getElementById('bill-unified-id');

    if (custInput) custInput.value = '';
    if (custId) custId.value = '';
    if (partInput) partInput.value = '';
    if (partId) partId.value = '';

    document.getElementById('bill-unified-qty').value = '1';
    document.getElementById('bill-unified-rate').value = '';
    document.getElementById('bill-labour').value = '';
    document.getElementById('bill-discount').value = '';
    document.getElementById('bill-initial-pay').value = '';
    document.getElementById('bill-notes').value = '';
    this.onPaymentMethodChanged('Cash');
    this.onBillCustomerChanged('');
    this.renderBillItems();
    this.updateBillCalculations();
  },

  async handleGenerateBill() {
    const customerInput = document.getElementById('bill-customer-input');
    const customerName = customerInput?.value.trim();
    let customerId = parseInt(document.getElementById('bill-customer-id')?.value);
    if (!customerName) {
      this.showToast('Please enter a customer name', 'error');
      document.getElementById('bill-customer-input')?.focus();
      return;
    }

    if (this.billItems.length === 0) {
      const labour = parseFloat(document.getElementById('bill-labour').value) || 0;
      if (labour <= 0) {
        this.showToast('Please add at least one item or service to create a bill', 'error');
        document.getElementById('bill-unified-input')?.focus();
        return;
      }
    }

    const subtotal = this.billItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const labour = parseFloat(document.getElementById('bill-labour').value) || 0;
    const discount = parseFloat(document.getElementById('bill-discount').value) || 0;
    const initialPayment = parseFloat(document.getElementById('bill-initial-pay').value) || 0;
    const totalAmount = Math.max(0, subtotal + labour - discount);

    if (initialPayment > totalAmount) {
      this.showToast('Initial payment cannot be greater than total payable', 'error');
      return;
    }

    const paymentMethodRadio = document.querySelector('input[name="bill-payment-type"]:checked');
    const paymentMethod = paymentMethodRadio ? paymentMethodRadio.value : 'Cash';

    const billData = {
      customerId,
      invoiceNo: this.nextInvoiceNo,
      vehicleDetails: '',
      items: this.billItems,
      subtotal,
      labourCharges: labour,
      discount,
      totalAmount,
      initialPayment,
      paymentMethod,
      notes: document.getElementById('bill-notes').value.trim()
    };

    // Prevent double submission
    const submitBtn = document.getElementById('btn-bill-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Generating...';

    try {
      if (!customerId) {
        const existingCustomer = this.currentCustomers.find(
          customer => customer.name.trim().toLowerCase() === customerName.toLowerCase()
        );
        if (existingCustomer) {
          customerId = existingCustomer.id;
        } else {
          const savedCustomer = await window.api.saveCustomer({
            name: customerName,
            phone: '',
            email: '',
            vehicle_no: '',
            vehicle_model: '',
            notes: ''
          });
          customerId = savedCustomer.id;
        }
      }

      billData.customerId = customerId;
      const res = await window.api.createInvoice(billData);
      this.showToast(`Invoice ${res.invoiceNo} generated successfully!`, 'success');
      this.resetBillForm();
      await this.prepareBilling();
      await this.loadDashboard();
      await this.loadInventory(); // updated stock counts
      this.switchTab('payments');
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Generate Invoice';
    }
  },

  // ----------------------------------------------------
  // 5. Payments Section
  // ----------------------------------------------------
  async loadPayments() {
    const search = document.getElementById('pay-search')?.value || '';
    const status = document.getElementById('pay-status-filter')?.value || 'All';

    try {
      const invoices = await window.api.getInvoices({ search, status });
      const tbody = document.getElementById('invoices-table-body');
      if (!tbody) return;

      if (invoices.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5">
              <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <p>No invoices matching your criteria. Click <strong>Create New Invoice</strong> to start billing.</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = invoices.map(inv => {
        const totalAmount = Number(inv.total_amount || 0);
        const paidAmount = Number(inv.paid_amount || 0);
        const dueAmount = Number(inv.balance_amount || 0);
        const isDue = dueAmount > 0;
        const invStatus = (inv.status || (isDue ? (paidAmount > 0 ? 'Partial' : 'Unpaid') : 'Paid'));

        let statusPill = '';
        if (invStatus === 'Paid') {
          statusPill = `<span class="status-pill success"><span class="status-dot"></span>Paid</span>`;
        } else if (invStatus === 'Partial') {
          statusPill = `<span class="status-pill info"><span class="status-dot"></span>Partial</span>`;
        } else {
          statusPill = `<span class="status-pill warning"><span class="status-dot"></span>Pending</span>`;
        }

        return `
          <tr style="cursor: pointer;" onclick="app.showInvoicePreviewModal(${inv.id})" title="Click row to preview invoice">
            <td>
              <div class="table-inv-no">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                ${this.escapeHtml(inv.invoice_no)}
              </div>
              <div class="table-entity-sub" style="margin-top: 3px;">
                ${this.formatDateTime(inv.created_at)}
              </div>
            </td>
            <td>
              <div style="font-weight: 600; color: var(--text-main); font-size: 13.5px; text-transform: capitalize;">
                ${this.escapeHtml(inv.customer_name || 'Walk-in Customer')}
              </div>
              <div class="table-entity-sub">
                ${inv.vehicle_no ? `<strong>${this.escapeHtml(inv.vehicle_no)}</strong>` : ''}
                ${inv.customer_phone ? (inv.vehicle_no ? ' • ' : '') + this.escapeHtml(inv.customer_phone) : ''}
              </div>
            </td>
            <td style="text-align: center;">
              ${statusPill}
            </td>
            <td style="text-align: right;">
              <div class="table-num" style="font-weight: 700; color: var(--text-main); font-size: 14px;">
                Rs. ${totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div class="table-entity-sub">Paid: Rs. ${paidAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </td>
            <td style="text-align: right;">
              ${isDue
            ? `<div class="table-num" style="font-weight: 700; color: var(--accent-danger); font-size: 14px;">Rs. ${dueAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                   <div class="table-entity-sub" style="color: var(--accent-danger);">Balance Due</div>`
            : `<div class="table-num" style="font-weight: 600; color: var(--accent-success); font-size: 13.5px;">Rs. 0.00</div>
                   <div class="table-entity-sub" style="color: var(--accent-success);">Settled</div>`
          }
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      this.showToast('Failed to load payments: ' + err.message, 'error');
    }
  },

  async openRecordPayment(invoiceId) {
    try {
      const inv = await window.api.getInvoiceDetails(invoiceId);
      if (!inv) return;

      document.getElementById('pay-invoice-id').value = inv.id;
      document.getElementById('pay-modal-inv-no').textContent = inv.invoice_no;
      document.getElementById('pay-modal-cust-name').textContent = inv.customer_name;
      document.getElementById('pay-modal-total').textContent = `Rs. ${inv.total_amount.toFixed(2)}`;
      document.getElementById('pay-modal-paid').textContent = `Rs. ${inv.paid_amount.toFixed(2)}`;
      document.getElementById('pay-modal-due').textContent = `Rs. ${inv.balance_amount.toFixed(2)}`;

      document.getElementById('pay-amount-input').value = inv.balance_amount.toFixed(2);
      document.getElementById('pay-amount-input').max = inv.balance_amount;
      document.getElementById('pay-ref-input').value = '';
      document.getElementById('pay-notes-input').value = '';

      this.openModal('modal-record-payment');
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async handleRecordPaymentSubmit() {
    const invoiceId = parseInt(document.getElementById('pay-invoice-id').value);
    const amount = parseFloat(document.getElementById('pay-amount-input').value);
    const paymentMethod = document.getElementById('pay-method-select').value;
    const referenceNo = document.getElementById('pay-ref-input').value.trim();
    const notes = document.getElementById('pay-notes-input').value.trim();

    if (isNaN(amount) || amount <= 0) {
      this.showToast('Please enter a valid payment amount', 'error');
      return;
    }

    try {
      await window.api.recordPayment({
        invoiceId,
        amount,
        paymentMethod,
        referenceNo,
        notes
      });

      this.showToast('Payment recorded successfully', 'success');
      this.closeModal('modal-record-payment');
      await this.loadPayments();
      await this.loadDashboard();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async viewInvoiceDetails(invoiceId) {
    try {
      const inv = await window.api.getInvoiceDetails(invoiceId);
      if (!inv) return;

      // Render to the preview panel on Billing tab and switch
      this.switchTab('billing');
      this.applyBranding();

      document.getElementById('prev-inv-num').textContent = inv.invoice_no;
      document.getElementById('prev-inv-date').textContent = `Date: ${inv.created_at.slice(0, 10)}`;
      document.getElementById('prev-inv-status').textContent = `Status: ${inv.status}`;
      document.getElementById('prev-cust-name').textContent = inv.customer_name;
      document.getElementById('prev-cust-phone').textContent = inv.customer_phone || '--';
      document.getElementById('prev-cust-veh').textContent = [inv.vehicle_no, inv.vehicle_model].filter(Boolean).join(' - ') || '--';

      const prevTbody = document.getElementById('prev-items-list');
      const items = inv.items || [];
      if (items.length === 0) {
        prevTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #94A3B8; padding: 20px 0;">No items found</td></tr>`;
      } else {
        prevTbody.innerHTML = items.map(item => {
          const qty = item.quantity || 1;
          const rate = item.unit_price != null ? item.unit_price : (item.unitPrice != null ? item.unitPrice : 0);
          const total = item.total_price != null ? item.total_price : (item.totalPrice != null ? item.totalPrice : (qty * rate));
          return `
            <tr>
              <td>${this.escapeHtml(item.description || 'Item')}</td>
              <td style="text-align: center;">${qty}</td>
              <td style="text-align: right;">Rs. ${Number(rate).toFixed(2)}</td>
              <td style="text-align: right;">Rs. ${Number(total).toFixed(2)}</td>
            </tr>
          `;
        }).join('');
      }

      document.getElementById('prev-subtotal').textContent = `Rs. ${Number(inv.subtotal || 0).toFixed(2)}`;
      document.getElementById('prev-labour').textContent = `Rs. ${Number(inv.labour_charges || 0).toFixed(2)}`;
      document.getElementById('prev-discount').textContent = `-Rs. ${Number(inv.discount || 0).toFixed(2)}`;
      document.getElementById('prev-discount-row').style.display = (inv.discount || 0) > 0 ? 'flex' : 'none';
      document.getElementById('prev-total').textContent = `Rs. ${Number(inv.total_amount || 0).toFixed(2)}`;
      document.getElementById('prev-paid').textContent = `Rs. ${Number(inv.paid_amount || 0).toFixed(2)}`;
      document.getElementById('prev-balance').textContent = `Rs. ${Number(inv.balance_amount || 0).toFixed(2)}`;
    } catch (err) {
      this.showToast('Error loading invoice: ' + err.message, 'error');
    }
  },

  // Print the invoice that is actually open in the preview modal. Without the
  // temporary body class the print stylesheet would only show the billing tab,
  // which can be a different (or empty) invoice.
  printInvoiceModal() {
    const modal = document.getElementById('modal-invoice-preview');
    if (!modal) return;

    const cleanup = () => {
      document.body.classList.remove('print-modal-invoice');
      window.removeEventListener('afterprint', cleanup);
    };

    document.body.classList.add('print-modal-invoice');
    window.addEventListener('afterprint', cleanup);
    try {
      window.print();
    } finally {
      // afterprint is not fired by every platform; the class only affects
      // print media, so leaving it until the next print is harmless.
      setTimeout(cleanup, 30000);
    }
  },

  async showInvoicePreviewModal(invoiceId) {
    try {
      this.applyBranding();
      const inv = await window.api.getInvoiceDetails(invoiceId);
      if (!inv) return;

      document.getElementById('modal-inv-num').textContent = inv.invoice_no || '--';
      document.getElementById('modal-inv-date').textContent = `Date: ${(inv.created_at || '').slice(0, 10)}`;
      document.getElementById('modal-inv-status').textContent = `Status: ${inv.status || 'Unpaid'}`;
      document.getElementById('modal-inv-cust-name').textContent = inv.customer_name || (inv.customer ? inv.customer.name : '--');
      document.getElementById('modal-inv-cust-phone').textContent = inv.customer_phone || (inv.customer ? inv.customer.phone : '--');

      const tbody = document.getElementById('modal-inv-items-body');
      const items = inv.items || [];
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #94A3B8; padding: 20px 0;">No items found</td></tr>`;
      } else {
        tbody.innerHTML = items.map(item => {
          const qty = item.quantity || 1;
          const rate = item.unit_price != null ? item.unit_price : (item.unitPrice != null ? item.unitPrice : 0);
          const total = item.total_price != null ? item.total_price : (item.totalPrice != null ? item.totalPrice : (qty * rate));
          return `
            <tr>
              <td>${this.escapeHtml(item.description || 'Item')}</td>
              <td style="text-align: center;">${qty}</td>
              <td style="text-align: right;">Rs. ${Number(rate).toFixed(2)}</td>
              <td style="text-align: right;">Rs. ${Number(total).toFixed(2)}</td>
            </tr>
          `;
        }).join('');
      }

      document.getElementById('modal-inv-subtotal').textContent = `Rs. ${Number(inv.subtotal || 0).toFixed(2)}`;
      document.getElementById('modal-inv-labour').textContent = `Rs. ${Number(inv.labour_charges || 0).toFixed(2)}`;
      document.getElementById('modal-inv-discount').textContent = `-Rs. ${Number(inv.discount || 0).toFixed(2)}`;
      document.getElementById('modal-inv-total').textContent = `Rs. ${Number(inv.total_amount || 0).toFixed(2)}`;
      document.getElementById('modal-inv-paid').textContent = `Rs. ${Number(inv.paid_amount || 0).toFixed(2)}`;
      this.currentPreviewInvoiceId = inv.id;
      const due = Number(inv.balance_amount || 0);
      document.getElementById('modal-inv-balance').textContent = `Rs. ${due.toFixed(2)}`;

      const payFullBtn = document.getElementById('btn-modal-preview-pay-full');
      if (payFullBtn) {
        if (due > 0.001) {
          payFullBtn.style.display = 'inline-flex';
          payFullBtn.textContent = 'Pay due';
        } else {
          payFullBtn.style.display = 'none';
        }
      }

      this.openModal('modal-invoice-preview');
    } catch (err) {
      this.showToast('Error loading invoice: ' + err.message, 'error');
    }
  },

  // ----------------------------------------------------
  // QR Codes Management (Up to 5 images, strictly tenant-scoped and local)
  // ----------------------------------------------------
  getQrStorageKey() {
    const tenant = (this.currentUser && this.currentUser.tenant) ? this.currentUser.tenant.toLowerCase().trim() : 'default';
    return `garage_qr_codes_${tenant}`;
  },

  getQrCodes() {
    try {
      const key = this.getQrStorageKey();
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  },

  saveQrCodes(list) {
    try {
      const key = this.getQrStorageKey();
      localStorage.setItem(key, JSON.stringify(list));
    } catch (e) {
      this.showToast('Failed to save QR code storage: ' + e.message, 'error');
    }
  },

  handleQrFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      this.showToast('Please choose an image file for the QR code.', 'error');
      e.target.value = '';
      return;
    }

    const list = this.getQrCodes();
    if (list.length >= 5) {
      this.showToast('Maximum 5 QR images allowed. Please delete one first.', 'error');
      e.target.value = '';
      return;
    }

    const nameInput = document.getElementById('setting-qr-name');
    let qrName = nameInput ? nameInput.value.trim() : '';
    if (!qrName) {
      // Auto-name numbered 1, 2, 3...
      qrName = String(list.length + 1);
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64Data = event.target.result;
      list.push({
        id: Date.now(),
        name: qrName,
        data: base64Data
      });
      this.saveQrCodes(list);
      this.showToast(`QR "${qrName}" added successfully`, 'success');
      if (nameInput) nameInput.value = '';
      e.target.value = '';
      this.renderSettingsQrList();
    };
    reader.readAsDataURL(file);
  },

  renderSettingsQrList() {
    const list = this.getQrCodes();
    const countBadge = document.getElementById('qr-count-badge');
    if (countBadge) countBadge.textContent = `${list.length} / 5 Uploaded`;

    const container = document.getElementById('setting-qr-list');
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 12px; font-size: 12.5px;">No custom QR uploaded yet. The default QR will be shown.</div>`;
      return;
    }

    container.innerHTML = list.map((qr, idx) => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--bg-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
        <div style="display: flex; align-items: center; gap: 10px;">
          <img src="${this.escapeHtml(qr.data)}" alt="${this.escapeHtml(qr.name)}" style="width: 48px; height: 48px; object-fit: contain; border-radius: 6px; background: white; border: 1px solid var(--border-subtle);">
          <div>
            <strong style="font-size: 13px; color: var(--text-main);">${this.escapeHtml(qr.name)}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">Slot #${idx + 1}</div>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-danger-ghost" style="padding: 2px 8px;" onclick="app.deleteQrCode(${Number(qr.id) || 0})">Remove</button>
      </div>
    `).join('');
  },

  deleteQrCode(id) {
    let list = this.getQrCodes();
    list = list.filter(q => q.id !== id);
    this.saveQrCodes(list);
    this.renderSettingsQrList();
    this.showToast('QR code removed', 'info');
  },

  selectQrCode(id) {
    const list = this.getQrCodes();
    const selected = list.find(q => q.id === id);
    const img = document.getElementById('qr-code-img');
    const svg = document.getElementById('qr-code-svg');
    const instruction = document.getElementById('qr-modal-instruction');

    if (selected && img) {
      img.src = selected.data;
      img.style.display = 'block';
      if (svg) svg.style.display = 'none';
      if (instruction) instruction.textContent = `Scan QR for ${selected.name}`;

      // Update switcher button active state
      document.querySelectorAll('.qr-switch-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.id) === id);
      });
    }
  },

  async openInventoryFromSearch(id) {
    this.switchTab('inventory');
    try {
      const item = await window.api.getInventoryById(id);
      const term = item ? item.name : '';
      const search = document.getElementById('inv-search');
      if (search) search.value = term;
      this.loadInventory(term);
    } catch (_) {
      this.loadInventory();
    }
  },

  // ----------------------------------------------------
  // Global Top-Mid Search
  // ----------------------------------------------------
  setupGlobalSearch() {
    const topInput = document.getElementById('global-search-input');
    const modal = document.getElementById('modal-global-search');
    const modalInput = document.getElementById('global-search-modal-input');
    const results = document.getElementById('global-search-modal-results');
    if (!topInput || !modal || !modalInput || !results) return;

    let debounceTimer = null;
    let currentFilter = 'all';

    // Filter buttons
    modal.querySelectorAll('.search-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.search-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        performSearch(modalInput.value);
      });
    });

    const openModal = () => {
      modalInput.value = '';
      renderResults(`<div style="padding: 40px; text-align: center; color: var(--text-dim); font-size: 13px;">Type to search invoices, customers, or stock...</div>`);
      this.openModal('modal-global-search');
      setTimeout(() => { modalInput.focus(); }, 50);
    };

    const closeModal = () => {
      this.closeModal('modal-global-search');
    };

    this.closeGlobalSearchModal = () => closeModal();

    topInput.addEventListener('focus', () => {
      topInput.blur();
      openModal();
    });
    topInput.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });

    const renderResults = (html) => {
      results.innerHTML = html || `<div style="padding: 40px; text-align: center; color: var(--text-dim); font-size: 13px;">No matches found</div>`;
    };

    const performSearch = async (term) => {
      const q = term.trim().toLowerCase();
      if (!q) {
        renderResults(`<div style="padding: 40px; text-align: center; color: var(--text-dim); font-size: 13px;">Type to search invoices, customers, or stock...</div>`);
        return;
      }

      try {
        const [customers, inventory, invoices] = await Promise.all([
          window.api.getCustomers(q),
          window.api.getInventory(q),
          window.api.getInvoices({ search: q })
        ]);

        let html = '';

        if ((currentFilter === 'all' || currentFilter === 'invoices') && invoices && invoices.length > 0) {
          html += `<div class="global-search-category">Invoices (${invoices.length})</div>`;
          html += invoices.slice(0, 8).map(inv => `
            <div class="global-search-result" onclick="app.showInvoicePreviewModal(${Number(inv.id) || 0}); app.closeGlobalSearchModal();">
              <div>
                <strong style="color: var(--accent-primary); font-size: 13px;">${this.escapeHtml(inv.invoice_no)}</strong>
                <span style="font-size: 12px; color: var(--text-muted); margin-left: 6px;">${this.escapeHtml(inv.customer_name)}</span>
                <div style="font-size: 11px; color: var(--text-dim);">${this.escapeHtml((inv.created_at || '').slice(0, 10))}</div>
              </div>
              <div style="text-align: right;">
                <strong style="font-size: 12.5px;">Rs. ${Number(inv.total_amount || 0).toFixed(2)}</strong>
                <div><span class="badge badge-${this.escapeHtml((inv.status || 'unpaid').toLowerCase())}" style="font-size: 10px; padding: 1px 6px;">${this.escapeHtml(inv.status)}</span></div>
              </div>
            </div>
          `).join('');
        }

        if ((currentFilter === 'all' || currentFilter === 'customers') && customers && customers.length > 0) {
          html += `<div class="global-search-category">Customers (${customers.length})</div>`;
          html += customers.slice(0, 8).map(c => `
            <div class="global-search-result" onclick="app.viewCustomer(${Number(c.id) || 0}); app.closeGlobalSearchModal();">
              <div>
                <strong style="font-size: 13px; color: var(--text-main);">${this.escapeHtml(c.name)}</strong>
                <div style="font-size: 11.5px; color: var(--text-muted);">${this.escapeHtml(c.phone)} ${c.vehicle_no ? '• ' + this.escapeHtml(c.vehicle_no) : ''}</div>
              </div>
              <div style="text-align: right;">
                ${c.outstanding_balance > 0
              ? `<span style="color: var(--accent-danger-text); font-size: 11.5px; font-weight: 600;">Due: Rs. ${Number(c.outstanding_balance || 0).toFixed(0)}</span>`
              : `<span style="color: var(--accent-success-text); font-size: 11.5px;">Nil</span>`}
              </div>
            </div>
          `).join('');
        }

        if ((currentFilter === 'all' || currentFilter === 'inventory') && inventory && inventory.length > 0) {
          html += `<div class="global-search-category">Inventory Stock (${inventory.length})</div>`;
          html += inventory.slice(0, 8).map(item => `
            <div class="global-search-result" onclick="app.openInventoryFromSearch(${Number(item.id) || 0}); app.closeGlobalSearchModal();">
              <div>
                <strong style="font-size: 13px; color: var(--text-main);">${this.escapeHtml(item.name)}</strong>
                <div style="font-size: 11px; color: var(--text-dim);">${this.escapeHtml(item.code)} ${item.category ? '• ' + this.escapeHtml(item.category) : ''}</div>
              </div>
              <div style="text-align: right;">
                <strong style="font-size: 12.5px;">Rs. ${Number(item.selling_price || 0).toFixed(2)}</strong>
                <div style="font-size: 11px; color: ${item.quantity <= item.min_quantity ? '#EF4444' : 'var(--text-muted)'};">
                  Stock: ${Number(item.quantity) || 0} units
                </div>
              </div>
            </div>
          `).join('');
        }

        if (!html) {
          html = `<div style="padding: 40px; text-align: center; color: var(--text-dim); font-size: 13px;">No matches found for "${this.escapeHtml(term.trim())}"</div>`;
        }

        renderResults(html);
      } catch (err) {
        console.error('Global search error:', err);
      }
    };

    modalInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => performSearch(e.target.value), 200);
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('open')) {
        closeModal();
      }
    });
  },
  async initAuth() {
    const authScreen = document.getElementById('auth-screen');
    const viewSetup = document.getElementById('view-setup');
    const viewLogin = document.getElementById('view-login');
    const formLogin = document.getElementById('form-login');
    const btnLoginSubmit = document.getElementById('btn-login-submit');
    const btnToggleLoginPwd = document.getElementById('btn-toggle-login-pwd');
    const btnToggleSetupPwd = document.getElementById('btn-toggle-setup-pwd');
    const btnLogout = document.getElementById('btn-logout');
    const btnCopyRecoveryKey = document.getElementById('btn-copy-recovery-key');

    // Password show/hide helper
    const setupPwdToggle = (btn, inputId) => {
      btn?.addEventListener('click', () => {
        const input = document.getElementById(inputId);
        if (!input) return;
        if (input.type === 'password') {
          input.type = 'text';
          btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path>
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path>
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path>
              <line x1="2" y1="2" x2="22" y2="22"></line>
            </svg>
          `;
        } else {
          input.type = 'password';
          btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          `;
        }
      });
    };
    setupPwdToggle(btnToggleLoginPwd, 'login-password');
    setupPwdToggle(btnToggleSetupPwd, 'setup-password');

    // Copy recovery key button
    btnCopyRecoveryKey?.addEventListener('click', () => {
      const key = document.getElementById('display-recovery-key')?.textContent;
      if (key && key !== '----') {
        navigator.clipboard.writeText(key).then(() => {
          btnCopyRecoveryKey.textContent = 'Copied!';
          setTimeout(() => { btnCopyRecoveryKey.textContent = 'Copy'; }, 2000);
        }).catch(() => { });
      }
    });

    // Check if user has an existing authenticated session (device-bound)
    let authenticated = false;
    if (window.api && window.api.getSession) {
      try {
        const sessionUser = await window.api.getSession();
        if (sessionUser) {
          this.currentUser = sessionUser;
          this.features = sessionUser.features || { backups: false };
          authenticated = true;
          this.applyFeatures();
          if (authScreen) authScreen.classList.add('hidden');
          this.updateUserDisplay();
          this.updateSystemTypeBadge(sessionUser.systemType, sessionUser.appName || sessionUser.tenantName);
          if (sessionUser.branding) {
            this.applyBranding(sessionUser.branding);
          }
          this.checkLicenseOnce();
        }
      } catch (e) { }
    }

    // If not authenticated, ensure login view is active
    if (!authenticated) {
      viewLogin?.classList.add('active');
      if (authScreen) authScreen.classList.remove('hidden');
    }

    // Login Form Submit
    const handleLogin = async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const email = document.getElementById('login-email')?.value.trim();
      const password = document.getElementById('login-password')?.value;
      const errBox = document.getElementById('login-error-msg');
      const submitBtn = document.getElementById('btn-login-submit');

      if (!email || !password) {
        if (errBox) {
          errBox.textContent = 'Please enter your email/username and password.';
          errBox.style.display = 'block';
        }
        return false;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Signing in...';
      }
      if (errBox) errBox.style.display = 'none';

      const formatErrorMessage = (msg, status) => {
        if (status === 503 || /temporarily unavailable/i.test(msg)) {
          return 'Service temporarily unavailable. Please retry shortly.';
        }
        if (status === 429 || /too many requests|rate[- ]limit/i.test(msg)) {
          return msg || 'Too many requests. Please wait and try again.';
        }
        if (status === 500 || /^server error$/i.test(msg)) {
          return 'Server error: The control plane failed to connect to the database. Please verify MongoDB IP Access (0.0.0.0/0) in Atlas or database settings in the control panel.';
        }
        if (!msg) return 'Invalid email or password.';
        // Clean technical SSL / BoringSSL / Network stack traces
        if (/tls|ssl|boringssl|alert number|econnrefused|enotfound|etimedout|getaddrinfo/i.test(msg)) {
          return 'Unable to connect to the server. Please check your internet connection.';
        }
        if (/failed to fetch|network error|cannot reach/i.test(msg)) {
          return 'Unable to reach the server. Please check your internet connection.';
        }
        return msg;
      };

      try {
        const res = await window.api.login({ email, password });
        if (res && res.success) {
          if (errBox) errBox.style.display = 'none';
          this.currentUser = res.user;
          this.features = res.features || (res.user && res.user.features) || { backups: false };
          this.applyFeatures();

          this.updateUserDisplay();

          // Show system type badge and dynamic appName from control plane
          this.updateSystemTypeBadge(res.systemType || res.user?.systemType, res.appName || res.user?.appName || res.tenantName || res.user?.tenantName);
          this.applyBranding(res.branding || res);

          this.showToast(`Welcome, ${res.user.name}!`, 'success');

          if (authScreen) authScreen.classList.add('hidden');
          await this.loadDashboard();

          // Check license & device once on login, then every 60 seconds
          this.checkLicenseOnce();
          this.startDeviceCheckTimer();
        } else {
          if (errBox) {
            errBox.textContent = formatErrorMessage(res && (res.message || res.error), res && res.status);
            errBox.style.display = 'block';
          }
        }
      } catch (err) {
        if (errBox) {
          errBox.textContent = formatErrorMessage(err && err.message, err && err.status);
          errBox.style.display = 'block';
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = `
            Sign In
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          `;
        }
      }
      return false;
    };

    formLogin?.addEventListener('submit', handleLogin);
    btnLoginSubmit?.addEventListener('click', handleLogin);

    // Forgot password feature removed. Password resets are managed via admin website.
    // Profile Details Form (Save Name Only)
    const formProfileDetails = document.getElementById('form-profile-details');
    formProfileDetails?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!this.currentUser) return;
      const name = document.getElementById('profile-name-input')?.value.trim();

      if (!name) {
        this.showToast('Please enter your full name.', 'error');
        return;
      }

      const saveBtn = document.getElementById('btn-save-profile');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
      }

      try {
        const res = await window.api.updateProfile({ userId: this.currentUser.id, name });
        if (res && res.success) {
          this.currentUser.name = res.user.name;
          this.updateUserDisplay();
          this.applyAvatar();
          this.closeModal('modal-edit-profile');
          this.showToast('Profile updated successfully!', 'success');
        } else {
          this.showToast((res && res.message) || 'Failed to update name.', 'error');
        }
      } catch (err) {
        this.showToast(err.message || 'Failed to update name.', 'error');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
        }
      }
    });

    // Change Password Form
    const formChangePassword = document.getElementById('form-change-password');
    formChangePassword?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!this.currentUser) return;
      const currentPassword = document.getElementById('pwd-current')?.value;
      const newPassword = document.getElementById('pwd-new')?.value;
      const confirmPassword = document.getElementById('pwd-confirm')?.value;
      const msgBox = document.getElementById('pwd-change-msg');

      if (!currentPassword || !newPassword || !confirmPassword) {
        if (msgBox) {
          msgBox.className = 'auth-alert error';
          msgBox.textContent = 'Please fill out all password fields.';
          msgBox.style.display = 'block';
        }
        return;
      }

      if (newPassword.length < 8) {
        if (msgBox) {
          msgBox.className = 'auth-alert error';
          msgBox.textContent = 'New password must be at least 8 characters long.';
          msgBox.style.display = 'block';
        }
        return;
      }

      if (newPassword !== confirmPassword) {
        if (msgBox) {
          msgBox.className = 'auth-alert error';
          msgBox.textContent = 'New passwords do not match.';
          msgBox.style.display = 'block';
        }
        return;
      }

      try {
        const res = await window.api.changePassword({
          userId: this.currentUser.id,
          currentPassword,
          newPassword
        });
        if (res && res.success) {
          if (msgBox) {
            msgBox.className = 'auth-alert success';
            msgBox.textContent = 'Password changed successfully!';
            msgBox.style.display = 'block';
          }
          formChangePassword.reset();
          setTimeout(() => { if (msgBox) msgBox.style.display = 'none'; }, 3000);
          this.showToast('Password updated successfully!', 'success');
        }
      } catch (err) {
        if (msgBox) {
          msgBox.className = 'auth-alert error';
          msgBox.textContent = err.message || 'Failed to change password.';
          msgBox.style.display = 'block';
        }
      }
    });

    // Logout
    btnLogout?.addEventListener('click', async () => {
      if (confirm('Are you sure you want to sign out?')) {
        await this.logout();
      }
    });

    // Listen for backend device-unauthorized events
    if (window.api && window.api.onUnauthorized) {
      window.api.onUnauthorized(() => { this.logout(); });
    }
  },

  updateUserDisplay() {
    const nameEl = document.getElementById('sidebar-user-name') || document.getElementById('sidebar-user-email');
    if (nameEl) {
      const displayName = (this.currentUser && (this.currentUser.name || this.currentUser.username)) || (this.currentUser && this.currentUser.email) || 'User';
      nameEl.textContent = displayName;
      if (this.currentUser && this.currentUser.email) {
        nameEl.title = `${displayName} (${this.currentUser.email})`;
      }
    }
    const roleEl = document.querySelector('.sidebar-user-role');
    if (roleEl) {
      roleEl.textContent = (this.currentUser && this.currentUser.role) ? this.currentUser.role : 'Admin';
    }
    this.applyAvatar();
    this.loadProfile();
  },

  /**
   * Show the management system type (e.g. "Garage Management System", "Hotel", "Salon") and organization name.
   * Dynamically adapts the app to whichever management system is connected without duplicate "Management" suffixes.
   */
  updateSystemTypeBadge(systemType, appNameOrTenantName) {
    const badge = document.getElementById('system-type-badge');
    const brandName = document.getElementById('sidebar-brand-name');

    const effectiveType = systemType || (this.currentUser && this.currentUser.systemType);
    const effectiveAppName = appNameOrTenantName || (this.currentUser && (this.currentUser.appName || this.currentUser.tenantName));

    // Properly title-case and normalize type:
    // e.g. "garage management system" -> "Garage Management System"
    // e.g. "garage" -> "Garage Management System"
    // e.g. "hotel" -> "Hotel Management System"
    let typeLabel = null;
    if (effectiveType && typeof effectiveType === 'string') {
      const words = effectiveType.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      const titled = words.join(' ');
      if (/management\s+system/i.test(titled)) {
        typeLabel = titled;
      } else if (/management/i.test(titled)) {
        typeLabel = titled;
      } else {
        typeLabel = `${titled} Management System`;
      }
    }

    // 1. Dynamic Brand Name across the UI
    if (brandName) {
      if (effectiveAppName) {
        brandName.textContent = effectiveAppName;
      } else if (typeLabel) {
        brandName.textContent = typeLabel;
      } else {
        brandName.textContent = 'Management System';
      }
    }

    // 2. Dynamic System Type Badge
    if (badge) {
      if (typeLabel) {
        badge.textContent = typeLabel;
        badge.style.display = 'inline-block';
      } else if (this.currentUser && this.currentUser.tenant) {
        badge.textContent = this.currentUser.tenant.toUpperCase();
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }

    // 3. Dynamic Window Document Title
    const titleBase = effectiveAppName || typeLabel || 'Management System';
    document.title = titleBase;

    // 4. Invoices header
    if (effectiveAppName) {
      document.querySelectorAll('.invoice-company-name').forEach(el => { el.textContent = effectiveAppName; });
    }

    // 5. About Card details
    const aboutAppName = document.getElementById('about-app-name');
    if (aboutAppName) {
      aboutAppName.textContent = effectiveAppName || typeLabel || 'Garage Management System';
    }
    const aboutContact = document.getElementById('about-contact-phone');
    if (aboutContact) {
      aboutContact.textContent = '+977 9762901898';
    }
  },

  getAvatarStorageKey() {
    if (!this.currentUser) return null;
    const tenant = (this.currentUser.tenant || 'default').toLowerCase().trim();
    const userIdentifier = (this.currentUser.email || this.currentUser.id || this.currentUser.name || 'user').toLowerCase().trim();
    return `avatar_${tenant}_${userIdentifier}`;
  },

  openAvatarView() {
    const key = this.getAvatarStorageKey();
    const data = (key && typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    const img = document.getElementById('avatar-view-img');
    const empty = document.getElementById('avatar-view-empty');
    if (data) {
      if (img) { img.src = data; img.style.display = 'block'; }
      if (empty) empty.style.display = 'none';
    } else {
      if (img) { img.src = ''; img.style.display = 'none'; }
      if (empty) empty.style.display = 'block';
    }
    this.openModal('modal-avatar-view');
  },

  applyAvatar() {
    const key = this.getAvatarStorageKey();
    let data = (key && typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    
    // Fallback: If not in local storage yet, use user's cloud-backed avatar
    if (!data && this.currentUser && this.currentUser.avatar) {
      data = this.currentUser.avatar;
      try {
        if (key) localStorage.setItem(key, data);
      } catch (_) {}
    }

    const name = (this.currentUser && (this.currentUser.name || this.currentUser.username)) ? (this.currentUser.name || this.currentUser.username) : 'User';
    
    // Generate clean initials (e.g. "Ritesh Sharma" -> "RS", "Puma" -> "P")
    let initials = 'U';
    if (name) {
      const parts = name.trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      } else if (parts.length === 1 && parts[0].length > 0) {
        initials = parts[0].slice(0, Math.min(2, parts[0].length)).toUpperCase();
      }
    }

    document.querySelectorAll('#sidebar-user-avatar, #profile-avatar').forEach(el => {
      if (data) {
        el.style.backgroundImage = `url(${data})`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.textContent = '';
      } else {
        el.style.backgroundImage = '';
        el.textContent = initials;
      }
    });

    const btnRemove = document.getElementById('btn-remove-avatar');
    if (btnRemove) {
      btnRemove.style.display = data ? 'inline-flex' : 'none';
    }
  },

  async loadProfile() {
    if (!this.currentUser) return;
    const name = this.currentUser.name || 'User';
    const email = this.currentUser.email || '--';
    const role = this.currentUser.role || 'Admin';
    const loggedIn = this.currentUser.loggedInAt ? new Date(this.currentUser.loggedInAt).toLocaleString() : new Date().toLocaleString();
    const tenantName = this.currentUser.tenantName || this.currentUser.appName || this.currentUser.tenant || 'Standard Organization';

    const nameEl = document.getElementById('profile-name');
    const roleEl = document.getElementById('profile-role');
    const emailEl = document.getElementById('profile-email');
    const nameInput = document.getElementById('profile-name-input');
    const tenantBadge = document.getElementById('profile-tenant-badge');

    // Values in summary card
    const emailVal = document.getElementById('profile-email-val');
    const roleVal = document.getElementById('profile-role-val');
    const tenantVal = document.getElementById('profile-tenant-val');
    const sessionVal = document.getElementById('profile-session-val');

    if (nameEl) nameEl.textContent = name;
    if (roleEl) roleEl.textContent = role;
    if (emailEl) emailEl.textContent = email;
    if (nameInput) nameInput.value = name;

    if (emailVal) emailVal.textContent = email;
    if (roleVal) roleVal.textContent = role;
    if (tenantVal) tenantVal.textContent = this.currentUser.tenant || tenantName;
    if (sessionVal) sessionVal.textContent = loggedIn;

    if (tenantBadge) {
      if (this.currentUser.tenant) {
        tenantBadge.textContent = this.currentUser.tenant.toUpperCase();
        tenantBadge.style.display = 'inline-block';
      } else {
        tenantBadge.style.display = 'none';
      }
    }

    if (window.api && window.api.getAppInfo) {
      window.api.getAppInfo().then(info => {
        if (info && info.version) {
          this.initAppVersion(info.version);
        }

        const platformEl = document.getElementById('profile-platform-val');
        if (platformEl) {
          const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
          platformEl.textContent = platformNames[info.platform] || info.platform || '--';
        }
      }).catch(() => { });
    }

    this.applyAvatar();
    this.checkDbConnection();

    try {
      const stats = await window.api.getDashboardStats();
      const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const count = (value) => Number(value || 0).toLocaleString('en-IN');

      // Only show figures that are not already on the Dashboard. Customers,
      // outstanding balance and low-stock counts live there.
      const r = document.getElementById('profile-stat-revenue');
      const invCount = document.getElementById('profile-stat-invoices');
      const invValue = document.getElementById('profile-stat-inventory-value');
      const invMeta = document.getElementById('profile-stat-inventory-meta');

      // Lifetime revenue belongs here; today's revenue is shown on the dashboard.
      if (r) r.textContent = money(stats.totalRevenue);
      if (invCount) invCount.textContent = count(stats.totalInvoices);
      if (invValue) invValue.textContent = money(stats.inventoryValue);
      if (invMeta) invMeta.textContent = `${count(stats.totalInventoryItems)} items · ${count(stats.totalStockUnits)} units`;
    } catch (e) { }
  },

  // Revenue detail page. Read-only: built entirely from stored payments and
  // invoices so existing data is never modified.
  async loadRevenue() {
    const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const shortMoney = (value) => {
      const n = Number(value || 0);
      if (n >= 10000000) return `Rs ${(n / 10000000).toFixed(2)} Cr`;
      if (n >= 100000) return `Rs ${(n / 100000).toFixed(2)} L`;
      if (n >= 1000) return `Rs ${(n / 1000).toFixed(1)}k`;
      return `Rs ${Math.round(n)}`;
    };
    const count = (value) => Number(value || 0).toLocaleString('en-IN');
    const pct = (value) => `${Number(value || 0).toFixed(1)}%`;
    const toneClass = (i) => ['tone-primary', 'tone-success', 'tone-warning', 'tone-danger'][i % 4];

    if (!window.api || !window.api.getRevenueBreakdown) return;

    let data;
    try {
      data = await window.api.getRevenueBreakdown();
    } catch (e) {
      this.showToast('Could not load the revenue breakdown.', 'error');
      return;
    }
    if (!data) return;

    const collected = Number(data.collected || 0);
    const invoiced = Number(data.invoiced || 0);
    const rate = Number(data.collectionRate || 0);

    // With nothing invoiced and nothing paid, replace the whole analytics wall
    // with one clear empty state instead of a stack of blank cards.
    const hasAnyData = Number(data.invoiceCount || 0) > 0 || Number(data.paymentCount || 0) > 0;
    const emptyStateEl = document.getElementById('rev-empty-state');
    const sectionsEl = document.getElementById('rev-sections');
    if (emptyStateEl) emptyStateEl.hidden = hasAnyData;
    if (sectionsEl) sectionsEl.hidden = !hasAnyData;

    // Headline figures
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    setText('rev-collected', money(collected));
    setText('rev-collected-meta', `${count(data.paymentCount)} payments recorded`);
    setText('rev-invoiced', money(invoiced));
    setText('rev-invoiced-meta', `${count(data.invoiceCount)} invoices generated`);
    setText('rev-outstanding', money(data.outstanding));
    setText('rev-outstanding-meta', 'Unpaid balance across invoices');
    setText('rev-rate', pct(rate));
    setText('rev-rate-meta', `${money(collected)} of ${money(invoiced)} collected`);

    // Monthly chart
    const chartEl = document.getElementById('rev-month-chart');
    const monthly = Array.isArray(data.monthly) ? data.monthly : [];
    const windowTotal = monthly.reduce((sum, m) => sum + Number(m.amount || 0), 0);
    setText('rev-window-total', `${shortMoney(windowTotal)} in 12 months`);

    if (chartEl) {
      const chartEmpty = !monthly.length || windowTotal <= 0;
      chartEl.classList.toggle('is-empty', chartEmpty);
      if (chartEmpty) {
        chartEl.innerHTML = '<div class="rev-empty">No payments in the last 12 months.</div>';
        setText('rev-peak', '');
      } else {
        const peak = Math.max(...monthly.map(m => Number(m.amount || 0)), 1);
        chartEl.innerHTML = monthly.map(m => {
          const amount = Number(m.amount || 0);
          const height = amount > 0 ? Math.max(4, Math.round((amount / peak) * 100)) : 0;
          return `
            <div class="rev-chart-col" title="${this.escapeHtml(m.month)}: ${this.escapeHtml(money(amount))} from ${count(m.count)} payments">
              <div class="rev-chart-track">
                <div class="rev-chart-bar${m.month === monthly[monthly.length - 1].month ? ' is-current' : ''}" style="height:${height}%"></div>
              </div>
              <span class="rev-chart-label">${this.escapeHtml(m.label)}</span>
            </div>`;
        }).join('');

        // Values above every bar would collide at this width, so show the
        // peak and monthly average once underneath instead.
        const peakMonth = monthly.reduce((best, m) => Number(m.amount || 0) > Number(best.amount || 0) ? m : best, monthly[0]);
        const activeMonths = monthly.filter(m => Number(m.amount || 0) > 0).length;
        const avg = activeMonths > 0 ? windowTotal / activeMonths : 0;
        setText('rev-peak', `Peak ${shortMoney(peakMonth.amount)} in ${peakMonth.label}${peakMonth.year ? ' ' + peakMonth.year : ''} · Average ${shortMoney(avg)} per active month`);
      }
    }

    // Payment method split
    const methodsEl = document.getElementById('rev-methods');
    if (methodsEl) {
      const methods = Array.isArray(data.methods) ? data.methods : [];
      const methodTotal = methods.reduce((sum, m) => sum + Number(m.amount || 0), 0);
      if (!methods.length) {
        methodsEl.innerHTML = '<div class="rev-empty">No payments recorded yet.</div>';
      } else {
        methodsEl.innerHTML = methods.map((m, i) => {
          const amount = Number(m.amount || 0);
          const share = methodTotal > 0 ? (amount / methodTotal) * 100 : 0;
          return `
            <div class="rev-method-row">
              <div class="rev-method-head">
                <span class="rev-method-name">${this.escapeHtml(m.method || 'Unspecified')}</span>
                <span class="rev-method-amount">${money(amount)}</span>
              </div>
              <div class="rev-track">
                <div class="rev-fill ${toneClass(i)}" style="width:${share.toFixed(1)}%"></div>
              </div>
              <div class="rev-method-sub">${pct(share)} · ${count(m.count)} payments</div>
            </div>`;
        }).join('');
      }
    }

    // Parts vs labour split of the money actually collected. Falls back to the
    // invoiced mix if an older payload has no collectedSplit.
    const mixEl = document.getElementById('rev-mix');
    if (mixEl) {
      const split = data.collectedSplit || null;
      const parts = Number(split ? split.parts : (data.mix && data.mix.parts) || 0);
      const labour = Number(split ? split.labour : (data.mix && data.mix.labour) || 0);
      const custom = Number(split ? split.custom : (data.mix && data.mix.custom) || 0);
      const unallocated = Number(split && split.unallocated || 0);
      const splitTotal = parts + labour + custom + unallocated;
      const hasUnallocated = unallocated > 0.5;

      if (collected <= 0 || splitTotal <= 0) {
        mixEl.innerHTML = '<div class="rev-empty">No collected revenue to split yet.</div>';
      } else {
        const rows = [
          { label: 'Spare Parts', value: parts, tone: 'tone-primary', seg: 'parts' },
          { label: 'Labour & Service', value: labour, tone: 'tone-success', seg: 'labour' },
          { label: 'Custom Lines', value: custom, tone: 'tone-warning', seg: 'custom' }
        ];
        if (hasUnallocated) {
          rows.push({ label: 'Unallocated', value: unallocated, tone: '', seg: 'other' });
        }

        mixEl.innerHTML = `
          <div class="rev-split-seg">
            ${rows.map(row => `<div class="rev-seg ${row.seg}" style="width:${((row.value / splitTotal) * 100).toFixed(2)}%"></div>`).join('')}
          </div>
          ${rows.map(row => {
            const share = (row.value / splitTotal) * 100;
            return `
              <div class="rev-method-row">
                <div class="rev-method-head">
                  <span class="rev-method-name">${row.label}</span>
                  <span class="rev-method-amount">${money(row.value)}</span>
                </div>
                <div class="rev-track">
                  <div class="rev-fill ${row.tone}" style="width:${share.toFixed(1)}%"></div>
                </div>
                <div class="rev-method-sub">${pct(share)} of collected revenue</div>
              </div>`;
          }).join('')}
          <div class="rev-note">Collected payments are allocated by each invoice's own parts, labour and custom lines.</div>`;
      }
    }

    // Invoice status tiles
    const statusEl = document.getElementById('rev-status');
    if (statusEl) {
      const statuses = Array.isArray(data.statuses) ? data.statuses : [];
      const byName = {};
      statuses.forEach(s => { byName[String(s.status || '').toLowerCase()] = s; });
      const order = [
        { key: 'paid', label: 'Paid', tone: 'tone-success' },
        { key: 'partial', label: 'Partially Paid', tone: 'tone-warning' },
        { key: 'unpaid', label: 'Unpaid', tone: 'tone-danger' }
      ];
      const totalInvoices = statuses.reduce((sum, s) => sum + Number(s.count || 0), 0);
      setText('rev-status-total', `${count(totalInvoices)} invoices`);
      if (!totalInvoices) {
        statusEl.innerHTML = '<div class="rev-empty">No invoices generated yet.</div>';
      } else {
        statusEl.innerHTML = order.map(item => {
          const row = byName[item.key] || { count: 0, amount: 0, balance: 0 };
          const share = totalInvoices > 0 ? (Number(row.count || 0) / totalInvoices) * 100 : 0;
          return `
            <div class="rev-status-tile">
              <div class="rev-status-head">
                <span class="rev-dot ${item.tone}"></span>
                <span class="rev-status-name">${item.label}</span>
                <span class="rev-status-count">${count(row.count)}</span>
              </div>
              <div class="rev-status-amount">${money(row.amount)}</div>
              <div class="rev-method-sub">${pct(share)} of invoices${Number(row.balance || 0) > 0 ? ` · ${money(row.balance)} due` : ''}</div>
            </div>`;
        }).join('');
      }
    }

    // Top customers
    const topEl = document.getElementById('rev-top-customers');
    if (topEl) {
      const rows = Array.isArray(data.topCustomers) ? data.topCustomers : [];
      if (!rows.length) {
        topEl.innerHTML = '<tr><td colspan="4" class="rev-empty">No payments recorded yet.</td></tr>';
      } else {
        const top = Number(rows[0].amount || 0) || 1;
        topEl.innerHTML = rows.map(r => {
          const amount = Number(r.amount || 0);
          const share = (amount / top) * 100;
          return `
            <tr>
              <td>
                <div style="font-weight: 600; color: var(--text-main);">${this.escapeHtml(r.customer_name || 'Walk-in Customer')}</div>
                <div class="rev-mini-track"><div class="rev-fill tone-success" style="width:${share.toFixed(1)}%"></div></div>
              </td>
              <td>${r.vehicle_no ? this.escapeHtml(r.vehicle_no) : '<span style="color: var(--text-dim);">—</span>'}</td>
              <td style="text-align: right;">${count(r.invoices)}</td>
              <td class="rev-cell-num" style="text-align: right;">${money(amount)}</td>
            </tr>`;
        }).join('');
      }
    }

    // Recent payments
    const recentEl = document.getElementById('rev-recent-payments');
    if (recentEl) {
      const rows = Array.isArray(data.recentPayments) ? data.recentPayments : [];
      if (!rows.length) {
        recentEl.innerHTML = '<tr><td colspan="5" class="rev-empty">No payments recorded yet.</td></tr>';
      } else {
        recentEl.innerHTML = rows.map(p => `
          <tr>
            <td><span class="table-inv-no">${this.escapeHtml(p.invoice_no || `#${p.invoice_id}`)}</span></td>
            <td style="font-weight: 600; color: var(--text-main);">${this.escapeHtml(p.customer_name || 'Walk-in Customer')}</td>
            <td><span class="status-pill info">${this.escapeHtml(p.payment_method || 'Cash')}</span></td>
            <td>${this.formatDateTime(p.payment_date)}</td>
            <td class="rev-cell-num tone-success" style="text-align: right;">${money(p.amount)}</td>
          </tr>`).join('');
      }
    }
  },

  updateDbConnectionStatus(connected) {
    const dot = document.getElementById('profile-status-dot');
    const avatarDot = document.getElementById('profile-avatar-status-dot');
    const text = document.getElementById('profile-status-text');

    const isConnected = !!connected;
    const color = isConnected ? '#10b981' : '#94a3b8'; // green if connected, grey if offline
    const label = isConnected ? 'Database Connected' : 'Offline';

    if (dot) {
      dot.style.background = color;
      dot.style.boxShadow = isConnected ? '0 0 6px rgba(16, 185, 129, 0.5)' : 'none';
    }
    if (avatarDot) {
      avatarDot.style.background = color;
      avatarDot.title = label;
      avatarDot.style.boxShadow = isConnected ? '0 0 4px rgba(16, 185, 129, 0.4)' : 'none';
    }
    if (text) {
      text.textContent = label;
      text.style.color = isConnected ? 'var(--accent-success)' : 'var(--text-muted)';
    }
  },

  async checkDbConnection() {
    if (!navigator.onLine) {
      this.updateDbConnectionStatus(false);
      return false;
    }
    try {
      if (window.api && window.api.checkDevice) {
        const r = await window.api.checkDevice();
        const connected = !!(r && r.authorized);
        this.updateDbConnectionStatus(connected);
        return connected;
      }
    } catch (_) {
      this.updateDbConnectionStatus(false);
      return false;
    }
    this.updateDbConnectionStatus(false);
    return false;
  },

  startDeviceCheckTimer() {
    this.stopDeviceCheckTimer();

    const doCheck = async () => {
      if (!this.currentUser || document.hidden || !navigator.onLine || this._deviceCheckInFlight) return;
      this._deviceCheckInFlight = true;
      try {
        await this.checkLicenseOnce();
      } finally {
        this._deviceCheckInFlight = false;
      }
    };

    // Keep polling around 60 seconds only while the app is active/online (never faster than 60s)
    this._deviceCheckTimer = setInterval(doCheck, 60000);

    // Pause polling when app is backgrounded/offline and resume on focus/online
    if (!this._deviceCheckEventsBound) {
      this._deviceCheckEventsBound = true;

      const handleResume = () => {
        if (this.currentUser && !document.hidden && navigator.onLine) {
          doCheck();
        }
      };

      window.addEventListener('focus', handleResume);
      window.addEventListener('online', handleResume);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          handleResume();
        }
      });
    }
  },

  stopDeviceCheckTimer() {
    if (this._deviceCheckTimer) {
      clearInterval(this._deviceCheckTimer);
      this._deviceCheckTimer = null;
    }
  },

  async checkLicenseOnce() {
    if (!window.api || !window.api.checkDevice || !this.currentUser) return;

    try {
      const r = await window.api.checkDevice();
      if (r && (!r.authorized || r.requiresLogout)) {
        if (r.serviceUnavailable) {
          // HTTP 503 = tenant DB unavailable -> fail closed, show retry/offline state, do NOT bypass local lock
          this.updateDbConnectionStatus(false);
          this.showToast('Service temporarily unavailable. Please retry shortly.', 'warning');
          return;
        }
        if (r.requiresLogout || r.sessionExpired) {
          this.showToast(r.message || 'License or device authorization expired.', 'error');
          await this.logout();
          return;
        }
        this.updateDbConnectionStatus(false);
        return;
      }

      this.updateDbConnectionStatus(true);

      // 1. Sync Features (e.g. permissions) - default to disabled/closed if missing
      this.features = (r && r.features && typeof r.features === 'object') ? r.features : { backups: false };
      this.applyFeatures();

      // 2. Sync User Profile (name, role, email, appName changed on control website)
      if (r && r.user) {
        const cur = this.currentUser || {};
        const newAppName = r.appName || r.user.appName || r.user.tenantName || (r.tenant && r.tenant.name) || cur.appName;
        if (r.user.name !== cur.name || r.user.role !== cur.role || r.user.email !== cur.email || r.user.systemType !== cur.systemType || r.user.tenantName !== cur.tenantName || newAppName !== cur.appName) {
          this.currentUser = { ...cur, ...r.user, appName: newAppName };
          this.updateUserDisplay();
          this.updateSystemTypeBadge(r.user.systemType, newAppName);
        }
      }
      if (r && (r.branding || r.appName)) {
        this.applyBranding(r.branding || r);
      }
    } catch (e) {
      // Fail closed on error: do NOT bypass local lock
      this.updateDbConnectionStatus(false);
    }
  },

  // ----------------------------------------------------
  // Cloud Backup & Offline-First Sync Management
  // ----------------------------------------------------
  async handleSyncCloudData() {
    const btnSync = document.getElementById('btn-sync-cloud-data');
    if (btnSync) {
      btnSync.disabled = true;
      btnSync.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 5px; animation: spin 1s linear infinite;">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        Syncing...
      `;
    }

    try {
      if (window.api && window.api.syncCloudData) {
        const res = await window.api.syncCloudData();
        if (res && res.success) {
          if (res.action && res.action.startsWith('restored')) {
            this.showToast(`Restored ${res.records} records from cloud backup!`, 'success');
            await this.loadCustomers();
            await this.loadInventory();
            await this.loadInvoices();
            await this.loadDashboard();
          } else if (res.action && res.action.startsWith('uploaded')) {
            this.showToast(`Uploaded ${res.records} records to cloud backup!`, 'success');
          } else {
            this.showToast('Local database is in sync with cloud backup.', 'info');
          }
        } else {
          this.showToast(res && res.reason ? `Cloud sync: ${res.reason}` : 'Could not sync with cloud.', 'warning');
        }
      }
    } catch (err) {
      this.showToast(`Cloud sync error: ${err.message}`, 'error');
    } finally {
      if (btnSync) {
        btnSync.disabled = false;
        btnSync.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 5px;">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
          </svg>
          Sync Now
        `;
      }
      this.updateCloudSyncDisplay();
    }
  },

  async handleBackupCloudNow() {
    const btnBackup = document.getElementById('btn-backup-cloud-now');
    if (btnBackup) {
      btnBackup.disabled = true;
      btnBackup.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 5px; animation: spin 1s linear infinite;">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        Backing up...
      `;
    }

    try {
      if (window.api && window.api.backupCloudNow) {
        const res = await window.api.backupCloudNow();
        if (res && res.success) {
          this.showToast(`Cloud backup complete! Secured ${res.records} records to cloud.`, 'success');
        } else {
          this.showToast(res && res.reason ? `Backup notice: ${res.reason}` : 'Failed to upload backup.', 'warning');
        }
      }
    } catch (err) {
      this.showToast(`Backup error: ${err.message}`, 'error');
    } finally {
      if (btnBackup) {
        btnBackup.disabled = false;
        btnBackup.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 5px;">
            <path d="M12 3v12M17 10l-5-5-5 5M2 17l.621 2.485A2 2 0 0 0 4.561 21h14.878a2 2 0 0 0 1.94-1.515L22 17"/>
          </svg>
          Backup Now
        `;
      }
      this.updateCloudSyncDisplay();
    }
  },

  async updateCloudSyncDisplay() {
    try {
      if (!window.api || !window.api.getCloudSyncStatus) return;
      const status = await window.api.getCloudSyncStatus();
      const pill = document.getElementById('cloud-sync-status-pill');
      const title = document.getElementById('cloud-sync-status-title');
      const desc = document.getElementById('cloud-sync-status-desc');
      const icon = document.getElementById('cloud-sync-icon');
      const lastTime = document.getElementById('cloud-sync-last-time');

      const localCount = status ? status.localRecords : 0;
      const backup = status ? status.lastBackup : null;
      const isOnline = navigator.onLine;
      const pending = status ? status.hasPendingChanges : false;
      const syncing = status ? status.isSyncing : false;

      if (pill) {
        if (syncing) {
          pill.className = 'status-pill info';
          pill.textContent = 'Syncing…';
        } else if (pending) {
          pill.className = 'status-pill warning';
          pill.textContent = 'Unsaved';
        } else if (!isOnline) {
          pill.className = 'status-pill warning';
          pill.textContent = 'Offline';
        } else {
          pill.className = 'status-pill success';
          pill.textContent = backup && backup.success ? 'Synced' : 'Push-Only';
        }
      }
      if (icon) {
        const synced = !pending && !syncing && isOnline;
        icon.style.background = synced ? '#ecfdf5' : (syncing ? '#eff6ff' : '#fef3c7');
        icon.style.color = synced ? '#059669' : (syncing ? '#3b82f6' : '#d97706');
      }
      if (title) {
        if (syncing) {
          title.textContent = 'Uploading to Cloud…';
        } else if (pending) {
          title.textContent = 'Changes Pending Backup';
        } else {
          title.textContent = backup && backup.success ? 'Cloud Backup Active' : 'Cloud Backup Ready';
        }
      }
      if (desc) {
        const newCount = status.newRecords || 0;
        if (pending && newCount > 0) {
          desc.textContent = `${newCount} new record${newCount !== 1 ? 's' : ''} to backup`;
        } else if (pending) {
          desc.textContent = 'Unsaved changes';
        } else if (backup && backup.success) {
          desc.textContent = 'All data backed up';
        } else {
          desc.textContent = '';
        }
      }
      if (lastTime) {
        if (syncing) {
          lastTime.textContent = 'Uploading…';
        } else if (backup && backup.success && backup.updatedAt) {
          const dateStr = new Date(backup.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const newCount = status.newRecords || 0;
          lastTime.textContent = newCount > 0
            ? `Last backup: ${dateStr} · ${newCount} new`
            : `Last backup: ${dateStr}`;
        } else {
          lastTime.textContent = '';
        }
      }

      // Also update the activity indicator from the status
      this.updateSyncActivityIndicator({ isSyncing: syncing, hasPendingChanges: pending });
    } catch (_) {}
  },

  /**
   * Updates the live activity indicator bar inside the cloud backup card.
   * Shows a spinner while syncing, an orange dot when changes are pending, hidden when all synced.
   */
  updateSyncActivityIndicator(state) {
    const container = document.getElementById('cloud-sync-activity');
    const iconEl = document.getElementById('cloud-sync-activity-icon');
    const textEl = document.getElementById('cloud-sync-activity-text');
    if (!container || !iconEl || !textEl) return;

    const { isSyncing, hasPendingChanges } = state || {};

    if (isSyncing) {
      container.style.display = 'flex';
      container.style.background = 'rgba(59, 130, 246, 0.08)';
      container.style.color = '#3b82f6';
      container.style.border = '1px solid rgba(59, 130, 246, 0.18)';
      iconEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`;
      textEl.textContent = 'Uploading backup to cloud…';
    } else if (hasPendingChanges) {
      container.style.display = 'flex';
      container.style.background = 'rgba(245, 158, 11, 0.08)';
      container.style.color = '#d97706';
      container.style.border = '1px solid rgba(245, 158, 11, 0.18)';
      iconEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>`;
      textEl.textContent = 'New changes — pending backup';
    } else {
      container.style.display = 'none';
    }
  },

  // ----------------------------------------------------
  // Software Updates UI & Remote Update Notifications
  // ----------------------------------------------------
  setUpdateAvailable(version, notes, downloadUrl = null) {
    const targetVer = version || this.appVersion || '1.0.0';
    const releaseNotes = notes || `Version ${targetVer}: Updates and performance optimizations.`;
    this._availableUpdate = { version: targetVer, notes: releaseNotes, downloadUrl };

    // 1. Show pulsing red circle badge on Settings in sidebar
    const badge = document.getElementById('nav-update-badge');
    if (badge) {
      badge.textContent = '1';
      badge.style.display = 'inline-flex';
    }

    // 2. Update Settings Software Updates card UI
    const title = document.getElementById('update-status-title');
    const desc = document.getElementById('update-status-desc');
    const icon = document.getElementById('update-status-icon');
    const btnInstall = document.getElementById('btn-install-update');
    const btnCheck = document.getElementById('btn-check-updates');

    if (title) title.innerHTML = `<span style="color: #dc2626; font-weight: 800;">Update Available: v${this.escapeHtml(version)}</span>`;
    if (desc) desc.textContent = notes;
    if (icon) {
      icon.style.background = '#fef2f2';
      icon.style.color = '#ef4444';
      icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    }
    if (btnInstall) {
      btnInstall.textContent = `Update to v${version}`;
      btnInstall.style.display = 'inline-flex';
      btnInstall.onclick = () => this.handleInstallUpdate();
    }
    if (btnCheck) {
      btnCheck.style.display = 'none';
    }

    // 3. Show prominent toast notification
    this.showToast(`🔔 Update Available! Version ${version} is ready. Open Settings to update.`, 'info');
  },

  resetUpdateStatus() {
    this._availableUpdate = null;
    const badge = document.getElementById('nav-update-badge');
    if (badge) badge.style.display = 'none';

    const title = document.getElementById('update-status-title');
    const desc = document.getElementById('update-status-desc');
    const icon = document.getElementById('update-status-icon');
    const btnInstall = document.getElementById('btn-install-update');
    const btnCheck = document.getElementById('btn-check-updates');

    if (title) title.textContent = 'App is up to date';
    if (desc) desc.textContent = `Version ${this.appVersion || '1.0.0'} is currently the latest version.`;
    if (icon) {
      icon.style.background = '#e0f2fe';
      icon.style.color = '#0284c7';
      icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>`;
    }
    if (btnInstall) btnInstall.style.display = 'none';
    if (btnCheck) {
      btnCheck.style.display = 'inline-flex';
      btnCheck.disabled = false;
      btnCheck.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 5px;">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
        </svg>
        Check for Updates
      `;
    }
  },

  async handleCheckUpdates(silent = false) {
    const btnCheck = document.getElementById('btn-check-updates');
    if (btnCheck && !silent) {
      btnCheck.disabled = true;
      btnCheck.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 5px; animation: spin 1s linear infinite;">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        Checking...
      `;
    }

    if (!silent) this.showToast('Checking for software updates...', 'info');

    try {
      if (window.api && window.api.checkForUpdates) {
        const res = await window.api.checkForUpdates();
        if (res && res.updateAvailable) {
          this.setUpdateAvailable(res.version, res.notes, res.downloadUrl);
        } else if (res && res.offline) {
          if (!silent) this.showToast('Unable to check for updates. You are currently offline.', 'info');
          this.resetUpdateStatus();
        } else {
          if (!silent) this.showToast(`You are on the latest version (${res && res.currentVersion ? 'v' + res.currentVersion : 'v' + (this.appVersion || '1.0.0')}).`, 'success');
          this.resetUpdateStatus();
        }
      }
    } catch (err) {
      if (!silent) this.showToast(`Update check failed: ${err.message}`, 'error');
    } finally {
      if (btnCheck) {
        btnCheck.disabled = false;
        btnCheck.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 5px;">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
          </svg>
          Check for Updates
        `;
      }
    }
  },

  async handleInstallUpdate() {
    const updateInfo = this._availableUpdate;
    if (!updateInfo || !updateInfo.downloadUrl) {
      this.showToast('No download link is configured for this update. Please contact support.', 'warning');
      return;
    }

    if (!window.api || !window.api.installUpdate) {
      this.showToast('Updates are not available in this build.', 'error');
      return;
    }

    const btnInstall = document.getElementById('btn-install-update');
    if (btnInstall) btnInstall.disabled = true;
    try {
      const res = await window.api.installUpdate(updateInfo.downloadUrl);
      if (res && res.success) {
        this.showToast('Opening the official download page for the update...', 'info');
      } else {
        this.showToast((res && res.message) || 'Could not open the update download link.', 'error');
      }
    } catch (err) {
      this.showToast(err.message || 'Could not open the update download link.', 'error');
    } finally {
      if (btnInstall) btnInstall.disabled = false;
    }
  },

  applyFeatures() {
    try {
      const allowed = !!(this.features && this.features.backups === true);
      const btnExport = document.getElementById('btn-export-backup');
      const btnSettings = document.getElementById('btn-settings-backup');
      const btnBackupCloud = document.getElementById('btn-backup-cloud-now');
      const btnSyncCloud = document.getElementById('btn-sync-cloud-data');
      const cardCloudBackup = document.getElementById('card-cloud-backup');

      if (btnExport) {
        btnExport.disabled = !allowed;
        btnExport.title = allowed ? 'Export backup' : 'Backups disabled by administrator';
      }
      if (btnSettings) {
        btnSettings.disabled = !allowed;
      }
      if (btnBackupCloud) {
        btnBackupCloud.disabled = !allowed;
        btnBackupCloud.title = allowed ? 'Backup Now' : 'Backups disabled by administrator';
      }
      if (btnSyncCloud) {
        btnSyncCloud.disabled = !allowed;
        btnSyncCloud.title = allowed ? 'Sync Now' : 'Backups disabled by administrator';
      }
      if (cardCloudBackup) {
        if (!allowed) {
          cardCloudBackup.style.opacity = '0.55';
          cardCloudBackup.style.pointerEvents = 'none';
        } else {
          cardCloudBackup.style.opacity = '1';
          cardCloudBackup.style.pointerEvents = 'auto';
        }
      }
    } catch (e) { }
  },

  async logout() {
    this.stopDeviceCheckTimer();
    if (window.api && window.api.logout) {
      try {
        await window.api.logout();
      } catch (e) { }
    }
    this.currentUser = null;
    this.features = { backups: false };
    localStorage.removeItem('garage_auth_token');
    localStorage.removeItem('garage_user_session');

    // Clear cached lists and data models so no stale data leaks between sessions
    this.currentCustomers = [];
    this.currentInventory = [];
    this.currentInvoices = [];
    this.allPayments = [];
    this.dashboardStats = null;

    // Reset table contents in DOM so data from previous tenant never lingers
    const clearEl = (id) => { const el = document.getElementById(id); if (el) el.innerHTML = ''; };
    clearEl('customers-table-body');
    clearEl('inventory-table-body');
    clearEl('invoices-table-body');
    clearEl('payments-table-body');
    clearEl('recent-invoices-body');

    // Reset dashboard stat cards
    const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setText('stat-total-revenue', 'Rs 0');
    setText('stat-total-invoices', '0');
    setText('stat-total-customers', '0');
    setText('stat-pending-dues', 'Rs 0');
    setText('stat-low-stock', '0');

    // Reset to default dashboard view
    this.switchTab('dashboard');

    this.closeModal('modal-profile');
    const authScreen = document.getElementById('auth-screen');
    if (authScreen) {
      authScreen.classList.remove('hidden');
    }
    const pwdInput = document.getElementById('login-password');
    if (pwdInput) pwdInput.value = '';
    const errBox = document.getElementById('login-error-msg');
    if (errBox) errBox.style.display = 'none';

    // Show login view
    document.getElementById('view-setup')?.classList.remove('active');
    document.getElementById('view-login')?.classList.add('active');

    // Reset brand name & badge & auth title
    const authTitle = document.getElementById('auth-title') || document.querySelector('.auth-title');
    if (authTitle) authTitle.textContent = 'Sign In';
    const brandName = document.getElementById('sidebar-brand-name');
    if (brandName) brandName.textContent = 'Management System';
    const badge = document.getElementById('system-type-badge');
    if (badge) badge.style.display = 'none';
    document.title = 'Sign In — Management System';

    this.showToast('Signed out successfully.', 'info');
  },

  // ----------------------------------------------------
  // Utility & Formatting Helpers
  // ----------------------------------------------------
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  getAvatarColor(name = '') {
    const colors = [
      { bg: '#EFF6FF', text: '#1D4ED8' }, // Blue
      { bg: '#ECFDF5', text: '#047857' }, // Emerald
      { bg: '#F5F3FF', text: '#6D28D9' }, // Purple
      { bg: '#FFF7ED', text: '#C2410C' }, // Orange
      { bg: '#FEF2F2', text: '#B91C1C' }, // Rose
      { bg: '#F0FDFA', text: '#0F766E' }, // Teal
    ];
    let hash = 0;
    const str = String(name || '');
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index];
  },

  getInitials(name = '') {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'CU';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  },

  formatDateTime(dateStr) {
    if (!dateStr) return '--';
    try {
      let value = String(dateStr).trim();
      // SQLite CURRENT_TIMESTAMP is UTC but has no timezone suffix. Without
      // the trailing Z it would be parsed as local time and show the wrong
      // calendar day for early-morning records.
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) {
        value = value.replace(' ', 'T') + 'Z';
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        value = `${value}T00:00:00`;
      }
      const d = new Date(value);
      if (isNaN(d.getTime())) return String(dateStr).slice(0, 10);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return String(dateStr).slice(0, 10);
    }
  },

  // ----------------------------------------------------
  // Modal & Toast Helpers
  // ----------------------------------------------------
  openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('open');
  },

  closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('open');
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }
};

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
