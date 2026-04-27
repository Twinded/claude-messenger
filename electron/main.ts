/**
 * Electron main process entry. Sets up the app lifecycle, the main window,
 * the settings store, and registers IPC handlers. Claude SDK plumbing is
 * deferred to electron/claudeAgentClient.ts (added in Phase 3); this file
 * stays focused on Electron concerns and dependency wiring.
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSettingsStore } from "./settingsStore.js";
import {
  createBaseWindowFactory,
  setStableWindowTitle,
  type WindowKey
} from "./windowManager.js";
import { registerIpcHandlers } from "./ipcHandlers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isSmokeTest = process.argv.includes("--smoke-test");
const isDev = !app.isPackaged;

const windows = new Map<WindowKey, BrowserWindow>();

function logDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!isDev && !process.env.CLAUDE_MESSENGER_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[claude-messenger] ${event}`, details);
}

function showDockIcon(): void {
  if (process.platform === "darwin") app.dock?.show?.();
}

function appIconPath(): string | undefined {
  const iconDir = isDev
    ? path.join(__dirname, "..", "public", "icons")
    : path.join(process.resourcesPath, "public", "icons");
  if (process.platform === "win32") return path.join(iconDir, "claude-messenger.ico");
  if (process.platform === "darwin") return path.join(iconDir, "claude-messenger.icns");
  return path.join(iconDir, "claude-messenger.png");
}

function rendererEntryUrl(): string {
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  const indexHtml = path.join(__dirname, "..", "dist", "index.html");
  return `file://${indexHtml}`;
}

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

const settings = createSettingsStore({ filePath: settingsFilePath });

const createBaseWindow = createBaseWindowFactory({
  preloadPath: path.join(__dirname, "preload.cjs"),
  appIconPath: appIconPath(),
  windows,
  showDockIcon,
  smokeTest: isSmokeTest,
  onSmokeReady: () => {
    logDebug("smoke.ready");
    app.quit();
  },
  logDebug
});

async function createMainWindow(): Promise<BrowserWindow> {
  const win = createBaseWindow("main", {
    width: 320,
    height: 600,
    minWidth: 280,
    minHeight: 420,
    title: "Claude Messenger"
  });
  setStableWindowTitle(win, "Claude Messenger");
  await win.loadURL(rendererEntryUrl());
  return win;
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await settings.load();
  registerIpcHandlers({ settings, windows, createBaseWindow, logDebug });
  await createMainWindow();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
});

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[claude-messenger] bootstrap failed", error);
  app.exit(1);
});
