# Garage Management System

A high-performance, offline-first desktop application designed for automotive workshops and garages. Built with Electron, better-sqlite3, and modern web standards, featuring automated cloud backups and multi-device synchronization via Control Plane HTTPS APIs.

---

## Features

- **Offline-First Architecture**: Powered by high-performance local SQLite database (`better-sqlite3`). Works flawlessly without an internet connection.
- **Automated Cloud Backup**: Background snapshot backups sent securely over HTTPS to your central Control Plane upon every data mutation (invoices, inventory, customers, payments).
- **Billing & Invoicing**: Fast invoice creation, automatic sequential invoice numbering, thermal & standard invoice printing, and PDF export.
- **Customer & Vehicle Management**: Full customer database with vehicle profiles, service history, and ledger accounts.
- **Inventory & Spare Parts**: Live stock tracking, low-stock threshold alerts, and manual inventory adjustments with audit reasons.
- **Payment & QR Code Management**: Built-in support for digital payments (Fonepay, Bank QRs) with dynamic QR code upload and checkout display.
- **Role-Based Access & Licensing**: Centralized authentication, device authorization verification, and remote license enforcement.
- **Dark Mode & Responsive UI**: Native dark/light/system theme toggling.

---

## Tech Stack

- **Runtime**: Electron 40+
- **Database**: SQLite3 via `better-sqlite3` (with `sql.js` fallback)
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3 with CSS variables
- **IPC Architecture**: Secure `contextIsolation: true` and `nodeIntegration: false` with preloaded bridge channels
- **Build System**: `electron-builder` (NSIS Windows installer & portable builds)

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm` or `pnpm`

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd garage
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your Control Plane settings:
   ```env
   MANAGEMENT_BASE_URL=https://myclientmanager.vercel.app
   TENANT_SLUG=your-tenant-slug
   TENANT_API_KEY=your-tenant-api-key
   ```

### Running in Development

```bash
npm start
```

---

## Building for Production

To package the application into a standalone Windows installer and portable executable:

```bash
npm run dist:win
```

Installers will be generated in the `dist/` directory:
- `Garage Management System Setup <version>.exe` (NSIS installer with automatic upgrades)
- `Garage Management System <version>.exe` (Portable executable)

---

## Architecture & Security

- **Zero Database Credentials in Client**: The client application connects exclusively to its local SQLite database. Cloud backups and device checks travel through authenticated HTTPS endpoints.
- **Protected Storage**: Sessions and device credentials are encrypted using OS-level secure storage (`safeStorage` / DPAPI on Windows) or machine-bound AES-256-GCM.
- **Isolated User Data**: All client records remain isolated in `AppData\Roaming\garage\tenants\<slug>\` and are preserved during application upgrades.

---

## License

Commercial Proprietary - Garage Management System. All rights reserved.
"# management-system" 
