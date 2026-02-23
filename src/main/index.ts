import { app, BrowserWindow, Notification, nativeTheme } from 'electron';
import { existsSync } from 'fs';
import path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { cleanupAllRuns } from './script-runner';

let mainWindow: BrowserWindow | null = null;
let isShuttingDown = false;

function forceExitSoon() {
  setTimeout(() => {
    process.exit(0);
  }, 2000).unref();
}

function shutdownApp() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    cleanupAllRuns();
  } catch { /* best-effort */ }

  try {
    app.quit();
  } finally {
    forceExitSoon();
  }
}

function registerShutdownHandlers() {
  process.on('SIGTERM', shutdownApp);
  process.on('SIGINT', shutdownApp);
  process.on('disconnect', shutdownApp);

  process.on('message', (data) => {
    if (data === 'graceful-exit') {
      shutdownApp();
    }
  });

  app.on('before-quit', () => {
    isShuttingDown = true;
  });
}

function resolveLogoPath() {
  const candidatePaths = [
    path.join(__dirname, '../../', 'logo.png'),
    path.join(process.resourcesPath, 'logo.png'),
    path.join(process.resourcesPath, 'app.asar', 'logo.png'),
  ];

  return candidatePaths.find((p) => existsSync(p));
}

function applyAppIcon() {
  const iconPath = resolveLogoPath();
  if (!iconPath) return;

  if (process.platform === 'darwin') {
    app.dock.setIcon(iconPath);
  }

  mainWindow?.setIcon(iconPath);
}

function createWindow() {
  const iconPath = resolveLogoPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#030712' : '#ffffff',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function sendToRenderer(channel: string, ...args: unknown[]) {
  mainWindow?.webContents.send(channel, ...args);
}

export function showNotification(title: string, body: string, onClick?: () => void) {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    if (onClick) {
      n.on('click', onClick);
    }
    n.show();
  }
}

app.whenReady().then(() => {
  registerShutdownHandlers();
  registerIpcHandlers();
  createWindow();
  applyAppIcon();

  nativeTheme.on('updated', () => {
    applyAppIcon();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Always quit — keeping the app alive in the dock without a window
  // causes hangs when the dev server or renderer process disappears.
  shutdownApp();
});
