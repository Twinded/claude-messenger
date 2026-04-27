/**
 * Electron main process entry. Sets up the app lifecycle, the main window,
 * the settings store, the Claude Agent SDK client, contact discovery, and
 * the IPC bridge that the renderer talks to.
 *
 * Renderer-visible side effects all flow through `electron/ipcHandlers.ts`;
 * stream events from the Agent SDK are forwarded over the `claude:*` and
 * `conversation:*` IPC channels declared in `shared/types.ts`.
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSettingsStore } from "./settingsStore.js";
import { createAuthBridge } from "./authBridge.js";
import { createThreadStore, resolveThreadDbPath } from "./threadStore.js";
import { createAgentsWatcher } from "./agentsWatcher.js";
import { createSkillsWatcher } from "./skillsWatcher.js";
import { createContactRegistry, type CustomAgentRecord } from "./contactRegistry.js";
import { createClaudeAgentClient } from "./claudeAgentClient.js";
import {
  createBaseWindowFactory,
  setStableWindowTitle,
  type WindowKey
} from "./windowManager.js";
import { registerIpcHandlers } from "./ipcHandlers.js";
import { STREAM_CHANNELS } from "../shared/types.js";

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
    ? path.join(__dirname, "..", "..", "public", "icons")
    : path.join(process.resourcesPath, "public", "icons");
  if (process.platform === "win32") return path.join(iconDir, "claude-messenger.ico");
  if (process.platform === "darwin") return path.join(iconDir, "claude-messenger.icns");
  return path.join(iconDir, "claude-messenger.png");
}

function rendererEntryUrl(): string {
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  const indexHtml = path.join(__dirname, "..", "..", "dist", "index.html");
  return `file://${indexHtml}`;
}

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function customAgentsFilePath(): string {
  return path.join(app.getPath("userData"), "custom-agents.json");
}

async function loadCustomAgents(): Promise<CustomAgentRecord[]> {
  const fs = await import("node:fs/promises");
  try {
    const raw = await fs.readFile(customAgentsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CustomAgentRecord[]) : [];
  } catch {
    return [];
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const settings = createSettingsStore({ filePath: settingsFilePath });
  const { settings: currentSettings } = await settings.load();

  const auth = createAuthBridge();
  await auth.applyToProcessEnv();

  const threadStore = createThreadStore({
    dbPath: resolveThreadDbPath(app.getPath("userData"))
  });

  const agentsWatcher = createAgentsWatcher();
  const skillsWatcher = createSkillsWatcher();
  await agentsWatcher.refresh();
  await skillsWatcher.refresh();

  const contactRegistry = createContactRegistry({
    agentsWatcher,
    skillsWatcher,
    threadStore,
    loadCustomAgents,
    defaultModel: currentSettings.defaultModel
  });
  await contactRegistry.refresh();

  const claudeClient = createClaudeAgentClient({
    threadStore,
    defaults: {
      model: currentSettings.defaultModel as never,
      maxOutputTokens: currentSettings.maxOutputTokens,
      maxThinkingTokens: currentSettings.maxThinkingTokens,
      permissionMode: currentSettings.permissionMode
    }
  });

  claudeClient.on("stream", (event) => {
    const channel = streamChannelFor(event.kind);
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, event);
    }
  });

  const createBaseWindow = createBaseWindowFactory({
    preloadPath: path.join(__dirname, "..", "preload.cjs"),
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

  registerIpcHandlers({
    settings,
    auth,
    threadStore,
    contactRegistry,
    claudeClient,
    windows,
    createBaseWindow,
    rendererEntryUrl,
    logDebug
  });

  await createMainWindow(createBaseWindow);
}

async function createMainWindow(
  createBaseWindow: ReturnType<typeof createBaseWindowFactory>
): Promise<BrowserWindow> {
  const win = createBaseWindow("main", {
    width: 320,
    height: 600,
    minWidth: 280,
    minHeight: 420,
    title: "Claude Messenger"
  });
  setStableWindowTitle(win, "Claude Messenger");
  await win.loadURL(rendererEntryUrl());
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

function streamChannelFor(kind: string): string {
  switch (kind) {
    case "delta":
      return STREAM_CHANNELS.delta;
    case "thinking":
      return STREAM_CHANNELS.thinking;
    case "tool-use":
      return STREAM_CHANNELS.toolUse;
    case "tool-result":
      return STREAM_CHANNELS.toolResult;
    case "message-completed":
      return STREAM_CHANNELS.messageCompleted;
    case "turn-completed":
      return STREAM_CHANNELS.turnCompleted;
    case "permission-request":
      return STREAM_CHANNELS.permissionRequest;
    case "status":
      return STREAM_CHANNELS.status;
    case "error":
    default:
      return STREAM_CHANNELS.error;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
});

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[claude-messenger] bootstrap failed", error);
  app.exit(1);
});
